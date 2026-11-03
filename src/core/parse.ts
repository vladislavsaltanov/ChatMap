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

export function flatten(text: unknown): TextPart[] {
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
        parts.push(...flatten(obj.text))
      }
    }
  }
  return parts
}

type RawMessage = Record<string, unknown>

function parseDateMs(m: RawMessage): number {
  if (m.date_unixtime != null) {
    const num = Number(m.date_unixtime)
    if (!Number.isNaN(num) && num > 0) return num * 1000
  }
  if (typeof m.date === 'number') {
    return m.date * 1000
  }
  if (typeof m.date === 'string') {
    if (/^\d+$/.test(m.date)) {
      return Number(m.date) * 1000
    }
    const parsed = Date.parse(m.date)
    if (!Number.isNaN(parsed)) return parsed
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
      const cleanStr = String(rawId).replace(/^(?:(?:user|channel|chat)_?|-)+/i, '')
      const num = Number(cleanStr)
      if (Number.isInteger(num) && num > 0) {
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
      // Number(null) and Number('') are 0, Number(true) is 1: those would collide with real ids
      const numId = typeof m.id === 'number' || typeof m.id === 'string' ? Number(m.id) : NaN
      return {
        id: Number.isInteger(numId) && numId > 0 ? numId : -(idx + 1),
        kind,
        authorId: authorId(m),
        dateMs: parseDateMs(m),
        parts: kind === 'service' ? [] : flatten(m.text),
        replyTo: typeof m.reply_to_message_id === 'number' ? m.reply_to_message_id : null,
      }
    })

  return {
    name: chatName,
    chatType: chatType,
    messages,
    authors: authorNames,
  }
}
