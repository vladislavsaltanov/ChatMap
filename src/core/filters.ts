import type { FilterCfg } from './types'

const RU_STOPWORDS = new Set([
  'и', 'в', 'не', 'на', 'я', 'что', 'с', 'по', 'а', 'он',
  'как', 'то', 'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к',
  'у', 'же', 'вы', 'за', 'бы', 'от', 'о', 'из', 'ему', 'тогда',
  'когда', 'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть',
  'был', 'была', 'было', 'были', 'будет', 'будут', 'него', 'до', 'вас', 'нибудь',
  'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может',
  'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их',
  'чем', 'вот', 'чтоб', 'чтобы', 'одно', 'им', 'более', 'мне', 'моем',
  'этот', 'это', 'эта', 'эти', 'этих', 'этого', 'этой', 'этом', 'этому', 'этим',
  'тому', 'тем', 'теми', 'тех', 'тот', 'та', 'те', 'тоже', 'здесь', 'сейчас',
  'очень', 'после', 'перед', 'через', 'между', 'около', 'под', 'над', 'без', 'про',
  'при', 'против', 'кроме', 'ради', 'спустя', 'вместе', 'сквозь', 'среди', 'возле', 'мимо',
  'вокруг', 'вдоль', 'внутри', 'вне', 'сверху', 'снизу', 'сзади', 'впереди', 'сам', 'сама',
  'сами', 'само', 'мое', 'моя', 'мои', 'мой', 'твой', 'твоя', 'твое', 'твои',
  'наш', 'наша', 'наше', 'наши', 'ваш', 'ваша', 'ваше', 'ваши', 'свой', 'своя',
  'свое', 'свои', 'кто', 'кому', 'кем', 'ком', 'кого', 'куда', 'откуда', 'почему',
  'зачем', 'сколько', 'столько', 'много', 'мало', 'несколько', 'раз', 'два', 'три', 'только',
  'всего', 'совсем', 'чуть', 'еще', 'хотя', 'будто', 'словно', 'вроде', 'точно',
])

const EN_STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
])

// Short roots (муд, хер, бля, сук, еб) match innocent words (мудрый, херсон), so only explicit forms remain.
const MAT_ROOTS = [
  'бляд', 'пизд', 'говн', 'дерьм', 'падл', 'подон', 'оху', 'ниху', 'аху',
  'мудак', 'мудил', 'мудац', 'мудо', 'херн', 'херов', 'сучк', 'сучар', 'сукин',
  'хуй', 'хуе', 'хуи', 'хуя',
  'еба', 'ебем', 'ебет', 'ебеш', 'ебут', 'ебл', 'ебн', 'ебу', 'ебен',
  'долбоеб', 'долбаеб', 'еблан', 'ебло', 'ебищ', 'ебок',
  'пидор', 'пидар', 'пидорас', 'пидрил', 'гандон', 'залуп',
]

// Common verb prefixes hiding the root: похуй, заебал, уебан, подъебнуть.
// Longest match first; at most one prefix is stripped.
const MAT_PREFIXES = [
  'пере', 'пред',
  'раз', 'рас', 'при', 'про', 'под', 'над', 'без', 'воз', 'вос',
  'до', 'за', 'на', 'по', 'вы', 'об', 'от', 'из', 'ис',
  'у', 'о', 'в', 'с',
]

// First-char index over a longest-first list: declaration order survives inside
// each bucket, so longest-match-first semantics hold while the per-token scan
// drops from the whole list to one bucket.
function indexByFirst(list: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const item of list) {
    const first = item.at(0) ?? ''
    let bucket = map.get(first)
    if (!bucket) {
      bucket = []
      map.set(first, bucket)
    }
    bucket.push(item)
  }
  return map
}

const MAT_ROOTS_BY_FIRST = indexByFirst(MAT_ROOTS)
const MAT_PREFIXES_BY_FIRST = indexByFirst(MAT_PREFIXES)

