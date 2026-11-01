export function nodeSize(count: number, maxCount: number): number {
  if (maxCount <= 0 || count <= 0) {
    return 4
  }
  return 4 + 22 * Math.sqrt(count / maxCount)
}

export function edgeWidth(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) {
    return 0
  }
  return Math.pow(w / wmax, 0.6)
}
