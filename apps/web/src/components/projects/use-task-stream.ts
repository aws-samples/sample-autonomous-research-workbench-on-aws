"use client";

import { type StreamResponse, stream } from "@durable-streams/client";
import {
	type Message,
	runStreamUrl,
	validateMessage,
} from "@repo/streams-protocol";
import { useEffect, useRef, useState } from "react";

import type {
	AssistantMessage,
	AssistantPart,
	TextPart,
	ToolPart,
} from "@/components/tasks/types";
import { SERVICE_URL } from "@/lib/config";

import { TOOL_LABEL } from "./use-lead-messages";

// The browser reads streams through the authenticated API proxy
// (`/v1/stream/run-{runId}` in apps/api), never the streams server directly.
// `runStreamUrl` appends the `/v1/stream/run-{runId}` path, so the base is
// just the API service origin.

// Carry the Better Auth session cookie on the stream request so the proxy can
// authenticate and authorize. Mirrors `syncFetch` for the Electric proxy.
const streamFetch: typeof fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
		fetch(input, { ...init, credentials: "include" }),
	{ preconnect: globalThis.fetch?.preconnect ?? (() => {}) },
);

/**
 * Live view model derived from the durable stream for a single agent run.
 *
 * - `assistant` is the in-progress assistant message reconstructed from
 *   text/tool deltas, with parts kept in arrival order. It is `null` until
 *   the run starts emitting.
 * - `isStreaming` is true between a `start` event and the terminal
 *   `finish`/`error`.
 */
export interface TaskStreamState {
	assistant: AssistantMessage | null;
	isStreaming: boolean;
	runId: string | null;
}

const EMPTY_STATE: TaskStreamState = {
	assistant: null,
	isStreaming: false,
	runId: null,
};

/**
 * Internal mutable accumulator. Parts are stored in arrival order. We track
 * the *currently open* text part per stream id so deltas append to the right
 * part, and a part's position is fixed at its `text-start` event. The open
 * entry is cleared on `text-end`, so when a later step reuses the same id
 * (the SDK numbers content blocks per step, so ids recur after a tool call)
 * the next start opens a fresh part instead of growing the earlier one.
 *
 * Reasoning deltas are skipped — the lead chat renders final answers only
 * (the persisted mapping in `use-lead-messages.ts` skips them too). Metrics
 * are also skipped here: they render from persisted history.
 */
interface Accumulator {
	runId: string | null;
	isStreaming: boolean;
	parts: AssistantPart[];
	/** Open text parts by stream id (cleared on text-end). */
	activeText: Map<string, TextPart>;
	/** Tool parts by toolCallId, so results update the right chip. */
	toolParts: Map<string, ToolPart>;
}

function freshAccumulator(): Accumulator {
	return {
		runId: null,
		isStreaming: false,
		parts: [],
		activeText: new Map(),
		toolParts: new Map(),
	};
}

function toState(acc: Accumulator): TaskStreamState {
	if (acc.parts.length === 0 && !acc.isStreaming) {
		return { ...EMPTY_STATE, runId: acc.runId };
	}
	return {
		assistant:
			acc.parts.length > 0
				? {
						id: `live-${acc.runId ?? "run"}`,
						role: "assistant",
						// Shallow-copy parts so React sees new references on each batch.
						parts: acc.parts.map((part) => ({ ...part })),
					}
				: null,
		isStreaming: acc.isStreaming,
		runId: acc.runId,
	};
}

function startText(acc: Accumulator, id: string): void {
	const part: TextPart = { type: "text", text: "", streaming: true };
	acc.activeText.set(id, part);
	acc.parts.push(part);
}

function appendTextDelta(acc: Accumulator, id: string, delta: string): void {
	const part = acc.activeText.get(id);
	if (part) {
		part.text += delta;
		return;
	}
	// Missed the start event: open a new part now so order is still preserved.
	const created: TextPart = { type: "text", text: delta, streaming: true };
	acc.activeText.set(id, created);
	acc.parts.push(created);
}

function markTextEnd(acc: Accumulator, id: string): void {
	const part = acc.activeText.get(id);
	if (part) {
		part.streaming = false;
		acc.activeText.delete(id);
	}
}

function startTool(
	acc: Accumulator,
	toolCallId: string,
	toolName: string,
): void {
	if (acc.toolParts.has(toolCallId)) return;
	const part: ToolPart = {
		type: "tool",
		stepId: toolCallId,
		toolName,
		label: TOOL_LABEL[toolName] ?? toolName,
		status: "running",
	};
	acc.toolParts.set(toolCallId, part);
	acc.parts.push(part);
}

function finishTool(acc: Accumulator, toolCallId: string): void {
	const part = acc.toolParts.get(toolCallId);
	if (part) {
		part.status = "completed";
	}
}

/**
 * Close every tool chip still marked running. A chip normally closes on its
 * `tool-result`, but that event never arrives when the executor dies mid-call
 * (AgentCore session terminated, worker crash) or when a retry starts a new
 * segment on the same stream. Without this, the chip spins forever even
 * though the run is over.
 */
