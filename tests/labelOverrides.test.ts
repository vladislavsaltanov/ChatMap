import { describe, expect, it } from 'vitest'
import { parseLabelOverrides } from '../src/core/labelOverrides'

describe('parseLabelOverrides', () => {
  it('keeps a valid flat object of string values', () => {
    expect(parseLabelOverrides('{"дом":"домик","кот":"котик"}')).toEqual({ дом: 'домик', кот: 'котик' })
  })

  it.each([
    ['null', null],
    ['empty string', ''],
    ['malformed JSON', '{bad'],
    ['JSON array', '["a"]'],
    ['number primitive', '123'],
    ['boolean primitive', 'true'],
    ['JSON null', 'null'],
    ['JSON string primitive', '"text"'],
  ])('returns an empty map for %s', (_label, raw) => {
    expect(parseLabelOverrides(raw)).toEqual({})
  })

  it('drops non-string values and keeps only the string ones', () => {
    expect(parseLabelOverrides('{"ok":"да","num":42,"nested":{},"bool":true,"nullVal":null}')).toEqual({
      ok: 'да',
    })
  })

  it('ignores __proto__, constructor and prototype keys, and inherited names miss', () => {
    const result = parseLabelOverrides('{"__proto__":"x","constructor":"y","prototype":"z","ok":"да"}')
    expect(Object.keys(result)).toEqual(['ok'])
    expect(result.constructor).toBeUndefined()
    expect(result.toString).toBeUndefined()
  })
})
