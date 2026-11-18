// Timeline slice: one frame of the map at a cursor position over the PINNED
// layout. Pure core — no I/O, no clock, no RNG, no mutation of its arguments.
// Pass 1 answers "how often did each word appear up to bucket T", pass 2 rescans
// the units for links between the few words that survived the slice ranking, and
// the pinned layout supplies positions, ports and fascicles. A slice therefore
// changes counts, author leads, sizes and the visible edge set — never the
// silhouette, so the caller recolours the existing map instead of rebuilding it.
import {
  bundleEdges,
  edgeAlpha,
  footprintScale,
  footprintSize,
  nodeFitSize,
} from './geometry'
import type { LayoutPort } from './graph'
import type { Intern } from './intern'
import { dropEdgelessNodes, pruneSortedBackbone, type SelectionEdge, type ViewCfg } from './select'
import {
  ADJACENT_CLOSE_MS,
  countsUpTo,
  edgeKey,
  parseEdgeKey,
  tally,
  type BucketCounts,
  type PairStat,
  type RawUnit,
} from './tally'
import type { BucketMeta } from './timebuckets'
import type { AuthorId, WorkerEdge } from './types'

// One frame's word: id and size live in the pinned map's id space (merge roots),
// count and authorLead are the SLICE's own numbers, not the whole-history ones.
export type SliceNode = { id: number; count: number; authorLead: AuthorId; size: number }

export type SliceMsg = {
  type: 'slice'
  bucket: number
  nodes: SliceNode[]
  edges: WorkerEdge[]
  maxCount: number
  maxWeight: number
}

// Same ceiling as select(): the edge layer is budgeted per frame, so a dense
// slice cannot hand the renderer more than the full map would.
const MAX_EDGES = 10000

type Counts = Map<number, Map<AuthorId, number>>
type RankedNode = { id: number; count: number; authorLead: AuthorId }

// [Query] Per-mode count of one word, by the same law select() weighs candidates:
// together sums every author, author mode reads one voice, cross falls back to the
// all-author total until Task 6 supplies real cross candidates.
function modeCount(byAuthor: Map<AuthorId, number>, mode: ViewCfg['mode']): number {
  if (mode.kind === 'author') return byAuthor.get(mode.author) ?? 0
  let sum = 0
  for (const cnt of byAuthor.values()) sum += cnt
  return sum
}

// [Query] Author holding the largest share of a word INSIDE the slice. Mirrors the
// worker's lead loop (strict >, first inserted author wins a tie), so a slice
// answers "who led this period", not "who led the chat".
function leadOf(byAuthor: Map<AuthorId, number>): AuthorId {
  let lead: AuthorId = 0
  let best = 0
  for (const [author, cnt] of byAuthor) {
    if (cnt > best) {
      best = cnt
      lead = author
    }
  }
  return lead
}

// [Query] Folds pass-1 prefix counts onto merge roots, so ranking, author leads and
// edge weights all live in the same id space as the pinned map's node ids.
function foldRoots(raw: Counts, merged?: Map<number, number>): Counts {
  // Guard: without a merge map the prefix is already in root space; reuse it as is.
  if (merged === undefined || merged.size === 0) return raw
  const out: Counts = new Map()
  for (const [id, byAuthor] of raw) {
    const root = merged.get(id) ?? id
    let target = out.get(root)
    if (!target) {
      target = new Map()
      out.set(root, target)
    }
    for (const [author, cnt] of byAuthor) target.set(author, (target.get(author) ?? 0) + cnt)
  }
  return out
}

// [Query] Top-N of the slice, ordered exactly like select(): count desc, then id.
// Restriction to the pinned universe happens BEFORE the slice, so an early word
// that was a period favourite but never reached the whole-chat top can never
// appear — documented v1 limitation of the pinned node set.
function rankSlice(
  counts: Counts,
  view: ViewCfg,
  universe: Set<number>,
  cross?: Set<number>,
): RankedNode[] {
  const candidates: RankedNode[] = []
  for (const [id, byAuthor] of counts) {
    // Guard: a word outside the pinned universe has no position on the map.
    if (!universe.has(id)) continue
    // Guard: cross is defined by links, so only a word that ever linked across authors
    // is a candidate. Without a mask (callers before the timeline) the mode keeps the
    // old fallback — every counted id — instead of silently emptying the map.
    if (view.mode.kind === 'cross' && cross !== undefined && !cross.has(id)) continue
    const count = modeCount(byAuthor, view.mode)
    // Guard: zero in this mode (another author's word) is not a candidate.
    if (count <= 0) continue
    candidates.push({ id, count, authorLead: leadOf(byAuthor) })
  }
  candidates.sort((a, b) => b.count - a.count || a.id - b.id)
  return candidates.slice(0, Math.max(0, view.topN))
}

