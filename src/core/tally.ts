import { compileWordRules, isStopword } from './filters'
import { Intern, MAX_TOKEN_ID } from './intern'
import { smartMerge } from './smart-merge'
import { buildBucketMeta, type BucketMeta } from './timebuckets'
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
  bucket?: number // pass-1 time stamp; undefined = unstamped, always in a slice
}

export type PairStat = {
  nX: Map<AuthorId, number>
  nCross: number
}

export type TallyResult = {
  pairs: Map<number, PairStat>
  counts: Map<number, Map<AuthorId, number>>
}

// Pass-1 store: token -> author -> one counter per time bucket. Sparse by design
// (only seen tokens and authors allocate); a cursor slice is a prefix sum over the
// Uint32Array, so switching buckets never re-scans the units.
export type BucketCounts = Map<number, Map<AuthorId, Uint32Array>>

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

// Interns the kept tokens of each sentence unit and appends one RawUnit per unit.
// With a BucketMeta the units carry the message's time bucket (pass 1); without one
// the stamp stays undefined, which every slice treats as "always included".
function addUnits(
  out: RawUnit[],
  message: Message,
  tokUnits: TokUnit[],
  ia: Intern,
  dropTok: (t: Tok) => boolean,
  meta?: BucketMeta
) {
  // One lookup per message: every unit of a message shares its date.
  const bucket = meta?.bucketOf(message.dateMs)
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
      bucket,
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

// Corpus-wide surface counts for the stemmer. The corpus IS the dictionary: a stem
// that is itself a far more frequent standalone word must not absorb a rare one
// (see canon.ts). Counted BEFORE any filter, so the answer does not depend on the
// active filter or on token order.
// ponytail: one linear pass over the cached units (~100k distinct forms); revisit
// only if tokenize ever stops dominating the pipeline.
function countSurfaces(tokenized: TokUnit[][]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const units of tokenized) {
    for (const unit of units) {
      for (const tok of unit) {
        if (tok.cls !== 'plain') continue
        counts.set(tok.word, (counts.get(tok.word) ?? 0) + 1)
      }
    }
  }
  return counts
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
  // One stamp map serves all message pairs: a key is window-new only when its
  // stamp differs from the current pair stamp (avoids a Set alloc per pair).
  const seenStamp = new Map<number, number>()
  let stamp = 0
  for (let mi = 0; mi + 1 < messages.length; mi++) {
    const a = messages[mi]
    const b = messages[mi + 1]
    if (!isCloseGap(a.dateMs, b.dateMs)) continue
    const isCross = a.authorId !== b.authorId
    // Skip pairs already linked inside either message without copying both
    // key sets: probe the intra maps directly, track only window-new pairs.
    const prevA = intraMaxList[mi]
    const prevB = intraMaxList[mi + 1]
    stamp += 1
    for (const uaRaw of a.units) {
      for (const ubRaw of b.units) {
        const ua = capped(uaRaw)
        const ub = capped(ubRaw)
        for (let i = 0; i < ua.length; i++) {
          for (let j = 0; j < ub.length; j++) {
            if (ua[i] === ub[j]) continue
            const key = edgeKey(ua[i], ub[j])
            if (seenStamp.get(key) === stamp || prevA.has(key) || prevB.has(key)) continue
            seenStamp.set(key, stamp)
            addPair(ua[i], ub[j], b.authorId, isCross, ADJACENT_CLOSE_WEIGHT)
          }
        }
      }
    }
  }

  // One stamp map serves all reply targets: a key is new only when its stamp
  // differs from the current target stamp (avoids a Set alloc per target).
  const seenReplyStamp = new Map<number, number>()
  let replyStamp = 0
  for (const unit of units) {
    if (unit.replyTo == null) continue
    const targetUnits = unitsByMsgId.get(unit.replyTo)
    if (!targetUnits) continue

    for (const targetUnit of targetUnits) {
      const isCross = unit.authorId !== targetUnit.authorId
      replyStamp += 1

      const cu = capped(unit.tokens)
      const ct = capped(targetUnit.tokens)
      for (let i = 0; i < cu.length; i++) {
        const u = cu[i]
        for (let j = 0; j < ct.length; j++) {
          const v = ct[j]
          if (u === v) continue
          const key = edgeKey(u, v)
          if (seenReplyStamp.get(key) !== replyStamp) {
            seenReplyStamp.set(key, replyStamp)
            addPair(u, v, unit.authorId, isCross, REPLY_WEIGHT)
          }
        }
      }
    }
  }

  return { pairs, counts }
}

