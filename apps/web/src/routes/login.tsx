import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { SignInView } from '#/components/sign-in-view'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional(),
  }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()
  return <SignInView redirect={redirect} />
}
