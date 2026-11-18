import { describe, expect, it } from 'vitest'
import fixture from './fixtures/sample-export.json'
import { ExportError, MAX_FLATTEN_DEPTH, flatten, parse, parseFinitePositiveNumber, parsePositiveInt } from '../src/core/parse'

const src = JSON.stringify(fixture)
const HTML_ERR =
  'похоже, это HTML-экспорт. Включи «Машиночитаемый экспорт (JSON)» в настройках экспорта'
const byId = (id: number) => parse(src).messages.find((m) => m.id === id)!

describe('flatten', () => {
  it('(a) массив сущностей → TextPart[] по порядку с классами', () => {
    expect(
      flatten(['code: ', { type: 'code', text: 'cat DESIGN.md' }, { type: 'link', text: 'https://example.com' }]),
    ).toEqual([
      { text: 'code: ', entity: 'plain' },
      { text: 'cat DESIGN.md', entity: 'code' },
      { text: 'https://example.com', entity: 'link' },
    ])
    expect(flatten('привет')).toEqual([{ text: 'привет', entity: 'plain' }])
    expect(flatten([{ type: 'bold', text: 'жирный' }, { type: 'italic', text: 'курсив' }])).toEqual([
      { text: 'жирный', entity: 'other' },
      { text: 'курсив', entity: 'other' },
    ])
  })

  it('(a) вложенность глубже лимита → ExportError, а не RangeError', () => {
    let nested: unknown = 'дно'
    for (let i = 0; i <= MAX_FLATTEN_DEPTH; i++) nested = [{ type: 'bold', text: nested }]
    expect(() => flatten(nested)).toThrowError(ExportError)
  })

  it('(a) фикстура: code и link сохранены по порядку', () => {
    expect(byId(108).parts).toEqual([
      { text: 'code: ', entity: 'plain' },
      { text: 'cat DESIGN.md', entity: 'code' },
      { text: 'https://example.com', entity: 'link' },
    ])
    expect(byId(114).parts[1]).toEqual({ text: '@durov', entity: 'mention' })
  })
})

