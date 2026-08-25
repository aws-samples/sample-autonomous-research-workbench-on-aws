"use client";

import { authClient } from "@repo/auth/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Braces,
	Check,
	Loader2,
	Network,
	Plus,
	RotateCcw,
	Save,
	Table2,
	TriangleAlert,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc/client";

const ENTRY_TYPES = ["actor", "feature", "relation"] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

type TemplateEntry = { type: EntryType; tokens: string[] };
type Template = Record<string, TemplateEntry>;

// Editor row: entry name is editable, so it can't be the map key while typing.
type EditorRow = {
	id: string;
	name: string;
	type: EntryType;
	tokens: string[];
};

const TYPE_BADGE: Record<EntryType, string> = {
	actor: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	feature: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
	relation: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function hasAdminRole(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.map((r) => r.trim())
		.includes("admin");
}

let rowSeq = 0;
function nextRowId(): string {
	rowSeq += 1;
	return `row-${rowSeq}`;
}

function templateToRows(template: Template): EditorRow[] {
	return Object.entries(template).map(([name, entry]) => ({
		id: nextRowId(),
		name,
		type: entry.type,
		tokens: entry.tokens,
	}));
}

/**
 * Validate + collapse editor rows back into a template map. Returns either the
 * template or a list of human-readable errors (duplicate/invalid names, empty
 * token lists, etc.).
 */
function rowsToTemplate(
	rows: EditorRow[],
): { ok: true; template: Template } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const template: Template = {};
	const seen = new Set<string>();

	for (const row of rows) {
		const name = row.name.trim();
		if (!name) {
			errors.push("An entry is missing a name.");
			continue;
		}
		if (!NAME_RE.test(name)) {
			errors.push(`"${name}" is not a valid entry name.`);
			continue;
		}
		if (seen.has(name)) {
			errors.push(`Duplicate entry name "${name}".`);
			continue;
		}
		seen.add(name);

		const tokens = row.tokens.map((t) => t.trim()).filter(Boolean);
		if (tokens.length === 0) {
			errors.push(`"${name}" has no tokens.`);
			continue;
		}
		template[name] = { type: row.type, tokens };
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, template };
}

/**
 * Platform Graph → Schema tab. Presents the entity/relation extraction
 * template (the tokens the ingestion pipeline skims for) as an editable
 * schema. Admins can edit it in a structured form or as raw JSON and persist
 * it; non-admins see a read-only view. "Reset to default" restores the
 * bundled platform template.
 */
