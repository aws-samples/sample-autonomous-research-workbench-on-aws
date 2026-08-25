"use client";

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import { MENU_SECTIONS } from "./constants";
import { GeneralSection } from "./sections/general-section";
import { ModelSection } from "./sections/model-section";
import { PromptSection } from "./sections/prompt-section";
import { SkillsSection } from "./sections/skills-section";
import { ToolsSection } from "./sections/tools-section";
import type { Agent, SectionId } from "./types";

interface AgentFormProps {
	agent: Agent;
}

export function AgentForm({ agent }: AgentFormProps) {
	const t = useTranslations("Agents");
	const { tab: activeSection } = useSearch({ strict: false }) as {
		tab: SectionId;
	};
	const navigate = useNavigate({ from: "/agents/$id" });

	return (
		<div className="relative h-full flex-1 overflow-hidden p-2">
			<div className="flex h-full w-full flex-col rounded-lg border bg-card">
				<div className="flex items-center border-b px-4 py-3">
					<div className="flex items-center gap-3">
						<SidebarTrigger className="text-muted-foreground hover:text-foreground" />
						<span className="h-4 w-px shrink-0 bg-border" aria-hidden />
						<Link to="/agents">
							<Button size="icon-lg" variant="ghost">
								<ArrowLeft className="h-4 w-4" />
							</Button>
						</Link>
						<div>
							<h1 className="text-sm font-semibold text-foreground">
								{agent.name}
							</h1>
							<p className="text-xs text-muted-foreground">
								{t("settings.subtitle")}
							</p>
						</div>
					</div>
				</div>

				<div className="flex flex-1 overflow-hidden">
					<div className="my-4 ml-4 w-44 shrink-0 rounded-lg border p-2">
						<nav className="flex flex-col gap-0.5">
							{MENU_SECTIONS.map((section) => {
								const Icon = section.icon;
								const isActive = activeSection === section.id;
								return (
									<button
										key={section.id}
										type="button"
										onClick={() =>
											navigate({
												search: (prev) => ({ ...prev, tab: section.id }),
											})
										}
										className={cn(
											"flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-tight transition-colors",
											isActive
												? "bg-foreground/6 text-foreground"
												: "text-foreground/70 hover:bg-foreground/4 hover:text-foreground/90",
										)}
									>
										<Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
										{t(`settings.menu.${section.id}`)}
									</button>
								);
							})}
						</nav>
					</div>

					<div className="flex-1 overflow-y-auto">
						{activeSection === "tools" ? (
							<div className="px-6 pt-4 pb-6">
								<ToolsSection agentId={agent.id} tools={agent.tools} />
							</div>
						) : (
							<div
								className={cn(
									"mx-auto max-w-6xl p-6 pt-4",
									activeSection === "prompt"
										? "flex h-full flex-col"
										: "space-y-4",
								)}
							>
								{activeSection === "general" && (
									<GeneralSection agent={agent} />
								)}

								{activeSection === "model" && (
									<ModelSection agent={agent} />
								)}

								{activeSection === "prompt" && (
									<PromptSection
										agentId={agent.id}
										systemPrompt={agent.systemPrompt}
									/>
								)}

								{activeSection === "skills" && (
									<SkillsSection agentId={agent.id} />
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
