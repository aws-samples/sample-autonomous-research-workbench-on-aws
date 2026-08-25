/**
 * Static metadata for the tool registry, safe to import from API/UI code
 * without pulling in the tool implementations (which have heavy runtime
 * dependencies). The `id`s here must match the keys of `toolRegistry` in
 * `./index.ts`, and `tools` lists the tool names each config ID exposes to
 * the model.
 */
export type ToolCatalogEntry = {
  id: string;
  name: string;
  description: string;
  tools: string[];
};

export const toolCatalog: ToolCatalogEntry[] = [
  {
    id: "current-datetime",
    name: "Current Date & Time",
    description: "Look up the current date and time.",
    tools: ["currentDateTime"],
  },
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the web for up-to-date information.",
    tools: ["webSearch"],
  },
  {
    id: "documents",
    name: "Documents",
    description: "Search and read documents in the knowledge base.",
    tools: ["queryDocuments", "getDocumentPage", "getDocument"],
  },
  // The three graph `id`s below are legacy identifiers: they are persisted in
  // `agent.tools`, so renaming them would need a data migration. The `name` and
  // `description` are what users actually read, so those carry the accurate
  // grouping — note "graph-epistemic" holds reads as well as writes.
  {
    id: "graph",
    name: "Knowledge Graph · Explore",
    description:
      "Query the knowledge graph of entities, relationships, and facts extracted from the document corpus. Read-only.",
    tools: [
      "graphSearch",
      "graphNeighborhood",
      "graphPaths",
      "graphOverview",
      "graphDocumentFacts",
    ],
  },
  {
    id: "graph-write",
    name: "Knowledge Graph · Add facts",
    description:
      "Append facts (subject–predicate–object triples) to the shared knowledge graph. Agent-authored facts are tracked separately from ingested ones. Append-only: facts cannot be edited or deleted, and there is no entity mutation. Enabled by default.",
    tools: ["graphAddFact"],
  },
  {
    id: "graph-epistemic",
    name: "Epistemic Graph · Hypotheses & Decisions",
    description:
      "Record and review reasoning in the epistemic graph: propose hypotheses, log observations, link evidence (supports/contradicts), update hypothesis status, record decisions, and list what this project already holds. Project- and run-scoped. Includes both reads and writes; enabled by default and mutates shared data.",
    tools: [
      "epistemicProposeHypothesis",
      "epistemicRecordObservation",
      "epistemicLinkEvidence",
      "epistemicSetHypothesisStatus",
      "epistemicRecordDecision",
      "epistemicListHypotheses",
      "epistemicListEvidence",
    ],
  },
  {
    id: "project-files",
    name: "Project Files",
    description:
      "Browse, read, and write the project's shared file directory with shell commands (ls, cat, grep, redirection). The same files the project's Files tab shows; only available to agents running inside a project.",
    tools: ["projectFilesShell"],
  },
  {
    id: "code-interpreter",
    name: "Code Interpreter",
    description: "Run code in a sandboxed environment.",
    tools: [
      "createSandboxSession",
      "stopSandboxSession",
      "executeCode",
      "executeCommand",
      "writeFiles",
      "readFiles",
      "listFiles",
    ],
  },
  {
    id: "subagents",
    name: "Sub-agents",
    description:
      "Delegate focused subtasks to specialist sub-agents running as other personas.",
    tools: ["runSubagent"],
  },
];

/**
 * IDs enabled for every agent by default. "project-files" degrades to a
 * structured error outside a project runtime, so it is safe as a default.
 * "graph-write" is included so agents can persist findings to the shared
 * knowledge graph out of the box; its writes are tracked as agent-authored
 * (verified_by='agent'), project-scoped, and independently reversible.
 */
export const DEFAULT_TOOL_IDS = [
  "current-datetime",
  "web-search",
  "documents",
  "graph",
  "graph-write",
  "graph-epistemic",
  "project-files",
];
