import { describe, expect, it } from 'vitest'
import { isStopword, matchesLaugh, matchesMat } from '../src/core/filters'
import { dropFor } from '../src/core/tally'
import type { FilterCfg, Tok, TokClass } from '../src/core/types'

describe('filters', () => {
  describe('isStopword', () => {
    it('detects common RU and EN stopwords', () => {
      expect(isStopword('если')).toBe(true)
      expect(isStopword('и')).toBe(true)
      expect(isStopword('the')).toBe(true)
      expect(isStopword('all')).toBe(true)
    })

    it('does not reject non-stopwords', () => {
      expect(isStopword('мем')).toBe(false)
      expect(isStopword('дизайн')).toBe(false)
      expect(isStopword('graph')).toBe(false)
    })
  })

  describe('matchesMat', () => {
    it('matches profanity forms and roots (§6.6)', () => {
      expect(matchesMat('сука', [])).toBe(true)
      expect(matchesMat('блять', [])).toBe(true)
      expect(matchesMat('нахуй', [])).toBe(true)
      expect(matchesMat('ебать', [])).toBe(true)
      expect(matchesMat('ебёшь', [])).toBe(true)
    })

    it('does not false-positive on innocent words (§6.6)', () => {
      expect(matchesMat('ахать', [])).toBe(false)
      expect(matchesMat('сукно', [])).toBe(false)
    })

    it('does not flag innocent words that share a prefix with a short mat root (regression)', () => {
      const innocent = ['мудрый', 'мудрость', 'мудрец', 'херсон', 'херес', 'херувим', 'сукно', 'бляха', 'бляшка']
      expect(innocent.filter((word) => matchesMat(word, []))).toEqual([])
    })

    it('flags stems and forms that replaced short mat roots (regression)', () => {
      const profane = ['мудак', 'мудила', 'мудацкий', 'хер', 'херня', 'херовый', 'бля', 'блядь', 'сучка', 'сучара', 'сука', 'блять', 'нахуй', 'ебать', 'ебёшь']
      expect(profane.filter((word) => !matchesMat(word, []))).toEqual([])
    })

    it('flags forms the short roots used to catch (regression)', () => {
      const profane = ['ёб', 'еб', 'ебена', 'ебёна', 'ебись', 'ебитесь', 'сукин', 'сукины', 'мудоеб', 'мудозвон']
      expect(profane.filter((word) => !matchesMat(word, []))).toEqual([])
    })

    it('catches profanity behind verb prefixes (похуй, заебись)', () => {
      const prefixed = ['похуй', 'похуист', 'похуизм', 'нахуя', 'заебись', 'заебал', 'заебало',
        'доебаться', 'уебан', 'уебище', 'уебок', 'подъебнуть', 'съебать', 'захуярить', 'переебать']
      expect(prefixed.filter((word) => !matchesMat(word, []))).toEqual([])
    })

    it('catches missing roots (долбоеб, пидорас, гандон, залупа, еблан)', () => {
      const roots = ['долбоеб', 'долбаеб', 'долбоебы', 'еблан', 'ебланы', 'ебло',
        'пидорас', 'пидоры', 'пидрила', 'гандон', 'залупа', 'охуительный', 'ебанувшийся', 'ебальник']
      expect(roots.filter((word) => !matchesMat(word, []))).toEqual([])
    })

    it('catches hyphenated compounds (ебать-копать)', () => {
      expect(matchesMat('ебать-копать', [])).toBe(true)
      expect(matchesMat('бляха-муха', [])).toBe(false)
    })

    it('does not flag innocent words that share a prefix with a mat root', () => {
      const innocent = ['заедать', 'заеда', 'похудеть', 'подъезд', 'съесть', 'доесть',
        'переезд', 'всучить', 'посуда', 'засуха', 'похерить']
      expect(innocent.filter((word) => matchesMat(word, []))).toEqual([])
    })

    it('keeps custom roots working for allowlisted prefixes', () => {
      expect(matchesMat('мудрец', ['мудр-'])).toBe(true)
      expect(matchesMat('бляха', ['бляха'])).toBe(true)
    })

    it('supports custom roots with hyphen suffix', () => {
      expect(matchesMat('нушая', ['нуш-'])).toBe(true)
      expect(matchesMat('другое', ['нуш-'])).toBe(false)
    })

    it('supports custom literal words without hyphen', () => {
      expect(matchesMat('редиска', ['редиска'])).toBe(true)
      expect(matchesMat('морковь', ['редиска'])).toBe(false)
    })
  })

  describe('matchesLaugh', () => {
    it('matches laughing patterns and literals (§6.6)', () => {
      expect(matchesLaugh('хахах', [])).toBe(true)
      expect(matchesLaugh('ахах', [])).toBe(true)
      expect(matchesLaugh('хАхА', [])).toBe(true)
      expect(matchesLaugh('лол', [])).toBe(true)
      expect(matchesLaugh('lmao', [])).toBe(true)
      expect(matchesLaugh('kek', [])).toBe(true)
      expect(matchesLaugh('rofl', [])).toBe(true)
    })

    it('does not false-positive on non-laugh words (§6.6)', () => {
      expect(matchesLaugh('ахалай', [])).toBe(false)
      expect(matchesLaugh('хахатка', [])).toBe(false)
      expect(matchesLaugh('механика', [])).toBe(false)
    })

    it('supports custom laugh items', () => {
      expect(matchesLaugh('хехей', ['хех-'])).toBe(true)
      expect(matchesLaugh('базинга', ['базинга'])).toBe(true)
      expect(matchesLaugh('обычное', ['базинга'])).toBe(false)
    })
  })
})

