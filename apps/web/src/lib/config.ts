/**
 * Resolve the base URL for reaching the API (auth, rpc, sync, streams, docs).
 *
 * In production the browser calls the API *same-origin*: the ALB routes
 * `/api/*`, `/rpc/*`, `/sync/*` and `/v1/stream/*` to the API service and
 * everything else to this web app, so whatever host loaded the page also
 * serves the API. The SSR pass instead goes directly over the VPC via
 * SERVICE_URL (Cloud Map DNS, set on the ECS task).
 *
 * Resolution order:
 *   1. An explicit VITE_SERVICE_URL always wins (escape hatch / point a local
 *      web app at a remote API).
 *   2. Production browser → same origin as the current page.
 *   3. Production SSR → SERVICE_URL from the task environment.
 *   4. Dev (web :3000 → api :4000) → local API.
 */
export function getServiceUrl(): string {
  if (import.meta.env.VITE_SERVICE_URL) {
    return import.meta.env.VITE_SERVICE_URL
  }

  if (import.meta.env.PROD) {
    if (typeof window !== 'undefined') {
      return window.location.origin
    }
    if (typeof process !== 'undefined' && process.env.SERVICE_URL) {
      return process.env.SERVICE_URL
    }
  }

  return 'http://localhost:4000'
}

export const SERVICE_URL = getServiceUrl()
