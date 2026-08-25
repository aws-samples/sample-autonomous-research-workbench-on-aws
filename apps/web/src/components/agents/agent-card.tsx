"use client";

import { Link } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import { formatDistanceToNow } from "date-fns";
import { Copy, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getAgentAvatarColors } from "@/lib/agent-avatar";

import { DeleteAgentDialog } from "./delete-agent-dialog";
import { DuplicateAgentDialog } from "./duplicate-agent-dialog";
import type { Agent } from "./types";

interface AgentCardProps {
	agent: Agent;
	onDeleted?: () => void;
	onDuplicated?: () => void;
}

export function AgentCard({ agent, onDeleted, onDuplicated }: AgentCardProps) {
	const t = useTranslations("Agents");
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
	const [isDuplicateDialogOpen, setIsDuplicateDialogOpen] =
		React.useState(false);

	const lastUpdated = formatDistanceToNow(new Date(agent.updatedAt), {
		addSuffix: true,
	});

	return (
		<>
			<Link to="/agents/$id" params={{ id: agent.id }}>
				<Card
					size="sm"
					className="flex h-full cursor-pointer flex-col transition-colors hover:bg-muted/50"
				>
					<CardHeader className="flex-1">
						<div className="mb-1 flex items-center gap-2.5">
							<div className="h-8 w-8 shrink-0 rounded-full bg-muted p-1">
								<Avatar
									size={24}
									name={agent.name}
									variant="marble"
									colors={getAgentAvatarColors(agent)}
								/>
							</div>
							<CardTitle className="flex items-center gap-1.5">
								{agent.name}
							</CardTitle>
						</div>
						<CardDescription className="line-clamp-2 min-h-10">
							{agent.description}
						</CardDescription>
						<CardAction>
							<DropdownMenu>
								<DropdownMenuTrigger
									asChild
									onClick={(e) => e.preventDefault()}
								>
									<Button size="icon-xs" variant="ghost">
										<MoreHorizontal className="h-3.5 w-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={(e) => {
											e.preventDefault();
											setIsDuplicateDialogOpen(true);
										}}
									>
										<Copy className="h-3.5 w-3.5 opacity-70" />
										{t("duplicate")}
									</DropdownMenuItem>
									<DropdownMenuItem
										variant="destructive"
										onClick={(e) => {
											e.preventDefault();
											setIsDeleteDialogOpen(true);
										}}
									>
										<Trash2 className="h-3.5 w-3.5 opacity-70" />
										{t("delete")}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</CardAction>
					</CardHeader>
					<div className="mt-2 px-3">
						<span className="text-[10px] text-muted-foreground">
							{t("updatedAgo", { time: lastUpdated })}
						</span>
					</div>
				</Card>
			</Link>

			<DuplicateAgentDialog
				open={isDuplicateDialogOpen}
				onOpenChange={setIsDuplicateDialogOpen}
				agentId={agent.id}
				agentName={agent.name}
				onDuplicated={onDuplicated}
			/>

			<DeleteAgentDialog
				open={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				agentId={agent.id}
				agentName={agent.name}
				onDeleted={onDeleted}
			/>
		</>
	);
}
