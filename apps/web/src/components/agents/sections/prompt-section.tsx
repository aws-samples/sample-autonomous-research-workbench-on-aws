"use client";

import { AgentPromptCard } from "../cards/agent-prompt-card";

interface PromptSectionProps {
	agentId: string;
	systemPrompt: string | null;
	readOnly?: boolean;
}

export function PromptSection({
	agentId,
	systemPrompt,
	readOnly,
}: PromptSectionProps) {
	return (
		<AgentPromptCard
			agentId={agentId}
			systemPrompt={systemPrompt}
			readOnly={readOnly}
			className="flex flex-1 flex-col"
		/>
	);
}
