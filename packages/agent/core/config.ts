export type ReasoningEffort = "max" | "high" | "medium" | "low";

export type BudgetReasoningConfig = {
  mode: "budget";
  defaultBudgetTokens: number;
};

export type AdaptiveReasoningConfig = {
  mode: "adaptive";
  defaultEffort: ReasoningEffort;
};

export type ReasoningConfig = BudgetReasoningConfig | AdaptiveReasoningConfig;

export type ModelConfig = {
  /** Human-readable model name (e.g. "Claude Sonnet 4.5") */
  name: string;
  /** Provider lab name (e.g. "Anthropic") */
  lab: string;

  /** Provider routing key */
  provider: "bedrock" | "bedrock-anthropic" | "anthropic";
  /** Actual provider model ID for API calls */
  modelId: string;
  /** Provider + model ID pair for cost lookups */
  costId: {
    provider: string;
    modelId: string;
  };
  /** The model ID to use for the ai-tokenizer library for accurate token counting */
  tokenizerModelId: string;

  /** Total input context window in tokens */
  contextWindow: number;
  /** Token count threshold at which auto-compaction triggers */
  autoCompactThreshold: number;

  /** Maximum output tokens the model supports */
  maxTokens: number;
  /** Default max tokens for new agents using this model */
  defaultMaxTokens: number;

  reasoning?: ReasoningConfig;

  /** Display cost per million tokens (for UI only, billing uses tokenlens) */
  cost: { input: number; output: number };
};

const models = {
  "anthropic/claude-opus-4-6": {
    name: "Claude Opus 4.6",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-opus-4-6-v1",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-opus-4-6-v1",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 200_000,
    autoCompactThreshold: 128_000,
    maxTokens: 1000 * 64,
    defaultMaxTokens: 1000 * 52,
    reasoning: {
      mode: "adaptive",
      defaultEffort: "high",
    },
    cost: { input: 5, output: 25 },
  },
  "anthropic/claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-sonnet-4-6",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 1_000_000,
    autoCompactThreshold: 480_000,
    maxTokens: 1000 * 64,
    defaultMaxTokens: 1000 * 52,
    reasoning: {
      mode: "adaptive",
      defaultEffort: "high",
    },
    cost: { input: 3, output: 15 },
  },
  "anthropic/claude-fable-5": {
    name: "Claude Fable 5",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-fable-5",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-fable-5",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 1_000_000,
    autoCompactThreshold: 480_000,
    maxTokens: 1000 * 128,
    defaultMaxTokens: 1000 * 112,
    reasoning: {
      mode: "adaptive",
      defaultEffort: "high",
    },
    cost: { input: 10, output: 50 },
  },
  "anthropic/claude-opus-4-8": {
    name: "Claude Opus 4.8",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-opus-4-8",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-opus-4-8",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 1_000_000,
    autoCompactThreshold: 480_000,
    maxTokens: 1000 * 128,
    defaultMaxTokens: 1000 * 112,
    reasoning: {
      mode: "adaptive",
      defaultEffort: "high",
    },
    cost: { input: 5, output: 25 },
  },
  "anthropic/claude-sonnet-5": {
    name: "Claude Sonnet 5",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-sonnet-5",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-5",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 1_000_000,
    autoCompactThreshold: 480_000,
    maxTokens: 1000 * 128,
    defaultMaxTokens: 1000 * 112,
    reasoning: {
      mode: "adaptive",
      defaultEffort: "high",
    },
    cost: { input: 3, output: 15 },
  },
  "anthropic/claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    lab: "Anthropic",
    provider: "bedrock",
    modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    costId: {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    },
    tokenizerModelId: "anthropic/claude-sonnet-4.5",
    contextWindow: 200_000,
    autoCompactThreshold: 128_000,
    maxTokens: 1000 * 64,
    defaultMaxTokens: 1000 * 52,
    reasoning: {
      mode: "budget",
      defaultBudgetTokens: 1000 * 8,
    },
    cost: { input: 1, output: 5 },
  },
} satisfies Record<string, ModelConfig>;

export type ModelId = keyof typeof models;

/** The model used by general agents when no preference is configured. */
export const DEFAULT_MODEL_ID: ModelId = "anthropic/claude-haiku-4-5";

/**
 * The Team Lead's fallback when a project has no explicit leadModel.
 * Supervisory turns require reliable multi-step policy and tool selection,
 * so they use Sonnet without raising the default cost of research agents.
 */
export const TEAM_LEAD_DEFAULT_MODEL_ID: ModelId =
  "anthropic/claude-sonnet-5";

const ADAPTIVE_REASONING_MODEL_IDS = new Set<ModelId>([
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
]);

/**
 * Compatibility guard for models that should always use adaptive reasoning.
 * This prevents stale persisted budget-token settings from being applied.
 */
export const isAdaptiveReasoningModelId = (modelId: ModelId): boolean =>
  ADAPTIVE_REASONING_MODEL_IDS.has(modelId);

export const getModel = (modelId: ModelId): ModelConfig => {
  const model = models[modelId];
  if (!model) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  return model;
};

export const getAvailableModelIds = (): ModelId[] =>
  Object.keys(models) as ModelId[];
