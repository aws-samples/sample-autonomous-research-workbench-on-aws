"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import {
	ArrowLeft,
	ChevronRight,
	CloudUpload,
	Download,
	Loader2,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Menubar,
	MenubarCheckboxItem,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarShortcut,
	MenubarSub,
	MenubarSubContent,
	MenubarSubTrigger,
	MenubarTrigger,
} from "@/components/ui/menubar";
import {
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
	IconDocumentCode,
	IconDocumentPdf,
	IconFolder,
	IconPaper,
	IconPython,
} from "./file-icons";
import {
	createProjectFilesApi,
	type FileBrowserApi,
	type FileEntry,
	fileContentQueryKey,
	fileListQueryKey,
	filePresignQueryKey,
} from "./files-api";
import { getFileViewer, isBinaryFile } from "./file-viewers";
import { UploadDialog } from "./upload-dialog";

// =============================================================================
// Constants
// =============================================================================

const SHOW_HIDDEN_FILES_COOKIE = "project-files-show-hidden";

function getCookieBool(name: string, defaultValue = false): boolean {
	if (typeof document === "undefined") return defaultValue;
	const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
	return match ? match[1] === "true" : defaultValue;
}

function setCookieBool(name: string, value: boolean) {
	// biome-ignore lint/suspicious/noDocumentCookie: simple persisted view toggle, no cookie-store dependency needed
	document.cookie = `${name}=${value};path=/;max-age=31536000`;
}

// =============================================================================
// Helpers
// =============================================================================

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatModTime(modTime: string): string {
	if (!modTime) return "--";
	try {
		return new Date(modTime).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return modTime;
	}
}

/** Paths are relative to the project root; "" is the root itself. */
function pathToBreadcrumbs(
	currentPath: string,
	rootLabel: string,
): { name: string; path: string }[] {
	const crumbs: { name: string; path: string }[] = [
		{ name: rootLabel, path: "" },
	];
	const parts = currentPath.split("/").filter(Boolean);
	let accumulated = "";
	for (const part of parts) {
		accumulated = accumulated ? `${accumulated}/${part}` : part;
		crumbs.push({ name: part, path: accumulated });
	}
	return crumbs;
}

function joinPath(currentPath: string, segment: string): string {
	return currentPath ? `${currentPath}/${segment}` : segment;
}

// =============================================================================
// File icon config
// =============================================================================

type FileIconComponent = React.ComponentType<{
	size?: number;
	color?: string;
	className?: string;
}>;

/**
 * Maps file extensions to their corresponding icon components.
 * Add new entries here to support additional file type icons.
 */
const FILE_ICON_MAP: Record<string, FileIconComponent> = {
	".pdf": IconDocumentPdf,
	".py": IconPython,
	".ts": IconDocumentCode,
	".js": IconDocumentCode,
	".css": IconDocumentCode,
	".html": IconDocumentCode,
};

function getFileIcon(fileName: string): FileIconComponent {
	const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	return FILE_ICON_MAP[ext] ?? IconPaper;
}

const FILE_TYPE_MAP: Record<string, string> = {
	".pdf": "PDF Document",
	".py": "Python",
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".css": "CSS",
	".html": "HTML",
	".json": "JSON",
	".md": "Markdown",
	".txt": "Text",
	".yml": "YAML",
	".yaml": "YAML",
	".xml": "XML",
	".sh": "Shell Script",
	".png": "Image",
	".jpg": "Image",
	".jpeg": "Image",
	".gif": "Image",
	".svg": "SVG",
	".zip": "Archive",
	".tar": "Archive",
	".gz": "Archive",
};

function getFileType(file: FileEntry, t: (key: string) => string): string {
	if (file.isDir) return t("types.folder");
	const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
	return (
		FILE_TYPE_MAP[ext] ??
		(ext !== file.name ? ext.replace(".", "").toUpperCase() : t("types.file"))
	);
}

// =============================================================================
// Column definitions
// =============================================================================

const COL_SIZES = {
	type: 120,
	size: 96,
	modTime: 160,
} as const;

