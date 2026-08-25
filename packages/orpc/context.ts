import { ORPCError, os } from '@orpc/server'
import { auth } from '@repo/auth'

/**
 * Initial context provided by the server handler (TanStack Start route,
 * isomorphic router client, etc.)
 */
export interface ContextLogger {
  error(bindings: Record<string, unknown>, message: string): void
}

export interface InitialContext {
  headers: Headers
  logger?: ContextLogger
}

const base = os.$context<InitialContext>()

/**
 * Base route with context (session may be null). Errors are logged here,
 * before oRPC converts them into generic HTTP 500 responses. Do not include
 * headers or procedure inputs because they can contain credentials or
 * scientific data.
 */
export const route = base.use(async ({ context, next }) => {
  let phase = 'auth.getSession'

  try {
    const session = await auth.api.getSession({ headers: context.headers })
    phase = 'procedure'

    return await next({
      context: {
        session,
        userId: session?.user?.id,
      },
    })
  } catch (error) {
    context.logger?.error(
      { err: error, operation: 'orpc.request', phase },
      'oRPC procedure failed',
    )
    throw error
  }
})

/**
 * Authorized route - requires authentication.
 * Use this for protected endpoints where a valid session is required.
 *
 * context.user is guaranteed to be defined.
 */
export const authorized = route.use(async ({ context, next }) => {
  if (!context.session?.session || !context.session?.user) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Sign in required' })
  }

  return next({
    context: {
      user: context.session.user,
    },
  })
})

function isAdmin(role: string | null | undefined): boolean {
  return (role ?? '')
    .split(',')
    .map((r) => r.trim())
    .includes('admin')
}

/**
 * Admin route - requires an authenticated user with the better-auth admin
 * plugin's "admin" role. Use `.use(admin)`-style composition instead of
 * calling a guard inside the handler.
 */
export const admin = authorized.use(async ({ context, next }) => {
  if (!isAdmin(context.user.role)) {
    throw new ORPCError('FORBIDDEN', { message: 'Admin access required' })
  }

  return next({ context })
})