function closeOrphanedTools(
	acc: Accumulator,
	status: "completed" | "error",
): void {
	for (const part of acc.toolParts.values()) {
		if (part.status === "running") {
			part.status = status;
		}
	}
}

/**
 * Reduce a single typed stream message into the accumulator. Returns true if
 * the run finished (terminal event) so the caller can stop.
 */
function reduce(acc: Accumulator, msg: Message): boolean {
	switch (msg.event_type) {
		case "start":
			// A second `start` on the same stream is a retry segment (the worker
			// appends attempts to one durable stream). Any tool still running
			// belongs to the dead previous attempt — close it as errored.
			closeOrphanedTools(acc, "error");
			acc.runId = msg.data.runId;
			acc.isStreaming = true;
			return false;
		case "text-start":
			startText(acc, msg.id);
			return false;
		case "text-delta":
			appendTextDelta(acc, msg.id, msg.delta);
			return false;
		case "text-end":
			markTextEnd(acc, msg.id);
			return false;
		case "tool-input-start":
			startTool(acc, msg.toolCallId, msg.toolName);
			return false;
		case "tool-result":
			finishTool(acc, msg.toolCallId);
			return false;
		case "finish":
			// A clean finish with a tool still open means its result event was
			// lost (e.g. dropped append) — close it rather than spin forever.
			closeOrphanedTools(acc, "completed");
			acc.isStreaming = false;
			return true;
		case "error":
			closeOrphanedTools(acc, "error");
			acc.isStreaming = false;
			return true;
		default:
			// reasoning-*, tool-input-delta, metrics, suggestions: no view change.
			return false;
	}
}

/**
 * Authorization scope the API stream proxy checks before forwarding the
 * read: task-owned runs (chat threads) pass the owning `taskId`;
 * project-scoped runs (persona agent orchestrators, prospect intake) pass
 * the owning `projectId`.
 */
export type StreamScope =
	| { taskId: string; projectId?: undefined }
	| { projectId: string; taskId?: undefined };

/**
 * Subscribe to a single run's durable stream and expose the live,
 * in-progress assistant message. Streams are per-run, so the caller passes
 * the active `runId` (from the send mutation, recovered from the trailing
 * persisted user message's `metadata.runId`, or the roster row's
 * `activeRunId`) plus the {@link StreamScope} the API proxy uses to
 * authorize the read. Persisted history comes separately from Electric SQL.
 */
export function useTaskStream(
	runId: string | null,
	scope: StreamScope | null,
): TaskStreamState {
	const [state, setState] = useState<TaskStreamState>(EMPTY_STATE);
	const accRef = useRef<Accumulator>(freshAccumulator());

	// Effect deps must be primitives — callers pass fresh scope objects every
	// render.
	const taskId = scope?.taskId ?? null;
	const projectId = scope?.projectId ?? null;

	useEffect(() => {
		if (!runId || (!taskId && !projectId) || typeof window === "undefined") {
			setState(EMPTY_STATE);
			return;
		}

		accRef.current = freshAccumulator();

		let response: StreamResponse<Message> | null = null;
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;
		let didReset = false;

		// Reset the visible state to empty when the run changes. Done lazily (not
		// synchronously in the effect body) to avoid cascading renders; the first
		// delta callback overwrites it anyway.
		const resetState = () => {
			if (didReset) return;
			didReset = true;
			setState(EMPTY_STATE);
		};

		const subscribe = (res: StreamResponse<Message>) => {
			resetState();
			unsubscribe = res.subscribeJson(async (batch) => {
				const acc = accRef.current;
				for (const item of batch.items) {
					const msg = validateMessage(item);
					if (msg) {
						reduce(acc, msg);
					}
				}
				setState(toState(acc));
			});
		};

		// On a brand-new run, the producer (the run executor) may not have
		// created the durable stream yet by the time we try to tail it: the send
		// mutation returns the run id before the dispatched executor picks the
		// run up, so `stream()` 404s. Retry with backoff until the stream
		// exists, so live tokens show on the *first* message — not only after a
		// reload. The budget is bounded: if the stream never appears (run
		// already finished and cleaned up, streams server restarted), give up
		// quietly instead of spamming 404s forever.
		const MAX_ATTEMPTS = 16; // ~8s at 500ms — covers worker pickup latency.
		const RETRY_MS = 500;

		const connect = async () => {
			for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
				try {
					response = await stream<Message>({
						url: runStreamUrl(SERVICE_URL, runId),
						// Tail from the start of the run so we don't miss early deltas,
						// then follow live via SSE.
						offset: "-1",
						live: "sse",
						// Authenticate via the session cookie and let the proxy
						// authorize the read against task/project ownership.
						fetch: streamFetch,
						params: taskId ? { taskId } : projectId ? { projectId } : {},
					});
				} catch {
					// Stream not created yet — wait and retry.
					await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
					continue;
				}

				if (cancelled) {
					response.cancel("unmounted");
					return;
				}

				subscribe(response);
				return;
			}
		};

		void connect();

		return () => {
			cancelled = true;
			unsubscribe?.();
			response?.cancel("unmounted");
		};
	}, [runId, taskId, projectId]);

	return state;
}
