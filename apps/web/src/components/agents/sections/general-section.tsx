"use client";

import { AgentDeleteCard } from "../cards/agent-delete-card";
import { AgentIdentityCard } from "../cards/agent-identity-card";
import { AgentOrbCard } from "../cards/agent-orb-card";
import type { Agent } from "../types";

interface GeneralSectionProps {
	agent: Agent;
	readOnly?: boolean;
}

export function GeneralSection({ agent, readOnly }: GeneralSectionProps) {
	return (
		<>
			<AgentIdentityCard
				agentId={agent.id}
				name={agent.name}
				description={agent.description}
				readOnly={readOnly}
			/>

			<AgentOrbCard
				agentId={agent.id}
				agentName={agent.name}
				initialFirstColor={
					(agent.metadata?.orbFirstColor as string) ?? undefined
				}
				initialSecondColor={
					(agent.metadata?.orbSecondColor as string) ?? undefined
				}
				readOnly={readOnly}
			/>

			{!readOnly && (
				<AgentDeleteCard agentId={agent.id} agentName={agent.name} />
			)}
		</>
	);
}
