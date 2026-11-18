import { describe, expect, it } from 'vitest'
import { buildBucketMeta } from '../src/core/timebuckets'
import type { ChatExport, Message } from '../src/core/types'

// Local noon keeps fixtures away from DST-shifted midnights: bucket boundaries
// are also local, so these timestamps resolve identically in every timezone.
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month, day, hour).getTime()

const dated = (rows: Array<{ at: number; n: number; kind?: Message['kind'] }>): Message[] => {
  let id = 1
  return rows.flatMap(({ at: dateMs, n, kind = 'message' }) =>
    Array.from({ length: n }, (): Message => ({ id: id++, kind, authorId: 1, dateMs, parts: [], replyTo: null })))
}

const chat = (messages: Message[]): ChatExport => ({ name: 'synthetic', chatType: 'personal', messages })

// Jan 15 .. Aug 15 2024: 8 calendar months, so month buckets are mandatory.
const eightMonths = (): ChatExport => chat(dated([
  { at: at(2024, 0, 15), n: 2 },
  { at: at(2024, 0, 20), n: 1, kind: 'service' },
  { at: at(2024, 1, 10), n: 1 },
  { at: at(2024, 2, 5), n: 2 },
  { at: at(2024, 4, 10), n: 0 },
  { at: at(2024, 6, 20), n: 1 },
  { at: at(2024, 7, 15), n: 2 },
]))

describe('buildBucketMeta: месячная гранулярность', () => {
  it('(a) 8 месяцев истории → календарные месяцы, метки и msgCounts по ручному подсчёту', () => {
    const meta = buildBucketMeta(eightMonths())

    expect(meta.count).toBe(8)
    expect(meta.eligible).toBe(true)
    expect(meta.labels).toEqual([
      'янв 2024', 'фев 2024', 'мар 2024', 'апр 2024',
      'май 2024', 'июн 2024', 'июл 2024', 'авг 2024',
    ])
    // Hand count: service messages count like regular ones; Apr/May/Jun are
    // empty and the lone summer row (at(2024, 6, 20)) is JULY - month index 6.
    expect(Array.from(meta.msgCounts)).toEqual([3, 1, 2, 0, 0, 0, 1, 2])

    // Границы: count+1 штук, каждая — локальное 1-е число своего месяца.
    expect(meta.monthStarts).toHaveLength(meta.count + 1)
    meta.monthStarts.forEach((boundary, i) => {
      const day = new Date(boundary)
      expect(day.getDate()).toBe(1)
      expect(day.getMonth()).toBe(i)
      expect(day.getFullYear()).toBe(2024)
    })

    expect(meta.bucketOf(at(2024, 0, 1))).toBe(0)
    expect(meta.bucketOf(at(2024, 2, 15))).toBe(2)
    expect(meta.bucketOf(at(2024, 7, 31, 23))).toBe(7)
  })
})

describe('buildBucketMeta: недельная гранулярность', () => {
  it('(b) 20 дней истории → недельные бакеты «нед. N» от первого дня чата', () => {
    const meta = buildBucketMeta(chat(dated([
      { at: at(2024, 1, 5), n: 2 },
      { at: at(2024, 1, 11, 23), n: 1 },
      { at: at(2024, 1, 12), n: 1 },
      { at: at(2024, 1, 18), n: 2 },
      { at: at(2024, 1, 19), n: 1 },
      { at: at(2024, 1, 25), n: 2 },
    ])))

    expect(meta.eligible).toBe(true)
    expect(meta.count).toBe(3)
    expect(meta.labels).toEqual(['нед. 1', 'нед. 2', 'нед. 3'])
    expect(Array.from(meta.msgCounts)).toEqual([3, 3, 3])
    // Якорь недель — локальная полночь первого дня чата, шаг 7 календарных дней.
    expect(meta.monthStarts).toEqual([
      new Date(2024, 1, 5).getTime(),
      new Date(2024, 1, 12).getTime(),
      new Date(2024, 1, 19).getTime(),
      new Date(2024, 1, 26).getTime(),
    ])
    expect(meta.bucketOf(at(2024, 1, 11, 23))).toBe(0)
    expect(meta.bucketOf(at(2024, 1, 18))).toBe(1)
    expect(meta.bucketOf(at(2024, 1, 25))).toBe(2)
  })
})

describe('buildBucketMeta: вырожденные случаи', () => {
  it('(c) 5 дней истории → один бакет, лента выключена', () => {
    const meta = buildBucketMeta(chat(dated([
      { at: at(2024, 2, 10), n: 2 },
      { at: at(2024, 2, 14), n: 1 },
    ])))

    expect(meta.count).toBe(1)
    expect(meta.eligible).toBe(false)
    expect(meta.monthStarts).toEqual([0, 0])
    expect(meta.labels).toEqual(['весь чат'])
    expect(Array.from(meta.msgCounts)).toEqual([3])
    expect(meta.bucketOf(at(2024, 2, 14))).toBe(0)
  })

  it('(e) пустой чат → count=1, eligible=false, [0,0], msgCounts=[0]', () => {
    const meta = buildBucketMeta(chat([]))

    expect(meta.count).toBe(1)
    expect(meta.eligible).toBe(false)
    expect(meta.monthStarts).toEqual([0, 0])
    expect(meta.labels).toEqual(['весь чат'])
    expect(Array.from(meta.msgCounts)).toEqual([0])
    expect(meta.bucketOf(0)).toBe(0)
  })

  it('чат без датированных сообщений → один бакет, все сообщения в нём', () => {
    const meta = buildBucketMeta(chat(dated([{ at: 0, n: 4 }])))

    expect(meta.count).toBe(1)
    expect(meta.eligible).toBe(false)
    expect(Array.from(meta.msgCounts)).toEqual([4])
  })
})

// Guard-даты: отсутствие даты не выбрасывает сообщение из среза (бакет 0),
// а слишком поздняя дата не создаёт несуществующий бакет.
describe('buildBucketMeta: guard-даты', () => {
  it('(d) 0/отрицательные/NaN → бакет 0, дата за концом клампится в последний', () => {
    const meta = buildBucketMeta(eightMonths())

    expect(meta.bucketOf(0)).toBe(0)
    expect(meta.bucketOf(-5)).toBe(0)
    expect(meta.bucketOf(Number.NaN)).toBe(0)
    expect(meta.bucketOf(at(2030, 0, 15))).toBe(meta.count - 1)
  })

  it('сообщения без даты попадают в бакет 0 действующего таймлайна', () => {
    const messages = dated([
      { at: at(2024, 0, 15), n: 2 },
      { at: at(2024, 7, 15), n: 1 },
      { at: 0, n: 3 },
      { at: -1, n: 1, kind: 'service' },
    ])
    const meta = buildBucketMeta(chat(messages))

    expect(meta.count).toBe(8)
    expect(meta.msgCounts[0]).toBe(6)
    expect(meta.msgCounts[7]).toBe(1)
    expect(meta.msgCounts.reduce((sum, n) => sum + n, 0)).toBe(messages.length)
  })
})