// [Query] Pass-1 frequencies: one linear pass over the units, bucketed by the stamp
// addUnits wrote. Guard: a unit without a stamp (undated, or built without meta)
// counts into bucket 0, so a timeline slice can never drop it.
export function countByBuckets(units: RawUnit[], bucketCount: number): BucketCounts {
  const out: BucketCounts = new Map()
  for (const unit of units) {
    // Guard: only a missing stamp is special; stamps arrive upper-clamped from BucketMeta.
    const bucket = unit.bucket ?? 0
    for (let i = 0; i < unit.tokens.length; i++) {
      const tokId = unit.tokens[i]
      let byAuthor = out.get(tokId)
      // Sparse store: rows appear only for tokens and authors actually seen.
      if (!byAuthor) {
        byAuthor = new Map()
        out.set(tokId, byAuthor)
      }
      let perBucket = byAuthor.get(unit.authorId)
      if (!perBucket) {
        perBucket = new Uint32Array(bucketCount)
        byAuthor.set(unit.authorId, perBucket)
      }
      perBucket[bucket] += 1
    }
  }
  return out
}

// [Query] Prefix-sum view of pass 1 for the timeline cursor: buckets 0..t inclusive
// (t is a cursor index, not a length), per author. Guard: t past the last bucket
// clamps to full history; guard: an author whose prefix is zero is left out of the
// sparse map, exactly like a token that never appears in this slice.
export function countsUpTo(bc: BucketCounts, t: number): Map<number, Map<AuthorId, number>> {
  const out = new Map<number, Map<AuthorId, number>>()
  for (const [tokId, byAuthor] of bc) {
    let authorMap: Map<AuthorId, number> | undefined
    for (const [authorId, perBucket] of byAuthor) {
      const last = Math.min(t, perBucket.length - 1)
      // Guard: a negative horizon (no bucket yet) contributes nothing.
      if (last < 0) continue
      let sum = 0
      for (let b = 0; b <= last; b++) sum += perBucket[b]
      // Guard: zero-prefix authors stay absent instead of bloating the map.
      if (sum === 0) continue
      if (!authorMap) authorMap = new Map()
      authorMap.set(authorId, sum)
    }
    // Guard: a token with no surviving author never reaches the selector.
    if (authorMap) out.set(tokId, authorMap)
  }
  return out
}

// Show-flags: a checked category stays on the map, an unchecked one is dropped
// before tally. Custom lists extend their category (no-op when shown: nothing drops).
// Category rules compile once here, not per token; cls and stopword flags stay cheap.
export function dropFor(cfg: FilterCfg): (t: Tok) => boolean {
  const dropWord = compileWordRules(cfg)
  return (tok) =>
    (!cfg.tech && tok.cls === 'tech') ||
    (!cfg.digits && tok.cls === 'digits') ||
    (!cfg.stopwords && isStopword(tok.word)) ||
    dropWord(tok.word)
}

// topN and minWeight are not in the key: they only change selection, not the tally
export function filterCacheKey(cfg: FilterCfg): string {
  return JSON.stringify([cfg.mat, cfg.laugh, cfg.tech, cfg.digits, cfg.stopwords, cfg.customMat, cfg.customLaugh])
}

export function mergeCacheKey(cfg: FilterCfg): string {
  return JSON.stringify([filterCacheKey(cfg), cfg.smartMerge])
}

