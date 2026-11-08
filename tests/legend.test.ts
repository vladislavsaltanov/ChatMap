import { describe, expect, it } from 'vitest'
import { LEGEND_TEXT, wrapLegend } from '../src/core/legend'

// Детерминированный моноширинный измеритель: 10 px на символ.
const measure = (s: string): number => s.length * 10

describe('wrapLegend', () => {
  it('wraps at word boundaries, never exceeding maxWidth', () => {
    const lines = wrapLegend('aa bb cc dd', 50, measure)
    expect(lines).toEqual(['aa bb', 'cc dd'])
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(50)
  })

  it('keeps every word exactly once and in order', () => {
    const text = 'Самые большие ноды это самые частые слова'
    const lines = wrapLegend(text, 120, measure)
    expect(lines.join(' ')).toBe(text)
  })

  it('keeps a single word longer than maxWidth on its own line', () => {
    expect(wrapLegend('встречаемость', 40, measure)).toEqual(['встречаемость'])
  })

  it('puts every word on its own line when maxWidth is unusable', () => {
    expect(wrapLegend('размер ноды частота', 0, measure)).toEqual(['размер', 'ноды', 'частота'])
  })

  it('returns no lines for empty or whitespace-only input', () => {
    expect(wrapLegend('', 100, measure)).toEqual([])
    expect(wrapLegend('   \n  ', 100, measure)).toEqual([])
  })

  it('legend text itself wraps into readable lines', () => {
    const lines = wrapLegend(LEGEND_TEXT, 380, (s) => s.length * 7)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.join(' ')).toBe(LEGEND_TEXT)
    expect(LEGEND_TEXT).toContain('Линиями')
  })
})
