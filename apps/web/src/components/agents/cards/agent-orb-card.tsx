"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "boring-avatars";
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
import { client, orpc } from "@/orpc/client";

interface AgentOrbCardProps {
	agentId: string;
	agentName: string;
	initialFirstColor?: string;
	initialSecondColor?: string;
	readOnly?: boolean;
}

function ColorInput({
	label,
	color,
	onChange,
}: {
	label: string;
	color: string;
	onChange: (color: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-sm font-medium">{label}</span>
			<label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-input bg-background px-3 py-2.5 transition-colors hover:bg-accent/50">
				<input
					type="color"
					value={color}
					onChange={(e) => onChange(e.target.value.toUpperCase())}
					className="h-5 w-5 cursor-pointer appearance-none rounded-full border border-border/50 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
				/>
				<span className="font-mono text-sm">{color}</span>
			</label>
		</div>
	);
}

export function AgentOrbCard({
	agentId,
	agentName,
	initialFirstColor = "#6D8E53",
	initialSecondColor = "#F5CABB",
	readOnly,
}: AgentOrbCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const [firstColor, setFirstColor] = React.useState(
		initialFirstColor.toUpperCase(),
	);
	const [secondColor, setSecondColor] = React.useState(
		initialSecondColor.toUpperCase(),
	);

	const hasChanges =
		firstColor !== initialFirstColor.toUpperCase() ||
		secondColor !== initialSecondColor.toUpperCase();

	const updateMutation = useMutation({
		mutationFn: async () => {
			return client.agents.update({
				id: agentId,
				metadata: {
					orbFirstColor: firstColor,
					orbSecondColor: secondColor,
				},
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.orbColorSuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const customColors = [
		firstColor,
		secondColor,
		firstColor,
		secondColor,
		firstColor,
	];

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.orbColor.title")}</CardTitle>
				<CardDescription>{t("settings.orbColor.description")}</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-6">
					<div className="relative h-20 w-20 shrink-0 rounded-full bg-muted p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)]">
						<div className="h-full w-full overflow-hidden rounded-full bg-background shadow-[inset_0_0_12px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]">
							<Avatar
								size={72}
								name={agentName}
								variant="marble"
								colors={customColors}
							/>
						</div>
					</div>
					{!readOnly && (
						<div className="flex gap-4">
							<ColorInput
								label={t("settings.orbColor.firstColor")}
								color={firstColor}
								onChange={setFirstColor}
							/>
							<ColorInput
								label={t("settings.orbColor.secondColor")}
								color={secondColor}
								onChange={setSecondColor}
							/>
						</div>
					)}
				</div>
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
