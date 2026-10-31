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
      // пустая строка не даёт токенов (media-only сообщения)
      if (el) parts.push({ text: el, entity: 'plain' })
    } else if (el && typeof el === 'object' && typeof (el as { text?: unknown }).text === 'string') {
      const part = el as { type?: unknown; text: string }
      if (part.text) {
        parts.push({ text: part.text, entity: (typeof part.type === 'string' && ENTITIES[part.type]) || 'other' })
      }
    }
  }
  return parts
}

type RawMessage = Record<string, unknown>

export function parse(src: string): ChatExport {
  let data: unknown
  try {
    data = JSON.parse(src)
  } catch {
    throw new ExportError(HTML_EXPORT_MSG)
  }
  const raw = data as { name?: unknown; type?: unknown; messages?: unknown } | null
  if (!raw || !Array.isArray(raw.messages)) throw new ExportError(HTML_EXPORT_MSG)

  const unknownIds = new Map<string, number>()
  const authorId = (m: RawMessage): number => {
    const rawId = m.from_id ?? m.actor_id
    const num = rawId == null ? NaN : Number(String(rawId).replace(/^-/, ''))
    if (Number.isInteger(num)) return num
    const key = String(m.from ?? m.actor ?? rawId)
    let id = unknownIds.get(key)
    if (id === undefined) {
      id = -(unknownIds.size + 1)
      unknownIds.set(key, id)
    }
    return id
  }

  const messages: Message[] = raw.messages
    .filter((m): m is RawMessage => !!m && typeof m === 'object')
    .map((m) => {
      const kind = m.type === 'service' ? 'service' : 'message'
      return {
        id: Number(m.id),
        kind,
        authorId: authorId(m),
        dateMs: Number(m.date) * 1000,
        parts: kind === 'service' ? [] : flatten(m.text),
        replyTo: typeof m.reply_to_message_id === 'number' ? m.reply_to_message_id : null,
      }
    })

  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    chatType: typeof raw.type === 'string' ? raw.type : '',
    messages,
  }
}
