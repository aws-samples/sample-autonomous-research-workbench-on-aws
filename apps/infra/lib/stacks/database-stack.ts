import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdanode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  isProd: boolean;
}

export class DatabaseStack extends cdk.Stack {
  public readonly postgresCluster: rds.DatabaseCluster;
  public readonly migrationFunction: lambdanode.NodejsFunction;

  /**
   * Security group for clients that need to reach Postgres (e.g. the ingestion
   * WriteStatus Lambda). Its ingress rule to the cluster is created here so
   * consumers only depend on this stack — attaching it from another stack
   * avoids a CloudFormation dependency cycle (same pattern as Neptune's).
   */
  public readonly clientSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    const subnetGroup = new rds.SubnetGroup(this, 'DB Subnet Group', {
      description: 'Subnet group for Aurora PostgreSQL cluster',
      vpc,
      vpcSubnets: { subnetType: props.isProd ? ec2.SubnetType.PRIVATE_ISOLATED : ec2.SubnetType.PUBLIC },
    });

    this.postgresCluster = new rds.DatabaseCluster(this, 'Postgres DB', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_9,
      }),
      parameters: {
        'rds.logical_replication': '1',
      },
      writer: rds.ClusterInstance.serverlessV2('writer', { publiclyAccessible: !props.isProd }),
      defaultDatabaseName: 'application',
      autoMinorVersionUpgrade: true,
      iamAuthentication: true,
      storageEncrypted: true,
      enableDataApi: true,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
      deletionProtection: props.isProd,
      subnetGroup,
      vpc,
      backup: {
        retention: cdk.Duration.days(7),
      },
    });

    // ── Drizzle migration Lambda ─────────────────────────────────────────
    // Applies packages/database/drizzle/*.sql to the cluster. Invoke after a
    // deploy that changes the schema:
    //
    //   aws lambda invoke --function-name <MigrationFunctionArn> /dev/stdout

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'MigrationLambdaSG', {
      vpc,
      description: 'Security group for the DB migration Lambda',
      allowAllOutbound: true,
    });

    this.postgresCluster.connections.allowDefaultPortFrom(
      lambdaSecurityGroup,
      'Allow migration Lambda to connect to Aurora PostgreSQL',
    );

    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

    this.migrationFunction = new lambdanode.NodejsFunction(this, 'DbMigrationFunction', {
      functionName: `${this.stackName}-MigrationFunction`,
      entry: path.join(repoRoot, 'packages', 'database', 'migrate.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      // The cluster lives in public subnets in non-prod (publiclyAccessible
      // writer); the Lambda still reaches it over the VPC network from the
      // private subnets.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      timeout: cdk.Duration.minutes(5),
      environment: {
        DATABASE_SECRET_ARN: this.postgresCluster.secret!.secretArn,
      },
      bundling: {
        platform: 'node',
        // esbuild inlines pg and drizzle-orm into the bundle (installing them
        // via nodeModules pulls the whole pnpm workspace past Lambda's 250MB
        // limit). The AWS SDK ships with the Node 24 runtime and pg-native is
        // an optional native binding pg probes for — keep both external.
        externalModules: ['@aws-sdk/client-secrets-manager', 'pg-native'],
        commandHooks: {
          // Copy the Drizzle SQL migrations next to the bundle so the
          // migrator can read them at runtime.
          beforeBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${path.join(inputDir, 'packages', 'database', 'drizzle')} ${outputDir}`,
          ],
          beforeInstall: () => [],
          afterBundling: () => [],
        },
      },
    });

    this.postgresCluster.secret!.grantRead(this.migrationFunction);

    // Shared client SG: consumers attach it to their compute and it is already
    // allowed into Postgres' port. Rule lives in this stack so the dependency
    // only flows consumer -> Database.
    this.clientSecurityGroup = new ec2.SecurityGroup(this, 'ClientSg', {
      vpc,
      description: 'Clients allowed to connect to Postgres',
      allowAllOutbound: true,
    });
    this.postgresCluster.connections.allowDefaultPortFrom(
      this.clientSecurityGroup,
      'Postgres clients (ingestion WriteStatus, etc.)',
    );

    new cdk.CfnOutput(this, 'MigrationFunctionArn', {
      value: this.migrationFunction.functionArn,
      description: 'Invoke this Lambda to apply Drizzle migrations',
    });
  }
}