// [Query] Surface form the size law measures. Duplicates the worker's loop on
// purpose: the slice path runs outside the open pipeline and has no node info map
// to borrow, and the form must be the most frequent surface, not the stem.
function bestFormOf(ia: Intern, id: number): string {
  const forms = ia.forms.get(id)
  let best = ia.getCanon(id) ?? String(id)
  let bestCount = 0
  if (forms) {
    for (const [form, cnt] of forms) {
      if (cnt > bestCount) {
        bestCount = cnt
        best = form
      }
    }
  }
  return best
}

// [Query] The GLOBAL size scale, pinned to the universe at full history. The size
// hierarchy inside a frame is honest (sliceMax/sliceMin), but the screen-area
// budget must not jump while scrubbing: a word that keeps its count keeps its
// screen size, and an early sparse frame is never inflated to the full px law.
function pinnedScale(ia: Intern, universe: Set<number>, full: Counts, mode: ViewCfg['mode']): number {
  const counts = new Map<number, number>()
  let max = 0
  let min = Number.POSITIVE_INFINITY
  for (const id of universe) {
    const byAuthor = full.get(id)
    const count = byAuthor ? modeCount(byAuthor, mode) : 0
    counts.set(id, count)
    if (count > max) max = count
    if (count < min) min = count
  }
  // Guard: an empty (or all-zero) universe has no frequency axis; nodeFitSize then
  // answers with its text-fit reservation and footprintScale stays at the design value.
  if (min === Number.POSITIVE_INFINITY) min = 0
  const sizes: number[] = []
  for (const [id, count] of counts) sizes.push(nodeFitSize(bestFormOf(ia, id), count, max, min))
  return footprintScale(sizes)
}

// [Query] Pairs of the pass-2 scan folded onto merge roots (select() does the same
// before weighing). Pairs collapsing onto one word are not links.
function rootPairs(pairs: Map<number, PairStat>, merged?: Map<number, number>): Map<number, PairStat> {
  // Guard: no merge map => the scan already produced root keys; skip the copy.
  if (merged === undefined || merged.size === 0) return pairs
  const out = new Map<number, PairStat>()
  for (const [key, stat] of pairs) {
    const [a, b] = parseEdgeKey(key)
    const rootA = merged.get(a) ?? a
    const rootB = merged.get(b) ?? b
    // Guard: two surface forms of one word are not a link.
    if (rootA === rootB) continue
    const rootKey = edgeKey(rootA, rootB)
    let target = out.get(rootKey)
    if (!target) {
      target = { nX: new Map(), nCross: 0 }
      out.set(rootKey, target)
    }
    target.nCross += stat.nCross
    for (const [author, cnt] of stat.nX) target.nX.set(author, (target.nX.get(author) ?? 0) + cnt)
  }
  return out
}

// [Query] Slice weight of one pair, by the same mode law select() uses.
function edgeWeight(stat: PairStat, mode: ViewCfg['mode']): number {
  if (mode.kind === 'author') return stat.nX.get(mode.author) ?? 0
  if (mode.kind === 'cross') return stat.nCross
  let sumNx = 0
  for (const cnt of stat.nX.values()) sumNx += cnt
  return sumNx + stat.nCross
}

// Guard: exact copy of tally's private isCloseGap law — unknown dates count as close
// (never punish missing data), out-of-order or far gaps do not link.
function isCloseGap(prevMs: number, nextMs: number): boolean {
  if (prevMs <= 0 || nextMs <= 0) return true
  const gap = nextMs - prevMs
  return gap >= 0 && gap <= ADJACENT_CLOSE_MS
}

