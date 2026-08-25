import { tool } from "ai";
import { z } from "zod";
import { withBrowser } from "./browser-session";

/**
 * Web-search tool backed by the AWS Bedrock AgentCore Browser.
 *
 * Unlike a search API, AgentCore Browser is a real remote Chrome driven over
 * CDP, so "search" here means: drive DuckDuckGo's no-JS HTML endpoint and
 * extract the result list from the DOM. The browser runs in AWS, not in this
 * container — `playwright` is used purely as a CDP client
 * (`chromium.connectOverCDP`), so no browser binaries are needed in the image.
 *
 * The tool keeps the shape of the Exa-backed tool it replaced (`{ query,
 * count, results[] }` with `highlights`/`highlightScores`) so the UI renderer
 * and any prompt references keep working. `highlights` carries the SERP
 * snippet, and `highlightScores` is empty — a DOM scrape has no relevance
 * scores to report, and inventing them would misrepresent the source.
 *
 * Failures return a structured `{ error }` payload rather than throwing, so
 * the model can react and the UI can render the failure.
 */

/** Cap full-page text so a single search can't blow the context window. */
const TEXT_MAX_CHARACTERS = 8000;

/** Per-navigation cap. Search pages are light; a slow one shouldn't stall a run. */
const NAVIGATION_TIMEOUT_MS = 30_000;

type WebSearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  favicon?: string;
  highlights: string[];
  highlightScores: number[];
  text?: string;
};

/** Raw shape scraped out of the SERP DOM. */
type ScrapedResult = {
  title: string | null;
  url: string | null;
  snippet: string | null;
};

/**
 * Result extraction, evaluated in the page.
 *
 * Must be an EXPRESSION, not an arrow function: the client forwards the string
 * to Playwright's `page.evaluate`, which returns undefined for a function
 * source passed without matching arguments.
 *
 * Written as ES5 (`var`, `function`) with no optional chaining because it is
 * serialized into whatever Chrome the browser tool runs.
 */
const EXTRACT_RESULTS_SCRIPT = `Array.from(document.querySelectorAll('div.result')).map(function (row) {
  var link = row.querySelector('a.result__a');
  var snippet = row.querySelector('.result__snippet');
  return {
    title: link ? link.innerText.trim() : null,
    url: link ? link.href : null,
    snippet: snippet ? snippet.innerText.trim() : null
  };
}).filter(function (item) { return item.url && item.title; })`;

/** Readable page text, used when `includeText` is set. */
const EXTRACT_PAGE_TEXT_SCRIPT = `(document.body ? document.body.innerText : '')`;

/**
 * DuckDuckGo wraps outbound links as `/l/?uddg=<encoded>`. Unwrap them so the
 * model and the UI get the real destination (and so `includeText` navigates to
 * the page itself rather than a redirector).
 */
function decodeResultUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (
      (parsed.hostname === "duckduckgo.com" ||
        parsed.hostname.endsWith(".duckduckgo.com")) &&
      parsed.pathname === "/l/"
    ) {
      const target = parsed.searchParams.get("uddg");
      if (target) {
        return target;
      }
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Apply domain filters as DuckDuckGo query operators. The HTML endpoint has no
 * structured filter parameters, so include/exclude are expressed in the query
 * itself: `site:` for a single include (multiple includes are OR-ed) and
 * `-site:` per exclusion.
 */
function buildQuery(
  query: string,
  includeDomains?: string[],
  excludeDomains?: string[]
): string {
  const parts = [query.trim()];

  const includes = (includeDomains ?? []).filter((d) => d.trim().length > 0);
  if (includes.length === 1) {
    parts.push(`site:${includes[0]}`);
  } else if (includes.length > 1) {
    parts.push(`(${includes.map((d) => `site:${d}`).join(" OR ")})`);
  }

  for (const domain of excludeDomains ?? []) {
    if (domain.trim().length > 0) {
      parts.push(`-site:${domain}`);
    }
  }

  return parts.join(" ");
}

export const webSearch = tool({
  description:
    "Search the live web and return the most relevant results. Use this for current events, recent facts, documentation, prices, or anything outside your training knowledge or the sandbox. Returns each result's title, URL, and a snippet; set includeText to also open each result and pull its page text for deeper reading (slower). Prefer concise, specific queries.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Search query. Keyword-style queries work best; this searches a real search engine, not a semantic index."
      ),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Number of results to return (1-10)."),
    includeText: z
      .boolean()
      .default(false)
      .describe(
        "When true, open each result and include its page text (capped) in addition to the snippet. Much slower — one page load per result. Leave false for token-efficient snippet-only results."
      ),
    includeDomains: z
      .array(z.string())
      .optional()
      .describe("Only return results from these domains."),
    excludeDomains: z
      .array(z.string())
      .optional()
      .describe("Exclude results from these domains."),
  }),
  execute: async ({
    query,
    numResults,
    includeText,
    includeDomains,
    excludeDomains,
  }) => {
    try {
      // Serialized: the shared session allows one navigation at a time, and
      // models often fire several searches in parallel.
      return await withBrowser(async (browser) => {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
          buildQuery(query, includeDomains, excludeDomains)
        )}`;

        await browser.navigate({
          url: searchUrl,
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });

        const scraped = (await browser.evaluate({
          script: EXTRACT_RESULTS_SCRIPT,
        })) as ScrapedResult[] | undefined;

        const results: WebSearchResult[] = (scraped ?? [])
          .slice(0, numResults)
          .map((item) => {
            const url = decodeResultUrl(item.url!);
            return {
              title: (item.title ?? "").trim() || url,
              url,
              highlights: item.snippet ? [item.snippet] : [],
              // A DOM scrape yields no relevance scores; report none rather
              // than fabricate them.
              highlightScores: [],
            };
          });

        // Full page text is opt-in: it costs one navigation per result, so it
        // runs sequentially on the single shared browser tab.
        if (includeText) {
          for (const result of results) {
            try {
              await browser.navigate({
                url: result.url,
                waitUntil: "domcontentloaded",
                timeout: NAVIGATION_TIMEOUT_MS,
              });
              const text = (await browser.evaluate({
                script: EXTRACT_PAGE_TEXT_SCRIPT,
              })) as string | undefined;
              if (typeof text === "string" && text.length > 0) {
                result.text = text.slice(0, TEXT_MAX_CHARACTERS);
              }
            } catch {
              // One unreachable page must not fail the whole search; the
              // result keeps its snippet and simply has no `text`.
            }
          }
        }

        return {
          type: "web-search" as const,
          query,
          count: results.length,
          results,
        };
      });
    } catch (error) {
      return {
        type: "web-search" as const,
        query,
        error: "Web search failed",
        detail: error instanceof Error ? error.message : String(error),
        count: 0,
        results: [],
      };
    }
  },
});
