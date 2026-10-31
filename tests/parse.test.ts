import { describe, expect, it } from 'vitest'
import fixture from './fixtures/sample-export.json'
import { ExportError, flatten, parse } from '../src/core/parse'

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
})
