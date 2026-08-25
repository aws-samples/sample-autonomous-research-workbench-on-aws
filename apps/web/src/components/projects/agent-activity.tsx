"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { ChevronRight, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	createElement,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { AgentMarkdown } from "@/components/tasks/agent-markdown";
import {
	getToolIcon,
	statusIcon,
	statusIconClass,
} from "@/components/tasks/tool-display";
import type { AssistantPart, StepStatus } from "@/components/tasks/types";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type ProjectAgentRow,
	parseLastResult,
	projectAgentsCollection,
} from "@/db-collections/project-agents";
import {
	type ProjectRunRow,
	projectRunsCollection,
	runTitle,
} from "@/db-collections/project-runs";
import { cn } from "@/lib/utils";

import { useTaskStream } from "./use-task-stream";

/**
 * Subscribe to the Electric-synced `project_agent` roster row for one agent.
 * Must only be mounted after hydration (Electric sync is client-only) —
 * follow the AgentRoster pattern of branching to a live component.
 */
export function useProjectAgentRow(
	projectId: string,
	agentId: string,
): ProjectAgentRow | null {
	const collection = useMemo(
		() => projectAgentsCollection(projectId),
		[projectId],
	);
	const { data: rows } = useLiveQuery(
		(q) => q.from({ pa: collection }),
		[collection],
	);
	return rows?.find((r) => r.agentId === agentId) ?? null;
}

/**
 * The agent's root orchestrator runs (newest first), from the Electric-synced
 * `run` shape. Root runs carry `agentType = agent.id`, so the persona's run
 * history is just the project's root runs filtered by that key.
 */
function useAgentRootRuns(projectId: string, agentId: string): ProjectRunRow[] {
	const collection = useMemo(
		() => projectRunsCollection(projectId),
		[projectId],
	);
	const { data: rows } = useLiveQuery(
		(q) => q.from({ run: collection }),
		[collection],
	);
	return useMemo(
		() =>
			(rows ?? [])
				.filter((r) => r.parentRunId === null && r.agentType === agentId)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
		[rows, agentId],
	);
}

/**
 * The sub-agent runs spawned under one root orchestrator run (spawn order).
 * Matches on rootRunId, so nested descendants are included too. Child rows
 * are already in the project-scoped Electric `run` shape.
 */
function useChildRuns(
	projectId: string,
	rootRunId: string | null,
): ProjectRunRow[] {
	const collection = useMemo(
		() => projectRunsCollection(projectId),
		[projectId],
	);
	const { data: rows } = useLiveQuery(
		(q) => q.from({ run: collection }),
		[collection],
	);
	return useMemo(() => {
		if (!rootRunId) return [];
		return (rows ?? [])
			.filter((r) => r.rootRunId === rootRunId && r.id !== rootRunId)
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	}, [rows, rootRunId]);
}

/**
 * Live activity feed for a project agent: tails the durable stream of the
 * agent's active orchestrator run and renders the in-progress transcript
 * (text + tool calls), so it's visible what the agent is working on.
 *
 * Run selection follows the roster row:
 * - `activeRunId` set → tail that run. The id is latched so the transcript
 *   stays on screen after the run finishes (the roster clears activeRunId
 *   on terminal status) until a new run replaces it.
 * - no run watched yet → idle placeholder with the last result summary.
 *
 * The run's stream spans all orchestrator segments (it closes only at
 * terminal status), so `offset: -1` replays everything so far and
 * `isStreaming` flips off between segments — rendered as "waiting on
 * sub-agents" while the roster still reports the agent as working.
 */
