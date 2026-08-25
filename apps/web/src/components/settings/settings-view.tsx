"use client";

import { useTranslations } from "next-intl";
import { SchemaExplorer } from "@/components/graph/schema-explorer";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { KnowledgePanel } from "./knowledge-panel";
import { SendingIdentityPanel } from "./sending-identity-panel";
import { UsersAdminTable } from "./users-admin-table";

export function SettingsView({
	initialTab,
}: {
	/** Tab to open on mount (from the route's `?tab=` search param). */
	initialTab?: "users" | "schema" | "knowledge" | "email";
} = {}) {
	const t = useTranslations("Settings");

	return (
		<div className="flex h-full flex-col overflow-hidden p-2">
			<div className="flex h-full w-full flex-col overflow-hidden">
				<header className="flex shrink-0 items-start gap-2 pb-3">
					<SidebarTrigger className="mt-1 -ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
					<div>
						<h1 className="text-lg font-semibold tracking-tight text-foreground">
							{t("title")}
						</h1>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{t("tagline")}
						</p>
					</div>
				</header>

				<Tabs
					defaultValue={initialTab ?? "users"}
					className="flex min-h-0 flex-1 flex-col gap-3"
				>
					<TabsList variant="line" className="shrink-0">
						<TabsTrigger value="users">{t("tabs.users")}</TabsTrigger>
						<TabsTrigger value="schema">{t("tabs.schema")}</TabsTrigger>
						<TabsTrigger value="knowledge">{t("tabs.knowledge")}</TabsTrigger>
						<TabsTrigger value="email">{t("tabs.email")}</TabsTrigger>
					</TabsList>

					<TabsContent
						value="users"
						className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
					>
						<UsersAdminTable />
					</TabsContent>

					<TabsContent
						value="schema"
						className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
					>
						<SchemaExplorer padded={false} />
					</TabsContent>

					<TabsContent
						value="knowledge"
						className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
					>
						<KnowledgePanel padded={false} />
					</TabsContent>

					<TabsContent
						value="email"
						className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
					>
						<SendingIdentityPanel padded={false} />
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
