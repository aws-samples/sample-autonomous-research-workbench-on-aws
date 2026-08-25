import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  S3FilesClient,
} from '@aws-sdk/client-s3files'

/**
 * Per-project S3 Files access points.
 *
 * The infra stack creates one S3 Files file system over the artifacts
 * bucket, scoped to the `projects/` prefix. Each project gets an access
 * point rooted at `/{projectId}` inside that file system (i.e.
 * `projects/{projectId}/` in the bucket), so compute mounting through the
 * access point sees only its own project's files.
 *
 * Provisioning is keyed off S3_FILES_FILE_SYSTEM_ID: when unset (local
 * dev, envs without the S3Files stack) these helpers are no-ops and the
 * project row simply keeps a null ARN.
 */

// Matches the POSIX identity used by the other mounted services in this
// stack (Electric / DurableStreams EFS access points).
const POSIX_UID = 1000
const POSIX_GID = 1000

let client: S3FilesClient | null = null
function getS3Files(): S3FilesClient {
  if (!client) {
    client = new S3FilesClient({
      customUserAgent: process.env.USER_AGENT_STRING,
    })
  }
  return client
}

function getFileSystemId(): string | null {
  return process.env.S3_FILES_FILE_SYSTEM_ID || null
}

/**
 * Create the project's access point and return its ARN, or null when
 * S3 Files provisioning is not configured in this environment. Idempotent
 * per project: the project id doubles as the client token, so a retried
 * activation does not create a duplicate.
 */
export async function createProjectAccessPoint(
  projectId: string,
): Promise<string | null> {
  const fileSystemId = getFileSystemId()
  if (!fileSystemId) {
    console.warn(
      '[s3files] S3_FILES_FILE_SYSTEM_ID not set — skipping access point creation',
    )
    return null
  }

  const res = await getS3Files().send(
    new CreateAccessPointCommand({
      fileSystemId,
      clientToken: projectId,
      // Path is relative to the file system root; the file system is
      // already scoped to `projects/` in the bucket.
      rootDirectory: {
        path: `/${projectId}`,
        creationPermissions: {
          ownerUid: POSIX_UID,
          ownerGid: POSIX_GID,
          permissions: '0755',
        },
      },
      posixUser: { uid: POSIX_UID, gid: POSIX_GID },
      tags: [{ key: 'research-workbench-project-id', value: projectId }],
    }),
  )

  if (!res.accessPointArn) {
    throw new Error('CreateAccessPoint returned no accessPointArn')
  }
  return res.accessPointArn
}

/**
 * Best-effort deletion of a project's access point. Already-deleted
 * access points are treated as success; other failures are logged and
 * swallowed (the caller has already removed the project row).
 */
export async function deleteProjectAccessPoint(
  accessPointArn: string,
): Promise<void> {
  try {
    await getS3Files().send(
      new DeleteAccessPointCommand({ accessPointId: accessPointArn }),
    )
  } catch (error) {
    const name = (error as Error).name
    if (name === 'ResourceNotFoundException') return
    console.error(
      `[s3files] failed to delete access point ${accessPointArn}:`,
      error,
    )
  }
}
