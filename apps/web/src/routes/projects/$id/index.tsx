import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppShell } from '#/components/app-shell'
import { ProjectDetail } from '#/components/projects/project-detail'
import { dbProjectToUi } from '#/components/projects/db-adapter'
import { client } from '#/orpc/client'

export const Route = createFileRoute('/projects/$id/')({
  loader: async ({ params }) => {
    try {
      const project = await client.projects.get({ id: params.id })
      return { project: dbProjectToUi(project) }
    } catch {
      throw notFound()
    }
  },
  component: ProjectDetailPage,
})

function ProjectDetailPage() {
  const { project } = Route.useLoaderData()

  return (
    <AppShell showMetrics={false}>
      <ProjectDetail key={project.id} project={project} />
    </AppShell>
  )
}
