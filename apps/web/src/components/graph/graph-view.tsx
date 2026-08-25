'use client'

import { ClusterGraph } from './cluster-graph'

/**
 * The interactive platform graph. The extraction-schema editor now lives under
 * Settings → Schema (it's an admin control), so this view is just the cluster.
 */
export function GraphView() {
  return (
    <div className="flex h-full flex-col overflow-hidden p-2">
      <ClusterGraph padded={false} showSidebarTrigger />
    </div>
  )
}
