import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { CreateProjectView } from '@/components/projects/create-project-view'

export const Route = createFileRoute('/projects/create')({
  validateSearch: (search: Record<string, unknown>): { projectId: string } => ({
    projectId: typeof search.projectId === 'string' ? search.projectId : '',
  }),
  component: CreateProjectPage,
})

function CreateProjectPage() {
  const { projectId } = Route.useSearch()

  return (
    <AppShell showMetrics={false}>
      {/* Key on projectId so switching between drafts remounts the view with
          fresh state instead of showing the previous draft's chat/history. */}
      <CreateProjectView key={projectId} projectId={projectId} />
    </AppShell>
  )
}
