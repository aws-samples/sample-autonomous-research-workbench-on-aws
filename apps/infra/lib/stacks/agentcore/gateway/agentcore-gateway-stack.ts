import {
  CfnGatewayTarget,
  Gateway,
  GatewayAuthorizer,
  GatewayProtocol,
  GatewayTarget,
  LambdaInterceptor,
  MCPProtocolVersion,
  McpGatewaySearchType,
  ToolSchema,
} from "aws-cdk-lib/aws-bedrockagentcore";
import * as cdk from "aws-cdk-lib";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import * as path from "node:path";

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  /** User pool whose JWTs the gateway accepts (inbound auth). */
  userPool: cognito.IUserPool;
  /** M2M app client (client-credentials grant) allowed to mint gateway tokens. */
  m2mClient: cognito.IUserPoolClient;
  /** VPC the tool Lambda runs in so it can reach Aurora. */
  vpc: ec2.Vpc;
  /** Aurora cluster the tool Lambda writes project-brief updates to. */
  postgresCluster: rds.DatabaseCluster;
}

export class AgentCoreGatewayStack extends cdk.Stack {
  public readonly gateway: Gateway;
  public readonly toolFunction: lambdanode.NodejsFunction;
  public readonly interceptorFunction: lambdanode.NodejsFunction;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);

    // REQUEST interceptor that forwards allowlisted client headers (x-project-id)
    // to the Lambda target. Client headers do not reach a Lambda target unless a
    // REQUEST interceptor echoes them back with passRequestHeaders=true; without
    // this the target sees an empty bedrockAgentCorePropagatedHeaders map.
    this.interceptorFunction = new lambdanode.NodejsFunction(
      this,
      "HeaderInterceptor",
      {
        functionName: `${this.stackName}-interceptor`,
        entry: path.join(__dirname, "./interceptor/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          platform: "node",
          externalModules: ["@aws-sdk/*"],
        },
      },
    );

    this.gateway = new Gateway(this, "Gateway", {
      gatewayName: this.stackName,
      protocolConfiguration: GatewayProtocol.mcp({
        supportedVersions: [MCPProtocolVersion.MCP_2025_06_18],
        searchType: McpGatewaySearchType.SEMANTIC,
        instructions:
          "Tools for agents. Use semantic search to discover tools.",
      }),
      authorizerConfiguration: GatewayAuthorizer.usingCognito({
        userPool: props.userPool,
        allowedClients: [props.m2mClient],
      }),
      // passRequestHeaders=true delivers the inbound headers to the interceptor;
      // the interceptor's returned headers are what actually reach the target.
      // Adding the interceptor auto-grants lambda:InvokeFunction on the gateway
      // role.
      interceptorConfigurations: [
        LambdaInterceptor.forRequest(this.interceptorFunction, {
          passRequestHeaders: true,
        }),
      ],
    });

    if (!this.gateway.gatewayUrl) {
      throw new Error("Gateway URL attribute is unavailable; it is required to wire the harness's remoteMcp tool.");
    }

    // Lambda that backs the gateway's MCP tools. It writes project-brief
    // updates to Aurora, so it runs in the VPC's private subnets and reads the
    // DB credentials from the cluster's managed secret at runtime.
    const toolSG = new ec2.SecurityGroup(this, "ToolFunctionSG", {
      vpc: props.vpc,
      // Needs egress to Aurora (in-VPC) and to Secrets Manager (via the NAT in
      // the PRIVATE_WITH_EGRESS subnets) to read the DB credentials.
      allowAllOutbound: true,
      description: "Security group for the gateway tool Lambda",
    });

    this.toolFunction = new lambdanode.NodejsFunction(this, "ToolFunction", {
      functionName: `${this.stackName}-tools`,
      entry: path.join(__dirname, "./lambda/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [toolSG],
      environment: {
        DB_SECRET_ARN: props.postgresCluster.secret!.secretArn,
        DB_HOST: props.postgresCluster.clusterEndpoint.hostname,
        DB_PORT: props.postgresCluster.clusterEndpoint.port.toString(),
        DB_NAME: "application",
      },
      bundling: {
        platform: "node",
        // pg is bundled; the AWS SDK is provided by the Lambda runtime.
        externalModules: ["@aws-sdk/*"],
      },
    });

    props.postgresCluster.secret!.grantRead(this.toolFunction);

    // Standalone ingress on the DB's SG, created in THIS stack (mirrors the API
    // and Electric stacks): using postgresCluster.connections.allowFrom would
    // place the rule in the Database stack referencing our SG and create a
    // cross-stack cycle, since we already depend on the cluster's endpoint.
    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromToolFunction", {
      ipProtocol: "tcp",
      fromPort: props.postgresCluster.clusterEndpoint.port,
      toPort: props.postgresCluster.clusterEndpoint.port,
      groupId: props.postgresCluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: toolSG.securityGroupId,
      description: "Allow the gateway tool Lambda to connect to Aurora PostgreSQL",
    });

    const target = GatewayTarget.forLambda(this, "ToolTarget", {
      gatewayTargetName: `${this.stackName}-tools`,
      gateway: this.gateway,
      lambdaFunction: this.toolFunction,
      toolSchema: ToolSchema.fromLocalAsset(
        path.join(__dirname, "tool-schema.json"),
      ),
    });

    // The L2 forLambda props don't expose metadataConfiguration, so set the
    // request-header allowlist on the underlying L1 resource. Only headers
    // listed here are forwarded from the invoke call to the Lambda target.
    const cfnTarget = target.node.defaultChild as CfnGatewayTarget;
    cfnTarget.addPropertyOverride(
      "MetadataConfiguration.AllowedRequestHeaders",
      ["x-project-id"],
    );

    // NOTE: the gateway only fronts the project-brief tools. Tools for
    // worker/orchestrated agents are served in-process via @repo/agent's
    // toolRegistry, not through a gateway target here.
  }
}
