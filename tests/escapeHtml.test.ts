import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../src/core/escapeHtml'

describe('escapeHtml', () => {
  it('leaves plain Russian text unchanged', () => {
    expect(escapeHtml('Привет, мир')).toBe('Привет, мир')
  })

  it('escapes each special character to its entity', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  it('escapes an apostrophe inside a name and keeps the letters', () => {
    expect(escapeHtml("Ирина О'Нил")).toBe('Ирина О&#39;Нил')
  })

  it('escapes & once, so entity-looking text is shown literally', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('neutralises a tag injection payload', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('neutralises an attribute breakout payload', () => {
    expect(escapeHtml('" autofocus onfocus="alert(1)')).toBe('&quot; autofocus onfocus=&quot;alert(1)')
  })

  it('never leaves a raw tag or quote character in the output', () => {
    const payloads = ['<img src=x onerror=alert(1)>', '" autofocus onfocus="alert(1)', "' onmouseover='x'"]
    for (const payload of payloads) {
      expect(escapeHtml(payload)).not.toMatch(/[<>"']/)
    }
  })
})
