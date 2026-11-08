import { describe, expect, it, vi } from 'vitest'
import { canon } from '../src/core/canon'
import * as canonMod from '../src/core/canon'
import { Intern } from '../src/core/intern'

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

describe('Intern memoization', () => {
  it('interning the same (word, cls) 50 times invokes canon at most once', () => {
    const spy = vi.spyOn(canonMod, 'canon')
    try {
      spy.mockClear()
      const interner = new Intern()
      let id = -1
      for (let i = 0; i < 50; i++) {
        id = interner.intern('домами', 'plain').id
      }
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
      expect(interner.forms.get(id)!.get('домами')).toBe(50)
    } finally {
      spy.mockRestore()
    }
  })

  it('different inflections share the same id with individual counts', () => {
    const interner = new Intern()
    const a = interner.intern('дом', 'plain')
    const b = interner.intern('дома', 'plain')
    const c = interner.intern('дому', 'plain')
    expect(b.id).toBe(a.id)
    expect(c.id).toBe(a.id)
    const forms = interner.forms.get(a.id)!
    expect(forms.get('дом')).toBe(1)
    expect(forms.get('дома')).toBe(1)
    expect(forms.get('дому')).toBe(1)
  })

  it('same surface word with plain vs tech does not collide', () => {
    const interner = new Intern()
    const plain = interner.intern('talked', 'plain')
    const tech = interner.intern('talked', 'tech')
    expect(tech.id).not.toBe(plain.id)
    expect(interner.forms.get(plain.id)!.get('talked')).toBe(1)
    expect(interner.forms.get(tech.id)!.get('talked')).toBe(1)
  })
})
