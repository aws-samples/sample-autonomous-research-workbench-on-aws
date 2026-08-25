import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ElectricStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  postgresCluster: rds.DatabaseCluster;
}

/**
 * Electric SQL sync service. Streams Postgres changes to browsers through the
 * API's authenticated /sync proxy. Reachable in-VPC only, at
 * electric.platform.internal:3000.
 */
export class ElectricStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  /** In-VPC base URL, e.g. "http://electric.platform.internal:3000". */
  public readonly internalUrl = 'http://electric.platform.internal:3000';

  constructor(scope: Construct, id: string, props: ElectricStackProps) {
    super(scope, id, props);

    const { vpc, cluster, postgresCluster } = props;

    const electricSG = new ec2.SecurityGroup(this, 'ServiceSG', {
      vpc,
      description: 'Security group for the Electric SQL ECS service',
      allowAllOutbound: true,
    });
    electricSG.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(3000),
      'In-VPC callers (API sync proxy) to Electric',
    );

    // EFS for persistent shape-log storage.
    const efsSG = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc,
      description: 'Security group for Electric EFS',
      allowAllOutbound: false,
    });
    efsSG.addIngressRule(electricSG, ec2.Port.tcp(2049), 'Allow NFS from Electric service');

    const fileSystem = new efs.FileSystem(this, 'Storage', {
      vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      securityGroup: efsSG,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const accessPoint = fileSystem.addAccessPoint('AccessPoint', {
      path: '/electric',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    taskDefinition.addVolume({
      name: 'electric-data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    fileSystem.grant(
      taskDefinition.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );

    // Electric expects a single DATABASE_URL env var. Aurora credentials live
    // in Secrets Manager as individual fields, so inject them separately and
    // assemble the URL in a shell wrapper before exec-ing the entrypoint.
    const container = taskDefinition.addContainer('electric', {
      containerName: 'electric',
      image: ecs.ContainerImage.fromRegistry('electricsql/electric:1.7.8'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'electric',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        ELECTRIC_STORAGE_DIR: '/data',
        ELECTRIC_PORT: '3000',
        ELECTRIC_INSECURE: 'true',
        DB_HOST: postgresCluster.clusterEndpoint.hostname,
        DB_PORT: postgresCluster.clusterEndpoint.port.toString(),
        DB_NAME: 'application',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(postgresCluster.secret!, 'username'),
        DB_PASS: ecs.Secret.fromSecretsManager(postgresCluster.secret!, 'password'),
      },
      entryPoint: ['/bin/sh', '-c'],
      command: [
        'export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require" && exec /app/bin/entrypoint start',
      ],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -sf http://localhost:3000/v1/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addMountPoints({
      sourceVolume: 'electric-data',
      containerPath: '/data',
      readOnly: false,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: 'Electric',
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [electricSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: 'electric',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // Standalone ingress on the DB's SG, created in THIS stack: using
    // `postgresCluster.connections.allowDefaultPortFrom` would put the rule in
    // the Database stack and reference our SG, creating a cross-stack cycle
    // (Database -> Electric while Electric -> Database for the endpoint).
    new ec2.CfnSecurityGroupIngress(this, 'DbIngressFromElectric', {
      ipProtocol: 'tcp',
      fromPort: postgresCluster.clusterEndpoint.port,
      toPort: postgresCluster.clusterEndpoint.port,
      groupId: postgresCluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: electricSG.securityGroupId,
      description: 'Allow Electric SQL to connect to Aurora PostgreSQL',
    });

    new cdk.CfnOutput(this, 'ElectricServiceDns', {
      value: this.internalUrl,
      description: 'Internal base URL for Electric SQL (ELECTRIC_URL on the API)',
    });
  }
}
