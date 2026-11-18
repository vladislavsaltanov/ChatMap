const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Single choke point for the forbidden list: parse and save must agree, or a
// rename saved under '__proto__' silently vanishes on the next load.
export function isOverridableKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key)
}

export type LabelOverrideChange = [key: string, label: string | null]

// Pure Query: parse once, apply all changes, serialize once.
// Null when any key is forbidden, so save and clear agree with parse.
export function applyLabelOverrides(raw: string | null, changes: LabelOverrideChange[]): string | null {
  for (const [key] of changes) {
    if (!isOverridableKey(key)) return null
  }
  const overrides = parseLabelOverrides(raw)
  for (const [key, label] of changes) {
    if (label === null) delete overrides[key]
    else overrides[key] = label
  }
  return JSON.stringify(overrides)
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
