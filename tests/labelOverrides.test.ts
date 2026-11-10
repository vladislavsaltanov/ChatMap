import { describe, expect, it } from 'vitest'
import { applyLabelOverrides, isOverridableKey, parseLabelOverrides } from '../src/core/labelOverrides'

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

  it('isOverridableKey rejects the same keys parse drops', () => {
    expect(isOverridableKey('__proto__')).toBe(false)
    expect(isOverridableKey('constructor')).toBe(false)
    expect(isOverridableKey('prototype')).toBe(false)
    expect(isOverridableKey('дом')).toBe(true)
  })

  it('ignores __proto__, constructor and prototype keys, and inherited names miss', () => {
    const result = parseLabelOverrides('{"__proto__":"x","constructor":"y","prototype":"z","ok":"да"}')
    expect(Object.keys(result)).toEqual(['ok'])
    expect(result.constructor).toBeUndefined()
    expect(result.toString).toBeUndefined()
  })
})

describe('applyLabelOverrides', () => {
  it('applies several changes in one serialization', () => {
    expect(applyLabelOverrides('{"a":"x","b":"y"}', [['a', null], ['b', null]])).toBe('{}')
    expect(applyLabelOverrides(null, [['дом', 'домик']])).toBe('{"дом":"домик"}')
  })

  it('rejects forbidden keys for save and clear', () => {
    expect(applyLabelOverrides(null, [['__proto__', 'x']])).toBeNull()
    expect(applyLabelOverrides(null, [['__proto__', null]])).toBeNull()
  })
})
