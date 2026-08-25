"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { client, orpc } from "@/orpc/client";

interface AddToolsSheetProps {
	agentId: string;
	currentTools: string[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AddToolsSheet({
	agentId,
	currentTools,
	open,
	onOpenChange,
}: AddToolsSheetProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [selectedToolIds, setSelectedToolIds] = React.useState<Set<string>>(
		new Set(),
	);

	const { data, isPending } = useQuery({
		...orpc.agents.toolCatalog.queryOptions({ input: {} }),
		enabled: open,
	});

	const updateToolsMutation = useMutation({
		mutationFn: async (newTools: string[]) => {
			const mergedTools = [...new Set([...currentTools, ...newTools])];
			return client.agents.update({ id: agentId, tools: mergedTools });
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.toolAddSuccess"));
			onOpenChange(false);
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const availableEntries = React.useMemo(() => {
		const catalog = data?.tools ?? [];
		const enabled = new Set(currentTools);
		const entries = catalog.filter((entry) => !enabled.has(entry.id));
		if (!searchQuery.trim()) return entries;

		const query = searchQuery.toLowerCase();
		return entries.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query),
		);
	}, [data?.tools, currentTools, searchQuery]);

	const handleToolToggle = (toolId: string) => {
		setSelectedToolIds((prev) => {
			const next = new Set(prev);
			if (next.has(toolId)) {
				next.delete(toolId);
			} else {
				next.add(toolId);
			}
			return next;
		});
	};

	React.useEffect(() => {
		if (!open) {
			setSelectedToolIds(new Set());
			setSearchQuery("");
		}
	}, [open]);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-lg">
				<SheetHeader className="border-b px-3 py-3">
					<SheetTitle>{t("settings.toolsSection.addTool")}</SheetTitle>
					<SheetDescription>
						{t("settings.toolsSection.description")}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-1 flex-col overflow-hidden px-2">
					<div className="relative py-4">
						<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder={t("settings.toolsSection.searchPlaceholder")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-8 pl-8 text-xs"
						/>
					</div>
					<FieldGroup className="flex-1 gap-2 overflow-y-auto">
						{isPending ? (
							<div className="flex flex-col gap-4">
								{Array.from({ length: 3 }).map((_, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
									<div key={i} className="flex flex-col gap-2">
										<Skeleton className="h-4 w-32" />
										<Skeleton className="h-3 w-full" />
									</div>
								))}
							</div>
						) : availableEntries.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-8 text-center">
								<Search className="mb-2 h-6 w-6 text-muted-foreground" />
								<p className="text-xs text-muted-foreground">
									{t("settings.toolsSection.noToolsFound")}
								</p>
							</div>
						) : (
							availableEntries.map((entry) => (
								<FieldLabel key={entry.id} htmlFor={`tool-${entry.id}`}>
									<Field
										orientation="horizontal"
										className="cursor-pointer p-3 transition-colors hover:bg-muted/50"
									>
										<Checkbox
											id={`tool-${entry.id}`}
											checked={selectedToolIds.has(entry.id)}
											onCheckedChange={() => handleToolToggle(entry.id)}
										/>
										<FieldContent>
											<FieldTitle>{entry.name}</FieldTitle>
											<FieldDescription className="line-clamp-2">
												{entry.description}
											</FieldDescription>
											<p className="mt-1 text-[10px] text-muted-foreground">
												{t("settings.toolsSection.toolCount", {
													count: entry.tools.length,
												})}
											</p>
										</FieldContent>
									</Field>
								</FieldLabel>
							))
						)}
					</FieldGroup>
				</div>
				<div className="flex items-center justify-end gap-2 border-t px-4 py-3">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={updateToolsMutation.isPending}
					>
						{t("common.cancel")}
					</Button>
					<Button
						onClick={() =>
							updateToolsMutation.mutate(Array.from(selectedToolIds))
						}
						disabled={
							selectedToolIds.size === 0 || updateToolsMutation.isPending
						}
					>
						{updateToolsMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							t("settings.toolsSection.addToolsCount", {
								count: selectedToolIds.size,
							})
						)}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}
