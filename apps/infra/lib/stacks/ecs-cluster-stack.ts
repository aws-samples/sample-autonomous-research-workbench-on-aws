import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface EcsClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

/**
 * Shared ECS cluster + private Cloud Map namespace. Every service (web, api,
 * electric, durable-streams) runs on this cluster and registers into
 * `platform.internal` for in-VPC service discovery, e.g.
 * `http://api.platform.internal:4000`.
 */
export class EcsClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.INamespace;

  constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'research-workbench',
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: {
        name: 'platform.internal',
      },
    });

    this.namespace = this.cluster.defaultCloudMapNamespace!;
  }
}
