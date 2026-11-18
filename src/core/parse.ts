import type { ChatExport, Entity, Message, TextPart } from './types'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

const HTML_EXPORT_MSG =
  'похоже, это HTML-экспорт. Включи «Машиночитаемый экспорт (JSON)» в настройках экспорта'

const ENTITIES: Record<string, Entity> = { plain: 'plain', link: 'link', code: 'code', mention: 'mention' }

// Crafted exports can nest text arrays thousands deep: cap the recursion so a
// malicious file gets a clean ExportError instead of a RangeError stack overflow.
export const MAX_FLATTEN_DEPTH = 100

export function flatten(text: unknown, depth = 0): TextPart[] {
  if (depth >= MAX_FLATTEN_DEPTH) {
    throw new ExportError('Слишком глубокая вложенность текста. Повреждённый экспорт?')
  }
  const parts: TextPart[] = []
  for (const el of Array.isArray(text) ? text : [text]) {
    if (typeof el === 'string') {
      if (el) parts.push({ text: el, entity: 'plain' })
    } else if (el && typeof el === 'object') {
      const obj = el as { type?: unknown; text?: unknown }
      if (typeof obj.text === 'string') {
        if (obj.text) {
          parts.push({
            text: obj.text,
            entity: (typeof obj.type === 'string' && ENTITIES[obj.type]) || 'other',
          })
        }
      } else if (Array.isArray(obj.text)) {
        parts.push(...flatten(obj.text, depth + 1))
      }
    }
  }
  return parts
}

type RawMessage = Record<string, unknown>

// Boundary parser: Telegram JSON stores ids/dates as numbers or digit strings,
// but hostile exports use exponents ("1e3"), Infinity, or booleans. Accept only
// finite positives and /^\d+$/ strings so "1e3" never becomes id 1000.
export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value)
    return Number.isSafeInteger(num) && num > 0 ? num : null
  }
  return null
}

// Same strictness for timestamps: Number("1e309") is Infinity, which would
// poison sorting and layout math with a non-finite dateMs.
export function parseFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? num : null
  }
  return null
}

function parseDateMs(m: RawMessage): number {
  if (m.date_unixtime != null) {
    const num = parseFinitePositiveNumber(m.date_unixtime)
    if (num !== null) return num * 1000
  }
  if (m.date != null) {
    // ISO strings stay on Date.parse; digit-only strings and numbers go
    // through the finite-positive gate.
    if (typeof m.date === 'string' && !/^\d+$/.test(m.date)) {
      const parsed = Date.parse(m.date)
      if (!Number.isNaN(parsed)) return parsed
    } else {
      const num = parseFinitePositiveNumber(m.date)
      if (num !== null) return num * 1000
    }
  }
  return 0
}

export function parse(src: string): ChatExport {
  const cleanSrc = src.replace(/^\uFEFF/, '').trim()
  if (cleanSrc.startsWith('<')) {
    throw new ExportError(HTML_EXPORT_MSG)
  }

  let data: unknown
  try {
    data = JSON.parse(cleanSrc)
  } catch (err: unknown) {
    if (cleanSrc.includes('<html') || cleanSrc.includes('<!DOCTYPE')) {
      throw new ExportError(HTML_EXPORT_MSG)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ExportError(`Ошибка разбора JSON: ${msg}`)
  }

  let rawMessages: unknown[] | null = null
  let chatName = ''
  let chatType = ''
  let warn: string | undefined

  if (Array.isArray(data)) {
    rawMessages = data
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    chatName = typeof obj.name === 'string' ? obj.name : ''
    chatType = typeof obj.type === 'string' ? obj.type : ''

    if (Array.isArray(obj.messages)) {
      rawMessages = obj.messages
    } else if (obj.chats && typeof obj.chats === 'object' && Array.isArray((obj.chats as { list?: unknown }).list)) {
      const list = (obj.chats as { list: unknown[] }).list
      const candidateChats = list.filter(
        (c): c is Record<string, unknown> =>
          Boolean(c && typeof c === 'object' && Array.isArray((c as { messages?: unknown }).messages) &&
          (c as { messages: unknown[] }).messages.length > 0)
      )
      if (candidateChats.length > 0) {
        candidateChats.sort((a, b) => ((b.messages as unknown[]).length) - ((a.messages as unknown[]).length))
        rawMessages = candidateChats[0].messages as unknown[]
        chatName = typeof candidateChats[0].name === 'string' ? candidateChats[0].name : chatName
        chatType = typeof candidateChats[0].type === 'string' ? candidateChats[0].type : chatType
        if (candidateChats.length > 1) {
          warn = `Найдено чатов: ${candidateChats.length}. Выбран «${chatName || 'Без названия'}» (${rawMessages.length} сообщ.).`
        }
      }
    } else if (obj.chat && typeof obj.chat === 'object' && Array.isArray((obj.chat as { messages?: unknown }).messages)) {
      const sub = obj.chat as Record<string, unknown>
      rawMessages = sub.messages as unknown[]
      chatName = typeof sub.name === 'string' ? sub.name : chatName
      chatType = typeof sub.type === 'string' ? sub.type : chatType
    }
  }

  if (!rawMessages || !Array.isArray(rawMessages)) {
    throw new ExportError(HTML_EXPORT_MSG)
  }

  const authorNames = new Map<number, string>()
  const unknownIds = new Map<string, number>()

  const authorId = (m: RawMessage): number => {
    const rawId = m.from_id ?? m.actor_id
    if (rawId != null) {
      // Same strict gate as message ids: bare Number() turns crafted "1e3"
      // (and hex "0x10") into numeric author ids and merges distinct voices.
      const cleanStr = String(rawId).replace(/^(?:(?:user|channel|chat)_?|-)+/i, '')
      const num = parsePositiveInt(cleanStr)
      if (num !== null) {
        if (!authorNames.has(num)) {
          const name = String(m.from ?? m.actor ?? `Участник ${num}`)
          authorNames.set(num, name)
        }
        return num
      }
    }
    const key = String(m.from ?? m.actor ?? rawId ?? 'unknown')
    let id = unknownIds.get(key)
    if (id === undefined) {
      id = -(unknownIds.size + 1)
      unknownIds.set(key, id)
      authorNames.set(id, key)
    }
    return id
  }

  const messages: Message[] = rawMessages
    .filter((m): m is RawMessage => !!m && typeof m === 'object')
    .map((m, idx) => {
      const kind = m.type === 'service' ? 'service' : 'message'
      // Null/""/"bad"/"1e3" fall back to -(idx+1): no NaN, no 0, no exponent ids.
      const parsedId = parsePositiveInt(m.id)
      return {
        id: parsedId ?? -(idx + 1),
        kind,
        authorId: authorId(m),
        dateMs: parseDateMs(m),
        parts: kind === 'service' ? [] : flatten(m.text),
        replyTo: parsePositiveInt(m.reply_to_message_id),
      }
    })

  return {
    name: chatName,
    chatType: chatType,
    messages,
    authors: authorNames,
    ...(warn ? { warn } : {}),
  }
}
