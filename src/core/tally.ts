import type { Intern } from './intern'
import { tokenize } from './tokenize'
import type { AuthorId, ChatExport, Tok } from './types'

const WINDOW_SIZE = 4 // 1/d decay within a sentence unit
const INTER_UNIT_WEIGHT = 0.3 // weaker link across units in one burst series
const REPLY_WEIGHT = 0.5 // reply context link weight

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

export function buildUnits(
  chat: ChatExport,
  ia: Intern,
  dropTok: (t: Tok) => boolean
): RawUnit[] {
  const result: RawUnit[] = []

  for (const message of chat.messages) {
    if (message.kind === 'service' || message.parts.length === 0) {
      continue
    }

    const tokUnits = tokenize(message.parts)
    for (const unit of tokUnits) {
      const kept = unit.filter((t) => !dropTok(t))
      if (kept.length === 0) continue

      const ids = new Uint32Array(kept.length)
      for (let i = 0; i < kept.length; i++) {
        ids[i] = ia.intern(kept[i].word, kept[i].cls).id
      }

      result.push({
        id: message.id,
        msgId: message.id,
        authorId: message.authorId,
        dateMs: message.dateMs,
        replyTo: message.replyTo,
        tokens: ids,
      })
    }
  }

  return result
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
