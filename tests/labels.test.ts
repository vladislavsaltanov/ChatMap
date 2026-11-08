import { describe, expect, it } from 'vitest'
import { resolveLabelBackdrops, resolveLabelBoxes, type LabelBox, type LabelCircle } from '../src/core/labels'

const box = (id: string, x: number, y: number, w: number, h: number, priority: number): LabelBox => ({
  id, x, y, w, h, priority,
})
const circle = (id: string, x: number, y: number, r: number): LabelCircle => ({ id, x, y, r })

describe('resolveLabelBoxes', () => {
  it('keeps the higher-priority label when boxes overlap', () => {
    const blocked = resolveLabelBoxes([
      box('small', 100, 100, 40, 14, 5),
      box('hub', 108, 100, 40, 14, 40),
    ])
    expect([...blocked]).toEqual(['small'])
  })

  it('keeps all labels that do not overlap', () => {
    const blocked = resolveLabelBoxes([
      box('a', 0, 0, 40, 14, 10),
      box('b', 300, 300, 40, 14, 10),
      box('c', 0, 300, 40, 14, 10),
    ])
    expect(blocked.size).toBe(0)
  })

  it('padding enforces extra separation, not just non-intersection', () => {
    // Boxes are 2px apart edge-to-edge; with padding 4 they must not both win.
    const boxes = [box('a', 0, 0, 40, 14, 10), box('b', 42, 0, 40, 14, 9)]
    expect(resolveLabelBoxes(boxes, 0).size).toBe(0)
    expect(resolveLabelBoxes(boxes, 4).size).toBe(1)
  })

  it('is deterministic on equal priorities (id tie-break)', () => {
    const boxes = [box('z', 0, 0, 40, 14, 10), box('a', 5, 0, 40, 14, 10)]
    expect([...resolveLabelBoxes(boxes)]).toEqual(['z'])
    expect([...resolveLabelBoxes([...boxes].reverse())]).toEqual(['z'])
  })

  it('handles wide boxes spanning several cells', () => {
    const boxes = [box('wide', 0, 0, 400, 20, 10), box('near', 210, 0, 40, 14, 9)]
    expect(resolveLabelBoxes(boxes).has('near')).toBe(true)
  })

  it('empty input yields no blocked labels', () => {
    expect(resolveLabelBoxes([]).size).toBe(0)
  })
})

describe('resolveLabelBackdrops', () => {
  it('marks a caption when another node marker is behind it', () => {
    const boxes = [box('a', 100, 100, 60, 20, 10)]
    const circles = [circle('b', 110, 100, 18)]
    expect([...resolveLabelBackdrops(boxes, circles)]).toEqual(['a'])
  })

  it('ignores the caption own marker', () => {
    const boxes = [box('a', 100, 100, 60, 20, 10)]
    const circles = [circle('a', 100, 100, 18)]
    expect(resolveLabelBackdrops(boxes, circles).size).toBe(0)
  })

  it('ignores distant markers', () => {
    const boxes = [box('a', 0, 0, 60, 20, 10)]
    const circles = [circle('b', 400, 400, 18)]
    expect(resolveLabelBackdrops(boxes, circles).size).toBe(0)
  })

  it('padding catches a marker just outside the text box', () => {
    const boxes = [box('a', 100, 100, 60, 20, 10)]
    const circles = [circle('b', 151, 100, 18)]
    expect(resolveLabelBackdrops(boxes, circles, 0).size).toBe(0)
    expect(resolveLabelBackdrops(boxes, circles, 6).size).toBe(1)
  })

  it('finds markers behind wide captions spanning several cells', () => {
    const boxes = [box('wide', 0, 0, 400, 20, 10)]
    const circles = [circle('b', 210, 0, 18)]
    expect(resolveLabelBackdrops(boxes, circles).has('wide')).toBe(true)
  })

  it('empty input yields no backdrops', () => {
    expect(resolveLabelBackdrops([], []).size).toBe(0)
  })
})
