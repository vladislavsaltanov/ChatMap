import { describe, expect, it } from 'vitest'
import { buildSlice, crossCandidates, type SliceMsg } from '../src/core/slice'
import { PipelineCache, countsUpTo } from '../src/core/tally'
import type { Intern } from '../src/core/intern'
import type { ViewCfg } from '../src/core/select'
import type { ChatExport, FilterCfg, Message } from '../src/core/types'

const textMsg = (
  id: number,
  authorId: number,
  text: string,
  dateMs = id * 1000,
  replyTo: number | null = null,
): Message => ({
  id,
  kind: 'message',
  authorId,
  dateMs,
  parts: [{ text, entity: 'plain' }],
  replyTo,
})

const CFG: FilterCfg = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  stopwords: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

const VIEW: ViewCfg = { mode: { kind: 'together' }, topN: 600, minWeight: 0 }

const monthStart = (month: number): number => new Date(2024, month, 10).getTime()

// token id of a surface form, by scanning the intern table (ids are not stable a priori)
const idOfForm = (ia: Intern, form: string): number => {
  for (const [id, forms] of ia.forms) if (forms.has(form)) return id
  return -1
}

const allIds = (ia: Intern): Set<number> => new Set(ia.forms.keys())

// Pinned layout stand-in: a small grid plus two synthetic nuclei. Ports are keyed
// by GROUP (as graph.ts builds them), so the corridor/intra-nucleus routing branch
// runs instead of collapsing to the straight-tract fallback.
const pinOf = (
  ids: Set<number>,
): {
  positions: Map<number, { x: number; y: number }>
  ports: Map<number, { x: number; y: number; mass: number; members: number }>
  groupOf: Map<number, number>
} => {
  const positions = new Map<number, { x: number; y: number }>()
  const ports = new Map<number, { x: number; y: number; mass: number; members: number }>()
  const groupOf = new Map<number, number>()
  let i = 0
  for (const id of ids) {
    positions.set(id, { x: (i % 8) * 40, y: Math.floor(i / 8) * 40 })
    const group = i % 2
    groupOf.set(id, group)
    ports.set(group, { x: 20 + group * 140, y: 20 + group * 140, mass: 1, members: 1 })
    i += 1
  }
  return { positions, ports, groupOf }
}

type Resolved = ReturnType<PipelineCache['resolve']>

const sliceOf = (
  res: Resolved,
  bucket: number,
  universe: Set<number>,
  view: ViewCfg = VIEW,
  cross?: Set<number>,
): SliceMsg =>
  buildSlice({
    units: res.units,
    bucketCounts: res.bucketCounts,
    merged: res.merged,
    meta: res.meta,
    bucket,
    view,
    ia: res.ia,
    layout: pinOf(universe),
    memberUniverse: universe,
    cross,
  })

// Seven consecutive months (март..сентябрь 2024) => the month regime, seven buckets.
// Each month one message, so every word's prefix grows strictly with the cursor.
const monthsChat: ChatExport = {
  name: 'months',
  chatType: 'personal_chat',
  messages: [
    textMsg(1, 1, 'слово альфа', monthStart(2)),
    textMsg(2, 2, 'слово альфа бета', monthStart(3)),
    textMsg(3, 2, 'слово бета', monthStart(4)),
    textMsg(4, 1, 'слово альфа бета', monthStart(5)),
    textMsg(5, 1, 'слово гамма', monthStart(6)),
    textMsg(6, 2, 'слово альфа гамма', monthStart(7)),
    textMsg(7, 1, 'слово альфа бета гамма', monthStart(8)),
  ],
}

