"use client"

import { memo } from "react"
import { Streamdown } from "streamdown"

/**
 * Renders an assistant text block as markdown via Streamdown (mirrors the
 * mobis-research `AgentMessage`). While a reply is streaming, `isAnimating`
 * enables the typing caret and incremental rendering; persisted history
 * renders in static mode.
 */
export const AgentMarkdown = memo(
  function AgentMarkdown({
    children,
    isAnimating = false,
  }: {
    children: string
    isAnimating?: boolean
  }) {
    return (
      <div className="my-2 text-xs/relaxed font-normal text-foreground/90">
        <Streamdown
          caret="circle"
          isAnimating={isAnimating}
          mode={isAnimating ? "streaming" : "static"}
        >
          {children}
        </Streamdown>
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isAnimating === nextProps.isAnimating
)
