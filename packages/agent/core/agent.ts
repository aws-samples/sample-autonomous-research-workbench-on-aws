import {
  createAmazonBedrock,
  type BedrockProviderOptions,
} from "@ai-sdk/amazon-bedrock";
import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

// Resolve AWS credentials via the standard provider chain (env vars, shared
// config, and crucially the ECS task role via the container metadata endpoint).
// Without this the Bedrock provider only looks for static AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY env vars and fails under an ECS task role.
const credentialProvider = fromNodeProviderChain();

// Prefer SigV4 credentials over a Bedrock bearer token. @ai-sdk/amazon-bedrock
// uses bearer-token auth whenever AWS_BEARER_TOKEN_BEDROCK is set, and then
// IGNORES the credentialProvider below. Locally a shell may export BOTH a
// (region-scoped, often invalid) bearer token AND working SSO creds, which makes
// the worker 403 even though SigV4 would succeed; in production only the ECS
// task role exists. So if the SigV4 chain resolves, drop the bearer token to
// force SigV4; otherwise leave it in place as a fallback.
if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
  try {
    await credentialProvider();
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  } catch {
    // No SigV4 credentials resolvable — keep the bearer token as the fallback.
  }
}

const bedrock = createAmazonBedrock({ credentialProvider });
const bedrockAnthropic = createBedrockAnthropic({ credentialProvider });
import { anthropic, type AnthropicProviderOptions } from "@ai-sdk/anthropic";
import {
  smoothStream,
  streamText,
  type TextStreamPart,
  type Tool,
  type ToolSet,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import Tokenizer, { models } from "ai-tokenizer";
import * as encoding from "ai-tokenizer/encoding";
import { count } from "ai-tokenizer/sdk";
import {
  getModel,
  isAdaptiveReasoningModelId,
  type ModelId,
  type ReasoningEffort,
} from "./config";
import type { ConversationManager } from "./conversation-manager";
import { calculateCost, type TokenUsage } from "./cost-calculation";
import { generateSuggestions } from "./lib/suggestions";
import {
  createStopSignalPoller,
  type StopSignalConfig,
  type StopSignalPoller,
} from "./lib/stop-signal";
import type { AgentRuntime, RunMetrics } from "./runtime";
import { agentToolTimeoutMs, withToolTimeout } from "./tool-timeout";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageContent,
  ToolMessage,
} from "./types";

export type AgentConfig = {
  /** The model to use for the agent. */
  modelId: ModelId;

  /** The system prompt to use for the agent. */
  systemPrompt?: string;

  /** The maximum number of tokens to use for the agent. */
  maxTokens?: number;

  /** Whether to enable reasoning. */
  reasoningEnabled?: boolean;

  /** Budget tokens for extended thinking/reasoning. Used with budget-mode models. */
  reasoningBudgetTokens?: number;

  /** Effort level for adaptive thinking. Used with adaptive-mode models. */
  reasoningEffort?: ReasoningEffort;

  /** The task ID this agent run belongs to. */
  taskId?: string;

  /**
   * Tools available to the agent. When omitted, the agent runs with no tools.
   * The worker wires in the default tool set (see `@repo/agent` `defaultTools`).
   */
  tools?: Record<string, Tool>;

  /**
   * The runtime implementation that handles external interactions.
   * - ConsoleRuntime: For local testing with console output
   * - StreamRuntime: For production with DB + Electric Streams
   */
  runtime: AgentRuntime;

  /**
   * Optional conversation manager for history management.
   * When provided, trims agentHistory to keep context bounded.
   */
  conversationManager?: ConversationManager;

  /**
   * Optional cooperative stop signal. When provided, a background poller
   * aborts the run mid-stream as soon as `check()` reports true (e.g. the
   * run row was cancelled), instead of letting the turn run to completion.
   */
  stopSignal?: StopSignalConfig;

  /**
   * Extra values merged into each tool's `experimental_context` alongside the
   * `{ taskId, runId }` the loop always provides. Used to inject non-persisted
   * dependencies a tool needs at call time — e.g. the `spawnSubAgent` function
   * that backs the `run_subagent` tool.
   */
  experimentalContext?: Record<string, unknown>;
};

