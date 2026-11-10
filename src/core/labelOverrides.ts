const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Single choke point for the forbidden list: parse and save must agree, or a
// rename saved under '__proto__' silently vanishes on the next load.
export function isOverridableKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key)
}

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
    if (typeof value === 'string' && isOverridableKey(key)) out[key] = value
  }
  return out
}
