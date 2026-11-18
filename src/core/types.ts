import type { ViewCfg } from './select'
// Type-only on purpose: slice.ts reads AuthorId/WorkerEdge back from this module,
// so a value import here would close a module cycle. `import type` is erased at
// build, which keeps the message contract in one place and the graph acyclic.
import type { SliceMsg } from './slice'

export type Entity = 'plain'|'link'|'code'|'mention'|'other'
export type TextPart = { text: string; entity: Entity }
export type Message = { id: number; kind: 'message'|'service'; authorId: number; dateMs: number; parts: TextPart[]; replyTo: number|null }
export type ChatExport = {
  name: string
  chatType: string
  messages: Message[]
  authors?: Map<AuthorId, string>
  warn?: string
}
// Show-flags: true = category stays on the map, false = dropped before tally.
// Selection (topN/minWeight/mode) lives in ViewCfg, not here.
export type FilterCfg = { mat: boolean; laugh: boolean; tech: boolean; digits: boolean; stopwords: boolean; customMat: string[]; customLaugh: string[]; smartMerge: boolean }
export type AuthorId = number

export type TokClass = 'plain'|'tech'|'digits'
export type Tok = { word: string; cls: TokClass }
export type TokUnit = Tok[]

export type WorkerNode = {
  id: number
  label: string
  canon: string
  x: number
  y: number
  size: number
  count: number
  authorLead: number
  phase: number
  arm0: number
  arm1: number
  arm2: number
  arm3: number
  arm4: number
}

export type WorkerEdge = {
  a: number
  b: number
  weight: number
  alpha: number
  bead: number
  tract: [number, number, number, number]
  bundle: number
  rank: number
  tractRank: number
}

// 'open' carries the raw file bytes: the main thread transfers the buffer
// (zero-copy), the worker decodes it. Never a string: that would duplicate
// a 200 MB file in memory on postMessage structured-clone. seed pins the
// layout (reproducible maps, stand calibration); omitted = rolled per open.
export type WorkerIn =
  | { type: 'open'; buf: ArrayBuffer; seed?: number }
  | { type: 'update'; cfg: FilterCfg & ViewCfg }
  // [Query] Timeline cursor: one frame at a bucket index, answered by a 'slice'.
  // Latest-wins lives on the sender side, so no request id travels here.
  | { type: 'slice'; bucket: number }

export type WorkerOut =
  | { type: 'progress'; done: number; total: number; stage?: string }
  | { type: 'ready'; authors: Array<{ id: number; name: string; wordCount: number }>; counts: { messages: number } }
  | {
      type: 'map'
      nodes: WorkerNode[]
      edges: WorkerEdge[]
      maxCount: number
      maxWeight: number
      forms: Map<number, Array<[form: string, count: number]>>
    }
  | { type: 'warn'; message: string }
  | { type: 'error'; message: string }
  // One timeline frame over the pinned layout; the member is imported rather than
  // restated so `type: 'slice'` narrows against a single definition.
  | SliceMsg

export type MapMsg = Extract<WorkerOut, { type: 'map' }>

