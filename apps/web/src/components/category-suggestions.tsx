"use client"

import { useTranslations } from "next-intl"
import {
  ArrowUpRight,
  Dna,
  FlaskConical,
  Hexagon,
  ShieldCheck,
  Beaker,
} from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

interface CategorySuggestionsProps {
  onSelect: (suggestion: string) => void
}

const CATEGORY_KEYS = [
  "targetBiology",
  "hitDiscovery",
  "medChem",
  "dmpkSafety",
  "cmc",
] as const

type CategoryKey = (typeof CATEGORY_KEYS)[number]

const CATEGORY_ICONS: Record<CategoryKey, React.ReactNode> = {
  targetBiology: <Dna className="size-3" />,
  hitDiscovery: <FlaskConical className="size-3" />,
  medChem: <Hexagon className="size-3" />,
  dmpkSafety: <ShieldCheck className="size-3" />,
  cmc: <Beaker className="size-3" />,
}

export function CategorySuggestions({ onSelect }: CategorySuggestionsProps) {
  const t = useTranslations("AppShell")
  const [activeCategory, setActiveCategory] =
    React.useState<CategoryKey | null>(null)

  const handleCategoryClick = (key: CategoryKey) => {
    setActiveCategory((prev) => (prev === key ? null : key))
  }

  const handleSuggestionClick = (suggestion: string) => {
    onSelect(suggestion)
    setActiveCategory(null)
  }

  const suggestions = activeCategory
    ? (t.raw(`suggestions.${activeCategory}`) as string[])
    : null

  return (
    <div className="mt-4 w-full">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {CATEGORY_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => handleCategoryClick(key)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-xs/relaxed font-medium transition-all select-none",
              "hover:bg-muted/50",
              activeCategory === key
                ? "border-foreground/20 bg-muted text-foreground"
                : "border-border text-muted-foreground",
            )}
          >
            {CATEGORY_ICONS[key]}
            {t(`categories.${key}`)}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          suggestions
            ? "mt-2.5 grid-rows-[1fr] opacity-100"
            : "mt-0 grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          {suggestions && (
            <div className="flex flex-col">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => handleSuggestionClick(suggestion)}
                  className={cn(
                    "group flex min-h-7 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs/relaxed transition-colors select-none",
                    "cursor-pointer text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span className="line-clamp-1">{suggestion}</span>
                  <ArrowUpRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
