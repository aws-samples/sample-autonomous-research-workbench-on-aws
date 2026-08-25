"use client"

import { useTranslations } from "next-intl"
import { Link } from "@tanstack/react-router"
import {
  ArrowLeft,
  CircleAlert,
  PanelRight as PanelRightIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { ProjectLeadChat } from "./project-lead-chat"
import { ProjectWorkspace } from "./project-workspace"
import type { Project, ProjectStatus } from "./types"

const STATUS_CLASS: Record<ProjectStatus, string> = {
  draft: "border-foreground/20 bg-foreground/5 text-muted-foreground",
  active: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  paused: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  completed:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
}

export function ProjectDetail({ project }: { project: Project }) {
  const t = useTranslations("Projects")

  const rightPanelRef = useRef<PanelImperativeHandle>(null)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  // Incremented by the alert's action button; the workspace reacts by
  // opening Settings → Budget.
  const [budgetJumpSignal, setBudgetJumpSignal] = useState(0)

  const budgetExceeded = Boolean(project.budgetExceededAt)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "l" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        const panel = rightPanelRef.current
        if (!panel) return
        if (panel.isCollapsed()) panel.expand()
        else panel.collapse()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden p-2">
        <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="-ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
              <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
              <Link
                to="/projects"
                className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                {t("back")}
              </Link>
              <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
              <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
                {project.name}
              </h1>
              <span
                className={cn(
                  "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  STATUS_CLASS[project.status]
                )}
              >
                {t(`statuses.${project.status}`)}
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                const panel = rightPanelRef.current
                if (!panel) return
                if (panel.isCollapsed()) panel.expand()
                else panel.collapse()
              }}
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <PanelRightIcon className="size-3.5" />
              {rightCollapsed
                ? t("workspace.agents")
                : t("workspace.projectGraph")}
            </button>
          </header>

          {budgetExceeded && (
            <div className="shrink-0 border-b px-5 py-2">
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>{t("budgetAlert.title")}</AlertTitle>
                <AlertDescription>
                  {t("budgetAlert.description")}
                </AlertDescription>
                <AlertAction>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      rightPanelRef.current?.expand()
                      setBudgetJumpSignal((n) => n + 1)
                    }}
                  >
                    {t("budgetAlert.action")}
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          )}

          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel defaultSize="50%" minSize="20%">
              <ProjectLeadChat
                messages={project.lead.messages}
                projectId={project.id}
                leadTaskId={project.leadTaskId}
                live={project.live}
              />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              className={cn(rightCollapsed && "hidden")}
            />
            <ResizablePanel
              panelRef={rightPanelRef}
              defaultSize="50%"
              minSize="40%"
              collapsible
              onResize={(size) => setRightCollapsed(size.asPercentage <= 0)}
            >
              <ProjectWorkspace
                project={project}
                budgetJumpSignal={budgetJumpSignal}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </TooltipProvider>
  )
}
