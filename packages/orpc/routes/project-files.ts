import { ORPCError } from '@orpc/server'
import { and, db, eq, project } from '@repo/database'
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
 * Project file routes: an S3-backed file browser scoped to a per-project
 * key prefix (`projects/{projectId}/`). See `files-shared.ts` for the
 * underlying S3 operations.
 */

function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`
}

/**
 * Read access: projects are platform-visible, so any authenticated user may
 * browse and download a project's files. Only existence is checked.
 */
async function getVisibleProject(projectId: string) {
  const row = await db.query.project.findFirst({
    where: eq(project.id, projectId),
  })
  if (!row) {
    throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
  }
  return row
}

/** Write access (upload/delete/create-folder) stays restricted to the owner. */
async function getOwnedProject(projectId: string, userId: string) {
  const row = await db.query.project.findFirst({
    where: and(eq(project.id, projectId), eq(project.ownerId, userId)),
  })
  if (!row) {
    // Same response whether the project is missing or someone else's.
    throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
  }
  return row
}

export const listFiles = authorized
  .route({
    method: 'GET',
    path: '/projects/{projectId}/files',
    tags: ['Projects'],
    description:
      "List files and folders at a path within the project's S3 prefix. Folders come from common prefixes; zero-byte folder markers are hidden.",
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      path: pathSchema.optional().default(''),
    }),
  )
  .handler(async ({ input }) => {
    await getVisibleProject(input.projectId)
    return listDir(projectPrefix(input.projectId), input.path)
  })

export const createFolder = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/files/folder',
    tags: ['Projects'],
    description:
      'Create a folder by writing a zero-byte S3 object with a trailing-slash key.',
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      path: pathSchema.min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    await getOwnedProject(input.projectId, context.user.id)
    await createFolderAt(projectPrefix(input.projectId), input.path)
    return { success: true }
  })

export const deleteFile = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/files/delete',
    tags: ['Projects'],
    description:
      'Delete a file, or recursively delete a folder (every object under its prefix).',
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      path: pathSchema.min(1),
      isDir: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ input, context }) => {
    await getOwnedProject(input.projectId, context.user.id)
    await deleteAt(projectPrefix(input.projectId), input.path, input.isDir)
    return { success: true }
  })

export const presignUpload = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/files/presign-upload',
    tags: ['Projects'],
    description:
      'Presigned PUT URLs for uploading files directly from the browser to S3, scoped to the project prefix.',
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      path: pathSchema.optional().default(''),
      files: uploadFilesSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    await getOwnedProject(input.projectId, context.user.id)
    return presignUploads(
      projectPrefix(input.projectId),
      input.path,
      input.files,
    )
  })

export const presignDownload = authorized
  .route({
    method: 'GET',
    path: '/projects/{projectId}/files/presign-download',
    tags: ['Projects'],
    description:
      'Presigned GET URL for reading or downloading a file. Set `download` for a content-disposition attachment.',
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      path: pathSchema.min(1),
      download: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ input }) => {
    await getVisibleProject(input.projectId)
    return presignDownloadAt(
      projectPrefix(input.projectId),
      input.path,
      input.download,
    )
  })
