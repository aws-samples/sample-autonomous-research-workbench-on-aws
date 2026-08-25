"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUp, Loader2, Plus, Rocket, TriangleAlert, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { createElement } from "react"

import { orpc } from "@/orpc/client"
import { AgentMarkdown } from "@/components/tasks/agent-markdown"
import {
  getToolIcon,
  statusIcon,
  statusIconClass,
} from "@/components/tasks/tool-display"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { useProspectStream } from "@/hooks/use-prospect-stream"
import { useProjectRow } from "@/hooks/use-project-row"
import { ProspectHarnessBadge } from "./prospect-harness-badge"

type ChatMessage = { id: string; role: "user" | "assistant"; content: string }
type AssignedAgent = { id: string; name: string; description: string }

export function CreateProjectView({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)

  const projectQuery = useQuery(
    orpc.projects.get.queryOptions({ input: { id: projectId } }),
  )

  const historyQuery = useQuery(
    orpc.projects.prospect.history.queryOptions({ input: { id: projectId } }),
  )

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [seeded, setSeeded] = useState(false)

  const [budget, setBudget] = useState("")
  const [cadence, setCadence] = useState("")
  const [agents, setAgents] = useState<AssignedAgent[]>([])

  // Live-syncing project row (Electric). As the prospect agent persists brief
  // fields via its tools, this updates without a refetch. We merge it over the
  // initial react-query load so the panel reflects saves in real time.
  const liveRow = useProjectRow(projectId)
  const project = useMemo(() => {
    if (!projectQuery.data) return undefined
    if (!liveRow) return projectQuery.data
    return {
      ...projectQuery.data,
      name: liveRow.name ?? projectQuery.data.name,
      status: liveRow.status ?? projectQuery.data.status,
      seedHypothesis: liveRow.seedHypothesis ?? projectQuery.data.seedHypothesis,
      maxBudgetUsd: liveRow.maxBudgetUsd ?? projectQuery.data.maxBudgetUsd,
      checkInCadence: liveRow.checkInCadence ?? projectQuery.data.checkInCadence,
      objective: liveRow.objective,
      flags: liveRow.flags,
      contextNotes: liveRow.contextNotes,
    }
  }, [projectQuery.data, liveRow])

  // The create flow is only for drafts. If the project is (or becomes)
  // active, go to the project screen. Activation normally navigates via the
  // mutation's onSuccess, but that round-trip can be lost — e.g. the request
  // outlives a proxy timeout, or the connection died while the tab was
  // asleep — leaving the server activated while this screen sits on a
  // spinner. The status flip arrives independently through the live project
  // row (Electric) or a refetched/reloaded projects.get, so this effect is
  // the safety net that always moves the user forward.
  const projectStatus = project?.status
  useEffect(() => {
    if (projectStatus && projectStatus !== "draft") {
      navigate({ to: "/projects/$id", params: { id: projectId }, replace: true })
    }
  }, [projectStatus, projectId, navigate])

  // Load persisted history and reconnect to an in-progress prospect run.
  useEffect(() => {
    if (historyQuery.data && !seeded) {
      setSeeded(true)
      setMessages(
        historyQuery.data.messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      )
      setActiveRunId(historyQuery.data.activeRunId)
    }
  }, [historyQuery.data, seeded])

  // Seed project fields from project data
  useEffect(() => {
    if (!project) return
    // The enforced agent-spend cap in USD ($100 default from creation);
    // reflects live saves from the prospect agent's budgetUsd tool field.
    if (project.maxBudgetUsd != null) setBudget(String(project.maxBudgetUsd))
    if (project.checkInCadence) setCadence(project.checkInCadence)
    if (project.agents.length > 0) {
      setAgents(
        project.agents.map((agent) => ({
          id: agent.id,
          name: agent.displayName,
          description: agent.description || "",
        })),
      )
    }
  }, [project])

  // Auto-send the seed hypothesis as the first message if no history exists
  const chatMutation = useMutation(
    orpc.projects.prospect.chat.mutationOptions(),
  )

  // Once-per-mount guard for the auto-send below. It must be a ref (not
  // state) so it flips synchronously: the effect's other guards
  // (chatMutation.isPending, activeRunId) update asynchronously, and
  // `project` gets a new identity on every Electric liveRow update, so the
  // effect can re-fire before those guards catch up and double-post the seed.
  const seedSentRef = useRef(false)

  useEffect(() => {
    if (
      !seedSentRef.current &&
      project &&
      historyQuery.data &&
      historyQuery.data.messages.length === 0 &&
      !chatMutation.isPending &&
      !activeRunId
    ) {
      seedSentRef.current = true
      sendMessage(project.seedHypothesis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, historyQuery.data])

  const { streamingText, parts, isStreaming } = useProspectStream({
    runId: activeRunId,
    projectId,
    onComplete: (fullText) => {
      if (fullText) {
        setMessages((prev) => [
          ...prev,
          { id: `assistant-${Date.now()}`, role: "assistant", content: fullText },
        ])
      }
      setActiveRunId(null)
    },
    // A turn can die mid-reply (upstream model errors). The server persists
    // the partial, so commit it here too and say what happened instead of
    // letting the text silently stop growing.
    onError: (message, fullText) => {
      if (fullText) {
        setMessages((prev) => [
          ...prev,
          { id: `assistant-${Date.now()}`, role: "assistant", content: fullText },
        ])
      }
      setActiveRunId(null)
      toast.error("The prospect agent stopped early", { description: message })
    },
  })

  // Auto-scroll on new content (text deltas and tool chips alike — a tool
  // call adds a part without changing streamingText).
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, streamingText, parts])

  // Synchronous in-flight guard: chatMutation.isPending only flips on the
  // next render, so a fast double-click (or effect re-run) could otherwise
  // slip past it and post the same message twice.
  const sendInFlightRef = useRef(false)

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || sendInFlightRef.current || chatMutation.isPending) return
    sendInFlightRef.current = true

    setInput("")
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content: trimmed },
    ])

    try {
      const result = await chatMutation.mutateAsync({
        id: projectId,
        message: trimmed,
      })
      setActiveRunId(result.runId)
      // Keep the history cache honest. It's what gates the seed auto-send,
      // and a stale "no messages" snapshot is what allowed duplicate posts.
      queryClient.invalidateQueries({
        queryKey: orpc.projects.prospect.history.key({
          input: { id: projectId },
        }),
      })
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to send message",
      )
    } finally {
      sendInFlightRef.current = false
    }
  }

  const update = useMutation(
    orpc.projects.update.mutationOptions({
      // handleActivate swallows the rejection, so without this a failed
      // save (expired session, network) would end the flow silently.
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Could not save project",
        ),
    }),
  )
  const activate = useMutation(
    orpc.projects.activate.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.projects.get.key({ input: { id: projectId } }),
        })
        toast.success("Research activated")
        navigate({ to: "/projects/$id", params: { id: projectId } })
      },
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Could not activate",
        ),
    }),
  )

  const canActivate =
    !!project && agents.length > 0 && !activate.isPending && !update.isPending && !isStreaming

  const handleActivate = async () => {
    if (!project) return
    // The budget input is the enforced cap; only persist a valid positive
    // number (otherwise the project keeps its current cap).
    const parsedBudget = Number(budget)
    try {
      await update.mutateAsync({
        id: projectId,
        maxBudgetUsd:
          Number.isFinite(parsedBudget) && parsedBudget > 0
            ? parsedBudget
            : undefined,
        checkInCadence: cadence || undefined,
        agentIds: agents.map((agent) => agent.id),
      })
      await activate.mutateAsync({
        id: projectId,
        // The default 9am daily heartbeat is scheduled in the activating
        // user's timezone (adjustable later in settings).
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch {
      // errors surfaced via mutation onError / toast
    }
  }

  if (projectQuery.isPending || historyQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    )
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <TriangleAlert className="size-5" />
        Couldn't load this project.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-2">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="-ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
            <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
              {project.name}
            </h1>
            <Badge className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
              {project.status}
            </Badge>
            <ProspectHarnessBadge />
          </div>
          <Button
            size="sm"
            disabled={!canActivate}
            onClick={handleActivate}
          >
            {activate.isPending || update.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Rocket className="size-4" />
            )}
            Activate research
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_320px]">
          {/* Chat */}
          <div className="flex min-h-0 flex-col overflow-hidden border-r">
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 py-5">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="flex flex-col items-end py-2">
                      <div className="w-fit max-w-[85%] rounded-lg border border-zinc-200 bg-zinc-100 px-3.5 py-2 text-xs leading-relaxed text-foreground dark:border-zinc-700 dark:bg-zinc-800">
                        {message.content}
                      </div>
                    </div>
                  ) : (
                    <AgentMarkdown key={message.id}>
                      {message.content}
                    </AgentMarkdown>
                  ),
                )}
                {isStreaming &&
                  parts.map((part, index) => {
                    if (part.type === "text") {
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a streaming turn
                        <AgentMarkdown
                          key={index}
                          isAnimating={part.streaming === true}
                        >
                          {part.text}
                        </AgentMarkdown>
                      )
                    }
                    // Tool chip — same rendering as the Team Lead chat
                    // (project-lead-chat.tsx MessageItem).
                    const icon = getToolIcon(part.toolName)
                    const status = statusIcon(part.status)
                    return (
                      <div
                        key={part.stepId}
                        className="my-3 flex items-center gap-1.5"
                      >
                        <div className="flex w-fit max-w-[420px] items-center gap-1.5 rounded-md border border-input bg-muted px-2 py-1 text-muted-foreground">
                          {createElement(icon, {
                            className: "size-3.5 shrink-0",
                          })}
                          <span className="min-w-0 truncate text-xs text-foreground">
                            {part.label}
                          </span>
                          {createElement(status, {
                            className: cn(
                              "ml-2 size-3.5 shrink-0",
                              statusIconClass(part.status),
                            ),
                          })}
                        </div>
                      </div>
                    )
                  })}
                {(isStreaming && parts.length === 0) && (
                  <div className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Thinking…
                  </div>
                )}
              </div>
            </div>

            <div className="mt-auto shrink-0 px-4 pb-4">
              <div className="mx-auto max-w-2xl">
                <InputGroup>
                  <InputGroupTextarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        sendMessage(input)
                      }
                    }}
                    placeholder="Reply to the Project Prospect…"
                    rows={2}
                    disabled={isStreaming}
                  />
                  <InputGroupAddon align="block-end">
                    <div className="ml-auto" />
                    <InputGroupButton
                      variant="default"
                      className="size-7"
                      disabled={input.trim().length === 0 || isStreaming}
                      onClick={() => sendMessage(input)}
                      aria-label="Send"
                    >
                      <ArrowUp />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            </div>
          </div>

          {/* Research brief */}
          <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">
                Seed hypothesis
              </Label>
              <p className="text-xs leading-relaxed text-foreground">
                {project.seedHypothesis}
              </p>
            </div>

            {project.objective && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Objective & success criteria
                </Label>
                <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                  {project.objective}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget" className="text-xs">
                Agent budget (USD)
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted-foreground">
                  $
                </span>
                <Input
                  id="budget"
                  type="number"
                  min={1}
                  step={1}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="100"
                  className="h-8 pl-6 tabular-nums"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Hard cap — agents stop when spend reaches it. Adjustable later
                in settings.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cadence" className="text-xs">
                Check-in cadence
              </Label>
              <Input
                id="cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                placeholder="e.g. every 2 weeks"
                className="h-8"
              />
            </div>

            {project.flags && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Flags & watch-outs
                </Label>
                <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                  {project.flags}
                </p>
              </div>
            )}

            {project.contextNotes && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Context & constraints
                </Label>
                <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                  {project.contextNotes}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Agents</Label>
                <AssignAgentsSheet selected={agents} onChange={setAgents} />
              </div>
              {agents.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No agents assigned yet.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {agents.map((agent) => (
                    <Badge
                      key={agent.id}
                      className="gap-1 bg-foreground/5 text-foreground/80"
                    >
                      {agent.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function AssignAgentsSheet({
  selected,
  onChange,
}: {
  selected: AssignedAgent[]
  onChange: (agents: AssignedAgent[]) => void
}) {
  const [draft, setDraft] = useState<AssignedAgent[]>(selected)

  const agentsQuery = useQuery(
    orpc.agents.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
  )

  const openSync = useMemo(() => () => setDraft(selected), [selected])

  const toggle = (agent: AssignedAgent) => {
    setDraft((prev) =>
      prev.some((a) => a.id === agent.id)
        ? prev.filter((a) => a.id !== agent.id)
        : [...prev, agent],
    )
  }

  const availableAgents: AssignedAgent[] =
    agentsQuery.data?.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
    })) ?? []

  return (
    <Sheet
      onOpenChange={(open) => {
        if (open) openSync()
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">
          <Plus className="size-3.5" />
          Assign agents
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>Assign agents</SheetTitle>
          <SheetDescription>
            Pick the agents to work on this program.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-4">
          {agentsQuery.isPending ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading agents…
            </div>
          ) : availableAgents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No agents available. Create an agent first.
            </p>
          ) : (
            availableAgents.map((agent) => {
              const checked = draft.some((a) => a.id === agent.id)
              return (
                <label
                  key={agent.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                    checked
                      ? "border-foreground/20 bg-foreground/5"
                      : "border-transparent hover:bg-foreground/4",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(agent)}
                    className="mt-0.5"
                  />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-foreground">
                      {agent.name}
                    </span>
                    {agent.description && (
                      <span className="text-[11px] text-muted-foreground">
                        {agent.description}
                      </span>
                    )}
                  </div>
                </label>
              )
            })
          )}
        </div>

        <SheetFooter>
          <SheetClose asChild>
            <Button
              size="sm"
              onClick={() => onChange(draft)}
              disabled={agentsQuery.isPending}
            >
              Save ({draft.length})
            </Button>
          </SheetClose>
          <SheetClose asChild>
            <Button variant="outline" size="sm">
              <X className="size-4" />
              Cancel
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
