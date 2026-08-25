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
import { client } from "@/orpc/client";

interface DuplicateAgentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	agentName: string;
	onDuplicated?: () => void;
}

export function DuplicateAgentDialog({
	open,
	onOpenChange,
	agentId,
	agentName,
	onDuplicated,
}: DuplicateAgentDialogProps) {
	const t = useTranslations("Agents");
	const [isDuplicating, setIsDuplicating] = React.useState(false);
	const [name, setName] = React.useState("");

	React.useEffect(() => {
		if (open) {
			setName(`${agentName} (Copy)`);
		}
	}, [open, agentName]);

	const handleDuplicate = async () => {
		if (!name.trim() || isDuplicating) return;

		setIsDuplicating(true);
		try {
			await client.agents.duplicate({ id: agentId, name: name.trim() });
			toast.success(t("duplicateSuccess"));
			onOpenChange(false);
			onDuplicated?.();
		} catch {
			toast.error(t("duplicateError"));
		} finally {
			setIsDuplicating(false);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			setName("");
		}
		onOpenChange(newOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-sm" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>{t("duplicateAgent")}</DialogTitle>
					<DialogDescription>
						{t("duplicateAgentDescription")}
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-2">
					<Field>
						<FieldLabel>{t("name")}</FieldLabel>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("namePlaceholder")}
							autoFocus
						/>
					</Field>
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost">{t("common.cancel")}</Button>
					</DialogClose>
					<Button
						onClick={handleDuplicate}
						disabled={!name.trim() || isDuplicating}
					>
						{isDuplicating ? t("duplicating") : t("duplicate")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
