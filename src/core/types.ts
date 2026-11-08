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
export type FilterCfg = { mat: boolean; laugh: boolean; tech: boolean; digits: boolean; customMat: string[]; customLaugh: string[]; smartMerge: boolean; topN: number; minWeight: number }
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

export type WorkerIn =
  | { type: 'open'; json: string }
  | { type: 'update'; cfg: FilterCfg & { mode: import('./select').ViewMode } }

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

export type MapMsg = Extract<WorkerOut, { type: 'map' }>

