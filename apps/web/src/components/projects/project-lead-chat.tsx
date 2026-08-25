"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowUp, Check, Copy, Crown, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	createElement,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { AgentMarkdown } from "@/components/tasks/agent-markdown";
import { Metrics } from "@/components/tasks/metrics";
import {
	statusIcon,
	statusIconClass,
	getToolIcon as toolIcon,
} from "@/components/tasks/tool-display";
import type {
	AssistantMessage,
	ChatMessage,
	MetricsPart,
} from "@/components/tasks/types";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@/components/ui/input-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { client } from "@/orpc/client";

import { useLeadMessages } from "./use-lead-messages";
import { useTaskStream } from "./use-task-stream";

/** Defer Electric subscriptions until after hydration (client-only sync). */
function useIsHydrated() {
	return useSyncExternalStore(
		() => () => {},
		() => true,
		() => false,
	);
}

export function ProjectLeadChat({
	messages,
	projectId,
	leadTaskId,
	live = false,
}: {
	messages: ChatMessage[];
	projectId?: string;
	leadTaskId?: string | null;
	live?: boolean;
}) {
	const hydrated = useIsHydrated();

	if (live && projectId && hydrated) {
		return (
			<LiveLeadChat projectId={projectId} initialTaskId={leadTaskId ?? null} />
		);
	}

	return (
		<LeadChatShell
			messages={messages}
			isThinking={false}
			composer={<Composer disabled onSend={() => {}} sending={false} />}
		/>
	);
}

function LiveLeadChat({
	projectId,
	initialTaskId,
}: {
	projectId: string;
	initialTaskId: string | null;
}) {
	const t = useTranslations("Projects");

	// The thread is created lazily by the first send; adopt the returned id so
	// the Electric subscription starts without a reload.
	const [taskId, setTaskId] = useState<string | null>(initialTaskId);
	const { messages, isThinking, pendingRunId } = useLeadMessages(taskId);

	const [submittedRunId, setSubmittedRunId] = useState<string | null>(null);

	// `pendingRunId` is derived from the trailing persisted row, so it flips
	// back to `null` the instant the worker persists its first assistant block
	// — even though the run is still streaming (metrics + terminal `finish`
	// are emitted last). Latch the run id being tailed in `watchedRunId` and
	// only release it once the live stream reports the run finished, so we
	// don't tear the stream down mid-run.
	const [watchedRunId, setWatchedRunId] = useState<string | null>(null);
	const activeRunId = submittedRunId ?? pendingRunId ?? watchedRunId;

	const live = useTaskStream(activeRunId, taskId ? { taskId } : null);

	useEffect(() => {
		const recovered = submittedRunId ?? pendingRunId;
		if (recovered && recovered !== watchedRunId) {
			setWatchedRunId(recovered);
		}
	}, [submittedRunId, pendingRunId, watchedRunId]);

	useEffect(() => {
		// Release the latched run once it has genuinely finished: the live
		// stream is idle (terminal `finish` applied) and history has synced.
		// Clears the local submit id too so a future run can latch cleanly.
		if (
			watchedRunId &&
			watchedRunId !== pendingRunId &&
			!live.isStreaming &&
			messages.length > 0
		) {
			setWatchedRunId(null);
			if (submittedRunId === watchedRunId) {
				setSubmittedRunId(null);
			}
		}
	}, [
		submittedRunId,
		watchedRunId,
		pendingRunId,
		live.isStreaming,
		messages.length,
	]);

	const sendMutation = useMutation({
		mutationFn: (message: string) =>
			client.projects.lead.send({ projectId, message }),
		onSuccess: (result) => {
			setTaskId(result.taskId);
			setSubmittedRunId(result.runId);
		},
		onError: (error: Error) => toast.error(error.message),
	});

	// Show the live (streaming) assistant only while the reply hasn't been
	// persisted yet — i.e. the trailing history row is still the user's
	// message. Once the assistant rows sync from Electric, the persisted copy
	// is the source of truth; rendering both would duplicate the reply (the
	// run can still be "streaming" briefly while it emits trailing
	// metrics/finish events).
	const liveAssistant = live.isStreaming && isThinking ? live.assistant : null;

	const intro: ChatMessage[] =
		messages.length === 0
			? [
					{
						id: "lead-intro",
						role: "assistant",
						parts: [{ type: "text", text: t("leadIntro") }],
					},
				]
			: [];

	const busy = isThinking || sendMutation.isPending || live.isStreaming;

	return (
		<LeadChatShell
			messages={[...intro, ...messages]}
			liveAssistant={liveAssistant}
			// Spinner only before the first delta arrives; once tokens stream in,
			// the live assistant itself is the progress indicator.
			isThinking={(isThinking || sendMutation.isPending) && !liveAssistant}
			// Re-run resubmits the turn's user message as a fresh send (the lead
			// keeps its thread memory, so this reads as "try that again").
			onResend={busy ? undefined : (text) => sendMutation.mutate(text)}
			composer={
				<Composer
					disabled={busy}
					sending={sendMutation.isPending}
					onSend={(text) => sendMutation.mutate(text)}
				/>
			}
		/>
	);
}

