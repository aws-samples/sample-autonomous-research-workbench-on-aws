import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { CfnHarness } from "aws-cdk-lib/aws-bedrockagentcore";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const MAX_PROMPT_FILE_SIZE = 1024 * 1024;

/** HarnessName must match ^[a-zA-Z][a-zA-Z0-9_]{0,39}$ — 40 chars, no hyphens. */
const MAX_HARNESS_NAME_LENGTH = 40;
/** Length of the uniqueness hash CDK appends to a nested stack's name. */
const STACK_HASH_LENGTH = 8;

/**
 * Derive a legal HarnessName from the CDK stack name.
 *
 * The stack name is the natural choice — it is unique per deployment, so two
 * umbrella stacks in one account do not collide — but it does not always fit:
 * a nested stack's name carries an 8-char hash, and the whole thing overflowed
 * 40 characters when the umbrella stack was renamed to ResearchWorkbench.
 * So strip characters the pattern forbids, then, if still too long, drop from
 * the middle: keep the leading label for readability and the trailing hash,
 * which is the part that makes the name unique.
 */
function harnessNameFrom(stackName: string): string {
  const cleaned = stackName.replace(/[^a-zA-Z0-9_]/g, "");
  if (cleaned.length <= MAX_HARNESS_NAME_LENGTH) return cleaned;
  const head = cleaned.slice(0, MAX_HARNESS_NAME_LENGTH - STACK_HASH_LENGTH);
  return head + cleaned.slice(-STACK_HASH_LENGTH);
}

export interface AgentCoreHarnessStackProps extends cdk.StackProps {}

export class AgentCoreHarnessStack extends cdk.Stack {
  public readonly harness: CfnHarness;
  public readonly role: iam.Role;
  public readonly harnessArn: string;

  constructor(scope: Construct, id: string, props?: AgentCoreHarnessStackProps) {
    super(scope, id, props);

    this.role = this.createExecutionRole();

    // Only the browser tool is baked into the harness. The gateway is attached
    // per invocation as a remote_mcp tool (see packages/orpc/routes/prospect.ts)
    // so each call can carry the project-scoped x-project-id header — the
    // agentcore_gateway tool type has no header mechanism.
    this.harness = new CfnHarness(this, "Harness", {
      harnessName: harnessNameFrom(this.stackName),
      executionRoleArn: this.role.roleArn,
      model: {
        bedrockModelConfig: { modelId: "global.anthropic.claude-opus-5" },
      },
      systemPrompt: [{ text: this.readSystemPrompt(path.join(__dirname, "system-prompt.md")) }],
      tools: [{ type: "agentcore_browser", name: "browser" }],
      memory: { disabled: {} },
    });

    this.harness.node.addDependency(this.role);

    this.harnessArn = this.harness.attrArn;
  }

  private createExecutionRole(): iam.Role {
    const { partition, region, account } = this;

    const role = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: {
            "aws:SourceArn": `arn:${partition}:bedrock-agentcore:${region}:${account}:*`,
          },
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModelInvocation",
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:${partition}:bedrock:*::foundation-model/*`,
          `arn:${partition}:bedrock:${region}:${account}:*`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrPublicTokenAccess",
        actions: ["ecr-public:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "StsForEcrPublicPull",
        actions: ["sts:GetServiceBearerToken"],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "XRayTracingAccess",
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsGroup",
        actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        resources: [
          `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsDescribeGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: [`arn:${partition}:logs:${region}:${account}:log-group:*`],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsStream",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchMetricsPublish",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
        },
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreWorkloadIdentity",
        actions: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        ],
        resources: [
          `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );

    // AgentCore browser tool → default AWS-managed browser data-plane actions.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreBrowser",
        actions: [
          "bedrock-agentcore:StartBrowserSession",
          "bedrock-agentcore:StopBrowserSession",
          "bedrock-agentcore:GetBrowserSession",
          "bedrock-agentcore:ListBrowserSessions",
          "bedrock-agentcore:UpdateBrowserStream",
          "bedrock-agentcore:ConnectBrowserAutomationStream",
          "bedrock-agentcore:ConnectBrowserLiveViewStream",
        ],
        resources: [`arn:${partition}:bedrock-agentcore:${region}:aws:browser/*`],
      }),
    );

    return role;
  }

  private readSystemPrompt(promptPath: string): string {
    const size = statSync(promptPath).size;
    if (size > MAX_PROMPT_FILE_SIZE) {
      throw new Error(
        `System prompt file "${promptPath}" is too large (${size} bytes). ` +
          `Maximum size is ${MAX_PROMPT_FILE_SIZE} bytes.`,
      );
    }
    const text = readFileSync(promptPath, "utf-8");
    if (text.trim().length === 0) {
      throw new Error(
        `System prompt file "${promptPath}" is empty or whitespace-only.`,
      );
    }
    return text;
  }
}
