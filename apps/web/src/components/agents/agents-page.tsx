"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGrid, List, Plus, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc/client";

import { AgentCard } from "./agent-card";
import { AgentTable } from "./agent-table";
import { NewAgentDialog } from "./new-agent-dialog";
import type { Agent } from "./types";

type ViewMode = "grid" | "table";
type PageSize = 10 | 20 | 50;

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
	const t = useTranslations("Agents");

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium text-foreground">{t("noAgents")}</p>
				<p className="max-w-sm text-xs text-muted-foreground">
					{t("noAgentsDescription")}
				</p>
			</div>
			<Button className="mt-4" onClick={onCreateClick}>
				<Plus className="h-4 w-4" />
				{t("createAgent")}
			</Button>
		</div>
	);
}

function NoSearchResults() {
	const t = useTranslations("Agents");

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<Search className="mb-2 h-8 w-8 text-muted-foreground" />
			<p className="text-sm font-medium text-foreground">{t("noResults")}</p>
			<p className="text-xs text-muted-foreground">{t("noResultsHint")}</p>
		</div>
	);
}

function ViewModeToggle({
	viewMode,
	setViewMode,
}: {
	viewMode: ViewMode;
	setViewMode: (mode: ViewMode) => void;
}) {
	return (
		<div className="inline-flex h-8 items-center rounded-md border bg-muted p-0.5">
			<button
				type="button"
				onClick={() => setViewMode("grid")}
				className={cn(
					"inline-flex h-full items-center rounded-sm px-1.5 transition-colors",
					viewMode === "grid"
						? "bg-background text-foreground shadow-sm"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				<LayoutGrid className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={() => setViewMode("table")}
				className={cn(
					"inline-flex h-full items-center rounded-sm px-1.5 transition-colors",
					viewMode === "table"
						? "bg-background text-foreground shadow-sm"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				<List className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

export function AgentsPage() {
	const t = useTranslations("Agents");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [viewMode, setViewMode] = React.useState<ViewMode>("grid");
	const [isNewAgentDialogOpen, setIsNewAgentDialogOpen] = React.useState(false);
	const [isPaginationPending, startTransition] = React.useTransition();
	const [page, setPage] = React.useState(1);
	const [pageSize, setPageSize] = React.useState<PageSize>(20);

	const queryOptions = orpc.agents.list.queryOptions({
		input: { page, pageSize },
	});

	const { data, refetch, isRefetching, isLoading } = useQuery(queryOptions);

	const invalidateList = () => {
		queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
	};

	const handleAgentCreated = (agentId: string) => {
		invalidateList();
		setIsNewAgentDialogOpen(false);
		navigate({ to: "/agents/$id", params: { id: agentId } });
	};

	const handleRefresh = () => {
		refetch().then(() => {
			toast.success(t("refreshed"));
		});
	};

	const handlePageChange = (newPage: number) => {
		startTransition(() => {
			setPage(newPage);
		});
	};

	const handlePageSizeChange = (newPageSize: number) => {
		startTransition(() => {
			setPageSize(newPageSize as PageSize);
			setPage(1);
		});
	};

	const agents = (data?.agents ?? []) as Agent[];
	const pagination = data?.pagination;

	const filteredAgents = searchQuery
		? agents.filter(
				(agent) =>
					agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
					agent.description.toLowerCase().includes(searchQuery.toLowerCase()),
			)
		: agents;

	return (
		<>
			<div className="flex h-full flex-col overflow-hidden p-2">
				<div className="flex h-full w-full flex-col overflow-hidden">
					<header className="flex shrink-0 items-start justify-between pb-3">
						<div className="flex items-start gap-2">
							<SidebarTrigger className="mt-1 -ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
							<div>
								<h1 className="text-lg font-semibold tracking-tight text-foreground">
									{t("title")}
								</h1>
								<p className="mt-0.5 text-xs text-muted-foreground">
									{t("tagline")}
								</p>
							</div>
						</div>
						<Button onClick={() => setIsNewAgentDialogOpen(true)}>
							<Plus className="h-4 w-4" />
							{t("createAgent")}
						</Button>
					</header>

					<div className="flex shrink-0 items-center gap-2 pb-4">
						<div className="relative flex-1">
							<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								placeholder={t("searchPlaceholder")}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="h-8 pl-8 text-xs"
							/>
						</div>
						<ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
						<Button
							size="icon-lg"
							variant="outline"
							onClick={handleRefresh}
							disabled={isRefetching}
						>
							<RefreshCw
								className={cn("h-3.5 w-3.5", isRefetching && "animate-spin")}
							/>
						</Button>
					</div>

					<div
						className={cn(
							"min-h-0 flex-1 overflow-y-auto transition-opacity",
							isPaginationPending && "pointer-events-none opacity-60",
						)}
					>
						{isLoading ? (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{Array.from({ length: 6 }).map((_, i) => (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
										key={i}
										className="rounded-lg bg-card p-3 ring-1 ring-foreground/10"
									>
										<Skeleton className="mb-2 h-4 w-24" />
										<Skeleton className="h-3 w-full" />
										<Skeleton className="mt-1 h-3 w-2/3" />
										<Skeleton className="mt-3 h-2.5 w-20" />
									</div>
								))}
							</div>
						) : agents.length === 0 ? (
							<EmptyState onCreateClick={() => setIsNewAgentDialogOpen(true)} />
						) : filteredAgents.length === 0 ? (
							<NoSearchResults />
						) : viewMode === "table" ? (
							<AgentTable
								agents={filteredAgents}
								pagination={searchQuery ? undefined : pagination}
								onPageChange={handlePageChange}
								onPageSizeChange={handlePageSizeChange}
								onDeleted={invalidateList}
								onDuplicated={invalidateList}
							/>
						) : (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{filteredAgents.map((agent) => (
									<AgentCard
										key={agent.id}
										agent={agent}
										onDeleted={invalidateList}
										onDuplicated={invalidateList}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			</div>

			<NewAgentDialog
				open={isNewAgentDialogOpen}
				onOpenChange={setIsNewAgentDialogOpen}
				onCreated={handleAgentCreated}
			/>
		</>
	);
}
