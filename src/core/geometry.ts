export function nodeFitSize(
  word: string,
  count: number,
  maxCount: number,
  minCount: number = 0
): number {
  const len = Math.max(2, word ? word.length : 2)
  // Text width estimation at 11-12px font size with comfortable padding
  const textWidth = Math.max(24, len * 7.2 + 8)
  const fitRadius = Math.round(textWidth / 2 + 4)

  if (maxCount <= 0 || count <= 0 || maxCount <= minCount) {
    return fitRadius
  }

  // Relative log-ratio across the spectrum of visible words
  const logMin = Math.log(1 + Math.max(0, minCount))
  const logMax = Math.log(1 + maxCount)
  const logVal = Math.log(1 + count)

  if (logMax <= logMin) {
    return fitRadius
  }

  const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)))
  // Grow radius by up to +50% for more frequent words
  return Math.round(fitRadius * (1 + 0.5 * t))
}

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