// [Query] Words that ever share a cross-author link over the FULL range: adjacent
// close-gap messages of different authors and cross-author replies. Pair-event scan
// only — no pair map is materialized, so this costs one pass, not the oracle's memory.
export function crossCandidates(units: RawUnit[], meta: BucketMeta): Set<number> {
  // Accepted, never read: the set is range-agnostic by design, and an ineligible chat
  // (count === 1) yields the same candidates as an eligible one.
  void meta
  const out = new Set<number>()
  const unitsByMsgId = new Map<number, RawUnit[]>()
  const messages: Array<{ authorId: AuthorId; dateMs: number; units: Uint32Array[] }> = []
  const msgIndexById = new Map<number, number>()

  // Group units into messages in export order, exactly like tally(): the meaning of
  // "adjacent message" and "reply target" must not drift between the two scans.
  for (const unit of units) {
    const msgId = unit.id ?? unit.msgId
    if (msgId !== undefined) {
      let list = unitsByMsgId.get(msgId)
      if (!list) {
        list = []
        unitsByMsgId.set(msgId, list)
      }
      list.push(unit)
    }
    // Units without an id (tests only; buildUnits always sets one) stand as their own message.
    if (msgId === undefined) {
      messages.push({ authorId: unit.authorId, dateMs: unit.dateMs, units: [unit.tokens] })
      continue
    }
    let idx = msgIndexById.get(msgId)
    if (idx === undefined) {
      idx = messages.length
      msgIndexById.set(msgId, idx)
      messages.push({ authorId: unit.authorId, dateMs: unit.dateMs, units: [] })
    }
    messages[idx].units.push(unit.tokens)
  }

  const mark = (tokens: Uint32Array): void => {
    for (let i = 0; i < tokens.length; i++) out.add(tokens[i])
  }

  // Adjacent messages with a small gap: only a cross-author pair can ever reach the
  // cross view, and a hit nominates every word of BOTH sides. Same-author neighbours
  // add nothing — their links are counted into nX, never into nCross.
  for (let mi = 0; mi + 1 < messages.length; mi++) {
    const a = messages[mi]
    const b = messages[mi + 1]
    // Guard: a far neighbour is not a link (same boundary as the oracle).
    if (!isCloseGap(a.dateMs, b.dateMs)) continue
    // Guard: same-author adjacency carries no cross evidence.
    if (a.authorId === b.authorId) continue
    for (const unit of a.units) mark(unit)
    for (const unit of b.units) mark(unit)
  }

  // Replies: an explicit answer across authors links regardless of the time gap, so
  // both endpoints are nominated; a same-author reply stays inside nX.
  for (const unit of units) {
    // Guard: only a reply with a target has a second endpoint.
    if (unit.replyTo == null) continue
    const targetUnits = unitsByMsgId.get(unit.replyTo)
    // Guard: a target dropped by filtering links nothing.
    if (!targetUnits) continue
    for (const targetUnit of targetUnits) {
      // Guard: same author on both ends never increments nCross.
      if (unit.authorId === targetUnit.authorId) continue
      mark(unit.tokens)
      mark(targetUnit.tokens)
    }
  }

  return out
}

// [Query] Cross mask in the ranking (merge-root) id space: candidates arrive as raw unit
// ids, so a variant's cross link must also nominate its root. Without a merge or a mask
// the set is returned untouched.
function crossRoots(cross: Set<number> | undefined, merged?: Map<number, number>): Set<number> | undefined {
  // Guard: no mask => the caller keeps the all-counted-ids fallback; no merge => raw ids are roots.
  if (cross === undefined || merged === undefined || merged.size === 0) return cross
  const out = new Set<number>()
  for (const id of cross) out.add(merged.get(id) ?? id)
  return out
}

// Guard: the strip can only address buckets the chat actually has. A stale cursor
// (filter switch rebuilt the meta), a fractional index or NaN clamps here instead
// of reading past the bucket arrays.
function clampBucket(bucket: number, meta: BucketMeta): number {
  if (!Number.isFinite(bucket)) return 0
  return Math.max(0, Math.min(Math.trunc(bucket), Math.max(0, meta.count - 1)))
}

function emptySlice(bucket: number): SliceMsg {
  return { type: 'slice', bucket, nodes: [], edges: [], maxCount: 0, maxWeight: 0 }
}

