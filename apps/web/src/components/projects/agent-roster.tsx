"use client"

import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot, Loader2, Play, Square } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useSyncExternalStore } from "react"
import { toast } from "sonner"

import {
  parseLastResult,
  projectAgentsCollection,
  type ProjectAgentRow,
} from "@/db-collections/project-agents"
import { client } from "@/orpc/client"

import { cn } from "@/lib/utils"

import { agentStateClass } from "./personas"
import type { AgentState, ProjectAgent } from "./types"

/**
 * `useLiveQuery` reads from a client-only Electric collection (sync is a
 * no-op during SSR), so defer subscribing until after hydration to avoid
 * React's missing `getServerSnapshot` warning.
 */
function useIsHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

/** Map the DB roster state to the UI's display state. */
function toUiState(state: ProjectAgentRow["state"]): AgentState {
  return state === "working" ? "active" : state
}

export function AgentRoster({
  projectId,
  agents,
  live = false,
}: {
  projectId: string
  agents: ProjectAgent[]
  live?: boolean
}) {
  const hydrated = useIsHydrated()

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {live && hydrated ? (
        <LiveCards projectId={projectId} agents={agents} />
      ) : (
        agents.map((agent) => (
          <AgentCard
            key={agent.id}
            projectId={projectId}
            agent={agent}
            liveRow={null}
            actions={false}
          />
        ))
      )}
    </div>
  )
}

function LiveCards({
  projectId,
  agents,
}: {
  projectId: string
  agents: ProjectAgent[]
}) {
  const collection = useMemo(
    () => projectAgentsCollection(projectId),
    [projectId]
  )

  const { data: rows } = useLiveQuery(
    (q) => q.from({ pa: collection }),
    [collection]
  )

  const byAgentId = useMemo(() => {
    const map = new Map<string, ProjectAgentRow>()
    for (const row of rows ?? []) map.set(row.agentId, row)
    return map
  }, [rows])

  return (
    <>
      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          projectId={projectId}
          agent={agent}
          liveRow={agent.agentId ? (byAgentId.get(agent.agentId) ?? null) : null}
          actions
        />
      ))}
    </>
  )
}

function AgentCard({
  projectId,
  agent,
  liveRow,
  actions,
}: {
  projectId: string
  agent: ProjectAgent
  liveRow: ProjectAgentRow | null
  actions: boolean
}) {
  const t = useTranslations("Projects")

  const state = liveRow ? toUiState(liveRow.state) : agent.state
  const lastResult = liveRow ? parseLastResult(liveRow.lastResult) : null

  const activity =
    state === "active"
      ? t("agent.working")
      : (lastResult?.summary ??
        agent.currentTask ??
        agent.description ??
        t("agent.noCurrent"))

  const agentId = agent.agentId

  const startMutation = useMutation({
    mutationFn: () => {
      if (!agentId) return Promise.reject(new Error("Agent not synced yet"))
      return client.projects.agents.start({ projectId, agentId })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const stopMutation = useMutation({
    mutationFn: () => {
      if (!agentId) return Promise.reject(new Error("Agent not synced yet"))
      return client.projects.agents.stop({ projectId, agentId })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const pending = startMutation.isPending || stopMutation.isPending
  const working = state === "active"

  return (
    <div className="group relative flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/30">
      <Link
        to="/projects/$id/agents/$agentId"
        params={{ id: projectId, agentId: agent.id }}
        className="absolute inset-0"
        aria-label={agent.displayName}
      />
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/10">
          <Bot className="size-3.5 text-foreground/70" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {agent.displayName}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              agentStateClass(state),
              state === "active" && "animate-pulse"
            )}
            aria-hidden
          />
          <span className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
            {t(`agentStates.${state}`)}
          </span>
        </span>
      </div>
      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        {activity}
      </p>
      {actions && agent.agentId ? (
        <div className="relative z-10 mt-auto flex items-center gap-1.5">
          {working ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => stopMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400"
            >
              {pending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3" />
              )}
              {t("agent.stop")}
            </button>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => startMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-400"
            >
              {pending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              {t("agent.run")}
            </button>
          )}
          {lastResult && !working ? (
            <span
              className={cn(
                "text-[10px] tracking-wide uppercase",
                lastResult.status === "failed"
                  ? "text-red-500"
                  : "text-muted-foreground/60"
              )}
            >
              {t(`agent.lastResult.${lastResult.status}`)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
