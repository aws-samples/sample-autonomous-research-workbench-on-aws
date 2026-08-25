import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as neptune from '@aws-cdk/aws-neptune-alpha';
import { Construct } from 'constructs';

export interface NeptuneStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  isProd: boolean;
}

export class NeptuneStack extends cdk.Stack {
  public readonly cluster: neptune.DatabaseCluster;

  public readonly clientSecurityGroup: ec2.SecurityGroup;

  public get clusterEndpoint(): string {
    return this.cluster.clusterEndpoint.socketAddress;
  }

  public get readerEndpoint(): string {
    return this.cluster.clusterReadEndpoint.socketAddress;
  }

  /** Allow a connectable peer (e.g. the ECS service) to reach Neptune's port. */
  public allowFrom(peer: ec2.IConnectable, description?: string): void {
    this.cluster.connections.allowDefaultPortFrom(
      peer,
      description ?? 'Allow access to Neptune',
    );
  }

  /** Grant an IAM principal neptune-db:* access for IAM database authentication. */
  public grantConnect(grantee: iam.IGrantable): void {
    this.cluster.grantConnect(grantee);
  }

  constructor(scope: Construct, id: string, props: NeptuneStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    this.cluster = new neptune.DatabaseCluster(this, 'Graph DB', {
      vpc,
      vpcSubnets: {
        subnetType: props.isProd ? ec2.SubnetType.PRIVATE_ISOLATED : ec2.SubnetType.PUBLIC,
      },
      instanceType: neptune.InstanceType.SERVERLESS,
      serverlessScalingConfiguration: {
        minCapacity: 1,
        maxCapacity: 32,
      },
      engineVersion: neptune.EngineVersion.V1_4_6_1,
      iamAuthentication: true,
      storageEncrypted: true,
      autoMinorVersionUpgrade: true,
      // Match the Postgres cluster's retention: a week of automated snapshots
      // is enough to recover from a bad ingestion run overwriting the graph.
      backupRetention: cdk.Duration.days(7),
      removalPolicy: props.isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
      deletionProtection: props.isProd,
    });

    this.clientSecurityGroup = new ec2.SecurityGroup(this, "ClientSg", {
      vpc,
      description: "Clients allowed to connect to Neptune over Bolt",
    });
    this.cluster.connections.allowDefaultPortFrom(
      this.clientSecurityGroup,
      "Allow Neptune clients (e.g. ingestion writers) over Bolt",
    );
  }
}
