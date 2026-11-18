import { describe, expect, it } from 'vitest'
import { buildMegaHubChat } from './fixtures/megahub-chat.mjs'
import fixture from './fixtures/sample-export.json'
import { parse } from '../src/core/parse'
import { memberPreimage, select, topIds, type ViewCfg } from '../src/core/select'
import { PipelineCache, countsUpTo, tally } from '../src/core/tally'
import type { ChatExport, FilterCfg } from '../src/core/types'

// The phase-1 truth gate: at T = whole history the two-stage chain (pass-1 prefix
// counts + a member-narrowed pair scan) must reproduce the oracle (full tally +
// select) EXACTLY, not approximately. Both sides run the production resolve, so
// filters, stemming, bucket stamps and smartMerge are all in the comparison.
// cross mode is absent by design: its real candidates land with the slice builder
// (Task 6), until then topIds ranks every counted word for it.

const BASE: FilterCfg = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  stopwords: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

// Plan matrix, smartMerge last: the last entry is the one that exercises the
// raw-id preimage, and the synthetic chat asserts it really merges something.
const FILTERS: FilterCfg[] = [
  BASE,
  { ...BASE, mat: true },
  { ...BASE, customMat: ['блин-'] },
  { ...BASE, smartMerge: true },
]

// Raw Telegram export, deliberately nasty: inflections of one stem (документ /
// документация / документы), a reply to the undated message, a service message, an
// empty text, multi-unit punctuation, and a word the customMat prefix must eat.
const SYNTHETIC = {
  name: 'Синтетика срезов',
  type: 'personal_chat',
  id: 700002,
  messages: [
    { id: 1, type: 'message', date: 1761900000, from: 'Аня', from_id: 111, text: 'документ котики разговоры разговоры' },
    { id: 2, type: 'message', date: 1761900060, from: 'Борис', from_id: 222, text: 'документация документация котики' },
    { id: 3, type: 'message', date: 1761900120, from: 'Аня', from_id: 111, text: 'блинчики и блинчики со сгущёнкой' },
    { id: 4, type: 'message', date: 1761900180, from: 'Борис', from_id: 222, reply_to_message_id: 1, text: 'документ важный' },
    { id: 5, type: 'message', date: 1761900240, from: 'Аня', from_id: 111, text: 'котики! разговоры? сгущёнка.' },
    { id: 6, type: 'message', date: 1761900300, from: 'Борис', from_id: 222, text: '' },
    { id: 7, type: 'message', date: 1761900360, from: 'Аня', from_id: 111, text: 'документация растёт, документ растёт' },
    // no date at all: dateMs 0, so the unit must land in bucket 0 and never be sliced off
    { id: 8, type: 'message', from: 'Борис', from_id: 222, text: 'без даты документ' },
    { id: 9, type: 'service', date: 1761900420, actor: 'Аня', actor_id: 111, action: 'invite_members', text: 'Аня пригласила Бориса' },
    { id: 10, type: 'message', date: 1761900480, from: 'Аня', from_id: 111, text: 'разговоры про документы и котиков' },
    { id: 11, type: 'message', date: 1761900540, from: 'Борис', from_id: 222, reply_to_message_id: 8, text: 'дату поставь' },
    { id: 12, type: 'message', date: 1761900600, from: 'Аня', from_id: 111, text: 'сгущёнка блинчики сгущёнка блинчики' },
  ],
}

// Runs the matrix over one chat and returns the smartMerge sizes per filter, so a
// caller can prove the preimage was not the identity. A topN below the vocabulary
// makes the slice boundary real, not theoretical.
const checkFullHistory = (chat: ChatExport, topN: number): number[] => {
  const cache = new PipelineCache()
  const views: ViewCfg[] = [
    { mode: { kind: 'together' }, topN, minWeight: 0 },
    // The author branch of topIds must mirror select() as well.
    { mode: { kind: 'author', author: chat.messages[0].authorId }, topN, minWeight: 0 },
  ]
  const mergeSizes: number[] = []

  for (const filterCfg of FILTERS) {
    const res = cache.resolve(chat, filterCfg)
    const merged = res.merged
    mergeSizes.push(merged?.size ?? 0)

    // Exactly what the worker materializes: whole-history counts + the oracle scan.
    const counts = countsUpTo(res.bucketCounts, res.meta.count - 1)
    const oracle = tally(res.units)
    expect(counts).toEqual(oracle.counts)

    for (const view of views) {
      const oldSelection = select(oracle, view, merged)
      const selected = topIds(counts, view, merged)
      const memberSet = memberPreimage(counts, selected, merged)
      const newSelection = select({ counts, pairs: tally(res.units, { memberSet }).pairs }, view, merged)
      // Full deep equality: nodes, edges, weights, maxCount, maxWeight.
      expect(newSelection).toEqual(oldSelection)
    }
  }

  return mergeSizes
}

describe('срез полной истории ≡ tally + select', () => {
  it('фикстура sample-export: обе цепочки дают один Selection', () => {
    checkFullHistory(parse(JSON.stringify(fixture)), 40)
  })

  it('мега-хаб: обе цепочки дают один Selection', () => {
    checkFullHistory(parse(JSON.stringify(buildMegaHubChat({ messages: 1200, vocab: 300 }))), 40)
  })

  it('синтетика с дублями и датой 0: обе цепочки дают один Selection', () => {
    const mergeSizes = checkFullHistory(parse(JSON.stringify(SYNTHETIC)), 6)
    // smartMerge is last in the matrix: the preimage must really remap, otherwise
    // this gate would also pass on a plain identity mask.
    expect(mergeSizes.at(-1)).toBeGreaterThan(0)
  })
})
