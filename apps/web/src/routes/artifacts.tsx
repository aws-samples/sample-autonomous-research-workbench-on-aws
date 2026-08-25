import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { ArtifactFiles } from '@/components/artifacts/artifact-files'

export const Route = createFileRoute('/artifacts')({ component: ArtifactsPage })

function ArtifactsPage() {
  return (
    <AppShell showMetrics={false}>
      <ArtifactFiles />
    </AppShell>
  )
}