describe('buildSlice', () => {
  const res = new PipelineCache().resolve(monthsChat, CFG)
  const ids = {
    слово: idOfForm(res.ia, 'слово'),
    альфа: idOfForm(res.ia, 'альфа'),
    бета: idOfForm(res.ia, 'бета'),
    гамма: idOfForm(res.ia, 'гамма'),
  }
  const countOf = (msg: SliceMsg, id: number): number => msg.nodes.find((n) => n.id === id)?.count ?? 0
  const keyOf = (edge: { a: number; b: number }): string => `${Math.min(edge.a, edge.b)}:${Math.max(edge.a, edge.b)}`

  it('(a) поздний бакет даёт строго больший счёт у того же слова', () => {
    const universe = allIds(res.ia)
    const early = sliceOf(res, 0, universe)
    const late = sliceOf(res, res.meta.count - 1, universe)

    expect(countOf(early, ids.слово)).toBe(1)
    expect(countOf(late, ids.слово)).toBe(7)
    expect(countOf(late, ids.слово)).toBeGreaterThan(countOf(early, ids.слово))

    // режим автора читает только его голос: автор 2 писал в апреле, мае и августе
    const bySecond = sliceOf(res, res.meta.count - 1, universe, { ...VIEW, mode: { kind: 'author', author: 2 } })
    expect(countOf(bySecond, ids.слово)).toBe(3)

    // курсор вне диапазона клампится к последнему бакету, а не читает пустоту
    const clamped = sliceOf(res, 999, universe)
    expect(clamped.bucket).toBe(res.meta.count - 1)
    expect(clamped).toEqual(late)
  })

  it('(b) рёбра среза живут только внутри пин-множества', () => {
    const universe = new Set([ids.слово, ids.альфа, ids.бета])
    const msg = sliceOf(res, res.meta.count - 1, universe)

    expect(msg.edges.length).toBeGreaterThan(0)
    for (const edge of msg.edges) {
      expect(universe.has(edge.a)).toBe(true)
      expect(universe.has(edge.b)).toBe(true)
    }
  })

  it('(c) слова вне пин-множества не появляются в срезе', () => {
    const universe = new Set([ids.слово, ids.альфа, ids.бета])
    const msg = sliceOf(res, res.meta.count - 1, universe)

    expect(msg.nodes.length).toBeGreaterThan(0)
    expect(msg.nodes.some((node) => node.id === ids.гамма)).toBe(false)
    for (const node of msg.nodes) expect(universe.has(node.id)).toBe(true)
  })

  it('(d) T = последний бакет совпадает с полными счётами чата', () => {
    const universe = allIds(res.ia)
    const last = res.meta.count - 1
    const msg = sliceOf(res, last, universe)
    const full = countsUpTo(res.bucketCounts, last)

    for (const node of msg.nodes) {
      let total = 0
      for (const cnt of full.get(node.id)!.values()) total += cnt
      expect(node.count).toBe(total)
    }
    // полный счёт «слово» = 7 сообщений, лидирует автор 1 (4 из 7)
    expect(msg.maxCount).toBe(7)
    expect(msg.nodes.find((node) => node.id === ids.слово)?.authorLead).toBe(1)
  })

  it('(e) minWeight отсекает слабые рёбра', () => {
    const universe = allIds(res.ia)
    const last = res.meta.count - 1
    const loose = sliceOf(res, last, universe)
    const strict = sliceOf(res, last, universe, { ...VIEW, minWeight: 3 })

    expect(loose.edges.some((edge) => edge.weight < 3)).toBe(true)
    for (const edge of strict.edges) expect(edge.weight).toBeGreaterThanOrEqual(3)

    const looseKeys = new Set(loose.edges.map(keyOf))
    const strictKeys = new Set(strict.edges.map(keyOf))
    for (const key of strictKeys) expect(looseKeys.has(key)).toBe(true)
    expect(strictKeys.size).toBeLessThan(looseKeys.size)
  })

  it('(f) пустая вселенная даёт пустой срез', () => {
    const msg = sliceOf(res, 3, new Set<number>())
    expect(msg).toEqual({ type: 'slice', bucket: 3, nodes: [], edges: [], maxCount: 0, maxWeight: 0 })
  })
})

// Six-letter nonsense words whose stems stay distinct (the stemmer needs a 4+ char
// remainder, so «XаYкое» -> «XаYк»): a uniform-frequency chat with a large universe.
const LETTERS = 'бвгджзклмнпрстфх'
const gibberish = (i: number): string => LETTERS[i % 16] + 'а' + LETTERS[Math.floor(i / 16) % 16] + 'кое'
const wordList = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, k) => gibberish(from + k))

// 70 words of equal full-chat count: the universe blows the footprint budget, while
// the early frame (5 words) is tiny — the pinned scale must still shrink it.
const footprintChat: ChatExport = {
  name: 'footprint',
  chatType: 'personal_chat',
  messages: [
    textMsg(1, 1, wordList(0, 5).join(' '), monthStart(2)),
    textMsg(2, 1, wordList(5, 65).join(' '), monthStart(8)),
  ],
}