export function SchemaExplorer({ padded = true }: { padded?: boolean } = {}) {
	const queryClient = useQueryClient();
	const { data: session } = authClient.useSession();
	const isAdmin = hasAdminRole(session?.user.role);

	const { data, isPending, isError, error } = useQuery(
		orpc.graph.getTemplate.queryOptions(),
	);

	const [mode, setMode] = useState<"form" | "json">("form");
	const [rows, setRows] = useState<EditorRow[]>([]);
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);

	// Seed the editor whenever the server template object changes. react-query's
	// structural sharing keeps `data` referentially stable across background
	// refetches that return identical content, so in-progress local edits are
	// only reset when the persisted template actually changes (our own save /
	// reset), not on every poll.
	useEffect(() => {
		if (!data) return;
		setRows(templateToRows(data.template as Template));
		setJsonText(JSON.stringify(data.template, null, 2));
		setJsonError(null);
		setDirty(false);
	}, [data]);

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: orpc.graph.getTemplate.key() });

	const save = useMutation(
		orpc.graph.saveTemplate.mutationOptions({
			onSuccess: () => {
				toast.success("Template saved");
				invalidate();
			},
			onError: (e) =>
				toast.error(e instanceof Error ? e.message : "Save failed"),
		}),
	);

	const reset = useMutation(
		orpc.graph.resetTemplate.mutationOptions({
			onSuccess: () => {
				toast.success("Reset to platform default");
				invalidate();
			},
			onError: (e) =>
				toast.error(e instanceof Error ? e.message : "Reset failed"),
		}),
	);

	// When switching form → JSON, serialize the current rows; JSON → form, parse.
	function switchMode(next: "form" | "json") {
		if (next === mode) return;
		if (next === "json") {
			const result = rowsToTemplate(rows);
			if (result.ok) {
				setJsonText(JSON.stringify(result.template, null, 2));
				setJsonError(null);
			} else {
				// Serialize best-effort so the user doesn't lose work, but warn.
				const partial: Template = {};
				for (const r of rows) {
					if (r.name.trim())
						partial[r.name.trim()] = {
							type: r.type,
							tokens: r.tokens.filter(Boolean),
						};
				}
				setJsonText(JSON.stringify(partial, null, 2));
				setJsonError(result.errors.join(" "));
			}
		} else {
			const parsed = parseJson(jsonText);
			if (!parsed.ok) {
				setJsonError(parsed.error);
				return; // stay in JSON mode until it parses
			}
			setRows(templateToRows(parsed.template));
			setJsonError(null);
		}
		setMode(next);
	}

	function parseJson(
		text: string,
	): { ok: true; template: Template } | { ok: false; error: string } {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (e) {
			return {
				ok: false,
				error: e instanceof Error ? e.message : "Invalid JSON",
			};
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { ok: false, error: "Template must be a JSON object." };
		}
		const template: Template = {};
		for (const [name, entry] of Object.entries(
			raw as Record<string, unknown>,
		)) {
			if (!NAME_RE.test(name)) {
				return { ok: false, error: `Invalid entry name "${name}".` };
			}
			if (!entry || typeof entry !== "object") {
				return { ok: false, error: `"${name}" must be an object.` };
			}
			const { type, tokens } = entry as Record<string, unknown>;
			if (!ENTRY_TYPES.includes(type as EntryType)) {
				return {
					ok: false,
					error: `"${name}".type must be one of ${ENTRY_TYPES.join(", ")}.`,
				};
			}
			if (
				!Array.isArray(tokens) ||
				tokens.some((t) => typeof t !== "string") ||
				tokens.length === 0
			) {
				return {
					ok: false,
					error: `"${name}".tokens must be a non-empty string array.`,
				};
			}
			template[name] = { type: type as EntryType, tokens: tokens as string[] };
		}
		return { ok: true, template };
	}

	function handleSave() {
		if (mode === "json") {
			const parsed = parseJson(jsonText);
			if (!parsed.ok) {
				setJsonError(parsed.error);
				toast.error("Fix the JSON before saving");
				return;
			}
			save.mutate({ template: parsed.template });
			return;
		}
		const result = rowsToTemplate(rows);
		if (!result.ok) {
			toast.error(result.errors[0] ?? "Fix validation errors before saving");
			return;
		}
		save.mutate({ template: result.template });
	}

	const entryCount = mode === "json" ? undefined : rows.length;
	const busy = save.isPending || reset.isPending;

	return (
		<div
			className={cn("flex h-full flex-col overflow-hidden", padded && "p-2")}
		>
			<div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
				<header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
					<Network className="size-4 shrink-0 text-muted-foreground" />
					<span className="text-sm font-medium text-foreground">
						Extraction Schema
					</span>
					{data ? (
						<span className="text-xs text-muted-foreground">
							{data.isDefault ? "platform default" : "customized"}
							{typeof entryCount === "number" ? ` · ${entryCount} entries` : ""}
						</span>
					) : null}

					<div className="ml-auto flex items-center gap-1.5">
						{/* Mode toggle */}
						<div className="flex items-center rounded-md border p-0.5">
							<Button
								size="sm"
								variant={mode === "form" ? "secondary" : "ghost"}
								className="h-7 gap-1.5 px-2"
								onClick={() => switchMode("form")}
							>
								<Table2 className="size-3.5" />
								Form
							</Button>
							<Button
								size="sm"
								variant={mode === "json" ? "secondary" : "ghost"}
								className="h-7 gap-1.5 px-2"
								onClick={() => switchMode("json")}
							>
								<Braces className="size-3.5" />
								JSON
							</Button>
						</div>

						{isAdmin ? (
							<>
								<Button
									size="sm"
									variant="outline"
									disabled={busy || (data?.isDefault ?? true)}
									onClick={() => {
										if (
											window.confirm(
												"Discard the saved template and restore the platform default?",
											)
										) {
											reset.mutate({});
										}
									}}
								>
									{reset.isPending ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<RotateCcw className="size-4" />
									)}
									Reset
								</Button>
								<Button size="sm" disabled={busy} onClick={handleSave}>
									{save.isPending ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<Save className="size-4" />
									)}
									Save
								</Button>
							</>
						) : null}
					</div>
				</header>

				<div className="min-h-0 flex-1 overflow-auto p-4">
					{isPending ? (
						<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Loading template…
						</div>
					) : isError ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-destructive">
							<TriangleAlert className="size-5" />
							<p>Failed to load template.</p>
							<p className="max-w-md text-center text-xs text-muted-foreground">
								{error instanceof Error ? error.message : "Unknown error"}
							</p>
						</div>
					) : mode === "json" ? (
						<JsonEditor
							value={jsonText}
							onChange={(v) => {
								setJsonText(v);
								setDirty(true);
								setJsonError(null);
							}}
							error={jsonError}
							readOnly={!isAdmin}
						/>
					) : (
						<FormEditor
							rows={rows}
							readOnly={!isAdmin}
							onChange={(next) => {
								setRows(next);
								setDirty(true);
							}}
						/>
					)}
				</div>

				{!isAdmin ? (
					<footer className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
						Read-only — only administrators can edit the extraction template.
					</footer>
				) : dirty ? (
					<footer className="flex shrink-0 items-center gap-1.5 border-t px-4 py-2 text-xs text-amber-600">
						<TriangleAlert className="size-3.5" />
						Unsaved changes
					</footer>
				) : null}
			</div>
		</div>
	);
}