// [Query] One timeline frame over the pinned layout.
// Contract: node ids are a subset of the pinned universe, so the caller updates
// attributes in place; positions and routing are read from `layout` and never
// recomputed. Guards: no units / no universe / nothing counted in this mode => an
// empty message (maxCount and maxWeight both 0), never a partial frame.
export function buildSlice(args: {
  units: RawUnit[]
  bucketCounts: BucketCounts
  merged?: Map<number, number>
  meta: BucketMeta
  bucket: number
  view: ViewCfg
  ia: Intern
  layout: {
    positions: Map<number, { x: number; y: number }>
    ports?: Map<number, LayoutPort>
    groupOf?: Map<number, number>
    stemOf?: Map<number, number>
  }
  memberUniverse: Set<number>
  // Cross-mode candidate mask in raw unit-id space (crossCandidates); absent = the
  // mode keeps the all-counted-ids fallback so pre-timeline callers still work.
  cross?: Set<number>
}): SliceMsg {
  const { units, bucketCounts, merged, meta, view, ia, layout, memberUniverse, cross } = args
  const bucket = clampBucket(args.bucket, meta)
  const lastBucket = Math.max(0, meta.count - 1)

  // Guard: an empty chat or an empty pinned universe has nothing to draw.
  if (units.length === 0 || memberUniverse.size === 0) return emptySlice(bucket)

  const rawCounts = countsUpTo(bucketCounts, bucket)
  const sliceCounts = foldRoots(rawCounts, merged)
  const ranked = rankSlice(sliceCounts, view, memberUniverse, crossRoots(cross, merged))
  // Guard: this mode has no counts yet (author mode before their first message).
  if (ranked.length === 0) return emptySlice(bucket)

  // Honest per-slice hierarchy: the px law bounds come from THIS frame's ranking.
  const sliceMax = ranked[0].count
  let sliceMin = sliceMax
  for (const node of ranked) if (node.count < sliceMin) sliceMin = node.count

  // Pin: the footprint scale is the universe's FULL-HISTORY one. On the last
  // bucket the prefix already is full history, so skip the second summation.
  const full = bucket === lastBucket ? sliceCounts : foldRoots(countsUpTo(bucketCounts, lastBucket), merged)
  const scale = pinnedScale(ia, memberUniverse, full, view.mode)

  const sized: SliceNode[] = ranked.map((node) => {
    const raw = nodeFitSize(bestFormOf(ia, node.id), node.count, sliceMax, sliceMin)
    return {
      id: node.id,
      count: node.count,
      authorLead: node.authorLead,
      // Shrink only: a slice never inflates a body above the px law.
      size: scale < 1 ? Math.round(footprintSize(raw, scale) * 10) / 10 : raw,
    }
  })

  const selected = new Set(ranked.map((node) => node.id))
  // Pass 2: the scan keeps only pairs whose BOTH ends are slice words. The mask is
  // closed over merge roots, so a merged surface form still feeds its root's links.
  const memberSet = new Set<number>()
  for (const id of rawCounts.keys()) {
    // Guard: a raw form joins the scan only when its merge root was ranked.
    if (selected.has(merged?.get(id) ?? id)) memberSet.add(id)
  }
  // Units above the cursor are skipped inside the scan (maxBucket), which is what
  // makes early slices cheaper than the full one.
  const { pairs } = tally(units, { memberSet, maxBucket: bucket })

  const candidates: SelectionEdge[] = []
  for (const [key, stat] of rootPairs(pairs, merged)) {
    const [a, b] = parseEdgeKey(key)
    // Guard: a link needs every end inside this frame's node set.
    if (!selected.has(a) || !selected.has(b)) continue
    const weight = edgeWeight(stat, view.mode)
    // Guard: minWeight is the user's floor, and a zero-weight pair is not a link.
    if (weight < view.minWeight || weight <= 0) continue
    candidates.push({ a, b, weight })
  }
  candidates.sort((e1, e2) => e2.weight - e1.weight || e1.a - e2.a || e1.b - e2.b)
  const visibleEdges = candidates.slice(0, MAX_EDGES)
  // Guard: the weight normaliser comes from the visible set, exactly like select().
  const maxWeight = visibleEdges.length > 0 ? visibleEdges[0].weight : 0

  // select() rule: a word without a visible link has no position on the map. The
  // frame's node list must match what the edge layer draws.
  const shownIds = new Set(dropEdgelessNodes(sized, visibleEdges).map((node) => node.id))
  const shown = sized.filter((node) => shownIds.has(node.id))

  // Serrano backbone over the frame's OWN weights: the trunk follows the slice,
  // not the whole history, and the pinned routing keeps the curves in place.
  const backboneEdges = pruneSortedBackbone(visibleEdges, shown.length)
  const posList = shown.map((node) => {
    const pos = layout.positions.get(node.id) ?? { x: 0, y: 0 }
    return { id: node.id, x: pos.x, y: pos.y }
  })
  const bundles = bundleEdges(posList, backboneEdges, {
    ports: layout.ports ?? new Map(),
    groupOf: layout.groupOf ?? new Map(),
    // Fascicle identity is pinned with the layout: no edge re-routes on a slice.
    stemOf: layout.stemOf,
  })

  // The backbone's budget cap can strand dust exactly like select()'s: drop those
  // nodes so the caption layer and picking agree on one connected set.
  const kept = new Set<number>()
  for (const edge of backboneEdges) {
    kept.add(edge.a)
    kept.add(edge.b)
  }
  const nodes = shown.filter((node) => kept.has(node.id))

  const edges: WorkerEdge[] = backboneEdges.map((edge, index) => ({
    ...edge,
    alpha: edgeAlpha(edge.weight, maxWeight),
    bead: maxWeight > 0 ? Math.min(1, edge.weight / maxWeight) : 0,
    tract: bundles[index].tract,
    bundle: bundles[index].bundle,
    rank: bundles[index].rank,
    tractRank: bundles[index].tractRank,
  }))

  return { type: 'slice', bucket, nodes, edges, maxCount: sliceMax, maxWeight }
}
