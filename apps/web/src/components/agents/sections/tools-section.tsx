"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Plus, Search, Trash2, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { client, orpc } from "@/orpc/client";

import { AddToolsSheet } from "./sheets/add-tools-sheet";

interface ToolsSectionProps {
	agentId: string;
	tools: string[];
	readOnly?: boolean;
}

export function ToolsSection({ agentId, tools, readOnly }: ToolsSectionProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [addSheetOpen, setAddSheetOpen] = React.useState(false);

	const { data: catalogData, isPending: isCatalogPending } = useQuery(
		orpc.agents.toolCatalog.queryOptions({ input: {} }),
	);

	const removeToolMutation = useMutation({
		mutationFn: async (toolId: string) => {
			return client.agents.update({
				id: agentId,
				tools: tools.filter((id) => id !== toolId),
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.toolRemoveSuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const enabledEntries = React.useMemo(() => {
		const catalog = catalogData?.tools ?? [];
		const enabled = new Set(tools);
		const entries = catalog.filter((entry) => enabled.has(entry.id));
		if (!searchQuery.trim()) return entries;

		const query = searchQuery.toLowerCase();
		return entries.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query),
		);
	}, [catalogData?.tools, tools, searchQuery]);

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.toolsSection.title")}</CardTitle>
				<CardDescription>
					{t("settings.toolsSection.description")}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center gap-3">
					<div className="relative flex-1">
						<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder={t("settings.toolsSection.searchPlaceholder")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="w-full pl-8"
						/>
					</div>

					{!readOnly && (
						<Button onClick={() => setAddSheetOpen(true)} className="gap-1.5">
							<Plus className="size-3.5" />
							{t("settings.toolsSection.addTool")}
						</Button>
					)}
				</div>

				<div className="overflow-hidden rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow className="bg-muted/50">
								<TableHead>{t("settings.toolsSection.table.name")}</TableHead>
								<TableHead>
									{t("settings.toolsSection.table.description")}
								</TableHead>
								<TableHead className="text-right">
									{t("settings.toolsSection.table.toolCount")}
								</TableHead>
								{!readOnly && <TableHead className="w-[50px]" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{isCatalogPending ? (
								Array.from({ length: 3 }).map((_, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
									<TableRow key={i} className="hover:bg-transparent">
										<TableCell>
											<div className="flex items-center gap-3">
												<Skeleton className="h-7 w-7 rounded-full" />
												<Skeleton className="h-3.5 w-24" />
											</div>
										</TableCell>
										<TableCell>
											<Skeleton className="h-3.5 w-40" />
										</TableCell>
										<TableCell>
											<div className="flex justify-end">
												<Skeleton className="h-3.5 w-6" />
											</div>
										</TableCell>
										{!readOnly && (
											<TableCell>
												<div className="flex justify-end">
													<Skeleton className="h-6 w-6 rounded-md" />
												</div>
											</TableCell>
										)}
									</TableRow>
								))
							) : enabledEntries.length > 0 ? (
								enabledEntries.map((entry) => (
									<TableRow key={entry.id}>
										<TableCell>
											<div className="flex items-center gap-3">
												<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
													<Wrench className="h-3.5 w-3.5 text-muted-foreground" />
												</div>
												<span className="font-medium text-foreground">
													{entry.name}
												</span>
												<Badge
													variant="secondary"
													className="h-4 px-1.5 text-[9px]"
												>
													{t("settings.toolsSection.core")}
												</Badge>
											</div>
										</TableCell>
										<TableCell>
											<span className="block max-w-[320px] truncate text-muted-foreground">
												{entry.description}
											</span>
										</TableCell>
										<TableCell>
											<div className="text-right font-medium tabular-nums">
												{entry.tools.length}
											</div>
										</TableCell>
										{!readOnly && (
											<TableCell>
												<div className="flex justify-end">
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button variant="ghost" size="icon-sm">
																<MoreVertical className="h-4 w-4" />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																variant="destructive"
																onClick={() =>
																	removeToolMutation.mutate(entry.id)
																}
															>
																<Trash2 className="size-3.5" />
																{t("settings.toolsSection.removeTool")}
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</div>
											</TableCell>
										)}
									</TableRow>
								))
							) : (
								<TableRow className="hover:bg-transparent">
									<TableCell
										colSpan={readOnly ? 3 : 4}
										className="py-16 text-center"
									>
										<div className="flex flex-col items-center justify-center gap-1">
											<Wrench className="mb-1 h-8 w-8 text-muted-foreground/50" />
											<p className="text-xs text-muted-foreground">
												{t("settings.toolsSection.emptyState")}
											</p>
										</div>
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
			</CardContent>

			<AddToolsSheet
				agentId={agentId}
				currentTools={tools}
				open={addSheetOpen}
				onOpenChange={setAddSheetOpen}
			/>
		</Card>
	);
}
