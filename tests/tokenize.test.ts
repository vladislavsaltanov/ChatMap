import { describe, expect, it } from 'vitest'
import { tokenize } from '../src/core/tokenize'

describe('tokenize', () => {
  it('splits sentence into lowercase plain tokens', () => {
    expect(tokenize([{ text: 'Привет, как дела?', entity: 'plain' }])).toEqual([
      [
        { word: 'привет', cls: 'plain' },
        { word: 'как', cls: 'plain' },
        { word: 'дела', cls: 'plain' },
      ],
    ])
  })

  it('normalizes ё to е and lowercases', () => {
    expect(tokenize([{ text: 'ёж', entity: 'plain' }])).toEqual([
      [{ word: 'еж', cls: 'plain' }],
    ])
  })

  it('assigns tech class for code parts', () => {
    expect(tokenize([{ text: 'DOM', entity: 'code' }])).toEqual([
      [{ word: 'dom', cls: 'tech' }],
    ])
  })

  it('assigns digits class for standalone numbers', () => {
    expect(tokenize([{ text: '2026', entity: 'plain' }])).toEqual([
      [{ word: '2026', cls: 'digits' }],
    ])
  })

  it('splits space-separated numbers into separate tokens', () => {
    expect(tokenize([{ text: '20 000', entity: 'plain' }])).toEqual([
      [
        { word: '20', cls: 'digits' },
        { word: '000', cls: 'digits' },
      ],
    ])
  })

  it('splits units by delimiters into separate arrays', () => {
    expect(tokenize([{ text: 'один. Два\nтри', entity: 'plain' }])).toEqual([
      [{ word: 'один', cls: 'plain' }],
      [{ word: 'два', cls: 'plain' }],
      [{ word: 'три', cls: 'plain' }],
    ])
  })

  it('handles empty parts or delimiter-only text without empty units', () => {
    expect(tokenize([])).toEqual([])
    expect(tokenize([{ text: '... \n\n ; !', entity: 'plain' }])).toEqual([])
  })
})
