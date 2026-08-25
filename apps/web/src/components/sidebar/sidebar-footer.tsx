"use client";

import { authClient } from "@repo/auth/client";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	BookOpen,
	Bot,
	FolderKanban,
	LogOut,
	Monitor,
	Moon,
	Network,
	Settings,
	Sun,
	Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/ui/user-avatar";
import { SERVICE_URL } from "@/lib/config";

const NAV_ITEMS = [
	{ key: "projects", icon: FolderKanban, href: "/projects", preview: false },
	{ key: "artifacts", icon: Archive, href: "/artifacts", preview: false },
	{ key: "agents", icon: Bot, href: "/agents", preview: false },
	// Tools is a design mock — flagged here so it reads as unfinished from the nav.
	{ key: "tools", icon: Wrench, href: "/tools", preview: true },
	{ key: "graphExplorer", icon: Network, href: "/graph", preview: false },
	{ key: "settings", icon: Settings, href: "/settings", preview: false },
] as const;

const NAV_ITEM_CLASS =
	"flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-foreground/4";

export function SidebarFooter() {
	const t = useTranslations("AppShell");

	return (
		<div className="space-y-2">
			<nav className="space-y-0.5">
				{NAV_ITEMS.map(({ key, icon: Icon, href, preview }) => {
					const content = (
						<>
							<Icon className="size-4 shrink-0" strokeWidth={1.5} />
							<span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-foreground/90">
								{t(`nav.${key}`)}
							</span>
							{preview ? (
								<span className="shrink-0 rounded-sm border border-border px-1 py-px text-[9px] leading-none font-medium tracking-wide text-muted-foreground uppercase">
									{t("nav.previewBadge")}
								</span>
							) : null}
						</>
					);

					return href ? (
						<Link key={key} to={href} className={NAV_ITEM_CLASS}>
							{content}
						</Link>
					) : (
						<button key={key} type="button" className={NAV_ITEM_CLASS}>
							{content}
						</button>
					);
				})}
			</nav>

			<UserMenu />
		</div>
	);
}

function UserMenu() {
	const t = useTranslations("AppShell");
	const { data: session } = authClient.useSession();

	const userName = session?.user.name ?? "";
	const userEmail = session?.user.email ?? "";
	const userImage = session?.user.image ?? undefined;
	const isAdmin = session?.user.role === "admin";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="w-full cursor-pointer rounded-md p-2 text-left outline-none transition-[background-color,transform] duration-150 hover:bg-foreground/5 active:scale-[0.98]">
				<div className="flex items-center gap-2">
					<UserAvatar
						name={userName}
						email={userEmail}
						image={userImage}
						className="size-8 outline outline-[rgba(0,0,0,0.1)] dark:outline-[rgba(255,255,255,0.1)]"
					/>
					<div className="flex min-w-0 flex-1 flex-col text-left">
						<div className="flex items-center gap-1.5">
							<span className="truncate text-xs font-normal">{userName}</span>
							{isAdmin ? (
								<span className="shrink-0 bg-red-600 px-1 py-px text-[9px] leading-none font-medium text-white uppercase dark:bg-red-500">
									{session?.user.role}
								</span>
							) : null}
						</div>
						<div className="truncate text-xs font-normal text-muted-foreground">
							{userEmail}
						</div>
					</div>
				</div>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="top"
				align="start"
				sideOffset={8}
				className="w-56"
			>
				<div className="px-2 py-1.5">
					<div className="text-xs font-medium">Research Platform</div>
					<div className="text-xs font-normal text-muted-foreground">
						Version: 0.1.0
					</div>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("user.preferences")}</DropdownMenuLabel>
					<ThemeSubmenu />
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("user.resources")}</DropdownMenuLabel>
					<DropdownMenuItem
						onSelect={() => {
							window.open(
								`${SERVICE_URL}/api`,
								"_blank",
								"noopener,noreferrer",
							);
						}}
					>
						<BookOpen />
						<span>{t("user.apiDocs")}</span>
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						void authClient.signOut();
					}}
				>
					<LogOut />
					<span>{t("user.signOut")}</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ThemeSubmenu() {
	const t = useTranslations("AppShell");
	const { theme, setTheme } = useTheme();

	const icon =
		theme === "light" ? (
			<Sun className="size-4" />
		) : theme === "dark" ? (
			<Moon className="size-4" />
		) : (
			<Monitor className="size-4" />
		);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				{icon}
				<span>{t("theme.label")}</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuRadioGroup
					value={theme ?? "system"}
					onValueChange={setTheme}
				>
					<DropdownMenuRadioItem value="light">
						<Sun className="size-4" />
						<span>{t("theme.light")}</span>
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">
						<Moon className="size-4" />
						<span>{t("theme.dark")}</span>
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="system">
						<Monitor className="size-4" />
						<span>{t("theme.system")}</span>
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
