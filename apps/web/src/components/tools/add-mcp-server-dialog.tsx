"use client";

import { Check, Loader2, Plug, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
	AUTH_LABELS,
	type McpAuthMode,
	type McpServer,
	type McpTool,
	type McpTransport,
	MOCK_DISCOVERED_TOOLS,
	MOCK_REGISTRY,
	type RegistryEntry,
	TRANSPORT_LABELS,
} from "./mock-data";

const TRANSPORTS: McpTransport[] = ["http", "sse", "stdio"];
const AUTH_MODES: McpAuthMode[] = ["none", "bearer", "oauth"];

/** Fake handshake latency so the mock reads like a real connection attempt. */
const HANDSHAKE_MS = 900;

interface AddMcpServerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdd: (server: McpServer) => void;
	existingIds: string[];
}

export function AddMcpServerDialog({
	open,
	onOpenChange,
	onAdd,
	existingIds,
}: AddMcpServerDialogProps) {
	const t = useTranslations("Tools");
	const [tab, setTab] = React.useState("registry");

	// Registry tab
	const [registryQuery, setRegistryQuery] = React.useState("");
	const [selectedEntryId, setSelectedEntryId] = React.useState<string | null>(
		null,
	);

	// Custom tab
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [transport, setTransport] = React.useState<McpTransport>("http");
	const [endpoint, setEndpoint] = React.useState("");
	const [auth, setAuth] = React.useState<McpAuthMode>("none");
	const [token, setToken] = React.useState("");
	const [headers, setHeaders] = React.useState("");

	// Handshake result (shared by both tabs)
	const [isConnecting, setIsConnecting] = React.useState(false);
	const [discovered, setDiscovered] = React.useState<McpTool[] | null>(null);
	const [enabledToolNames, setEnabledToolNames] = React.useState<Set<string>>(
		new Set(),
	);

	const reset = React.useCallback(() => {
		setTab("registry");
		setRegistryQuery("");
		setSelectedEntryId(null);
		setName("");
		setDescription("");
		setTransport("http");
		setEndpoint("");
		setAuth("none");
		setToken("");
		setHeaders("");
		setIsConnecting(false);
		setDiscovered(null);
		setEnabledToolNames(new Set());
	}, []);

	React.useEffect(() => {
		if (!open) reset();
	}, [open, reset]);

	const entries = React.useMemo(() => {
		const taken = new Set(existingIds);
		const available = MOCK_REGISTRY.filter((entry) => !taken.has(entry.id));
		const query = registryQuery.trim().toLowerCase();
		if (!query) return available;
		return available.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query) ||
				entry.category.toLowerCase().includes(query),
		);
	}, [existingIds, registryQuery]);

	const selectedEntry: RegistryEntry | undefined = React.useMemo(
		() => MOCK_REGISTRY.find((entry) => entry.id === selectedEntryId),
		[selectedEntryId],
	);

	const isRegistryTab = tab === "registry";
	const canConnect = isRegistryTab
		? Boolean(selectedEntry)
		: name.trim().length > 0 && endpoint.trim().length > 0;

	const handleConnect = () => {
		if (!canConnect || isConnecting) return;
		setIsConnecting(true);
		setDiscovered(null);
		// Mock: pretend we ran an MCP initialize + tools/list round trip.
		window.setTimeout(() => {
			const tools = selectedEntry?.tools ?? MOCK_DISCOVERED_TOOLS;
			setDiscovered(tools);
			setEnabledToolNames(new Set(tools.map((tool) => tool.name)));
			setIsConnecting(false);
		}, HANDSHAKE_MS);
	};

	const handleToggleTool = (toolName: string) => {
		setEnabledToolNames((prev) => {
			const next = new Set(prev);
			if (next.has(toolName)) next.delete(toolName);
			else next.add(toolName);
			return next;
		});
	};

	const handleAdd = () => {
		if (!discovered || enabledToolNames.size === 0) return;
		const tools = discovered.filter((tool) => enabledToolNames.has(tool.name));

		onAdd(
			selectedEntry
				? {
						id: selectedEntry.id,
						name: selectedEntry.name,
						description: selectedEntry.description,
						transport: selectedEntry.transport,
						endpoint: selectedEntry.endpoint,
						auth: selectedEntry.auth,
						status: "connected",
						lastSync: t("justNow"),
						agentCount: 0,
						tools,
					}
				: {
						id: `custom-${name
							.trim()
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")}`,
						name: name.trim(),
						description: description.trim() || t("customServerFallbackDesc"),
						transport,
						endpoint: endpoint.trim(),
						auth,
						status: "connected",
						lastSync: t("justNow"),
						agentCount: 0,
						tools,
					},
		);
		onOpenChange(false);
	};

	// Switching tabs invalidates a handshake made against the other source.
	const handleTabChange = (next: string) => {
		setTab(next);
		setDiscovered(null);
		setEnabledToolNames(new Set());
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("addServer")}</DialogTitle>
					<DialogDescription>
						{t("addServerDescription")}{" "}
						<span className="font-medium text-foreground">
							{t("addServerPreviewNote")}
						</span>
					</DialogDescription>
				</DialogHeader>

				<Tabs
					value={tab}
					onValueChange={handleTabChange}
					className="flex min-h-0 flex-1 flex-col"
				>
					<TabsList>
						<TabsTrigger value="registry">{t("tabs.registry")}</TabsTrigger>
						<TabsTrigger value="custom">{t("tabs.custom")}</TabsTrigger>
					</TabsList>

					<TabsContent
						value="registry"
						className="min-h-0 flex-1 overflow-y-auto"
					>
						<div className="relative pb-3">
							<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								placeholder={t("registrySearchPlaceholder")}
								value={registryQuery}
								onChange={(e) => setRegistryQuery(e.target.value)}
								className="h-8 pl-8 text-xs"
							/>
						</div>

						{entries.length === 0 ? (
							<p className="py-8 text-center text-xs text-muted-foreground">
								{t("registryEmpty")}
							</p>
						) : (
							<div className="grid gap-2 sm:grid-cols-2">
								{entries.map((entry) => {
									const isSelected = entry.id === selectedEntryId;
									return (
										<button
											key={entry.id}
											type="button"
											onClick={() => {
												setSelectedEntryId(entry.id);
												setDiscovered(null);
												setEnabledToolNames(new Set());
											}}
											className={cn(
												"flex flex-col gap-1 rounded-lg p-3 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted/50",
												isSelected && "bg-muted/60 ring-primary/40",
											)}
										>
											<div className="flex items-center gap-1.5">
												<span className="text-xs font-medium text-foreground">
													{entry.name}
												</span>
												{isSelected ? (
													<Check className="h-3 w-3 text-primary" />
												) : null}
											</div>
											<p className="line-clamp-2 text-[11px] text-muted-foreground">
												{entry.description}
											</p>
											<div className="mt-1 flex items-center gap-1.5">
												<Badge variant="outline" className="text-[10px]">
													{entry.category}
												</Badge>
												<span className="text-[10px] text-muted-foreground">
													{t("toolCount", { count: entry.tools.length })}
												</span>
											</div>
										</button>
									);
								})}
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="custom"
						className="min-h-0 flex-1 overflow-y-auto"
					>
						<div className="grid gap-4 pb-1">
							<div className="grid gap-4 sm:grid-cols-2">
								<Field>
									<FieldLabel>{t("form.name")}</FieldLabel>
									<Input
										value={name}
										onChange={(e) => setName(e.target.value)}
										placeholder={t("form.namePlaceholder")}
									/>
								</Field>
								<Field>
									<FieldLabel>{t("form.transport")}</FieldLabel>
									<Select
										value={transport}
										onValueChange={(value) =>
											setTransport(value as McpTransport)
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{TRANSPORTS.map((value) => (
												<SelectItem key={value} value={value}>
													{TRANSPORT_LABELS[value]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							</div>

							<Field>
								<FieldLabel>
									{transport === "stdio"
										? t("form.command")
										: t("form.endpoint")}
								</FieldLabel>
								<Input
									value={endpoint}
									onChange={(e) => setEndpoint(e.target.value)}
									placeholder={
										transport === "stdio"
											? t("form.commandPlaceholder")
											: t("form.endpointPlaceholder")
									}
									className="font-mono text-xs"
								/>
								<FieldDescription>
									{transport === "stdio"
										? t("form.commandHint")
										: t("form.endpointHint")}
								</FieldDescription>
							</Field>

							<div className="grid gap-4 sm:grid-cols-2">
								<Field>
									<FieldLabel>{t("form.auth")}</FieldLabel>
									<Select
										value={auth}
										onValueChange={(value) => setAuth(value as McpAuthMode)}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{AUTH_MODES.map((value) => (
												<SelectItem key={value} value={value}>
													{AUTH_LABELS[value]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
								{auth === "bearer" ? (
									<Field>
										<FieldLabel>{t("form.token")}</FieldLabel>
										<Input
											type="password"
											value={token}
											onChange={(e) => setToken(e.target.value)}
											placeholder={t("form.tokenPlaceholder")}
										/>
									</Field>
								) : null}
							</div>

							<Field>
								<FieldLabel>{t("form.description")}</FieldLabel>
								<Textarea
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									placeholder={t("form.descriptionPlaceholder")}
									rows={2}
								/>
							</Field>

							<Field>
								<FieldLabel>{t("form.headers")}</FieldLabel>
								<Textarea
									value={headers}
									onChange={(e) => setHeaders(e.target.value)}
									placeholder={t("form.headersPlaceholder")}
									rows={2}
									className="font-mono text-xs"
								/>
								<FieldDescription>{t("form.headersHint")}</FieldDescription>
							</Field>
						</div>
					</TabsContent>
				</Tabs>

				{discovered ? (
					<div className="shrink-0 rounded-lg bg-muted/40 p-3 ring-1 ring-foreground/10">
						<div className="mb-2 flex items-center gap-1.5">
							<Check className="h-3.5 w-3.5 text-primary" />
							<span className="text-xs font-medium text-foreground">
								{t("discoveredTitle", { count: discovered.length })}
							</span>
						</div>
						<div className="max-h-32 space-y-1.5 overflow-y-auto">
							{discovered.map((tool) => (
								<label
									key={tool.name}
									htmlFor={`discovered-${tool.name}`}
									className="flex cursor-pointer items-start gap-2 rounded-md p-1 hover:bg-muted/60"
								>
									<Checkbox
										id={`discovered-${tool.name}`}
										checked={enabledToolNames.has(tool.name)}
										onCheckedChange={() => handleToggleTool(tool.name)}
										className="mt-0.5"
									/>
									<span className="min-w-0">
										<span className="block font-mono text-[11px] text-foreground">
											{tool.name}
										</span>
										<span className="block text-[11px] text-muted-foreground">
											{tool.description}
										</span>
									</span>
								</label>
							))}
						</div>
					</div>
				) : null}

				<DialogFooter className="shrink-0 sm:justify-between">
					<Button
						variant="outline"
						onClick={handleConnect}
						disabled={!canConnect || isConnecting}
					>
						{isConnecting ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Plug className="h-3.5 w-3.5" />
						)}
						{isConnecting ? t("connecting") : t("testConnection")}
					</Button>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleAdd}
							disabled={!discovered || enabledToolNames.size === 0}
						>
							{t("addServerConfirm", { count: enabledToolNames.size })}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
