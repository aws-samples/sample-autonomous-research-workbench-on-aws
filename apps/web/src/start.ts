import { createStart, createMiddleware } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { authClient } from '@repo/auth/client'

const PUBLIC_PATHS = ['/login', '/api/auth']

const isPublicPath = (pathname: string) => {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
}

const authMiddleware = createMiddleware().server(
  async ({ request, pathname, next }) => {
    // The API owns the session; validate it by forwarding the cookie. An
    // unreachable API must not take down SSR — treat it as "no session" so
    // public pages still render and everything else bounces to /login.
    let session = null
    try {
      const { data } = await authClient.getSession({
        fetchOptions: {
          headers: {
            cookie: request.headers.get('cookie') ?? '',
          },
        },
      })
      session = data
    } catch (error) {
      console.error('auth: getSession failed during SSR', error)
    }

    if (!session && !isPublicPath(pathname)) {
      throw redirect({ to: '/login' })
    }

    return next({ context: { session } })
  },
)

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [authMiddleware],
  }
})
