export type UserMessage = {
  role: "user";
  content: string;
  metadata: Record<string, unknown>;
};

// Assistant messages - separate message per content block
export type AssistantMessageContent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string };

export type AssistantMessage = {
  role: "assistant";
  content: AssistantMessageContent;
  metadata: Record<string, unknown>;
};

// Tool messages
export type ToolMessage = {
  role: "tool";
  content: {
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
    output: unknown;
  };
  metadata: Record<string, unknown>;
};

// Platform messages (metrics, system info)
export type PlatformMessage = {
  role: "platform";
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | PlatformMessage;
