const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// Single pass: each & is escaped once; the entities emitted here are never re-escaped.
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ENTITIES[ch])
}