describe('buildSlice sizes', () => {
  it('(g) размеры уважают footprintScale вселенной, а не среза', () => {
    const res = new PipelineCache().resolve(footprintChat, CFG)
    const universe = allIds(res.ia)
    // закон без бюджетного сжатия отдал бы 32 px на шестибуквенное слово
    const unscaled = 32
    const early = sliceOf(res, 0, universe)
    const late = sliceOf(res, res.meta.count - 1, universe)

    expect(universe.size).toBe(70)
    expect(early.nodes.length).toBe(5)
    for (const node of early.nodes) {
      expect(node.size).toBeLessThan(unscaled)
      expect(node.size).toBeGreaterThan(0)
    }
    for (const node of late.nodes) expect(node.size).toBeLessThan(unscaled)
    // счёт у всех слов равен: иерархии нет, размер один на всех
    expect(new Set(early.nodes.map((node) => node.size)).size).toBe(1)
    expect(new Set(late.nodes.map((node) => node.size)).size).toBe(1)
  })
})

// Timeline-candidate fixture: three minutes of chat (< 14 days => ineligible meta),
// then one reply two hours later so the reply misses the adjacency window on purpose.
const CROSS_BASE = new Date(2024, 2, 10, 12, 0, 0).getTime()
const minutes = (n: number): number => CROSS_BASE + n * 60_000

const crossChat: ChatExport = {
  name: 'cross',
  chatType: 'personal_chat',
  messages: [
    textMsg(1, 1, 'альфа бета', minutes(0)),
    textMsg(2, 2, 'гамма дельта', minutes(1)),
    textMsg(3, 2, 'омега сигма', minutes(2)),
    textMsg(4, 2, 'тау фита', minutes(3)),
    textMsg(5, 1, 'кси пси', minutes(120), 4),
  ],
}

describe('crossCandidates', () => {
  it('(h) соседство разных авторов и ответы поперёк авторов красят оба конца', () => {
    const res = new PipelineCache().resolve(crossChat, CFG)
    const candidates = crossCandidates(res.units, res.meta)
    const inSet = (form: string): boolean => candidates.has(idOfForm(res.ia, form))

    // сообщения 1 и 2 — разные авторы, зазор 1 минута: в сете оба конца пары
    for (const form of ['альфа', 'бета', 'гамма', 'дельта']) expect(inSet(form)).toBe(true)

    // середина чата: соседи с обеих сторон того же автора, cross-связи нет
    for (const form of ['омега', 'сигма']) expect(inSet(form)).toBe(false)

    // ответ через 2 часа: зазор вне окна 10 минут, но ответ всё равно связывает концы
    for (const form of ['кси', 'пси', 'тау', 'фита']) expect(inSet(form)).toBe(true)

    // чат короче 14 дней: мета неэлигибельна, скан кандидатов от этого не зависит
    expect(res.meta.eligible).toBe(false)
  })
})

// Две соседние реплики разных авторов: у каждой пары слов поперёк них есть реальный
// nCross, поэтому у cross-режима есть что показать.
const crossPairChat: ChatExport = {
  name: 'cross-pair',
  chatType: 'personal_chat',
  messages: [
    textMsg(1, 1, 'альфа бета', minutes(0)),
    textMsg(2, 2, 'гамма дельта', minutes(1)),
  ],
}

describe('buildSlice cross mode', () => {
  it('(i) cross-срез уважает переданный сет, без него — прежний фолбэк', () => {
    const res = new PipelineCache().resolve(crossPairChat, CFG)
    const universe = allIds(res.ia)
    const crossView: ViewCfg = { ...VIEW, mode: { kind: 'cross' } }
    const last = res.meta.count - 1
    const beta = idOfForm(res.ia, 'бета')
    const crossSet = new Set([idOfForm(res.ia, 'альфа'), idOfForm(res.ia, 'гамма')])

    // «бета» посчитана и лежит во вселенной, но cross-кандидатом не является
    expect(countsUpTo(res.bucketCounts, last).has(beta)).toBe(true)
    const filtered = sliceOf(res, last, universe, crossView, crossSet)
    expect(filtered.nodes.map((node) => node.id).sort((a, b) => a - b)).toEqual(
      [...crossSet].sort((a, b) => a - b),
    )
    expect(filtered.edges.length).toBeGreaterThan(0)

    // без cross-аргумента режим держит фолбэк: кандидаты — все посчитанные id
    const fallback = sliceOf(res, last, universe, crossView)
    expect(fallback.nodes.some((node) => node.id === beta)).toBe(true)
    expect(fallback.nodes.length).toBeGreaterThan(filtered.nodes.length)
  })
})
