import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgentCoreGatewayStack } from "./stacks/agentcore/gateway/agentcore-gateway-stack";
import { AgentCoreHarnessStack } from "./stacks/agentcore/harness/agentcore-harness-stack";
import { AgentCoreRuntimeStack } from "./stacks/agentcore/runtime/agentcore-runtime-stack";
import { AlbStack } from "./stacks/alb-stack";
import { ApiServiceStack } from "./stacks/api-service-stack";
import { CloudFrontStack } from "./stacks/cloudfront-stack";
import { CognitoStack } from "./stacks/cognito-stack";
import { DatabaseStack } from "./stacks/database-stack";
import { DurableStreamsStack } from "./stacks/durable-streams-stack";
import { EcsClusterStack } from "./stacks/ecs-cluster-stack";
import { ElectricStack } from "./stacks/electric-stack";
import { NeptuneStack } from "./stacks/neptune-stack";
import { S3FilesStack } from "./stacks/s3-files-stack";
import { StepFunctionIngestionStack } from "./stacks/step-function-ingestion-stack";
import { AccessLogsStorageStack, StorageStack } from "./stacks/storage-stack";
import { VpcStack } from "./stacks/vpc-stack";
import { WebServiceStack } from "./stacks/web-service-stack";

export interface InfraStackProps extends cdk.StackProps {
  readonly isProd?: boolean;
}

/**
 * Umbrella stack: every functional area lives in its own child CloudFormation
 * stack so they deploy independently, e.g.
 *
 *   cdk deploy 'ResearchWorkbench/Cognito'   # just the user pool / client
 *   cdk deploy 'ResearchWorkbench/Api'       # just the API service
 *   cdk deploy --all                # everything
 *
 * Access is via the ALB DNS name directly (path-based routing, self-signed
 * cert) — there is no CloudFront distribution any more.
 */
