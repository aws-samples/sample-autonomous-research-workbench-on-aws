import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as path from 'node:path';
import type { NeptuneStack } from './neptune-stack';
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as s3files from "aws-cdk-lib/aws-s3files";
import {
  HEARTBEAT_SCHEDULE_GROUP,
  HEARTBEAT_SCHEDULE_NAME_PREFIX,
  PROJECT_RUNTIME_CONFIG_PARAM,
  PROJECT_RUNTIME_NAME_PREFIX,
} from './agentcore/runtime/agentcore-runtime-stack';

export interface ApiServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  postgresCluster: rds.DatabaseCluster;
  neptune: NeptuneStack;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  userPoolDomain: cognito.UserPoolDomain;
  apiTargetGroup: elbv2.ApplicationTargetGroup;
  albSecurityGroup: ec2.SecurityGroup;
  /** Public HTTPS URL (CloudFront) — better-auth's baseURL / trusted origin. */
  publicUrl: string;
  /** In-VPC Electric SQL base URL (the /sync proxy's upstream). */
  electricUrl: string;
  /** In-VPC durable-streams base URL (the /v1/stream proxy's upstream). */
  streamsUrl: string;
  /** Bucket backing the project Files tab (presigned uploads/downloads). */
  filesBucket: s3.IBucket;
  /** ARN of the project_prospect AgentCore harness. */
  projectProspectHarnessArn?: string;
  /** ARN of the AgentCore run runtime (orchestrated run execution). */
  agentCoreRunRuntimeArn: string;
  /** AgentCore Gateway MCP endpoint the harness connects to per invocation. */
  agentcoreGateway: agentcore.Gateway;
  /** Cognito M2M app client for minting gateway bearer tokens. */
  gatewayM2mClient?: cognito.IUserPoolClient;
  /** Secrets Manager mirror of the M2M client secret. */
  gatewayM2mClientSecret?: secretsmanager.ISecret;
  /** OAuth scope to request in the client-credentials token call. */
  gatewayOauthScope?: string;
  /** Knowledge-document bucket the admin UI browses / uploads to / deletes from. */
  knowledgeBucket: s3.IBucket;
  /** S3 Files file system ID over the artifacts bucket's projects/ prefix. */
  s3FilesFileSystem: s3files.CfnFileSystem;
  /**
   * Shared execution role for per-project AgentCore runtimes. The API
   * passes it to CreateAgentRuntime at project activation.
   */
  projectRuntimeRole: iam.IRole;
  /** Lambda every project heartbeat schedule targets. */
  heartbeatTargetArn: string;
  /**
   * Role EventBridge Scheduler assumes to invoke the heartbeat Lambda. The
   * API passes it to CreateSchedule at project activation.
   */
  heartbeatSchedulerRole: iam.IRole;
  /** Ingestion Step Function the admin UI's "Sync" button starts. */
  ingestionStateMachine: sfn.IStateMachine;
}

/**
 * The Bun/Elysia API service (apps/api): better-auth, oRPC, OpenAPI docs.
 * Registered into the ALB's /api,/rpc,/sync,/v1/stream path rule and into
 * Cloud Map as api.platform.internal:4000 for in-VPC callers (web SSR).
 */
