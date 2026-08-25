import type { Tool } from "ai";
import { currentDateTime } from "./datetime/current-datetime";
import { getDocument } from "./documents/get-document";
import { getDocumentPage } from "./documents/get-page";
import { queryDocuments } from "./documents/query";
import {
  epistemicListEvidence,
  epistemicListHypotheses,
} from "./epistemic/read";
import {
  epistemicLinkEvidence,
  epistemicProposeHypothesis,
  epistemicRecordDecision,
  epistemicRecordObservation,
  epistemicSetHypothesisStatus,
} from "./epistemic/write";
import { graphDocumentFacts } from "./graph/document-facts";
import { graphNeighborhood } from "./graph/neighborhood";
import { graphOverview } from "./graph/overview";
import { graphPaths } from "./graph/paths";
import { graphSearch } from "./graph/search";
import { graphAddFact } from "./graph/write";
import { projectFilesShell } from "./files/shell";
import { sandboxTools } from "./sandbox/tools";
import { runSubagent } from "./subagent/run-subagent";
import { webSearch } from "./web/browser-search";
import { DEFAULT_TOOL_IDS } from "./catalog";

export {
  toolCatalog,
  DEFAULT_TOOL_IDS,
  type ToolCatalogEntry,
} from "./catalog";

/**
 * Registry of agent tools, keyed by a stable config ID.
 *
 * Each entry maps an ID to the tool record (the keys of which become the tool
 * names exposed to the model). `defaultTools()` returns the set that every
 * agent gets unless an explicit `tools` record is passed to the Agent.
 */
export const toolRegistry: Record<string, Record<string, Tool>> = {
  "current-datetime": {
    currentDateTime,
  },
  "web-search": {
    webSearch,
  },
  documents: {
    queryDocuments,
    getDocumentPage,
    getDocument,
  },
  // The three graph IDs are legacy: they live in `agent.tools` rows, so they
  // cannot be renamed without a data migration. The tools they expose and the
  // catalog labels carry the accurate naming instead.
  graph: {
    graphSearch,
    graphNeighborhood,
    graphPaths,
    graphOverview,
    graphDocumentFacts,
  },
  // Appends facts to the shared knowledge graph (append-only: no entity
  // mutation, no fact deletion). Enabled by default via DEFAULT_TOOL_IDS;
  // remove "graph-write" from an agent's toolIds to make it read-only.
  "graph-write": {
    graphAddFact,
  },
  // Epistemic graph: agent-authored hypotheses, observations, evidence links,
  // and decisions (dedicated node labels, not reified facts), plus the reads
  // that review them. Enabled by default via DEFAULT_TOOL_IDS; project- and
  // run-scoped like graph-write.
  "graph-epistemic": {
    epistemicProposeHypothesis,
    epistemicRecordObservation,
    epistemicLinkEvidence,
    epistemicSetHypothesisStatus,
    epistemicRecordDecision,
    epistemicListHypotheses,
    epistemicListEvidence,
  },
  // Shell access to the project's shared file directory (the S3 Files
  // mount on project runtimes). Opt-in per agent via the "project-files"
  // config ID; returns a structured error outside a project context.
  "project-files": {
    projectFilesShell,
  },
  "code-interpreter": sandboxTools,
  subagents: {
    runSubagent,
  },
};

/** Resolve config IDs to a merged tool record. Unknown IDs are ignored. */
export function resolveTools(toolIds: string[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const id of toolIds) {
    const entry = toolRegistry[id];
    if (entry) {
      Object.assign(tools, entry);
    }
  }
  return tools;
}

/** The default tool set every agent gets when none are explicitly configured. */
export function defaultTools(): Record<string, Tool> {
  return resolveTools(DEFAULT_TOOL_IDS);
}
