"use client"

/**
 * Client-only entry point for the Sigma canvas. Sigma references
 * `WebGL2RenderingContext` at module scope, which crashes server rendering,
 * so the real component is code-split and only ever loaded in the browser
 * (the TanStack equivalent of Next's `dynamic(..., { ssr: false })`).
 */
import { ClientOnly } from "@tanstack/react-router"
import { lazy, Suspense } from "react"

import type { GraphCanvasProps } from "./graph-canvas-types"

const GraphCanvasInner = lazy(() => import("./graph-canvas"))

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ClientOnly fallback={null}>
      <Suspense fallback={null}>
        <GraphCanvasInner {...props} />
      </Suspense>
    </ClientOnly>
  )
}
