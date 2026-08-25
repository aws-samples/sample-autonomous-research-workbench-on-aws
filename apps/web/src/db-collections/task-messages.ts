import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import { createCollection } from '@tanstack/react-db'
import { z } from 'zod'

import {
  createStreamRestarter,
  errorStatus,
  shapeUrl,
  syncFetch,
  syncParser,
} from './sync'

/**
 * Row shape synced from the `task_message` table via Electric. Mirrors the
 * columns exposed by the `/sync/taskMessages` proxy in
 * `apps/api/src/electric.ts`. `content`/`metadata` are jsonb, so they arrive
 * as already-parsed objects.
 */
export const taskMessageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.unknown(),
  metadata: z.unknown().nullable(),
  taskId: z.string(),
  createdAt: z.coerce.date(),
})

export type TaskMessageRow = z.infer<typeof taskMessageRowSchema>

const cache = new Map<string, ReturnType<typeof buildTaskMessagesCollection>>()

function buildTaskMessagesCollection(taskId: string) {
  const restart = createStreamRestarter(`taskMessages-${taskId}`)
  const collection = createCollection(
    electricCollectionOptions({
      id: `taskMessages-${taskId}`,
      schema: taskMessageRowSchema,
      getKey: (message) => message.id,
      shapeOptions: {
        url: shapeUrl(`taskMessages?taskId=${encodeURIComponent(taskId)}`),
        fetchClient: syncFetch,
        parser: syncParser,
        onError: (error) => {
          // A 403 means the proxy could no longer verify ownership — almost
          // always because the thread was deleted while this live stream was
          // still mounted. Retrying would loop on a forbidden request, so
          // stop the stream permanently.
          const status = errorStatus(error)
          if (status === 401 || status === 403) {
            return
          }
          // Stale handle/offset after long idle — restart from scratch (see
          // createStreamRestarter); retrying the same request can't recover.
          if (status === 404) {
            console.warn('taskMessages stream went stale; restarting', error)
            restart(collection)
            return
          }
          // Other errors retry the same request with backoff.
          console.error('taskMessages sync error', error)
          return {}
        },
      },
    }),
  )
  return collection
}

/**
 * Live collection of persisted messages for a single task thread (used for
 * the Team Lead chat). The proxy verifies ownership of `taskId` server-side.
 */
export function taskMessagesCollection(taskId: string) {
  let collection = cache.get(taskId)
  if (!collection) {
    collection = buildTaskMessagesCollection(taskId)
    cache.set(taskId, collection)
  }
  return collection
}
