import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface DurableStreamsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
}

/**
 * Durable-streams (Electric Streams) server. Carries ephemeral, high-frequency
 * agent token/tool/reasoning deltas appended to per-run streams at
 * `/v1/stream/run-{runId}`. Durable rows still sync via the Electric SQL
 * service; this only handles the live agent stream. Reachable in-VPC only, at
 * streams.platform.internal:4437 — the browser reads through the API's
 * authenticated /v1/stream proxy.
 */
export class DurableStreamsStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  /** In-VPC base URL, e.g. "http://streams.platform.internal:4437". */
  public readonly internalUrl = 'http://streams.platform.internal:4437';

  constructor(scope: Construct, id: string, props: DurableStreamsStackProps) {
    super(scope, id, props);

    const { vpc, cluster } = props;

    const streamsSG = new ec2.SecurityGroup(this, 'ServiceSG', {
      vpc,
      description: 'Security group for the durable-streams ECS service',
      allowAllOutbound: true,
    });
    streamsSG.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(4437),
      'In-VPC callers (API stream proxy, workers) to durable-streams',
    );

    // EFS for persistent stream storage (file-backed store under /data).
    const efsSG = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc,
      description: 'Security group for durable-streams EFS',
      allowAllOutbound: false,
    });
    efsSG.addIngressRule(streamsSG, ec2.Port.tcp(2049), 'Allow NFS from durable-streams service');

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
      path: '/streams',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    taskDefinition.addVolume({
      name: 'streams-data',
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

    const container = taskDefinition.addContainer('durable-streams', {
      containerName: 'durable-streams',
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '..', '..', '..', '..', 'docker', 'durable-streams'),
        {
          file: 'Dockerfile.prod',
          platform: ecrAssets.Platform.LINUX_AMD64,
        },
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'durable-streams',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      // The Caddy admin endpoint is disabled, so there's no admin health route.
      // debian:bookworm-slim ships no curl/wget, so confirm the data-plane port
      // is accepting connections via bash's /dev/tcp.
      //
      // This is the only liveness probe for the container: Dockerfile.prod
      // deliberately declares no HEALTHCHECK (see the note there), because a
      // container-definition healthCheck overrides the image's. Don't remove
      // this block without adding a HEALTHCHECK to the image in its place.
      healthCheck: {
        command: ['CMD-SHELL', "bash -c '</dev/tcp/127.0.0.1/4437' 2>/dev/null || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
      essential: true,
    });

    container.addPortMappings({ containerPort: 4437 });

    container.addMountPoints({
      sourceVolume: 'streams-data',
      containerPath: '/data',
      readOnly: false,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: 'DurableStreams',
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [streamsSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      cloudMapOptions: {
        name: 'streams',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    new cdk.CfnOutput(this, 'StreamsServiceDns', {
      value: this.internalUrl,
      description: 'Internal base URL for durable-streams (STREAMS_URL on the API)',
    });

    new cdk.CfnOutput(this, 'StreamsEfsId', {
      value: fileSystem.fileSystemId,
      description: 'EFS filesystem ID for durable-streams storage',
    });
  }
}
