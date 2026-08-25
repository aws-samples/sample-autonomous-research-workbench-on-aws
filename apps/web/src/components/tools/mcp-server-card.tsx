"use client";

import {
	ChevronDown,
	MoreHorizontal,
	RefreshCw,
	Settings2,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
	AUTH_LABELS,
	type McpServer,
	type McpServerStatus,
	TRANSPORT_LABELS,
} from "./mock-data";

const STATUS_STYLES: Record<McpServerStatus, string> = {
	connected: "bg-emerald-500",
	disabled: "bg-muted-foreground/40",
	error: "bg-destructive",
};

interface McpServerCardProps {
	server: McpServer;
	onToggle: (id: string, enabled: boolean) => void;
	onSync: (server: McpServer) => void;
	onRemove: (server: McpServer) => void;
}

export function McpServerCard({
	server,
	onToggle,
	onSync,
	onRemove,
}: McpServerCardProps) {
	const t = useTranslations("Tools");
	const [isOpen, setIsOpen] = React.useState(false);

	const isEnabled = server.status !== "disabled";

	return (
		<Collapsible
			open={isOpen}
			onOpenChange={setIsOpen}
			className="rounded-xl bg-card ring-1 ring-foreground/10"
		>
			<div className="flex items-start gap-3 p-3">
				<span
					className={cn(
						"mt-1.5 size-2 shrink-0 rounded-full",
						STATUS_STYLES[server.status],
					)}
					aria-hidden
				/>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<h3 className="truncate text-sm font-medium text-foreground">
							{server.name}
						</h3>
						<Badge variant="outline" className="text-[10px]">
							{TRANSPORT_LABELS[server.transport]}
						</Badge>
						{server.status === "error" ? (
							<Badge variant="destructive" className="gap-1 text-[10px]">
								<TriangleAlert />
								{t("status.error")}
							</Badge>
						) : null}
					</div>

					<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
						{server.description}
					</p>

					<p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/80">
						{server.endpoint}
					</p>

					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
						<CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground">
							{t("toolCount", { count: server.tools.length })}
							<ChevronDown
								className={cn(
									"size-3 transition-transform",
									isOpen && "rotate-180",
								)}
							/>
						</CollapsibleTrigger>
						<span>{t("agentCount", { count: server.agentCount })}</span>
						<span>{AUTH_LABELS[server.auth]}</span>
						<span>{t("syncedAgo", { time: server.lastSync })}</span>
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-1">
					<Switch
						checked={isEnabled}
						onCheckedChange={(checked) => onToggle(server.id, checked)}
						aria-label={t("enableServer")}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="icon-xs" variant="ghost">
								<MoreHorizontal className="h-3.5 w-3.5" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => onSync(server)}>
								<RefreshCw className="h-3.5 w-3.5 opacity-70" />
								{t("actions.sync")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onSync(server)}>
								<Settings2 className="h-3.5 w-3.5 opacity-70" />
								{t("actions.configure")}
							</DropdownMenuItem>
							<DropdownMenuItem
								variant="destructive"
								onClick={() => onRemove(server)}
							>
								<Trash2 className="h-3.5 w-3.5 opacity-70" />
								{t("actions.remove")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<CollapsibleContent>
				<div className="space-y-1.5 border-t px-3 py-2.5">
					{server.tools.map((tool) => (
						<div key={tool.name} className="flex items-baseline gap-2">
							<span className="shrink-0 font-mono text-[11px] text-foreground">
								{tool.name}
							</span>
							<span className="truncate text-[11px] text-muted-foreground">
								{tool.description}
							</span>
						</div>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
