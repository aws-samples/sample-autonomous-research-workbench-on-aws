"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { orpc } from "@/orpc/client";

import { AgentForm } from "./agent-form";
import { NotFoundState } from "./not-found-state";
import type { Agent } from "./types";

function AgentDetailSkeleton() {
	return (
		<div className="h-full flex-1 overflow-hidden p-2">
			<div className="flex h-full w-full flex-col rounded-lg border bg-card">
				<div className="flex items-center gap-3 border-b px-4 py-3">
					<Skeleton className="h-8 w-8 rounded-md" />
					<div className="space-y-1.5">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-3 w-40" />
					</div>
				</div>
				<div className="flex flex-1 overflow-hidden">
					<div className="my-4 ml-4 w-44 shrink-0 space-y-1 rounded-lg border p-2">
						{Array.from({ length: 5 }).map((_, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
							<Skeleton key={i} className="h-8 w-full rounded-lg" />
						))}
					</div>
					<div className="flex-1 overflow-y-auto">
						<div className="mx-auto max-w-xl space-y-4 p-6">
							<Skeleton className="h-40 w-full rounded-lg" />
							<Skeleton className="h-32 w-full rounded-lg" />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function AgentDetail() {
	const { id } = useParams({ strict: false }) as { id: string };

	const { data, isLoading } = useQuery(
		orpc.agents.get.queryOptions({ input: { id } }),
	);

	if (isLoading) {
		return <AgentDetailSkeleton />;
	}

	if (!data?.agent) {
		return <NotFoundState />;
	}

	return <AgentForm agent={data.agent as Agent} />;
}
