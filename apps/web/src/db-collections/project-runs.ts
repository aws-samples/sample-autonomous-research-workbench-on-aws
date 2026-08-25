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
 * Row shape synced from the `run` table via Electric (project-scoped).
 * Mirrors the columns exposed by the `/sync/projectRuns` proxy in
 * `apps/api/src/electric.ts` — status/agentType only, no payloads.
 */
export const projectRunRowSchema = z.object({
  id: z.string(),
  parentRunId: z.string().nullable(),
  rootRunId: z.string(),
  agentType: z.string(),
  status: z.enum([
    'pending',
    'planning',
    'running',
    'waiting_on_children',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  // The TaskSpec brief handed to the run (jsonb). Sub-agent runs carry their
  // plan-task title here (input.title).
  input: z.unknown().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
})

export type ProjectRunRow = z.infer<typeof projectRunRowSchema>

/** Display title for a run: its TaskSpec title when present. */
export function runTitle(row: ProjectRunRow): string | null {
  const input = row.input
  if (input && typeof input === 'object' && 'title' in input) {
    const title = (input as { title?: unknown }).title
    if (typeof title === 'string' && title.trim()) return title
  }
  return null
}

const cache = new Map<string, ReturnType<typeof buildProjectRunsCollection>>()

function buildProjectRunsCollection(projectId: string) {
  const restart = createStreamRestarter(`projectRuns-${projectId}`)
  const collection = createCollection(
    electricCollectionOptions({
      id: `projectRuns-${projectId}`,
      schema: projectRunRowSchema,
      getKey: (row) => row.id,
      shapeOptions: {
        url: shapeUrl(`projectRuns?projectId=${encodeURIComponent(projectId)}`),
        fetchClient: syncFetch,
        parser: syncParser,
        onError: (error) => {
          const status = errorStatus(error)
          if (status === 401 || status === 403) {
            return
          }
          // Stale handle/offset after long idle — restart from scratch (see
          // createStreamRestarter); retrying the same request can't recover.
          if (status === 404) {
            console.warn('projectRuns stream went stale; restarting', error)
            restart(collection)
            return
          }
          console.error('projectRuns sync error', error)
          return {}
        },
      },
    }),
  )
  return collection
}

/** Live collection of a project's run tree activity (roots + children). */
export function projectRunsCollection(projectId: string) {
  let collection = cache.get(projectId)
  if (!collection) {
    collection = buildProjectRunsCollection(projectId)
    cache.set(projectId, collection)
  }
  return collection
}
