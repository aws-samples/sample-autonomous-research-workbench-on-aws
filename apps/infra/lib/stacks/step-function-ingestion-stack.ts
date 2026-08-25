import * as neptune from "@aws-cdk/aws-neptune-alpha";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrassets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as python from "@aws-cdk/aws-lambda-python-alpha";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import * as path from "node:path";

export interface StepFunctionIngestionStackProps extends cdk.StackProps {
  /**
   * Bucket the ingestion Step Function maps over. Every object dumped here is
   * processed when the state machine is invoked.
   */
  readonly knowledgeBucket: s3.IBucket;

  /**
   * Scratch bucket for stage handoffs. The per-file stages exchange their
   * intermediate artifacts (ingested text, extracted infons) here between
   * steps, so the multi-megabyte payloads never travel inline through Step
   * Functions state.
   */
  readonly semanticBucket: s3.IBucket;

  /** S3-backed LanceDB vector store the semantic stage writes embeddings to. */
  readonly lancedbBucket: s3.IBucket;

  /** VPC the graph stages run in so they can reach Neptune. */
  readonly vpc: ec2.IVpc;

  /** Graph target: the pipeline writes documents + infons here over Bolt. */
  readonly neptuneCluster: neptune.IDatabaseCluster;

  /**
   * Neptune's client security group. The graph-writer Lambdas attach it so
   * they can reach the cluster's Bolt port; the ingress rule lives in the
   * Neptune stack, so referencing it here keeps the dependency one-way
   * (Ingestion -> Neptune) and avoids a cross-stack cycle.
   */
  readonly neptuneClientSecurityGroup: ec2.ISecurityGroup;

  /**
   * Bedrock model id for extraction + the VLM fallback (bedrock.py reads
   * BEDROCK_MODEL_ID). Must be a model the account has subscribed in
   * bedrockRegion.
   */
  readonly bedrockModelId: string;

  /**
   * Application Postgres cluster. The in-VPC WriteStatus stage upserts each
   * document's per-index status here after the graph + semantic branches join.
   */
  readonly postgresCluster: rds.DatabaseCluster;

