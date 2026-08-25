"use client"

import { useTranslations } from "next-intl"
import { Search } from "lucide-react"

import { Kbd } from "@/components/ui/kbd"

export function SearchButton() {
  const t = useTranslations("AppShell")

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="flex-1 text-left">{t("search")}</span>
      <Kbd>&#8984;K</Kbd>
    </button>
  )
}
