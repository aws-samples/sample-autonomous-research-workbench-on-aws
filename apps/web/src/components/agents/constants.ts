import { Brain, MessageSquare, Settings, Sparkles, Wrench } from "lucide-react";

import type { ModelConfig, SectionId } from "./types";

// Mirrors packages/agent/core/config.ts — the models the runtime can serve.
export const DEFAULT_MODEL_ID = "anthropic/claude-haiku-4-5";
export const TEAM_LEAD_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";

export const AVAILABLE_MODELS: ModelConfig[] = [
	{
		id: "anthropic/claude-opus-4-6",
		name: "Claude Opus 4.6",
		lab: "Anthropic",
		context: "200K",
		reasoningMode: "adaptive",
		maxTokens: 1000 * 64,
		defaultMaxTokens: 1000 * 52,
		defaultReasoningEffort: "high",
		cost: { input: 5, output: 25 },
	},
	{
		id: "anthropic/claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		lab: "Anthropic",
		context: "1M",
		reasoningMode: "adaptive",
		maxTokens: 1000 * 64,
		defaultMaxTokens: 1000 * 52,
		defaultReasoningEffort: "high",
		cost: { input: 3, output: 15 },
	},
	{
		id: "anthropic/claude-fable-5",
		name: "Claude Fable 5",
		lab: "Anthropic",
		context: "1M",
		reasoningMode: "adaptive",
		maxTokens: 1000 * 128,
		defaultMaxTokens: 1000 * 112,
		defaultReasoningEffort: "high",
		cost: { input: 10, output: 50 },
	},
	{
		id: "anthropic/claude-opus-4-8",
		name: "Claude Opus 4.8",
		lab: "Anthropic",
		context: "1M",
		reasoningMode: "adaptive",
		maxTokens: 1000 * 128,
		defaultMaxTokens: 1000 * 112,
		defaultReasoningEffort: "high",
		cost: { input: 5, output: 25 },
	},
	{
		id: "anthropic/claude-sonnet-5",
		name: "Claude Sonnet 5",
		lab: "Anthropic",
		context: "1M",
		reasoningMode: "adaptive",
		maxTokens: 1000 * 128,
		defaultMaxTokens: 1000 * 112,
		defaultReasoningEffort: "high",
		cost: { input: 3, output: 15 },
	},
	{
		id: "anthropic/claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		lab: "Anthropic",
		context: "200K",
		reasoningMode: "budget",
		maxTokens: 1000 * 64,
		defaultMaxTokens: 1000 * 52,
		defaultReasoningBudgetTokens: 1000 * 8,
		cost: { input: 1, output: 5 },
	},
];

export const MENU_SECTIONS: { id: SectionId; icon: typeof Settings }[] = [
	{ id: "general", icon: Settings },
	{ id: "model", icon: Brain },
	{ id: "prompt", icon: MessageSquare },
	{ id: "tools", icon: Wrench },
	{ id: "skills", icon: Sparkles },
];
