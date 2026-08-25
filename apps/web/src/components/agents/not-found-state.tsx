"use client";

import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

export function NotFoundState() {
	const t = useTranslations("Agents");

	return (
		<div className="h-full flex-1 overflow-hidden p-2">
			<div className="flex h-full w-full flex-col items-center justify-center rounded-lg border bg-card p-4 text-center">
				<div className="flex flex-col gap-0.5">
					<p className="text-sm font-medium text-foreground">
						{t("notFound.title")}
					</p>
					<p className="text-xs text-muted-foreground">
						{t("notFound.description")}
					</p>
				</div>
				<Link to="/agents">
					<Button className="mt-4" variant="outline" size="sm">
						<ArrowLeft className="h-3.5 w-3.5" />
						{t("notFound.backToAgents")}
					</Button>
				</Link>
			</div>
		</div>
	);
}
