import { isStopword, matchesLaugh, matchesMat } from './filters'
import { Intern } from './intern'
import { smartMerge } from './smart-merge'
import { tokenize } from './tokenize'
import type { AuthorId, ChatExport, FilterCfg, Message, Tok, TokUnit } from './types'

const WINDOW_SIZE = 4 // 1/d decay within a sentence unit
const INTER_UNIT_WEIGHT = 0.3 // weaker link across units in one burst series
const REPLY_WEIGHT = 0.5 // reply context link weight
const PROGRESS_EVERY = 5000 // messages between onProgress calls

export type RawUnit = {
  id?: number
  msgId?: number
  authorId: AuthorId
  dateMs: number
  replyTo: number | null
  tokens: Uint32Array
}

export type PairStat = {
  nX: Map<AuthorId, number>
  nCross: number
}

export type TallyResult = {
  pairs: Map<string, PairStat>
  counts: Map<number, Map<AuthorId, number>>
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split(':')
  return [Number(a), Number(b)]
}

type Progress = (doneMsgs: number, totalMsgs: number) => void

export function buildUnits(
  chat: ChatExport,
  ia: Intern,
  dropTok: (t: Tok) => boolean,
  onProgress?: Progress
): RawUnit[] {
  const result: RawUnit[] = []

  for (let i = 0; i < chat.messages.length; i++) {
    if (i > 0 && i % PROGRESS_EVERY === 0) onProgress?.(i, chat.messages.length)
    const message = chat.messages[i]
    addUnits(result, message, tokenizeMessage(message), ia, dropTok)
  }

  return result
}

// service and empty messages have no text to tokenize
function tokenizeMessage(message: Message): TokUnit[] {
  return message.kind === 'service' || message.parts.length === 0 ? [] : tokenize(message.parts)
}

// interns the kept tokens of each sentence unit and appends one RawUnit per unit
function addUnits(
  out: RawUnit[],
  message: Message,
  tokUnits: TokUnit[],
  ia: Intern,
  dropTok: (t: Tok) => boolean
) {
  for (const unit of tokUnits) {
    const kept = unit.filter((t) => !dropTok(t))
    if (kept.length === 0) continue

    const ids = new Uint32Array(kept.length)
    for (let i = 0; i < kept.length; i++) {
      ids[i] = ia.intern(kept[i].word, kept[i].cls).id
    }

    out.push({
      id: message.id,
      msgId: message.id,
      authorId: message.authorId,
      dateMs: message.dateMs,
      replyTo: message.replyTo,
      tokens: ids,
    })
  }
}

// PipelineCache layer 1: tokens per message, index-aligned with chat.messages
function tokenizeChat(chat: ChatExport, onProgress?: Progress): TokUnit[][] {
  const out: TokUnit[][] = []
  for (let i = 0; i < chat.messages.length; i++) {
    if (i > 0 && i % PROGRESS_EVERY === 0) onProgress?.(i, chat.messages.length)
    out.push(tokenizeMessage(chat.messages[i]))
  }
  return out
}

// keeps the max candidate weight per pair key within one series
function relax(best: Map<string, number>, u: number, v: number, w: number) {
  if (u === v) return
  const key = edgeKey(u, v)
  if ((best.get(key) ?? 0) < w) best.set(key, w)
}

type Series = {
  authorId: AuthorId
  dateMs: number
  units: Uint32Array[]
  tokenCount: number
}

export function tally(units: RawUnit[]): TallyResult {
  const pairs = new Map<string, PairStat>()
  const counts = new Map<number, Map<AuthorId, number>>()
  const unitsByMsgId = new Map<number, RawUnit[]>()

  function addPair(u: number, v: number, authorId: AuthorId, isCross: boolean, w: number) {
    if (u === v) return
    const key = edgeKey(u, v)
    let stat = pairs.get(key)
    if (!stat) {
      stat = { nX: new Map(), nCross: 0 }
      pairs.set(key, stat)
    }
    if (isCross) {
      stat.nCross += w
    } else {
      stat.nX.set(authorId, (stat.nX.get(authorId) || 0) + w)
    }
  }

  const seriesList: Series[] = []
  let currentSeries: Series | null = null

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

    for (let i = 0; i < unit.tokens.length; i++) {
      const tokId = unit.tokens[i]
      let authorMap = counts.get(tokId)
      if (!authorMap) {
        authorMap = new Map()
        counts.set(tokId, authorMap)
      }
      authorMap.set(unit.authorId, (authorMap.get(unit.authorId) || 0) + 1)
    }

    // dateMs 0 means unknown date: undated or out-of-order units never glue into a series
    if (
      currentSeries &&
      currentSeries.authorId === unit.authorId &&
      unit.dateMs > 0 &&
      currentSeries.dateMs > 0 &&
      unit.dateMs - currentSeries.dateMs >= 0 &&
      unit.dateMs - currentSeries.dateMs <= 120_000 &&
      currentSeries.tokenCount + unit.tokens.length <= 30
    ) {
      currentSeries.units.push(unit.tokens)
      currentSeries.tokenCount += unit.tokens.length
      currentSeries.dateMs = unit.dateMs
    } else {
      if (currentSeries) {
        seriesList.push(currentSeries)
      }
      currentSeries = {
        authorId: unit.authorId,
        dateMs: unit.dateMs,
        units: [unit.tokens],
        tokenCount: unit.tokens.length,
      }
    }
  }

  if (currentSeries) {
    seriesList.push(currentSeries)
  }

  for (const series of seriesList) {
    // one series adds each pair at most once, at its max candidate weight (seriesMax)
    const seriesMax = new Map<string, number>()
    const seriesUnits = series.units
    for (let ui = 0; ui < seriesUnits.length; ui++) {
      const a = seriesUnits[ui]
      for (let i = 0; i < a.length; i++) {
        for (let d = 1; d <= WINDOW_SIZE && i + d < a.length; d++) {
          relax(seriesMax, a[i], a[i + d], 1 / d)
        }
      }
      for (let uj = ui + 1; uj < seriesUnits.length; uj++) {
        const b = seriesUnits[uj]
        for (let i = 0; i < a.length; i++) {
          for (let j = 0; j < b.length; j++) {
            relax(seriesMax, a[i], b[j], INTER_UNIT_WEIGHT)
          }
        }
      }
    }
    for (const [key, w] of seriesMax) {
      const [u, v] = parseEdgeKey(key)
      addPair(u, v, series.authorId, false, w)
    }
  }

  for (const unit of units) {
    if (unit.replyTo == null) continue
    const targetUnits = unitsByMsgId.get(unit.replyTo)
    if (!targetUnits) continue

    for (const targetUnit of targetUnits) {
      const isCross = unit.authorId !== targetUnit.authorId
      const seenReply = new Set<string>()

      for (let i = 0; i < unit.tokens.length; i++) {
        const u = unit.tokens[i]
        for (let j = 0; j < targetUnit.tokens.length; j++) {
          const v = targetUnit.tokens[j]
          if (u === v) continue
          const key = edgeKey(u, v)
          if (!seenReply.has(key)) {
            seenReply.add(key)
            addPair(u, v, unit.authorId, isCross, REPLY_WEIGHT)
          }
        }
      }
    }
  }

  return { pairs, counts }
}

