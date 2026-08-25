import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { AgentDetail } from '@/components/projects/agent-detail'
import { dbProjectToUi } from '@/components/projects/db-adapter'
import type { Project } from '@/components/projects/types'
import { client } from '@/orpc/client'

export const Route = createFileRoute('/projects/$id/agents/$agentId')({
  loader: async ({ params }) => {
    let project: Project
    try {
      project = dbProjectToUi(await client.projects.get({ id: params.id }))
    } catch {
      throw notFound()
    }
    const agent = project.agents.find((a) => a.id === params.agentId)
    if (!agent) throw notFound()
    return { project, agent }
  },
  component: AgentDetailPage,
})

function AgentDetailPage() {
  const { project, agent } = Route.useLoaderData()

  return (
    <AppShell showMetrics={false}>
      <AgentDetail project={project} agent={agent} />
    </AppShell>
  )
}
