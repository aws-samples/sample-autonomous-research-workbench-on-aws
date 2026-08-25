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
import { client } from "@/orpc/client";

interface DeleteAgentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	agentName: string;
	onDeleted?: () => void;
}

export function DeleteAgentDialog({
	open,
	onOpenChange,
	agentId,
	agentName,
	onDeleted,
}: DeleteAgentDialogProps) {
	const t = useTranslations("Agents");
	const [isDeleting, setIsDeleting] = React.useState(false);

	const handleDelete = async () => {
		if (isDeleting) return;

		setIsDeleting(true);
		try {
			await client.agents.delete({ id: agentId });
			onOpenChange(false);
			onDeleted?.();
		} catch {
			toast.error(t("toast.error"));
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>{t("deleteAgent")}</DialogTitle>
					<DialogDescription>
						{t("deleteAgentDescription", { agentName })}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost">{t("common.cancel")}</Button>
					</DialogClose>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={isDeleting}
					>
						{isDeleting ? t("deleting") : t("delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
