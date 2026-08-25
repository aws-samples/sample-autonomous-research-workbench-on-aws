import { tool } from "ai";
import { z } from "zod";

/**
 * Current date/time tool.
 *
 * Returns the exact current date and time at call time, in both machine
 * (ISO 8601 / epoch) and human-readable forms, plus the resolved IANA time
 * zone. The system prompt only carries the current month + year (to stay
 * cacheable), so the agent should call this whenever a task depends on the
 * precise day, date, or time.
 */

const NAME = "current-datetime" as const;

export const currentDateTime = tool({
  description:
    "Get the exact current date and time at the moment of the call. Returns ISO 8601 and epoch values, a human-readable date/time, and the IANA time zone. Use this whenever you need the precise day, date, weekday, or time — e.g. computing ages, durations, deadlines, or resolving 'today'/'now' — instead of guessing.",
  inputSchema: z.object({
    timeZone: z
      .string()
      .optional()
      .describe(
        "Optional IANA time zone (e.g. 'America/New_York', 'Asia/Seoul'). Defaults to the server's local time zone when omitted."
      ),
  }),
  execute: async ({ timeZone }) => {
    const now = new Date();

    const resolvedTimeZone =
      timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: resolvedTimeZone,
        dateStyle: "full",
        timeStyle: "long",
      });

      return {
        type: NAME,
        iso: now.toISOString(),
        epochMs: now.getTime(),
        timeZone: resolvedTimeZone,
        readable: formatter.format(now),
      };
    } catch (error) {
      // An invalid timeZone throws a RangeError; fall back to UTC so the agent
      // still gets a usable answer rather than a hard failure.
      return {
        type: NAME,
        iso: now.toISOString(),
        epochMs: now.getTime(),
        timeZone: "UTC",
        readable: now.toUTCString(),
        warning: `Invalid time zone "${timeZone}"; returned UTC instead.`,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
