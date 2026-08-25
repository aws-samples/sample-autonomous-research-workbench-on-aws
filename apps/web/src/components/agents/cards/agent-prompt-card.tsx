"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/orpc/client";

const PROMPT_MAX = 10000;

interface AgentPromptCardProps {
	agentId: string;
	systemPrompt: string | null;
	readOnly?: boolean;
	className?: string;
}

export function AgentPromptCard({
	agentId,
	systemPrompt: initialSystemPrompt,
	readOnly,
	className,
}: AgentPromptCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const [systemPrompt, setSystemPrompt] = React.useState(
		initialSystemPrompt ?? "",
	);

	const tooLong = systemPrompt.length > PROMPT_MAX;
	const hasChanges = systemPrompt !== (initialSystemPrompt ?? "");

	const updateMutation = useMutation({
		mutationFn: async () => {
			return client.agents.update({
				id: agentId,
				systemPrompt: systemPrompt || null,
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.promptSuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!hasChanges || tooLong) return;
		updateMutation.mutate();
	};

	return (
		<Card size="sm" className={className}>
			<CardHeader>
				<CardTitle>{t("settings.promptSection.title")}</CardTitle>
				<CardDescription>
					{t("settings.promptSection.description")}
				</CardDescription>
			</CardHeader>
			<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
				<CardContent className="flex min-h-0 flex-1 flex-col">
					<Field
						data-invalid={tooLong}
						className="flex min-h-0 flex-1 flex-col"
					>
						<FieldLabel>
							{t("settings.promptSection.customInstructions")}
						</FieldLabel>
						<FieldDescription>
							{t("settings.promptSection.customInstructionsDescription")}
						</FieldDescription>
						<Textarea
							value={systemPrompt}
							onChange={(e) => setSystemPrompt(e.target.value)}
							placeholder={t("settings.promptSection.placeholder")}
							disabled={readOnly}
							className="min-h-64 flex-1 resize-none font-mono text-xs"
						/>
						{tooLong && (
							<FieldError>{t("settings.promptSection.tooLong")}</FieldError>
						)}
					</Field>
				</CardContent>
				{!readOnly && (
					<CardFooter className="mt-3 flex justify-end border-t pt-3">
						<Button
							type="submit"
							size="sm"
							disabled={!hasChanges || tooLong || updateMutation.isPending}
						>
							{updateMutation.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								t("common.save")
							)}
						</Button>
					</CardFooter>
				)}
			</form>
		</Card>
	);
}
