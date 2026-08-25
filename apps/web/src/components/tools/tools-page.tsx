"use client";

import { Construction, Plug, Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";

import { AddMcpServerDialog } from "./add-mcp-server-dialog";
import { McpServerCard } from "./mcp-server-card";
import { type McpServer, MOCK_SERVERS } from "./mock-data";

/**
 * Mock page: MCP servers live in local state only, so every action here is a
 * no-op against the backend. It exists to show that any MCP server can be
 * registered with the platform and exposed to agents.
 */
export function ToolsPage() {
	const t = useTranslations("Tools");
	const [servers, setServers] = React.useState<McpServer[]>(MOCK_SERVERS);
	const [searchQuery, setSearchQuery] = React.useState("");
	const [isAddDialogOpen, setIsAddDialogOpen] = React.useState(false);

	const filteredServers = React.useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return servers;
		return servers.filter(
			(server) =>
				server.name.toLowerCase().includes(query) ||
				server.description.toLowerCase().includes(query) ||
				server.tools.some((tool) => tool.name.toLowerCase().includes(query)),
		);
	}, [servers, searchQuery]);

	const connectedCount = servers.filter(
		(server) => server.status === "connected",
	).length;
	const toolCount = servers.reduce(
		(total, server) =>
			server.status === "disabled" ? total : total + server.tools.length,
		0,
	);

	const handleToggle = (id: string, enabled: boolean) => {
		setServers((prev) =>
			prev.map((server) =>
				server.id === id
					? { ...server, status: enabled ? "connected" : "disabled" }
					: server,
			),
		);
		toast.success(enabled ? t("toast.enabled") : t("toast.disabled"));
	};

	const handleSync = (server: McpServer) => {
		setServers((prev) =>
			prev.map((entry) =>
				entry.id === server.id
					? { ...entry, status: "connected", lastSync: t("justNow") }
					: entry,
			),
		);
		toast.success(t("toast.synced", { name: server.name }));
	};

	const handleRemove = (server: McpServer) => {
		setServers((prev) => prev.filter((entry) => entry.id !== server.id));
		toast.success(t("toast.removed", { name: server.name }));
	};

	const handleAdd = (server: McpServer) => {
		setServers((prev) => [
			server,
			...prev.filter((entry) => entry.id !== server.id),
		]);
		toast.success(t("toast.added", { name: server.name }));
	};

	return (
		<>
			<div className="flex h-full flex-col overflow-hidden p-2">
				<div className="flex h-full w-full flex-col overflow-hidden">
					<header className="flex shrink-0 items-start justify-between pb-3">
						<div className="flex items-start gap-2">
							<SidebarTrigger className="mt-1 -ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
							<div>
								<div className="flex items-center gap-2">
									<h1 className="text-lg font-semibold tracking-tight text-foreground">
										{t("title")}
									</h1>
									<Badge variant="outline" className="shrink-0">
										{t("preview.badge")}
									</Badge>
								</div>
								<p className="mt-0.5 text-xs text-muted-foreground">
									{t("tagline")}
								</p>
							</div>
						</div>
						<Button onClick={() => setIsAddDialogOpen(true)}>
							<Plus className="h-4 w-4" />
							{t("addServer")}
						</Button>
					</header>

					<Alert className="mb-3 shrink-0">
						<Construction />
						<AlertTitle>{t("preview.title")}</AlertTitle>
						<AlertDescription>{t("preview.description")}</AlertDescription>
					</Alert>

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
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
							{t("summary", {
								servers: connectedCount,
								tools: toolCount,
							})}
						</span>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto">
						{servers.length === 0 ? (
							<EmptyState onAddClick={() => setIsAddDialogOpen(true)} />
						) : filteredServers.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-16 text-center">
								<Search className="mb-2 h-8 w-8 text-muted-foreground" />
								<p className="text-sm font-medium text-foreground">
									{t("noResults")}
								</p>
								<p className="text-xs text-muted-foreground">
									{t("noResultsHint")}
								</p>
							</div>
						) : (
							<div className="space-y-2">
								{filteredServers.map((server) => (
									<McpServerCard
										key={server.id}
										server={server}
										onToggle={handleToggle}
										onSync={handleSync}
										onRemove={handleRemove}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			</div>

			<AddMcpServerDialog
				open={isAddDialogOpen}
				onOpenChange={setIsAddDialogOpen}
				onAdd={handleAdd}
				existingIds={servers.map((server) => server.id)}
			/>
		</>
	);
}

function EmptyState({ onAddClick }: { onAddClick: () => void }) {
	const t = useTranslations("Tools");

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<Plug className="mb-2 h-8 w-8 text-muted-foreground" />
			<p className="text-sm font-medium text-foreground">{t("noServers")}</p>
			<p className="max-w-sm text-xs text-muted-foreground">
				{t("noServersDescription")}
			</p>
			<Button className="mt-4" onClick={onAddClick}>
				<Plus className="h-4 w-4" />
				{t("addServer")}
			</Button>
		</div>
	);
}
