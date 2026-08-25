import { Shape, ShapeStream } from "@electric-sql/client"
import { useEffect, useState } from "react"

import { errorStatus } from "@/db-collections/sync"
import { SERVICE_URL } from "@/lib/config"

/**
 * Live-syncing view of a single `project` row via Electric SQL.
 *
 * Subscribes to the API's authenticated shape proxy (`/sync/project/:id`),
 * which pins the shape to this project's row server-side. Returns the latest
 * row so the UI reflects fields as the prospect agent persists them, without
 * polling or refetching.
 */
export type ProjectRow = {
  id: string
  name: string
  status: string
  seedHypothesis: string
  objective: string | null
  maxBudgetUsd: number
  checkInCadence: string | null
  flags: string | null
  contextNotes: string | null
}

export function useProjectRow(projectId: string | null): ProjectRow | null {
  const [row, setRow] = useState<ProjectRow | null>(null)

  useEffect(() => {
    if (!projectId) return
    setRow(null)

    const stream = new ShapeStream({
      url: `${SERVICE_URL}/sync/project/${projectId}`,
      // The proxy pins table + where server-side; `table` here is only for the
      // client's own bookkeeping and is ignored upstream.
      params: { table: "project" },
      // Cross-origin in dev (web :3000 → api :4000); send the auth cookie so
      // the proxy's session/ownership check passes.
      fetchClient: ((input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, credentials: "include" })) as typeof fetch,
      // Without an onError the stream dies permanently on the first error,
      // freezing the "live" row for the rest of the mount. 401/403/404 won't
      // recover by retrying the same request, so stop; transient errors
      // (network blips after sleep/wake, 5xx) retry with backoff.
      onError: (error) => {
        const status = errorStatus(error)
        if (status === 401 || status === 403 || status === 404) {
          console.warn(`project row sync stopped (HTTP ${status})`, error)
          return
        }
        console.error("project row sync error", error)
        return {}
      },
    })

    const shape = new Shape(stream)
    const unsubscribe = shape.subscribe(({ rows }) => {
      // Shape scoped to a single row: take the first (or null if not yet synced
      // / deleted).
      setRow((rows[0] as ProjectRow | undefined) ?? null)
    })

    return () => {
      unsubscribe()
      stream.unsubscribeAll()
    }
  }, [projectId])

  return row
}
