import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "#/components/agents/agents-page";
import { AppShell } from "#/components/app-shell";

export const Route = createFileRoute("/agents/")({
	component: AgentsIndexPage,
});

function AgentsIndexPage() {
	return (
		<AppShell showMetrics={false}>
			<AgentsPage />
		</AppShell>
	);
}
