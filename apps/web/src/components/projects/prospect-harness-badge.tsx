"use client"

import { useQuery } from "@tanstack/react-query"
import { Bot, ChevronDown, ExternalLink, Loader2 } from "lucide-react"
import { useState } from "react"

import { orpc } from "@/orpc/client"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<string, string> = {
  READY: "bg-green-500/15 text-green-600 dark:text-green-400",
  CREATING: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  UPDATING: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  CREATE_FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
  UPDATE_FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
  DELETING: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  DELETE_FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-[11px] text-foreground">
        {value}
      </span>
    </div>
  )
}

/**
 * Header chip identifying the intake chat as the Project Prospect agent.
 * Opens a popover describing the Bedrock AgentCore harness behind it
 * (fetched server-side via the control plane's GetHarness API).
 */
export function ProspectHarnessBadge() {
  const [open, setOpen] = useState(false)

  // Only fetch once the popover is opened; the API caches the control-plane
  // response, so repeated opens are cheap.
  const harnessQuery = useQuery({
    ...orpc.projects.prospect.harness.queryOptions({ input: {} }),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const harness = harnessQuery.data?.harness ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/20 dark:text-violet-400">
        <Bot className="size-3.5" />
        Project Prospect
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b px-3 py-2.5">
          <p className="text-xs font-medium text-foreground">
            Project Prospect agent
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            This intake conversation is handled by the Project Prospect agent,
            which interviews you to shape the research brief before
            activation. It runs on an Amazon Bedrock AgentCore harness.
          </p>
        </div>

        <div className="px-3 py-2.5">
          {!open || harnessQuery.isPending ? (
            <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading harness details…
            </div>
          ) : harnessQuery.isError ? (
            <p className="py-1 text-[11px] text-destructive">
              Couldn't load harness details
              {harnessQuery.error instanceof Error
                ? `: ${harnessQuery.error.message}`
                : "."}
            </p>
          ) : !harness ? (
            <p className="py-1 text-[11px] text-muted-foreground">
              {harnessQuery.data?.configured
                ? "The harness could not be described."
                : "No harness configured in this environment (local development)."}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {harness.harnessName}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-px text-[10px] font-medium",
                    STATUS_CLASS[harness.status] ??
                      "bg-foreground/10 text-foreground/70",
                  )}
                >
                  {harness.status}
                </span>
              </div>
              {harness.harnessVersion ? (
                <DetailRow label="Version" value={harness.harnessVersion} />
              ) : null}
              {harness.modelId ? (
                <DetailRow label="Model" value={harness.modelId} />
              ) : null}
              {harness.tools.length > 0 ? (
                <DetailRow
                  label="Tools"
                  value={harness.tools
                    .map((tool) => tool.name ?? tool.type)
                    .join(", ")}
                />
              ) : null}
              {harness.maxIterations != null ? (
                <DetailRow
                  label="Max iterations"
                  value={String(harness.maxIterations)}
                />
              ) : null}
              {harness.maxTokens != null ? (
                <DetailRow
                  label="Max tokens"
                  value={harness.maxTokens.toLocaleString()}
                />
              ) : null}
              {harness.timeoutSeconds != null ? (
                <DetailRow
                  label="Timeout"
                  value={`${harness.timeoutSeconds}s`}
                />
              ) : null}
              {harness.updatedAt ? (
                <DetailRow
                  label="Updated"
                  value={new Date(harness.updatedAt).toLocaleString()}
                />
              ) : null}
              {harness.consoleUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 w-full text-[11px]"
                  onClick={() => {
                    window.open(
                      harness.consoleUrl!,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }}
                >
                  <ExternalLink className="size-3" />
                  Open in AWS Console
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
