import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { PlatformMetrics } from "@/components/sidebar/platform-metrics"

export function AppShell({
  children,
  showMetrics = true,
}: {
  children: React.ReactNode
  showMetrics?: boolean
}) {
  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": "19.2rem" } as React.CSSProperties}
    >
      <AppSidebar />
      <SidebarInset>
        {showMetrics ? (
          <header className="shrink-0 px-2 pt-2 pb-1">
            <PlatformMetrics />
          </header>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
