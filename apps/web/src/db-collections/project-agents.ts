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
 * Row shape synced from the `project_agent` table via Electric. Mirrors the
 * columns exposed by the `/sync/projectAgents` proxy in
 * `apps/api/src/electric.ts`. `lastResult` is jsonb (an AgentResult) and
 * arrives already parsed.
 */
export const projectAgentRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  state: z.enum(['idle', 'working', 'blocked']),
  activeRunId: z.string().nullable(),
  lastResult: z.unknown().nullable(),
  stateUpdatedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})

export type ProjectAgentRow = z.infer<typeof projectAgentRowSchema>

/** The `lastResult` jsonb payload (AgentResult from the orchestration layer). */
export interface AgentLastResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  summary: string
}

export function parseLastResult(value: unknown): AgentLastResult | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.status !== 'string' || typeof record.summary !== 'string') {
    return null
  }
  return record as unknown as AgentLastResult
}

// Collections are cached per project so remounting a project page reuses the
// live shape subscription instead of re-syncing from scratch.
const cache = new Map<
  string,
  ReturnType<typeof buildProjectAgentsCollection>
>()

function buildProjectAgentsCollection(projectId: string) {
  const restart = createStreamRestarter(`projectAgents-${projectId}`)
  const collection = createCollection(
    electricCollectionOptions({
      id: `projectAgents-${projectId}`,
      schema: projectAgentRowSchema,
      getKey: (row) => row.id,
      shapeOptions: {
        url: shapeUrl(`projectAgents?projectId=${encodeURIComponent(projectId)}`),
        fetchClient: syncFetch,
        parser: syncParser,
        onError: (error) => {
          // 401/403 won't recover by retrying the same request (signed out /
          // project deleted), so stop the stream.
          const status = errorStatus(error)
          if (status === 401 || status === 403) {
            return
          }
          // A 404 mid-stream means the saved handle/offset went stale (e.g.
          // the tab slept for hours) — replaying the same request can never
          // recover, so restart the collection from scratch instead.
          if (status === 404) {
            console.warn('projectAgents stream went stale; restarting', error)
            restart(collection)
            return
          }
          // Other errors (network/5xx) retry the same request with backoff.
          console.error('projectAgents sync error', error)
          return {}
        },
      },
    }),
  )
  return collection
}

/** Live, project-scoped collection of `project_agent` roster rows. */
export function projectAgentsCollection(projectId: string) {
  let collection = cache.get(projectId)
  if (!collection) {
    collection = buildProjectAgentsCollection(projectId)
    cache.set(projectId, collection)
  }
  return collection
}
