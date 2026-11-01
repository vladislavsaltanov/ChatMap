import { describe, expect, it } from 'vitest'
import { smartMerge } from '../src/core/smart-merge'

describe('smartMerge', () => {
  it('merges similar words into the more frequent key when Jaccard >= 0.5', () => {
    const freq = new Map([
      [1, 4], // говорит
      [2, 7], // говорила
    ])
    const idWords = new Map([
      [1, 'говорит'],
      [2, 'говорила'],
    ])
    const merged = smartMerge(freq, idWords)
    // 2 (говорила) is more frequent -> root
    // 1 (говорит) merges into 2
    expect(merged.get(1)).toBe(2)
    expect(merged.has(2)).toBe(false)
  })

  it('does not merge words with Jaccard < 0.5', () => {
    const freq = new Map([
      [1, 10], // молоко
      [2, 5],  // молодо
    ])
    const idWords = new Map([
      [1, 'молоко'],
      [2, 'молодо'],
    ])
    const merged = smartMerge(freq, idWords)
    expect(merged.size).toBe(0)
  })

  it('rejects words shorter than 6 characters via length guard', () => {
    const freq = new Map([
      [1, 10], // сука (len 4)
      [2, 5],  // сукно (len 5)
    ])
    const idWords = new Map([
      [1, 'сука'],
      [2, 'сукно'],
    ])
    const merged = smartMerge(freq, idWords)
    expect(merged.size).toBe(0)
  })

  it('prevents transitive merge chains: only merges into roots', () => {
    // Construct three words: A, B, C where A ≈ B, B ≈ C, but A !≈ C
    // len >= 6
    // Word A: "abcdefgh"
    // Word B: "abcdefxy" -> Jaccard with A: 4 / 8 = 0.5 (trigrams: abc, bcd, cde, def)
    // Word C: "cdefxyzw" -> Jaccard with B: 4 / 8 = 0.5; Jaccard with A: 2 / 10 = 0.2 < 0.5
    const freq = new Map([
      [1, 100], // A
      [2, 50],  // B
      [3, 10],  // C
    ])
    const idWords = new Map([
      [1, 'abcdefgh'],
      [2, 'abcdefxy'],
      [3, 'cdefxyzw'],
    ])
    const merged = smartMerge(freq, idWords)
    expect(merged.get(2)).toBe(1) // B merges into root A
    expect(merged.has(3)).toBe(false) // C does NOT merge transitively
  })
})
