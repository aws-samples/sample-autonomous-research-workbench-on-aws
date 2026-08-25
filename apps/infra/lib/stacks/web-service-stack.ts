import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface WebServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  webTargetGroup: elbv2.ApplicationTargetGroup;
  albSecurityGroup: ec2.SecurityGroup;
  /**
   * In-VPC base URL of the API (Cloud Map DNS). The web server-side render
   * calls the API through this instead of looping back out via the ALB.
   */
  apiInternalUrl: string;
}

/**
 * The TanStack Start web app (apps/web). The browser talks to the API
 * same-origin through the ALB path rules; only the SSR pass uses the internal
 * SERVICE_URL. The web app holds no database or auth server code any more.
 */
export class WebServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: WebServiceStackProps) {
    super(scope, id, props);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

    const container = taskDefinition.addContainer('web', {
      containerName: 'web',
      image: ecs.ContainerImage.fromAsset(repoRoot, {
        file: 'apps/web/Dockerfile',
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web' }),
      environment: {
        NODE_ENV: 'production',
        // SSR-side API base URL (browser-side is same-origin via the ALB).
        SERVICE_URL: props.apiInternalUrl,
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    const webSG = new ec2.SecurityGroup(this, 'ServiceSG', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Security group for the web ECS service',
    });
    webSG.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(3000), 'ALB to web');

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: 'Web',
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [webSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
    });

    this.service.attachToApplicationTargetGroup(props.webTargetGroup);
  }
}
