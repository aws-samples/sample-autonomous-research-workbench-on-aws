"use client";

import { Link } from "@tanstack/react-router";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import Avatar from "boring-avatars";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Copy,
	MoreHorizontal,
	Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { getAgentAvatarColors } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";

import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "./constants";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { DuplicateAgentDialog } from "./duplicate-agent-dialog";
import type { Agent } from "./types";

type PageSize = 10 | 20 | 50;

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
	if (isSorted === "asc") return <ArrowUp className="h-3 w-3" />;
	if (isSorted === "desc") return <ArrowDown className="h-3 w-3" />;
	return (
		<ArrowUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover/head:opacity-100" />
	);
}

function RowActions({
	agent,
	onDeleted,
	onDuplicated,
}: {
	agent: Agent;
	onDeleted?: () => void;
	onDuplicated?: () => void;
}) {
	const t = useTranslations("Agents");
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
	const [isDuplicateDialogOpen, setIsDuplicateDialogOpen] =
		React.useState(false);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon-xs"
						variant="ghost"
						className="opacity-0 transition-opacity group-hover:opacity-100"
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => setIsDuplicateDialogOpen(true)}>
						<Copy className="h-3.5 w-3.5 opacity-70" />
						{t("duplicate")}
					</DropdownMenuItem>
					<DropdownMenuItem
						variant="destructive"
						onClick={() => setIsDeleteDialogOpen(true)}
					>
						<Trash2 className="h-3.5 w-3.5 opacity-70" />
						{t("delete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<DuplicateAgentDialog
				open={isDuplicateDialogOpen}
				onOpenChange={setIsDuplicateDialogOpen}
				agentId={agent.id}
				agentName={agent.name}
				onDuplicated={onDuplicated}
			/>

			<DeleteAgentDialog
				open={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				agentId={agent.id}
				agentName={agent.name}
				onDeleted={onDeleted}
			/>
		</>
	);
}

function createColumns(
	t: (key: string) => string,
	onDeleted: () => void,
	onDuplicated: () => void,
): ColumnDef<Agent>[] {
	return [
		{
			accessorKey: "name",
			header: t("name"),
			cell: ({ row }) => {
				const agent = row.original;
				return (
					<Link
						to="/agents/$id"
						params={{ id: agent.id }}
						className="flex items-center gap-2.5"
					>
						<div className="h-6 w-6 shrink-0 rounded-full bg-muted p-0.5">
							<Avatar
								size={20}
								name={agent.name}
								variant="marble"
								colors={getAgentAvatarColors(agent)}
							/>
						</div>
						<span className="font-medium text-foreground">{agent.name}</span>
					</Link>
				);
			},
		},
		{
			accessorKey: "description",
			header: t("description"),
			cell: ({ getValue }) => (
				<span className="block max-w-[300px] truncate text-muted-foreground">
					{getValue<string>()}
				</span>
			),
		},
		{
			id: "model",
			accessorFn: (row) => {
				const modelId = row.preferredModel ?? DEFAULT_MODEL_ID;
				return AVAILABLE_MODELS.find((m) => m.id === modelId)?.name ?? "";
			},
			header: t("model"),
			cell: ({ row }) => {
				const modelId = row.original.preferredModel ?? DEFAULT_MODEL_ID;
				const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
				if (!model) return <span className="text-muted-foreground">—</span>;
				return <span className="text-muted-foreground">{model.name}</span>;
			},
		},
		{
			id: "tools",
			accessorFn: (row) => row.tools.length,
			header: t("tools"),
			cell: ({ getValue }) => (
				<span className="text-muted-foreground">{getValue<number>()}</span>
			),
		},
		{
			accessorKey: "updatedAt",
			header: t("updated"),
			cell: ({ getValue }) => (
				<span className="text-muted-foreground">
					{formatDistanceToNow(new Date(getValue<string>()), {
						addSuffix: true,
					})}
				</span>
			),
		},
		{
			id: "actions",
			enableSorting: false,
			cell: ({ row }) => (
				<RowActions
					agent={row.original}
					onDeleted={onDeleted}
					onDuplicated={onDuplicated}
				/>
			),
			meta: { className: "w-[50px]" },
		},
	];
}

interface AgentTableProps {
	agents: Agent[];
	pagination?: {
		page: number;
		pageSize: number;
		totalCount: number;
		totalPages: number;
	};
	onPageChange?: (page: number) => void;
	onPageSizeChange?: (pageSize: number) => void;
	onDeleted: () => void;
	onDuplicated: () => void;
}

export function AgentTable({
	agents,
	pagination,
	onPageChange,
	onPageSizeChange,
	onDeleted,
	onDuplicated,
}: AgentTableProps) {
	const t = useTranslations("Agents");
	const [sorting, setSorting] = React.useState<SortingState>([]);

	const columns = React.useMemo(
		() => createColumns(t, onDeleted, onDuplicated),
		[t, onDeleted, onDuplicated],
	);

	const table = useReactTable({
		data: agents,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getRowId: (row) => row.id,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	return (
		<div className="flex flex-col gap-0 overflow-hidden rounded-lg border">
			<Table>
				<TableHeader>
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id} className="hover:bg-transparent">
							{headerGroup.headers.map((header) => {
								const meta = header.column.columnDef.meta as
									| { className?: string }
									| undefined;
								return (
									<TableHead key={header.id} className={cn(meta?.className)}>
										{header.isPlaceholder ? null : header.column.getCanSort() ? (
											<button
												type="button"
												className="group/head inline-flex cursor-pointer items-center gap-1 select-none"
												onClick={header.column.getToggleSortingHandler()}
											>
												{flexRender(
													header.column.columnDef.header,
													header.getContext(),
												)}
												<SortIcon isSorted={header.column.getIsSorted()} />
											</button>
										) : (
											flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)
										)}
									</TableHead>
								);
							})}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{table.getRowModel().rows.map((row) => (
						<TableRow key={row.id} className="group">
							{row.getVisibleCells().map((cell) => (
								<TableCell key={cell.id}>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>

			{pagination && pagination.totalCount > 0 && (
				<div className="flex items-center justify-between border-t px-4 py-2">
					<div className="flex items-center gap-1.5">
						<span className="text-xs text-muted-foreground">
							{t("pagination.rows")}:
						</span>
						<Select
							value={String(pagination.pageSize)}
							onValueChange={(val) =>
								onPageSizeChange?.(Number(val) as PageSize)
							}
						>
							<SelectTrigger size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{([10, 20, 50] as PageSize[]).map((size) => (
									<SelectItem key={size} value={String(size)}>
										{size}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex items-center gap-1.5">
						<span className="text-xs text-muted-foreground tabular-nums">
							{(pagination.page - 1) * pagination.pageSize + 1}-
							{Math.min(
								pagination.page * pagination.pageSize,
								pagination.totalCount,
							)}{" "}
							{t("pagination.of")} {pagination.totalCount.toLocaleString()}
						</span>

						<div className="ml-2 flex items-center gap-0.5">
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() => onPageChange?.(1)}
								disabled={pagination.page <= 1}
							>
								<ChevronsLeft className="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() => onPageChange?.(Math.max(1, pagination.page - 1))}
								disabled={pagination.page <= 1}
							>
								<ChevronLeft className="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() =>
									onPageChange?.(
										Math.min(pagination.totalPages, pagination.page + 1),
									)
								}
								disabled={pagination.page >= pagination.totalPages}
							>
								<ChevronRight className="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() => onPageChange?.(pagination.totalPages)}
								disabled={pagination.page >= pagination.totalPages}
							>
								<ChevronsRight className="h-3.5 w-3.5" />
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
