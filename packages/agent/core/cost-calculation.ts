import { fetchModels, type ProviderInfo } from "tokenlens";
import { getUsage } from "tokenlens/helpers";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type ManualPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const TOKENS_PER_MILLION = 1_000_000;

const MANUAL_MODEL_PRICING: Record<string, Record<string, ManualPricing>> = {
  "amazon-bedrock": {
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
    "anthropic.claude-sonnet-4-6": {
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
    "anthropic.claude-opus-4-6-v1": {
      inputPerMillion: 5,
      outputPerMillion: 25,
    },
    "anthropic.claude-fable-5": {
      inputPerMillion: 10,
      outputPerMillion: 50,
    },
    "anthropic.claude-opus-4-8": {
      inputPerMillion: 5,
      outputPerMillion: 25,
    },
    "anthropic.claude-sonnet-5": {
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
    "anthropic.claude-haiku-4-5-20251001-v1:0": {
      inputPerMillion: 1,
      outputPerMillion: 5,
    },
  },
};

function calculateManualCost(
  providerId: string,
  modelId: string,
  tokenUsage: TokenUsage
) {
  const providerPricing = MANUAL_MODEL_PRICING[providerId];
  const pricing = providerPricing?.[modelId];
  if (!pricing) {
    return null;
  }

  const inputUSD =
    (tokenUsage.inputTokens / TOKENS_PER_MILLION) * pricing.inputPerMillion;
  const outputUSD =
    (tokenUsage.outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMillion;
  const cacheReadUSD =
    (tokenUsage.cacheReadTokens / TOKENS_PER_MILLION) * pricing.inputPerMillion;
  const cacheWriteUSD =
    (tokenUsage.cacheWriteTokens / TOKENS_PER_MILLION) *
    pricing.inputPerMillion;
  const totalUSD = inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD;

  return {
    costUSD: {
      inputUSD,
      outputUSD,
      cacheReadUSD,
      cacheWriteUSD,
      totalUSD,
    },
  };
}

export const calculateCost = async (
  providerId: string,
  modelId: string,
  tokenUsage: TokenUsage
) => {
  const manualCost = calculateManualCost(providerId, modelId, tokenUsage);
  if (manualCost) {
    return manualCost;
  }

  const provider = (await fetchModels(providerId)) as ProviderInfo;

  const usageData = getUsage(
    modelId,
    {
      input: tokenUsage.inputTokens,
      output: tokenUsage.outputTokens,
      cacheReads: tokenUsage.cacheReadTokens,
      cacheWrites: tokenUsage.cacheWriteTokens,
    },
    provider
  );

  return usageData;
};
