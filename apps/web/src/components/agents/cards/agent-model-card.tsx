"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { client, orpc } from "@/orpc/client";

import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../constants";
import type { ModelConfig, ReasoningMode } from "../types";

interface AgentModelCardProps {
	agentId: string;
	preferredModel: string | null;
	readOnly?: boolean;
}

function ModelDetails({ model }: { model: ModelConfig }) {
	const t = useTranslations("Agents");

	const reasoningLabels: Record<ReasoningMode, string> = {
		budget: t("settings.modelSection.reasoningConfigurable"),
		adaptive: t("settings.modelSection.reasoningAdaptive"),
		none: t("settings.modelSection.reasoningDisabled"),
	};

	return (
		<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
			<div className="flex justify-between">
				<span>{t("settings.modelSection.detailContext")}</span>
				<span className="font-medium text-foreground">{model.context}</span>
			</div>
			<div className="flex justify-between">
				<span>{t("settings.modelSection.detailReasoning")}</span>
				<span className="font-medium text-foreground">
					{reasoningLabels[model.reasoningMode]}
				</span>
			</div>
			<div className="flex justify-between">
				<span>{t("settings.modelSection.detailCost")}</span>
				<span className="font-medium text-foreground">
					${model.cost.input} / ${model.cost.output}
				</span>
			</div>
		</div>
	);
}

export function AgentModelCard({
	agentId,
	preferredModel: initialPreferredModel,
	readOnly,
}: AgentModelCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const [preferredModel, setPreferredModel] = React.useState<string>(
		initialPreferredModel ?? DEFAULT_MODEL_ID,
	);

	const selectedModel = AVAILABLE_MODELS.find((m) => m.id === preferredModel);

	const updateMutation = useMutation({
		mutationFn: async (newModel: string) => {
			return client.agents.update({ id: agentId, preferredModel: newModel });
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.modelSuccess"));
		},
		onError: () => {
			setPreferredModel(initialPreferredModel ?? DEFAULT_MODEL_ID);
			toast.error(t("toast.error"));
		},
	});

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.modelSection.title")}</CardTitle>
				<CardDescription>
					{t("settings.modelSection.description")}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<Field>
					<FieldLabel>{t("settings.modelSection.preferredModel")}</FieldLabel>
					<FieldDescription>
						{t("settings.modelSection.preferredModelDescription")}
					</FieldDescription>
					<Select
						value={preferredModel}
						onValueChange={(value) => {
							if (value && value !== preferredModel) {
								setPreferredModel(value);
								updateMutation.mutate(value);
							}
						}}
						disabled={readOnly || updateMutation.isPending}
					>
						<SelectTrigger className="w-full">
							<SelectValue>
								{selectedModel ? (
									<span className="flex items-center gap-2">
										{selectedModel.name}
										<Badge
											variant="secondary"
											className="shrink-0 px-1.5 py-0 text-[10px]"
										>
											{selectedModel.lab}
										</Badge>
									</span>
								) : (
									preferredModel
								)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{AVAILABLE_MODELS.map((model) => (
								<SelectItem key={model.id} value={model.id}>
									<span className="flex items-center gap-2">
										{model.name}
										<Badge
											variant="secondary"
											className="px-1.5 py-0 text-[10px]"
										>
											{model.lab}
										</Badge>
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>

				{selectedModel && (
					<div className="rounded-lg border bg-muted/30 p-3">
						<div className="mb-1 flex items-center gap-2">
							<span className="text-sm font-medium">{selectedModel.name}</span>
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								{selectedModel.lab}
							</Badge>
						</div>
						<ModelDetails model={selectedModel} />
					</div>
				)}
			</CardContent>
		</Card>
	);
}
