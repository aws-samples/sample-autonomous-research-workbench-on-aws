import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod'

import { AppShell } from '@/components/app-shell'
import { SettingsView } from '@/components/settings/settings-view'

const settingsSearchSchema = z.object({
  /** Deep-linkable settings tab, e.g. /settings?tab=knowledge */
  tab: z.enum(['users', 'schema', 'knowledge', 'email']).optional(),
})

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  validateSearch: settingsSearchSchema,
})

function SettingsPage() {
  const { tab } = Route.useSearch()
  return (
    <AppShell showMetrics={false}>
      <SettingsView initialTab={tab} />
    </AppShell>
  )
}