  /**
   * Postgres client security group (owned by the Database stack, already
   * allowed into the cluster's port). Attached to WriteStatus. Passing it in —
   * rather than calling allowDefaultPortFrom here — keeps the dependency
   * one-way (Ingestion -> Database) and avoids a CloudFormation cycle.
   */
  readonly postgresClientSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Ingestion Step Function. Instead of one Lambda per file, the per-file work is
 * broken into three chained stages inside a Distributed Map, preceded by a
 * one-time ontology-write:
 *
 *   WriteOntology                          (once, before fan-out)
 *   └─ Map over every object in knowledge bucket, maxConcurrency 3:
 *        Ingest      (container: Docling convert + PPTX/VLM recovery -> text)
 *        ├─ graph:    Extract (Bedrock triples) -> WriteGraph (Neptune)
 *        └─ semantic: Docling-with-images -> Embed v4 -> LanceDB (S3)
 *
 * After Ingest a Parallel state fans out into the graph branch and the semantic
 * (vector) branch; both consume the ingested output and run independently.
 *
 * Stages hand off multi-megabyte payloads (document text, infons) via S3
 * artifacts in the semantic bucket — only small pointers travel through the
 * state machine, staying well under the 256 KB state limit.
 *
 * Invoke with an empty input `{}` to process every object in the bucket.
 */
export class StepFunctionIngestionStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: StepFunctionIngestionStackProps,
  ) {
    super(scope, id, props);

    const {
      knowledgeBucket,
      semanticBucket,
      lancedbBucket,
      vpc,
      neptuneCluster,
      neptuneClientSecurityGroup,
      bedrockModelId,
      postgresCluster,
      postgresClientSecurityGroup,
    } = props;

    const lambdaRoot = path.resolve(__dirname, "../lambda/ingestion");
    // PythonFunction copies `entry` into the asset itself and does not consult
    // the repo .dockerignore, so local tool caches would otherwise land in the
    // asset and churn its hash on every local run — forcing a Docker rebuild.
    const pythonBundling: python.BundlingOptions = {
      assetExcludes: [
        "__pycache__",
        "**/__pycache__",
        ".ruff_cache",
        ".mypy_cache",
        ".pytest_cache",
      ],
    };
    // bolt+ssc://<host>:<port> — Neptune's TLS Bolt endpoint. GraphStore reads
    // GRAPH_AUTH=sigv4 and signs each connection with the caller's IAM creds.
    const graphBoltUrl = `bolt+ssc://${neptuneCluster.clusterEndpoint.hostname}:${neptuneCluster.clusterEndpoint.port}`;

    // Shared env for the two graph-writing stages (Neptune over Bolt + SigV4).
    const graphEnv: Record<string, string> = {
      GRAPH_BOLT_URL: graphBoltUrl,
      GRAPH_AUTH: "sigv4",
      // GraphStore's SigV4 signer reads AWS_DEFAULT_REGION/AWS_REGION, which
      // Lambda sets to this function's region (same region as Neptune).
      SEMANTIC_BUCKET: semanticBucket.bucketName,
    };

    // ── Stage 1: Ingest (container — Docling + torch + LibreOffice/poppler) ──
    const ingestFn = new lambda.DockerImageFunction(this, "IngestFunction", {
      functionName: `${this.stackName}-Ingest`,
      // finch on Apple Silicon builds arm64; the function must run arm64 too or
      // Lambda fails with Runtime.InvalidEntrypoint (exec format error). The
      // asset platform is pinned to match.
      architecture: lambda.Architecture.ARM_64,
      code: lambda.DockerImageCode.fromImageAsset(path.join(lambdaRoot, "ingest"), {
        platform: ecrassets.Platform.LINUX_ARM64,
      }),
      // Docling + torch are memory hungry; give them the full Lambda maximum.
      memorySize: 10240,
      // Docling model load can be slow on a cold page.
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: {
        SEMANTIC_BUCKET: semanticBucket.bucketName,
        BEDROCK_REGION: this.region,
        BEDROCK_MODEL_ID: bedrockModelId,
        DOCLING_CACHE_DIR: "/tmp/docling-cache",
      },
    });
    knowledgeBucket.grantRead(ingestFn);
    semanticBucket.grantReadWrite(ingestFn);
    grantBedrock(ingestFn, this.region, this.region);

    // ── Stage 2: Extract (zip — ontology-steered Bedrock extraction) ────────
    const extractFn = new python.PythonFunction(this, "ExtractFunction", {
      functionName: `${this.stackName}-Extract`,
      entry: path.join(lambdaRoot, "graph"),
      bundling: pythonBundling,
      index: "extract_handler.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      environment: {
        SEMANTIC_BUCKET: semanticBucket.bucketName,
        BEDROCK_REGION: this.region,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
    });
    semanticBucket.grantReadWrite(extractFn);
    grantBedrock(extractFn, this.region, this.region);

    // ── Stage 3: WriteGraph (zip — MERGE into Neptune over Bolt) ────────────
    const writeGraphFn = new python.PythonFunction(this, "WriteGraphFunction", {
      functionName: `${this.stackName}-WriteGraph`,
      entry: path.join(lambdaRoot, "graph"),
      bundling: pythonBundling,
      index: "write_graph.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [neptuneClientSecurityGroup],
      environment: graphEnv,
    });
    semanticBucket.grantRead(writeGraphFn);
    neptuneCluster.grantConnect(writeGraphFn);

    // ── Semantic (container — Docling-with-images + Embed v4 -> LanceDB) ─────
    // Parallel branch to the graph path. Re-parses the original with images
    // (stage 1 is text-only), embeds text/figure/table/page surfaces, and
    // appends to the S3-backed LanceDB store. Not in the VPC — it only needs
    // S3 + Bedrock.
    const semanticFn = new lambda.DockerImageFunction(this, "SemanticFunction", {
      functionName: `${this.stackName}-Semantic`,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.DockerImageCode.fromImageAsset(path.join(lambdaRoot, "semantic"), {
        platform: ecrassets.Platform.LINUX_ARM64,
      }),
      // Docling's multimodal pipeline retains page/figure images, vectors, and
      // LanceDB records together; use the full Lambda maximum to avoid OOMs.
      memorySize: 10240,
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: {
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        LANCEDB_BUCKET: lancedbBucket.bucketName,
        BEDROCK_REGION: this.region,
        BEDROCK_MODEL_ID: bedrockModelId,
        DOCLING_CACHE_DIR: "/tmp/docling-cache",
      },
    });
    knowledgeBucket.grantRead(semanticFn);
    lancedbBucket.grantReadWrite(semanticFn);
    grantBedrock(semanticFn, this.region, this.region);

    // ── Pre-Map: WriteOntology (zip — runs once before fan-out) ─────────────
    const writeOntologyFn = new python.PythonFunction(this, "WriteOntologyFunction", {
      functionName: `${this.stackName}-WriteOntology`,
      entry: path.join(lambdaRoot, "graph"),
      bundling: pythonBundling,
      index: "write_ontology.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [neptuneClientSecurityGroup],
      environment: graphEnv,
    });
    neptuneCluster.grantConnect(writeOntologyFn);

    // ── Post-branch: WriteStatus (zip, in-VPC — upsert per-doc status to PG) ─
    // Attaches the Database stack's client SG (already allowed into Postgres);
    // the ingress rule lives in the Database stack so the dependency only flows
    // Ingestion -> Database (no cross-stack cycle).
    const writeStatusFn = new python.PythonFunction(this, "WriteStatusFunction", {
      functionName: `${this.stackName}-WriteStatus`,
      entry: path.join(lambdaRoot, "graph"),
      bundling: pythonBundling,
      index: "write_status.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(2),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [postgresClientSecurityGroup],
      environment: {
        DB_SECRET_ARN: postgresCluster.secret!.secretArn,
        DB_ADDRESS: postgresCluster.clusterEndpoint.hostname,
        DB_NAME: "application",
      },
    });
    postgresCluster.secret!.grantRead(writeStatusFn);

    // ── Pre-Map: BuildManifest (zip, in-VPC — reconcile S3 vs DB) ────────────
    // Lists the knowledge bucket, self-heals a `pending` document row for any
    // object without one (so direct-to-S3 uploads need no API), and writes the
    // still-pending file list to a manifest the Map iterates. Honors a
    // replaceExisting execution-input flag to force full reprocessing.
    const manifestKey = "manifests/pending.json";
    const buildManifestFn = new python.PythonFunction(this, "BuildManifestFunction", {
      functionName: `${this.stackName}-BuildManifest`,
      entry: path.join(lambdaRoot, "graph"),
      bundling: pythonBundling,
      index: "build_manifest.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [postgresClientSecurityGroup],
      environment: {
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        MANIFEST_BUCKET: semanticBucket.bucketName,
        MANIFEST_KEY: manifestKey,
        DB_SECRET_ARN: postgresCluster.secret!.secretArn,
        DB_ADDRESS: postgresCluster.clusterEndpoint.hostname,
        DB_NAME: "application",
      },
    });
    knowledgeBucket.grantRead(buildManifestFn);
    semanticBucket.grantReadWrite(buildManifestFn);
    postgresCluster.secret!.grantRead(buildManifestFn);

    // ── State machine wiring ────────────────────────────────────────────────

    // Runs once; its run_at timestamp is threaded to every document write.
    const writeOntologyTask = new tasks.LambdaInvoke(this, "WriteOntology", {
      lambdaFunction: writeOntologyFn,
      payload: sfn.TaskInput.fromObject({}),
      resultSelector: { "run_at.$": "$.Payload.run_at" },
      resultPath: "$.ontology",
    });

    // Reconciles S3 vs DB and writes the pending-file manifest. Receives the
    // execution input (for replaceExisting); its output is kept on $.manifest.
    const buildManifestTask = new tasks.LambdaInvoke(this, "BuildManifest", {
      lambdaFunction: buildManifestFn,
      // Pass the whole execution input so an optional {replaceExisting:true}
      // reaches the Lambda; it defaults the flag when absent. (Referencing
      // $.replaceExisting directly would fail when the input omits it.)
      payload: sfn.TaskInput.fromJsonPathAt("$$.Execution.Input"),
      resultSelector: {
        "bucket.$": "$.Payload.manifest_bucket",
        "key.$": "$.Payload.manifest_key",
        "pending.$": "$.Payload.pending",
      },
      resultPath: "$.manifest",
    });

    // Per-file chain inside the Distributed Map.
    const ingestTask = new tasks.LambdaInvoke(this, "Ingest", {
      lambdaFunction: ingestFn,
      outputPath: "$.Payload",
    });
    const extractTask = new tasks.LambdaInvoke(this, "Extract", {
      lambdaFunction: extractFn,
      outputPath: "$.Payload",
    });
    const writeGraphTask = new tasks.LambdaInvoke(this, "WriteGraph", {
      lambdaFunction: writeGraphFn,
      outputPath: "$.Payload",
    });
    const semanticTask = new tasks.LambdaInvoke(this, "Semantic", {
      lambdaFunction: semanticFn,
      outputPath: "$.Payload",
    });

    // Retry transient Lambda/Bedrock/Neptune errors on each stage.
    const retryProps: sfn.RetryProps = {
      errors: [
        "Lambda.ServiceException",
        "Lambda.TooManyRequestsException",
        "States.TaskFailed",
      ],
      interval: cdk.Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    };
    ingestTask.addRetry(retryProps);
    extractTask.addRetry(retryProps);
    writeGraphTask.addRetry(retryProps);
    semanticTask.addRetry(retryProps);

    // Records per-document status to Postgres after both branches join. The
    // Parallel output is [graphBranchResult, semanticBranchResult]; pass it
    // straight through as the payload.
    const writeStatusTask = new tasks.LambdaInvoke(this, "WriteStatus", {
      lambdaFunction: writeStatusFn,
      outputPath: "$.Payload",
    });
    writeStatusTask.addRetry(retryProps);

    // After Ingest, fan out into two independent branches that both consume the
    // ingested text/pointer: the graph path (Extract -> WriteGraph -> Neptune)
    // and the semantic path (Docling-with-images -> Embed v4 -> LanceDB). The
    // Parallel state's result is the [graph, semantic] array, which flows into
    // WriteStatus to record the per-document outcome.
    const fanOut = new sfn.Parallel(this, "GraphAndSemantic")
      .branch(extractTask.next(writeGraphTask))
      .branch(semanticTask);

    const itemChain = ingestTask.next(fanOut).next(writeStatusTask);

    const mapState = new sfn.DistributedMap(this, "Map Files", {
      maxConcurrency: 1,
      // A single unprocessable file (corrupt PDF, unsupported format, a document
      // that trips Bedrock) must not abort the whole run: absorb up to 10 failed
      // items and keep going. Failures stay visible — the item's error lands in
      // the Map result and the document row keeps its pre-run status, so a later
      // execution retries it. Beyond 10 the Map fails, on the assumption that
      // something systemic (permissions, Bedrock quota, Neptune down) is wrong
      // rather than the individual documents.
      toleratedFailureCount: 10,
      // Iterate the pending-file manifest BuildManifest wrote (a JSON array of
      // {bucket, key}), not the raw bucket listing — so already-indexed files
      // are skipped. Static key; a run overwrites it and startSync blocks
      // concurrent runs.
      itemReader: new sfn.S3JsonItemReader({
        bucket: semanticBucket,
        key: manifestKey,
      }),
      // Each manifest item is { bucket, key }; add run_at from WriteOntology.
      itemSelector: {
        bucket: sfn.JsonPath.stringAt("$$.Map.Item.Value.bucket"),
        key: sfn.JsonPath.stringAt("$$.Map.Item.Value.key"),
        run_at: sfn.JsonPath.stringAt("$.ontology.run_at"),
      },
      resultPath: "$.results",
    });
    mapState.itemProcessor(itemChain);

    const definition = writeOntologyTask.next(buildManifestTask).next(mapState);

    this.stateMachine = new sfn.StateMachine(this, "IngestionStateMachine", {
      stateMachineName: `${this.stackName}-Ingestion`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(3),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, "IngestionLogs", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    // The Distributed Map's ItemReader (S3JsonItemReader) reads the pending
    // manifest that BuildManifest wrote to the semantic bucket, so the state
    // machine role needs GetObject on it. Per-item object reads are done by the
    // stage Lambdas (their own roles), not the state machine.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${semanticBucket.bucketArn}/${manifestKey}`],
      }),
    );

    new cdk.CfnOutput(this, "StateMachineArn", {
      value: this.stateMachine.stateMachineArn,
      description: "Start an execution with {} to process the whole bucket",
    });
  }
}

/**
 * Grant a function permission to invoke Bedrock models. Bedrock may live in a
 * different region than the stack (e.g. us-east-1 for the inference profile),
 * and cross-region inference profiles fan out to sibling regions — so the grant
 * is region-agnostic on the model resources.
 */
function grantBedrock(fn: lambda.Function, _stackRegion: string, _bedrockRegion: string): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
      ],
    }),
  );
}
