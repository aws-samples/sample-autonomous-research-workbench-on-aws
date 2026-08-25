"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Download,
	FileText,
	FolderSync,
	Loader2,
	Trash2,
	Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { client, orpc } from "@/orpc/client";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1024;
		unit += 1;
	} while (value >= 1024 && unit < units.length - 1);
	return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleString();
}

const SYNC_BADGE: Record<string, string> = {
	RUNNING: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	SUCCEEDED: "bg-green-500/15 text-green-600 dark:text-green-400",
	FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
	TIMED_OUT: "bg-red-500/15 text-red-600 dark:text-red-400",
	ABORTED: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
};

/**
 * Admin browser for the knowledge S3 bucket: list, upload (via presigned PUT
 * straight from the browser), download, delete, and a "Sync" button that
 * starts the ingestion Step Function over the bucket's current contents.
 */
export function KnowledgePanel({ padded = true }: { padded?: boolean } = {}) {
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	const [confirmClearGraph, setConfirmClearGraph] = useState(false);

	const invalidateFiles = () =>
		queryClient.invalidateQueries({ queryKey: orpc.knowledge.listFiles.key() });

	// Destructive: detach-deletes every node and relationship in the graph.
	const clearGraph = useMutation(
		orpc.graph.clearGraph.mutationOptions({
			onSuccess: (data) => {
				toast.success(`Graph cleared — deleted ${data.deleted} nodes`);
				queryClient.invalidateQueries({
					queryKey: orpc.graph.getSchema.key(),
				});
			},
			onError: (error) =>
				toast.error(
					error instanceof Error ? error.message : "Clear graph failed",
				),
		}),
	);

	const filesQuery = useQuery(orpc.knowledge.listFiles.queryOptions());

	const syncQuery = useQuery(
		orpc.knowledge.syncStatus.queryOptions({
			// Poll while an ingestion run is in flight so the badge flips on its own.
			refetchInterval: (query) =>
				query.state.data?.execution?.status === "RUNNING" ? 5000 : false,
		}),
	);
	const execution = syncQuery.data?.execution ?? null;
	const syncRunning = execution?.status === "RUNNING";

	const startSync = useMutation(
		orpc.knowledge.startSync.mutationOptions({
			onSuccess: () => {
				toast.success("Ingestion started");
				queryClient.invalidateQueries({
					queryKey: orpc.knowledge.syncStatus.key(),
				});
			},
			onError: (error) =>
				toast.error(error instanceof Error ? error.message : "Sync failed"),
		}),
	);

	const deleteFile = useMutation(
		orpc.knowledge.deleteFile.mutationOptions({
			onSuccess: (_data, variables) => {
				toast.success(`Deleted ${variables.key}`);
				invalidateFiles();
			},
			onError: (error) =>
				toast.error(error instanceof Error ? error.message : "Delete failed"),
		}),
	);

	async function uploadFiles(files: FileList) {
		setUploading(true);
		try {
			for (const file of Array.from(files)) {
				const { url } = await client.knowledge.getUploadUrl({
					key: file.name,
					contentType: file.type || "application/octet-stream",
				});
				const res = await fetch(url, {
					method: "PUT",
					body: file,
					headers: {
						"Content-Type": file.type || "application/octet-stream",
					},
				});
				if (!res.ok) {
					throw new Error(`Upload of ${file.name} failed (${res.status})`);
				}
				toast.success(`Uploaded ${file.name}`);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Upload failed");
		} finally {
			setUploading(false);
			invalidateFiles();
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	}

	async function downloadFile(key: string) {
		try {
			const { url } = await client.knowledge.getDownloadUrl({ key });
			window.open(url, "_blank", "noopener");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Download failed");
		}
	}

	const files = filesQuery.data?.files ?? [];

	return (
		<div
			className={cn("flex h-full flex-col overflow-hidden", padded && "p-2")}
		>
			<div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
				<header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
					<FileText className="size-4 shrink-0 text-muted-foreground" />
					<span className="text-sm font-medium text-foreground">
						Knowledge documents
					</span>
					{execution ? (
						<Badge
							variant="secondary"
							className={cn("ml-1", SYNC_BADGE[execution.status])}
						>
							{syncRunning ? <Loader2 className="size-3 animate-spin" /> : null}
							Sync {execution.status.toLowerCase().replace("_", " ")}
						</Badge>
					) : null}

					<div className="ml-auto flex items-center gap-2">
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(e) => {
								if (e.target.files?.length) void uploadFiles(e.target.files);
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							disabled={uploading}
							onClick={() => fileInputRef.current?.click()}
						>
							{uploading ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Upload className="size-4" />
							)}
							Upload
						</Button>
						<Button
							size="sm"
							disabled={syncRunning || startSync.isPending}
							onClick={() => startSync.mutate({})}
						>
							{syncRunning || startSync.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<FolderSync className="size-4" />
							)}
							Sync
						</Button>
						<Button
							size="sm"
							variant="outline"
							className="text-destructive hover:text-destructive"
							disabled={clearGraph.isPending}
							onClick={() => setConfirmClearGraph(true)}
						>
							{clearGraph.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Trash2 className="size-4" />
							)}
							Clear graph
						</Button>
					</div>
				</header>

				<div className="min-h-0 flex-1 overflow-auto">
					<div className="border-b px-4 py-3">
						<p className="max-w-2xl text-sm text-muted-foreground">
							Documents uploaded here land in the knowledge S3 bucket.{" "}
							<strong>Sync</strong> runs the ingestion pipeline (a
							distributed-map Step Function) over every document currently in
							the bucket.
							{filesQuery.data?.bucket ? (
								<>
									{" "}
									Bucket: <code>{filesQuery.data.bucket}</code>
								</>
							) : null}
						</p>
						{filesQuery.data?.truncated ? (
							<p className="mt-1 text-xs text-yellow-600">
								Listing truncated — showing the first {files.length} objects.
							</p>
						) : null}
					</div>

					{filesQuery.isPending ? (
						<div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Loading documents…
						</div>
					) : filesQuery.isError ? (
						<p className="p-4 text-sm text-destructive">
							{filesQuery.error instanceof Error
								? filesQuery.error.message
								: "Couldn't list documents"}
						</p>
					) : files.length === 0 ? (
						<p className="p-4 text-sm text-muted-foreground">
							The bucket is empty. Upload a document to get started.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Document</TableHead>
									<TableHead className="w-28">Size</TableHead>
									<TableHead className="w-48">Last modified</TableHead>
									<TableHead className="w-24 text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{files.map((file) => (
									<TableRow key={file.key}>
										<TableCell className="font-mono text-xs">
											{file.key}
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{formatBytes(file.size)}
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{formatDate(file.lastModified)}
										</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-1">
												<Button
													size="icon"
													variant="ghost"
													className="size-7"
													aria-label={`Download ${file.key}`}
													onClick={() => void downloadFile(file.key)}
												>
													<Download className="size-3.5" />
												</Button>
												<Button
													size="icon"
													variant="ghost"
													className="size-7 text-destructive hover:text-destructive"
													aria-label={`Delete ${file.key}`}
													disabled={deleteFile.isPending}
													onClick={() => setPendingDelete(file.key)}
												>
													<Trash2 className="size-3.5" />
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</div>
			</div>

			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete document?</AlertDialogTitle>
						<AlertDialogDescription>
							<code>{pendingDelete}</code> will be permanently removed from the
							knowledge bucket.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pendingDelete) deleteFile.mutate({ key: pendingDelete });
								setPendingDelete(null);
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={confirmClearGraph} onOpenChange={setConfirmClearGraph}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Clear the graph?</AlertDialogTitle>
						<AlertDialogDescription>
							Every node and relationship in the graph database will be
							permanently deleted. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								clearGraph.mutate({});
								setConfirmClearGraph(false);
							}}
						>
							Clear graph
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