// reads only cfg fields that filterCacheKey covers; add new ones there
function dropFor(cfg: FilterCfg): (t: Tok) => boolean {
  return (tok) =>
    (!cfg.tech && tok.cls === 'tech') ||
    (!cfg.digits && tok.cls === 'digits') ||
    isStopword(tok.word) ||
    (!cfg.mat && matchesMat(tok.word, cfg.customMat)) ||
    (!cfg.laugh && matchesLaugh(tok.word, cfg.customLaugh))
}

// topN and minWeight are not in the key: they only change selection, not the tally
export function filterCacheKey(cfg: FilterCfg): string {
  return JSON.stringify([cfg.mat, cfg.laugh, cfg.tech, cfg.digits, cfg.customMat, cfg.customLaugh])
}

export function mergeCacheKey(cfg: FilterCfg): string {
  return JSON.stringify([filterCacheKey(cfg), cfg.smartMerge])
}

// same inputs as worker.ts runPipeline: total count per id, canon word for plain ids
function mergeTokens(tallyResult: TallyResult, ia: Intern): Map<number, number> {
  const freq = new Map<number, number>()
  const idWords = new Map<number, string>()
  for (const [id, authorMap] of tallyResult.counts) {
    let sum = 0
    for (const cnt of authorMap.values()) sum += cnt
    freq.set(id, sum)
    if (ia.getCls(id) === 'plain') {
      const word = ia.getCanon(id)
      if (word) idWords.set(id, word)
    }
  }
  return smartMerge(freq, idWords)
}

export type PipelineCallbacks = {
  onTokenizeStart?: () => void
  onTokenizeProgress?: Progress
  onTallyStart?: () => void
  onMergeStart?: () => void
}

// a *Cached flag is true when that stage did not run (reused, or switched off)
export type PipelineResult = {
  ia: Intern
  tallyResult: TallyResult
  merged?: Map<number, number>
  tallyCached: boolean
  mergeCached: boolean
}

// shortcut: keeps one chat and one tally/merge entry, so flipping back to an older filter recomputes; upgrade to a Map keyed by filterKey if the UI flips often
export class PipelineCache {
  private chat?: ChatExport
  private tokenized?: TokUnit[][]
  private tallied?: { key: string; ia: Intern; tallyResult: TallyResult }
  private merged?: { key: string; merged: Map<number, number> }

  resolve(chat: ChatExport, cfg: FilterCfg, callbacks: PipelineCallbacks = {}): PipelineResult {
    if (chat !== this.chat) {
      this.chat = chat
      this.tokenized = undefined
      this.tallied = undefined
      this.merged = undefined
    }

    if (!this.tokenized) {
      callbacks.onTokenizeStart?.()
      this.tokenized = tokenizeChat(chat, callbacks.onTokenizeProgress)
    }

    const filterKey = filterCacheKey(cfg)
    let tallyCached = true
    if (!this.tallied || this.tallied.key !== filterKey) {
      tallyCached = false
      callbacks.onTallyStart?.()
      const tallyIa = new Intern()
      const dropTok = dropFor(cfg)
      const units: RawUnit[] = []
      for (let i = 0; i < chat.messages.length; i++) {
        addUnits(units, chat.messages[i], this.tokenized[i], tallyIa, dropTok)
      }
      this.tallied = { key: filterKey, ia: tallyIa, tallyResult: tally(units) }
    }
    const { ia, tallyResult } = this.tallied

    let merged: Map<number, number> | undefined
    let mergeCached = true
    if (cfg.smartMerge) {
      const mergeKey = mergeCacheKey(cfg)
      if (!this.merged || this.merged.key !== mergeKey) {
        mergeCached = false
        callbacks.onMergeStart?.()
        this.merged = { key: mergeKey, merged: mergeTokens(tallyResult, ia) }
      }
      merged = this.merged.merged
    }

    return { ia, tallyResult, merged, tallyCached, mergeCached }
  }
}
