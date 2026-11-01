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

const LATIN_ENDINGS = ['ing', 'ed', 'es', 's']

function stemRu(word: string): string {
  for (const ending of RU_ENDINGS) {
    if (word.endsWith(ending)) {
      const remainder = word.slice(0, -ending.length)
      if (remainder.length >= 4 || remainder === 'дом') {
        return remainder
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

export function canon(word: string, cls: TokClass): string {
  if (cls !== 'plain') {
    return word
  }

  const clean = word.toLowerCase().replace(/ё/g, 'е')
  if (/[а-я]/u.test(clean)) {
    return stemRu(clean)
  }
  if (/[a-z]/.test(clean)) {
    return stemLatin(clean)
  }
  return clean
}
