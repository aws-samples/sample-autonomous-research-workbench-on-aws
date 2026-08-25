import {
  AgentRuntimeArtifact,
  Runtime,
  RuntimeNetworkConfiguration,
} from "aws-cdk-lib/aws-bedrockagentcore";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "node:path";
import type { NeptuneStack } from "../../neptune-stack";
import type { S3FilesStack } from "../../s3-files-stack";
import { SOLUTION_USER_AGENT } from "../../../solution";

/** SSM parameter the runtime reads its own ARN from at boot (self-dispatch). */
export const RUN_RUNTIME_ARN_PARAM = "/research-workbench/agentcore/run-runtime-arn";

/**
 * SSM parameter holding the JSON config the API uses to create per-project
 * AgentCore runtimes at activation time (image URI, execution role, network,
 * baseline env vars). Regenerated on every deploy, so newly activated
 * projects always get the current worker image. Existing project runtimes
 * are NOT updated in place — they keep the image they were created with
 * (delete and re-create the project to pick up a new image).
 */
export const PROJECT_RUNTIME_CONFIG_PARAM =
  "/research-workbench/agentcore/project-runtime-config";

/** Naming prefix for per-project runtimes (runtime names forbid hyphens). */
export const PROJECT_RUNTIME_NAME_PREFIX = "project_";

/** Where each project runtime mounts its S3 Files access point. */
export const PROJECT_FILES_MOUNT_PATH = "/mnt/files";

/**
 * EventBridge Scheduler group holding one schedule per activated project
 * (name `project-heartbeat-<id>`). The schedule IS the heartbeat's source of
 * truth: time, timezone, and enabled state live on the Scheduler resource;
 * the project row only stores the ARN.
 */
export const HEARTBEAT_SCHEDULE_GROUP = "project-heartbeats";

/** Naming prefix for per-project heartbeat schedules. */
export const HEARTBEAT_SCHEDULE_NAME_PREFIX = "project-heartbeat-";

export interface AgentCoreRuntimeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  postgresCluster: rds.DatabaseCluster;
  neptune: NeptuneStack;
  /** In-VPC durable-streams base URL (RunRuntime writes run deltas here). */
  streamsUrl: string;
  /**
   * Public web origin (the CloudFront URL). The Team Lead's owner-email tool
   * uses it to build project links.
   */
  publicUrl: string;
  /** LanceDB vector-store bucket (document retrieval tools). */
  lancedbBucket?: s3.IBucket;
  /**
   * S3 Files stack (file system over the artifacts bucket's projects/
   * prefix). Project runtimes mount their project's access point from it;
   * this stack opens NFS (2049) from the runtime SG to the mount targets and
   * scopes the shared execution role's mount permissions to it.
   */
  s3Files: S3FilesStack;
}

/**
 * AgentCore execution substrate for orchestrated runs.
 *
 * Hosts the worker's run processors (apps/worker, the agentcore entrypoint)
 * as a Bedrock AgentCore Runtime. Each InvokeAgentRuntime
 * call carries a `{ runId }` pointer and executes one run segment in an
 * isolated session; Postgres stays the source of truth, exactly as with the
 * BullMQ/ECS worker.
 *
 * Two indirections specific to AgentCore:
 * - The runtime cannot reference its own ARN in its env vars (the value would
 *   depend on the resource under creation), so the ARN is published to a
 *   fixed-name SSM parameter the container reads at boot for self-dispatch
 *   (spawning children, resuming parents, retries).
 * - There is no ECS-style secret injection, so the container gets
 *   DB_SECRET_ARN and fetches the Aurora credentials at boot.
 *
 * A scheduled in-VPC Lambda (entry: apps/worker/src/sweep-lambda.ts) runs the
 * stalled-run sweeper every five minutes directly against Postgres — off the
 * runtime substrate, so recovery does not share a failure domain with the
 * sessions it recovers. It resets runs whose session died mid-segment and
 * resumes parents whose resume baton was dropped.
 */
