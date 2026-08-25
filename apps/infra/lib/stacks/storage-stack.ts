import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface AccessLogsStorageStackProps extends cdk.StackProps {
  isProd: boolean;
}

export interface StorageStackProps extends cdk.StackProps {
  isProd: boolean;
  /** The app's public origin (CloudFront), allowed to upload/download via
   * presigned URLs from the browser. Dev deployments also allow localhost. */
  publicUrl: string;
  /**
   * Shared access-logs bucket (from AccessLogsStorageStack). Every bucket here
   * delivers S3 server access logs to it under its own prefix, so request-level
   * audit records survive independently of the bucket being audited.
   */
  accessLogsBucket: s3.IBucket;
}

/**
 * Holds the access-logs bucket only. Lives in its own stack (created before
 * the ALB) because the main StorageStack depends on CloudFront, which depends
 * on the ALB — passing a bucket from StorageStack into AlbStack would be a
 * circular dependency.
 */
export class AccessLogsStorageStack extends cdk.Stack {
  public readonly accessLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AccessLogsStorageStackProps) {
    super(scope, id, props);

    this.accessLogsBucket = new s3.Bucket(this, 'Access Logs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      // CloudFront standard logging delivers via bucket ACLs, so ACLs must be
      // enabled (buckets default to BUCKET_OWNER_ENFORCED / ACLs disabled).
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.isProd,
    });
  }
}

/**
 * Bucket-name prefix. Deliberately a short constant rather than
 * `this.stackName`: bucket names cap at 63 characters, and a nested stack's
 * name carries an 8-char CDK hash, so deriving from it left only a few
 * characters of headroom and broke the moment the umbrella stack was renamed.
 * `<prefix>-<account>-<role>` is globally unique via the account id.
 */
const BUCKET_PREFIX = 'research-workbench';

export class StorageStack extends cdk.Stack {
  public readonly artifactsBucket: s3.Bucket;
  public readonly knowledgeBucket: s3.Bucket;
  public readonly semanticBucket: s3.Bucket;
  public readonly lancedbBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // Origins allowed on browser-facing buckets: the public origin, plus
    // localhost in dev so presigned uploads work against local web dev.
    const corsOrigins = props.isProd
      ? [props.publicUrl]
      : [props.publicUrl, 'http://localhost:3000'];

    this.knowledgeBucket = new s3.Bucket(this, 'Knowledge Bucket', {
      bucketName: `${BUCKET_PREFIX}-${this.account}-knowledge`,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.isProd ? false : true,
      enforceSSL: true,
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 's3/knowledge/',
      // The knowledge admin UI uploads/downloads via presigned URLs straight
      // from the browser, so the bucket must answer cross-origin requests.
      // The URLs themselves are minted server-side behind the admin guard,
      // which is what actually gates access.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: corsOrigins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    this.semanticBucket = new s3.Bucket(this, 'Semantic Bucket', {
      bucketName: `${BUCKET_PREFIX}-${this.account}-ingestion-semantic`,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.isProd ? false : true,
      enforceSSL: true,
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 's3/semantic/',
    });

    // Dedicated LanceDB vector store (the semantic ingestion stage writes the
    // multimodal Embed v4 vectors here as an S3-backed LanceDB dataset). New
    // bucket, so no deployed name to match — follows the same region pattern.
    this.lancedbBucket = new s3.Bucket(this, 'LanceDB Bucket', {
      bucketName: `${BUCKET_PREFIX}-${this.account}-ingestion-lancedb`,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.isProd ? false : true,
      enforceSSL: true,
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 's3/lancedb/',
    });

    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      // Explicit name (not stack-derived): child-stack names are long and can
      // push a derived bucket name past S3's 63-char limit.
      bucketName: `${BUCKET_PREFIX}-${this.account}-artifacts`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.isProd ? false : true,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 's3/artifacts/',
      // Browser-direct presigned PUT/GET (project Files tab) needs CORS.
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: corsOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          id: 'TransitionToGlacier',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          id: 'AbortIncompleteMultipartUploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
  }
}
