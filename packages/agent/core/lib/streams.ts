import { DurableStream } from "@durable-streams/client";
import { runStreamUrl, type Message } from "@repo/streams-protocol";

/**
 * Thin wrapper around `@durable-streams/client` for the agent's producer side.
 *
 * Each agent run gets one append-only JSON stream at `/v1/stream/run-{runId}`.
 * The agent appends typed {@link Message} events as it streams, then closes the
 * stream (EOF) when the run finishes so consumers know no more data is coming.
 *
 * Streams are per-run rather than per-task: a durable stream's close is
 * terminal, so reusing a per-task path would 409 ("Stream is closed") on the
 * second run. A fresh run id means a fresh stream every time.
 */
/**
 * Bound every stream request. The client's default backoff retries network
 * errors and 429/503 FOREVER (maxRetries: Infinity), and appends serialize
 * through a concurrency-1 queue — so with the streams service unreachable,
 * one append's await never settles and every later emit queues behind it.
 * On an AgentCore runtime that silent hang keeps the segment promise
 * pending, /ping reports HealthyBusy, and the session idles to its 8h max
 * lifetime, billed the whole time. These caps turn that into a few seconds
 * of retries followed by a thrown error, which append() already treats as
 * "drop the event and warn" (Postgres is the source of truth; the live
 * stream is UX telemetry).
 */
const STREAM_BACKOFF = {
  initialDelay: 200,
  maxDelay: 5_000,
  multiplier: 1.5,
  maxRetries: 4,
};

/** Per-append deadline (covers a socket-level stall within one attempt). */
const APPEND_TIMEOUT_MS = 30_000;

/** Deadline for creating/connecting the stream handle. */
const CONNECT_TIMEOUT_MS = 15_000;

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class TaskStreamWriter {
  private handlePromise: Promise<DurableStream> | null = null;
  private closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly runId: string
  ) {}

  private get url(): string {
    return runStreamUrl(this.baseUrl, this.runId);
  }

  /**
   * Lazily create (or connect to) the durable stream. Creating a stream that
   * already exists is treated as connecting to it (e.g. a retried run). A
   * failed connect is NOT cached — the next append retries from scratch, so
   * one bad attempt can't wedge the writer for the rest of the run.
   */
  private async getHandle(): Promise<DurableStream> {
    if (!this.handlePromise) {
      this.handlePromise = this.ensureStream();
      this.handlePromise.catch(() => {
        this.handlePromise = null;
      });
    }
    return this.handlePromise;
  }

  private async ensureStream(): Promise<DurableStream> {
    try {
      return await DurableStream.create({
        url: this.url,
        contentType: "application/json",
        // The handle constructor reads backoffOptions for create too; the
        // published CreateOptions type just doesn't declare it (connect's
        // DurableStreamOptions does).
        backoffOptions: STREAM_BACKOFF,
      } as Parameters<typeof DurableStream.create>[0]);
    } catch {
      // Stream already exists (e.g. a retry of this run) — connect to it.
      return DurableStream.connect({
        url: this.url,
        backoffOptions: STREAM_BACKOFF,
      });
    }
  }

  /**
   * Append a typed event to the stream. Best-effort: the live stream is UX
   * telemetry, Postgres is the source of truth — an append failure must never
   * fail the run. A 409 means the stream was closed (terminal), so further
   * appends are skipped.
   */
  async append(message: Message): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const handle = await withDeadline(
        this.getHandle(),
        CONNECT_TIMEOUT_MS,
        `stream connect (run-${this.runId})`,
      );
      // The abort signal is checked between backoff retries, so it also
      // bounds the retry loop — not just the in-flight request.
      await handle.append(JSON.stringify(message), {
        signal: AbortSignal.timeout(APPEND_TIMEOUT_MS),
      });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 409) {
        this.closed = true;
      }
      console.warn(
        `[stream run-${this.runId}] append dropped${status ? ` (HTTP ${status})` : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Close the stream (EOF). Idempotent — safe to call multiple times. After
   * this, consumers receive `streamClosed: true` and stop tailing.
   *
   * Close is TERMINAL for a durable stream, so this must only be called when
   * the run itself is terminal — never at the end of a non-final segment
   * (yield/resume runs append to the same stream across segments).
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      const handle = await withDeadline(
        this.getHandle(),
        CONNECT_TIMEOUT_MS,
        `stream connect (run-${this.runId})`,
      );
      await handle.close({ signal: AbortSignal.timeout(APPEND_TIMEOUT_MS) });
    } catch {
      // Best-effort: a missing/already-closed stream is fine.
    }
  }
}

/**
 * Best-effort EOF for a run's durable stream. Used by the run processors when
 * a run reaches terminal status (succeeded/failed/cancelled) so tailing
 * consumers stop, including on paths where no writer was ever constructed
 * this segment (deadline/budget rejections, sweeper kills).
 */
export async function closeRunStream(
  runId: string,
  baseUrl: string = process.env.STREAMS_URL ?? "http://localhost:4437",
): Promise<void> {
  await new TaskStreamWriter(baseUrl, runId).close();
}

/**
 * Append terminal `error` + `finish` events to a run's durable stream on
 * behalf of a dead executor. When an AgentCore session is terminated (or the
 * worker crashes) the run's own runtime never emits its terminal events, so
 * tailing consumers see a stream that just stops — tool chips keep spinning
 * and `isStreaming` stays true. The sweeper calls this before EOF-ing the
 * stream so the UI reducer processes a real terminal event. Best-effort: the
 * stream may already be closed (409) or gone, and Postgres remains the
 * source of truth either way.
 */
export async function appendRunFailureEvents(args: {
  runId: string;
  rootRunId: string;
  message: string;
  baseUrl?: string;
}): Promise<void> {
  const baseUrl =
    args.baseUrl ?? process.env.STREAMS_URL ?? "http://localhost:4437";
  const writer = new TaskStreamWriter(baseUrl, args.runId);
  await writer.append({
    event_type: "error",
    taskId: args.rootRunId,
    runId: args.runId,
    data: { message: args.message },
  });
  await writer.append({
    event_type: "finish",
    taskId: args.rootRunId,
    runId: args.runId,
    data: { runId: args.runId, reason: "error" },
  });
}
