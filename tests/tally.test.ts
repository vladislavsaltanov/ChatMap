import { describe, expect, it } from 'vitest'
import { Intern } from '../src/core/intern'
import { buildUnits, edgeKey, tally, type RawUnit } from '../src/core/tally'
import type { ChatExport } from '../src/core/types'

describe('tally', () => {
  it('(f) computes edgeKey = a * 3001 + b for a < b', () => {
    expect(edgeKey(2, 5)).toBe(2 * 3001 + 5)
    expect(edgeKey(5, 2)).toBe(2 * 3001 + 5)
  })

  it('(a) unit <= 16 tokens produces all N*(N-1)/2 pairs', () => {
    const tokens = new Uint32Array([1, 2, 3, 4, 5])
    const units: RawUnit[] = [
      { authorId: 10, dateMs: 1000, replyTo: null, tokens },
    ]
    const res = tally(units)
    // 5 tokens -> 5*4/2 = 10 pairs
    expect(res.pairs.size).toBe(10)
    for (const stat of res.pairs.values()) {
      expect(stat.nX.get(10)).toBe(1)
      expect(stat.nCross).toBe(0)
    }
  })

  it('(b) unit with 20 tokens produces only windowed pairs (distance <= 3)', () => {
    const tokens = new Uint32Array(Array.from({ length: 20 }, (_, i) => i + 1))
    const units: RawUnit[] = [
      { authorId: 10, dateMs: 1000, replyTo: null, tokens },
    ]
    const res = tally(units)

    // Verify distance <= 3
    for (const [key, stat] of res.pairs) {
      const b = key % 3001
      const a = Math.floor(key / 3001)
      expect(b - a).toBeGreaterThanOrEqual(1)
      expect(b - a).toBeLessThanOrEqual(3)
      expect(stat.nX.get(10)).toBe(1)
    }
    // Pairs at dist 1: 19; dist 2: 18; dist 3: 17 => 54 pairs
    expect(res.pairs.size).toBe(19 + 18 + 17)
  })

  it('(c) units within 120s merge into series with cross-boundary pairs; >120s separate', () => {
    // 60s pause -> merged
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resMerged = tally([u1, u2])
    expect(resMerged.pairs.has(edgeKey(1, 3))).toBe(true)

    // 150s pause -> separate
    const u3: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u4: RawUnit = { authorId: 10, dateMs: 151000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resSeparate = tally([u3, u4])
    expect(resSeparate.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('(d) series caps at 30 tokens, splitting 35 tokens into two series', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array(Array.from({ length: 20 }, (_, i) => i + 1)) }
    const u2: RawUnit = { authorId: 10, dateMs: 2000, replyTo: null, tokens: new Uint32Array(Array.from({ length: 15 }, (_, i) => i + 21)) }
    const res = tally([u1, u2])
    // 20 + 15 = 35 > 30, so u2 is in a separate series; pair between 1 and 21 does not exist
    expect(res.pairs.has(edgeKey(1, 21))).toBe(false)
  })

  it('(e) reply to another author increments nCross; self-reply increments nX', () => {
    const target: RawUnit = { id: 100, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    const replyOther: RawUnit = { id: 101, authorId: 20, dateMs: 2000, replyTo: 100, tokens: new Uint32Array([2]) }
    const resOther = tally([target, replyOther])
    const key = edgeKey(1, 2)
    expect(resOther.pairs.get(key)?.nCross).toBe(1)
    expect(resOther.pairs.get(key)?.nX.get(20) || 0).toBe(0)

    const replySelf: RawUnit = { id: 102, authorId: 10, dateMs: 150000, replyTo: 100, tokens: new Uint32Array([3]) }
    const resSelf = tally([target, replySelf])
    const keySelf = edgeKey(1, 3)
    expect(resSelf.pairs.get(keySelf)?.nCross).toBe(0)
    expect(resSelf.pairs.get(keySelf)?.nX.get(10)).toBe(1)
  })

  it('(g) different authors do not merge into serial even with short pause', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 20, dateMs: 2000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const res = tally([u1, u2])
    expect(res.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('buildUnits converts chat messages using intern and drops filtered tokens', () => {
    const ia = new Intern()
    const chat: ChatExport = {
      name: 'test',
      chatType: 'personal_chat',
      messages: [
        {
          id: 1,
          kind: 'message',
          authorId: 111,
          dateMs: 1000,
          parts: [{ text: 'Привет! Как дела?', entity: 'plain' }],
          replyTo: null,
        },
        {
          id: 2,
          kind: 'service',
          authorId: 111,
          dateMs: 2000,
          parts: [],
          replyTo: null,
        },
      ],
    }
    // Drop token 'как'
    const units = buildUnits(chat, ia, (t) => t.word === 'как')
    expect(units.length).toBe(2) // 2 units from 'Привет!' and 'Как дела?'
    expect(units[0].authorId).toBe(111)
    expect(units[0].tokens.length).toBe(1) // 'привет'
    expect(units[1].tokens.length).toBe(1) // 'дела' ('как' dropped)
  })
})