export function AgentActivity({
	projectId,
	agentId,
	row,
}: {
	projectId: string;
	agentId: string;
	row: ProjectAgentRow | null;
}) {
	// Latch the run id: keep showing the finished run's transcript until a new
	// run starts (activeRunId is cleared on terminal status by the worker).
	const [watchedRunId, setWatchedRunId] = useState<string | null>(null);
	const activeRunId = row?.activeRunId ?? null;
	useEffect(() => {
		if (activeRunId && activeRunId !== watchedRunId) {
			setWatchedRunId(activeRunId);
		}
	}, [activeRunId, watchedRunId]);

	const runs = useAgentRootRuns(projectId, agentId);

	// A picked run overrides the live latch; null follows the latest activity.
	// Finished runs replay fine: streams are EOF-closed at terminal status but
	// kept, and useTaskStream tails from offset -1 (the start of the run).
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const viewedRunId = selectedRunId ?? watchedRunId;

	const live = useTaskStream(viewedRunId, { projectId });
	const childRuns = useChildRuns(projectId, viewedRunId);

	const working = row?.state === "working";
	const lastResult = row ? parseLastResult(row.lastResult) : null;

	// Viewing history = an explicit pick that isn't the run the live view is
	// already on; the status line then reflects that run, not the roster.
	const viewingPast = selectedRunId !== null && selectedRunId !== watchedRunId;
	const viewedRun = viewingPast
		? (runs.find((r) => r.id === selectedRunId) ?? null)
		: null;

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<StatusLine
				working={!viewingPast && working}
				blocked={!viewingPast && row?.state === "blocked"}
				isStreaming={live.isStreaming}
				hasTranscript={live.assistant !== null}
				lastResultStatus={
					viewingPast
						? terminalStatus(viewedRun?.status)
						: (lastResult?.status ?? null)
				}
				picker={
					runs.length > 0 ? (
						<RunPicker
							runs={runs}
							activeRunId={activeRunId}
							value={selectedRunId}
							onChange={setSelectedRunId}
						/>
					) : null
				}
			/>
			{live.assistant ? (
				<Transcript
					parts={live.assistant.parts}
					isStreaming={live.isStreaming}
				/>
			) : viewingPast ? (
				<NoTranscript />
			) : (
				<IdleSummary working={working} summary={lastResult?.summary ?? null} />
			)}
			<SubAgentsSection projectId={projectId} runs={childRuns} />
		</div>
	);
}

/** Map a run row's status onto the tool-chip status icon vocabulary. */
function childStepStatus(status: ProjectRunRow["status"]): StepStatus {
	switch (status) {
		case "succeeded":
			return "completed";
		case "failed":
		case "cancelled":
			return "error";
		default:
			return "running";
	}
}

/**
 * The sub-agents spawned by the viewed orchestrator run: one row per child
 * (plan-task title, agent type, live status), expandable to that child's own
 * transcript — the same live stream / replay mechanics as the orchestrator's.
 */
function SubAgentsSection({
	projectId,
	runs,
}: {
	projectId: string;
	runs: ProjectRunRow[];
}) {
	const t = useTranslations("Projects");
	// One child expanded at a time keeps the panel readable and holds at most
	// one extra stream subscription open.
	const [expandedId, setExpandedId] = useState<string | null>(null);

	if (runs.length === 0) return null;

	return (
		<div className="flex max-h-[45%] shrink-0 flex-col border-t">
			<p className="shrink-0 px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
				{t("agent.activity.subagents.title")} · {runs.length}
			</p>
			<div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{runs.map((run) => (
					<SubAgentRow
						key={run.id}
						projectId={projectId}
						run={run}
						expanded={expandedId === run.id}
						onToggle={() =>
							setExpandedId((current) => (current === run.id ? null : run.id))
						}
					/>
				))}
			</div>
		</div>
	);
}