// same inputs as worker.ts runPipeline: total count per id, canon word for plain ids
function mergeTokens(counts: Map<number, Map<AuthorId, number>>, ia: Intern): Map<number, number> {
  const freq = new Map<number, number>()
  const idWords = new Map<number, string>()
  for (const [id, authorMap] of counts) {
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
  onCountStart?: () => void
  onMergeStart?: () => void
}

// Pass-1 output factory for the map pipeline: units still feed the (Task 3) slice
// scan, bucketCounts feed every timeline cursor, countsCached marks a reused slot.
export type ResolveResult = {
  ia: Intern
  units: RawUnit[]
  merged?: Map<number, number>
  meta: BucketMeta
  bucketCounts: BucketCounts
  countsCached: boolean
}

// Filter toggles in the UI are A->B->A, so two slots make the return trip free.
// A slot holds one filtered unit list plus its bucketed counts; the full pairs map
// is gone (pass 2 scans on demand), so two slots are far cheaper than two tallies.
// shortcut: fixed two slots, no byte accounting; raise slots only with a memory budget
const CACHE_SLOTS = 2

// Insertion order doubles as recency: the first key is the oldest. Re-inserting an
// existing key refreshes it, so one function covers both store and touch.
function remember<K, V>(map: Map<K, V>, key: K, value: V, slots: number): V {
  map.delete(key)
  map.set(key, value)
  while (map.size > slots) map.delete(map.keys().next().value as K)
  return value
}

// Keeps one chat, its tokens, its bucket layout, and up to CACHE_SLOTS filter/merge
// entries. Tokenization and bucket meta are chat-scoped; only the filter-dependent
// stages are slotted.
export class PipelineCache {
  private chat?: ChatExport
  private tokenized?: TokUnit[][]
  private surfaceCounts?: Map<string, number>
  private meta?: BucketMeta
  private filterSlots = new Map<string, { ia: Intern; units: RawUnit[]; bucketCounts: BucketCounts }>()
  private merged = new Map<string, Map<number, number>>()

  // [Query] Pass-1 resolve for one chat and filter. Never tallies pairs: the open path
  // still scans the units itself (pass 2 arrives with the slice work).
  resolve(chat: ChatExport, cfg: FilterCfg, callbacks: PipelineCallbacks = {}): ResolveResult {
    if (chat !== this.chat) {
      this.chat = chat
      this.tokenized = undefined
      this.surfaceCounts = undefined
      this.meta = undefined
      this.filterSlots.clear()
      this.merged.clear()
    }

    if (!this.tokenized) {
      callbacks.onTokenizeStart?.()
      this.tokenized = tokenizeChat(chat, callbacks.onTokenizeProgress)
      this.surfaceCounts = countSurfaces(this.tokenized)
    }

    // Buckets are a pure function of the chat, so one build serves every filter:
    // a filter switch never re-segments time.
    if (!this.meta) this.meta = buildBucketMeta(chat)
    const meta = this.meta

    const filterKey = filterCacheKey(cfg)
    let countsCached = true
    let slot = this.filterSlots.get(filterKey)
    if (slot) {
      // touch so the least recently used key stays first in insertion order
      slot = remember(this.filterSlots, filterKey, slot, CACHE_SLOTS)
    } else {
      countsCached = false
      callbacks.onCountStart?.()
      const tallyIa = new Intern(this.surfaceCounts)
      const dropTok = dropFor(cfg)
      const units: RawUnit[] = []
      for (let i = 0; i < chat.messages.length; i++) {
        addUnits(units, chat.messages[i], this.tokenized[i], tallyIa, dropTok, meta)
      }
      slot = remember(
        this.filterSlots,
        filterKey,
        { ia: tallyIa, units, bucketCounts: countByBuckets(units, meta.count) },
        CACHE_SLOTS,
      )
    }
    const { ia, units, bucketCounts } = slot

    let merged: Map<number, number> | undefined
    if (cfg.smartMerge) {
      const mergeKey = mergeCacheKey(cfg)
      const cached = this.merged.get(mergeKey)
      if (cached) {
        merged = remember(this.merged, mergeKey, cached, CACHE_SLOTS)
      } else {
        callbacks.onMergeStart?.()
        // Merging is a whole-history decision: the cursor never changes the stems.
        merged = remember(
          this.merged,
          mergeKey,
          mergeTokens(countsUpTo(bucketCounts, meta.count - 1), ia),
          CACHE_SLOTS,
        )
      }
    }

    return { ia, units, merged, meta, bucketCounts, countsCached }
  }
}
