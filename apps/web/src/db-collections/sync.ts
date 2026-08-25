import { SERVICE_URL } from '#/lib/config'

/**
 * Shared plumbing for Electric-synced TanStack DB collections.
 *
 * Postgres serializes timestamps without a timezone (e.g. `2026-06-08 09:01:02`).
 * Electric streams these as strings; coerce them into JS `Date`s, treating
 * naive timestamps as UTC.
 */
const parseTimestamp = (value: string) => {
  const hasTimezone = /Z$|[+-]\d{2}(:\d{2})?$/.test(value)
  const isoString = value.replace(' ', 'T')
  return new Date(hasTimezone ? isoString : `${isoString}Z`)
}

export const syncParser = {
  timestamp: parseTimestamp,
  timestamptz: parseTimestamp,
  date: parseTimestamp,
}

/**
 * Electric collections fetch through our authenticated proxy, so requests must
 * include the Better Auth session cookie. On the server (SSR) there is no
 * session to sync, so we return a promise that never resolves.
 */
export const syncFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof window === 'undefined') {
      return new Promise<Response>(() => {})
    }
    return fetch(input, { ...init, credentials: 'include' })
  },
  { preconnect: globalThis.fetch?.preconnect ?? (() => {}) },
)

export function shapeUrl(path: string) {
  return `${SERVICE_URL}/sync/${path}`
}

/** Electric surfaces HTTP failures as errors carrying a numeric `status`. */
export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/** The subset of a TanStack DB collection a sync restart needs. */
interface RestartableCollection {
  cleanup: () => Promise<void>
  preload: () => Promise<void>
}

const MAX_STREAM_RESTARTS = 3

/**
 * Bounded restart of a collection's Electric sync from scratch.
 *
 * A live shape stream resumes with the `handle`/`offset` it last saw. If that
 * saved position goes stale while a tab sits idle (sleep/wake, server-side
 * state loss), retrying the identical request can never succeed — e.g. a 404
 * replays forever until the stream is torn down dead, and because collections
 * are module-cached the app then shows stale/empty data until a full reload.
 *
 * Instead, restart the whole collection: `cleanup()` drops the sync session
 * and data, `preload()` starts a fresh ShapeStream from offset -1. Attempts
 * are capped so a genuinely-gone resource (deleted project/thread) doesn't
 * hammer the proxy in a loop.
 */
export function createStreamRestarter(label: string) {
  let restarts = 0
  return (collection: RestartableCollection): void => {
    if (restarts >= MAX_STREAM_RESTARTS) {
      console.error(
        `${label} sync gave up after ${MAX_STREAM_RESTARTS} restarts`,
      )
      return
    }
    restarts += 1
    const delayMs = 1000 * 2 ** (restarts - 1)
    setTimeout(() => {
      collection
        .cleanup()
        .then(() => collection.preload())
        .catch((error) => {
          console.error(`${label} sync restart failed`, error)
        })
    }, delayMs)
  }
}