const MAT_EXACT = new Set([
  'еб', 'ебись', 'ебитесь', 'сука', 'суки', 'суке', 'суку', 'сукой', 'бля', 'блять', 'блядь',
  'хер', 'хера', 'херу', 'хером', 'нахуй', 'епта', 'пздц',
])

// Innocent words that start with a mat form: built-in rules skip them, customRoots still apply.
const MAT_ALLOWLIST = ['мудр', 'херсон', 'херес', 'сукн', 'бляха']
const MAT_ALLOW_BY_FIRST = indexByFirst(MAT_ALLOWLIST)

const LAUGH_LITERALS = new Set(['лол', 'кек', 'lol', 'lmao', 'rofl', 'kek'])
const LAUGH_GLYPHS = /^[хаеиоуыэ-]+$/u

// Hyphenated compounds (ебать-копать) split on any dash form.
const WORD_HYPHENS = /[-–—]/u

// One normalization for every word and list item: lowercase + ё -> е.
function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е')
}

type PreparedList = {
  exact: Set<string>
  rootsByFirst: Map<string, string[]>
}

// User lists compile once per config: an item ending with '-' is a prefix root,
// the rest are exact words. Normalization happens here, not per token.
function prepareList(items: string[]): PreparedList {
  const exact = new Set<string>()
  const roots: string[] = []
  for (const item of items) {
    const raw = normalize(item.trim())
    if (!raw) continue
    if (raw.endsWith('-')) {
      // A lone '-' is inert by design: its empty root used to match every short Cyrillic word.
      const root = raw.slice(0, -1)
      if (root) roots.push(root)
    } else exact.add(raw)
  }
  // A root can only match words sharing its first char, so one bucket per char is enough.
  return { exact, rootsByFirst: indexByFirst(roots) }
}

export function isStopword(word: string): boolean {
  const clean = normalize(word)
  return RU_STOPWORDS.has(clean) || EN_STOPWORDS.has(clean)
}

function matchesRootRule(word: string, root: string): boolean {
  if (!word.startsWith(root)) return false
  const suffix = word.slice(root.length)
  // Long productive endings (охуительный, ебанувшийся) still count; roots are
  // specific enough that innocent words do not reach this branch (see tests).
  return suffix.length <= 8 && /^[а-яё]*$/u.test(suffix)
}

// Strips one verb prefix (подъебнуть -> ебнуть); ъ/ь after it is dropped.
// Returns the input unchanged when no prefix applies.
function stripMatPrefix(clean: string): string {
  const candidates = MAT_PREFIXES_BY_FIRST.get(clean.at(0) ?? '') ?? []
  for (const prefix of candidates) {
    if (clean.startsWith(prefix) && clean.length - prefix.length >= 2) {
      return clean.slice(prefix.length).replace(/^[ъь]/u, '')
    }
  }
  return clean
}

// Innocent words that start with a mat form: built-in rules skip the whole word.
// Same first-char bucket trick as the roots: a prefix shares the word's first char.
function isMatAllowlisted(s: string): boolean {
  const candidates = MAT_ALLOW_BY_FIRST.get(s.at(0) ?? '') ?? []
  for (const prefix of candidates) {
    if (s.startsWith(prefix)) return true
  }
  return false
}

// Root scan over the word's first-char bucket only: a root can match solely
// words starting with the same char, so the result equals a full scan.
function matchesRoots(word: string, rootsByFirst: Map<string, string[]>): boolean {
  const candidates = rootsByFirst.get(word.at(0) ?? '') ?? []
  for (const root of candidates) {
    if (matchesRootRule(word, root)) return true
  }
  return false
}

