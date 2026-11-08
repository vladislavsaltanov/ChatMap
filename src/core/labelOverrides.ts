const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function parseLabelOverrides(raw: string | null): Record<string, string> {
  // Null prototype: lookups like overrides['constructor'] must miss, not hit Object.prototype.
  const out: Record<string, string> = Object.create(null)
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && !FORBIDDEN_KEYS.has(key)) out[key] = value
  }
  return out
}
