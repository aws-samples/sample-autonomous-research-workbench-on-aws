import { stream } from "@durable-streams/client"
import { type Message, eventTypes, runStreamUrl } from "@repo/streams-protocol"
import { useCallback, useEffect, useRef, useState } from "react"

import type { TextPart, ToolPart } from "@/components/tasks/types"
import { SERVICE_URL } from "@/lib/config"

/** In-order streamed content: text runs interleaved with tool chips. */
export type ProspectStreamPart = TextPart | ToolPart

/** Humanize a tool name for the chip label, e.g. "save_project_brief". */
function toolLabel(toolName: string): string {
  return toolName.replace(/[_-]+/g, " ")
}

export interface UseProspectStreamOptions {
  runId: string | null
  /** The project whose prospect session owns the run — required by the
   * `/v1/stream` proxy's authorization check. */
  projectId: string
  onComplete?: (fullText: string) => void
  /** A turn that failed mid-stream. `fullText` is whatever arrived before the
   * failure — the server persists the same partial, so committing it here
   * keeps the view consistent with what a reload will show. */
  onError?: (message: string, fullText: string) => void
}

export function useProspectStream({
  runId,
  projectId,
  onComplete,
  onError,
}: UseProspectStreamOptions) {
  const [streamingText, setStreamingText] = useState("")
  const [parts, setParts] = useState<ProspectStreamPart[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)
  const fullTextRef = useRef("")
  // Ordered parts (text runs + tool chips) with lookup maps for in-place
  // updates as deltas/results arrive.
  const partsRef = useRef<ProspectStreamPart[]>([])
  const textPartsRef = useRef<Map<string, TextPart>>(new Map())
  const toolPartsRef = useRef<Map<string, ToolPart>>(new Map())
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  // A failed turn emits ERROR then FINISH. Both carry the same partial text,
  // so without this flag the FINISH would commit the reply a second time.
  const erroredRef = useRef(false)

  useEffect(() => {
    if (!runId) return

    let cancelled = false
    setIsStreaming(true)
    setStreamingText("")
    setParts([])
    erroredRef.current = false
    fullTextRef.current = ""
    partsRef.current = []
    textPartsRef.current = new Map()
    toolPartsRef.current = new Map()

    async function subscribe() {
      const url = runStreamUrl(SERVICE_URL, runId!)

      // On a brand-new run the producer may not have created the durable
      // stream yet (invoke is async), so `stream()` fails. Retry with backoff
      // until it exists, so live tokens show from the first delta.
      const MAX_ATTEMPTS = 16 // ~8s at 500ms
      const RETRY_MS = 500

      let res: Awaited<ReturnType<typeof stream<Message>>> | null = null
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          // The API is cross-origin in dev (web :3000 → api :4000), so the
          // default "same-origin" credentials mode drops the auth cookie.
          // Force it to be sent so the /v1/stream proxy's session check passes.
          res = await stream<Message>({
            url,
            offset: "-1",
            live: "sse",
            params: { projectId },
            fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
              fetch(input, { ...init, credentials: "include" })) as typeof fetch,
          })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        }
      }
      if (!res || cancelled) {
        if (!cancelled) setIsStreaming(false)
        res?.cancel()
        return
      }
      const connected = res

      cancelRef.current = () => connected.cancel()

      const unsubscribe = connected.subscribeJson(async (batch) => {
        if (cancelled) return

        for (const item of batch.items) {
          const msg = item as Message
          if (msg.event_type === eventTypes.TEXT_START && "id" in msg) {
            if (!textPartsRef.current.has(msg.id)) {
              const part: TextPart = { type: "text", text: "", streaming: true }
              textPartsRef.current.set(msg.id, part)
              partsRef.current.push(part)
            }
          } else if (msg.event_type === eventTypes.TEXT_DELTA && "delta" in msg) {
            let part = textPartsRef.current.get(msg.id)
            if (!part) {
              part = { type: "text", text: "", streaming: true }
              textPartsRef.current.set(msg.id, part)
              partsRef.current.push(part)
            }
            part.text += msg.delta
            fullTextRef.current += msg.delta
            setStreamingText(fullTextRef.current)
          } else if (msg.event_type === eventTypes.TEXT_END && "id" in msg) {
            const part = textPartsRef.current.get(msg.id)
            if (part) part.streaming = false
          } else if (msg.event_type === eventTypes.TOOL_INPUT_START) {
            if (!toolPartsRef.current.has(msg.toolCallId)) {
              const part: ToolPart = {
                type: "tool",
                stepId: msg.toolCallId,
                toolName: msg.toolName,
                label: toolLabel(msg.toolName),
                status: "running",
              }
              toolPartsRef.current.set(msg.toolCallId, part)
              partsRef.current.push(part)
            }
          } else if (msg.event_type === eventTypes.TOOL_RESULT) {
            const part = toolPartsRef.current.get(msg.toolCallId)
            if (part) part.status = "completed"
          } else if (msg.event_type === eventTypes.FINISH) {
            setIsStreaming(false)
            if (!erroredRef.current) {
              onCompleteRef.current?.(fullTextRef.current)
            }
          } else if (msg.event_type === eventTypes.ERROR) {
            setIsStreaming(false)
            erroredRef.current = true
            const detail =
              msg.data && typeof msg.data === "object" && "message" in msg.data
                ? String(msg.data.message)
                : "The prospect agent failed to finish its reply."
            onErrorRef.current?.(detail, fullTextRef.current)
          }
        }

        // New array identity so React re-renders; part objects are mutated
        // in place and re-read during render.
        setParts([...partsRef.current])

        if (batch.streamClosed) {
          setIsStreaming(false)
        }
      })

      cancelRef.current = () => {
        unsubscribe()
        connected.cancel()
      }
    }

    subscribe().catch(() => {
      if (!cancelled) setIsStreaming(false)
    })

    return () => {
      cancelled = true
      cancelRef.current?.()
      cancelRef.current = null
    }
  }, [runId, projectId])

  const cancel = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    setIsStreaming(false)
  }, [])

  return { streamingText, parts, isStreaming, cancel }
}
