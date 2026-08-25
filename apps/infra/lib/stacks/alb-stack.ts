import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface AlbStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  isProd: boolean;
  /** SSE-S3 encrypted bucket the ALB writes its access logs to. */
  accessLogsBucket: s3.IBucket;
}

/**
 * Internet-facing ALB with path-based routing, sitting behind CloudFront:
 *
 *   default                                  -> web  (TanStack Start, :3000)
 *   /api/* /rpc/* /sync/* /v1/stream/*       -> api  (Bun/Elysia, :4000)
 *
 * TLS now terminates at CloudFront's edge, so the ALB listens on plain HTTP
 * and its security group only accepts traffic from CloudFront's origin-facing
 * managed prefix list — the ALB is not reachable directly from the internet.
 */
export class AlbStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly webTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly apiTargetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    // Resolve CloudFront's origin-facing managed prefix list ID for this
    // region (varies per region), so the ALB SG only admits CloudFront.
    const cloudFrontPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: ['com.amazonaws.global.cloudfront.origin-facing'],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing-prefix-list'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const cloudFrontPrefixListId = cloudFrontPrefixList.getResponseField(
      'PrefixLists.0.PrefixListId',
    );

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc,
      description: 'Security group for the ALB (CloudFront origin)',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixListId),
      ec2.Port.tcp(80),
      'Allow HTTP from CloudFront origin-facing edge locations only',
    );

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(300),
    });

    this.alb.logAccessLogs(props.accessLogsBucket, 'alb');

    this.webTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/login',
        protocol: elbv2.Protocol.HTTP,
        port: '3000',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
      },
    });

    this.apiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        protocol: elbv2.Protocol.HTTP,
        port: '4000',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
      },
    });

    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([this.webTargetGroup]),
      open: false,
    });

    new elbv2.ApplicationListenerRule(this, 'ApiPathRule', {
      listener,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api/*',
          '/rpc/*',
          '/sync/*',
          '/v1/stream/*',
        ]),
      ],
      action: elbv2.ListenerAction.forward([this.apiTargetGroup]),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Internal ALB DNS name (CloudFront origin)',
    });
  }
}
