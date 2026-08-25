"use client";

import { useLiveQuery } from "@tanstack/react-db"
import { Link, useRouterState } from "@tanstack/react-router"
import { FolderKanban } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useSyncExternalStore } from "react"

import { projectAgentsCollection } from "@/db-collections/project-agents"
import { projectsCollection, type ProjectRow } from "@/db-collections/projects"
import { cn } from "@/lib/utils"

/**
 * `useLiveQuery` reads from a client-only Electric collection (sync is a no-op
 * during SSR), so defer subscribing until after hydration to avoid React's
 * missing `getServerSnapshot` warning.
 */
function useIsHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

export function ThreadList() {
  const hydrated = useIsHydrated()

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto pr-1">
        {hydrated ? <ProjectsSection /> : <ProjectsSkeleton />}
      </div>
    </div>
  )
}

function ProjectsSection() {
  const t = useTranslations("AppShell")
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ project: projectsCollection })
  )

  const sorted = useMemo(
    () =>
      [...(projects ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      ),
    [projects]
  )

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between px-2.5">
        <h2 className="text-[13px] font-medium text-foreground/80">
          {t("projects")}
        </h2>
      </div>
      <div className="space-y-0.5">
        {isLoading ? (
          <ProjectsSkeleton />
        ) : sorted.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-muted-foreground/70">
            {t("noProjects")}
          </p>
        ) : (
          sorted.map((project) => (
            <ProjectItem key={project.id} project={project} />
          ))
        )}
      </div>
    </div>
  )
}

function ProjectsSkeleton() {
  return (
    <div className="space-y-0.5 px-2.5" aria-hidden>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 py-2">
          <div className="size-3.5 shrink-0 rounded-sm bg-foreground/6" />
          <div
            className="h-3.5 flex-1 rounded bg-foreground/6"
            style={{ maxWidth: `${72 - (i % 3) * 14}%` }}
          />
        </div>
      ))}
    </div>
  )
}

function ProjectItem({ project }: { project: ProjectRow }) {
  const t = useTranslations("AppShell")
  const location = useRouterState({ select: (s) => s.location })
  const isDraft = project.status === "draft"
  // Drafts aren't activated yet, so they open the create/setup flow rather
  // than the project workspace. All drafts share the /projects/create path, so
  // match on the projectId search param to highlight only the selected one.
  const isActive = isDraft
    ? location.pathname.startsWith("/projects/create") &&
      (location.search as { projectId?: string }).projectId === project.id
    : location.pathname.startsWith(`/projects/${project.id}`)
  const running = useAnyAgentWorking(project.id)

  return (
    <div
      className={cn(
        "group/item relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-foreground/4",
        isActive && "bg-foreground/6"
      )}
    >
      {isDraft ? (
        <Link
          to="/projects/create"
          search={{ projectId: project.id }}
          className="absolute inset-0 z-0"
          aria-label={project.name}
        />
      ) : (
        <Link
          to="/projects/$id"
          params={{ id: project.id }}
          className="absolute inset-0 z-0"
          aria-label={project.name}
        />
      )}

      <FolderKanban className="size-3.5 shrink-0 text-muted-foreground/70" />

      <p className="min-w-0 flex-1 truncate text-[13px] leading-tight text-foreground/90">
        {project.name}
      </p>

      {isDraft ? (
        <span className="shrink-0 rounded-sm bg-foreground/8 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("draft")}
        </span>
      ) : running ? (
        <span
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground/60"
          aria-hidden
        />
      ) : null}
    </div>
  )
}

/**
 * Live: true when any of the project's agents is currently `working`. Reads the
 * project-scoped roster collection (cached per project) so the dot reflects
 * real agent activity rather than the project's own status field.
 */
function useAnyAgentWorking(projectId: string): boolean {
  const collection = useMemo(
    () => projectAgentsCollection(projectId),
    [projectId]
  )
  const { data: rows } = useLiveQuery(
    (q) => q.from({ pa: collection }),
    [collection]
  )
  return (rows ?? []).some((row) => row.state === "working")
}
