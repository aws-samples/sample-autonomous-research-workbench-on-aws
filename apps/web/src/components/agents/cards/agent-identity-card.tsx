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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/orpc/client";

interface AgentIdentityCardProps {
	agentId: string;
	name: string;
	description: string;
	readOnly?: boolean;
}

const NAME_MAX = 64;
const DESCRIPTION_MAX = 500;

export function AgentIdentityCard({
	agentId,
	name: initialName,
	description: initialDescription,
	readOnly,
}: AgentIdentityCardProps) {
	const t = useTranslations("Agents");
	const queryClient = useQueryClient();

	const [name, setName] = React.useState(initialName);
	const [description, setDescription] = React.useState(initialDescription);

	const nameError = !name.trim()
		? t("settings.identity.nameRequired")
		: name.length > NAME_MAX
			? t("settings.identity.nameTooLong")
			: null;
	const descriptionError = !description.trim()
		? t("settings.identity.descriptionRequired")
		: description.length > DESCRIPTION_MAX
			? t("settings.identity.descriptionTooLong")
			: null;

	const hasChanges = name !== initialName || description !== initialDescription;
	const isValid = !nameError && !descriptionError;

	const updateMutation = useMutation({
		mutationFn: async () => {
			return client.agents.update({
				id: agentId,
				name: name.trim(),
				description: description.trim(),
			});
		},
		onSuccess: (data) => {
			queryClient.setQueryData(
				orpc.agents.get.queryOptions({ input: { id: agentId } }).queryKey,
				{ agent: data.agent },
			);
			queryClient.invalidateQueries({ queryKey: orpc.agents.list.key() });
			toast.success(t("toast.identitySuccess"));
		},
		onError: () => {
			toast.error(t("toast.error"));
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!hasChanges || !isValid) return;
		updateMutation.mutate();
	};

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>{t("settings.identity.title")}</CardTitle>
				<CardDescription>{t("settings.identity.description")}</CardDescription>
			</CardHeader>
			<form onSubmit={handleSubmit}>
				<CardContent className="space-y-3">
					<Field data-invalid={!!nameError}>
						<FieldLabel>{t("settings.identity.name")}</FieldLabel>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("settings.identity.namePlaceholder")}
							disabled={readOnly}
						/>
						{nameError && <FieldError>{nameError}</FieldError>}
					</Field>
					<Field data-invalid={!!descriptionError}>
						<FieldLabel>{t("settings.identity.agentDescription")}</FieldLabel>
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder={t("settings.identity.descriptionPlaceholder")}
							rows={2}
							disabled={readOnly}
						/>
						{descriptionError && <FieldError>{descriptionError}</FieldError>}
					</Field>
				</CardContent>
				{!readOnly && (
					<CardFooter className="mt-4 flex justify-end border-t pt-3">
						<Button
							type="submit"
							size="sm"
							disabled={!hasChanges || !isValid || updateMutation.isPending}
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
