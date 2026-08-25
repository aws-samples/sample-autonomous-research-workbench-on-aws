"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/orpc/client";

interface NewAgentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (agentId: string) => void;
}

export function NewAgentDialog({
	open,
	onOpenChange,
	onCreated,
}: NewAgentDialogProps) {
	const t = useTranslations("Agents");
	const [isCreating, setIsCreating] = React.useState(false);
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");

	const handleCreate = async () => {
		if (!name.trim() || !description.trim() || isCreating) return;

		setIsCreating(true);
		try {
			const { agentId } = await client.agents.create({
				name: name.trim(),
				description: description.trim(),
			});
			setName("");
			setDescription("");
			onCreated?.(agentId);
		} catch {
			toast.error(t("toast.error"));
		} finally {
			setIsCreating(false);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			setName("");
			setDescription("");
		}
		onOpenChange(newOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("createAgent")}</DialogTitle>
					<DialogDescription>{t("createAgentDescription")}</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-2">
					<Field>
						<FieldLabel>{t("name")}</FieldLabel>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("namePlaceholder")}
						/>
					</Field>
					<Field>
						<FieldLabel>{t("description")}</FieldLabel>
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder={t("descriptionPlaceholder")}
							rows={3}
						/>
					</Field>
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost">{t("common.cancel")}</Button>
					</DialogClose>
					<Button
						onClick={handleCreate}
						disabled={!name.trim() || !description.trim() || isCreating}
					>
						{isCreating ? t("creating") : t("create")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
