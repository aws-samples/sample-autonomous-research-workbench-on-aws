/**
 * REQUEST interceptor for the AgentCore Gateway.
 *
 * Client-provided request headers do NOT reach a Lambda target on their own —
 * the gateway only forwards headers that a REQUEST interceptor (invoked with
 * passRequestHeaders=true) echoes back in `transformedGatewayRequest.headers`.
 * This interceptor forwards the allowlisted `x-project-id` header so it lands
 * in the tool Lambda's client context under `bedrockAgentCorePropagatedHeaders`.
 *
 * Contract notes (see the Gateway interceptor docs / FLS runbook):
 *  - `body` MUST be returned unchanged; omitting it makes the gateway forward an
 *    empty request to the target.
 *  - Only return headers to inject — do NOT spread the inbound infrastructure
 *    headers (Host, X-Forwarded-*, etc.), which breaks gateway routing.
 *  - Forwarded headers must still be in the target's allowedRequestHeaders.
 */
const FORWARDED_HEADERS = ["x-project-id"] as const;

interface InterceptorEvent {
  mcp?: {
    gatewayRequest?: {
      headers?: Record<string, string>;
      body?: unknown;
    };
  };
}

/** Case-insensitive lookup over a header bag. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export async function handler(event: InterceptorEvent) {
  const gatewayRequest = event.mcp?.gatewayRequest ?? {};
  const inbound = gatewayRequest.headers;

  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headerValue(inbound, name);
    if (value !== undefined) forwarded[name] = value;
  }

  console.log(
    JSON.stringify({
      msg: "gateway request interceptor",
      inboundHeaderKeys: inbound ? Object.keys(inbound) : [],
      forwardedHeaderKeys: forwarded,
      // Full event shape (minus header values) so we can see exactly where the
      // body lives and what keys the gateway sends the interceptor.
      eventTopKeys: Object.keys(event ?? {}),
      mcpKeys: event.mcp ? Object.keys(event.mcp) : [],
      gatewayRequestKeys: Object.keys(gatewayRequest),
      hasBody: gatewayRequest.body !== undefined,
      bodyType: typeof gatewayRequest.body,
    }),
  );

  return {
    interceptorOutputVersion: "1.0",
    mcp: {
      transformedGatewayRequest: {
        headers: forwarded,
        // Pass the body through unchanged — required by the gateway contract.
        body: gatewayRequest.body,
      },
    },
  };
}
