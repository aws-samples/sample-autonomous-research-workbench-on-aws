"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ClusterGraph } from "@/components/graph/cluster-graph";
import { cn } from "@/lib/utils";

import { AgentRoster } from "./agent-roster";
import { ProjectFiles } from "./files/project-files";
import { ProjectMetrics } from "./project-metrics";
import { ProjectSettings } from "./project-settings";
import type { Project } from "./types";

type WorkspaceTab = "agents" | "files" | "graph" | "metrics" | "settings";

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-selected={active}
			role="tab"
			className={cn(
				"relative flex h-full items-center px-0.5 text-xs font-medium transition-colors",
				active
					? "text-foreground"
					: "text-muted-foreground hover:text-foreground",
				// Active underline sits on top of the header's bottom border.
				"after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity",
				active && "after:opacity-100",
			)}
		>
			{children}
		</button>
	);
}

export function ProjectWorkspace({
	project,
	budgetJumpSignal = 0,
}: {
	project: Project;
	budgetJumpSignal?: number;
}) {
	const t = useTranslations("Projects");
	const [tab, setTab] = useState<WorkspaceTab>("agents");
	// When true, Settings opens on the Budget section (set by the alert jump).
	const [openOnBudget, setOpenOnBudget] = useState(false);

	useEffect(() => {
		if (budgetJumpSignal > 0) {
			setOpenOnBudget(true);
			setTab("settings");
		}
	}, [budgetJumpSignal]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Fixed h-10 to match the Project Lead header exactly (both are
          40px tall including the bottom border). */}
			<div
				role="tablist"
				className="flex h-10 shrink-0 items-center gap-5 border-b px-5"
			>
				<TabButton active={tab === "agents"} onClick={() => setTab("agents")}>
					{t("workspace.agents")}
				</TabButton>
				<TabButton active={tab === "files"} onClick={() => setTab("files")}>
					{t("workspace.files")}
				</TabButton>
				<TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
					{t("workspace.projectGraph")}
				</TabButton>
				<TabButton active={tab === "metrics"} onClick={() => setTab("metrics")}>
					{t("workspace.metrics")}
				</TabButton>
				<TabButton
					active={tab === "settings"}
					onClick={() => {
						setOpenOnBudget(false);
						setTab("settings");
					}}
				>
					{t("workspace.settings")}
				</TabButton>
			</div>

			{/* Both panels stay mounted so the graph keeps its layout/zoom state
          when switching tabs; the inactive one is hidden. */}
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto px-5 py-4",
					tab !== "agents" && "hidden",
				)}
			>
				<AgentRoster
					projectId={project.id}
					agents={project.agents}
					live={project.live}
				/>
			</div>

			{/* Files stays mounted so folder navigation and the open file survive
          tab switches; the inactive panel is hidden. */}
			<div
				className={cn(
					"min-h-0 flex-1 flex-col overflow-hidden",
					tab === "files" ? "flex" : "hidden",
				)}
			>
				<ProjectFiles projectId={project.id} />
			</div>

			<div
				className={cn(
					"min-h-0 flex-1 flex-col p-3",
					tab === "graph" ? "flex" : "hidden",
				)}
			>
				<div className="min-h-0 flex-1 overflow-hidden">
					<ClusterGraph
						title={t("workspace.projectGraph")}
						projectId={project.id}
						padded={false}
					/>
				</div>
			</div>

			{/* Metrics remounts on each visit so its query refetches fresh data. */}
			{tab === "metrics" ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<ProjectMetrics project={project} />
				</div>
			) : null}

			{/* Settings remounts on each visit so its form state re-seeds from the
          freshest loader data (edits refresh the route via invalidate). */}
			{tab === "settings" ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					<ProjectSettings
						project={project}
						initialSection={openOnBudget ? "budget" : "general"}
					/>
				</div>
			) : null}
		</div>
	);
}