// ── Form mode ──

function FormEditor({
	rows,
	readOnly,
	onChange,
}: {
	rows: EditorRow[];
	readOnly: boolean;
	onChange: (rows: EditorRow[]) => void;
}) {
	function update(id: string, patch: Partial<EditorRow>) {
		onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	}
	function remove(id: string) {
		onChange(rows.filter((r) => r.id !== id));
	}
	function add() {
		onChange([
			...rows,
			{ id: nextRowId(), name: "", type: "actor", tokens: [] },
		]);
	}

	return (
		<div className="flex flex-col gap-3">
			{rows.map((row) => (
				<EntryCard
					key={row.id}
					row={row}
					readOnly={readOnly}
					onChange={(patch) => update(row.id, patch)}
					onRemove={() => remove(row.id)}
				/>
			))}
			{!readOnly ? (
				<Button variant="outline" className="self-start" onClick={add}>
					<Plus className="size-4" />
					Add entry
				</Button>
			) : null}
		</div>
	);
}

function EntryCard({
	row,
	readOnly,
	onChange,
	onRemove,
}: {
	row: EditorRow;
	readOnly: boolean;
	onChange: (patch: Partial<EditorRow>) => void;
	onRemove: () => void;
}) {
	const [tokenDraft, setTokenDraft] = useState("");

	function commitToken() {
		const value = tokenDraft.trim();
		if (!value) return;
		if (!row.tokens.includes(value))
			onChange({ tokens: [...row.tokens, value] });
		setTokenDraft("");
	}

	return (
		<div className="flex flex-col gap-2.5 rounded-lg border bg-background/40 p-3">
			<div className="flex items-center gap-2">
				<Input
					value={row.name}
					disabled={readOnly}
					placeholder="entry_name"
					className="h-8 max-w-xs font-mono text-sm"
					onChange={(e) => onChange({ name: e.target.value })}
				/>
				<Select
					value={row.type}
					disabled={readOnly}
					onValueChange={(v) => onChange({ type: v as EntryType })}
				>
					<SelectTrigger className="h-8 w-32">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{ENTRY_TYPES.map((t) => (
							<SelectItem key={t} value={t}>
								{t}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Badge
					variant="secondary"
					className={cn("font-normal", TYPE_BADGE[row.type])}
				>
					{row.tokens.length} tokens
				</Badge>
				{!readOnly ? (
					<Button
						size="icon"
						variant="ghost"
						className="ml-auto size-7 text-destructive hover:text-destructive"
						aria-label="Remove entry"
						onClick={onRemove}
					>
						<X className="size-4" />
					</Button>
				) : null}
			</div>

			<div className="flex flex-wrap gap-1.5">
				{row.tokens.map((token) => (
					<Badge key={token} variant="secondary" className="gap-1 font-normal">
						{token}
						{!readOnly ? (
							<button
								type="button"
								aria-label={`Remove ${token}`}
								className="text-muted-foreground hover:text-foreground"
								onClick={() =>
									onChange({ tokens: row.tokens.filter((t) => t !== token) })
								}
							>
								<X className="size-3" />
							</button>
						) : null}
					</Badge>
				))}
				{!readOnly ? (
					<Input
						value={tokenDraft}
						placeholder="add token + Enter"
						className="h-7 w-40 text-xs"
						onChange={(e) => setTokenDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === ",") {
								e.preventDefault();
								commitToken();
							}
						}}
						onBlur={commitToken}
					/>
				) : null}
			</div>
		</div>
	);
}

// ── JSON mode ──

function JsonEditor({
	value,
	onChange,
	error,
	readOnly,
}: {
	value: string;
	onChange: (v: string) => void;
	error: string | null;
	readOnly: boolean;
}) {
	const lineCount = useMemo(() => value.split("\n").length, [value]);
	return (
		<div className="flex h-full flex-col gap-2">
			<Textarea
				value={value}
				readOnly={readOnly}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				className={cn(
					"min-h-96 flex-1 resize-none font-mono text-xs leading-relaxed",
					error && "border-destructive",
				)}
			/>
			{error ? (
				<p className="flex items-center gap-1.5 text-xs text-destructive">
					<TriangleAlert className="size-3.5 shrink-0" />
					{error}
				</p>
			) : (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Check className="size-3.5 shrink-0 text-green-600" />
					{lineCount} lines
				</p>
			)}
		</div>
	);
}