function getColumns(t: (key: string) => string): ColumnDef<FileEntry>[] {
	return [
		{
			accessorKey: "name",
			header: t("columns.name"),
			cell: ({ row }) => {
				const file = row.original;
				const FileIcon = file.isDir ? null : getFileIcon(file.name);
				return (
					<div className="flex items-center gap-2">
						{file.isDir ? (
							<IconFolder size={16} color="currentColor" className="shrink-0" />
						) : FileIcon ? (
							<FileIcon size={16} color="currentColor" className="shrink-0" />
						) : null}
						<span className={cn("truncate", file.isDir && "font-medium")}>
							{file.name}
						</span>
					</div>
				);
			},
			sortingFn: (rowA, rowB) => {
				const a = rowA.original;
				const b = rowB.original;
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			},
		},
		{
			id: "type",
			header: () => <div className="text-right">{t("columns.type")}</div>,
			size: COL_SIZES.type,
			cell: ({ row }) => (
				<div className="text-right text-muted-foreground">
					{getFileType(row.original, t)}
				</div>
			),
		},
		{
			accessorKey: "size",
			header: () => <div className="text-right">{t("columns.size")}</div>,
			size: COL_SIZES.size,
			cell: ({ row }) => {
				const file = row.original;
				return (
					<div className="text-right text-muted-foreground tabular-nums">
						{file.isDir ? "--" : formatFileSize(file.size)}
					</div>
				);
			},
		},
		{
			accessorKey: "modTime",
			header: () => <div className="text-right">{t("columns.modified")}</div>,
			size: COL_SIZES.modTime,
			cell: ({ row }) => (
				<div className="text-right text-muted-foreground">
					{formatModTime(row.original.modTime)}
				</div>
			),
		},
	];
}

// =============================================================================
// FileBrowser
// =============================================================================

/**
 * Generic S3 file browser. All backend access goes through the `api`
 * adapter, so the same UI serves both project-scoped files and the
 * bucket-root artifacts view.
 */
