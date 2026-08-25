import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      // Rejected-traffic flow logs only: enough to diagnose "why can't X reach
      // Y" (the usual SG/NACL misconfiguration) without paying to ingest every
      // accepted packet's metadata. Retention is capped since these are a
      // debugging aid, not an audit record.
      flowLogs: {
        Rejects: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
      // Gateway endpoints are route-table entries rather than ENIs, so they
      // cost nothing and only need to exist for a service this app actually
      // calls. S3 qualifies heavily: the artifacts/knowledge/semantic/LanceDB
      // buckets are read and written from in-VPC compute (API and web tasks,
      // the worker runtime, the ingestion state machine) and ECR pulls its
      // image layers from S3 too, so this also takes container-image traffic
      // off the NAT.
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // Interface endpoints for the AWS APIs that in-VPC compute calls on the
    // hot path, so that traffic reaches the service over PrivateLink instead
    // of egressing through the NAT gateway. Each one is an ENI per subnet with
    // an hourly charge, so the list is deliberately limited to services this
    // app genuinely uses — see the acknowledged VPC-endpoint findings in
    // lib/nag-acknowledgements.ts for the flagged services it does not.
    //
    // Private DNS is on (the CDK default), so the SDKs in the worker, API and
    // Lambda code resolve the normal service hostnames to these ENIs with no
    // client-side configuration. The endpoint security group admits 443 from
    // the VPC CIDR, again the CDK default.
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      // InvokeModel / InvokeModelWithResponseStream: the agent tools in the
      // worker runtime and the ingestion Lambdas' extraction calls.
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      // InvokeAgentRuntime and the AgentCore control plane: the API task
      // dispatches runs here, and the runtime itself re-invokes for
      // spawn/resume/retry.
      BedrockAgentCore: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENTCORE,
      // Bedrock Agents / Knowledge Bases data plane (InvokeAgent, Retrieve,
      // RetrieveAndGenerate). Nothing calls it today — retrieval is a LanceDB
      // index on S3 plus Neptune, queried in-process by the worker — so this
      // is here to keep the private path ready if a Knowledge Base is added,
      // and to satisfy the pack's endpoint rule for it.
      BedrockAgentRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
      // Aurora and Neptune credentials, fetched on every task and runtime
      // cold start.
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    };

    for (const [id, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(id, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }
  }
}
