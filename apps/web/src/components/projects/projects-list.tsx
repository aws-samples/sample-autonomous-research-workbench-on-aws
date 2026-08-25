"use client"

import { useTranslations } from "next-intl"

import { SidebarTrigger } from "@/components/ui/sidebar"

import { ProjectsDataTable } from "./projects-data-table"

export function ProjectsList() {
  const t = useTranslations("Projects")

  return (
    <div className="flex h-full flex-col overflow-hidden p-2">
      <div className="flex h-full w-full flex-col overflow-hidden">
        <header className="flex shrink-0 items-start gap-2 pb-3">
          <SidebarTrigger className="mt-1 -ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {t("title")}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("tagline")}</p>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <ProjectsDataTable />
        </div>
      </div>
    </div>
  )
}