function SubAgentRow({
	projectId,
	run,
	expanded,
	onToggle,
}: {
	projectId: string;
	run: ProjectRunRow;
	expanded: boolean;
	onToggle: () => void;
}) {
	const status = childStepStatus(run.status);
	const StatusIcon = statusIcon(status);
	const title = runTitle(run) ?? run.agentType;

	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
			>
				<ChevronRight
					className={cn(
						"size-3 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate text-xs text-foreground">
					{title}
				</span>
				<span className="shrink-0 text-[10px] text-muted-foreground">
					{run.agentType}
				</span>
				{status === "running" ? (
					<Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
				) : (
					<StatusIcon
						className={cn("size-3 shrink-0", statusIconClass(status))}
					/>
				)}
			</button>
			{expanded ? (
				<ChildTranscript projectId={projectId} runId={run.id} />
			) : null}
		</div>
	);
}

/**
 * A child run's transcript, mounted only while its row is expanded. Live runs
 * tail; finished runs replay from the start (streams are EOF-closed but kept).
 */
function ChildTranscript({
	projectId,
	runId,
}: {
	projectId: string;
	runId: string;
}) {
	const t = useTranslations("Projects");
	const live = useTaskStream(runId, { projectId });

	if (!live.assistant) {
		return (
			<p className="px-7 py-2 text-xs text-muted-foreground">
				{t("agent.activity.noTranscript")}
			</p>
		);
	}

	return (
		<div className="mb-1 ml-6 flex h-72 flex-col overflow-hidden rounded-md border">
			<Transcript parts={live.assistant.parts} isStreaming={live.isStreaming} />
		</div>
	);
}

type TerminalStatus = "succeeded" | "failed" | "cancelled";

function terminalStatus(status: string | undefined): TerminalStatus | null {
	return status === "succeeded" || status === "failed" || status === "cancelled"
		? status
		: null;
}

function RunPicker({
	runs,
	activeRunId,
	value,
	onChange,
}: {
	runs: ProjectRunRow[];
	activeRunId: string | null;
	value: string | null;
	onChange: (runId: string | null) => void;
}) {
	const t = useTranslations("Projects");
	const formatter = useMemo(
		() =>
			new Intl.DateTimeFormat(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}),
		[],
	);

	const statusLabel = (run: ProjectRunRow) => {
		if (run.id === activeRunId) return t("agent.activity.streaming");
		const terminal = terminalStatus(run.status);
		return terminal ? t(`agent.lastResult.${terminal}`) : null;
	};

	return (
		<Select
			value={value ?? "latest"}
			onValueChange={(next) => onChange(next === "latest" ? null : next)}
		>
			<SelectTrigger
				size="sm"
				className="ml-auto h-6 gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent [&_svg]:size-3"
				aria-label={t("agent.activity.runs.label")}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="end">
				<SelectItem value="latest">
					{t("agent.activity.runs.latest")}
				</SelectItem>
				{runs.map((run) => {
					const status = statusLabel(run);
					return (
						<SelectItem key={run.id} value={run.id}>
							{formatter.format(run.startedAt ?? run.createdAt)}
							{status ? ` · ${status}` : ""}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}

/** Placeholder while a picked run's replay connects (or if it's gone). */
function NoTranscript() {
	const t = useTranslations("Projects");
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-5">
			<p className="max-w-md text-center text-sm text-muted-foreground">
				{t("agent.activity.noTranscript")}
			</p>
		</div>
	);
}

function StatusLine({
	working,
	blocked,
	isStreaming,
	hasTranscript,
	lastResultStatus,
	picker,
}: {
	working: boolean;
	blocked: boolean;
	isStreaming: boolean;
	hasTranscript: boolean;
	lastResultStatus: TerminalStatus | null;
	picker?: ReactNode;
}) {
	const t = useTranslations("Projects");

	let label: string;
	if (working) {
		// Between orchestrator segments the stream is quiet while children run.
		label = isStreaming
			? t("agent.activity.streaming")
			: t("agent.activity.waitingOnSubagents");
	} else if (blocked) {
		label = t("agent.activity.blocked");
	} else if (hasTranscript && lastResultStatus) {
		label = t(`agent.lastResult.${lastResultStatus}`);
	} else {
		label = t("agent.noCurrent");
	}

	return (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
			<p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
				{t("agent.activity.title")}
			</p>
			<span className="h-3 w-px bg-border" aria-hidden />
			<span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
				{working ? <Loader2 className="size-3 animate-spin" /> : null}
				{label}
			</span>
			{picker}
		</div>
	);
}

function IdleSummary({
	working,
	summary,
}: {
	working: boolean;
	summary: string | null;
}) {
	const t = useTranslations("Projects");

	// A finished run's summary is markdown (it's the agent's final message),
	// so render it like transcript content rather than as a raw string.
	if (!working && summary) {
		return (
			<div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-2xl px-4 py-5">
					<AgentMarkdown>{summary}</AgentMarkdown>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-5">
			<p className="max-w-md text-center text-sm text-muted-foreground">
				{working ? t("agent.activity.starting") : t("agent.activity.empty")}
			</p>
		</div>
	);
}

function Transcript({
	parts,
	isStreaming,
}: {
	parts: AssistantPart[];
	isStreaming: boolean;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);

	// Follow the stream: keep the newest content in view as tokens arrive,
	// but only when the user is already near the bottom, so scrolling up to
	// read earlier output isn't fought by the auto-scroll.
	const size = parts.reduce(
		(n, part) => n + (part.type === "text" ? part.text.length : 1),
		0,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [size]);

	return (
		<div
			ref={scrollRef}
			className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto"
		>
			<div className="mx-auto max-w-2xl px-4 py-5">
				{parts.map((part, index) => {
					if (part.type === "text") {
						return (
							<AgentMarkdown
								// biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only
								key={index}
								isAnimating={isStreaming && part.streaming === true}
							>
								{part.text}
							</AgentMarkdown>
						);
					}
					if (part.type !== "tool") return null;
					const icon = getToolIcon(part.toolName);
					const status = statusIcon(part.status);
					return (
						<div key={part.stepId} className="my-3 flex items-center gap-1.5">
							<div className="flex w-fit max-w-[420px] items-center gap-1.5 rounded-md border border-input bg-muted px-2 py-1 text-muted-foreground">
								{createElement(icon, { className: "size-3.5 shrink-0" })}
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
					);
				})}
			</div>
		</div>
	);
}
