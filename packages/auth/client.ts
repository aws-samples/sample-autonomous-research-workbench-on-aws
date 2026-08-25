import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// This package is compiled by the consuming app's bundler (Vite for the web
// app), which statically replaces literal `import.meta.env.*` expressions.
// The tsconfig here doesn't include vite/client types, so view it as a plain
// record instead of declaring a global (which would clash with Vite's types).
const viteEnv = (
  import.meta as unknown as {
    env?: { VITE_SERVICE_URL?: string; PROD?: boolean };
  }
).env;

/**
 * Base URL of the API that hosts better-auth. Mirrors the resolution in the
 * web app's lib/config.ts: explicit VITE_SERVICE_URL override, then
 * same-origin in a production browser (the ALB routes /api/* to the API),
 * then SERVICE_URL for the SSR pass, then the local dev API.
 */
function getServiceUrl(): string {
  if (viteEnv?.VITE_SERVICE_URL) {
    return viteEnv.VITE_SERVICE_URL;
  }

  if (viteEnv?.PROD) {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    if (typeof process !== "undefined" && process.env.SERVICE_URL) {
      return process.env.SERVICE_URL;
    }
  }

  return "http://localhost:4000";
}

export const authClient = createAuthClient({
  baseURL: getServiceUrl(),
  fetchOptions: {
    credentials: "include",
  },
  plugins: [adminClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
