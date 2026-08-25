import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "#/components/app-shell";
import { ToolsPage } from "#/components/tools/tools-page";

export const Route = createFileRoute("/tools/")({
	component: ToolsIndexPage,
});

function ToolsIndexPage() {
	return (
		<AppShell showMetrics={false}>
			<ToolsPage />
		</AppShell>
	);
}
