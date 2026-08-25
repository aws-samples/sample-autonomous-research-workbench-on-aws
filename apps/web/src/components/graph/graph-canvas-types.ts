/**
 * Prop types for the Sigma canvas, kept in a module with no sigma imports so
 * consumers and the lazy wrapper can type against them without pulling
 * WebGL-touching code into the server bundle.
 */

export interface SigmaGraphNode {
  id: string
  label: string
  color: string
  size: number
}

export interface SigmaGraphLink {
  source: string
  target: string
  /**
   * Optional edge color. Left unset the canvas draws a neutral edge; consumers
   * set it where the relation type carries meaning of its own — an epistemic
   * `contradicts` edge must not read the same as `supports`.
   */
  color?: string
}

export interface SigmaGraphData {
  nodes: SigmaGraphNode[]
  links: SigmaGraphLink[]
}

export interface LegendItem {
  label: string
  color: string
}

export interface GraphCanvasProps {
  graph: SigmaGraphData
  legend: LegendItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onFocus: (id: string) => void
}
