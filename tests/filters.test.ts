import { describe, expect, it } from 'vitest'
import { isStopword, matchesLaugh, matchesMat } from '../src/core/filters'

describe('filters', () => {
  describe('isStopword', () => {
    it('detects common RU and EN stopwords', () => {
      expect(isStopword('если')).toBe(true)
      expect(isStopword('и')).toBe(true)
      expect(isStopword('the')).toBe(true)
      expect(isStopword('all')).toBe(true)
    })

    it('does not reject non-stopwords', () => {
      expect(isStopword('мем')).toBe(false)
      expect(isStopword('дизайн')).toBe(false)
      expect(isStopword('graph')).toBe(false)
    })
  })

  describe('matchesMat', () => {
    it('matches profanity forms and roots (§6.6)', () => {
      expect(matchesMat('сука', [])).toBe(true)
      expect(matchesMat('блять', [])).toBe(true)
      expect(matchesMat('нахуй', [])).toBe(true)
      expect(matchesMat('ебать', [])).toBe(true)
      expect(matchesMat('ебёшь', [])).toBe(true)
    })

    it('does not false-positive on innocent words (§6.6)', () => {
      expect(matchesMat('ахать', [])).toBe(false)
      expect(matchesMat('сукно', [])).toBe(false)
    })

    it('supports custom roots with hyphen suffix', () => {
      expect(matchesMat('нушая', ['нуш-'])).toBe(true)
      expect(matchesMat('другое', ['нуш-'])).toBe(false)
    })

    it('supports custom literal words without hyphen', () => {
      expect(matchesMat('редиска', ['редиска'])).toBe(true)
      expect(matchesMat('морковь', ['редиска'])).toBe(false)
    })
  })

  describe('matchesLaugh', () => {
    it('matches laughing patterns and literals (§6.6)', () => {
      expect(matchesLaugh('хахах', [])).toBe(true)
      expect(matchesLaugh('ахах', [])).toBe(true)
      expect(matchesLaugh('хАхА', [])).toBe(true)
      expect(matchesLaugh('лол', [])).toBe(true)
      expect(matchesLaugh('lmao', [])).toBe(true)
      expect(matchesLaugh('kek', [])).toBe(true)
      expect(matchesLaugh('rofl', [])).toBe(true)
    })

    it('does not false-positive on non-laugh words (§6.6)', () => {
      expect(matchesLaugh('ахалай', [])).toBe(false)
      expect(matchesLaugh('хахатка', [])).toBe(false)
      expect(matchesLaugh('механика', [])).toBe(false)
    })

    it('supports custom laugh items', () => {
      expect(matchesLaugh('хехей', ['хех-'])).toBe(true)
      expect(matchesLaugh('базинга', ['базинга'])).toBe(true)
      expect(matchesLaugh('обычное', ['базинга'])).toBe(false)
    })
  })
})
