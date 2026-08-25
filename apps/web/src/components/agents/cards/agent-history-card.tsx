"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { client, orpc } from "@/orpc/client";

type HistoryStrategy = "none" | "sliding-window";

interface AgentHistoryCardProps {
	agentId: string;
	historyStrategy: string;
	historyWindowSize: number;
	historyPerTurn: boolean;
	readOnly?: boolean;
}

const STRATEGY_IDS: HistoryStrategy[] = ["none", "sliding-window"];

const STRATEGY_KEYS: Record<HistoryStrategy, string> = {
	none: "none",
	"sliding-window": "slidingWindow",
};

export function AgentHistoryCard({
	agentId,
	historyStrategy: initialStrategy,
	historyWindowSize: initialWindowSize,
	historyPerTurn: initialPerTurn,
	readOnly,
}: AgentHistoryCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const [strategy, setStrategy] = React.useState<HistoryStrategy>(
		(initialStrategy as HistoryStrategy) ?? "sliding-window",
	);
	const [windowSize, setWindowSize] = React.useState(initialWindowSize ?? 40);
	const [perTurn, setPerTurn] = React.useState(initialPerTurn ?? true);

	const hasChanges =
		strategy !== initialStrategy ||
		windowSize !== initialWindowSize ||
		perTurn !== initialPerTurn;

	const updateMutation = useMutation({
		mutationFn: async () => {
			return client.agents.update({
				id: agentId,
				historyStrategy: strategy,
				historyWindowSize: windowSize,
				historyPerTurn: perTurn,
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			toast.success(t("toast.historySuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.historySection.title")}</CardTitle>
				<CardDescription>
					{t("settings.historySection.description")}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<Field>
					<FieldLabel>{t("settings.historySection.strategy")}</FieldLabel>
					<FieldDescription>
						{t("settings.historySection.strategyDescription")}
					</FieldDescription>
					<div className="grid grid-cols-2 gap-2">
						{STRATEGY_IDS.map((id) => {
							const selected = strategy === id;
							return (
								<button
									key={id}
									type="button"
									disabled={readOnly}
									onClick={() => setStrategy(id)}
									className={cn(
										"relative flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
										"disabled:cursor-not-allowed disabled:opacity-50",
										selected
											? "border-primary bg-primary/5 dark:bg-primary/10"
											: "border-border bg-muted/30 hover:bg-muted/60",
									)}
								>
									<div className="flex w-full items-center gap-2">
										<History
											className={cn(
												"h-4 w-4 shrink-0",
												selected ? "text-primary" : "text-muted-foreground",
											)}
										/>
										<span
											className={cn(
												"text-xs font-medium",
												selected ? "text-primary" : "text-foreground",
											)}
										>
											{t(
												`settings.historySection.strategies.${STRATEGY_KEYS[id]}.label`,
											)}
										</span>
										<span
											className={cn(
												"ml-auto h-3 w-3 shrink-0 rounded-full border-2 transition-colors",
												selected
													? "border-primary bg-primary"
													: "border-muted-foreground/40 bg-transparent",
											)}
										/>
									</div>
									<span className="text-[11px] leading-snug text-muted-foreground">
										{t(
											`settings.historySection.strategies.${STRATEGY_KEYS[id]}.description`,
										)}
									</span>
								</button>
							);
						})}
					</div>
				</Field>

				{strategy === "sliding-window" && (
					<>
						<Field>
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<FieldLabel>
										{t("settings.historySection.windowSize")}
									</FieldLabel>
									<FieldDescription>
										{t("settings.historySection.windowSizeDescription")}
									</FieldDescription>
								</div>
								<Input
									type="number"
									value={windowSize}
									onChange={(e) =>
										setWindowSize(
											Math.max(1, Math.min(Number(e.target.value), 200)),
										)
									}
									min={1}
									max={200}
									step={1}
									className="w-20 text-right tabular-nums"
									disabled={readOnly}
								/>
							</div>
						</Field>

						<Field>
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<FieldLabel>
										{t("settings.historySection.perTurn")}
									</FieldLabel>
									<FieldDescription>
										{t("settings.historySection.perTurnDescription")}
									</FieldDescription>
								</div>
								<Switch
									checked={perTurn}
									onCheckedChange={setPerTurn}
									disabled={readOnly}
								/>
							</div>
						</Field>
					</>
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