function LeadChatShell({
	messages,
	liveAssistant = null,
	isThinking,
	composer,
	onResend,
}: {
	messages: ChatMessage[];
	/** In-progress assistant message tailed from the run's durable stream. */
	liveAssistant?: AssistantMessage | null;
	isThinking: boolean;
	composer: React.ReactNode;
	/** Resubmit a previous user message (undefined while busy / non-live). */
	onResend?: (text: string) => void;
}) {
	const t = useTranslations("Projects");
	const scrollRef = useRef<HTMLDivElement>(null);

	// Track streamed content growth so the view follows the tokens, not just
	// whole messages.
	const liveSize = liveAssistant
		? liveAssistant.parts.reduce(
				(n, part) => n + (part.type === "text" ? part.text.length : 1),
				0,
			)
		: 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length, isThinking, liveSize]);

	// Each assistant turn's re-run resubmits the user message that produced it.
	let lastUserText: string | null = null;

	return (
		<div className="flex h-full flex-col overflow-hidden bg-background/40">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
				<Crown
					className="size-3.5 shrink-0 text-emerald-500"
					strokeWidth={1.75}
					aria-hidden
				/>
				<span className="text-sm font-medium text-foreground">
					{t("projectLead")}
				</span>
			</div>

			<div
				ref={scrollRef}
				className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto"
			>
				<div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 py-5">
					{messages.map((message) => {
						if (message.role === "user") {
							lastUserText = message.text;
							return <MessageItem key={message.id} message={message} />;
						}
						const sourceText = lastUserText;
						return (
							<MessageItem
								key={message.id}
								message={message}
								onRerun={
									onResend && sourceText
										? () => onResend(sourceText)
										: undefined
								}
							/>
						);
					})}
					{liveAssistant ? (
						<MessageItem message={liveAssistant} isStreaming />
					) : null}
					{isThinking ? (
						<div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" />
							{t("leadThinking")}
						</div>
					) : null}
				</div>
			</div>

			<div className="mt-auto shrink-0 px-4 pb-4">
				<div className="mx-auto max-w-2xl">{composer}</div>
			</div>
		</div>
	);
}

function Composer({
	disabled,
	sending,
	onSend,
}: {
	disabled: boolean;
	sending: boolean;
	onSend: (text: string) => void;
}) {
	const t = useTranslations("Projects");
	const [value, setValue] = useState("");

	const submit = () => {
		const text = value.trim();
		if (!text || sending || disabled) return;
		onSend(text);
		setValue("");
	};

	return (
		<InputGroup className={cn(disabled && "opacity-90")}>
			<InputGroupTextarea
				placeholder={t("composer.placeholder")}
				disabled={disabled}
				rows={2}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			<InputGroupAddon align="block-end">
				<span className="text-[11px] text-muted-foreground/70">
					{t("projectLead")}
				</span>
				<InputGroupButton
					size="icon-sm"
					variant="default"
					className="ml-auto"
					disabled={disabled || sending || value.trim().length === 0}
					onClick={submit}
					aria-label={t("composer.send")}
				>
					{sending ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<ArrowUp className="size-4" />
					)}
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}

