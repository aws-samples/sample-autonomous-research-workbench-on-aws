import * as z from 'zod'

import { authorized } from '../context'
import {
  createFolderAt,
  deleteAt,
  listDir,
  pathSchema,
  presignDownloadAt,
  presignUploads,
  uploadFilesSchema,
} from './files-shared'

/**
 * Artifact file routes: an S3-backed file browser over the entire
 * FILES_BUCKET from its root (no per-project prefix). See
 * `files-shared.ts` for the underlying S3 operations.
 */

const ROOT_PREFIX = ''

export const listFiles = authorized
  .route({
    method: 'GET',
    path: '/artifacts/files',
    tags: ['Artifacts'],
    description:
      'List files and folders at a path from the root of the artifacts bucket. Folders come from common prefixes; zero-byte folder markers are hidden.',
  })
  .input(
    z.object({
      path: pathSchema.optional().default(''),
    }),
  )
  .handler(async ({ input }) => listDir(ROOT_PREFIX, input.path))

export const createFolder = authorized
  .route({
    method: 'POST',
    path: '/artifacts/files/folder',
    tags: ['Artifacts'],
    description:
      'Create a folder by writing a zero-byte S3 object with a trailing-slash key.',
  })
  .input(
    z.object({
      path: pathSchema.min(1),
    }),
  )
  .handler(async ({ input }) => {
    await createFolderAt(ROOT_PREFIX, input.path)
    return { success: true }
  })

export const deleteFile = authorized
  .route({
    method: 'POST',
    path: '/artifacts/files/delete',
    tags: ['Artifacts'],
    description:
      'Delete a file, or recursively delete a folder (every object under its prefix).',
  })
  .input(
    z.object({
      path: pathSchema.min(1),
      isDir: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ input }) => {
    await deleteAt(ROOT_PREFIX, input.path, input.isDir)
    return { success: true }
  })

export const presignUpload = authorized
  .route({
    method: 'POST',
    path: '/artifacts/files/presign-upload',
    tags: ['Artifacts'],
    description:
      'Presigned PUT URLs for uploading files directly from the browser to the artifacts bucket.',
  })
  .input(
    z.object({
      path: pathSchema.optional().default(''),
      files: uploadFilesSchema,
    }),
  )
  .handler(async ({ input }) =>
    presignUploads(ROOT_PREFIX, input.path, input.files),
  )

export const presignDownload = authorized
  .route({
    method: 'GET',
    path: '/artifacts/files/presign-download',
    tags: ['Artifacts'],
    description:
      'Presigned GET URL for reading or downloading a file. Set `download` for a content-disposition attachment.',
  })
  .input(
    z.object({
      path: pathSchema.min(1),
      download: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ input }) =>
    presignDownloadAt(ROOT_PREFIX, input.path, input.download),
  )
