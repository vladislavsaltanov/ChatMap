import type { TokClass } from './types'

const RU_ENDINGS = [
  'вшись',
  'иться', 'еться', 'аться', 'яться', 'уться', 'ыться',
  'ами', 'ями', 'ься', 'тся', 'ете', 'ите', 'ешь', 'ишь',
  'ить', 'еть', 'ать', 'ять', 'уть', 'ыть',
  'ила', 'или', 'ило', 'ала', 'али', 'ало', 'ела', 'ели', 'ело',
  'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ую', 'юю', 'ых', 'их',
  'ей', 'ов', 'ев', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях',
  'ил', 'ал', 'ел', 'ит', 'ет', 'ут', 'ют', 'ат', 'ят',
  'ть', 'ти', 'ой', 'ай', 'яй', 'ий', 'ый', 'ое', 'ее', 'ая', 'яя', 'ые', 'ие',
  'а', 'я', 'у', 'ю', 'о', 'е', 'ы', 'и', 'ь', 'й',
].sort((a, b) => b.length - a.length)

// Endings indexed by final char: stemming checks only the handful of endings
// that can match instead of scanning all ~60 per token. Buckets keep the
// longest-first order, so the longest applicable ending still wins (an ending
// can only match a word ending in the same char).
const RU_ENDINGS_BY_LAST = (() => {
  const map = new Map<string, string[]>()
  for (const ending of RU_ENDINGS) {
    const last = ending.at(-1) ?? ''
    let list = map.get(last)
    if (!list) {
      list = []
      map.set(last, list)
    }
    list.push(ending)
  }
  return map
})()

const LATIN_ENDINGS = ['ing', 'ed', 'es', 's']

// A stem that is itself a corpus-wide standalone word, far more frequent than the
// word it would absorb, is almost always a DIFFERENT lexeme, not its inflection:
// «меня» (2085) must not swallow «менять» (15). Real paradigms stay within a few
// times in frequency (measured <10x), while the false merge above is 139x.
const STEM_DOMINANCE = 25

// Query: does `remainder` dominate `word` in the corpus? Without counts (tests,
// single-token callers) the answer is always no, i.e. the old stemming applies.
function dominates(remainder: string, word: string, counts?: Map<string, number>): boolean {
  if (!counts) return false
  const stemFreq = counts.get(remainder)
  if (!stemFreq) return false
  return stemFreq >= STEM_DOMINANCE * Math.max(1, counts.get(word) ?? 0)
}

function stemRu(word: string, counts?: Map<string, number>): string {
  const candidates = RU_ENDINGS_BY_LAST.get(word.at(-1) ?? '') ?? []
  for (const ending of candidates) {
    if (word.endsWith(ending)) {
      const remainder = word.slice(0, -ending.length)
      if (remainder.length >= 4 || remainder === 'дом') {
        // Vetoed: keep the whole word so it never joins the dominant lexeme.
        return dominates(remainder, word, counts) ? word : remainder
      }
    }
  }
  return word
}

function stemLatin(word: string): string {
  for (const ending of LATIN_ENDINGS) {
    if (word.endsWith(ending)) {
      if (ending === 's' && word.endsWith('ss')) {
        continue
      }
      const remainder = word.slice(0, -ending.length)
      if (remainder.length >= 3) {
        return remainder
      }
    }
  }
  return word
}

export function canon(word: string, cls: TokClass, counts?: Map<string, number>): string {
  if (cls !== 'plain') {
    return word
  }

  const clean = word.toLowerCase().replace(/ё/g, 'е')
  if (/[а-я]/u.test(clean)) {
    return stemRu(clean, counts)
  }
  if (/[a-z]/.test(clean)) {
    return stemLatin(clean)
  }
  return clean
}
