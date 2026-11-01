export function nodeSize(
  count: number,
  maxCount: number,
  minCount: number = 0
): number {
  if (maxCount <= 0 || count <= 0) {
    return 4
  }
  if (minCount > 0 && maxCount > minCount) {
    // Relative log-ratio across the spectrum of visible words in the chat
    const logMin = Math.log(1 + minCount)
    const logMax = Math.log(1 + maxCount)
    const logVal = Math.log(1 + count)
    const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)))
    return 5 + 21 * t
  }
  return 4 + 22 * Math.sqrt(count / maxCount)
}

export function edgeWidth(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) {
    return 0
  }
  return Math.pow(w / wmax, 0.6)
}
