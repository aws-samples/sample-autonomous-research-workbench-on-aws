import type { NagAcknowledgement } from './nag-suppressions';

/**
 * Acknowledged AwsSolutions and PrototypeSecurity findings, each paired with the
 * evidence for why it is acceptable here. Any unlisted ERROR fails synthesis;
 * WARN-level findings are reported but non-blocking.
 *
 * Grouped by theme rather than by stack, because most of these come from a
 * handful of systemic causes (CDK's grant helpers, CDK's Lambda defaults) and
 * repeat across every stack that uses them.
 *
 * Deferred-to-production items are marked `PROD:` so they can be found and
 * reconsidered when `isProd` is turned on in bin/app.ts.
 */

const CDK_GRANT_ACTION_WILDCARDS =
  "Action wildcard comes from an aws-cdk-lib grant helper (grantRead/grantReadWrite/" +
  "grantDelete/grantConnect), not hand-written policy. These are CDK's fixed expansions of a " +
  'single logical permission — s3:GetObject* covers GetObject/GetObjectVersion/GetObjectTagging, ' +
  'neptune-db:* is the only documented action prefix for IAM database auth — and each statement ' +
  'is resource-scoped to one bucket or cluster owned by this app.';

const CDK_GRANT_RESOURCE_WILDCARDS =
  'Resource wildcard is the object-level suffix (bucket-arn/*) or sub-resource suffix that ' +
  'aws-cdk-lib grant helpers generate. The wildcard is confined to a single named bucket, ' +
  'file system, state machine or cluster created by this app — it does not widen past that ' +
  'resource, and the object keys inside it are created at runtime so they cannot be enumerated ' +
  'in the policy.';