describe('parse', () => {
  it('(b) service без текста, media-only с пустыми parts', () => {
    expect(byId(110).kind).toBe('service')
    expect(byId(110).parts).toEqual([])
    expect(byId(109).parts).toEqual([])
  })

  it('(c) HTML-экспорт → ExportError с инструкцией', () => {
    expect(() => parse('<html><body>чат</body></html>')).toThrowError(ExportError)
    expect(() => parse('{"name":"x","type":"personal_chat"}')).toThrowError(HTML_ERR)
    expect(() => parse('<html><body>чат</body></html>')).toThrowError(HTML_ERR)
  })

  it('(d) author у service берётся из actor_id', () => {
    expect(byId(110).authorId).toBe(111)
  })

  it('(e) from_id "-123" → 123, неизвестный автор стабилен', () => {
    expect(byId(113).authorId).toBe(123)
    expect(byId(111).authorId).toBe(byId(112).authorId)
    expect(byId(111).authorId).not.toBe(111)
    expect(byId(111).authorId).not.toBe(222)
    expect(byId(111).authorId).not.toBe(123)
  })

  it('(f) date в unix-секундах → dateMs', () => {
    const chat = parse(src)
    expect(chat.name).toBe('Синтетический чат')
    expect(chat.chatType).toBe('personal_chat')
    expect(byId(101).dateMs).toBe(fixture.messages[0].date * 1000)
    expect(chat.messages).toHaveLength(fixture.messages.length)
  })

  it('(g) replyTo распознан, без reply → null', () => {
    expect(byId(108).replyTo).toBe(101)
    expect(byId(101).replyTo).toBeNull()
  })

  it('(h) парсит JSON с UTF-8 BOM, user-префиксами в from_id и строковыми ISO-датами', () => {
    const rawWithBom = '\uFEFF' + JSON.stringify({
      name: 'BOM Chat',
      type: 'personal_chat',
      messages: [
        { id: 1, type: 'message', date: '2023-10-25T14:30:00', from: 'Иван', from_id: 'user999', text: 'привет мир' },
        { id: 2, type: 'message', date_unixtime: '1698244260', from: 'Мария', from_id: 'user888', text: 'и тебе привет' },
      ],
    })
    const parsed = parse(rawWithBom)
    expect(parsed.name).toBe('BOM Chat')
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].authorId).toBe(999)
    expect(parsed.authors?.get(999)).toBe('Иван')
    expect(parsed.messages[0].dateMs).toBe(Date.parse('2023-10-25T14:30:00'))
    expect(parsed.messages[1].dateMs).toBe(1698244260000)
  })

  it('(i) парсит полный экспорт аккаунта с chats.list', () => {
    const accountExport = JSON.stringify({
      about: 'Telegram export',
      chats: {
        list: [
          { name: 'Пустой', messages: [] },
          {
            name: 'Главный чат',
            type: 'personal_chat',
            messages: [
              { id: 10, type: 'message', date: 1700000000, from: 'Алекс', from_id: 'user777', text: 'сообщение' },
            ],
          },
        ],
      },
    })
    const parsed = parse(accountExport)
    expect(parsed.name).toBe('Главный чат')
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0].authorId).toBe(777)
  })

  it('(j) id: отсутствует / null / "" / "bad" → -(idx+1), не NaN и не 0; числовая строка сохраняется', () => {
    const chat = parse(JSON.stringify({
      messages: [
        { type: 'message', from_id: 'user1', text: 'a' },
        { id: 'bad', type: 'message', from_id: 'user1', text: 'b' },
        { id: null, type: 'message', from_id: 'user1', text: 'c' },
        { id: '', type: 'message', from_id: 'user1', text: 'd' },
        { id: '42', type: 'message', from_id: 'user1', text: 'e' },
      ],
    }))
    expect(chat.messages.map((m) => m.id)).toEqual([-1, -2, -3, -4, 42])
  })

  it('(k) from_id с префиксом и подчёркиванием: user_123, channel_45, chat_789 → 123, 45, 789', () => {
    const chat = parse(JSON.stringify({
      messages: [
        { id: 1, type: 'message', from_id: 'user_123', text: 'a' },
        { id: 2, type: 'message', from_id: 'channel_45', text: 'b' },
        { id: 3, type: 'message', from_id: 'chat_789', text: 'c' },
      ],
    }))
    expect(chat.messages.map((m) => m.authorId)).toEqual([123, 45, 789])
  })

  it('(l) аккаунт с одним непустым чатом (и пустым) → warn не задан', () => {
    const parsed = parse(JSON.stringify({
      chats: {
        list: [
          { name: 'Пустой', messages: [] },
          {
            name: 'Единственный',
            type: 'personal_chat',
            messages: [{ id: 1, type: 'message', date: 1700000000, from: 'Алекс', from_id: 'user777', text: 'привет' }],
          },
        ],
      },
    }))
    expect(parsed.name).toBe('Единственный')
    expect(parsed.warn).toBeUndefined()
    expect(parsed).not.toHaveProperty('warn')
  })

  it('(m) аккаунт с 2+ непустыми чатами → выбран самый большой, warn называет чат, число чатов и сообщений', () => {
    const msgs = (n: number, from: string) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'message', date: 1700000000 + i, from, from_id: 'user777', text: `сообщение ${i}` }))
    const parsed = parse(JSON.stringify({
      chats: {
        list: [
          { name: 'Пустой', messages: [] },
          { name: 'Маленький', type: 'personal_chat', messages: msgs(2, 'Алекс') },
          { name: 'Большой', type: 'personal_chat', messages: msgs(5, 'Мария') },
          { name: 'Средний', type: 'personal_chat', messages: msgs(3, 'Алекс') },
        ],
      },
    }))
    expect(parsed.name).toBe('Большой')
    expect(parsed.messages).toHaveLength(5)
    expect(parsed.warn).toContain('Большой')
    expect(parsed.warn).toContain('Найдено чатов: 3')
    expect(parsed.warn).toContain('(5 сообщ.)')
  })

  it('(n) ровно 2 непустых чата → warn с числом 2; чат без имени → «Без названия»', () => {
    const msgs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'message', from: 'Алекс', from_id: 'user777', text: `сообщение ${i}` }))
    const parsed = parse(JSON.stringify({
      chats: { list: [{ messages: msgs(1) }, { messages: msgs(2) }] },
    }))
    expect(parsed.name).toBe('')
    expect(parsed.warn).toContain('Найдено чатов: 2')
    expect(parsed.warn).toContain('«Без названия»')
    expect(parsed.warn).toContain('(2 сообщ.)')
  })

  it('(o) одиночный экспорт → warn не задан', () => {
    expect(parse(src).warn).toBeUndefined()
    expect(parse(src)).not.toHaveProperty('warn')
  })

  it('(p) exponent id и infinity-даты отвергаются, digit-строки принимаются', () => {
    expect(parsePositiveInt('1e3')).toBeNull()
    expect(parsePositiveInt('123')).toBe(123)
    expect(parseFinitePositiveNumber('1e309')).toBeNull()
    expect(parseFinitePositiveNumber(Infinity)).toBeNull()
  })

  it('(q) строковый reply id сохраняется', () => {
    const chat = parse(JSON.stringify({ messages: [{ id: 1, reply_to_message_id: '123', text: 'x' }] }))
    expect(chat.messages[0].replyTo).toBe(123)
  })
})
