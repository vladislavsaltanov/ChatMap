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

const LAUGH_LITERALS = new Set(['лол', 'кек', 'lol', 'lmao', 'rofl', 'kek'])
const LAUGH_GLYPHS = /^[хаеиоуыэ-]+$/u

export function isStopword(word: string): boolean {
  const clean = word.toLowerCase().replace(/ё/g, 'е')
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
function isMatAllowlisted(s: string): boolean {
  return MAT_ALLOWLIST.some((prefix) => s.startsWith(prefix))
}

// Root scan over the word's first-char bucket only: a root can match solely
// words starting with the same char, so the result equals a full scan.
function matchesIndexedRoots(word: string): boolean {
  const candidates = MAT_ROOTS_BY_FIRST.get(word.at(0) ?? '') ?? []
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
  if (matchesIndexedRoots(clean)) return true
  if (stripped !== clean) {
    if (MAT_EXACT.has(stripped)) return true
    if (matchesIndexedRoots(stripped)) return true
  }
  return false
}

export function matchesMat(word: string, customRoots: string[]): boolean {
  const clean = word.toLowerCase().replace(/ё/g, 'е')
  if (matchesMatBuiltin(clean) || matchesMatCustom(clean, customRoots)) return true
  // Hyphenated compounds: ебать-копать. Each part follows the same rules;
  // every part is allowlisted independently (бляха-муха stays clean).
  if (/[-–—]/.test(clean)) {
    return clean
      .split(/[-–—]/u)
      .some((part) => part.length >= 2 && (matchesMatBuiltin(part) || matchesMatCustom(part, customRoots)))
  }
  return false
}

function matchesMatCustom(clean: string, customRoots: string[]): boolean {
  for (const item of customRoots) {
    const raw = item.trim().toLowerCase().replace(/ё/g, 'е')
    if (!raw) continue
    if (raw.endsWith('-')) {
      const root = raw.slice(0, -1)
      if (matchesRootRule(clean, root)) {
        return true
      }
    } else if (clean === raw) {
      return true
    }
  }

  return false
}

export function matchesLaugh(word: string, customItems: string[]): boolean {
  const clean = word.toLowerCase().replace(/ё/g, 'е')

  if (LAUGH_LITERALS.has(clean)) {
    return true
  }

  if (LAUGH_GLYPHS.test(clean)) {
    const hMatches = clean.match(/х/gu)
    if (hMatches && hMatches.length >= 2) {
      return true
    }
  }

  for (const item of customItems) {
    const raw = item.trim().toLowerCase().replace(/ё/g, 'е')
    if (!raw) continue
    if (raw.endsWith('-')) {
      const root = raw.slice(0, -1)
      if (matchesRootRule(clean, root)) {
        return true
      }
    } else if (clean === raw) {
      return true
    }
  }

  return false
}
