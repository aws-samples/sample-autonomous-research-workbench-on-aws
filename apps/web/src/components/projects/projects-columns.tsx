"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { useTranslations, useLocale } from "next-intl"
import { ArrowDown, ArrowUp, ChevronsUpDown, FolderKanban } from "lucide-react"
import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import { formatTaskDateTime } from "@/components/tasks/utils"
import { cn } from "@/lib/utils"

import type { Project, ProjectStatus } from "./types"

function SortHeader({
  label,
  isSorted,
  onToggle,
  className,
}: {
  label: string
  isSorted: false | "asc" | "desc"
  onToggle: (desc: boolean) => void
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2.5 h-7 text-muted-foreground", className)}
      onClick={() => onToggle(isSorted === "asc")}
    >
      <span>{label}</span>
      {isSorted === "desc" ? (
        <ArrowDown />
      ) : isSorted === "asc" ? (
        <ArrowUp />
      ) : (
        <ChevronsUpDown className="opacity-50" />
      )}
    </Button>
  )
}

function projectStatusBadgeClass(status: ProjectStatus): string {
  switch (status) {
    case "draft":
      return "border-foreground/20 bg-foreground/5 text-muted-foreground"
    case "active":
      return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
    case "paused":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    case "completed":
    default:
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  }
}

function statusDotClass(status: ProjectStatus): string {
  switch (status) {
    case "draft":
      return "bg-muted-foreground/40"
    case "active":
      return "bg-blue-500"
    case "paused":
      return "bg-amber-500"
    case "completed":
    default:
      return "bg-emerald-500"
  }
}

export function useProjectColumns(): ColumnDef<Project>[] {
  const t = useTranslations("Projects")
  const locale = useLocale()

  return useMemo<ColumnDef<Project>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <SortHeader
            label={t("columns.name")}
            isSorted={column.getIsSorted()}
            onToggle={(desc) => column.toggleSorting(desc)}
          />
        ),
        cell: ({ row }) => {
          const project = row.original
          return (
            <div className="flex items-center gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <FolderKanban className="size-3" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {project.name}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {project.summary}
                </p>
              </div>
            </div>
          )
        },
      },
      {
        accessorKey: "status",
        header: t("columns.status"),
        cell: ({ row }) => {
          const status = row.original.status
          return (
            <span
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
                projectStatusBadgeClass(status)
              )}
            >
              <span
                className={cn(
                  "mr-1.5 size-1.5 rounded-full",
                  statusDotClass(status)
                )}
              />
              {t(`statuses.${status}`)}
            </span>
          )
        },
        filterFn: (row, id, value: string[]) =>
          value.length === 0 || value.includes(row.getValue(id)),
      },
      {
        id: "agents",
        accessorFn: (row) => row.agents.length,
        header: ({ column }) => (
          <SortHeader
            label={t("columns.agents")}
            isSorted={column.getIsSorted()}
            onToggle={(desc) => column.toggleSorting(desc)}
          />
        ),
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("agentCount", { count: row.original.agents.length })}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortHeader
            label={t("columns.created")}
            isSorted={column.getIsSorted()}
            onToggle={(desc) => column.toggleSorting(desc)}
            className="ml-auto"
          />
        ),
        cell: ({ row }) => (
          <div className="text-right text-xs text-muted-foreground tabular-nums">
            {formatTaskDateTime(row.original.createdAt, locale)}
          </div>
        ),
      },
    ],
    [t, locale]
  )
}
