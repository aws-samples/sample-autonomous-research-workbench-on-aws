import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface CloudFrontStackProps extends cdk.StackProps {
  /** Public ALB the distribution fronts (origin). */
  alb: elbv2.ApplicationLoadBalancer;
  /** Shared access-logs bucket (must have ACLs enabled for CloudFront). */
  accessLogsBucket: s3.IBucket;
}

/**
 * Public front door. CloudFront terminates TLS at the edge (using the default
 * *.cloudfront.net certificate — no custom domain, so no ACM cert needed) and
 * forwards everything to the ALB over HTTP. The ALB keeps doing the path-based
 * routing (web default, api on /api,/rpc,/sync,/v1/stream), so a single
 * catch-all behaviour is enough here.
 *
 * Nothing is cached: the app is entirely dynamic (auth, RPC, SSE), so the
 * behaviour disables caching and forwards the full viewer request (all
 * headers, cookies and query strings) to the origin. Static-asset caching can
 * be layered on later with extra path behaviours if needed.
 */
export class CloudFrontStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  /** Public HTTPS URL, e.g. "https://d111111abcdef8.cloudfront.net". */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: CloudFrontStackProps) {
    super(scope, id, props);

    const origin = new origins.LoadBalancerV2Origin(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      // SSE (/v1/stream/*) holds the origin connection open; give it the max
      // response/keepalive window CloudFront allows without a quota increase.
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Autonomous Research Workbench front door',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // RPC/auth use POST/PUT/DELETE, so the whole method set must be allowed.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Everything is dynamic: never cache, and forward the full viewer
        // request (headers/cookies/query) so auth cookies and CORS work.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      enableLogging: true,
      logBucket: props.accessLogsBucket,
      logFilePrefix: 'cloudfront/',
    });

    this.url = `https://${this.distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: this.url,
      description: 'Public URL of the application (CloudFront)',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });
  }
}
