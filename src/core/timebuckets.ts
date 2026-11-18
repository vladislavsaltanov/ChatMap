// Time buckets for the timeline strip: the chat's LOCAL-calendar span selects the
// granularity (calendar months for 6+ month histories, weeks for 14+ days, one
// disabled bucket below that) and every message is mapped to a bucket index.
// Pure core role: no I/O, no clock reads — boundaries derive from the message
// dates, so the same export always yields the same layout in the same device
// timezone.
import type { ChatExport } from './types'

export type BucketMeta = {
  count: number // 1..K buckets; count >= 2 whenever eligible
  eligible: boolean // false => chat spans < 14 days, timeline disabled
  monthStarts: number[] // count+1 boundaries (ms): [i] starts bucket i, [count] is the exclusive end
  labels: string[] // one cursor label per bucket, Russian UI strings
  msgCounts: Uint32Array // messages per bucket (activity strip), service included
  bucketOf: (dateMs: number) => number // undated/non-finite => bucket 0; upper-clamped to count-1
}

const DAY_MS = 86_400_000
// Granularity ladder from the design: six calendar months, then two weeks.
const MONTHS_FOR_MONTH_BUCKETS = 6
const MIN_WEEK_DAYS = 14
const WEEK_DAYS = 7
// Russian short month names in calendar order. A hardcoded table keeps the label
// design language fixed instead of following the browser locale through Intl.
const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const WHOLE_CHAT_LABEL = 'весь чат'

// Local midnight of a (possibly overflowing) calendar date. The year goes through
// setFullYear because `new Date(y, ...)` remaps years 0..99 to 1900+y; month/day
// overflow is normalised there too, so week stepping stays DST-honest. setHours
// pins the local time of day, and a non-existent midnight normalises forward to
// the first instant of the same calendar day.
function localDate(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setFullYear(year, month, day)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// Local midnight of the calendar day containing `ms`.
function dayStart(ms: number): number {
  const date = new Date(ms)
  return localDate(date.getFullYear(), date.getMonth(), date.getDate())
}

const monthIndex = (ms: number): number => {
  const date = new Date(ms)
  return date.getFullYear() * 12 + date.getMonth()
}

type Range = { minMs: number; maxMs: number }

// [Query] Dated span of the chat. Only finite positive timestamps prove history;
// undated messages are skipped here and later land in bucket 0 via the guard.
function datedRange(messages: ChatExport['messages']): Range | null {
  let minMs = Number.POSITIVE_INFINITY
  let maxMs = 0
  for (const message of messages) {
    const { dateMs } = message
    if (!Number.isFinite(dateMs) || dateMs <= 0) continue
    if (dateMs < minMs) minMs = dateMs
    if (dateMs > maxMs) maxMs = dateMs
  }
  return minMs === Number.POSITIVE_INFINITY ? null : { minMs, maxMs }
}

// Calendar-day distance between the ends of the dated range; rounding absorbs the
// DST hour, so a 14-day chat never slips below the week threshold.
function daySpan({ minMs, maxMs }: Range): number {
  return Math.round((dayStart(maxMs) - dayStart(minMs)) / DAY_MS)
}

type Buckets = { bounds: number[]; labels: string[] }

// Bucket starts for calendar months, plus the exclusive end = start of the month
// after the last bucket. `months` is the month distance from first to last bucket,
// so the bucket count is months+1 (always >= 2 for the eligible regime).
function monthBuckets(from: Date, months: number): Buckets {
  const year = from.getFullYear()
  const month = from.getMonth()
  const count = months + 1
  const bounds: number[] = []
  for (let step = 0; step <= count; step++) bounds.push(localDate(year, month + step, 1))
  // Labels read the month back from its own boundary, so label i always describes
  // bucket i even across a year rollover.
  const labels = bounds.slice(0, count).map((boundary) => {
    const start = new Date(boundary)
    return `${SHORT_MONTHS[start.getMonth()]} ${start.getFullYear()}`
  })
  return { bounds, labels }
}

// Week bucket starts, seven calendar days apart from the first dated day, plus the
// exclusive end. Calendar steps keep every bucket seven calendar days wide.
function weekBuckets(from: Date, maxMs: number): Buckets {
  const year = from.getFullYear()
  const month = from.getMonth()
  const day = from.getDate()
  const bounds: number[] = [localDate(year, month, day)]
  // Starts grow monotonically, so the loop always passes maxMs and stops on the end.
  for (let week = 1; ; week++) {
    const start = localDate(year, month, day + WEEK_DAYS * week)
    bounds.push(start)
    if (start > maxMs) break
  }
  const labels = bounds.slice(0, -1).map((_, index) => `нед. ${index + 1}`)
  return { bounds, labels }
}

// [Query] Bucket index of a timestamp. Guard: non-finite or non-positive dates
// resolve to bucket 0 ("always included" semantics); guard: anything at or past
// the exclusive end clamps to the last bucket.
function makeBucketOf(bounds: number[], count: number): (dateMs: number) => number {
  return (dateMs: number): number => {
    if (!Number.isFinite(dateMs) || dateMs <= 0) return 0
    if (dateMs >= bounds[count]) return count - 1
    // Boundaries are strictly ascending, so the binary search is exact.
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bounds[mid] <= dateMs) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}

// Guard: ineligible chat — one bucket with collapsed boundaries, so every
// timestamp (dated, undated, out of range) resolves to bucket 0.
function singleBucket(messages: ChatExport['messages']): BucketMeta {
  return {
    count: 1,
    eligible: false,
    monthStarts: [0, 0],
    labels: [WHOLE_CHAT_LABEL],
    msgCounts: Uint32Array.of(messages.length),
    bucketOf: () => 0,
  }
}

// Shared assembly for the two eligible regimes: one linear pass over the chat
// fills the histogram that feeds both the activity strip and the slice counts.
function assemble(messages: ChatExport['messages'], { bounds, labels }: Buckets): BucketMeta {
  const count = bounds.length - 1
  // Guard: a single bucket is not a timeline; keep the short-chat shape instead.
  if (count < 2) return singleBucket(messages)
  const bucketOf = makeBucketOf(bounds, count)
  const msgCounts = new Uint32Array(count)
  for (const message of messages) msgCounts[bucketOf(message.dateMs)] += 1
  return { count, eligible: true, monthStarts: bounds, labels, msgCounts, bucketOf }
}

// [Query] Timeline bucket layout for a chat. Granularity comes from the dated span
// in local device time (local calendar edges, never Date.now), msgCounts counts
// every message exactly once, and an empty or undated chat yields one ineligible
// bucket. Deterministic for a given chat and timezone.
export function buildBucketMeta(chat: ChatExport): BucketMeta {
  const range = datedRange(chat.messages)
  // Guard: no dated message means nothing to segment — the timeline stays off.
  if (range === null) return singleBucket(chat.messages)

  const from = new Date(range.minMs)
  const months = monthIndex(range.maxMs) - monthIndex(range.minMs)
  // Guard: six or more calendar months of history is the month-bucket regime.
  if (months >= MONTHS_FOR_MONTH_BUCKETS) return assemble(chat.messages, monthBuckets(from, months))
  // Guard: fourteen calendar days (DST-safe, via day starts) is the week regime.
  if (daySpan(range) >= MIN_WEEK_DAYS) return assemble(chat.messages, weekBuckets(from, range.maxMs))
  // Guard: anything shorter is a single ineligible bucket (timeline disabled).
  return singleBucket(chat.messages)
}
