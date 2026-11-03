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

    const remappedPairs = new Map<string, PairStat>()
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
