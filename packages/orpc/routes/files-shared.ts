import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ORPCError } from '@orpc/server'
import * as z from 'zod'

/**
 * Shared S3 file-browser primitives used by both the project-scoped file
 * routes (`projects/{projectId}/` prefix) and the bucket-root artifact
 * routes. Every operation takes a `basePrefix` ('' for the bucket root, or
 * a trailing-slash prefix) and a user-supplied relative path. File bytes
 * never travel through the RPC layer — uploads and downloads use
 * short-lived presigned URLs so the browser talks to S3 directly.
 */

export const PRESIGN_EXPIRY_SECONDS = 15 * 60
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024 // S3 single-PUT limit

export const pathSchema = z.string().max(1024)

export const uploadFilesSchema = z
  .array(
    z.object({
      name: z
        .string()
        .min(1)
        .max(255)
        .refine((n) => !n.includes('/'), {
          message: 'File name must not contain slashes',
        }),
      contentType: z.string().max(255).optional(),
      size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
    }),
  )
  .min(1)
  .max(50)

let s3Client: S3Client | null = null
export function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      customUserAgent: process.env.USER_AGENT_STRING,
    })
  }
  return s3Client
}

export function getBucket(): string {
  const bucket = process.env.FILES_BUCKET
  if (!bucket) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'FILES_BUCKET is not configured',
    })
  }
  return bucket
}

/**
 * Run an S3 operation, logging the underlying SDK error (name, message,
 * HTTP status) before surfacing a readable ORPCError to the client.
 */
export async function withS3<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ORPCError) throw error
    const err = error as Error & {
      name?: string
      $metadata?: { httpStatusCode?: number }
    }
    console.error(
      `[files] S3 ${operation} failed:`,
      err.name ?? 'Error',
      '-',
      err.message,
      err.$metadata?.httpStatusCode
        ? `(http ${err.$metadata.httpStatusCode})`
        : '',
    )
    console.error(error)
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `S3 ${operation} failed: ${err.name ?? 'Error'} - ${err.message}`,
    })
  }
}

/**
 * Normalize a user-supplied path into a safe, relative segment list.
 * Rejects traversal so keys can never escape the base prefix.
 */
export function normalizeRelativePath(path: string): string {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid path' })
    }
  }
  return segments.join('/')
}

/**
 * Prefix for a directory listing: ends with `/` unless it is the bucket
 * root ('' base prefix with an empty path).
 */
export function dirPrefix(basePrefix: string, path: string): string {
  const rel = normalizeRelativePath(path)
  return rel ? `${basePrefix}${rel}/` : basePrefix
}

/** Key for a single object (file). */
export function fileKey(basePrefix: string, path: string): string {
  const rel = normalizeRelativePath(path)
  if (!rel) {
    throw new ORPCError('BAD_REQUEST', { message: 'Invalid path' })
  }
  return `${basePrefix}${rel}`
}

export interface FileEntry {
  name: string
  isDir: boolean
  size: number
  modTime: string
}

/**
 * List files and folders at a path under the base prefix. Folders come
 * from common prefixes; zero-byte folder markers are hidden.
 */
export async function listDir(
  basePrefix: string,
  path: string,
): Promise<{ files: FileEntry[] }> {
  const prefix = dirPrefix(basePrefix, path)
  const bucket = getBucket()
  const s3 = getS3()

  const dirs: { name: string }[] = []
  const files: { name: string; size: number; modTime: string }[] = []

  await withS3('list', async () => {
    let continuationToken: string | undefined
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      )
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '')
        if (name) dirs.push({ name })
      }
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue
        const name = obj.Key.slice(prefix.length)
        // Skip the folder marker for the current directory itself.
        if (!name) continue
        files.push({
          name,
          size: obj.Size ?? 0,
          modTime:
            obj.LastModified?.toISOString() ?? new Date(0).toISOString(),
        })
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined
    } while (continuationToken)
  })

  return {
    files: [
      ...dirs.map((d) => ({
        name: d.name,
        isDir: true,
        size: 0,
        modTime: '',
      })),
      ...files.map((f) => ({
        name: f.name,
        isDir: false,
        size: f.size,
        modTime: f.modTime,
      })),
    ],
  }
}

/** Create a folder by writing a zero-byte object with a trailing-slash key. */
export async function createFolderAt(
  basePrefix: string,
  path: string,
): Promise<void> {
  const key = `${fileKey(basePrefix, path)}/`
  await withS3('create-folder', () =>
    getS3().send(
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: key,
        Body: '',
      }),
    ),
  )
}

/**
 * Delete a file, or recursively delete a folder (every object under its
 * prefix).
 */
export async function deleteAt(
  basePrefix: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  const bucket = getBucket()
  const s3 = getS3()

  if (!isDir) {
    await withS3('delete', () =>
      s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: fileKey(basePrefix, path),
        }),
      ),
    )
    return
  }

  const prefix = dirPrefix(basePrefix, path)
  await withS3('delete', async () => {
    let continuationToken: string | undefined
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )
      const keys = (res.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        )
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined
    } while (continuationToken)
  })
}

/** Presigned PUT URLs for uploading files directly from the browser to S3. */
export async function presignUploads(
  basePrefix: string,
  path: string,
  files: { name: string; contentType?: string; size: number }[],
): Promise<{ uploads: { name: string; url: string }[] }> {
  const prefix = dirPrefix(basePrefix, path)
  const bucket = getBucket()
  const s3 = getS3()

  const uploads = await withS3('presign-upload', () =>
    Promise.all(
      files.map(async (file) => {
        const key = `${prefix}${normalizeRelativePath(file.name)}`
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: file.contentType || 'application/octet-stream',
          }),
          { expiresIn: PRESIGN_EXPIRY_SECONDS },
        )
        return { name: file.name, url }
      }),
    ),
  )

  return { uploads }
}

/**
 * Presigned GET URL for reading or downloading a file. Set `download` for
 * a content-disposition attachment.
 */
export async function presignDownloadAt(
  basePrefix: string,
  path: string,
  download: boolean,
): Promise<{ url: string; fileName: string }> {
  const key = fileKey(basePrefix, path)
  const fileName = key.split('/').pop() ?? 'file'
  const url = await withS3('presign-download', () =>
    getSignedUrl(
      getS3(),
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: key,
        ...(download
          ? {
              ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.\- ]/g, '_')}"`,
            }
          : {}),
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    ),
  )

  return { url, fileName }
}
