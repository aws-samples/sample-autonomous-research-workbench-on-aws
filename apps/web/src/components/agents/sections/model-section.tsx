"use client";

import { AgentConfigCard } from "../cards/agent-config-card";
import { AgentHistoryCard } from "../cards/agent-history-card";
import { AgentModelCard } from "../cards/agent-model-card";
import type { Agent } from "../types";

interface ModelSectionProps {
	agent: Agent;
	readOnly?: boolean;
}

export function ModelSection({ agent, readOnly }: ModelSectionProps) {
	return (
		<div className="space-y-4">
			<AgentModelCard
				agentId={agent.id}
				preferredModel={agent.preferredModel}
				readOnly={readOnly}
			/>
			<AgentConfigCard
				agentId={agent.id}
				preferredModel={agent.preferredModel}
				maxTokens={agent.maxTokens}
				reasoningEnabled={agent.reasoningEnabled}
				reasoningBudgetTokens={agent.reasoningBudgetTokens}
				reasoningEffort={agent.reasoningEffort}
				readOnly={readOnly}
			/>
			<AgentHistoryCard
				agentId={agent.id}
				historyStrategy={agent.historyStrategy}
				historyWindowSize={agent.historyWindowSize}
				historyPerTurn={agent.historyPerTurn}
				readOnly={readOnly}
			/>
		</div>
	);
}
