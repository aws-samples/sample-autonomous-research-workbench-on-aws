"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import {
  Bot,
  Brain,
  HeartPulse,
  Loader2,
  Search,
  Settings,
  Users,
  Wallet,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { createElement, useState } from "react"
import { toast } from "sonner"

import {
  AVAILABLE_MODELS,
  TEAM_LEAD_DEFAULT_MODEL_ID,
} from "@/components/agents/constants"
import type { ModelConfig, ReasoningMode } from "@/components/agents/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { client } from "@/orpc/client"

import type { Project } from "./types"

export type SettingsSectionId =
  | "general"
  | "leadModel"
  | "heartbeat"
  | "budget"
  | "agents"

const MENU_SECTIONS: { id: SettingsSectionId; icon: typeof Settings }[] = [
  { id: "general", icon: Settings },
  { id: "leadModel", icon: Brain },
  { id: "heartbeat", icon: HeartPulse },
  { id: "budget", icon: Wallet },
  { id: "agents", icon: Users },
]

const NAME_MAX = 64
const DESCRIPTION_MAX = 2000

export function ProjectSettings({
  project,
  initialSection = "general",
}: {
  project: Project
  initialSection?: SettingsSectionId
}) {
  const t = useTranslations("Projects")
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>(initialSection)

  if (!project.live) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        {t("settings.sampleReadOnly")}
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="my-4 ml-4 h-fit w-44 shrink-0 rounded-lg border p-2">
        <nav className="flex flex-col gap-0.5">
          {MENU_SECTIONS.map((section) => {
            const isActive = activeSection === section.id
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-tight transition-colors",
                  isActive
                    ? "bg-foreground/6 text-foreground"
                    : "text-foreground/70 hover:bg-foreground/4 hover:text-foreground/90"
                )}
              >
                {createElement(section.icon, {
                  className: "size-3.5 shrink-0",
                  strokeWidth: 1.5,
                })}
                {t(`settings.menu.${section.id}`)}
              </button>
            )
          })}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6 pt-4">
          {activeSection === "general" && (
            <GeneralSection project={project} />
          )}
          {activeSection === "leadModel" && (
            <>
              <LeadModelSection project={project} />
              <LeadPromptSection project={project} />
            </>
          )}
          {activeSection === "heartbeat" && (
            <HeartbeatSection project={project} />
          )}
          {activeSection === "budget" && <BudgetSection project={project} />}
          {activeSection === "agents" && <AgentsSection project={project} />}
        </div>
      </div>
    </div>
  )
}

/** Re-run the route loader so the header + workspace pick up the new data. */
function useProjectRefresh() {
  const router = useRouter()
  return () => router.invalidate()
}

function GeneralSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const refresh = useProjectRefresh()

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.summary)

  const nameError = !name.trim()
    ? t("settings.general.nameRequired")
    : name.length > NAME_MAX
      ? t("settings.general.nameTooLong")
      : null
  const descriptionError = !description.trim()
    ? t("settings.general.descriptionRequired")
    : description.length > DESCRIPTION_MAX
      ? t("settings.general.descriptionTooLong")
      : null

  const hasChanges =
    name !== project.name || description !== project.summary
  const isValid = !nameError && !descriptionError

  const updateMutation = useMutation({
    mutationFn: async () =>
      client.projects.update({
        id: project.id,
        name: name.trim(),
        seedHypothesis: description.trim(),
      }),
    onSuccess: () => {
      refresh()
      toast.success(t("settings.toast.generalSaved"))
    },
    onError: () => toast.error(t("settings.toast.error")),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hasChanges || !isValid) return
    updateMutation.mutate()
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.general.title")}</CardTitle>
        <CardDescription>{t("settings.general.description")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-3">
          <Field data-invalid={!!nameError}>
            <FieldLabel>{t("settings.general.name")}</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.general.namePlaceholder")}
            />
            {nameError && <FieldError>{nameError}</FieldError>}
          </Field>
          <Field data-invalid={!!descriptionError}>
            <FieldLabel>{t("settings.general.projectDescription")}</FieldLabel>
            <FieldDescription>
              {t("settings.general.projectDescriptionHint")}
            </FieldDescription>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("settings.general.descriptionPlaceholder")}
              rows={4}
            />
            {descriptionError && <FieldError>{descriptionError}</FieldError>}
          </Field>
        </CardContent>
        <CardFooter className="mt-4 flex justify-end border-t pt-3">
          <Button
            type="submit"
            size="sm"
            disabled={!hasChanges || !isValid || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t("settings.save")
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function ModelDetails({ model }: { model: ModelConfig }) {
  const t = useTranslations("Agents")

  const reasoningLabels: Record<ReasoningMode, string> = {
    budget: t("settings.modelSection.reasoningConfigurable"),
    adaptive: t("settings.modelSection.reasoningAdaptive"),
    none: t("settings.modelSection.reasoningDisabled"),
  }

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <div className="flex justify-between">
        <span>{t("settings.modelSection.detailContext")}</span>
        <span className="font-medium text-foreground">{model.context}</span>
      </div>
      <div className="flex justify-between">
        <span>{t("settings.modelSection.detailReasoning")}</span>
        <span className="font-medium text-foreground">
          {reasoningLabels[model.reasoningMode]}
        </span>
      </div>
      <div className="flex justify-between">
        <span>{t("settings.modelSection.detailCost")}</span>
        <span className="font-medium text-foreground">
          ${model.cost.input} / ${model.cost.output}
        </span>
      </div>
    </div>
  )
}

function LeadModelSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const refresh = useProjectRefresh()

  const initialModel = project.leadModel ?? TEAM_LEAD_DEFAULT_MODEL_ID
  const [leadModel, setLeadModel] = useState(initialModel)

  const selectedModel = AVAILABLE_MODELS.find((m) => m.id === leadModel)

  const updateMutation = useMutation({
    mutationFn: async (newModel: string) =>
      client.projects.update({ id: project.id, leadModel: newModel }),
    onSuccess: () => {
      refresh()
      toast.success(t("settings.toast.modelSaved"))
    },
    onError: () => {
      setLeadModel(initialModel)
      toast.error(t("settings.toast.error"))
    },
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.leadModel.title")}</CardTitle>
        <CardDescription>
          {t("settings.leadModel.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field>
          <FieldLabel>{t("settings.leadModel.preferredModel")}</FieldLabel>
          <FieldDescription>
            {t("settings.leadModel.preferredModelDescription")}
          </FieldDescription>
          <Select
            value={leadModel}
            onValueChange={(value) => {
              if (value && value !== leadModel) {
                setLeadModel(value)
                updateMutation.mutate(value)
              }
            }}
            disabled={updateMutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {selectedModel ? (
                  <span className="flex items-center gap-2">
                    {selectedModel.name}
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-1.5 py-0 text-[10px]"
                    >
                      {selectedModel.lab}
                    </Badge>
                  </span>
                ) : (
                  leadModel
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AVAILABLE_MODELS.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <span className="flex items-center gap-2">
                    {model.name}
                    <Badge
                      variant="secondary"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {model.lab}
                    </Badge>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {selectedModel && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium">{selectedModel.name}</span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {selectedModel.lab}
              </Badge>
            </div>
            <ModelDetails model={selectedModel} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const PROMPT_MAX = 10000

function LeadPromptSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const refresh = useProjectRefresh()

  const initialPrompt = project.leadSystemPrompt ?? ""
  const [systemPrompt, setSystemPrompt] = useState(initialPrompt)

  const tooLong = systemPrompt.length > PROMPT_MAX
  const hasChanges = systemPrompt !== initialPrompt

  const updateMutation = useMutation({
    mutationFn: async () =>
      client.projects.update({
        id: project.id,
        leadSystemPrompt: systemPrompt.trim() ? systemPrompt : null,
      }),
    onSuccess: () => {
      refresh()
      toast.success(t("settings.toast.promptSaved"))
    },
    onError: () => toast.error(t("settings.toast.error")),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hasChanges || tooLong) return
    updateMutation.mutate()
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.leadPrompt.title")}</CardTitle>
        <CardDescription>{t("settings.leadPrompt.description")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent>
          <Field data-invalid={tooLong}>
            <FieldLabel>{t("settings.leadPrompt.label")}</FieldLabel>
            <FieldDescription>
              {t("settings.leadPrompt.hint")}
            </FieldDescription>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("settings.leadPrompt.placeholder")}
              className="min-h-64 resize-none font-mono text-xs"
            />
            {tooLong && (
              <FieldError>{t("settings.leadPrompt.tooLong")}</FieldError>
            )}
          </Field>
        </CardContent>
        <CardFooter className="mt-4 flex justify-end border-t pt-3">
          <Button
            type="submit"
            size="sm"
            disabled={!hasChanges || tooLong || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t("settings.save")
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

/**
 * The project heartbeat: a daily EventBridge schedule that pulses the Team
 * Lead to check on its agents. The schedule itself is the source of truth
 * (time, timezone, enabled), so this section reads and writes it live via
 * the heartbeat routes rather than project fields.
 */
function HeartbeatSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const queryClient = useQueryClient()

  const heartbeatQuery = useQuery({
    queryKey: ["projects", project.id, "heartbeat"],
    queryFn: () => client.projects.heartbeat.get({ id: project.id }),
  })
  const heartbeat = heartbeatQuery.data?.heartbeat ?? null

  const [time, setTime] = useState<string | null>(null)
  const editedTime = time ?? heartbeat?.time ?? "09:00"
  const hasChanges = heartbeat?.time != null && editedTime !== heartbeat.time

  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const updateMutation = useMutation({
    mutationFn: async (input: {
      time?: string
      timezone?: string
      enabled?: boolean
    }) => client.projects.heartbeat.update({ id: project.id, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects", project.id, "heartbeat"],
      })
      setTime(null)
      toast.success(t("settings.heartbeat.toastSaved"))
    },
    onError: () => toast.error(t("settings.toast.error")),
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.heartbeat.title")}</CardTitle>
        <CardDescription>
          {t("settings.heartbeat.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {heartbeatQuery.isPending ? (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" />
          </div>
        ) : !heartbeat ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {project.status === "active"
                ? t("settings.heartbeat.noneActive")
                : t("settings.heartbeat.noneDraft")}
            </p>
            {project.status === "active" && (
              <Button
                size="sm"
                disabled={updateMutation.isPending}
                onClick={() =>
                  updateMutation.mutate({
                    time: "09:00",
                    timezone: browserTimezone,
                    enabled: true,
                  })
                }
              >
                {updateMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  t("settings.heartbeat.enable")
                )}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-foreground">
                  {t("settings.heartbeat.enabledLabel")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {heartbeat.enabled
                    ? t("settings.heartbeat.enabledHint")
                    : t("settings.heartbeat.disabledHint")}
                </p>
              </div>
              <Switch
                checked={heartbeat.enabled}
                disabled={updateMutation.isPending}
                onCheckedChange={(checked) =>
                  updateMutation.mutate({ enabled: checked === true })
                }
              />
            </div>

            <Field>
              <FieldLabel>{t("settings.heartbeat.timeLabel")}</FieldLabel>
              <FieldDescription>
                {t("settings.heartbeat.timeHint", {
                  timezone: heartbeat.timezone,
                })}
              </FieldDescription>
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  value={editedTime}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-32 tabular-nums"
                />
                <Button
                  size="sm"
                  disabled={!hasChanges || updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ time: editedTime })}
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    t("settings.save")
                  )}
                </Button>
              </div>
            </Field>

            {heartbeat.timezone !== browserTimezone && (
              <p className="text-xs text-muted-foreground">
                {t("settings.heartbeat.timezoneMismatch", {
                  timezone: browserTimezone,
                })}{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  disabled={updateMutation.isPending}
                  onClick={() =>
                    updateMutation.mutate({ timezone: browserTimezone })
                  }
                >
                  {t("settings.heartbeat.useMyTimezone")}
                </button>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

const BUDGET_MAX = 500
const BUDGET_STEP = 5

function BudgetSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const refresh = useProjectRefresh()

  // Every project has a budget cap — it can be adjusted but never removed.
  const initialBudget = project.maxBudgetUsd ?? 100
  const [budget, setBudget] = useState<number>(initialBudget)
  // Free-form text mirror of the numeric input so partial edits don't snap.
  const [budgetText, setBudgetText] = useState<string>(String(initialBudget))

  const { data: metrics } = useQuery({
    queryKey: ["projects", project.id, "metrics"],
    queryFn: () => client.projects.metrics({ id: project.id }),
    refetchInterval: 30_000,
  })
  const spend = metrics?.totals.spendUsd ?? 0

  const hasChanges = budget !== initialBudget
  const isValid = Number.isFinite(budget) && budget > 0

  const setBudgetValue = (value: number) => {
    setBudget(value)
    setBudgetText(String(value))
  }

  const updateMutation = useMutation({
    mutationFn: async () =>
      client.projects.update({
        id: project.id,
        maxBudgetUsd: budget,
      }),
    onSuccess: () => {
      refresh()
      toast.success(t("settings.budget.toastSaved"))
    },
    onError: () => toast.error(t("settings.toast.error")),
  })

  const spendPct = budget > 0 ? Math.min(100, (spend / budget) * 100) : null
  const overBudget = spend >= budget && spend > 0

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.budget.title")}</CardTitle>
        <CardDescription>{t("settings.budget.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <Slider
              value={[Math.min(budget, BUDGET_MAX)]}
              min={BUDGET_STEP}
              max={BUDGET_MAX}
              step={BUDGET_STEP}
              onValueChange={([value]) => {
                if (value !== undefined) setBudgetValue(value)
              }}
              className="flex-1"
            />
            <div className="relative w-28 shrink-0">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-muted-foreground">
                $
              </span>
              <Input
                type="number"
                min={1}
                step={1}
                value={budgetText}
                onChange={(e) => {
                  setBudgetText(e.target.value)
                  const parsed = Number(e.target.value)
                  if (Number.isFinite(parsed)) setBudget(parsed)
                }}
                className="h-8 pl-6 text-[13px] tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">
                {t("settings.budget.currentSpend")}
              </span>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  overBudget ? "text-destructive" : "text-foreground"
                )}
              >
                {t("settings.budget.spendOfBudget", {
                  spend: spend.toFixed(2),
                  budget: budget.toFixed(0),
                })}
              </span>
            </div>
            <Progress
              value={spendPct ?? 0}
              className={cn(overBudget && "[&>div]:bg-destructive")}
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="mt-4 flex justify-end border-t pt-3">
        <Button
          size="sm"
          disabled={!hasChanges || !isValid || updateMutation.isPending}
          onClick={() => updateMutation.mutate()}
        >
          {updateMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            t("settings.save")
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}

function AgentsSection({ project }: { project: Project }) {
  const t = useTranslations("Projects")
  const refresh = useProjectRefresh()

  const initialIds = project.agents.map((agent) => agent.id)
  const [selected, setSelected] = useState<string[]>(initialIds)
  const [query, setQuery] = useState("")

  // The assignable catalog is the DB agent list (management UI agents).
  const agentsQuery = useQuery({
    queryKey: ["agents", "list", "all"],
    queryFn: () => client.agents.list({ page: 1, pageSize: 100 }),
  })
  const catalog = agentsQuery.data?.agents ?? []

  const visibleAgents = catalog.filter((agent) =>
    agent.name.toLowerCase().includes(query.trim().toLowerCase())
  )

  const hasChanges =
    selected.length !== initialIds.length ||
    selected.some((id) => !initialIds.includes(id))

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )
  }

  const updateMutation = useMutation({
    mutationFn: async () =>
      client.projects.update({
        id: project.id,
        agentIds: selected,
      }),
    onSuccess: () => {
      refresh()
      toast.success(t("settings.toast.agentsSaved"))
    },
    onError: () => toast.error(t("settings.toast.error")),
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("settings.agents.title")}</CardTitle>
        <CardDescription>{t("settings.agents.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.agents.searchPlaceholder")}
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          {agentsQuery.isPending ? (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            </div>
          ) : visibleAgents.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-muted-foreground">
              {t("settings.agents.noResults", { query: query.trim() })}
            </p>
          ) : (
            visibleAgents.map((agent) => {
              const checked = selected.includes(agent.id)
              return (
                <label
                  key={agent.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                    checked
                      ? "border-foreground/20 bg-foreground/5"
                      : "border-transparent hover:bg-foreground/4"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(agent.id)}
                  />
                  <Bot className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-[13px] text-foreground">
                    {agent.name}
                  </span>
                </label>
              )
            })
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-4 flex items-center justify-between border-t pt-3">
        <span className="text-[11px] text-muted-foreground">
          {t("settings.agents.selectedCount", { count: selected.length })}
        </span>
        <Button
          size="sm"
          disabled={
            !hasChanges || selected.length === 0 || updateMutation.isPending
          }
          onClick={() => updateMutation.mutate()}
        >
          {updateMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            t("settings.save")
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}
