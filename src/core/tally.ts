import type { Intern } from './intern'
import { tokenize } from './tokenize'
import type { AuthorId, ChatExport, Tok } from './types'

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

type Series = {
  authorId: AuthorId
  dateMs: number
  tokens: number[]
}

export function tally(units: RawUnit[]): TallyResult {
  const pairs = new Map<string, PairStat>()
  const counts = new Map<number, Map<AuthorId, number>>()
  const unitsByMsgId = new Map<number, RawUnit[]>()

  function addPair(u: number, v: number, authorId: AuthorId, isCross: boolean) {
    if (u === v) return
    const key = edgeKey(u, v)
    let stat = pairs.get(key)
    if (!stat) {
      stat = { nX: new Map(), nCross: 0 }
      pairs.set(key, stat)
    }
    if (isCross) {
      stat.nCross += 1
    } else {
      stat.nX.set(authorId, (stat.nX.get(authorId) || 0) + 1)
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
      currentSeries.tokens.length + unit.tokens.length <= 30
    ) {
      for (let i = 0; i < unit.tokens.length; i++) {
        currentSeries.tokens.push(unit.tokens[i])
      }
      currentSeries.dateMs = unit.dateMs
    } else {
      if (currentSeries) {
        seriesList.push(currentSeries)
      }
      currentSeries = {
        authorId: unit.authorId,
        dateMs: unit.dateMs,
        tokens: Array.from(unit.tokens),
      }
    }
  }

  if (currentSeries) {
    seriesList.push(currentSeries)
  }

  for (const series of seriesList) {
    const tokens = series.tokens
    const n = tokens.length
    const seen = new Set<string>()

    if (n <= 16) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const key = edgeKey(tokens[i], tokens[j])
          if (!seen.has(key)) {
            seen.add(key)
            addPair(tokens[i], tokens[j], series.authorId, false)
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const limit = Math.min(i + 3, n - 1)
        for (let j = i + 1; j <= limit; j++) {
          const key = edgeKey(tokens[i], tokens[j])
          if (!seen.has(key)) {
            seen.add(key)
            addPair(tokens[i], tokens[j], series.authorId, false)
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
      const seenReply = new Set<string>()

      for (let i = 0; i < unit.tokens.length; i++) {
        const u = unit.tokens[i]
        for (let j = 0; j < targetUnit.tokens.length; j++) {
          const v = targetUnit.tokens[j]
          if (u === v) continue
          const key = edgeKey(u, v)
          if (!seenReply.has(key)) {
            seenReply.add(key)
            addPair(u, v, unit.authorId, isCross)
          }
        }
      }
    }
  }

  return { pairs, counts }
}
