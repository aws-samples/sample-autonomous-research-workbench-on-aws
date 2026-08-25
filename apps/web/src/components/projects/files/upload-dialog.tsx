"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, File as FileIcon, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { type FileBrowserApi, fileListQueryKey } from "./files-api";

interface UploadDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	api: FileBrowserApi;
	/** Directory (relative to the browser root) files are uploaded into. */
	currentPath: string;
	initialFiles?: File[];
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function UploadDialog({
	open,
	onOpenChange,
	api,
	currentPath,
	initialFiles,
}: UploadDialogProps) {
	const t = useTranslations("Projects.files");
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
	const [isDragOver, setIsDragOver] = useState(false);

	// Populate selected files when initialFiles are provided (e.g. from
	// workspace drag-and-drop).
	useEffect(() => {
		if (initialFiles && initialFiles.length > 0) {
			setSelectedFiles(initialFiles);
		}
	}, [initialFiles]);

	const uploadMutation = useMutation({
		mutationFn: async (files: File[]) => {
			const { uploads } = await api.presignUpload(
				currentPath,
				files.map((file) => ({
					name: file.name,
					contentType: file.type || "application/octet-stream",
					size: file.size,
				})),
			);

			const urlByName = new Map(uploads.map((u) => [u.name, u.url]));
			await Promise.all(
				files.map(async (file) => {
					const url = urlByName.get(file.name);
					if (!url) throw new Error(`No upload URL for ${file.name}`);
					const res = await fetch(url, {
						method: "PUT",
						headers: {
							"Content-Type": file.type || "application/octet-stream",
						},
						body: file,
					});
					if (!res.ok) {
						throw new Error(`Failed to upload ${file.name} (${res.status})`);
					}
				}),
			);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: fileListQueryKey(api, currentPath),
			});
			setSelectedFiles([]);
			setIsDragOver(false);
			onOpenChange(false);
		},
	});

	const handleClose = useCallback(() => {
		if (uploadMutation.isPending) return;
		setSelectedFiles([]);
		setIsDragOver(false);
		onOpenChange(false);
	}, [onOpenChange, uploadMutation.isPending]);

	const addFiles = useCallback((newFiles: FileList | File[]) => {
		const filesArray = Array.from(newFiles);
		setSelectedFiles((prev) => {
			const existingNames = new Set(prev.map((f) => f.name));
			const unique = filesArray.filter((f) => !existingNames.has(f.name));
			return [...prev, ...unique];
		});
	}, []);

	const removeFile = useCallback((index: number) => {
		setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			if (e.dataTransfer.files.length > 0) {
				addFiles(e.dataTransfer.files);
			}
		},
		[addFiles],
	);

	const handleFileInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (e.target.files && e.target.files.length > 0) {
				addFiles(e.target.files);
				// Reset the input so the same file can be selected again.
				e.target.value = "";
			}
		},
		[addFiles],
	);

	const handleUpload = useCallback(() => {
		if (selectedFiles.length === 0) return;
		uploadMutation.mutate(selectedFiles);
	}, [selectedFiles, uploadMutation]);

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle>{t("menu.uploadDialogTitle")}</DialogTitle>
					<DialogDescription>
						{t("menu.uploadDialogDescription")}
					</DialogDescription>
				</DialogHeader>

				{/* Drop zone */}
				<button
					type="button"
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
					onClick={() => fileInputRef.current?.click()}
					className={cn(
						"relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer",
						isDragOver
							? "border-primary bg-primary/5"
							: "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50",
					)}
				>
					<div
						className={cn(
							"rounded-full p-3 transition-colors",
							isDragOver ? "bg-primary/10" : "bg-muted",
						)}
					>
						<CloudUpload
							className={cn(
								"h-6 w-6 transition-colors",
								isDragOver ? "text-primary" : "text-muted-foreground",
							)}
						/>
					</div>
					<div className="text-center">
						<p className="text-sm text-muted-foreground">
							{t("menu.dropzoneText")}{" "}
							<span className="font-medium text-primary underline underline-offset-2">
								{t("menu.browseFiles")}
							</span>
						</p>
					</div>
				</button>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={handleFileInputChange}
				/>

				{/* Selected files list */}
				{selectedFiles.length > 0 && (
					<div className="space-y-2">
						<p className="text-xs text-muted-foreground">
							{t("menu.selectedFiles", { count: selectedFiles.length })}
						</p>
						<div className="max-h-40 overflow-y-auto space-y-1 scrollbar-minimal">
							{selectedFiles.map((file, index) => (
								<div
									key={`${file.name}-${file.size}`}
									className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
								>
									<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									<span className="flex-1 truncate">{file.name}</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{formatFileSize(file.size)}
									</span>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											removeFile(index);
										}}
										className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
										disabled={uploadMutation.isPending}
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Error message */}
				{uploadMutation.isError && (
					<p className="text-xs text-destructive">{t("menu.uploadError")}</p>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={handleClose}
						disabled={uploadMutation.isPending}
					>
						{t("menu.cancel")}
					</Button>
					<Button
						type="button"
						onClick={handleUpload}
						disabled={selectedFiles.length === 0 || uploadMutation.isPending}
					>
						{uploadMutation.isPending ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin mr-2" />
								{t("menu.uploading")}
							</>
						) : (
							t("menu.upload")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
