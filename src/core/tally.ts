import { isStopword, matchesLaugh, matchesMat } from './filters'
import { Intern, MAX_TOKEN_ID } from './intern'
import { smartMerge } from './smart-merge'
import { tokenize } from './tokenize'
import type { AuthorId, ChatExport, FilterCfg, Message, Tok, TokUnit } from './types'

const WINDOW_SIZE = 4 // 1/d decay within a sentence unit
const INTER_UNIT_WEIGHT = 0.3 // weaker link across units of one message
// Three link levels: an explicit reply always links; neighbouring messages link
// only on a small time gap; a large gap means no link at all.
export const REPLY_WEIGHT = 1.0 // level 1: direct reply, time gap ignored
export const ADJACENT_CLOSE_WEIGHT = 0.7 // level 2: neighbours, small gap
export const ADJACENT_CLOSE_MS = 10 * 60_000 // level 2/3 boundary
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
  pairs: Map<number, PairStat>
  counts: Map<number, Map<AuthorId, number>>
}

// Numeric pair key min * KEY_BASE + max: exact while token ids stay in
// [1, MAX_TOKEN_ID] (chat vocabularies are orders of magnitude smaller).
// Numeric keys skip the per-pair template string plus split/Number parses.
const KEY_BASE = MAX_TOKEN_ID + 1

export function edgeKey(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a > MAX_TOKEN_ID || b > MAX_TOKEN_ID) {
    throw new RangeError('token id out of range')
  }
  return a < b ? a * KEY_BASE + b : b * KEY_BASE + a
}

export function parseEdgeKey(key: number): [number, number] {
  return [Math.floor(key / KEY_BASE), key % KEY_BASE]
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

// keeps the max candidate weight per pair key within one message
function relax(best: Map<number, number>, u: number, v: number, w: number) {
  if (u === v) return
  const key = edgeKey(u, v)
  if ((best.get(key) ?? 0) < w) best.set(key, w)
}

type Msg = {
  authorId: AuthorId
  dateMs: number
  units: Uint32Array[]
}

// Cross-unit pair loops are O(Ta x Tb): one pasted article (3000 tokens) next to
// another freezes the worker on a single adjacency. Only the head of each unit
// builds cross links; inside-unit window pairs (already O(n)) are untouched.
export const MAX_LINK_TOKENS = 200

// Zero-copy view: subarray shares the buffer, so the common short case costs nothing.
function capped(tokens: Uint32Array): Uint32Array {
  return tokens.length > MAX_LINK_TOKENS ? tokens.subarray(0, MAX_LINK_TOKENS) : tokens
}

// Unknown dates (dateMs 0) count as close: never punish missing data.
// Out-of-order timestamps (negative gap) count as far.
function isCloseGap(prevMs: number, nextMs: number): boolean {
  if (prevMs <= 0 || nextMs <= 0) return true
  const gap = nextMs - prevMs
  return gap >= 0 && gap <= ADJACENT_CLOSE_MS
}

export function tally(units: RawUnit[]): TallyResult {
  const pairs = new Map<number, PairStat>()
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

  // Group units into messages in export order. Units without an id (tests only;
  // buildUnits always sets one) each stand as their own message.
  const messages: Msg[] = []
  const msgIndexById = new Map<number, number>()

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

  // Intra-message pairs: each message contributes its pairs once, at max weight.
  const intraMaxList: Array<Map<number, number>> = []
  for (const msg of messages) {
    // one message adds each pair at most once, at its max candidate weight
    const best = new Map<number, number>()
    for (let ui = 0; ui < msg.units.length; ui++) {
      const a = msg.units[ui]
      for (let i = 0; i < a.length; i++) {
        for (let d = 1; d <= WINDOW_SIZE && i + d < a.length; d++) {
          relax(best, a[i], a[i + d], 1 / d)
        }
      }
      for (let uj = ui + 1; uj < msg.units.length; uj++) {
        const b = capped(msg.units[uj])
        const ca = capped(a)
        for (let i = 0; i < ca.length; i++) {
          for (let j = 0; j < b.length; j++) {
            relax(best, ca[i], b[j], INTER_UNIT_WEIGHT)
          }
        }
      }
    }
    intraMaxList.push(best)
    for (const [key, w] of best) {
      const [u, v] = parseEdgeKey(key)
      addPair(u, v, msg.authorId, false, w)
    }
  }

  // Adjacent messages with a small gap link at ADJACENT_CLOSE_WEIGHT: into nCross
  // for different authors (that is what the cross-author view shows), into nX for
  // the same author. Pairs already linked inside either message are skipped
  // (max, not sum). A large gap contributes nothing.
  for (let mi = 0; mi + 1 < messages.length; mi++) {
    const a = messages[mi]
    const b = messages[mi + 1]
    if (!isCloseGap(a.dateMs, b.dateMs)) continue
    const isCross = a.authorId !== b.authorId
    // Skip pairs already linked inside either message without copying both
    // key sets: probe the intra maps directly, track only window-new pairs.
    const prevA = intraMaxList[mi]
    const prevB = intraMaxList[mi + 1]
    const seen = new Set<number>()
    for (const uaRaw of a.units) {
      for (const ubRaw of b.units) {
        const ua = capped(uaRaw)
        const ub = capped(ubRaw)
        for (let i = 0; i < ua.length; i++) {
          for (let j = 0; j < ub.length; j++) {
            if (ua[i] === ub[j]) continue
            const key = edgeKey(ua[i], ub[j])
            if (seen.has(key) || prevA.has(key) || prevB.has(key)) continue
            seen.add(key)
            addPair(ua[i], ub[j], b.authorId, isCross, ADJACENT_CLOSE_WEIGHT)
          }
        }
      }
    }
  }

  for (const unit of units) {
    if (unit.replyTo == null) continue
    const targetUnits = unitsByMsgId.get(unit.replyTo)
    if (!targetUnits) continue

    for (const targetUnit of targetUnits) {
      const isCross = unit.authorId !== targetUnit.authorId
      const seenReply = new Set<number>()

      const cu = capped(unit.tokens)
      const ct = capped(targetUnit.tokens)
      for (let i = 0; i < cu.length; i++) {
        const u = cu[i]
        for (let j = 0; j < ct.length; j++) {
          const v = ct[j]
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

// Show-flags: a checked category stays on the map, an unchecked one is dropped
// before tally. Custom lists extend their category (no-op when shown: nothing drops).
export function dropFor(cfg: FilterCfg): (t: Tok) => boolean {
  return (tok) =>
    (!cfg.tech && tok.cls === 'tech') ||
    (!cfg.digits && tok.cls === 'digits') ||
    (!cfg.stopwords && isStopword(tok.word)) ||
    (!cfg.mat && matchesMat(tok.word, cfg.customMat)) ||
    (!cfg.laugh && matchesLaugh(tok.word, cfg.customLaugh))
}

// topN and minWeight are not in the key: they only change selection, not the tally
export function filterCacheKey(cfg: FilterCfg): string {
  return JSON.stringify([cfg.mat, cfg.laugh, cfg.tech, cfg.digits, cfg.stopwords, cfg.customMat, cfg.customLaugh])
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