function MessageItem({
	message,
	isStreaming = false,
	onRerun,
}: {
	message: ChatMessage;
	isStreaming?: boolean;
	/** Resubmit the user message that produced this assistant turn. */
	onRerun?: () => void;
}) {
	if (message.role === "user") {
		return (
			<div className="flex flex-col items-end py-2">
				<div className="w-fit max-w-[85%] rounded-lg border border-zinc-200 bg-zinc-100 px-3.5 py-2 text-xs leading-relaxed text-foreground dark:border-zinc-700 dark:bg-zinc-800">
					{message.text}
				</div>
			</div>
		);
	}

	// Metrics render as a footer under the turn, not inline among the parts.
	const metrics = message.parts.find(
		(part): part is MetricsPart => part.type === "metrics",
	);
	const parts = message.parts.filter((part) => part.type !== "metrics");

	const responseText = parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n\n")
		.trim();

	return (
		<div className="py-2">
			{parts.map((part, index) => {
				if (part.type === "text") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a persisted message
						<AgentMarkdown
							key={index}
							isAnimating={isStreaming && part.streaming === true}
						>
							{part.text}
						</AgentMarkdown>
					);
				}
				if (part.type !== "tool") return null;
				const icon = toolIcon(part.toolName);
				const status = statusIcon(part.status);
				return (
					<div key={part.stepId} className="my-3 flex items-center gap-1.5">
						<div className="flex w-fit max-w-[420px] items-center gap-1.5 rounded-md border border-input bg-muted px-2 py-1 text-muted-foreground">
							{createElement(icon, { className: "size-3.5 shrink-0" })}
							<span className="min-w-0 truncate text-xs text-foreground">
								{part.label}
								{part.description ? (
									<span className="ml-2 font-light text-muted-foreground">
										{part.description}
									</span>
								) : null}
							</span>
							{createElement(status, {
								className: cn(
									"ml-2 size-3.5 shrink-0",
									statusIconClass(part.status),
								),
							})}
						</div>
					</div>
				);
			})}
			{!isStreaming && (metrics || responseText || onRerun) ? (
				<div className="flex items-center gap-2">
					{metrics ? <Metrics metrics={metrics} /> : null}
					<div className="flex items-center text-muted-foreground/50">
						{responseText ? <CopyButton text={responseText} /> : null}
						{onRerun ? <RerunButton onRerun={onRerun} /> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}

function CopyButton({ text }: { text: string }) {
	const t = useTranslations("Projects.messageActions");
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		};
	}, []);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			if (resetTimer.current) clearTimeout(resetTimer.current);
			resetTimer.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error(t("copyFailed"));
		}
	};

	return (
		<Tooltip>
			<TooltipTrigger
				onClick={copy}
				aria-label={t("copy")}
				className="rounded p-1 transition-colors hover:bg-muted hover:text-foreground"
			>
				{copied ? (
					<Check className="size-3 text-emerald-500" />
				) : (
					<Copy className="size-3" />
				)}
			</TooltipTrigger>
			<TooltipContent side="top">
				{copied ? t("copied") : t("copy")}
			</TooltipContent>
		</Tooltip>
	);
}

function RerunButton({ onRerun }: { onRerun: () => void }) {
	const t = useTranslations("Projects.messageActions");

	return (
		<Tooltip>
			<TooltipTrigger
				onClick={onRerun}
				aria-label={t("rerun")}
				className="rounded p-1 transition-colors hover:bg-muted hover:text-foreground"
			>
				<RefreshCw className="size-3" />
			</TooltipTrigger>
			<TooltipContent side="top">{t("rerun")}</TooltipContent>
		</Tooltip>
	);
}