export type RunArgs = {
  message: string;
  messageMetadata?: Record<string, unknown>;
  /** Optional run ID. If not provided, a new ID is generated. */
  runId?: string;
};

/** Reason why the agent run ended */
export type StopReason =
  | { type: "completed" }
  | { type: "stopped" }
  | { type: "error"; error: Error };

export type RunResult = {
  runId: string;
  stopReason: StopReason;
};

/** Generate a unique run identifier. */
export const generateRunId = (): string =>
  `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Type for messages with cache checkpoint provider options.
 */
type MessageWithCacheOptions = {
  role: string;
  content: unknown;
  providerOptions?: {
    bedrock?: { cachePoint?: { type: string } };
    anthropic?: { cacheControl?: { type: string } };
    [key: string]: unknown;
  };
};

/**
 * Replace characters that PostgreSQL JSONB cannot store:
 * - \u0000 (null byte) is rejected outright by PostgreSQL
 * - Lone UTF-16 surrogates are invalid
 */
export function sanitizeUnicodeString(value: string): string {
  let output = "";

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0) {
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(i, i + 2);
        i++;
      } else {
        output += "\uFFFD";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
      continue;
    }

    output += value.charAt(i);
  }

  return output;
}

export function sanitizeForJson<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeUnicodeString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item)) as T;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      sanitized[key] = sanitizeForJson(nested);
    }
    return sanitized as T;
  }

  return value;
}

function addCheckpoint(
  message: MessageWithCacheOptions,
  provider: "bedrock" | "anthropic"
): void {
  if (provider === "bedrock") {
    message.providerOptions = {
      ...message.providerOptions,
      bedrock: {
        ...message.providerOptions?.bedrock,
        cachePoint: { type: "default" },
      },
    };
  } else {
    message.providerOptions = {
      ...message.providerOptions,
      anthropic: {
        ...message.providerOptions?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    };
  }
}

function removeCheckpoint(message: MessageWithCacheOptions): void {
  if (!message.providerOptions) {
    return;
  }

  if (message.providerOptions.bedrock?.cachePoint) {
    delete message.providerOptions.bedrock.cachePoint;
    if (Object.keys(message.providerOptions.bedrock).length === 0) {
      delete message.providerOptions.bedrock;
    }
  }

  if (message.providerOptions.anthropic?.cacheControl) {
    delete message.providerOptions.anthropic.cacheControl;
    if (Object.keys(message.providerOptions.anthropic).length === 0) {
      delete message.providerOptions.anthropic;
    }
  }

  if (Object.keys(message.providerOptions).length === 0) {
    delete message.providerOptions;
  }
}

/**
 * Agent class for running AI agent loops with streaming responses.
 *
 * The Agent delegates all external interactions (DB, streaming, logging) to
 * an injected AgentRuntime, allowing the same agent logic to run in different
 * environments (local testing vs production).
 */
export class Agent {
  public modelId: ModelId;
  public systemPrompt?: string;
  public readonly maxTokens: number;
  public agentHistory: ModelMessage[] = [];
  public readonly messages: AgentMessage[] = [];
  public totalCost = 0.0;
  public readonly reasoningEnabled: boolean = true;
  public readonly reasoningBudgetTokens?: number;
  public readonly reasoningEffort?: ReasoningEffort;
  public readonly taskId?: string;
  public readonly tools: Record<string, Tool>;

  /** The current run ID (set during run()) */
  public currentRunId?: string;

  private provider: string | LanguageModel;
  private modelConfig: ReturnType<typeof getModel>;
  private isActive = true;
  private runtime: AgentRuntime;
  private conversationManager?: ConversationManager;
  private stopSignal?: StopSignalConfig;
  private stopPoller?: StopSignalPoller;
  private wasStopped = false;
  private experimentalContextExtra: Record<string, unknown>;
  /** Track the history length to know which messages are new */
  private historyLength = 0;

  // Accumulators for streaming content
  private currentReasoningText = "";
  private currentTextContent = "";
  private reasoningStartTime: number | null = null;
  private textStartTime: number | null = null;

  // Tool tracking: toolCallId -> { name, input, startTime }
  private toolTracking: Map<
    string,
    { name: string; input: string; startTime: number }
  > = new Map();

  constructor(config: AgentConfig) {
    this.modelId = config.modelId;
    this.systemPrompt = config.systemPrompt;
    this.taskId = config.taskId ?? "";
    this.reasoningEnabled = config.reasoningEnabled ?? false;
    this.modelConfig = getModel(this.modelId);
    this.runtime = config.runtime;
    this.conversationManager = config.conversationManager;
    this.stopSignal = config.stopSignal;
    this.experimentalContextExtra = config.experimentalContext ?? {};
    // Bound every tool call (built-in, persona, and dynamically created
    // orchestration/lead tools all pass through here) so a hung tool resolves
    // with a structured timeout result instead of parking the loop forever.
    const toolTimeoutMs = agentToolTimeoutMs();
    this.tools = withToolTimeout(config.tools ?? {}, toolTimeoutMs, (toolName) =>
      console.error(
        `[tooltrace] run=${this.currentRunId ?? "?"} TIMEOUT ${toolName} after ${toolTimeoutMs}ms`,
      ),
    );

    const reasoningMode = this.getReasoningMode();

    if (reasoningMode === "adaptive") {
      this.reasoningEffort =
        config.reasoningEffort ??
        (this.modelConfig.reasoning?.mode === "adaptive"
          ? this.modelConfig.reasoning.defaultEffort
          : "high");
    } else if (reasoningMode === "budget") {
      this.reasoningBudgetTokens =
        config.reasoningBudgetTokens ??
        (this.modelConfig.reasoning?.mode === "budget"
          ? this.modelConfig.reasoning.defaultBudgetTokens
          : undefined);
    } else if (
      config.reasoningBudgetTokens !== undefined ||
      config.reasoningEffort !== undefined
    ) {
      throw new Error(`Reasoning is not supported for model ${this.modelId}`);
    }

    this.maxTokens = config.maxTokens ?? this.modelConfig.defaultMaxTokens;

    if (
      reasoningMode === "budget" &&
      this.reasoningBudgetTokens !== undefined &&
      this.reasoningEnabled
    ) {
      const totalTokens = this.maxTokens + this.reasoningBudgetTokens;
      if (totalTokens > this.modelConfig.maxTokens) {
        throw new Error(
          `Total tokens (maxTokens: ${this.maxTokens} + reasoningBudgetTokens: ${this.reasoningBudgetTokens} = ${totalTokens}) exceeds model limit of ${this.modelConfig.maxTokens} for ${this.modelId}`
        );
      }
    }

    switch (this.modelConfig.provider) {
      case "bedrock-anthropic":
        this.provider = bedrockAnthropic(
          this.modelConfig.modelId
        ) as LanguageModel;
        break;
      case "bedrock":
        this.provider = bedrock(this.modelConfig.modelId) as LanguageModel;
        break;
      case "anthropic":
        this.provider = anthropic(this.modelConfig.modelId) as LanguageModel;
        break;
      default:
        this.provider = this.modelConfig.modelId;
        break;
    }
  }

  public async run(args: RunArgs): Promise<RunResult> {
    const startTime = Date.now();

    this.isActive = true;
    this.currentRunId = args.runId ?? generateRunId();
    let stopReason: StopReason = { type: "completed" };

    await this.runtime.onRunStart(this.currentRunId);

    const abortController = new AbortController();

    this.wasStopped = false;
    if (this.stopSignal) {
      this.stopPoller = createStopSignalPoller({
        config: this.stopSignal,
        abortController,
        onStop: () => {
          this.runtime.log("info", "Agent run stopped by signal");
          this.isActive = false;
          this.wasStopped = true;
        },
      });
    }

    this.agentHistory = sanitizeForJson(await this.runtime.loadMessages());

    if (this.conversationManager) {
      this.agentHistory = this.conversationManager.trimMessages(
        this.agentHistory
      );
    }

    this.historyLength = this.agentHistory.length;

    const sanitizedMessage = sanitizeUnicodeString(args.message);
    this.agentHistory.push({ role: "user", content: sanitizedMessage });
    // NOTE: the user message is persisted upstream by `tasks.run` (so it shows
    // immediately, before the worker picks up the job). We intentionally do NOT
    // push it into `this.messages` here — `saveMessages` would otherwise write a
    // second `TaskMessage` row and the UI would render the prompt twice. It
    // still lives in `agentHistory` above, which is the LLM conversation.

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    try {
      await this.runAgentLoop(abortController, usage);
    } catch (error) {
      stopReason = this.handleRunError(error, abortController);
    } finally {
      this.stopPoller?.cleanup();
      this.stopPoller = undefined;
    }

    if (this.wasStopped && stopReason.type === "completed") {
      stopReason = { type: "stopped" };
    }

    await this.finalizeRun(usage, startTime, stopReason);

    return { runId: this.currentRunId, stopReason };
  }

  /**
   * Main agent loop - streams responses and handles tool calls.
   */
  private async runAgentLoop(
    abortController: AbortController,
    usage: TokenUsage
  ): Promise<void> {
    while (this.isActive && !abortController.signal.aborted) {
      if (this.conversationManager?.perTurn) {
        this.agentHistory = this.conversationManager.trimMessages(
          this.agentHistory
        );
      }

      this.applyCacheCheckpoint();

      const result = streamText({
        model: this.provider,
        experimental_context: {
          ...this.experimentalContextExtra,
          taskId: this.taskId ?? "",
          runId: this.currentRunId ?? "",
        },
        messages: this.agentHistory,
        system: this.systemPrompt,
        ...(Object.keys(this.tools).length > 0 ? { tools: this.tools } : {}),
        maxRetries: 3,
        abortSignal: abortController.signal,
        maxOutputTokens: this.maxTokens,
        experimental_transform: smoothStream(),
        ...({ providerOptions: this.buildProviderOptions() } as Record<
          string,
          unknown
        >),
      });

      await this.processStream(result, abortController, usage);

      if (abortController.signal.aborted) {
        break;
      }

      const responseMessages = await this.getResponseMessages(result);
      if (!responseMessages) {
        break;
      }

      this.agentHistory.push(...responseMessages);

      if ((await result.finishReason) === "stop") {
        this.isActive = false;
      }
    }
  }

  /**
   * Build provider options for the streamText call based on model reasoning mode.
   */
  private buildProviderOptions() {
    const reasoningMode = this.getReasoningMode();

    if (reasoningMode === "adaptive") {
      return {
        bedrock: {
          reasoningConfig: {
            type: "adaptive" as const,
            ...(this.reasoningEffort && {
              maxReasoningEffort: this.reasoningEffort,
            }),
          },
        } satisfies BedrockProviderOptions,
      };
    }

    if (reasoningMode === "budget") {
      if (this.modelConfig.provider === "bedrock") {
        return {
          bedrock: {
            reasoningConfig: {
              type: "enabled" as const,
              budgetTokens: this.reasoningBudgetTokens,
            },
            anthropicBeta: [
              "interleaved-thinking-2025-05-14",
              "fine-grained-tool-streaming-2025-05-14",
            ],
          } satisfies BedrockProviderOptions,
        };
      }

      if (this.modelConfig.provider === "anthropic") {
        return {
          anthropic: {
            thinking: this.reasoningEnabled
              ? {
                  type: "enabled" as const,
                  budgetTokens: this.reasoningBudgetTokens ?? 0,
                }
              : undefined,
            toolStreaming: true,
          } satisfies AnthropicProviderOptions,
        };
      }
    }

    return {};
  }

  private getReasoningMode(): "adaptive" | "budget" | undefined {
    if (isAdaptiveReasoningModelId(this.modelId)) {
      return "adaptive";
    }

    return this.modelConfig.reasoning?.mode;
  }

  private async processStream(
    result: ReturnType<typeof streamText>,
    abortController: AbortController,
    usage: TokenUsage
  ): Promise<void> {
    for await (const chunk of result.fullStream) {
      if (abortController.signal.aborted) {
        this.runtime.log("debug", "Stream aborted");
        break;
      }

      await this.handleStreamChunk(chunk, usage);
    }
  }

  private async handleStreamChunk(
    chunk: TextStreamPart<ToolSet>,
    usage: TokenUsage
  ): Promise<void> {
    switch (chunk.type) {
      case "reasoning-start":
        this.reasoningStartTime = Date.now();
        this.currentReasoningText = "";
        await this.runtime.emit({ type: "reasoning-start", id: chunk.id });
        break;

      case "reasoning-delta":
        this.currentReasoningText += sanitizeUnicodeString(chunk.text);
        await this.runtime.emit({
          type: "reasoning-delta",
          id: chunk.id,
          text: sanitizeUnicodeString(chunk.text),
        });
        break;

      case "reasoning-end": {
        const duration = this.reasoningStartTime
          ? Date.now() - this.reasoningStartTime
          : null;
        if (this.currentReasoningText) {
          this.messages.push(
            this.createAssistantMessage(
              { type: "reasoning", text: this.currentReasoningText },
              { duration }
            )
          );
        }
        this.currentReasoningText = "";
        this.reasoningStartTime = null;
        await this.runtime.emit({ type: "reasoning-end", id: chunk.id });
        break;
      }

      case "text-start":
        this.textStartTime = Date.now();
        this.currentTextContent = "";
        await this.runtime.emit({ type: "text-start", id: chunk.id });
        break;

      case "text-delta":
        this.currentTextContent += sanitizeUnicodeString(chunk.text);
        await this.runtime.emit({
          type: "text-delta",
          id: chunk.id,
          text: sanitizeUnicodeString(chunk.text),
        });
        break;

      case "text-end": {
        this.finalizeTextContent();
        await this.runtime.emit({ type: "text-end", id: chunk.id });
        break;
      }

      case "tool-input-start":
        this.toolTracking.set(chunk.id, {
          name: chunk.toolName,
          input: "",
          startTime: Date.now(),
        });
        // Trace which tools an agent (incl. sub-agents) actually calls, keyed
        // by run id for correlation across log lines.
        console.log(
          `[tooltrace] run=${this.currentRunId ?? "?"} CALL ${chunk.toolName}`,
        );
        await this.runtime.emit({
          type: "tool-input-start",
          id: chunk.id,
          toolName: chunk.toolName,
        });
        break;

      case "tool-input-delta": {
        const tracking = this.toolTracking.get(chunk.id);
        const sanitizedDelta = sanitizeUnicodeString(chunk.delta);
        if (tracking) {
          tracking.input += sanitizedDelta;
        }
        await this.runtime.emit({
          type: "tool-input-delta",
          id: chunk.id,
          delta: sanitizedDelta,
        });
        break;
      }

      case "tool-result": {
        const tracking = this.toolTracking.get(chunk.toolCallId);
        const duration = tracking ? Date.now() - tracking.startTime : null;
        const parsedInput = this.parseToolInput(tracking?.input ?? "");
        const sanitizedOutput = sanitizeForJson(chunk.output);
        // Trace the tool's returned payload so logs show what each tool call
        // produced. Truncated to keep logs readable.
        console.log(
          `[tooltrace] run=${this.currentRunId ?? "?"} RESULT ${tracking?.name ?? "unknown"} -> ` +
            JSON.stringify(sanitizedOutput).slice(0, 500),
        );
        this.messages.push(
          this.createToolMessage(
            chunk.toolCallId,
            tracking?.name ?? "unknown",
            parsedInput,
            sanitizedOutput,
            { duration }
          )
        );
        this.toolTracking.delete(chunk.toolCallId);
        await this.runtime.emit({
          type: "tool-result",
          toolCallId: chunk.toolCallId,
          output: sanitizedOutput,
        });
        break;
      }

      case "finish": {
        usage.inputTokens += chunk.totalUsage.inputTokens ?? 0;
        usage.outputTokens += chunk.totalUsage.outputTokens ?? 0;

        const totalUsage = chunk.totalUsage as {
          cacheReadInputTokens?: number;
          cacheWriteInputTokens?: number;
          inputTokenDetails?: {
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          raw?: {
            cacheReadInputTokens?: number;
            cacheWriteInputTokens?: number;
          };
        };

        const cacheRead =
          totalUsage.inputTokenDetails?.cacheReadTokens ??
          totalUsage.raw?.cacheReadInputTokens ??
          totalUsage.cacheReadInputTokens ??
          0;

        const cacheWrite =
          totalUsage.inputTokenDetails?.cacheWriteTokens ??
          totalUsage.raw?.cacheWriteInputTokens ??
          totalUsage.cacheWriteInputTokens ??
          0;

        usage.cacheReadTokens += Number(cacheRead);
        usage.cacheWriteTokens += Number(cacheWrite);

        break;
      }

      // A tool that throws must still produce a terminal event: persist a
      // tool message and emit a `tool-result` with a structured error payload
      // so the durable stream (and the UI chip keyed on toolCallId) closes.
      // Without this, only the model hears about the failure via the SDK's
      // internal error result — consumers of our stream see a forever-pending
      // tool.
      case "tool-error": {
        const errorChunk = chunk as {
          toolCallId: string;
          toolName?: string;
          error?: unknown;
        };
        const errorText = sanitizeUnicodeString(
          errorChunk.error instanceof Error
            ? errorChunk.error.message
            : String(errorChunk.error),
        ).slice(0, 2_000);
        console.error(
          `[tooltrace] run=${this.currentRunId ?? "?"} TOOL-ERROR ` +
            JSON.stringify({ toolName: errorChunk.toolName, error: errorText }),
        );

        const tracking = this.toolTracking.get(errorChunk.toolCallId);
        const duration = tracking ? Date.now() - tracking.startTime : null;
        const output = {
          type: "tool-execution-error",
          error: errorText,
          toolName: errorChunk.toolName ?? tracking?.name ?? "unknown",
        };
        this.messages.push(
          this.createToolMessage(
            errorChunk.toolCallId,
            errorChunk.toolName ?? tracking?.name ?? "unknown",
            this.parseToolInput(tracking?.input ?? ""),
            output,
            { duration, error: true },
          ),
        );
        this.toolTracking.delete(errorChunk.toolCallId);
        await this.runtime.emit({
          type: "tool-result",
          toolCallId: errorChunk.toolCallId,
          output,
        });
        break;
      }

      case "error":
        console.error(
          `[tooltrace] run=${this.currentRunId ?? "?"} STREAM-ERROR ` +
            String((chunk as { error?: unknown }).error).slice(0, 500),
        );
        break;
    }
  }

  private createAssistantMessage(
    content: AssistantMessageContent,
    metadata: Record<string, unknown> = {}
  ): AssistantMessage {
    return { role: "assistant", content, metadata };
  }

  private createToolMessage(
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
    output: unknown,
    metadata: Record<string, unknown> = {}
  ): ToolMessage {
    return {
      role: "tool",
      content: { toolCallId, name, input, output },
      metadata,
    };
  }

  private parseToolInput(input: string): Record<string, unknown> {
    if (!input) return {};
    try {
      return sanitizeForJson(
        JSON.parse(input) as Record<string, unknown>
      ) as Record<string, unknown>;
    } catch {
      return { raw: sanitizeUnicodeString(input) };
    }
  }

  private finalizeTextContent(): void {
    if (this.currentTextContent) {
      const duration = this.textStartTime
        ? Date.now() - this.textStartTime
        : null;
      this.messages.push(
        this.createAssistantMessage(
          { type: "text", text: this.currentTextContent },
          { duration }
        )
      );
    }
    this.currentTextContent = "";
    this.textStartTime = null;
  }

  private async getResponseMessages(
    result: ReturnType<typeof streamText>
  ): Promise<
    Awaited<ReturnType<typeof streamText>["response"]>["messages"] | null
  > {
    try {
      return sanitizeForJson((await result.response).messages);
    } catch (error) {
      if (
        error instanceof TypeError &&
        (error as TypeError & { code?: string }).code === "ERR_INVALID_STATE"
      ) {
        this.runtime.log(
          "debug",
          "Stream closed during tool execution (expected on abort)"
        );
        return null;
      }
      throw error;
    }
  }

  private handleRunError(
    error: unknown,
    abortController: AbortController
  ): StopReason {
    if (abortController.signal.aborted) {
      this.runtime.log("info", "Agent run aborted");
      return { type: "completed" };
    }

    const err = error instanceof Error ? error : new Error(String(error));
    this.runtime.log("error", `Agent run error: ${err.message}`);
    return { type: "error", error: err };
  }

  private async finalizeRun(
    usage: TokenUsage,
    startTime: number,
    stopReason: StopReason
  ): Promise<void> {
    const durationMs = Date.now() - startTime;

    const usageCalc = await calculateCost(
      this.modelConfig.costId.provider,
      this.modelConfig.costId.modelId,
      usage
    );

    const costUSD = usageCalc.costUSD?.totalUSD ?? 0.0;
    this.totalCost += costUSD;

    let tokenCount = 0;
    try {
      const tokenizerModel =
        models[this.modelConfig.tokenizerModelId as keyof typeof models];
      const tokenizer = new Tokenizer(
        encoding[tokenizerModel.encoding as keyof typeof encoding]
      );
      const tokenResult = count({
        // @ts-expect-error tokenizer typing mismatch between sdk + encoding
        tokenizer,
        model: tokenizerModel,
        messages: this.agentHistory as unknown as ModelMessage[],
        ...(Object.keys(this.tools).length > 0 ? { tools: this.tools } : {}),
      });
      tokenCount = tokenResult.total;
    } catch (error) {
      this.runtime.log("debug", "Token count estimation failed", error);
    }

    const metrics: RunMetrics = {
      usage,
      costUSD,
      durationMs,
      tokenCount,
      modelId: this.modelId,
    };

    if (this.conversationManager) {
      this.agentHistory = this.conversationManager.trimMessages(
        this.agentHistory
      );
    }

    this.applyCacheCheckpoint();

    await this.runtime.saveMessages(
      sanitizeForJson(this.agentHistory),
      sanitizeForJson([...this.messages])
    );

    if (stopReason.type === "error") {
      await this.runtime.onRunError(this.currentRunId!, stopReason.error);
      await this.runtime.cleanup();
    } else {
      // Complete the run first (metrics + status + terminal `finish`) so the
      // UI registers completion immediately. Suggestion generation is a slow
      // follow-up model call, so it must not delay completion — otherwise the
      // stream stays "streaming", metrics are withheld, and late events race
      // with the persisted history (causing duplicate/echoed output).
      await this.runtime.onRunComplete(this.currentRunId!, metrics);

      // Generate follow-up query suggestions *after* the run has finished. The
      // live stream may already be closing, so suggestions reach the UI via
      // the persisted platform row (Electric SQL sync). Best-effort: a failure
      // never affects the completed run.
      if (this.runtime.onRunSuggestions) {
        try {
          const suggestions = await generateSuggestions(this.agentHistory);
          if (suggestions.length > 0) {
            await this.runtime.onRunSuggestions(
              this.currentRunId!,
              suggestions
            );
          }
        } catch (error) {
          this.runtime.log("debug", "Suggestion generation failed", error);
        }
      }

      await this.runtime.cleanup();
    }
  }

  private messageHasReasoning(message: ModelMessage): boolean {
    if (!Array.isArray((message as { content: unknown }).content)) {
      return false;
    }
    return (message as { content: Array<{ type: string }> }).content.some(
      (part) => part.type === "reasoning"
    );
  }

  /**
   * Apply a single moving cache checkpoint to the conversation history.
   * Removes all existing checkpoints, then adds one to the last eligible message.
   */
  private applyCacheCheckpoint(): void {
    const provider =
      this.modelConfig.provider === "bedrock" ? "bedrock" : "anthropic";

    for (const message of this.agentHistory) {
      removeCheckpoint(message as MessageWithCacheOptions);
    }

    for (let i = this.agentHistory.length - 1; i >= 0; i--) {
      const msg = this.agentHistory[i];
      if (!msg) continue;

      if (msg.role === "assistant") {
        if (this.messageHasReasoning(msg)) {
          continue;
        }
        addCheckpoint(msg as MessageWithCacheOptions, provider);
        return;
      }

      if (msg.role === "user" || msg.role === "tool") {
        addCheckpoint(msg as MessageWithCacheOptions, provider);
        return;
      }
    }
  }

  /** Stop the currently running agent (local abort). */
  public stop(): void {
    this.isActive = false;
    this.runtime.log("info", "Agent stopped locally");
  }
}
