import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3files from 'aws-cdk-lib/aws-s3files';
import { Construct } from 'constructs';

export interface S3FilesStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  bucket: s3.IBucket;
  prefix?: string;
}

export class S3FilesStack extends cdk.Stack {
  public readonly fileSystem: s3files.CfnFileSystem;
  public readonly mountTargetSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: S3FilesStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? '';
    if (prefix && !prefix.endsWith('/')) {
      throw new Error(`S3 Files prefix must end with '/': got '${prefix}'`);
    }

    // S3 Files assumes this role to sync data between S3 and the file system.
    const role = new iam.Role(this, 'S3FilesRole', {
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com'),
    });

    // S3 permissions: read/write access to the bucket and objects
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket*'],
      resources: [props.bucket.bucketArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:GetObject*', 's3:List*', 's3:PutObject*'],
      resources: [props.bucket.arnForObjects('*')],
    }));

    // EventBridge permissions: S3 Files creates rules prefixed "DO-NOT-DELETE-S3-Files"
    // to detect S3 object changes and trigger data synchronization.
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'events:DeleteRule', 'events:DisableRule', 'events:EnableRule',
        'events:PutRule', 'events:PutTargets', 'events:RemoveTargets',
      ],
      resources: [`arn:${cdk.Aws.PARTITION}:events:*:*:rule/DO-NOT-DELETE-S3-Files*`],
      conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule'],
      resources: [`arn:${cdk.Aws.PARTITION}:events:*:*:rule/*`],
    }));

    this.fileSystem = new s3files.CfnFileSystem(this, 'S3FilesFs', {
      bucket: props.bucket.bucketArn,
      ...(prefix ? { prefix } : {}),
      roleArn: role.roleArn,
      // Prefixes with many existing objects trigger a creation warning
      // (rename/move ops translate to copy+delete per object). Acknowledge
      // it so deploys don't fail as the bucket grows.
      acceptBucketWarning: true,
    });

    this.mountTargetSecurityGroup = new ec2.SecurityGroup(this, 'MountTargetSG', { vpc: props.vpc });

    // Create a mount target in each private subnet so Lambda can reach the file system via NFS.
    props.vpc.privateSubnets.forEach((subnet, i) =>
      new s3files.CfnMountTarget(this, `MountTarget${i}`, {
        fileSystemId: this.fileSystem.attrFileSystemId,
        subnetId: subnet.subnetId,
        securityGroups: [this.mountTargetSecurityGroup.securityGroupId],
      }),
    );
  }
}