// Show-flag cfg: true keeps a category, so start from "nothing drops".
const shownCfg: FilterCfg = {
  mat: true,
  laugh: true,
  tech: true,
  digits: true,
  stopwords: true,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

const cfg = (over: Partial<FilterCfg> = {}): FilterCfg => ({ ...shownCfg, ...over })

const tok = (word: string, cls: TokClass = 'plain'): Tok => ({ word, cls })

const drops = (c: FilterCfg, word: string, cls: TokClass = 'plain'): boolean => dropFor(c)(tok(word, cls))

describe('dropFor', () => {
  it('drops mat words only while the mat category is unchecked', () => {
    expect(drops(cfg({ mat: false }), 'блять')).toBe(true)
    expect(drops(cfg({ mat: true }), 'блять')).toBe(false)
  })

  it('applies custom roots by prefix, bare root word included', () => {
    const custom = cfg({ mat: false, customMat: ['фу-'] })
    expect(drops(custom, 'фубар')).toBe(true)
    // An empty suffix passes matchesRootRule today: the bare root is dropped too.
    expect(drops(custom, 'фу')).toBe(true)
    expect(drops(cfg({ mat: true, customMat: ['фу-'] }), 'фубар')).toBe(false)
  })

  it('applies custom exact items as literals only', () => {
    const custom = cfg({ mat: false, customMat: ['кринж'] })
    expect(drops(custom, 'кринж')).toBe(true)
    expect(drops(custom, 'кринжа')).toBe(false)
    // The same word as a root item also covers its forms.
    expect(drops(cfg({ mat: false, customMat: ['кринж-'] }), 'кринжа')).toBe(true)
  })

  it('normalizes custom items: spaces, case and ё do not matter', () => {
    expect(drops(cfg({ mat: false, customMat: [' ЁБАНЫЙ '] }), 'ебаный')).toBe(true)
    // Built-in laugh rules miss this word, so the hit comes from the normalized item.
    expect(drops(cfg({ laugh: false, customLaugh: [' ЁЖИК '] }), 'ЕЖИК')).toBe(true)
  })

  it('treats a lone dash item as inert', () => {
    // The empty root used to match every short Cyrillic word: documented behavior change.
    const mat = dropFor(cfg({ mat: false, customMat: ['-'] }))
    const laugh = dropFor(cfg({ laugh: false, customLaugh: ['-'] }))
    for (const word of ['фу', 'кринж', 'обычное']) {
      expect(mat(tok(word))).toBe(false)
      expect(laugh(tok(word))).toBe(false)
    }
  })

  it('snapshots custom lists when the predicate is built', () => {
    // The predicate lives for one tally pass; mutating cfg lists afterwards is not
    // observed. Until this step the list was read per token, so this is the second
    // documented behavior change.
    const list = ['кринж']
    const drop = dropFor(cfg({ mat: false, customMat: list }))
    list.push('редиска')
    expect(drop(tok('кринж'))).toBe(true)
    expect(drop(tok('редиска'))).toBe(false)
  })

  it('drops tech and digit tokens only while their flags are unchecked', () => {
    expect(drops(cfg({ tech: false }), 'https', 'tech')).toBe(true)
    expect(drops(cfg({ tech: true }), 'https', 'tech')).toBe(false)
    expect(drops(cfg({ digits: false }), '2024', 'digits')).toBe(true)
    expect(drops(cfg({ digits: true }), '2024', 'digits')).toBe(false)
  })

  it('drops stopwords only while the stopword flag is unchecked', () => {
    expect(drops(cfg({ stopwords: false }), 'если')).toBe(true)
    expect(drops(cfg({ stopwords: true }), 'если')).toBe(false)
  })
})

describe('dropFor rules (regression pins)', () => {
  it('keeps innocent words clean under built-in mat rules', () => {
    const drop = dropFor(cfg({ mat: false }))
    for (const word of ['мудрый', 'херсон', 'бляха']) expect(drop(tok(word))).toBe(false)
  })

  it('matches profanity behind a stripped verb prefix', () => {
    const drop = dropFor(cfg({ mat: false }))
    for (const word of ['похуй', 'заебал', 'подъебнуть']) expect(drop(tok(word))).toBe(true)
  })

  it('applies the same rules to hyphen parts', () => {
    const drop = dropFor(cfg({ mat: false }))
    expect(drop(tok('бляха-муха'))).toBe(false)
    expect(drop(tok('ебать-копать'))).toBe(true)
  })

  it('drops laugh forms through the glyph, literal and custom root rules', () => {
    const drop = dropFor(cfg({ laugh: false, customLaugh: ['хех-'] }))
    expect(drop(tok('ахахаха'))).toBe(true)
    expect(drop(tok('лол'))).toBe(true)
    expect(drop(tok('хехей'))).toBe(true)
  })
})

// Uncompiled chain: the public predicates in dropFor's original order.
const oracleDrop = (c: FilterCfg) => (t: Tok): boolean =>
  (!c.tech && t.cls === 'tech') ||
  (!c.digits && t.cls === 'digits') ||
  (!c.stopwords && isStopword(t.word)) ||
  (!c.mat && matchesMat(t.word, c.customMat)) ||
  (!c.laugh && matchesLaugh(t.word, c.customLaugh))

const EQUIV_TOKENS: Tok[] = [
  'мудрый', 'херсон', 'бляха', 'бляха-муха', 'ебать-копать', 'похуй', 'заебал', 'подъебнуть',
  'блять', 'ебаный', 'фу', 'фубар', 'кринж', 'кринжа', 'ахахаха', 'лол', 'хехей', 'ежик',
  'механика', 'если', 'the', 'обычное', 'редиска', 'ЁБАНЫЙ',
].map((word) => tok(word))
EQUIV_TOKENS.push(tok('https', 'tech'), tok('2024', 'digits'))

const EQUIV_CFGS: FilterCfg[] = [
  cfg(),
  cfg({ mat: false }),
  cfg({ laugh: false }),
  cfg({ mat: false, laugh: false }),
  cfg({ mat: false, customMat: ['фу-', 'кринж', ' ЁБАНЫЙ '] }),
  cfg({ laugh: false, customLaugh: ['хех-', ' ЁЖИК '] }),
  cfg({ mat: false, laugh: false, customMat: ['бляха', 'мудр-'], customLaugh: ['базинга'] }),
]

describe('compileWordRules (equivalence)', () => {
  it('agrees with the public predicates on every word and cfg', () => {
    const disagreements: string[] = []
    let checked = 0
    for (const c of EQUIV_CFGS) {
      const drop = dropFor(c)
      const oracle = oracleDrop(c)
      for (const t of EQUIV_TOKENS) {
        checked += 1
        if (drop(t) !== oracle(t)) disagreements.push(`${t.word}/${t.cls}: ${JSON.stringify(c)}`)
      }
    }
    expect(disagreements).toEqual([])
    expect(checked).toBe(EQUIV_CFGS.length * EQUIV_TOKENS.length)
  })
})
