export type Entity = 'plain'|'link'|'code'|'mention'|'other'
export type TextPart = { text: string; entity: Entity }
export type Message = { id: number; kind: 'message'|'service'; authorId: number; dateMs: number; parts: TextPart[]; replyTo: number|null }
export type ChatExport = { name: string; chatType: string; messages: Message[] }
export type FilterCfg = { mat: boolean; laugh: boolean; tech: boolean; digits: boolean; customMat: string[]; customLaugh: string[]; smartMerge: boolean; topN: number; minWeight: number }
export type AuthorId = number

export type TokClass = 'plain'|'tech'|'digits'
export type Tok = { word: string; cls: TokClass }
export type TokUnit = Tok[]