export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const isProd = props.isProd ?? false;
    const env = props.env;

    const vpc = new VpcStack(this, "Vpc", { env });

    const database = new DatabaseStack(this, "Database", {
      env,
      vpc: vpc.vpc,
      isProd,
    });

    const neptune = new NeptuneStack(this, "Neptune", {
      env,
      vpc: vpc.vpc,
      isProd,
    });

    // Access-logs bucket lives in its own stack so the ALB can use it: the
    // main StorageStack depends on CloudFront, which depends on the ALB, so
    // sourcing the bucket from there would be circular.
    const accessLogsStorage = new AccessLogsStorageStack(this, "AccessLogsStorage", {
      env,
      isProd,
    });

    // Front door: ALB with path-based routing (web default, api on /api etc.)
    const alb = new AlbStack(this, "Alb", {
      env,
      vpc: vpc.vpc,
      isProd,
      accessLogsBucket: accessLogsStorage.accessLogsBucket,
    });

    // CloudFront terminates TLS and fronts the ALB; its domain is the app's
    // public origin (better-auth, CORS and the Cognito callback all key off it).
    const cloudfront = new CloudFrontStack(this, "CloudFront", {
      env,
      alb: alb.alb,
      accessLogsBucket: accessLogsStorage.accessLogsBucket,
    });

    // After CloudFront: browser-facing buckets CORS-allow the public origin
    // for presigned uploads/downloads (plus localhost in dev).
    const storage = new StorageStack(this, "Storage", {
      env,
      isProd,
      publicUrl: cloudfront.url,
      accessLogsBucket: accessLogsStorage.accessLogsBucket,
    });

    // S3 Files: the artifacts bucket's projects/ tree as a mountable NFS
    // file system. Per-project access points get created at
    // project-provisioning time against this file system.
    const s3Files = new S3FilesStack(this, "S3Files", {
      env,
      vpc: vpc.vpc,
      bucket: storage.artifactsBucket,
      prefix: "projects/",
    });

    const ingestion = new StepFunctionIngestionStack(this, "Ingestion", {
      env,
      knowledgeBucket: storage.knowledgeBucket,
      semanticBucket: storage.semanticBucket,
      lancedbBucket: storage.lancedbBucket,
      vpc: vpc.vpc,
      neptuneCluster: neptune.cluster,
      bedrockModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      neptuneClientSecurityGroup: neptune.clientSecurityGroup,
      postgresCluster: database.postgresCluster,
      postgresClientSecurityGroup: database.clientSecurityGroup,
    });

    const cognito = new CognitoStack(this, "Cognito", {
      env,
      isProd,
      publicUrl: cloudfront.url,
    });

    const agentcoreGateway = new AgentCoreGatewayStack(this, "AgentCoreGateway", {
      env,
      userPool: cognito.userPool,
      m2mClient: cognito.gatewayM2mClient,
      vpc: vpc.vpc,
      postgresCluster: database.postgresCluster,
    });

    const projectProspect = new AgentCoreHarnessStack(this, "AgentCoreHarness", {
      env,
    });

    const ecsCluster = new EcsClusterStack(this, "EcsCluster", {
      env,
      vpc: vpc.vpc,
    });

    const electric = new ElectricStack(this, "Electric", {
      env,
      vpc: vpc.vpc,
      cluster: ecsCluster.cluster,
      postgresCluster: database.postgresCluster,
    });

    const durableStreams = new DurableStreamsStack(this, "DurableStreams", {
      env,
      vpc: vpc.vpc,
      cluster: ecsCluster.cluster,
    });

    // Execution substrate for orchestrated runs: the worker's processors
    // behind InvokeAgentRuntime. The API (and the runtime itself, for
    // spawn/resume/retry) dispatches { runId } pointers here; Postgres is
    // the source of truth and a scheduled sweep Lambda is the backstop.
    const agentcoreRuntime = new AgentCoreRuntimeStack(this, "AgentCoreRuntime", {
      env,
      vpc: vpc.vpc,
      postgresCluster: database.postgresCluster,
      neptune,
      streamsUrl: durableStreams.internalUrl,
      publicUrl: cloudfront.url,
      lancedbBucket: storage.lancedbBucket,
      s3Files,
    });

    const api = new ApiServiceStack(this, "Api", {
      env,
      vpc: vpc.vpc,
      cluster: ecsCluster.cluster,
      postgresCluster: database.postgresCluster,
      neptune,
      userPool: cognito.userPool,
      userPoolClient: cognito.userPoolClient,
      userPoolDomain: cognito.userPoolDomain,
      apiTargetGroup: alb.apiTargetGroup,
      albSecurityGroup: alb.albSecurityGroup,
      publicUrl: cloudfront.url,
      electricUrl: electric.internalUrl,
      streamsUrl: durableStreams.internalUrl,
      filesBucket: storage.artifactsBucket,
      projectProspectHarnessArn: projectProspect.harnessArn,
      agentCoreRunRuntimeArn: agentcoreRuntime.runtimeArn,
      agentcoreGateway: agentcoreGateway.gateway,
      gatewayM2mClient: cognito.gatewayM2mClient,
      gatewayM2mClientSecret: cognito.gatewayM2mClientSecret,
      gatewayOauthScope: cognito.gatewayOauthScope,
      knowledgeBucket: storage.knowledgeBucket,
      ingestionStateMachine: ingestion.stateMachine,
      s3FilesFileSystem: s3Files.fileSystem,
      projectRuntimeRole: agentcoreRuntime.projectRuntimeRole,
      heartbeatTargetArn: agentcoreRuntime.heartbeatTargetArn,
      heartbeatSchedulerRole: agentcoreRuntime.heartbeatSchedulerRole,
    });

    new WebServiceStack(this, "Web", {
      env,
      vpc: vpc.vpc,
      cluster: ecsCluster.cluster,
      webTargetGroup: alb.webTargetGroup,
      albSecurityGroup: alb.albSecurityGroup,
      apiInternalUrl: api.internalUrl,
    });
  }
}
