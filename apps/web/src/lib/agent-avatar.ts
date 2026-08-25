export function getAgentAvatarColors(agent: {
	metadata?: unknown;
}): string[] | undefined {
	const meta = agent.metadata as Record<string, unknown> | null;
	const first = meta?.orbFirstColor as string | undefined;
	const second = meta?.orbSecondColor as string | undefined;
	if (first && second) {
		return [first, second, first, second, first];
	}
	return undefined;
}
