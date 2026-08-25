/**
 * Static fixtures for the Tools page. The page is a design mock: nothing here
 * is persisted or fetched, and "connecting" a server only mutates local React
 * state. Replace these with an MCP server registry route when the backend
 * lands.
 */

export type McpTransport = "http" | "sse" | "stdio";
export type McpAuthMode = "none" | "bearer" | "oauth";
export type McpServerStatus = "connected" | "disabled" | "error";

export type McpTool = {
	name: string;
	description: string;
};

export type McpServer = {
	id: string;
	name: string;
	description: string;
	transport: McpTransport;
	endpoint: string;
	auth: McpAuthMode;
	status: McpServerStatus;
	/** Pre-formatted so the mock stays stable between server and client renders. */
	lastSync: string;
	/** Number of agents that currently have this server enabled. */
	agentCount: number;
	tools: McpTool[];
	builtIn?: boolean;
};

export const MOCK_SERVERS: McpServer[] = [
	{
		id: "chembl",
		name: "ChEMBL",
		description:
			"Bioactivity, assay, and target data from the ChEMBL database of drug-like molecules.",
		transport: "http",
		endpoint: "https://mcp.ebi.ac.uk/chembl/mcp",
		auth: "none",
		status: "connected",
		lastSync: "12 minutes ago",
		agentCount: 6,
		tools: [
			{
				name: "searchCompounds",
				description: "Search compounds by name, InChIKey, or SMILES.",
			},
			{
				name: "getCompoundActivities",
				description: "Return measured activities for a compound.",
			},
			{
				name: "searchTargets",
				description: "Find targets by gene symbol or protein name.",
			},
			{
				name: "getAssay",
				description: "Fetch assay metadata and protocol details.",
			},
		],
	},
	{
		id: "uniprot",
		name: "UniProt",
		description:
			"Protein sequences, functional annotation, domains, and cross-references.",
		transport: "http",
		endpoint: "https://mcp.uniprot.org/mcp",
		auth: "none",
		status: "connected",
		lastSync: "1 hour ago",
		agentCount: 8,
		tools: [
			{
				name: "getProtein",
				description: "Retrieve a UniProt entry by accession.",
			},
			{
				name: "searchProteins",
				description: "Query proteins by organism, keyword, or family.",
			},
			{
				name: "getSequence",
				description: "Return the canonical amino-acid sequence.",
			},
		],
	},
	{
		id: "europepmc",
		name: "Europe PMC",
		description:
			"Full-text literature search across publications, preprints, and patents.",
		transport: "sse",
		endpoint: "https://mcp.europepmc.org/sse",
		auth: "bearer",
		status: "connected",
		lastSync: "4 hours ago",
		agentCount: 11,
		tools: [
			{
				name: "searchLiterature",
				description: "Boolean and phrase search over full text.",
			},
			{
				name: "getArticle",
				description: "Fetch an article's metadata and abstract.",
			},
			{
				name: "getCitations",
				description: "List citing and cited-by references.",
			},
		],
	},
	{
		id: "comp-chem",
		name: "Computational Chemistry",
		description:
			"Computational chemistry workflows — docking, RAMD, reactivity, and IFP — over the internal PrivateLink endpoint.",
		transport: "http",
		endpoint: "http://workflows.sampleco.internal/mcp",
		auth: "oauth",
		status: "connected",
		lastSync: "23 minutes ago",
		agentCount: 3,
		tools: [
			{
				name: "submitDocking",
				description: "Queue a docking run against a prepared receptor.",
			},
			{
				name: "submitRamd",
				description: "Launch a random-acceleration MD dissociation run.",
			},
			{
				name: "submitReactivity",
				description: "Compute reactivity descriptors for a ligand set.",
			},
			{ name: "getJobStatus", description: "Poll a submitted workflow job." },
			{
				name: "fetchResults",
				description: "Download result artifacts for a finished job.",
			},
		],
	},
	{
		id: "alphafold",
		name: "AlphaFold DB",
		description:
			"Predicted protein structures with per-residue confidence scores.",
		transport: "http",
		endpoint: "https://mcp.alphafold.ebi.ac.uk/mcp",
		auth: "none",
		status: "disabled",
		lastSync: "2 days ago",
		agentCount: 0,
		tools: [
			{
				name: "getPrediction",
				description: "Fetch a predicted structure by accession.",
			},
			{
				name: "getConfidence",
				description: "Return pLDDT and PAE confidence arrays.",
			},
		],
	},
	{
		id: "eln",
		name: "Internal ELN",
		description:
			"Read-only bridge to the electronic lab notebook: experiments, batches, and assay readouts.",
		transport: "stdio",
		endpoint: "npx -y @example-org/eln-mcp --readonly",
		auth: "bearer",
		status: "error",
		lastSync: "Failed 3 hours ago",
		agentCount: 2,
		tools: [
			{
				name: "searchExperiments",
				description: "Search notebook entries by project or author.",
			},
			{
				name: "getBatchRecord",
				description: "Return a synthesis batch record.",
			},
		],
	},
];

