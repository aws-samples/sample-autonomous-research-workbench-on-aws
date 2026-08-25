import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";

import { AgentDetail } from "#/components/agents/agent-detail";
import { AppShell } from "#/components/app-shell";

const sectionIds = ["general", "model", "prompt", "tools", "skills"] as const;

const agentSearchSchema = z.object({
	tab: z.enum(sectionIds).default("general").catch("general"),
});

export const Route = createFileRoute("/agents/$id")({
	validateSearch: agentSearchSchema,
	component: AgentDetailPage,
});

function AgentDetailPage() {
	return (
		<AppShell showMetrics={false}>
			<AgentDetail />
		</AppShell>
	);
}
