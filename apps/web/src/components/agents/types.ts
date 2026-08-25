export type SectionId = "general" | "model" | "prompt" | "tools" | "skills";

export type ReasoningMode = "budget" | "adaptive" | "none";

export type ReasoningEffort = "max" | "high" | "medium" | "low";

export interface ModelConfig {
	id: string;
	name: string;
	lab: string;
	context: string;
	reasoningMode: ReasoningMode;
	maxTokens: number;
	defaultMaxTokens: number;
	defaultReasoningBudgetTokens?: number;
	defaultReasoningEffort?: ReasoningEffort;
	cost: {
		input: number;
		output: number;
	};
}

// The shape returned by the agents.* oRPC procedures (see
// packages/orpc/routes/agents.ts toAgentDto).
export interface Agent {
	id: string;
	name: string;
	description: string;
	systemPrompt: string | null;
	preferredModel: string | null;
	tools: string[];
	maxTokens: number | null;
	reasoningEnabled: boolean | null;
	reasoningBudgetTokens: number | null;
	reasoningEffort: string | null;
	historyStrategy: string;
	historyWindowSize: number;
	historyPerTurn: boolean;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}
