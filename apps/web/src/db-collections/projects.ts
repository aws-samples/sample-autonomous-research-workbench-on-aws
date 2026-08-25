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
 * Row shape synced from the `project` table via Electric. Mirrors the columns
 * exposed by the `/sync/projects` proxy in `apps/api/src/electric.ts` — all
 * projects on the platform (projects are visible to every signed-in user).
 */
export const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  ownerId: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type ProjectRow = z.infer<typeof projectRowSchema>

/**
 * Live collection of all projects. Any authenticated user can view any
 * project, so the proxy only requires a session; no client params are needed.
 */
const restart = createStreamRestarter('projects')

export const projectsCollection = createCollection(
  electricCollectionOptions({
    id: 'projects',
    schema: projectRowSchema,
    getKey: (row) => row.id,
    shapeOptions: {
      url: shapeUrl('projects'),
      fetchClient: syncFetch,
      parser: syncParser,
      onError: (error) => {
        // 401 (signed out) won't recover by retrying the same request, so stop
        // the stream permanently.
        const status = errorStatus(error)
        if (status === 401) {
          return
        }
        // Stale handle/offset after long idle — restart from scratch (see
        // createStreamRestarter); retrying the same request can't recover.
        if (status === 404) {
          console.warn('projects stream went stale; restarting', error)
          restart(projectsCollection)
          return
        }
        // Other errors (network/5xx) retry the same request with backoff.
        console.error('projects sync error', error)
        return {}
      },
    },
  }),
)
