import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";

import { DEFAULT_MODEL_ID, getModel } from "../config";

// Resolve AWS credentials via the standard provider chain (env vars, shared
// config, and the ECS task role) so the same code works locally and in prod.
const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
});

// Follow the platform default model (packages/agent/core/config.ts) so this
// never drifts to a model the account isn't subscribed to separately.
const SUGGESTIONS_MODEL_ID = getModel(DEFAULT_MODEL_ID).modelId;

const MAX_SUGGESTIONS = 4;

const suggestionsSchema = z.object({
  suggestions: z
    .array(
      z
        .string()
        .describe("A concise follow-up query the user might ask next"),
    )
    .min(2)
    .max(MAX_SUGGESTIONS),
});

const SYSTEM_PROMPT = [
  "You generate suggested follow-up queries for a research assistant.",
  "Given the latest exchange between a user and the assistant, propose 2-4 short",
  "questions the user is likely to ask next to dig deeper or take the next step.",
  "",
  "Rules:",
  "- Output only the suggestions, as the structured object. No preamble or",
  "  commentary.",
  "- Each suggestion is a single concise question or instruction (ideally under",
  "  12 words) phrased as the user would type it.",
  "- Write the suggestions in the SAME language as the conversation. If the",
  "  conversation is in Korean, write them in Korean; if English, write them in",
  "  English. Never translate to English by default.",
  "- Make them specific and grounded in the actual content of the exchange, not",
  "  generic. Avoid duplicating what the user already asked.",
  "- Suggest natural next steps: deeper analysis, comparisons, related topics,",
  "  or actions building on the assistant's answer.",
].join("\n");

const MAX_CHARS_PER_MESSAGE = 4000;

function textFromContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const { text } = part as { text?: unknown };
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS_PER_MESSAGE) return trimmed;
  return `${trimmed.slice(0, MAX_CHARS_PER_MESSAGE).trimEnd()}…`;
}

/**
 * Build a compact prompt from the most recent user message and the final
 * assistant answer, so suggestions are relevant follow-ups without sending the
 * entire history (and its token bloat).
 */
function buildPrompt(messages: ModelMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  const userText = lastUser ? truncate(textFromContent(lastUser.content)) : "";
  const assistantText = lastAssistant
    ? truncate(textFromContent(lastAssistant.content))
    : "";

  return [
    "User's last message:",
    '"""',
    userText || "(none)",
    '"""',
    "",
    "Assistant's answer:",
    '"""',
    assistantText || "(none)",
    '"""',
    "",
    "Suggested follow-up queries:",
  ].join("\n");
}

/**
 * Generate 2-4 suggested follow-up queries from the conversation history using
 * Claude Sonnet 4.6 (via Bedrock) with structured output. Returns an empty
 * array if the model call fails or returns nothing, so a run never breaks on
 * suggestion generation.
 */
export async function generateSuggestions(
  messages: ModelMessage[],
): Promise<string[]> {
  if (messages.length === 0) return [];

  try {
    const { output } = await generateText({
      model: bedrock(SUGGESTIONS_MODEL_ID),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(messages),
      output: Output.object({ schema: suggestionsSchema }),
      temperature: 0.4,
      maxOutputTokens: 256,
    });

    return output.suggestions
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS);
  } catch (error) {
    console.error("[generateSuggestions] skipping suggestions", { error });
    return [];
  }
}