/**
 * Curated servers offered in the "Registry" tab of the add dialog. `tools` is
 * what a real `tools/list` handshake would return once connected.
 */
export type RegistryEntry = {
	id: string;
	name: string;
	description: string;
	transport: McpTransport;
	endpoint: string;
	auth: McpAuthMode;
	category: string;
	tools: McpTool[];
};

export const MOCK_REGISTRY: RegistryEntry[] = [
	{
		id: "pdb",
		name: "RCSB PDB",
		description:
			"Experimental structures, ligand binding sites, and structure-quality metrics.",
		transport: "http",
		endpoint: "https://mcp.rcsb.org/mcp",
		auth: "none",
		category: "Structural biology",
		tools: [
			{ name: "searchStructures", description: "Search PDB entries." },
			{ name: "getStructure", description: "Fetch an entry by PDB ID." },
			{
				name: "getLigands",
				description: "List bound ligands and their contacts.",
			},
		],
	},
	{
		id: "pubchem",
		name: "PubChem",
		description:
			"Chemical identity, properties, and bioassay summaries for 100M+ compounds.",
		transport: "http",
		endpoint: "https://mcp.pubchem.ncbi.nlm.nih.gov/mcp",
		auth: "none",
		category: "Chemistry",
		tools: [
			{
				name: "searchCompound",
				description: "Resolve a name or SMILES to a CID.",
			},
			{ name: "getProperties", description: "Return computed properties." },
			{ name: "getBioassays", description: "Summarize assay outcomes." },
		],
	},
	{
		id: "clinicaltrials",
		name: "ClinicalTrials.gov",
		description:
			"Trial registrations, phases, endpoints, and sponsor information.",
		transport: "http",
		endpoint: "https://mcp.clinicaltrials.gov/mcp",
		auth: "none",
		category: "Clinical",
		tools: [
			{
				name: "searchTrials",
				description: "Search trials by condition or drug.",
			},
			{ name: "getTrial", description: "Fetch a trial by NCT number." },
		],
	},
	{
		id: "benchling",
		name: "Benchling",
		description:
			"Registry entities, sequences, and results from the Benchling tenant.",
		transport: "http",
		endpoint: "https://mcp.benchling.com/mcp",
		auth: "oauth",
		category: "Lab systems",
		tools: [
			{ name: "searchEntities", description: "Search the registry." },
			{ name: "getSequence", description: "Read a DNA or AA sequence." },
			{ name: "getAssayResults", description: "Pull assay result tables." },
		],
	},
	{
		id: "s3-datasets",
		name: "S3 Datasets",
		description:
			"Browse and read curated datasets from the platform's S3 data lake.",
		transport: "stdio",
		endpoint: "uvx s3-datasets-mcp --bucket research-datasets",
		auth: "none",
		category: "Data",
		tools: [
			{ name: "listDatasets", description: "List available datasets." },
			{ name: "readTable", description: "Read a Parquet or CSV table." },
		],
	},
	{
		id: "slack",
		name: "Slack",
		description: "Post run summaries and escalations to research channels.",
		transport: "http",
		endpoint: "https://mcp.slack.com/mcp",
		auth: "oauth",
		category: "Collaboration",
		tools: [
			{ name: "postMessage", description: "Send a message to a channel." },
			{ name: "searchMessages", description: "Search channel history." },
		],
	},
];

/** Tools "discovered" by the mock handshake for a hand-entered server. */
export const MOCK_DISCOVERED_TOOLS: McpTool[] = [
	{
		name: "listResources",
		description: "Enumerate resources the server exposes.",
	},
	{
		name: "search",
		description: "Full-text search across the server's corpus.",
	},
	{ name: "getRecord", description: "Fetch a single record by identifier." },
	{
		name: "runQuery",
		description: "Execute a structured query and stream rows.",
	},
];

export const TRANSPORT_LABELS: Record<McpTransport, string> = {
	http: "Streamable HTTP",
	sse: "SSE",
	stdio: "stdio",
};

export const AUTH_LABELS: Record<McpAuthMode, string> = {
	none: "None",
	bearer: "Bearer token",
	oauth: "OAuth 2.1",
};