export const NAG_ACKNOWLEDGEMENTS: readonly NagAcknowledgement[] = [
  // ── CDK-generated IAM policy (IAM4 / IAM5) ───────────────────────────────
  // The bulk of the findings. None of these come from policy this repo wrote by
  // hand; they are what CDK's grant helpers and Function defaults emit.
  {
    path: /./,
    rule: /^AwsSolutions-IAM4\[Policy::arn:<AWS::Partition>:iam::aws:policy\/service-role\/AWSLambda(BasicExecution|VPCAccessExecution)Role\]$/,
    reason:
      'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole are attached by the ' +
      'aws-cdk-lib Function construct itself. They grant only CloudWatch Logs writes and the ENI ' +
      'create/describe/delete calls the Lambda service needs to attach a function to a VPC. ' +
      'Inlining equivalents would restate identical permissions without narrowing them.',
  },
  {
    path: /./,
    rule: /^AwsSolutions-IAM5\[Action::(s3|neptune-db):/,
    reason: CDK_GRANT_ACTION_WILDCARDS,
  },

  // InvokeAgentRuntime / InvokeHarness: hand-written, so it carries its own
  // evidence rather than the generic grant-helper one below.
  {
    path: /Api\/TaskDef\/TaskRole|AgentCoreRuntime\/(SelfDispatchPolicy|HeartbeatTrigger|SweepTrigger)/,
    rule: /^AwsSolutions-IAM5\[Resource::(?:<Runtime|[^:\]]+:ExportsOutputFnGetAtt(?:HarnessArn|Runtime[^/\]]*AgentRuntimeArn))/,
    reason:
      'InvokeAgentRuntime/InvokeHarness needs the trailing wildcard to reach the runtime\'s ' +
      'sub-resources (runtime-endpoint/<name>, version qualifiers), which are created at invoke ' +
      'and re-version time rather than at deploy time. The prefix is a specific runtime or ' +
      'harness ARN owned by this app.',
  },

  // S3 Files uses a hand-written policy for its app-owned artifacts bucket.
  {
    path: 'S3Files/S3FilesRole',
    rule: /^AwsSolutions-IAM5\[Resource::[^:\]]+:ExportsOutputFnGetAttArtifactsBucket[^/\]]+\/\*\]$/,
    reason:
      'S3 Files synchronizes objects whose keys are created at runtime, so the role must address ' +
      'the object-level /* suffix. The wildcard is confined to the single artifacts bucket ' +
      'exported by this app\'s Storage stack and does not grant access to any other bucket.',
  },

  // Object-level and sub-resource wildcards on app-owned resources. CDK renders
  // cross-stack references as <producer>:ExportsOutput..., independent of the
  // root stack name; local unresolved references begin with <.
  {
    path: /./,
    rule: /^AwsSolutions-IAM5\[Resource::(?:<|[^:\]]+:ExportsOutput(?:FnGetAtt|Ref))/,
    reason: CDK_GRANT_RESOURCE_WILDCARDS,
  },
  {
    path: /./,
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:(neptune-db|states):/,
    reason: CDK_GRANT_RESOURCE_WILDCARDS,
  },
  {
    path: 'Ingestion/IngestionStateMachine/Role',
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:s3:::[^:\]]+:ExportsOutput(?:FnGetAtt|Ref)[^/\]]+\/\*\]$/,
    reason: CDK_GRANT_RESOURCE_WILDCARDS,
  },

  // ── Genuinely unscopable APIs ────────────────────────────────────────────
  // Resource::* survives only where the AWS API itself does not support
  // resource-level permissions. Each is listed against its own construct so a
  // new Resource::* anywhere else still fails the build.
  {
    path: 'Api/TaskDef/TaskRole',
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'ses:ListEmailIdentities does not support resource-level permissions (it enumerates the ' +
      'account\'s identities, so there is no ARN to scope to). The paired GetEmailIdentity call ' +
      'that reads an individual identity is scoped to identity/* in this account.',
  },
  {
    path: /(Api|Web|DurableStreams|Electric)\/TaskDef\/ExecutionRole/,
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'ECS task execution role, generated by aws-cdk-lib. The * is on ecr:GetAuthorizationToken, ' +
      'which is account-scoped by design and has no ARN form; the image pull and log writes in ' +
      'the same policy are scoped to this app\'s ECR repositories and log groups.',
  },
  {
    path: /(Web|DurableStreams|Electric)\/TaskDef\/TaskRole/,
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'enableExecuteCommand adds the ssmmessages:CreateControlChannel/CreateDataChannel/' +
      'OpenControlChannel/OpenDataChannel set that ECS Exec requires. None of these support ' +
      'resource-level permissions — the channel does not exist until the session is opened.',
  },
  {
    path: 'Alb/CloudFrontPrefixList/CustomResourcePolicy',
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'ec2:DescribeManagedPrefixLists is a read-only describe call with no resource-level ' +
      'permission support. It is used once at deploy time to look up the CloudFront origin-facing ' +
      'prefix list so the ALB only admits CloudFront traffic.',
  },
  {
    path: 'Ingestion/IngestionStateMachine/Role',
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'Added by aws-cdk-lib when a state machine enables logging and X-Ray tracing. The ' +
      'logs:*LogDelivery / logs:PutResourcePolicy / logs:DescribeLogGroups and xray:Put*/Get* ' +
      'actions are all account-scoped in the IAM model and reject a resource ARN, which is why ' +
      'CDK emits them this way.',
  },
  {
    path: /AgentCore(Runtime|Harness)/,
    rule: 'AwsSolutions-IAM5[Resource::*]',
    reason:
      'bedrock-agentcore runtimes require account-scoped observability permissions ' +
      '(logs:DescribeLogGroups, xray:PutTraceSegments/PutTelemetryRecords, ' +
      'cloudwatch:PutMetricData), none of which accept a resource ARN. The log-group writes ' +
      'alongside them are scoped to /aws/bedrock-agentcore/runtimes/*. The web-search tool\'s ' +
      'bedrock-agentcore:ConnectBrowserAutomationStream is here for the same reason: the CDP ' +
      'stream is not a resource until the connection is opened, so scoping it to the browser ARN ' +
      'evaluates to an implicit deny (checked with iam simulate-custom-policy). The paired ' +
      'Start/StopBrowserSession calls are scoped to the AWS-managed browser ARN.',
  },

  // ── AgentCore / Bedrock resource wildcards ──────────────────────────────
  {
    path: /AgentCore|Ingestion/,
    rule: /^AwsSolutions-IAM5\[Resource::arn:(<AWS::Partition>|aws):bedrock(-agentcore)?:/,
    reason:
      'Foundation-model and inference-profile ARNs are wildcarded because the model ID is a ' +
      'deploy-time/runtime choice (cross-region inference profiles resolve to several regional ' +
      'model ARNs), and runtime/project_* covers the per-project AgentCore runtimes created when ' +
      'a project is activated. Both stay within this account except for the foundation-model ' +
      'ARNs, which are AWS-owned read-only model endpoints.',
  },
  {
    path: /AgentCore/,
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:logs:/,
    reason:
      'AgentCore writes one log group per runtime under /aws/bedrock-agentcore/runtimes/, named ' +
      'after runtimes created at project-activation time, so the group and stream names cannot be ' +
      'enumerated at deploy time. Scoped to this account and region.',
  },
  {
    path: /AgentCore|Api\/TaskDef\/TaskRole/,
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:scheduler:/,
    reason:
      'Project heartbeat schedules are created per project as ' +
      'project-heartbeats/project-heartbeat-<id>, so the name is only known at runtime. The ' +
      'wildcard is confined to that one schedule group and name prefix.',
  },

  // ── Other unscopable service APIs ───────────────────────────────────────
  {
    path: 'Api/TaskDef/TaskRole',
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:ses:/,
    reason:
      'SES identities are managed outside this stack (created in the console when a sending ' +
      'domain is onboarded), so they have no deploy-time ARN. Scoped to identity/* in this ' +
      'account and the grant is read-only (GetEmailIdentity).',
  },
  {
    path: 'S3Files/S3FilesRole',
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:events:/,
    reason:
      'The S3 Files service manages its own EventBridge rules to detect object changes. The ' +
      'mutating grants are restricted to the DO-NOT-DELETE-S3-Files* name prefix AND gated on ' +
      'events:ManagedBy=elasticfilesystem.amazonaws.com; the broader rule/* entry is read-only ' +
      '(Describe/List) because the service discovers its rules by listing them.',
  },
  {
    path: 'AgentCoreGateway/Gateway/ServiceRole',
    rule: /^AwsSolutions-IAM5\[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-/,
    reason:
      'Read access to the CDK asset bucket, where the gateway\'s tool schema is staged as a ' +
      'deploy asset. Object keys are content-addressed hashes that change every deploy, so they ' +
      'cannot be enumerated in the policy.',
  },

  // ── ECS task definitions (ECS2) ──────────────────────────────────────────
  {
    path: /(Api|Web|Electric|DurableStreams)\/TaskDef\/Resource$/,
    rule: 'AwsSolutions-ECS2',
    reason:
      'The plaintext environment entries are non-sensitive configuration: endpoints, bucket and ' +
      'pool IDs, ARNs, ports, NODE_ENV and the AWS Solutions USER_AGENT_STRING injected by ' +
      'SolutionMetadataAspect. Every actual credential already goes through the task ' +
      'definition\'s `secrets` block from Secrets Manager (DB_USER, DB_PASSWORD, ' +
      'BETTER_AUTH_SECRET, GATEWAY_M2M_CLIENT_SECRET).',
  },

  // ── Rule evaluation failures (EC23) ─────────────────────────────────────
  {
    path: /(Api|Electric|DurableStreams)\/ServiceSG\/Resource$/,
    rule: 'AwsSolutions-EC23',
    reason:
      'Not an open security group — the rule threw because the ingress CIDR is an unresolved ' +
      'cross-stack Fn::ImportValue of the VPC CIDR block, which cdk-nag cannot evaluate. The ' +
      'ingress is ec2.Peer.ipv4(vpc.vpcCidrBlock), i.e. in-VPC callers only, never 0.0.0.0/0.',
  },
  {
    path: /Vpc\/VPC\/(BedrockRuntime|BedrockAgentCore|BedrockAgentRuntime|SecretsManager)\/SecurityGroup\/Resource$/,
    rule: 'AwsSolutions-EC23',
    reason:
      'Same false positive as above, one step earlier in the resolution chain: these are the ' +
      'security groups aws-cdk-lib creates for the interface VPC endpoints in VpcStack, and their ' +
      'ingress CIDR is an in-stack Fn::GetAtt on the VPC\'s CidrBlock rather than a cross-stack ' +
      'import, which cdk-nag also cannot resolve. The synthesized rule is tcp/443 from the VPC ' +
      'CIDR only — CDK\'s default endpoint SG — never 0.0.0.0/0.',
  },

  // ── Deferred to production ──────────────────────────────────────────────
  {
    path: 'CloudFront/Distribution',
    rule: /^AwsSolutions-CFR(4|5)$/,
    reason:
      'PROD: the distribution uses the default *.cloudfront.net certificate, which pins the ' +
      'viewer security policy to TLSv1 regardless of MinimumProtocolVersion — CFR4 is not ' +
      'satisfiable without a custom domain plus an ACM certificate. CFR5 needs the ALB to ' +
      'terminate TLS (also a cert) before the origin protocol can move off HTTP_ONLY. Both are ' +
      'part of the custom-domain work, and origin traffic stays inside AWS in the meantime.',
  },
  {
    path: 'CloudFront/Distribution',
    rule: 'AwsSolutions-CFR1',
    reason:
      'No geographic restriction is intended: the platform is used by researchers who may be in ' +
      'any country, so an allowlist would lock out legitimate users. Access is gated by Cognito ' +
      'authentication rather than by viewer location.',
  },
  {
    path: 'CloudFront/Distribution',
    rule: 'AwsSolutions-CFR2',
    reason:
      'PROD: no WAF web ACL on this prototype. Every route behind the distribution requires an ' +
      'authenticated session, and adding a WAF carries a per-ACL and per-request cost that is ' +
      'not justified before the app is publicly exposed.',
  },
  {
    path: /Api\/BetterAuthSecret|Cognito\/Gateway M2M Client Secret|Database\/Postgres DB\/Secret/,
    rule: 'AwsSolutions-SMG4',
    reason:
      'PROD: automatic rotation is not wired up on this prototype. Rotating the better-auth ' +
      'signing secret invalidates all live sessions, and the Cognito M2M client secret is a ' +
      'mirror of a value Cognito owns (rotating it in Secrets Manager alone would break the ' +
      'token exchange), so both need a rotation Lambda that understands the dependency before ' +
      'this can be enabled.',
  },
  {
    path: 'Database/Postgres DB/Resource',
    rule: 'AwsSolutions-RDS10',
    reason:
      'PROD: deletion protection is deliberately keyed to the isProd flag so prototype stacks ' +
      'can be torn down with `cdk destroy`. Setting isProd: true in bin/app.ts enables it, ' +
      'along with SNAPSHOT removal and private-isolated subnets.',
  },
  {
    path: 'Cognito/User Pool',
    rule: 'AwsSolutions-COG2',
    reason:
      'PROD: MFA is not enforced on this prototype. Sign-up is admin-only and the pool holds no ' +
      'production data yet; enforcing MFA requires an enrolment flow in the app first.',
  },
  {
    path: 'Cognito/User Pool',
    rule: 'AwsSolutions-COG8',
    reason:
      'PROD: the Plus feature plan carries a significant per-MAU cost increase for threat ' +
      'protection features (compromised-credential detection, adaptive auth) that a prototype ' +
      'with a handful of admin-created accounts does not benefit from.',
  },
  {
    path: 'AccessLogsStorage/Access Logs',
    rule: 'AwsSolutions-S1',
    reason:
      'This is the access-log destination bucket for every other bucket in the app. Pointing its ' +
      'own server access logs at itself would recurse (each log delivery generating another log ' +
      'record), and S3 does not permit a self-referencing logging target.',
  },

  // ── PrototypeSecurity pack ───────────────────────────────────────────────
  // The prototype-specific pack in bin/prototype-security.ts, which layers
  // CMK/VPC/AgentCore rules on top of AwsSolutions.
  {
    path: /(AccessLogsStorage\/Access Logs|Storage\/(Knowledge|Semantic|LanceDB) Bucket|Storage\/ArtifactsBucket)\/Resource$/,
    rule: 'PrototypeSecurity-CMK for S3 buckets',
    reason:
      'PROD: every one of these buckets is encrypted at rest with SSE-S3 (BucketEncryption.' +
      'S3_MANAGED, which is also the CDK default the three unannotated buckets pick up), and all ' +
      'of them set enforceSSL so data is encrypted in transit too. Moving to a CMK buys ' +
      'key-policy-level access control and an audit trail of key use, neither of which this ' +
      'prototype relies on, at the cost of a per-key monthly charge plus per-request KMS calls on ' +
      'a path that ingests whole document corpora. Revisit with the isProd work.',
  },
  {
    path: 'AgentCoreGateway/Gateway/Resource',
    rule: 'PrototypeSecurity-CMK for Bedrock AgentCore Gateway',
    reason:
      'PROD: the gateway falls back to AWS-owned encryption for the tool schemas and search index ' +
      'it stores. The aws-bedrockagentcore Gateway L2 does accept a `kmsKey`, so this is a ' +
      'deliberate deferral rather than a gap in the API — the key would also need granting to the ' +
      'gateway service role and to every M2M client that reads through it, which is part of the ' +
      'isProd hardening pass.',
  },
  {
    path: /\/AWS679f53fac002430cb0da5b7982bd2287\/Resource$/,
    rule: 'PrototypeSecurity-LambdaInsideVPC',
    reason:
      'aws-cdk-lib\'s AwsCustomResource provider Lambda, generated by the framework rather than ' +
      'declared here. It runs once at deploy time against public AWS control-plane endpoints ' +
      '(ec2:DescribeManagedPrefixLists for the ALB, Cognito configuration), so attaching it to ' +
      'the VPC would only add ENI cold-start latency and a NAT dependency for calls that never ' +
      'touch a private resource.',
  },
  {
    path: /Ingestion\/(Ingest|Extract|Semantic)Function\/Resource$/,
    rule: 'PrototypeSecurity-LambdaInsideVPC',
    reason:
      'These three ingestion stages talk only to S3 and Bedrock, both public-endpoint services, ' +
      'and hold no inbound network surface of their own. The stage that does reach a private ' +
      'resource — WriteGraphFunction, which connects to Neptune over Bolt — is in the VPC on ' +
      'private-with-egress subnets, which is why it is absent from this finding. Putting the ' +
      'other three in the VPC would require S3 and Bedrock interface endpoints (see the ' +
      'unresolved VPC-endpoint warnings from this same pack) or NAT egress for the container ' +
      'images, without narrowing what they can reach.',
  },
  {
    path: 'Vpc/VPC/Resource',
    rule: /^PrototypeSecurity-VPC Endpoint for (dynamodb|batch)$/,
    reason:
      'This app uses neither service. There is no DynamoDB table and no aws-cdk-lib/aws-dynamodb ' +
      'import anywhere in apps/infra — Aurora Postgres is the transactional store and Neptune the ' +
      'graph store — and no AWS Batch compute environment or job queue either: long-running ' +
      'compute runs on an AgentCore runtime. An interface endpoint for a service with no ' +
      'callers would bill per AZ-hour for an ENI nothing resolves. Endpoints for the other ' +
      'services this rule flags are in lib/stacks/vpc-stack.ts.',
  },
  {
    path: /AgentCoreGateway\/HeaderInterceptor\/Resource$|AgentCoreRuntime\/HeartbeatTrigger\/Resource$/,
    rule: 'PrototypeSecurity-LambdaInsideVPC',
    reason:
      'Both are invoked by AWS services from outside any VPC — the interceptor by AgentCore ' +
      'Gateway on each MCP request (it only rewrites headers, and reads nothing), the heartbeat ' +
      'trigger by EventBridge Scheduler to call InvokeAgentRuntime. Their only outbound calls are ' +
      'to bedrock-agentcore public endpoints, so VPC attachment would add NAT egress rather than ' +
      'isolation.',
  },
];