export class AgentCoreRuntimeStack extends cdk.Stack {
  public readonly runtime: Runtime;
  public readonly runtimeArn: string;
  /**
   * Execution role shared by every per-project runtime the API creates at
   * activation time. The API's task role needs iam:PassRole on it.
   */
  public readonly projectRuntimeRole: iam.Role;
  /** Lambda every project heartbeat schedule targets. */
  public readonly heartbeatTargetArn: string;
  /**
   * Role EventBridge Scheduler assumes to invoke the heartbeat Lambda. The
   * API passes it to CreateSchedule at project activation, so its task role
   * needs iam:PassRole on it.
   */
  public readonly heartbeatSchedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeStackProps) {
    super(scope, id, props);

    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");

    const runtimeSG = new ec2.SecurityGroup(this, "RuntimeSG", {
      vpc: props.vpc,
      // Needs egress to Aurora/Neptune/durable-streams (in-VPC) and to
      // Bedrock, Secrets Manager, SSM and its own InvokeAgentRuntime data
      // plane (via the NAT in the PRIVATE_WITH_EGRESS subnets).
      allowAllOutbound: true,
      description: "Security group for the AgentCore run runtime",
    });

    // The worker image, built once and shared between the platform runtime
    // (below) and the per-project runtimes the API creates at activation
    // time (via the config parameter's imageUri).
    const workerImage = new ecrAssets.DockerImageAsset(this, "WorkerImage", {
      directory: repoRoot,
      file: "apps/worker/Dockerfile",
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // Env vars shared by the platform runtime and every project runtime
    // (project runtimes additionally get PROJECT_ID / PROJECT_FILES_DIR at
    // creation time).
    const workerEnvironment: Record<string, string> = {
      NODE_ENV: "production",

      // AWS Solutions API usage metrics: SDK clients pass this as
      // customUserAgent. Lambda/ECS get it from UserAgentAspect; AgentCore
      // runtimes are not covered by the aspect, so it is set here.
      USER_AGENT_STRING: SOLUTION_USER_AGENT,

      DB_ADDRESS: props.postgresCluster.clusterEndpoint.socketAddress,
      DB_NAME: "application",
      DB_SECRET_ARN: props.postgresCluster.secret!.secretArn,

      STREAMS_URL: props.streamsUrl,
      AWS_DEFAULT_REGION: this.region,

      // Public web origin, used by the Team Lead's owner-email tool to build
      // project links.
      PUBLIC_APP_URL: props.publicUrl,

      // Knowledge graph tools: Neptune over Bolt with SigV4 IAM auth.
      GRAPH_BOLT_URL: `bolt+ssc://${props.neptune.clusterEndpoint}`,
      GRAPH_AUTH: "sigv4",

      // Fallback dispatch target (runs without a project runtime): the
      // container reads the platform runtime's ARN from this parameter at
      // boot. Project-scoped runs resolve their runtime ARN from the
      // project row instead.
      AGENTCORE_RUNTIME_ARN_PARAM: RUN_RUNTIME_ARN_PARAM,

      ...(props.lancedbBucket && {
        LANCEDB_BUCKET: props.lancedbBucket.bucketName,
      }),
    };

    this.runtime = new Runtime(this, "Runtime", {
      runtimeName: "ResearchWorkbenchRunRuntime",
      description:
        "Executes orchestrator/sub-agent run segments (worker processors behind the AgentCore invocation contract).",
      agentRuntimeArtifact: AgentRuntimeArtifact.fromEcrRepository(
        workerImage.repository,
        workerImage.imageTag,
      ),
      networkConfiguration: RuntimeNetworkConfiguration.usingVpc(this, {
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [runtimeSG],
      }),
      environmentVariables: workerEnvironment,
    });

    this.runtimeArn = this.runtime.agentRuntimeArn;

    // Self-ARN indirection: fixed-name parameter, read by the container at
    // boot (AGENTCORE_RUNTIME_ARN_PARAM above).
    new ssm.StringParameter(this, "RuntimeArnParam", {
      parameterName: RUN_RUNTIME_ARN_PARAM,
      stringValue: this.runtime.agentRuntimeArn,
      description: "ARN of the AgentCore run runtime (read at boot for self-dispatch)",
    });

    // Aurora credentials, fetched by the boot-time bootstrap.
    props.postgresCluster.secret!.grantRead(this.runtime);

    // Self-dispatch permissions (spawning children, resuming parents and
    // retries are InvokeAgentRuntime calls against this same runtime, and the
    // container reads its own ARN from the SSM parameter at boot).
    //
    // These live in a STANDALONE policy, not the execution role's default
    // policy: the L2 Runtime adds a construct-node dependency on the whole
    // role subtree (default policy included), so a default-policy statement
    // referencing the runtime's own ARN closes a CloudFormation dependency
    // cycle (Runtime → DefaultPolicy → Runtime). Nothing depends on this
    // policy, so its reference to the runtime is acyclic. The SSM parameter
    // ARN is built from the fixed name for the same reason.
    // The project_* pattern is included because the platform runtime hosts
    // the sweep backstop: stalled PROJECT runs are re-dispatched from here,
    // and dispatch resolves them to their project runtime's ARN.
    new iam.Policy(this, "SelfDispatchPolicy", {
      roles: [this.runtime.role],
      statements: [
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [
            this.runtime.agentRuntimeArn,
            `${this.runtime.agentRuntimeArn}/*`,
            this.projectRuntimeArnPattern(),
          ],
        }),
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            this.formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: RUN_RUNTIME_ARN_PARAM.replace(/^\//, ""),
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      ],
    });

    // Bedrock model calls (streamText via @ai-sdk/amazon-bedrock). Foundation
    // models and cross-region inference profiles are account-agnostic
    // resources, so the wildcard is the practical scope here (mirrors the
    // worker/API task roles).
    this.runtime.grant(
      ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      ["*"],
    );

    props.neptune.grantConnect(this.runtime.role);

    // Web-search tool: a session on the AWS-managed browser (aws.browser.v1),
    // driven over CDP. Scoped to the AWS-managed browser ("aws" as the account
    // in the ARN), which is the only browser this uses.
    this.runtime.grant(
      [
        "bedrock-agentcore:StartBrowserSession",
        "bedrock-agentcore:StopBrowserSession",
      ],
      [`arn:${this.partition}:bedrock-agentcore:${this.region}:aws:browser/*`],
    );
    // The CDP WebSocket the Playwright client attaches to. Split out with a
    // wildcard resource because ConnectBrowserAutomationStream does not
    // support resource-level permissions — scoping it to the browser ARN
    // evaluates to an implicit deny (verified with
    // `aws iam simulate-custom-policy`), since the stream does not exist as a
    // resource until the connection is opened.
    this.runtime.grant(
      ["bedrock-agentcore:ConnectBrowserAutomationStream"],
      ["*"],
    );

    // Team Lead owner-email tool: resolve the platform sending identity
    // (first SES identity, same convention as the settings Email tab) and
    // send from it. ListEmailIdentities is not resource-scopable; SendEmail
    // is scoped to this account's identities.
    this.runtime.grant(["ses:ListEmailIdentities"], ["*"]);
    this.runtime.grant(
      ["ses:SendEmail"],
      ["*"],
    );

    // LanceDB retrieval tools read the vector store directly from S3. Write
    // access is deliberately bucket-wide: Lance's directory namespace
    // maintains a manifest cache (__manifest/) that readers create/refresh,
    // and without write it falls back to slower directory listing with a
    // warning per session. If tighter scoping is ever wanted, restrict the
    // write actions to arnForObjects("__manifest/*") in a standalone policy
    // (the minimizePolicies flag merges a prefix-scoped grant into the
    // bucket-wide read statement if placed in the default policy).
    props.lancedbBucket?.grantReadWrite(this.runtime);

    // Standalone ingress rules created in THIS stack: the allowFrom helpers
    // would place them in the Database/Neptune stacks referencing our SG,
    // creating cross-stack cycles (we already depend on their endpoints).
    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromRuntime", {
      ipProtocol: "tcp",
      fromPort: props.postgresCluster.clusterEndpoint.port,
      toPort: props.postgresCluster.clusterEndpoint.port,
      groupId:
        props.postgresCluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: runtimeSG.securityGroupId,
      description: "Allow the AgentCore run runtime to connect to Aurora PostgreSQL",
    });

    new ec2.CfnSecurityGroupIngress(this, "NeptuneIngressFromRuntime", {
      ipProtocol: "tcp",
      fromPort: 8182,
      toPort: 8182,
      groupId: props.neptune.cluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: runtimeSG.securityGroupId,
      description: "Allow the AgentCore run runtime to connect to Neptune",
    });

    // ── Sweep backstop ───────────────────────────────────────────────────────
    // The stalled-run sweeper runs INSIDE this scheduled Lambda (entry:
    // apps/worker/src/sweep-lambda.ts), directly against Postgres —
    // deliberately off the AgentCore substrate it recovers, so a runtime
    // that cannot boot or hangs cannot take its own crash recovery down
    // with it. It also avoids minting a fresh AgentCore session (a warm
    // billed microVM) every five minutes just to run a few SQL statements.
    // The Lambda timeout doubles as the sweep's hang watchdog.
    const sweepFunction = new lambdanode.NodejsFunction(this, "SweepTrigger", {
      functionName: `${this.stackName}-sweep`,
      entry: path.join(repoRoot, "apps/worker/src/sweep-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      // In-VPC: the sweep talks to Aurora, Neptune (knowledge pulse), and
      // the durable-streams service directly. Reuses the runtime SG so every
      // existing ingress rule keyed on it (Aurora, Neptune, S3 Files,
      // streams) covers the Lambda too.
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [runtimeSG],
      environment: {
        NODE_ENV: "production",
        DB_ADDRESS: props.postgresCluster.clusterEndpoint.socketAddress,
        DB_NAME: "application",
        DB_SECRET_ARN: props.postgresCluster.secret!.secretArn,
        STREAMS_URL: props.streamsUrl,
        GRAPH_BOLT_URL: `bolt+ssc://${props.neptune.clusterEndpoint}`,
        GRAPH_AUTH: "sigv4",
        // Re-dispatch target for runs without a project runtime. Unlike the
        // AgentCore container (which reads its own ARN from SSM at boot),
        // the Lambda can reference the runtime ARN directly.
        AGENTCORE_RUNTIME_ARN: this.runtime.agentRuntimeArn,
        // Aurora requires TLS; the pg Pool only enables it when this points
        // at a CA bundle (see packages/database/client.ts). The bundle is
        // fetched into the asset by the afterBundling hook below — the same
        // pattern the worker/api Dockerfiles use at image build.
        RDS_CA_BUNDLE_PATH: "/var/task/rds-global-bundle.pem",
      },
      bundling: {
        platform: "node",
        // Bundle everything (workspace packages ship as TS source); pg-native
        // is an optional binary dependency of pg that is never installed —
        // leaving it external keeps esbuild from trying to resolve it.
        externalModules: ["pg-native"],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            // RDS global CA bundle for Aurora TLS (all regions/CAs in one PEM).
            `curl -fsSL -o ${outputDir}/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
          ],
        },
      },
      depsLockFilePath: path.join(repoRoot, "pnpm-lock.yaml"),
    });

    // Aurora credentials, resolved by the handler at cold start.
    props.postgresCluster.secret!.grantRead(sweepFunction);

    // Re-dispatching stalled runs is an InvokeAgentRuntime call: the shared
    // platform runtime for projectless runs, or the run's project runtime
    // (name project_*) when it has one.
    this.runtime.grantInvokeRuntime(sweepFunction);
    sweepFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [this.projectRuntimeArnPattern()],
      }),
    );

    // Knowledge pulse (onChildTerminal for dead runs) reads the graph.
    props.neptune.grantConnect(sweepFunction.role!);

    new scheduler.Schedule(this, "Sweep Schedule", {
      description: "Stalled-run sweep for the AgentCore run substrate",
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      target: new targets.LambdaInvoke(sweepFunction),
    });

    new cdk.CfnOutput(this, "RunRuntimeArn", {
      value: this.runtime.agentRuntimeArn,
      description: "ARN of the AgentCore run runtime",
    });

    // ── Project heartbeats ──────────────────────────────────────────────────
    // One EventBridge Scheduler schedule per activated project (created by
    // the API, default 9am daily) pulses the Team Lead to check on its
    // agents. The schedule is the source of truth for the heartbeat config;
    // this stack provides the shared pieces: the schedule group, the target
    // Lambda (same shape as the sweep trigger), and the role Scheduler
    // assumes to invoke it.
    const heartbeatFunction = new lambdanode.NodejsFunction(
      this,
      "HeartbeatTrigger",
      {
        functionName: `${this.stackName}-heartbeat`,
        entry: path.join(__dirname, "./heartbeat-lambda/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(30),
        environment: {
          AGENTCORE_RUNTIME_ARN: this.runtime.agentRuntimeArn,
        },
        bundling: {
          platform: "node",
          // Bundle the bedrock-agentcore client: the Lambda-provided SDK may
          // predate it.
          externalModules: [],
        },
      },
    );
    this.runtime.grantInvokeRuntime(heartbeatFunction);
    this.heartbeatTargetArn = heartbeatFunction.functionArn;

    new scheduler.ScheduleGroup(this, "HeartbeatScheduleGroup", {
      scheduleGroupName: HEARTBEAT_SCHEDULE_GROUP
    });

    this.heartbeatSchedulerRole = new iam.Role(this, "HeartbeatSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description:
        "Assumed by EventBridge Scheduler to invoke the project heartbeat Lambda",
    });
    heartbeatFunction.grantInvoke(this.heartbeatSchedulerRole);

    // The Team Lead's stopHeartbeat tool disables (never deletes) the
    // project's schedule from inside the worker runtimes. Get is needed
    // because UpdateSchedule replaces the whole resource, so the worker
    // reads the current definition first. The schedule ARN pattern is
    // name-based, so no dependency-cycle concern here.
    const heartbeatDisableStatement = new iam.PolicyStatement({
      actions: ["scheduler:GetSchedule", "scheduler:UpdateSchedule"],
      resources: [this.heartbeatScheduleArnPattern()],
    });
    // UpdateSchedule replaces the whole resource including Target.RoleArn,
    // so Scheduler demands iam:PassRole on the execution role even for a
    // pure state change (ENABLED → DISABLED). Without this the worker's
    // disable call is AccessDenied.
    const heartbeatPassRoleStatement = new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [this.heartbeatSchedulerRole.roleArn],
      conditions: {
        StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
      },
    });
    new iam.Policy(this, "HeartbeatDisablePolicy", {
      roles: [this.runtime.role],
      statements: [heartbeatDisableStatement, heartbeatPassRoleStatement],
    });

    // ── Per-project runtimes ────────────────────────────────────────────────
    // Each activated project gets its own AgentCore runtime (created by the
    // API via CreateAgentRuntime, name `project_<id>`), running the same
    // worker image with the project's S3 Files access point mounted at
    // /mnt/files. This stack provides everything those creations share: the
    // execution role, network plumbing, and a config parameter the API reads
    // at activation time.

    this.projectRuntimeRole = new iam.Role(this, "ProjectRuntimeRole", {
      // Mirrors the trust policy the L2 Runtime construct generates, scoped
      // to runtimes named project_* in this account.
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": this.projectRuntimeArnPattern() },
        },
      }),
      description:
        "Shared execution role for per-project AgentCore runtimes (created by the API at project activation)",
      maxSessionDuration: cdk.Duration.hours(8),
    });

    // Baseline runtime permissions, mirroring what the L2 Runtime construct
    // grants its execution role (logs, tracing, metrics, workload identity).
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "LogGroupAccess",
        actions: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "DescribeLogGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
        ],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "LogStreamAccess",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "XRayAccess",
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
        },
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "GetAgentAccessToken",
        actions: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        resources: [
          `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );

    // Pull the worker image (CDK asset repository).
    workerImage.repository.grantPull(this.projectRuntimeRole);

    // Everything the shared runtime's role gets, since project runtimes run
    // the same worker code.
    props.postgresCluster.secret!.grantRead(this.projectRuntimeRole);
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      }),
    );
    props.neptune.grantConnect(this.projectRuntimeRole);
    props.lancedbBucket?.grantReadWrite(this.projectRuntimeRole);
    // Web-search tool's browser session (see the platform runtime's grant for
    // why the stream connect is a separate, unscopable statement).
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:StartBrowserSession",
          "bedrock-agentcore:StopBrowserSession",
        ],
        resources: [
          `arn:${this.partition}:bedrock-agentcore:${this.region}:aws:browser/*`,
        ],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:ConnectBrowserAutomationStream"],
        resources: ["*"],
      }),
    );

    // Dispatch: spawning children / resuming parents stays on the project's
    // own runtime (project_*); the platform runtime ARN param is the
    // fallback read at boot.
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          this.projectRuntimeArnPattern(),
          // Name-based pattern (not a token reference to this.runtime) so
          // this default-policy statement can't create a dependency cycle.
          this.formatArn({
            service: "bedrock-agentcore",
            resource: "runtime",
            resourceName: "ResearchWorkbenchRunRuntime*",
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: RUN_RUNTIME_ARN_PARAM.replace(/^\//, ""),
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Team Lead runs execute on project runtimes too, so the stopHeartbeat
    // tool (disable-only, see HeartbeatDisablePolicy above) needs the same
    // scheduler permissions here.
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:GetSchedule", "scheduler:UpdateSchedule"],
        resources: [this.heartbeatScheduleArnPattern()],
      }),
    );
    // ... and the matching iam:PassRole (see HeartbeatDisablePolicy above):
    // UpdateSchedule re-passes Target.RoleArn even on a disable-only change.
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [this.heartbeatSchedulerRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
        },
      }),
    );

    // ... and the owner-email tool needs the same SES permissions as the
    // platform runtime (see the grants near neptune.grantConnect above).
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:ListEmailIdentities"],
        resources: ["*"],
      }),
    );
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      }),
    );

    // Mount the project's S3 Files access point over NFS: IAM side. Scoped
    // to access points of OUR file system — which access point a runtime
    // sees is fixed by its filesystemConfigurations, so the wildcard here
    // does not weaken per-project isolation.
    this.projectRuntimeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3files:ClientMount",
          "s3files:ClientWrite",
          "s3files:GetAccessPoint",
          "s3files:ListMountTargets",
          "s3files:GetFileSystem",
        ],
        resources: ["*"],
      }),
    );

    // Mount the file system over NFS: network side. Project runtimes reuse
    // runtimeSG, so one ingress rule covers the whole fleet. Standalone rule
    // in THIS stack for the same cross-stack-cycle reason as Db/Neptune.
    new ec2.CfnSecurityGroupIngress(this, "S3FilesIngressFromRuntime", {
      ipProtocol: "tcp",
      fromPort: 2049,
      toPort: 2049,
      groupId: props.s3Files.mountTargetSecurityGroup.securityGroupId,
      sourceSecurityGroupId: runtimeSG.securityGroupId,
      description:
        "Allow AgentCore project runtimes to mount S3 Files over NFS",
    });

    // Everything the API needs to create a project runtime, as one JSON
    // parameter. Regenerated each deploy, so the imageUri always points at
    // the current worker image for NEW activations (existing runtimes keep
    // the image they were created with).
    new ssm.StringParameter(this, "ProjectRuntimeConfigParam", {
      parameterName: PROJECT_RUNTIME_CONFIG_PARAM,
      stringValue: cdk.Stack.of(this).toJsonString({
        imageUri: workerImage.imageUri,
        roleArn: this.projectRuntimeRole.roleArn,
        subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
        securityGroupIds: [runtimeSG.securityGroupId],
        mountPath: PROJECT_FILES_MOUNT_PATH,
        environmentVariables: workerEnvironment,
      }),
      description:
        "JSON config the API uses to create per-project AgentCore runtimes at activation",
    });
  }

  /** ARN pattern matching every per-project runtime (name `project_*`). */
  private projectRuntimeArnPattern(): string {
    return this.formatArn({
      service: "bedrock-agentcore",
      resource: "runtime",
      resourceName: `${PROJECT_RUNTIME_NAME_PREFIX}*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
  }

  /** ARN pattern matching every SES identity in this account/region. */
  private sesIdentityArnPattern(): string {
    return this.formatArn({
      service: "ses",
      resource: "identity",
      resourceName: "*",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
  }

  /**
   * ARN pattern matching every project heartbeat schedule
   * (`schedule/<group>/project-heartbeat-*`).
   */
  private heartbeatScheduleArnPattern(): string {
    return this.formatArn({
      service: "scheduler",
      resource: "schedule",
      resourceName: `${HEARTBEAT_SCHEDULE_GROUP}/${HEARTBEAT_SCHEDULE_NAME_PREFIX}*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
  }
}
