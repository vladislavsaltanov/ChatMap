// Deterministic message-level synthetic chat with one word carrying most links:
// the failure shape a real chat produces (a filler word in almost every message).
// The generator exists so the stand and the tests share one source: the words are
// drawn from a Zipf pool over topic slices, the mega-hub is injected with a chosen
// probability, and two semi-hubs sit between it and the topical vocabulary.
// Only the generator is committed; no chat data.
//
// Run from tests: buildMegaHubChat({ hubShare: 0.85 }).
// Run from tools/shot-shape.mjs `mega`: same defaults.

const SYLLABLES = [
  'ма', 'ре', 'ки', 'то', 'лу', 'на', 'ве', 'зи', 'дор', 'ша',
  'кор', 'ти', 'му', 'ба', 'сен', 'лар', 'по', 'чер', 'вы', 'гра',
]

// Stable nonsense words: real stopwords would be filtered, and a hub that is a
// stopword never reaches the graph at all.
export const HUB_WORDS = ['зумбра', 'квелта', 'фурни']

export const MEGA_DEFAULTS = {
  messages: 6000,
  vocab: 1400,
  topics: 8,
  // Probability that one message carries the mega-hub word (own sentence unit).
  hubShare: 0.85,
  // Probability that it carries one of the two semi-hubs.
  semiHubShare: 0.25,
  // Probability that the topic sentence borrows one word from the whole pool.
  backgroundShare: 0.35,
  // Zipf exponent of the word pool: ~1.05-1.1 matches a conversational frequency
  // curve without letting a handful of ranks own the pool.
  zipf: 1.08,
  seed: 20261114,
}

// Deterministic LCG, integer arithmetic only (same family as the stand scripts).
const makeRng = (seed) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

// Inverse-CDF draw over precomputed Zipf weights: binary search over the slice's
// cumulative curve, so a draw costs log(slice) instead of rebuilding weights.
const drawRank = (rnd, cumulative, total) => {
  const target = rnd() * total
  let lo = 0
  let hi = cumulative.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function buildMegaHubChat(opts = {}) {
  const cfg = { ...MEGA_DEFAULTS, ...opts }
  const rnd = makeRng(cfg.seed)

  // Distinct syllabic words, split into topic slices by rank.
  const words = new Set(HUB_WORDS)
  while (words.size < cfg.vocab + HUB_WORDS.length) {
    words.add(
      SYLLABLES[Math.floor(rnd() * SYLLABLES.length)] +
        SYLLABLES[Math.floor(rnd() * SYLLABLES.length)] +
        SYLLABLES[Math.floor(rnd() * SYLLABLES.length)] +
        SYLLABLES[Math.floor(rnd() * SYLLABLES.length)],
    )
  }
  const vocab = [...words].sort()
  const topical = vocab.filter((w) => !HUB_WORDS.includes(w))
  const perTopic = Math.floor(topical.length / cfg.topics)
  const topicPools = []
  const topicCumulative = []
  for (let t = 0; t < cfg.topics; t++) {
    const pool = topical.slice(t * perTopic, t === cfg.topics - 1 ? topical.length : (t + 1) * perTopic)
    const cumulative = []
    let total = 0
    for (let r = 0; r < pool.length; r++) {
      total += 1 / Math.pow(r + 1, cfg.zipf)
      cumulative.push(total)
    }
    topicPools.push(pool)
    topicCumulative.push({ cumulative, total })
  }

  // Two authors in bursts (series) with occasional replies inside a series.
  // Between series the gap is hours, so tally's adjacency rule links only inside
  // a series — the same structure a live chat has.
  const messages = []
  const base = 1761900000
  let series = 0
  let msgId = 1000
  while (messages.length < cfg.messages) {
    const author = series % 2
    const seriesLen = 1 + Math.floor(rnd() * 3)
    let seriesStartId = 0
    let seriesStartAt = 0
    for (let s = 0; s < seriesLen && messages.length < cfg.messages; s++) {
      const topic = Math.floor(rnd() * cfg.topics)
      const { cumulative, total } = topicCumulative[topic]
      const pool = topicPools[topic]
      const chosen = new Set()
      const n = 3 + Math.floor(rnd() * 10)
      for (let k = 0; k < n; k++) chosen.add(pool[drawRank(rnd, cumulative, total)])
      if (rnd() < cfg.backgroundShare) chosen.add(topical[Math.floor(rnd() * topical.length)])
      const heads = []
      if (rnd() < cfg.hubShare) heads.push(HUB_WORDS[0])
      if (rnd() < cfg.semiHubShare) heads.push(HUB_WORDS[1])
      if (rnd() < cfg.semiHubShare) heads.push(HUB_WORDS[2])
      const text =
        (heads.length > 0 ? `${heads.join(' ')}. ` : '') +
        [...chosen].join(' ') +
        '.'
      let at
      if (s === 0) {
        at = base + series * 5 * 3600
        seriesStartAt = at
        seriesStartId = msgId
      } else {
        at = seriesStartAt + s * (20 + Math.floor(rnd() * 100))
      }
      const replyTo = s > 0 && rnd() < 0.35 ? seriesStartId + Math.floor(rnd() * s) : null
      messages.push({
        id: msgId,
        type: 'message',
        date_unixtime: at,
        from: author === 0 ? 'Аня' : 'Борис',
        from_id: author === 0 ? 101 : 202,
        text,
        ...(replyTo === null ? {} : { reply_to_message_id: replyTo }),
      })
      msgId++
    }
    series++
  }

  return { name: 'Синтетика мега-хаб', type: 'personal_chat', id: 700001, messages }
}
