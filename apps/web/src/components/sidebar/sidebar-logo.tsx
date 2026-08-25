"use client"

import { useTranslations } from "next-intl"
import { Link } from "@tanstack/react-router"

export function SidebarLogo() {
  const t = useTranslations("AppShell")

  return (
    <Link
      to="/"
      className="flex items-center gap-2 rounded-md py-1 text-left text-foreground outline-none"
      aria-label={t("logoAlt")}
    >
      <img
        src="/aws-logo.png"
        alt={t("logoAlt")}
        width={36}
        height={36}
        className="size-[2.16rem] rounded-md"
      />
    </Link>
  )
}
