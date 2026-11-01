import type { TextPart, Tok, TokClass, TokUnit } from './types'

export type { Tok, TokClass, TokUnit }

const PLAIN_SPLIT = /([\n.!?…;]+)/u
const PLAIN_DELIM_TEST = /^[\n.!?…;]+$/u

const CODE_SPLIT = /([\n;]+)/u
const CODE_DELIM_TEST = /^[\n;]+$/u

function extractPlainTokens(text: string): Tok[] {
  const tokens: Tok[] = []
  const regex = /(\p{L}[\p{L}\p{M}'’-]*|\d[\d._-]*)/gu
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1]
    if (/^\d/.test(raw)) {
      const num = raw.replace(/[._-]+$/u, '')
      if (num.length > 0) {
        tokens.push({ word: num, cls: 'digits' })
      }
    } else {
      const clean = raw.replace(/['’-]+$/u, '').toLowerCase().replace(/ё/g, 'е')
      if (clean.length > 0) {
        tokens.push({ word: clean, cls: 'plain' })
      }
    }
  }
  return tokens
}

function extractTechTokens(text: string): Tok[] {
  const tokens: Tok[] = []
  const regex = /[^\s,()[\]{}'"]+/gu
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const clean = match[0].toLowerCase().replace(/ё/g, 'е')
    if (clean.length > 0) {
      tokens.push({ word: clean, cls: 'tech' })
    }
  }
  return tokens
}

export function tokenize(parts: TextPart[]): TokUnit[] {
  const units: TokUnit[] = []
  let currentUnit: Tok[] = []

  for (const part of parts) {
    const isTech = part.entity === 'code' || part.entity === 'link'
    const splitter = isTech ? CODE_SPLIT : PLAIN_SPLIT
    const isDelim = isTech ? CODE_DELIM_TEST : PLAIN_DELIM_TEST
    const segments = part.text.split(splitter)

    for (const segment of segments) {
      if (!segment) continue

      if (isDelim.test(segment)) {
        if (currentUnit.length > 0) {
          units.push(currentUnit)
          currentUnit = []
        }
      } else {
        const tokens = isTech ? extractTechTokens(segment) : extractPlainTokens(segment)
        for (const tok of tokens) {
          currentUnit.push(tok)
        }
      }
    }
  }

  if (currentUnit.length > 0) {
    units.push(currentUnit)
  }

  return units
}
