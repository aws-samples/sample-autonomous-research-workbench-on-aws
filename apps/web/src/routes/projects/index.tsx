import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '#/components/app-shell'
import { ProjectsList } from '#/components/projects/projects-list'

export const Route = createFileRoute('/projects/')({ component: ProjectsPage })

function ProjectsPage() {
  return (
    <AppShell showMetrics={false}>
      <ProjectsList />
    </AppShell>
  )
}
