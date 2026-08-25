"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { orpc } from "@/orpc/client";

import { DeleteAgentDialog } from "../delete-agent-dialog";

interface AgentDeleteCardProps {
	agentId: string;
	agentName: string;
}

export function AgentDeleteCard({ agentId, agentName }: AgentDeleteCardProps) {
	const t = useTranslations("Agents");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

	return (
		<>
			<Card size="sm">
				<CardHeader>
					<CardTitle>{t("settings.deleteAgent.title")}</CardTitle>
					<CardDescription>
						{t("settings.deleteAgent.description")}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="destructive"
						onClick={() => setDeleteDialogOpen(true)}
					>
						<Trash2 className="h-3.5 w-3.5" />
						{t("settings.deleteAgent.button")}
					</Button>
				</CardContent>
			</Card>

			<DeleteAgentDialog
				open={deleteDialogOpen}
				onOpenChange={setDeleteDialogOpen}
				agentId={agentId}
				agentName={agentName}
				onDeleted={() => {
					queryClient.removeQueries({
						queryKey: orpc.agents.get.queryOptions({
							input: { id: agentId },
						}).queryKey,
					});
					queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
					navigate({ to: "/agents" });
				}}
			/>
		</>
	);
}
