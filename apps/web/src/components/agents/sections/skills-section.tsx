"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	File,
	FileCode,
	FileText,
	Folder,
	FolderOpen,
	Loader2,
	Sparkles,
	Trash2,
	Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { client, orpc } from "@/orpc/client";

interface SkillsSectionProps {
	agentId: string;
	readOnly?: boolean;
}

interface SkillFileMeta {
	id: string;
	path: string;
	size: number;
}

interface Skill {
	id: string;
	name: string;
	description: string | null;
	files: SkillFileMeta[];
	totalSize: number;
	createdAt: string;
	updatedAt: string;
}

// ── File tree ──

interface TreeDir {
	type: "dir";
	name: string;
	path: string;
	children: TreeNode[];
}

interface TreeFile {
	type: "file";
	name: string;
	file: SkillFileMeta;
}

type TreeNode = TreeDir | TreeFile;

/** Build a nested tree from flat relative paths. */
function buildTree(files: SkillFileMeta[]): TreeNode[] {
	const root: TreeDir = { type: "dir", name: "", path: "", children: [] };

	for (const file of files) {
		const segments = file.path.split("/");
		let dir = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const dirPath = segments.slice(0, i + 1).join("/");
			let child = dir.children.find(
				(n): n is TreeDir => n.type === "dir" && n.path === dirPath,
			);
			if (!child) {
				child = {
					type: "dir",
					name: segments[i] ?? "",
					path: dirPath,
					children: [],
				};
				dir.children.push(child);
			}
			dir = child;
		}
		dir.children.push({
			type: "file",
			name: segments[segments.length - 1] ?? file.path,
			file,
		});
	}

	const sortNodes = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const node of nodes) {
			if (node.type === "dir") sortNodes(node.children);
		}
	};
	sortNodes(root.children);

	return root.children;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name: string) {
	if (/\.(md|mdx|txt)$/i.test(name)) return FileText;
	if (/\.(py|js|ts|tsx|jsx|sh|rb|sql|json|ya?ml|toml)$/i.test(name))
		return FileCode;
	return File;
}

function FileTreeNode({
	node,
	depth,
	onFileClick,
}: {
	node: TreeNode;
	depth: number;
	onFileClick: (file: SkillFileMeta) => void;
}) {
	const [expanded, setExpanded] = React.useState(true);

	if (node.type === "dir") {
		const DirIcon = expanded ? FolderOpen : Folder;
		const Chevron = expanded ? ChevronDown : ChevronRight;
		return (
			<div>
				<button
					type="button"
					onClick={() => setExpanded((prev) => !prev)}
					className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
					style={{ paddingLeft: `${depth * 16 + 8}px` }}
				>
					<Chevron className="h-3 w-3 shrink-0 text-muted-foreground" />
					<DirIcon className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
					<span className="truncate text-xs text-foreground">{node.name}</span>
				</button>
				{expanded &&
					node.children.map((child) => (
						<FileTreeNode
							key={child.type === "dir" ? child.path : child.file.id}
							node={child}
							depth={depth + 1}
							onFileClick={onFileClick}
						/>
					))}
			</div>
		);
	}

	const Icon = fileIcon(node.name);
	const isSkillMd = node.file.path === "SKILL.md";
	return (
		<button
			type="button"
			onClick={() => onFileClick(node.file)}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
			style={{ paddingLeft: `${depth * 16 + 8 + 18}px` }}
		>
			<Icon
				className={cn(
					"h-3.5 w-3.5 shrink-0",
					isSkillMd ? "text-primary" : "text-muted-foreground",
				)}
			/>
			<span
				className={cn(
					"truncate text-xs",
					isSkillMd ? "font-medium text-foreground" : "text-foreground/90",
				)}
			>
				{node.name}
			</span>
			<span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums">
				{formatBytes(node.file.size)}
			</span>
		</button>
	);
}

// ── File preview dialog ──

