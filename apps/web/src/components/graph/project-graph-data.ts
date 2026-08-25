export type ProjectNodeKind =
  | "hypothesis"
  | "observation"
  | "evidence"
  | "paper"
  | "simulation"
  | "target"
  | "agent"
  | "entity"

export type HypothesisStatus = "proposed" | "supported" | "refuted"

export type Confidence = "low" | "medium" | "high"

export interface NodeMeta {
  pmid?: string
  doi?: string
  jobId?: string
  reactomeId?: string
  url?: string
}

export interface ProjectNode {
  id: string
  label: string
  kind: ProjectNodeKind
  summary?: string
  /** For hypotheses: the agent that proposed it. */
  agent?: string
  /** For hypotheses: the reasoning narrative behind the claim. */
  reasoning?: string
  confidence?: Confidence
  status?: HypothesisStatus
  /** Node ids that support this node (mainly used by hypotheses). */
  evidenceFor?: string[]
  /** Node ids that refute this node. */
  evidenceAgainst?: string[]
  meta?: NodeMeta
}

export interface ProjectEdge {
  source: string
  target: string
  relation?: string
}

export interface ProjectGraphData {
  id: string
  name: string
  description: string
  nodes: ProjectNode[]
  edges: ProjectEdge[]
}

// A single cohesive sample program: a target-enabling effort around a cryptic
// allosteric pocket on "Target X" (a kinase-adjacent target). Agents propose
// hypotheses; observations, simulations, papers, and Reactome targets supply
// the supporting or refuting evidence.
export const project: ProjectGraphData = {
  id: "prog-target-x",
  name: "Target X allosteric program",
  description:
    "Hypotheses, observations, and evidence for an allosteric inhibitor program against Target X.",
  nodes: [
    // Agents
    {
      id: "agent-target-bio",
      label: "Target Biology Analyst",
      kind: "agent",
      summary: "Proposes and tests target-biology hypotheses.",
    },
    {
      id: "agent-medchem",
      label: "Medicinal Chemistry Analyst",
      kind: "agent",
      summary: "Reasons about SAR, properties, and scaffold design.",
    },
    {
      id: "agent-dmpk",
      label: "DMPK & Safety Reviewer",
      kind: "agent",
      summary: "Evaluates clearance, selectivity, and liability risk.",
    },

    // Targets / entities
    {
      id: "target-x",
      label: "Target X (kinase)",
      kind: "target",
      summary: "Primary program target; serine/threonine kinase.",
      meta: { reactomeId: "R-HSA-5673001" },
    },
    {
      id: "entity-pocket",
      label: "Cryptic allosteric pocket",
      kind: "entity",
      summary: "Transient pocket near the activation loop.",
    },
    {
      id: "entity-gating-res",
      label: "Gating residue (L412)",
      kind: "entity",
      summary: "Flexible residue that controls pocket opening.",
    },
    {
      id: "entity-frag-a",
      label: "Fragment A",
      kind: "entity",
      summary: "Pyrazole fragment, 1.8 mM, ligand-efficient.",
    },
    {
      id: "entity-frag-b",
      label: "Fragment B",
      kind: "entity",
      summary: "Aminopyridine fragment with orthogonal vector.",
    },
    {
      id: "entity-lead-series",
      label: "Lead series (TX-200)",
      kind: "entity",
      summary: "Fragment-grown series occupying the allosteric pocket.",
    },
    {
      id: "target-pathway",
      label: "MAPK signaling pathway",
      kind: "target",
      summary: "Downstream pathway modulated by Target X.",
      meta: { reactomeId: "R-HSA-5683057" },
    },

    // Hypotheses
    {
      id: "hyp-pocket-druggable",
      label: "Allosteric pocket is druggable",
      kind: "hypothesis",
      agent: "Target Biology Analyst",
      status: "supported",
      confidence: "high",
      reasoning:
        "MD simulations show the cryptic pocket opens in a majority of frames, and three independent fragment soaks produced co-crystal structures occupying it. The pocket has a defined hydrophobic floor and a polar rim, consistent with a ligandable site rather than a transient artefact.",
      summary:
        "The cryptic allosteric pocket on Target X can be engaged by small molecules.",
      evidenceFor: ["obs-md-occupancy", "obs-fragment-soak", "sim-pocket-fe", "paper-cryptic"],
      evidenceAgainst: ["obs-apo-closed"],
    },
    {
      id: "hyp-allosteric-selective",
      label: "Allosteric site confers selectivity",
      kind: "hypothesis",
      agent: "DMPK & Safety Reviewer",
      status: "proposed",
      confidence: "medium",
      reasoning:
        "The gating residue is poorly conserved across the kinase subfamily, so an allosteric binder should avoid the conserved ATP site and improve selectivity. Early panel data is encouraging but incomplete, so this remains a working hypothesis.",
      summary:
        "Targeting the allosteric pocket should give better kinome selectivity than ATP-competitive binding.",
      evidenceFor: ["obs-panel-clean", "paper-allosteric-sel"],
      evidenceAgainst: ["obs-offtarget-subfamily"],
    },
    {
      id: "hyp-fragment-led",
      label: "Fragment-led series is the best start",
      kind: "hypothesis",
      agent: "Medicinal Chemistry Analyst",
      status: "supported",
      confidence: "high",
      reasoning:
        "Fragment hits confirm at higher orthogonal rates by SPR/ITC and grow cleanly into the pocket, whereas DEL hits carry more false positives. The matched-pair analysis favours growing Fragment A with DEL chemotypes held as backup.",
      summary:
        "Grow the fragment hits into the lead series rather than leading with DEL hits.",
      evidenceFor: ["obs-spr-confirm", "sim-growth-vector"],
    },
    {
      id: "hyp-benzylic-softspot",
      label: "Benzylic soft spot limits clearance",
      kind: "hypothesis",
      agent: "DMPK & Safety Reviewer",
      status: "supported",
      confidence: "medium",
      reasoning:
        "HLM turnover tracks with the exposed benzylic position; a fluorine block at that site is predicted to lower intrinsic clearance without harming potency.",
      summary: "Benzylic oxidation is the dominant metabolic liability in the series.",
      evidenceFor: ["obs-hlm", "sim-clearance"],
    },

    // Observations
    {
      id: "obs-md-occupancy",
      label: "MD pocket occupancy 60%",
      kind: "observation",
      summary: "Pocket open in 60% of 2 µs MD frames.",
    },
    {
      id: "obs-fragment-soak",
      label: "3 fragment co-crystals",
      kind: "observation",
      summary: "Three confirmed co-crystal structures in the pocket.",
    },
    {
      id: "obs-apo-closed",
      label: "Apo structure pocket closed",
      kind: "observation",
      summary: "The apo crystal form shows the pocket fully collapsed.",
    },
    {
      id: "obs-spr-confirm",
      label: "SPR confirms fragments",
      kind: "observation",
      summary: "Fragment A/B confirmed by SPR and ITC.",
    },
    {
      id: "obs-panel-clean",
      label: "Kinase panel clean at 10 µM",
      kind: "observation",
      summary: "No major off-target inhibition in the early panel.",
    },
    {
      id: "obs-offtarget-subfamily",
      label: "Subfamily off-target hits",
      kind: "observation",
      summary: "Two related kinases show weak inhibition.",
    },
    {
      id: "obs-hlm",
      label: "HLM soft spot at benzylic",
      kind: "observation",
      summary: "Benzylic oxidation drives microsomal turnover.",
    },

    // Simulations (SLURM workloads)
    {
      id: "sim-pocket-fe",
      label: "Pocket free-energy run",
      kind: "simulation",
      summary: "Free-energy of pocket opening ≈ 2.1 kcal/mol.",
      meta: { jobId: "slurm-48213" },
    },
    {
      id: "sim-growth-vector",
      label: "Fragment growth FEP",
      kind: "simulation",
      summary: "FEP ranks eastern growth vector best for potency.",
      meta: { jobId: "slurm-48576" },
    },
    {
      id: "sim-clearance",
      label: "Clearance projection",
      kind: "simulation",
      summary: "Well-stirred model: 23/24 analogs within target Cl.",
      meta: { jobId: "slurm-49002" },
    },

    // Papers (PubMed)
    {
      id: "paper-cryptic",
      label: "Cryptic pockets in kinases",
      kind: "paper",
      summary: "Review of cryptic allosteric pockets across the kinome.",
      meta: { pmid: "34567890", doi: "10.1021/jacs.1c00000" },
    },
    {
      id: "paper-allosteric-sel",
      label: "Allosteric selectivity precedent",
      kind: "paper",
      summary: "Case studies of allosteric kinase inhibitor selectivity.",
      meta: { pmid: "33123456", doi: "10.1038/s41589-020-0000-0" },
    },

    // Evidence (aggregated supporting artefacts)
    {
      id: "evidence-cocrystal-pack",
      label: "Co-crystal evidence pack",
      kind: "evidence",
      summary: "Curated structural package for the allosteric pocket.",
    },
  ],
  edges: [
    // Agents propose hypotheses
    { source: "agent-target-bio", target: "hyp-pocket-druggable", relation: "proposes" },
    { source: "agent-dmpk", target: "hyp-allosteric-selective", relation: "proposes" },
    { source: "agent-medchem", target: "hyp-fragment-led", relation: "proposes" },
    { source: "agent-dmpk", target: "hyp-benzylic-softspot", relation: "proposes" },

    // Hypotheses anchored to the target / entities
    { source: "hyp-pocket-druggable", target: "target-x", relation: "about" },
    { source: "hyp-pocket-druggable", target: "entity-pocket", relation: "about" },
    { source: "hyp-allosteric-selective", target: "entity-pocket", relation: "about" },
    { source: "hyp-fragment-led", target: "entity-lead-series", relation: "about" },
    { source: "hyp-benzylic-softspot", target: "entity-lead-series", relation: "about" },

    // Target / entity structure
    { source: "target-x", target: "entity-pocket", relation: "has_site" },
    { source: "entity-pocket", target: "entity-gating-res", relation: "gated_by" },
    { source: "entity-pocket", target: "entity-frag-a", relation: "binds" },
    { source: "entity-pocket", target: "entity-frag-b", relation: "binds" },
    { source: "entity-frag-a", target: "entity-lead-series", relation: "grown_into" },
    { source: "target-x", target: "target-pathway", relation: "signals_through" },

    // Hypothesis 1 evidence
    { source: "hyp-pocket-druggable", target: "obs-md-occupancy", relation: "supported_by" },
    { source: "hyp-pocket-druggable", target: "obs-fragment-soak", relation: "supported_by" },
    { source: "hyp-pocket-druggable", target: "sim-pocket-fe", relation: "supported_by" },
    { source: "hyp-pocket-druggable", target: "paper-cryptic", relation: "supported_by" },
    { source: "hyp-pocket-druggable", target: "obs-apo-closed", relation: "refuted_by" },
    { source: "obs-fragment-soak", target: "evidence-cocrystal-pack", relation: "rolled_into" },
    { source: "evidence-cocrystal-pack", target: "entity-pocket", relation: "about" },

    // Hypothesis 2 evidence
    { source: "hyp-allosteric-selective", target: "obs-panel-clean", relation: "supported_by" },
    { source: "hyp-allosteric-selective", target: "paper-allosteric-sel", relation: "supported_by" },
    { source: "hyp-allosteric-selective", target: "obs-offtarget-subfamily", relation: "refuted_by" },
    { source: "obs-panel-clean", target: "entity-gating-res", relation: "about" },

    // Hypothesis 3 evidence
    { source: "hyp-fragment-led", target: "obs-spr-confirm", relation: "supported_by" },
    { source: "hyp-fragment-led", target: "sim-growth-vector", relation: "supported_by" },
    { source: "obs-spr-confirm", target: "entity-frag-a", relation: "about" },
    { source: "obs-spr-confirm", target: "entity-frag-b", relation: "about" },

    // Hypothesis 4 evidence
    { source: "hyp-benzylic-softspot", target: "obs-hlm", relation: "supported_by" },
    { source: "hyp-benzylic-softspot", target: "sim-clearance", relation: "supported_by" },
    { source: "obs-hlm", target: "entity-lead-series", relation: "about" },
  ],
}
