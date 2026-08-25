"use client";

import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import { AgentActivity, useProjectAgentRow } from "./agent-activity";
import { agentStateClass } from "./personas";
import type {
	AgentState,
	AgentWorkItem,
	Project,
	ProjectAgent,
	WorkItemState,
} from "./types";

const SECTION_ORDER: WorkItemState[] = ["active", "current", "pending"];

/** Defer Electric subscriptions until after hydration (client-only sync). */
function useIsHydrated() {
	return useSyncExternalStore(
		() => () => {},
		() => true,
		() => false,
	);
}

export function AgentDetail({
	project,
	agent,
}: {
	project: Project;
	agent: ProjectAgent;
}) {
	const hydrated = useIsHydrated();

	// DB-backed agents get the live view (Electric roster row + run stream);
	// static sample projects keep the sample work-item sections.
	if (project.live && agent.agentId && hydrated) {
		return (
			<LiveAgentDetail
				project={project}
				agent={agent}
				agentId={agent.agentId}
			/>
		);
	}

	return (
		<AgentDetailShell project={project} agent={agent} state={agent.state}>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
					<StaticWorkItems agent={agent} />
				</div>
			</div>
		</AgentDetailShell>
	);
}

function LiveAgentDetail({
	project,
	agent,
	agentId,
}: {
	project: Project;
	agent: ProjectAgent;
	agentId: string;
}) {
	const row = useProjectAgentRow(project.id, agentId);
	const state: AgentState = row
		? row.state === "working"
			? "active"
			: row.state
		: agent.state;

	return (
		<AgentDetailShell project={project} agent={agent} state={state}>
			<AgentActivity projectId={project.id} agentId={agentId} row={row} />
		</AgentDetailShell>
	);
}

function AgentDetailShell({
	project,
	agent,
	state,
	children,
}: {
	project: Project;
	agent: ProjectAgent;
	state: AgentState;
	children: React.ReactNode;
}) {
	const t = useTranslations("Projects");

	return (
		<div className="flex h-full flex-col overflow-hidden p-2">
			<div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
				<header className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
					<SidebarTrigger className="-ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
					<span className="h-4 w-px shrink-0 bg-border" aria-hidden />
					<Link
						to="/projects/$id"
						params={{ id: project.id }}
						className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						<ArrowLeft className="size-3.5" />
						{t("agent.back")}
					</Link>
					<span className="h-4 w-px shrink-0 bg-border" aria-hidden />
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/10">
						<Bot className="size-3.5 text-foreground/70" />
					</span>
					<h1 className="min-w-0 truncate text-sm font-medium text-foreground">
						{agent.displayName}
					</h1>
					<span className="inline-flex items-center gap-1.5">
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								agentStateClass(state),
								state === "active" && "animate-pulse",
							)}
							aria-hidden
						/>
						<span className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
							{t(`agentStates.${state}`)}
						</span>
					</span>
				</header>

				{children}
			</div>
		</div>
	);
}

/** Sample-project fallback: the original static work-item sections. */
function StaticWorkItems({ agent }: { agent: ProjectAgent }) {
	const t = useTranslations("Projects");

	return (
		<>
			<div>
				<p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
					{t("agent.currentlyWorking")}
				</p>
				<p className="mt-1 text-sm text-foreground">
					{agent.currentTask ?? t("agent.noCurrent")}
				</p>
			</div>

			{SECTION_ORDER.map((sectionState) => {
				const items = agent.workItems.filter(
					(item) => item.state === sectionState,
				);
				return (
					<Section
						key={sectionState}
						title={t(`agent.sections.${sectionState}`)}
						items={items}
						emptyLabel={t("agent.empty")}
					/>
				);
			})}
		</>
	);
}

function Section({
	title,
	items,
	emptyLabel,
}: {
	title: string;
	items: AgentWorkItem[];
	emptyLabel: string;
}) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
					{title}
				</h2>
				<span className="text-xs text-muted-foreground tabular-nums">
					{items.length}
				</span>
			</div>
			{items.length === 0 ? (
				<p className="text-xs text-muted-foreground">{emptyLabel}</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{items.map((item) => (
						<li key={item.id}>
							<div className="flex items-center gap-2 rounded-lg border bg-background/40 px-3 py-2">
								<span className="min-w-0 flex-1 truncate text-sm text-foreground">
									{item.title}
								</span>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
