import { describe, expect, it, vi } from 'vitest'
import { canon } from '../src/core/canon'
import * as canonMod from '../src/core/canon'
import { Intern, MAX_TOKEN_ID } from '../src/core/intern'

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

  it('assigns the last valid id, then throws', () => {
    const ia = new Intern()
    Reflect.set(ia, 'nextId', MAX_TOKEN_ID)
    expect(ia.intern('last', 'plain').id).toBe(MAX_TOKEN_ID)
    expect(() => ia.intern('overflow', 'plain')).toThrow(RangeError)
  })
})

describe('canon с частотным словарём корпуса', () => {
  // Real shape from a chat: the pronoun «меня» is 139x more frequent than the verb
  // it would absorb, so the stem «меня» is a different lexeme, not an inflection.
  const counts = new Map([
    ['меня', 2085],
    ['менять', 15],
    ['меняет', 7],
    ['меняют', 4],
    ['меняю', 1],
    ['меняем', 1],
    ['работ', 100],
    ['работе', 10],
  ])

  it('не вливает редкую форму в частотное самостоятельное слово', () => {
    expect(canon('менять', 'plain', counts)).not.toBe('меня')
    expect(canon('меняет', 'plain', counts)).not.toBe('меня')
    expect(canon('меняют', 'plain', counts)).not.toBe('меня')
    // The pronoun keeps its own slot.
    expect(canon('меня', 'plain', counts)).toBe('меня')
  })

  it('по-прежнему склеивает парадигму, где основа не доминирует', () => {
    expect(canon('работе', 'plain', counts)).toBe('работ')
  })

  it('без карты частот работает как раньше', () => {
    expect(canon('менять', 'plain')).toBe('меня')
    expect(canon('работе', 'plain')).toBe('работ')
  })

  it('Intern с картой оставляет у местоимения и глагола разные ноды', () => {
    const ia = new Intern(counts)
    const pronoun = ia.intern('меня', 'plain')
    const verb = ia.intern('менять', 'plain')
    expect(verb.id).not.toBe(pronoun.id)
    expect(ia.forms.get(pronoun.id)!.get('меня')).toBe(1)
    expect(ia.forms.get(verb.id)!.get('менять')).toBe(1)
  })
})