export class ApiServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  /** In-VPC base URL, e.g. "http://api.platform.internal:4000". */
  public readonly internalUrl = 'http://api.platform.internal:4000';

  constructor(scope: Construct, id: string, props: ApiServiceStackProps) {
    super(scope, id, props);

    const betterAuthSecret = new secretsmanager.Secret(this, 'BetterAuthSecret', {
      description: 'Secret used by better-auth to sign session tokens',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

    const container = taskDefinition.addContainer('api', {
      containerName: 'api',
      image: ecs.ContainerImage.fromAsset(repoRoot, {
        file: 'apps/api/Dockerfile',
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api' }),
      environment: {
        NODE_ENV: 'production',
        PORT: '4000',

        DB_ADDRESS: props.postgresCluster.clusterEndpoint.socketAddress,
        DB_NAME: 'application',

        // better-auth: OAuth callbacks and cookies live on the CloudFront origin.
        BETTER_AUTH_URL: props.publicUrl,
        TRUSTED_ORIGINS: props.publicUrl,

        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: `${props.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
        COGNITO_USERPOOL_ID: props.userPool.userPoolId,
        AWS_DEFAULT_REGION: this.region,

        ELECTRIC_URL: props.electricUrl,
        STREAMS_URL: props.streamsUrl,

        // Knowledge bucket admin: S3 browsing + ingestion Step Function sync.
        KNOWLEDGE_BUCKET: props.knowledgeBucket.bucketName,
        INGESTION_STATE_MACHINE_ARN: props.ingestionStateMachine.stateMachineArn,

        // Knowledge graph: Neptune over Bolt with SigV4 IAM auth.
        GRAPH_BOLT_URL: `bolt+ssc://${props.neptune.clusterEndpoint}`,
        GRAPH_AUTH: 'sigv4',

        // Project files: S3-backed file browser (presigned URLs).
        FILES_BUCKET: props.filesBucket.bucketName,

        // S3 Files: per-project access points are created against this
        // file system when a project is activated.
        S3_FILES_FILE_SYSTEM_ID: props.s3FilesFileSystem.attrFileSystemId,

        // Per-project AgentCore runtimes: activation reads the creation
        // config (image, role, network, env) from this SSM parameter.
        AGENTCORE_PROJECT_RUNTIME_CONFIG_PARAM: PROJECT_RUNTIME_CONFIG_PARAM,

        // Project heartbeats: activation creates one EventBridge Scheduler
        // schedule per project (the schedule holds the heartbeat config;
        // the API reads/updates it via GetSchedule/UpdateSchedule).
        HEARTBEAT_TARGET_ARN: props.heartbeatTargetArn,
        HEARTBEAT_SCHEDULER_ROLE_ARN: props.heartbeatSchedulerRole.roleArn,
        HEARTBEAT_SCHEDULE_GROUP: HEARTBEAT_SCHEDULE_GROUP,

        // AgentCore harness ARNs
        ...(props.projectProspectHarnessArn && {
          PROJECT_PROSPECT_HARNESS_ARN: props.projectProspectHarnessArn,
        }),

        // AgentCore run runtime the API dispatches orchestrated runs to
        // (@repo/queue's dispatch layer calls InvokeAgentRuntime on it).
        AGENTCORE_RUNTIME_ARN: props.agentCoreRunRuntimeArn,

        // AgentCore Gateway: MCP endpoint + Cognito M2M token settings. The
        // API mints a client-credentials token and attaches the gateway to
        // each harness invocation as a remote_mcp tool with an x-project-id
        // header (packages/orpc/routes/prospect.ts).
        AGENTCORE_GATEWAY_URL: props.agentcoreGateway.gatewayUrl!,
        ...(props.gatewayM2mClient && {
          GATEWAY_M2M_CLIENT_ID: props.gatewayM2mClient.userPoolClientId,
        }),
        ...(props.gatewayOauthScope && {
          GATEWAY_OAUTH_SCOPE: props.gatewayOauthScope,
        }),
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(props.postgresCluster.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.postgresCluster.secret!, 'password'),
        BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(betterAuthSecret),
        ...(props.gatewayM2mClientSecret && {
          GATEWAY_M2M_CLIENT_SECRET: ecs.Secret.fromSecretsManager(props.gatewayM2mClientSecret),
        }),
      },
    });

    container.addPortMappings({ containerPort: 4000 });

    const apiSG = new ec2.SecurityGroup(this, 'ServiceSG', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Security group for the API ECS service',
    });
    apiSG.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(4000), 'ALB to API');
    apiSG.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(4000),
      'In-VPC callers (web SSR) to API',
    );

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: 'Api',
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [apiSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: 'api',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.service.attachToApplicationTargetGroup(props.apiTargetGroup);

    // Standalone ingress rules created in THIS stack: the allowFrom helpers
    // would place them in the Database/Neptune stacks referencing our SG,
    // creating cross-stack cycles (we already depend on their endpoints).
    new ec2.CfnSecurityGroupIngress(this, 'DbIngressFromApi', {
      ipProtocol: 'tcp',
      fromPort: props.postgresCluster.clusterEndpoint.port,
      toPort: props.postgresCluster.clusterEndpoint.port,
      groupId: props.postgresCluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: apiSG.securityGroupId,
      description: 'Allow API to connect to Aurora PostgreSQL',
    });

    new ec2.CfnSecurityGroupIngress(this, 'NeptuneIngressFromApi', {
      ipProtocol: 'tcp',
      fromPort: 8182,
      toPort: 8182,
      groupId: props.neptune.cluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: apiSG.securityGroupId,
      description: 'Allow API to connect to Neptune',
    });

    props.neptune.grantConnect(taskDefinition.taskRole);

    // Project files browser: presigned PUT/GET against the artifacts bucket.
    props.filesBucket.grantReadWrite(taskDefinition.taskRole);

    // Knowledge admin endpoints: list/delete objects and mint presigned
    // GET/PUT URLs (presigning signs with the task role, so it needs the
    // underlying object permissions), plus start/inspect ingestion runs.
    props.knowledgeBucket.grantReadWrite(taskDefinition.taskRole);
    props.knowledgeBucket.grantDelete(taskDefinition.taskRole);
    props.ingestionStateMachine.grantStartExecution(taskDefinition.taskRole);
    props.ingestionStateMachine.grantRead(taskDefinition.taskRole);

    // Settings → Email tab: read-only view of the SES v2 domain identities
    // (the first one is the platform sending domain; identities themselves
    // are managed in the AWS console). ListEmailIdentities is not
    // resource-scopable; GetEmailIdentity is scoped to this account's
    // identities.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:ListEmailIdentities'],
        resources: ['*'],
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:GetEmailIdentity'],
        resources: [
          this.formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: '*',
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Per-project S3 Files access points: created on "Activate research",
    // deleted with the project. Access point ARNs live under the file
    // system ARN, so both grants stay scoped to our file system.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          's3files:CreateAccessPoint',
          's3files:DeleteAccessPoint',
          's3files:GetAccessPoint',
          's3files:TagResource',
        ],
        resources: [
          props.s3FilesFileSystem.attrFileSystemArn,
          `${props.s3FilesFileSystem.attrFileSystemArn}/access-point/*`,
        ],
      }),
    );

    // Allow the API to invoke the project_prospect AgentCore harness. The
    // harness ARN identifies the runtime resource the InvokeHarness call
    // targets; also cover its sub-resources (versions/endpoints) with a
    // wildcard so we don't have to re-grant when the harness is re-versioned.
    if (props.projectProspectHarnessArn) {
      taskDefinition.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:InvokeHarness',
            'bedrock-agentcore:InvokeAgentRuntime',
            'bedrock-agentcore:GetHarness',
          ],
          resources: [
            props.projectProspectHarnessArn,
            `${props.projectProspectHarnessArn}/*`,
          ],
        }),
      );
    }

    // Allow the API to dispatch orchestrated runs to the AgentCore run
    // runtime (startRun / startAgent / sendLeadMessage). Sub-resources
    // (versions/endpoints) covered by the wildcard.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          props.agentCoreRunRuntimeArn,
          `${props.agentCoreRunRuntimeArn}/*`,
        ],
      }),
    );

    // ── Per-project AgentCore runtimes ──────────────────────────────────────
    // Activation creates a runtime named project_<id> (worker image + the
    // project's S3 Files access point at /mnt/files); deletion tears it
    // down; dispatch invokes it. All name-scoped to the project_ prefix.
    const projectRuntimeArnPattern = this.formatArn({
      service: 'bedrock-agentcore',
      resource: 'runtime',
      resourceName: `${PROJECT_RUNTIME_NAME_PREFIX}*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateAgentRuntime',
          'bedrock-agentcore:CreateAgentRuntimeEndpoint',
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:DeleteAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:GetAgentRuntimeEndpoint',
          'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
          'bedrock-agentcore:TagResource',
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:GetWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
        ],
        resources: ["*"],
      }),
    );
    // ConflictException recovery path looks the runtime up by name.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:ListAgentRuntimes'],
        resources: ['*'],
      }),
    );
    // CreateAgentRuntime passes the shared execution role to the service.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.projectRuntimeRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'bedrock-agentcore.amazonaws.com',
          },
        },
      }),
    );
    // The creation config (image URI, role, network, env) lives in SSM.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: PROJECT_RUNTIME_CONFIG_PARAM.replace(/^\//, ''),
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // ── Project heartbeat schedules ─────────────────────────────────────────
    // Activation creates a schedule named project-heartbeat-<id>; settings
    // read and update it in place (the schedule is the config's source of
    // truth); project deletion removes it. All name-scoped to the heartbeat
    // group + prefix.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        resources: [
          this.formatArn({
            service: 'scheduler',
            resource: 'schedule',
            resourceName: `${HEARTBEAT_SCHEDULE_GROUP}/${HEARTBEAT_SCHEDULE_NAME_PREFIX}*`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // CreateSchedule/UpdateSchedule pass the scheduler execution role.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.heartbeatSchedulerRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'scheduler.amazonaws.com',
          },
        },
      }),
    );
  }
}