function FilePreviewDialog({
	agentId,
	file,
	onOpenChange,
}: {
	agentId: string;
	file: SkillFileMeta | null;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isPending } = useQuery({
		...orpc.agents.skills.getFile.queryOptions({
			input: { agentId, fileId: file?.id ?? "" },
		}),
		enabled: !!file,
	});

	return (
		<Dialog open={!!file} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="font-mono text-sm">{file?.path}</DialogTitle>
					<DialogDescription>
						{file ? formatBytes(file.size) : ""}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
					{isPending ? (
						<div className="space-y-2 p-3">
							<Skeleton className="h-3 w-full" />
							<Skeleton className="h-3 w-5/6" />
							<Skeleton className="h-3 w-2/3" />
						</div>
					) : (
						<pre className="p-3 font-mono text-xs whitespace-pre-wrap text-foreground/90">
							{data?.file.content}
						</pre>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ── Skill card ──

function SkillCard({
	agentId,
	skill,
	readOnly,
	onFileClick,
}: {
	agentId: string;
	skill: Skill;
	readOnly?: boolean;
	onFileClick: (file: SkillFileMeta) => void;
}) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = React.useState(false);

	const tree = React.useMemo(() => buildTree(skill.files), [skill.files]);

	const deleteMutation = useMutation({
		mutationFn: () =>
			client.agents.skills.delete({ agentId, skillId: skill.id }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.agents.skills.list.key(),
			});
			toast.success(t("settings.skillsSection.deleteSuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const Chevron = expanded ? ChevronDown : ChevronRight;

	return (
		<div className="overflow-hidden rounded-lg border">
			<div className="flex items-center gap-2 px-3 py-2.5">
				<button
					type="button"
					onClick={() => setExpanded((prev) => !prev)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
				>
					<Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/80" />
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs font-medium text-foreground">
							{skill.name}
						</div>
						{skill.description && (
							<div className="truncate text-[11px] text-muted-foreground">
								{skill.description}
							</div>
						)}
					</div>
				</button>
				<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
					{t("settings.skillsSection.fileCount", {
						count: skill.files.length,
					})}{" "}
					· {formatBytes(skill.totalSize)}
				</span>
				{!readOnly && (
					<Button
						variant="ghost"
						size="icon-xs"
						onClick={() => deleteMutation.mutate()}
						disabled={deleteMutation.isPending}
					>
						{deleteMutation.isPending ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</Button>
				)}
			</div>
			{expanded && (
				<div className="border-t bg-muted/20 py-1.5">
					{tree.map((node) => (
						<FileTreeNode
							key={node.type === "dir" ? node.path : node.file.id}
							node={node}
							depth={0}
							onFileClick={onFileClick}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ── Upload ──

const MAX_FILE_SIZE = 512 * 1024;
const MAX_TOTAL_SIZE = 2 * 1024 * 1024;

/**
 * Read a folder selection (webkitdirectory) into skill upload payloads. The
 * top-level folder name becomes the skill name and is stripped from paths.
 */
async function readFolderSelection(fileList: FileList): Promise<{
	name: string;
	files: { path: string; content: string }[];
}> {
	const files: { path: string; content: string }[] = [];
	let name = "";
	let totalSize = 0;

	for (const file of Array.from(fileList)) {
		const relativePath =
			(file as File & { webkitRelativePath?: string }).webkitRelativePath ||
			file.name;
		const segments = relativePath.split("/");
		// Skip hidden files/dirs (.git, .DS_Store, ...).
		if (segments.some((s) => s.startsWith("."))) continue;

		if (segments.length > 1) {
			name = segments[0] ?? "";
			segments.shift();
		}
		const path = segments.join("/");

		if (file.size > MAX_FILE_SIZE) {
			throw new Error(`file-too-large:${path}`);
		}
		totalSize += file.size;
		if (totalSize > MAX_TOTAL_SIZE) {
			throw new Error("skill-too-large");
		}

		files.push({ path, content: await file.text() });
	}

	return { name, files };
}

export function SkillsSection({ agentId, readOnly }: SkillsSectionProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();
	const inputRef = React.useRef<HTMLInputElement>(null);
	const [previewFile, setPreviewFile] = React.useState<SkillFileMeta | null>(
		null,
	);

	const { data, isPending } = useQuery(
		orpc.agents.skills.list.queryOptions({ input: { agentId } }),
	);

	const uploadMutation = useMutation({
		mutationFn: async (fileList: FileList) => {
			const { name, files } = await readFolderSelection(fileList);
			if (files.length === 0) {
				throw new Error("no-files");
			}
			if (!files.some((f) => f.path === "SKILL.md")) {
				throw new Error("missing-skill-md");
			}
			return client.agents.skills.upload({
				agentId,
				name: name || (files[0]?.path ?? "skill").replace(/\.[^.]+$/, ""),
				files,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.agents.skills.list.key(),
			});
			toast.success(t("settings.skillsSection.uploadSuccess"));
		},
		onError: (error: Error) => {
			if (error.message === "missing-skill-md") {
				toast.error(t("settings.skillsSection.missingSkillMd"));
			} else if (
				error.message === "skill-too-large" ||
				error.message.startsWith("file-too-large")
			) {
				toast.error(t("settings.skillsSection.tooLarge"));
			} else {
				toast.error(t("toast.error"));
			}
		},
	});

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const fileList = e.target.files;
		if (fileList && fileList.length > 0) {
			uploadMutation.mutate(fileList);
		}
		e.target.value = "";
	};

	const skills = (data?.skills ?? []) as Skill[];

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.skillsSection.title")}</CardTitle>
				<CardDescription>
					{t("settings.skillsSection.description")}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{!readOnly && (
					<div className="flex items-center justify-between rounded-lg border border-dashed px-4 py-3">
						<div className="min-w-0">
							<p className="text-xs font-medium text-foreground">
								{t("settings.skillsSection.uploadTitle")}
							</p>
							<p className="text-[11px] text-muted-foreground">
								{t("settings.skillsSection.uploadHint")}
							</p>
						</div>
						<input
							ref={inputRef}
							type="file"
							// @ts-expect-error non-standard attribute for folder selection
							webkitdirectory=""
							multiple
							className="hidden"
							onChange={handleFileChange}
						/>
						<Button
							size="sm"
							onClick={() => inputRef.current?.click()}
							disabled={uploadMutation.isPending}
						>
							{uploadMutation.isPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Upload className="h-3.5 w-3.5" />
							)}
							{t("settings.skillsSection.uploadButton")}
						</Button>
					</div>
				)}

				{isPending ? (
					<div className="space-y-2">
						{Array.from({ length: 2 }).map((_, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
							<Skeleton key={i} className="h-12 w-full rounded-lg" />
						))}
					</div>
				) : skills.length === 0 ? (
					<div className="flex flex-col items-center justify-center rounded-lg border py-10 text-center">
						<Sparkles className="mb-2 h-8 w-8 text-muted-foreground/50" />
						<p className="text-sm font-medium text-foreground">
							{t("settings.skillsSection.emptyTitle")}
						</p>
						<p className="mt-0.5 max-w-sm text-xs text-muted-foreground">
							{t("settings.skillsSection.emptyDescription")}
						</p>
					</div>
				) : (
					<div className="space-y-2">
						{skills.map((skill) => (
							<SkillCard
								key={skill.id}
								agentId={agentId}
								skill={skill}
								readOnly={readOnly}
								onFileClick={setPreviewFile}
							/>
						))}
					</div>
				)}
			</CardContent>

			<FilePreviewDialog
				agentId={agentId}
				file={previewFile}
				onOpenChange={(open) => {
					if (!open) setPreviewFile(null);
				}}
			/>
		</Card>
	);
}
