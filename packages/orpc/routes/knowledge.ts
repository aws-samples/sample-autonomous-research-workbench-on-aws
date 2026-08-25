import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  DescribeExecutionCommand,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ORPCError } from '@orpc/server'
import * as z from 'zod'

import { admin } from '../context'

const UPLOAD_URL_TTL_SECONDS = 15 * 60
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60
const MAX_LISTED_OBJECTS = 5000

let cachedS3: S3Client | null = null
function s3(): S3Client {
  cachedS3 ??= new S3Client({
    // Without this, SDK >= 3.729 signs an (empty-body) CRC32 checksum into
    // presigned PUT URLs, so S3 rejects the browser's actual upload bytes.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    customUserAgent: process.env.USER_AGENT_STRING,
  })
  return cachedS3
}

let cachedSfn: SFNClient | null = null
function sfn(): SFNClient {
  cachedSfn ??= new SFNClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  })
  return cachedSfn
}

function knowledgeBucket(): string {
  const bucket = process.env.KNOWLEDGE_BUCKET
  if (!bucket) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'KNOWLEDGE_BUCKET is not configured',
    })
  }
  return bucket
}

function ingestionStateMachineArn(): string {
  const arn = process.env.INGESTION_STATE_MACHINE_ARN
  if (!arn) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'INGESTION_STATE_MACHINE_ARN is not configured',
    })
  }
  return arn
}

/** S3 object key: no leading slash, no empty or dot-only path segments. */
const KeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (key) =>
      !key.startsWith('/') &&
      !key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'),
    { message: 'Invalid object key' },
  )

export const listFiles = admin
  .route({
    method: 'GET',
    path: '/knowledge/files',
    tags: ['Knowledge'],
    description: 'List every document in the knowledge bucket.',
  })
  .output(
    z.object({
      bucket: z.string(),
      files: z.array(
        z.object({
          key: z.string(),
          size: z.number(),
          lastModified: z.string().nullable(),
        }),
      ),
      truncated: z.boolean(),
    }),
  )
  .handler(async () => {
    const bucket = knowledgeBucket()
    const files: { key: string; size: number; lastModified: string | null }[] =
      []

    let continuationToken: string | undefined
    let truncated = false
    do {
      const page = await s3().send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        }),
      )
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue
        files.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.toISOString() ?? null,
        })
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined
      if (files.length >= MAX_LISTED_OBJECTS && continuationToken) {
        truncated = true
        break
      }
    } while (continuationToken)

    files.sort((a, b) => a.key.localeCompare(b.key))
    return { bucket, files, truncated }
  })

export const getUploadUrl = admin
  .route({
    method: 'POST',
    path: '/knowledge/files/upload-url',
    tags: ['Knowledge'],
    description:
      'Mint a presigned PUT URL so the browser can upload a document directly to the knowledge bucket.',
  })
  .input(
    z.object({
      key: KeySchema,
      contentType: z.string().min(1).max(255).default('application/octet-stream'),
    }),
  )
  .output(z.object({ url: z.string(), key: z.string() }))
  .handler(async ({ input }) => {
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: knowledgeBucket(),
        Key: input.key,
        ContentType: input.contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    )
    return { url, key: input.key }
  })

export const getDownloadUrl = admin
  .route({
    method: 'POST',
    path: '/knowledge/files/download-url',
    tags: ['Knowledge'],
    description: 'Mint a presigned GET URL for a document in the knowledge bucket.',
  })
  .input(z.object({ key: KeySchema }))
  .output(z.object({ url: z.string() }))
  .handler(async ({ input }) => {
    const url = await getSignedUrl(
      s3(),
      new GetObjectCommand({ Bucket: knowledgeBucket(), Key: input.key }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    )
    return { url }
  })

export const deleteFile = admin
  .route({
    method: 'POST',
    path: '/knowledge/files/delete',
    tags: ['Knowledge'],
    description: 'Delete a document from the knowledge bucket.',
  })
  .input(z.object({ key: KeySchema }))
  .output(z.object({ success: z.boolean() }))
  .handler(async ({ input }) => {
    await s3().send(
      new DeleteObjectCommand({ Bucket: knowledgeBucket(), Key: input.key }),
    )
    return { success: true }
  })

const SyncStatusOutput = z.object({
  execution: z
    .object({
      executionArn: z.string(),
      status: z.string(),
      startDate: z.string().nullable(),
      stopDate: z.string().nullable(),
    })
    .nullable(),
})

async function latestExecution() {
  const { executions } = await sfn().send(
    new ListExecutionsCommand({
      stateMachineArn: ingestionStateMachineArn(),
      maxResults: 1,
    }),
  )
  const latest = executions?.[0]
  if (!latest?.executionArn) return null

  const detail = await sfn().send(
    new DescribeExecutionCommand({ executionArn: latest.executionArn }),
  )
  return {
    executionArn: latest.executionArn,
    status: detail.status ?? 'UNKNOWN',
    startDate: detail.startDate?.toISOString() ?? null,
    stopDate: detail.stopDate?.toISOString() ?? null,
  }
}

export const startSync = admin
  .route({
    method: 'POST',
    path: '/knowledge/sync',
    tags: ['Knowledge'],
    description:
      'Start the ingestion Step Function, which processes every document currently in the knowledge bucket.',
  })
  .output(z.object({ executionArn: z.string() }))
  .handler(async () => {
    const running = await latestExecution()
    if (running?.status === 'RUNNING') {
      throw new ORPCError('CONFLICT', {
        message: 'An ingestion run is already in progress',
      })
    }

    const { executionArn } = await sfn().send(
      new StartExecutionCommand({
        stateMachineArn: ingestionStateMachineArn(),
        input: '{}',
      }),
    )
    if (!executionArn) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Step Functions did not return an execution ARN',
      })
    }
    return { executionArn }
  })

export const syncStatus = admin
  .route({
    method: 'GET',
    path: '/knowledge/sync/status',
    tags: ['Knowledge'],
    description: 'Status of the most recent ingestion Step Function execution.',
  })
  .output(SyncStatusOutput)
  .handler(async () => {
    return { execution: await latestExecution() }
  })