export function FileBrowser({ api }: { api: FileBrowserApi }) {
	const t = useTranslations("Projects.files");

	// The file browser is local component state (not a route), so navigation
	// state lives here rather than in URL search params.
	const [currentPath, setCurrentPath] = useState("");
	const [viewingFile, setViewingFileState] = useState<string | null>(null);
	const setViewingFile = useCallback((file: string | null) => {
		setViewingFileState(file);
	}, []);

	const [sorting, setSorting] = useState<SortingState>([
		{ id: "name", desc: false },
	]);
	const [showHiddenFiles, setShowHiddenFiles] = useState(() =>
		getCookieBool(SHOW_HIDDEN_FILES_COOKIE),
	);
	const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
	const [uploadInitialFiles, setUploadInitialFiles] = useState<File[]>([]);
	const [isWorkspaceDragOver, setIsWorkspaceDragOver] = useState(false);
	const queryClient = useQueryClient();

	const { data, isLoading, isFetching, isError, error } = useQuery({
		queryKey: fileListQueryKey(api, currentPath),
		queryFn: () => api.list(currentPath),
	});

	const viewingFileIsBinary = viewingFile ? isBinaryFile(viewingFile) : false;

	// Presigned GET URL for the file being viewed. Binary viewers (images)
	// render the URL directly; text viewers fetch its contents below.
	const {
		data: presignData,
		isLoading: isPresignLoading,
		isError: isPresignError,
		error: presignError,
	} = useQuery({
		queryKey: filePresignQueryKey(api, viewingFile ?? ""),
		queryFn: () => api.presignDownload(viewingFile ?? ""),
		enabled: !!viewingFile,
		staleTime: 10 * 60 * 1000,
	});

	const {
		data: fileText,
		isLoading: isFileTextLoading,
		isError: isFileTextError,
		error: fileTextError,
	} = useQuery({
		queryKey: fileContentQueryKey(api, viewingFile ?? ""),
		queryFn: async () => {
			const url = presignData?.url;
			if (!url) throw new Error("Missing download URL");
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
			return res.text();
		},
		enabled: !!viewingFile && !viewingFileIsBinary && !!presignData?.url,
		staleTime: Infinity,
	});

	const listQueryKey = fileListQueryKey(api, currentPath);

	const createFolderMutation = useMutation({
		mutationFn: async (folderName: string) => {
			const folderPath = joinPath(currentPath, folderName);
			return api.createFolder(folderPath);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: listQueryKey });
			setNewFolderDialogOpen(false);
			setNewFolderName("");
		},
	});

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		file: FileEntry;
	} | null>(null);
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [fileToDelete, setFileToDelete] = useState<FileEntry | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	const deleteMutation = useMutation({
		mutationFn: async (file: FileEntry) => {
			return api.delete(joinPath(currentPath, file.name), file.isDir);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: listQueryKey });
			setDeleteDialogOpen(false);
			setFileToDelete(null);
		},
	});

	const handleContextMenu = useCallback(
		(e: React.MouseEvent, file: FileEntry) => {
			e.preventDefault();
			e.stopPropagation();
			setContextMenu({ x: e.clientX, y: e.clientY, file });
		},
		[],
	);

	const handleDeleteClick = useCallback(() => {
		if (!contextMenu) return;
		setFileToDelete(contextMenu.file);
		setDeleteDialogOpen(true);
		setContextMenu(null);
	}, [contextMenu]);

	const [isDownloading, setIsDownloading] = useState(false);

	const handleDownloadClick = useCallback(async () => {
		if (!contextMenu || contextMenu.file.isDir) return;
		const file = contextMenu.file;
		setContextMenu(null);
		setIsDownloading(true);

		try {
			const result = await api.presignDownload(
				joinPath(currentPath, file.name),
				true,
			);
			const a = document.createElement("a");
			a.href = result.url;
			a.download = result.fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} catch (err) {
			console.error("Failed to download file:", err);
		} finally {
			setIsDownloading(false);
		}
	}, [contextMenu, currentPath, api]);

	const handleConfirmDelete = useCallback(() => {
		if (!fileToDelete) return;
		deleteMutation.mutate(fileToDelete);
	}, [fileToDelete, deleteMutation]);

	// Close context menu on click outside or scroll
	useEffect(() => {
		if (!contextMenu) return;

		const handleClose = () => setContextMenu(null);
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setContextMenu(null);
		};

		document.addEventListener("click", handleClose);
		document.addEventListener("scroll", handleClose, true);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("click", handleClose);
			document.removeEventListener("scroll", handleClose, true);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [contextMenu]);

	const handleCreateFolder = useCallback(() => {
		const trimmed = newFolderName.trim();
		if (!trimmed) return;
		createFolderMutation.mutate(trimmed);
	}, [newFolderName, createFolderMutation]);

	const handleToggleHiddenFiles = useCallback((checked: boolean) => {
		setShowHiddenFiles(checked);
		setCookieBool(SHOW_HIDDEN_FILES_COOKIE, checked);
	}, []);

	// Workspace-level drag-and-drop to open upload dialog
	const dragCounterRef = useRef(0);

	const handleWorkspaceDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		if (e.dataTransfer.types.includes("Files")) {
			setIsWorkspaceDragOver(true);
		}
	}, []);

	const handleWorkspaceDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
	}, []);

	const handleWorkspaceDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current--;
		if (dragCounterRef.current === 0) {
			setIsWorkspaceDragOver(false);
		}
	}, []);

	const handleWorkspaceDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = 0;
		setIsWorkspaceDragOver(false);

		if (e.dataTransfer.files.length > 0) {
			const droppedFiles = Array.from(e.dataTransfer.files);
			setUploadInitialFiles(droppedFiles);
			setUploadDialogOpen(true);
		}
	}, []);

	const handleUploadDialogOpenChange = useCallback((open: boolean) => {
		setUploadDialogOpen(open);
		if (!open) {
			setUploadInitialFiles([]);
		}
	}, []);

	const files = useMemo(() => {
		const all = data?.files ?? [];
		if (showHiddenFiles) return all;
		return all.filter((f) => !f.name.startsWith("."));
	}, [data, showHiddenFiles]);

	const breadcrumbs = useMemo(
		() => pathToBreadcrumbs(currentPath, t("root")),
		[currentPath, t],
	);

	const columns = useMemo(() => getColumns(t), [t]);

	const table = useReactTable({
		data: files,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	const handleRowClick = useCallback(
		(file: FileEntry) => {
			if (file.isDir) {
				setCurrentPath(joinPath(currentPath, file.name));
				setViewingFile(null);
			} else {
				setViewingFile(joinPath(currentPath, file.name));
			}
		},
		[currentPath, setViewingFile],
	);

	if (viewingFile) {
		const fileName = viewingFile.split("/").pop() ?? viewingFile;
		const dirPath = viewingFile.slice(0, viewingFile.length - fileName.length);
		const FileViewer = getFileViewer(fileName);

		const viewerLoading = viewingFileIsBinary
			? isPresignLoading
			: isPresignLoading || isFileTextLoading;
		const viewerError = viewingFileIsBinary
			? isPresignError
			: isPresignError || isFileTextError;
		const viewerErrorObj = (presignError ?? fileTextError) as Error | null;

		return (
			<div className="flex flex-col h-full overflow-hidden">
				{/* File viewer header */}
				<div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 min-w-0">
					<button
						type="button"
						onClick={() => setViewingFile(null)}
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1.5 py-1 hover:bg-muted shrink-0"
					>
						<ArrowLeft className="h-3.5 w-3.5" />
						{t("fileViewer.back")}
					</button>
					<div className="flex items-baseline gap-1.5 min-w-0 truncate">
						<span className="text-xs font-medium shrink-0">{fileName}</span>
						<span className="text-[11px] text-muted-foreground font-mono truncate">
							{dirPath}
						</span>
					</div>
				</div>

				{/* File content */}
				<div className="flex-1 min-h-0 overflow-auto scrollbar-minimal">
					{viewerLoading ? (
						<div className="flex h-full items-center justify-center">
							<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
						</div>
					) : viewerError ? (
						<div className="flex h-full items-center justify-center p-4">
							<p className="text-sm text-muted-foreground">
								{viewerErrorObj?.message ?? t("fileViewer.loadError")}
							</p>
						</div>
					) : (
						<FileViewer
							content={
								viewingFileIsBinary
									? (presignData?.url ?? "")
									: (fileText ?? "")
							}
							fileName={fileName}
						/>
					)}
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex h-full items-center justify-center p-4">
				<p className="text-sm text-muted-foreground">
					{(error as Error | null)?.message ?? t("loadError")}
				</p>
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target; the same actions are reachable via the File menu
		<div
			className="flex flex-col h-full overflow-hidden relative"
			onDragEnter={handleWorkspaceDragEnter}
			onDragOver={handleWorkspaceDragOver}
			onDragLeave={handleWorkspaceDragLeave}
			onDrop={handleWorkspaceDrop}
		>
			{/* Breadcrumb navigation */}
			<div className="flex items-center gap-0.5 px-3 py-2 border-b text-xs text-muted-foreground overflow-x-auto shrink-0">
				{breadcrumbs.map((crumb, i) => (
					<span key={crumb.path} className="flex items-center gap-0.5">
						{i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
						<button
							type="button"
							onClick={() => {
								setCurrentPath(crumb.path);
								setViewingFile(null);
							}}
							className={cn(
								"hover:text-foreground transition-colors rounded px-1 py-0.5",
								i === breadcrumbs.length - 1
									? "text-foreground font-medium"
									: "hover:underline",
							)}
						>
							{crumb.name}
						</button>
					</span>
				))}
				<Tooltip>
					<TooltipTrigger
						className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						onClick={() => {
							queryClient.invalidateQueries({ queryKey: listQueryKey });
						}}
					>
						<RefreshCw
							className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
						/>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("menu.refresh")}</TooltipContent>
				</Tooltip>
			</div>

			{/* Menu bar */}
			<div className="shrink-0 border-b">
				<Menubar className="border-none bg-secondary/10 rounded-none">
					<MenubarMenu>
						<MenubarTrigger>{t("menu.file")}</MenubarTrigger>
						<MenubarContent className="w-[200px]">
							<MenubarItem onClick={() => setNewFolderDialogOpen(true)}>
								{t("menu.newFolder")}
							</MenubarItem>
							<MenubarItem onClick={() => setUploadDialogOpen(true)}>
								{t("menu.uploadFile")}
							</MenubarItem>
						</MenubarContent>
					</MenubarMenu>
					<MenubarMenu>
						<MenubarTrigger>{t("menu.edit")}</MenubarTrigger>
						<MenubarContent className="w-[200px]">
							<MenubarItem>
								{t("menu.undo")} <MenubarShortcut>⌘Z</MenubarShortcut>
							</MenubarItem>
							<MenubarItem>
								{t("menu.redo")} <MenubarShortcut>⇧⌘Z</MenubarShortcut>
							</MenubarItem>
							<MenubarSeparator />
							<MenubarSub>
								<MenubarSubTrigger>{t("menu.find")}</MenubarSubTrigger>
								<MenubarSubContent>
									<MenubarItem>{t("menu.searchTheWeb")}</MenubarItem>
									<MenubarSeparator />
									<MenubarItem>{t("menu.findEllipsis")}</MenubarItem>
									<MenubarItem>{t("menu.findNext")}</MenubarItem>
									<MenubarItem>{t("menu.findPrevious")}</MenubarItem>
								</MenubarSubContent>
							</MenubarSub>
							<MenubarSeparator />
							<MenubarItem>{t("menu.cut")}</MenubarItem>
							<MenubarItem>{t("menu.copy")}</MenubarItem>
							<MenubarItem>{t("menu.paste")}</MenubarItem>
						</MenubarContent>
					</MenubarMenu>
					<MenubarMenu>
						<MenubarTrigger>{t("menu.view")}</MenubarTrigger>
						<MenubarContent className="w-[200px]">
							<MenubarCheckboxItem
								checked={showHiddenFiles}
								onCheckedChange={handleToggleHiddenFiles}
							>
								{t("menu.showHiddenFiles")}
							</MenubarCheckboxItem>
						</MenubarContent>
					</MenubarMenu>
				</Menubar>
			</div>

			{/* Fixed table header */}
			<table className="w-full text-xs shrink-0 table-fixed">
				<colgroup>
					<col />
					<col style={{ width: COL_SIZES.type }} />
					<col style={{ width: COL_SIZES.size }} />
					<col style={{ width: COL_SIZES.modTime }} />
				</colgroup>
				<TableHeader>
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<TableHead key={header.id} className="h-8">
									{header.isPlaceholder
										? null
										: flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)}
								</TableHead>
							))}
						</TableRow>
					))}
				</TableHeader>
			</table>

			{/* Scrollable table body */}
			<div className="flex-1 min-h-0 overflow-y-auto scrollbar-minimal relative">
				{/* Drag overlay */}
				{isWorkspaceDragOver && (
					// biome-ignore lint/a11y/noStaticElementInteractions: transient drop overlay only shown mid-drag
					<div
						className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
						onDragOver={(e) => {
							e.preventDefault();
							e.stopPropagation();
						}}
						onDrop={handleWorkspaceDrop}
					>
						<div className="flex flex-col items-center gap-3 pointer-events-none">
							<div className="rounded-full p-3 bg-primary/10">
								<CloudUpload className="h-6 w-6 text-primary" />
							</div>
							<p className="text-sm text-muted-foreground">
								{t("menu.dropToUpload")}
							</p>
						</div>
					</div>
				)}
				<table className="w-full text-xs table-fixed">
					<colgroup>
						<col />
						<col style={{ width: COL_SIZES.type }} />
						<col style={{ width: COL_SIZES.size }} />
						<col style={{ width: COL_SIZES.modTime }} />
					</colgroup>
					<TableBody>
						{table.getRowModel().rows.length ? (
							table.getRowModel().rows.map((row) => (
								<TableRow
									key={row.id}
									className="cursor-pointer"
									onClick={() => handleRowClick(row.original)}
									onContextMenu={(e) => handleContextMenu(e, row.original)}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id} className="px-3 py-2">
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext(),
											)}
										</TableCell>
									))}
								</TableRow>
							))
						) : (
							<TableRow className="hover:bg-transparent">
								<TableCell
									colSpan={columns.length}
									className="py-16 text-center"
								>
									<div className="flex flex-col items-center gap-3 text-center animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
										<div className="flex size-12 items-center justify-center rounded-xl bg-foreground/5 text-muted-foreground/80">
											<IconFolder
												size={22}
												color="currentColor"
												className="shrink-0"
											/>
										</div>
										<div className="flex flex-col gap-1 max-w-xs text-pretty">
											<p className="text-sm font-medium text-foreground/90">
												{t("emptyDirectory")}
											</p>
											<p className="text-xs text-muted-foreground">
												{t("emptyDirectoryHint")}
											</p>
										</div>
									</div>
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</table>
			</div>

			{/* New Folder Dialog */}
			<Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
				<DialogContent className="sm:max-w-[400px]">
					<DialogHeader>
						<DialogTitle>{t("menu.newFolder")}</DialogTitle>
						<DialogDescription>
							{t("menu.newFolderDescription")}
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleCreateFolder();
						}}
					>
						<Input
							autoFocus
							placeholder={t("menu.folderNamePlaceholder")}
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
						/>
						<DialogFooter className="mt-4">
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setNewFolderDialogOpen(false);
									setNewFolderName("");
								}}
							>
								{t("menu.cancel")}
							</Button>
							<Button
								type="submit"
								disabled={
									!newFolderName.trim() || createFolderMutation.isPending
								}
							>
								{createFolderMutation.isPending
									? t("menu.creating")
									: t("menu.create")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{/* Upload Dialog */}
			<UploadDialog
				open={uploadDialogOpen}
				onOpenChange={handleUploadDialogOpenChange}
				api={api}
				currentPath={currentPath}
				initialFiles={uploadInitialFiles}
			/>

			{/* Context Menu */}
			{contextMenu && (
				// biome-ignore lint/a11y/noStaticElementInteractions: click handler only stops propagation so the menu stays open
				// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally while the menu is open
				<div
					ref={contextMenuRef}
					className="fixed z-50 min-w-36 rounded-lg p-1 shadow-md ring-1 ring-foreground/10 bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 duration-100"
					style={{
						left: contextMenu.x,
						top: contextMenu.y,
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{!contextMenu.file.isDir && (
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent outline-none cursor-default select-none"
							onClick={handleDownloadClick}
						>
							<Download className="h-3.5 w-3.5" />
							{isDownloading ? t("menu.downloading") : t("menu.downloadFile")}
						</button>
					)}
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20 outline-none cursor-default select-none"
						onClick={handleDeleteClick}
					>
						<Trash2 className="h-3.5 w-3.5" />
						{t("menu.deleteFile")}
					</button>
				</div>
			)}

			{/* Delete Confirmation Dialog */}
			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{fileToDelete?.isDir
								? t("menu.deleteFolderTitle")
								: t("menu.deleteFileTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{fileToDelete?.isDir
								? t("menu.deleteFolderDescription", {
										name: fileToDelete?.name ?? "",
									})
								: t("menu.deleteFileDescription", {
										name: fileToDelete?.name ?? "",
									})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							onClick={() => {
								setDeleteDialogOpen(false);
								setFileToDelete(null);
							}}
						>
							{t("menu.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleConfirmDelete}
							disabled={deleteMutation.isPending}
						>
							{deleteMutation.isPending
								? t("menu.deleting")
								: t("menu.deleteFile")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

// =============================================================================
// ProjectFiles
// =============================================================================

/** File browser scoped to a single project's S3 prefix. */
export function ProjectFiles({ projectId }: { projectId: string }) {
	const api = useMemo(() => createProjectFilesApi(projectId), [projectId]);
	return <FileBrowser api={api} />;
}
