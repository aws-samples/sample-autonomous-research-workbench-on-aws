import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

/**
 * Per-project AgentCore runtimes.
 *
 * Each activated project gets its own AgentCore runtime running the shared
 * worker image, with the project's S3 Files access point mounted at
 * /mnt/files — so every agent in the project reads and writes the same
 * project-scoped file system (backed by projects/{id}/ in the artifacts
 * bucket), with the boundary enforced by the mount itself.
 *
 * The infra stack publishes everything a creation needs (image URI,
 * execution role, VPC network config, baseline env vars, mount path) to an
 * SSM parameter; AGENTCORE_PROJECT_RUNTIME_CONFIG_PARAM names it. When
 * unset (local dev, envs without the AgentCore stack) these helpers are
 * no-ops and the project row keeps a null runtime ARN — dispatch then falls
 * back to the shared platform runtime.
 */

/** Runtime names forbid hyphens, so the project UUID is underscored. */
const NAME_PREFIX = 'project_'

/**
 * Session lifecycle for per-project runtimes (seconds).
 *
 * Observed behavior (validated against USAGE_LOGS): the platform retires a
 * session ~idleRuntimeSessionTimeout after its most recent
 * InvokeAgentRuntime, even while /ping reports HealthyBusy for detached
 * background work. A 5-minute idle timeout bounds the billed tail after work
 * settles; a 2-hour max lifetime caps worst-case session cost (service
 * defaults are 900s / 8h).
 */
const IDLE_RUNTIME_SESSION_TIMEOUT_SECONDS = 300
const MAX_LIFETIME_SECONDS = 7_200

interface ProjectRuntimeConfig {
  imageUri: string
  roleArn: string
  subnetIds: string[]
  securityGroupIds: string[]
  mountPath: string
  environmentVariables: Record<string, string>
}

let client: BedrockAgentCoreControlClient | null = null
function getControlPlane(): BedrockAgentCoreControlClient {
  if (!client) {
    client = new BedrockAgentCoreControlClient({
      customUserAgent: process.env.USER_AGENT_STRING,
    })
  }
  return client
}

/**
 * Read the creation config published by the infra stack, or null when this
 * environment has no per-project runtime provisioning. Fetched fresh per
 * activation (activations are rare and the config changes on deploys).
 */
async function getConfig(): Promise<ProjectRuntimeConfig | null> {
  const paramName = process.env.AGENTCORE_PROJECT_RUNTIME_CONFIG_PARAM
  if (!paramName) {
    console.warn(
      '[agentcore-runtime] AGENTCORE_PROJECT_RUNTIME_CONFIG_PARAM not set — skipping project runtime creation',
    )
    return null
  }
  const result = await new SSMClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  }).send(
    new GetParameterCommand({ Name: paramName }),
  )
  if (!result.Parameter?.Value) {
    throw new Error(`SSM parameter ${paramName} has no value`)
  }
  return JSON.parse(result.Parameter.Value) as ProjectRuntimeConfig
}

function runtimeName(projectId: string): string {
  return `${NAME_PREFIX}${projectId.replace(/-/g, '_')}`
}

/**
 * Create the project's AgentCore runtime and return its ARN, or null when
 * provisioning is not configured in this environment. The project id doubles
 * as the client token, so a retried activation returns the same runtime
 * instead of creating a duplicate; a name conflict from an older activation
 * attempt resolves to the existing runtime's ARN.
 *
 * The runtime is created asynchronously (status CREATING → READY, typically
 * a couple of minutes). Runs dispatched before it is READY fail that
 * invocation and are recovered by the sweeper.
 */
export async function createProjectRuntime(
  projectId: string,
  s3AccessPointArn: string | null,
): Promise<string | null> {
  const config = await getConfig()
  if (!config) return null

  const name = runtimeName(projectId)
  try {
    const res = await getControlPlane().send(
      new CreateAgentRuntimeCommand({
        agentRuntimeName: name,
        clientToken: projectId,
        description: `ResearchWorkbench project runtime (project ${projectId})`,
        roleArn: config.roleArn,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: config.imageUri },
        },
        networkConfiguration: {
          networkMode: 'VPC',
          networkModeConfig: {
            subnets: config.subnetIds,
            securityGroups: config.securityGroupIds,
          },
        },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: IDLE_RUNTIME_SESSION_TIMEOUT_SECONDS,
          maxLifetime: MAX_LIFETIME_SECONDS,
        },
        environmentVariables: {
          ...config.environmentVariables,
          PROJECT_ID: projectId,
          ...(s3AccessPointArn && { PROJECT_FILES_DIR: config.mountPath }),
        },
        // The project-scoped file system: the S3 Files access point rooted
        // at projects/{id}/, mounted into every session of this runtime.
        ...(s3AccessPointArn && {
          filesystemConfigurations: [
            {
              s3FilesAccessPoint: {
                accessPointArn: s3AccessPointArn,
                mountPath: config.mountPath,
              },
            },
          ],
        }),
        tags: { 'research-workbench-project-id': projectId },
      }),
    )
    if (!res.agentRuntimeArn) {
      throw new Error('CreateAgentRuntime returned no agentRuntimeArn')
    }
    return res.agentRuntimeArn
  } catch (error) {
    // A previous activation created the runtime but the ARN never reached
    // the project row (e.g. the DB update failed) and the client token has
    // since rotated out: recover by looking the runtime up by name.
    if ((error as Error).name === 'ConflictException') {
      const existing = await findRuntimeArnByName(name)
      if (existing) return existing
    }
    throw error
  }
}

async function findRuntimeArnByName(name: string): Promise<string | null> {
  let nextToken: string | undefined
  do {
    const page = await getControlPlane().send(
      new ListAgentRuntimesCommand({ maxResults: 100, nextToken }),
    )
    const match = page.agentRuntimes?.find((r) => r.agentRuntimeName === name)
    if (match?.agentRuntimeArn) return match.agentRuntimeArn
    nextToken = page.nextToken
  } while (nextToken)
  return null
}

/**
 * Best-effort deletion of a project's runtime. Already-deleted runtimes are
 * treated as success; other failures are logged and swallowed (the caller
 * has already removed the project row).
 */
export async function deleteProjectRuntime(
  agentRuntimeArn: string,
): Promise<void> {
  // DeleteAgentRuntime takes the runtime ID — the last path segment of the
  // ARN (arn:aws:bedrock-agentcore:…:runtime/<id>).
  const agentRuntimeId = agentRuntimeArn.split('/').pop()
  if (!agentRuntimeId) {
    console.error(
      `[agentcore-runtime] cannot parse runtime id from ARN ${agentRuntimeArn}`,
    )
    return
  }
  try {
    await getControlPlane().send(
      new DeleteAgentRuntimeCommand({ agentRuntimeId }),
    )
  } catch (error) {
    const name = (error as Error).name
    if (name === 'ResourceNotFoundException') return
    console.error(
      `[agentcore-runtime] failed to delete runtime ${agentRuntimeArn}:`,
      error,
    )
  }
}
