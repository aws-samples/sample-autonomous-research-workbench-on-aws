import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '#/components/app-shell'
import { ScratchpadLanding } from '#/components/scratchpad-landing'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <AppShell>
      <ScratchpadLanding />
    </AppShell>
  )
}
