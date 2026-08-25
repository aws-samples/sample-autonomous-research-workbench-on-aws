"use client";

import { useQuery } from "@tanstack/react-query";
import {
	CheckCircle2,
	ExternalLink,
	Loader2,
	Mail,
	TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc/client";

/**
 * SES console page where identities are created and verified. The region
 * comes from the API (where SES actually runs); before it loads, fall back to
 * the region-less console URL, which redirects to the user's default.
 */
function sesConsoleUrl(region?: string): string {
	if (!region) return "https://console.aws.amazon.com/ses/home#/get-set-up";
	return `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/get-set-up`;
}

const STATUS_BADGE: Record<string, string> = {
	SUCCESS: "bg-green-500/15 text-green-600 dark:text-green-400",
	PENDING: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
	FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function statusBadgeClass(status: string): string {
	return (
		STATUS_BADGE[status] ?? "bg-red-500/15 text-red-600 dark:text-red-400"
	);
}

const TYPE_LABEL: Record<string, string> = {
	DOMAIN: "domain",
	EMAIL_ADDRESS: "email address",
};

/**
 * Settings → Email tab. Read-only view of the SES v2 identities (domains and
 * email addresses): identities are created and verified in the AWS console
 * (linked below), and the first listed identity is the platform sender. When
 * no identity exists, email sending is not allowed and a warning is shown.
 */
export function SendingIdentityPanel({
	padded = true,
}: { padded?: boolean } = {}) {
	const { data, isPending, isError, error } = useQuery(
		orpc.platform.sendingIdentities.queryOptions(),
	);
	const consoleUrl = sesConsoleUrl(data?.region);

	return (
		<div
			className={cn("flex h-full flex-col overflow-hidden", padded && "p-2")}
		>
			<div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
				<header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
					<Mail className="size-4 shrink-0 text-muted-foreground" />
					<span className="text-sm font-medium text-foreground">
						Email Sending
					</span>
					{data ? (
						<span className="text-xs text-muted-foreground">
							{data.identities.length}{" "}
							{data.identities.length === 1 ? "identity" : "identities"} in SES
						</span>
					) : null}

					<div className="ml-auto flex items-center gap-1.5">
						<Button size="sm" variant="outline" asChild>
							<a href={consoleUrl} target="_blank" rel="noreferrer">
								<ExternalLink className="size-3.5" />
								Manage in AWS SES
							</a>
						</Button>
					</div>
				</header>

				<div className="flex-1 overflow-y-auto p-4">
					{isPending ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Loading sending identities…
						</div>
					) : isError ? (
						<div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
							<TriangleAlert className="size-4 shrink-0" />
							{error instanceof Error
								? error.message
								: "Couldn't load sending identities."}
						</div>
					) : data.sender ? (
						<div className="flex flex-col gap-4">
							{/* Active sender */}
							<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5">
								<CheckCircle2 className="size-4 shrink-0 text-green-600 dark:text-green-400" />
								<span className="text-sm text-muted-foreground">Sender</span>
								<span className="font-mono text-sm font-medium text-foreground">
									{data.sender.identity}
								</span>
								<Badge variant="secondary">
									{TYPE_LABEL[data.sender.type] ?? data.sender.type}
								</Badge>
								<Badge
									className={statusBadgeClass(data.sender.verificationStatus)}
								>
									{data.sender.verificationStatus}
								</Badge>
								{!data.sender.sendingEnabled ? (
									<span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
										<TriangleAlert className="size-3.5" />
										Not verified for sending yet — finish verification in the
										SES console
									</span>
								) : null}
							</div>

							{/* All identities */}
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Identity</TableHead>
										<TableHead>Type</TableHead>
										<TableHead>Verification</TableHead>
										<TableHead>Sending</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.identities.map((entry) => (
										<TableRow key={entry.identity}>
											<TableCell className="font-mono text-sm">
												{entry.identity}
												{entry.identity === data.sender?.identity ? (
													<Badge variant="secondary" className="ml-2">
														active
													</Badge>
												) : null}
											</TableCell>
											<TableCell className="text-sm text-muted-foreground">
												{TYPE_LABEL[entry.type] ?? entry.type}
											</TableCell>
											<TableCell>
												<Badge
													className={statusBadgeClass(entry.verificationStatus)}
												>
													{entry.verificationStatus}
												</Badge>
											</TableCell>
											<TableCell className="text-sm text-muted-foreground">
												{entry.sendingEnabled ? "enabled" : "disabled"}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>

							<p className="text-xs text-muted-foreground">
								The first SES identity is used as the platform sender. Add or
								verify domains and email addresses in the AWS SES console.
							</p>
						</div>
					) : (
						<div className="flex flex-col items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3.5">
							<div className="flex items-center gap-2">
								<TriangleAlert className="size-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
								<span className="text-sm font-medium text-foreground">
									No sending identity configured
								</span>
							</div>
							<p className="text-sm text-muted-foreground">
								Email sending is not allowed until a domain or email address
								identity is created and verified in Amazon SES. Set one up in
								the AWS console, then refresh this page.
							</p>
							<Button size="sm" asChild>
								<a href={consoleUrl} target="_blank" rel="noreferrer">
									<ExternalLink className="size-3.5" />
									Set up in AWS SES
								</a>
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
