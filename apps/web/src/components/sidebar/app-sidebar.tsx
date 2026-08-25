"use client"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"

import { SearchButton } from "./search-button"
import { SidebarFooter as SidebarFooterContent } from "./sidebar-footer"
import { SidebarLogo } from "./sidebar-logo"
import { ThreadList } from "./thread-list"

export function AppSidebar() {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-3 px-2.5 pt-3">
        <SidebarLogo />
        <SearchButton />
      </SidebarHeader>
      <SidebarContent className="px-0 pt-2">
        <ThreadList />
      </SidebarContent>
      <SidebarFooter>
        <SidebarFooterContent />
      </SidebarFooter>
    </Sidebar>
  )
}
