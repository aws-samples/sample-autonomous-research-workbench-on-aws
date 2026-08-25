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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { client, orpc } from "@/orpc/client";

import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../constants";
import type { ReasoningEffort } from "../types";

interface AgentConfigCardProps {
	agentId: string;
	preferredModel: string | null;
	maxTokens: number | null;
	reasoningEnabled: boolean | null;
	reasoningBudgetTokens: number | null;
	reasoningEffort: string | null;
	readOnly?: boolean;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000) {
		const k = tokens / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
	}
	return tokens.toLocaleString();
}

const MIN_TOKENS = 1024;

const EFFORT_LEVELS: {
	id: ReasoningEffort;
	accentClassName: string;
}[] = [
	{ id: "low", accentClassName: "bg-emerald-400 dark:bg-emerald-500" },
	{ id: "medium", accentClassName: "bg-amber-400 dark:bg-amber-500" },
	{ id: "high", accentClassName: "bg-orange-400 dark:bg-orange-500" },
	{ id: "max", accentClassName: "bg-rose-400 dark:bg-rose-500" },
];

export function AgentConfigCard({
	agentId,
	preferredModel,
	maxTokens: initialMaxTokens,
	reasoningEnabled: initialReasoningEnabled,
	reasoningBudgetTokens: initialReasoningBudgetTokens,
	reasoningEffort: initialReasoningEffort,
	readOnly,
}: AgentConfigCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const modelConfig = AVAILABLE_MODELS.find(
		(m) => m.id === (preferredModel ?? DEFAULT_MODEL_ID),
	);

	const reasoningMode = modelConfig?.reasoningMode ?? "none";
	const modelMaxTokens = modelConfig?.maxTokens ?? 64000;
	const defaultMaxTokens = modelConfig?.defaultMaxTokens ?? modelMaxTokens;
	const defaultEffort = modelConfig?.defaultReasoningEffort ?? "high";
	const defaultBudget =
		modelConfig?.defaultReasoningBudgetTokens ?? MIN_TOKENS * 8;

	const [maxTokens, setMaxTokens] = React.useState(
		initialMaxTokens ?? defaultMaxTokens,
	);
	const [reasoningEnabled, setReasoningEnabled] = React.useState(
		initialReasoningEnabled ?? true,
	);
	const [reasoningBudgetTokens, setReasoningBudgetTokens] = React.useState(
		initialReasoningBudgetTokens ?? defaultBudget,
	);
	const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort>(
		(initialReasoningEffort as ReasoningEffort) ?? defaultEffort,
	);

	// When the preferred model changes (this card re-renders with new props but
	// unsaved local values), re-derive defaults for fields the user hasn't set.
	React.useEffect(() => {
		if (initialMaxTokens === null) setMaxTokens(defaultMaxTokens);
		if (initialReasoningBudgetTokens === null)
			setReasoningBudgetTokens(defaultBudget);
		if (initialReasoningEffort === null) setReasoningEffort(defaultEffort);
	}, [
		defaultMaxTokens,
		defaultBudget,
		defaultEffort,
		initialMaxTokens,
		initialReasoningBudgetTokens,
		initialReasoningEffort,
	]);

	const isBudgetMode = reasoningMode === "budget";
	const isAdaptiveMode = reasoningMode === "adaptive";

	const hasChanges =
		maxTokens !== (initialMaxTokens ?? defaultMaxTokens) ||
		reasoningEnabled !== (initialReasoningEnabled ?? true) ||
		(isBudgetMode &&
			reasoningBudgetTokens !==
				(initialReasoningBudgetTokens ?? defaultBudget)) ||
		(isAdaptiveMode &&
			reasoningEffort !==
				((initialReasoningEffort as ReasoningEffort) ?? defaultEffort));

	const updateMutation = useMutation({
		mutationFn: async () => {
			return client.agents.update({
				id: agentId,
				maxTokens,
				reasoningEnabled,
				...(isBudgetMode && { reasoningBudgetTokens }),
				...(isAdaptiveMode && { reasoningEffort }),
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			toast.success(t("toast.configSuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	// In budget mode, output + reasoning tokens share the model's output limit.
	const maxOutputTokens =
		isBudgetMode && reasoningEnabled
			? modelMaxTokens - MIN_TOKENS
			: modelMaxTokens;
	const maxReasoningTokens = Math.max(MIN_TOKENS, modelMaxTokens - maxTokens);

	const handleMaxTokensChange = (value: number) => {
		const clamped = Math.max(MIN_TOKENS, Math.min(value, maxOutputTokens));
		setMaxTokens(clamped);

		if (
			isBudgetMode &&
			reasoningEnabled &&
			clamped + reasoningBudgetTokens > modelMaxTokens
		) {
			setReasoningBudgetTokens(Math.max(MIN_TOKENS, modelMaxTokens - clamped));
		}
	};

	const handleReasoningTokensChange = (value: number) => {
		setReasoningBudgetTokens(
			Math.max(MIN_TOKENS, Math.min(value, maxReasoningTokens)),
		);
	};

	const handleReasoningToggle = (enabled: boolean) => {
		setReasoningEnabled(enabled);
		if (enabled && isBudgetMode) {
			if (maxTokens + defaultBudget > modelMaxTokens) {
				setMaxTokens(Math.max(MIN_TOKENS, modelMaxTokens - defaultBudget));
			}
			setReasoningBudgetTokens(defaultBudget);
		}
	};

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.configSection.title")}</CardTitle>
				<CardDescription>
					{t("settings.configSection.description")}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<Field>
					<div className="mb-2 flex items-center justify-between">
						<div className="space-y-0.5">
							<FieldLabel>{t("settings.configSection.maxTokens")}</FieldLabel>
							<FieldDescription>
								{t("settings.configSection.maxTokensDescription", {
									limit: formatTokens(modelMaxTokens),
								})}
							</FieldDescription>
						</div>
						<Input
							type="number"
							value={maxTokens}
							onChange={(e) => handleMaxTokensChange(Number(e.target.value))}
							min={MIN_TOKENS}
							max={maxOutputTokens}
							step={1024}
							className="w-24 text-right tabular-nums"
							disabled={readOnly}
						/>
					</div>
					<Slider
						value={[maxTokens]}
						onValueChange={(val: number[]) =>
							handleMaxTokensChange(val[0] ?? maxTokens)
						}
						min={MIN_TOKENS}
						max={maxOutputTokens}
						step={1024}
						disabled={readOnly}
					/>
					<div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
						<span>{formatTokens(MIN_TOKENS)}</span>
						<span>{formatTokens(maxOutputTokens)}</span>
					</div>
				</Field>

				{reasoningMode !== "none" && (
					<Field>
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<FieldLabel>
									{t("settings.configSection.enableReasoning")}
								</FieldLabel>
								<FieldDescription>
									{t("settings.configSection.enableReasoningDescription")}
								</FieldDescription>
							</div>
							<Switch
								checked={reasoningEnabled}
								onCheckedChange={handleReasoningToggle}
								disabled={readOnly}
							/>
						</div>
					</Field>
				)}

				{isBudgetMode && reasoningEnabled && (
					<>
						<div className="space-y-2">
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">
									{t("settings.configSection.budgetAllocation")}
								</span>
								<span className="font-medium tabular-nums">
									{formatTokens(maxTokens + reasoningBudgetTokens)}
									<span className="font-normal text-muted-foreground">
										{" "}
										/ {formatTokens(modelMaxTokens)}
									</span>
								</span>
							</div>
							<div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full bg-foreground/60 transition-all duration-200 dark:bg-foreground/40"
									style={{ width: `${(maxTokens / modelMaxTokens) * 100}%` }}
								/>
								<div
									className="h-full bg-blue-500/70 transition-all duration-200"
									style={{
										width: `${(reasoningBudgetTokens / modelMaxTokens) * 100}%`,
									}}
								/>
							</div>
							<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
								<span className="flex items-center gap-1.5">
									<span className="inline-block h-2 w-2 rounded-full bg-foreground/60 dark:bg-foreground/40" />
									{t("settings.configSection.budgetOutput")}
								</span>
								<span className="flex items-center gap-1.5">
									<span className="inline-block h-2 w-2 rounded-full bg-blue-500/70" />
									{t("settings.configSection.budgetReasoning")}
								</span>
							</div>
						</div>

						<Field>
							<div className="mb-2 flex items-center justify-between">
								<div className="space-y-0.5">
									<FieldLabel>
										{t("settings.configSection.reasoningBudget")}
									</FieldLabel>
									<FieldDescription>
										{t("settings.configSection.reasoningBudgetDescription")}
									</FieldDescription>
								</div>
								<Input
									type="number"
									value={reasoningBudgetTokens}
									onChange={(e) =>
										handleReasoningTokensChange(Number(e.target.value))
									}
									min={MIN_TOKENS}
									max={maxReasoningTokens}
									step={1024}
									className="w-24 text-right tabular-nums"
									disabled={readOnly}
								/>
							</div>
							<Slider
								value={[reasoningBudgetTokens]}
								onValueChange={(val: number[]) =>
									handleReasoningTokensChange(val[0] ?? reasoningBudgetTokens)
								}
								min={MIN_TOKENS}
								max={maxReasoningTokens}
								step={1024}
								disabled={readOnly}
							/>
							<div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
								<span>{formatTokens(MIN_TOKENS)}</span>
								<span>{formatTokens(maxReasoningTokens)}</span>
							</div>
						</Field>
					</>
				)}

				{isAdaptiveMode && reasoningEnabled && (
					<Field>
						<FieldLabel>{t("settings.configSection.effortLevel")}</FieldLabel>
						<FieldDescription>
							{t("settings.configSection.effortLevelDescription")}
						</FieldDescription>
						<div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
							<span className="whitespace-nowrap">
								{t("settings.configSection.effortLow")}
							</span>
							<div className="h-1.5 flex-1 rounded-full bg-gradient-to-r from-emerald-400/50 via-amber-400/50 to-rose-400/50 opacity-80" />
							<span className="whitespace-nowrap">
								{t("settings.configSection.effortMax")}
							</span>
						</div>
						<div className="mt-2 grid grid-cols-2 gap-2">
							{EFFORT_LEVELS.map((level) => {
								const selected = reasoningEffort === level.id;
								return (
									<button
										key={level.id}
										type="button"
										disabled={readOnly}
										onClick={() => setReasoningEffort(level.id)}
										className={cn(
											"relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
											"disabled:cursor-not-allowed disabled:opacity-50",
											selected
												? "border-foreground/35 bg-muted/50"
												: "border-border/80 bg-muted/20 hover:bg-muted/35",
										)}
									>
										<div className="flex w-full items-center gap-2">
											<span
												className={cn(
													"h-2.5 w-2.5 shrink-0 rounded-full transition-opacity",
													level.accentClassName,
													selected ? "opacity-90" : "opacity-55",
												)}
											/>
											<span
												className={cn(
													"text-xs font-medium",
													selected ? "text-foreground" : "text-foreground/90",
												)}
											>
												{t(`settings.configSection.efforts.${level.id}.label`)}
											</span>
											<span
												className={cn(
													"ml-auto h-3 w-3 shrink-0 rounded-full border-2 transition-colors",
													selected
														? "border-foreground bg-foreground"
														: "border-muted-foreground/40 bg-transparent",
												)}
											/>
										</div>
										<span className="text-[11px] leading-snug text-muted-foreground">
											{t(`settings.configSection.efforts.${level.id}.desc`)}
										</span>
									</button>
								);
							})}
						</div>
					</Field>
				)}
			</CardContent>
			{!readOnly && (
				<CardFooter className="flex justify-end border-t pt-3">
					<Button
						size="sm"
						onClick={() => hasChanges && updateMutation.mutate()}
						disabled={!hasChanges || updateMutation.isPending}
					>
						{updateMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							t("common.save")
						)}
					</Button>
				</CardFooter>
			)}
		</Card>
	);
}
