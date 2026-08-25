import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '#/components/app-shell'
import { GraphView } from '#/components/graph/graph-view'

export const Route = createFileRoute('/graph')({ component: GraphPage })

function GraphPage() {
  return (
    <AppShell showMetrics={false}>
      <GraphView />
    </AppShell>
  )
}
