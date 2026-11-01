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

const MAT_ROOTS = [
  'бляд', 'бля', 'хуй', 'хер', 'еб', 'пизд', 'муд', 'сук',
  'говн', 'дерьм', 'падл', 'подон', 'оху', 'ниху', 'аху',
]

const MAT_EXACT = new Set(['сука', 'блять', 'нахуй', 'епта', 'пздц'])

const LAUGH_LITERALS = new Set(['лол', 'кек', 'lol', 'lmao', 'rofl', 'kek'])
const LAUGH_GLYPHS = /^[хаеиоуыэ-]+$/u

export function isStopword(word: string): boolean {
  const clean = word.toLowerCase().replace(/ё/g, 'е')
  return RU_STOPWORDS.has(clean) || EN_STOPWORDS.has(clean)
}

function matchesRootRule(word: string, root: string): boolean {
  if (!word.startsWith(root)) return false
  const suffix = word.slice(root.length)
  return suffix.length <= 4 && /^[а-яё]*$/u.test(suffix)
}

export function matchesMat(word: string, customRoots: string[]): boolean {
  const clean = word.toLowerCase().replace(/ё/g, 'е')

  if (MAT_EXACT.has(clean)) {
    return true
  }

  for (const root of MAT_ROOTS) {
    if (root === 'сук' && clean.startsWith('сукн')) {
      continue
    }
    if (matchesRootRule(clean, root)) {
      return true
    }
  }

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