// Built-in exact + root rules, with and without a verb prefix.
function matchesMatBuiltin(clean: string): boolean {
  const stripped = stripMatPrefix(clean)
  if (isMatAllowlisted(clean) || (stripped !== clean && isMatAllowlisted(stripped))) return false
  if (MAT_EXACT.has(clean)) return true
  if (matchesRoots(clean, MAT_ROOTS_BY_FIRST)) return true
  if (stripped !== clean) {
    if (MAT_EXACT.has(stripped)) return true
    if (matchesRoots(stripped, MAT_ROOTS_BY_FIRST)) return true
  }
  return false
}

// Custom list against an already normalized word: exact hit first, then roots.
function matchesList(clean: string, list: PreparedList): boolean {
  return list.exact.has(clean) || matchesRoots(clean, list.rootsByFirst)
}

// Mat rules for one normalized word: built-in forms (with one prefix retry),
// then the user list (custom roots still apply to allowlisted words).
function matchesMatRules(clean: string, custom: PreparedList): boolean {
  return matchesMatBuiltin(clean) || matchesList(clean, custom)
}

// Parts are already normalized; each one follows the same rules and is
// allowlisted independently (бляха-муха stays clean).
function matchesMatParts(clean: string, custom: PreparedList): boolean {
  for (const part of clean.split(WORD_HYPHENS)) {
    if (part.length >= 2 && matchesMatRules(part, custom)) return true
  }
  return false
}

// Full mat verdict for one normalized word: whole-word rules, then hyphen parts.
// The only composition point: the public predicate and the compiled one share it.
function matchesMatAll(clean: string, custom: PreparedList): boolean {
  if (matchesMatRules(clean, custom)) return true
  // Hyphenated compounds: ебать-копать.
  return WORD_HYPHENS.test(clean) && matchesMatParts(clean, custom)
}

// Shared empty list: the common 'no custom words' case allocates nothing.
const EMPTY_LIST: PreparedList = { exact: new Set(), rootsByFirst: new Map() }

// Compat wrapper for tests and one-off checks. It compiles the list per call,
// so per-token work must go through compileWordRules.
export function matchesMat(word: string, customRoots: string[]): boolean {
  return matchesMatAll(normalize(word), customRoots.length > 0 ? prepareList(customRoots) : EMPTY_LIST)
}

function matchesLaughBuiltin(clean: string): boolean {
  if (LAUGH_LITERALS.has(clean)) return true
  if (!LAUGH_GLYPHS.test(clean)) return false
  const h = clean.match(/х/gu)
  return h !== null && h.length >= 2
}

// Laugh rules for one normalized word: literals, the >=2 'х' glyph rule, then the user list.
function matchesLaughRules(clean: string, custom: PreparedList): boolean {
  return matchesLaughBuiltin(clean) || matchesList(clean, custom)
}

// Compat wrapper, same per-call compilation caveat as matchesMat.
export function matchesLaugh(word: string, customItems: string[]): boolean {
  return matchesLaughRules(normalize(word), customItems.length > 0 ? prepareList(customItems) : EMPTY_LIST)
}

// Per-config predicate: "this word is dropped by the mat/laugh category rules".
// Flags and user lists are resolved once; a token costs one normalize plus
// set/map probes. Category order matches dropFor: mat first, then laugh.
export function compileWordRules(
  cfg: Pick<FilterCfg, 'mat' | 'laugh' | 'customMat' | 'customLaugh'>
): (word: string) => boolean {
  const matOn = !cfg.mat
  const laughOn = !cfg.laugh
  // Both categories shown: nothing in this layer can drop a word.
  if (!matOn && !laughOn) return () => false

  const customMat = prepareList(cfg.customMat)
  const customLaugh = prepareList(cfg.customLaugh)

  // Lists are snapshotted on purpose: the predicate lives for one tally pass, so
  // in-place mutation of cfg.customMat/customLaugh afterwards is not observed.
  return (word) => {
    const clean = normalize(word)
    if (matOn && matchesMatAll(clean, customMat)) return true
    return laughOn && matchesLaughRules(clean, customLaugh)
  }
}
