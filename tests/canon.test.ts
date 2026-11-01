import { describe, expect, it } from 'vitest'
import { canon } from '../src/core/canon'

describe('canon', () => {
  it('stems verb forms into a single key', () => {
    const a = canon('говорит', 'plain')
    const b = canon('говорил', 'plain')
    const c = canon('говорить', 'plain')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('stems case endings of house forms into a single key', () => {
    const base = canon('дом', 'plain')
    expect(canon('дома', 'plain')).toBe(base)
    expect(canon('дому', 'plain')).toBe(base)
    expect(canon('домами', 'plain')).toBe(base)
  })

  it('preserves 3-letter stems by guard and keeps unrelated words separate', () => {
    expect(canon('сука', 'plain')).toBe('сука')
    expect(canon('сука', 'plain')).not.toBe(canon('сукно', 'plain'))
  })

  it('does not strip non-inflectional noun suffixes like ник', () => {
    expect(canon('передник', 'plain')).not.toBe(canon('перед', 'plain'))
  })

  it('stems latin suffixes s and ed to base form', () => {
    expect(canon('asks', 'plain')).toBe('ask')
    expect(canon('asked', 'plain')).toBe('ask')
  })

  it('does not stem tech or digits classes', () => {
    expect(canon('2026', 'digits')).toBe('2026')
    expect(canon('dom', 'tech')).toBe('dom')
    expect(canon('talked', 'tech')).toBe('talked')
  })
})
