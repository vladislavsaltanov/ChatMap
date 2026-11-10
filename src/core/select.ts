import { edgeKey, parseEdgeKey, type PairStat, type TallyResult } from './tally'
import type { AuthorId } from './types'

export type ViewMode =
  | { kind: 'together' }
  | { kind: 'author'; author: AuthorId }
  | { kind: 'cross' }

export type ViewCfg = {
  mode: ViewMode
  topN: number
  minWeight: number
}

export type SelectionNode = {
  id: number
  count: number
}

export type SelectionEdge = {
  a: number
  b: number
  weight: number
}

export type Selection = {
  nodes: SelectionNode[]
  edges: SelectionEdge[]
  maxCount: number
  maxWeight: number
}

const MAX_EDGES = 10000

export function select(
  tallyData: TallyResult,
  cfg: ViewCfg,
  merged?: Map<number, number>
): Selection {
  let { counts, pairs } = tallyData

  if (merged && merged.size > 0) {
    const remappedCounts = new Map<number, Map<AuthorId, number>>()
    for (const [id, authorMap] of counts) {
      const root = merged.get(id) ?? id
      let targetMap = remappedCounts.get(root)
      if (!targetMap) {
        targetMap = new Map()
        remappedCounts.set(root, targetMap)
      }
      for (const [author, cnt] of authorMap) {
        targetMap.set(author, (targetMap.get(author) || 0) + cnt)
      }
    }
    counts = remappedCounts

    const remappedPairs = new Map<number, PairStat>()
    for (const [key, stat] of pairs) {
      const [a, b] = parseEdgeKey(key)
      const rootA = merged.get(a) ?? a
      const rootB = merged.get(b) ?? b
      if (rootA === rootB) continue

      const newKey = edgeKey(rootA, rootB)
      let targetStat = remappedPairs.get(newKey)
      if (!targetStat) {
        targetStat = { nX: new Map(), nCross: 0 }
        remappedPairs.set(newKey, targetStat)
      }
      targetStat.nCross += stat.nCross
      for (const [author, cnt] of stat.nX) {
        targetStat.nX.set(author, (targetStat.nX.get(author) || 0) + cnt)
      }
    }
    pairs = remappedPairs
  }

  const crossNodes = new Set<number>()
  if (cfg.mode.kind === 'cross') {
    for (const [key, stat] of pairs) {
      if (stat.nCross > 0) {
        const [a, b] = parseEdgeKey(key)
        crossNodes.add(a)
        crossNodes.add(b)
      }
    }
  }

  const candidateNodes: SelectionNode[] = []
  for (const [id, authorMap] of counts) {
    let count = 0
    if (cfg.mode.kind === 'together') {
      for (const c of authorMap.values()) count += c
    } else if (cfg.mode.kind === 'author') {
      count = authorMap.get(cfg.mode.author) || 0
    } else {
      if (!crossNodes.has(id)) continue
      for (const c of authorMap.values()) count += c
    }

    if (count > 0) {
      candidateNodes.push({ id, count })
    }
  }

  candidateNodes.sort((a, b) => b.count - a.count || a.id - b.id)
  const selectedNodes = candidateNodes.slice(0, cfg.topN)
  const selectedNodeSet = new Set(selectedNodes.map((n) => n.id))

  const candidateEdges: SelectionEdge[] = []
  for (const [key, stat] of pairs) {
    const [a, b] = parseEdgeKey(key)
    if (!selectedNodeSet.has(a) || !selectedNodeSet.has(b)) {
      continue
    }

    let weight = 0
    if (cfg.mode.kind === 'together') {
      let sumNx = 0
      for (const c of stat.nX.values()) sumNx += c
      weight = sumNx + stat.nCross
    } else if (cfg.mode.kind === 'author') {
      weight = stat.nX.get(cfg.mode.author) || 0
    } else {
      weight = stat.nCross
    }

    if (weight >= cfg.minWeight && weight > 0) {
      candidateEdges.push({ a, b, weight })
    }
  }

  candidateEdges.sort((e1, e2) => e2.weight - e1.weight || e1.a - e2.a || e1.b - e2.b)
  const visibleEdges = candidateEdges.slice(0, MAX_EDGES)

  const maxCount = selectedNodes.length > 0 ? selectedNodes[0].count : 0
  const maxWeight = visibleEdges.length > 0 ? visibleEdges[0].weight : 0

  return {
    nodes: selectedNodes,
    edges: visibleEdges,
    maxCount,
    maxWeight,
  }
}

// Serrano disparity filter plus each node's top-2 edges. The input must already
// be sorted weight-desc (select() returns edges in that order).
export function pruneSortedBackbone(sorted: SelectionEdge[], nodeCount: number, alpha = 0.05): SelectionEdge[] {
  const degree = new Map<number, number>()
  const strength = new Map<number, number>()
  for (const e of sorted) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1)
    degree.set(e.b, (degree.get(e.b) || 0) + 1)
    strength.set(e.a, (strength.get(e.a) || 0) + e.weight)
    strength.set(e.b, (strength.get(e.b) || 0) + e.weight)
  }

  // Edge is significant at node i when (1 - p_ij)^(k_i - 1) < alpha, with p_ij = w_ij / s_i
  const significantAt = (node: number, weight: number) => {
    const k = degree.get(node) || 0
    const s = strength.get(node) || 0
    return k >= 2 && s > 0 && Math.pow(1 - weight / s, k - 1) < alpha
  }

  // Sorted scan: an edge is in an endpoint's top-2 when fewer than 2 of its edges precede it
  const seen = new Map<number, number>()
  const top2: SelectionEdge[] = []
  const disparity: SelectionEdge[] = []
  for (const e of sorted) {
    const inTop2 = (seen.get(e.a) || 0) < 2 || (seen.get(e.b) || 0) < 2
    seen.set(e.a, (seen.get(e.a) || 0) + 1)
    seen.set(e.b, (seen.get(e.b) || 0) + 1)
    if (inTop2) top2.push(e)
    else if (significantAt(e.a, e.weight) || significantAt(e.b, e.weight)) disparity.push(e)
  }

  // Budget: top-2 edges go first; disparity-only edges fill the rest (Math.max keeps the slice non-negative)
  const cap = Math.max(300, Math.round(nodeCount * 3.5))
  const kept = new Set([...top2.slice(0, cap), ...disparity.slice(0, Math.max(0, cap - top2.length))])
  return sorted.filter((e) => kept.has(e))
}
