export function nodeFitSize(
  word: string,
  count: number,
  maxCount: number,
  minCount: number = 0
): number {
  const len = Math.max(2, word ? word.length : 2)
  // Text width estimation at ~11px font size with clean breathing room
  const textWidth = Math.max(24, len * 7.5 + 8)
  const fitRadius = Math.round(textWidth / 2 + 5)

  if (maxCount <= 0 || count <= 0 || maxCount <= minCount) {
    return fitRadius
  }

  // Relative log-ratio across visible words
  const logMin = Math.log(1 + Math.max(0, minCount))
  const logMax = Math.log(1 + maxCount)
  const logVal = Math.log(1 + count)

  if (logMax <= logMin) {
    return fitRadius
  }

  const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)))
  // Scale radius up to +45% for high-frequency landmark words
  return Math.round(fitRadius * (1 + 0.45 * t))
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

export function edgeColor(w: number, maxWeight: number): string {
  if (maxWeight <= 0 || w <= 0) {
    return '#23253040'
  }
  const t = Math.max(0, Math.min(1, Math.pow(w / maxWeight, 0.5)))
  // Smoothly grade from subtle slate to luminous blue
  const r = Math.round(45 + (180 - 45) * t)
  const g = Math.round(50 + (205 - 50) * t)
  const b = Math.round(70 + (255 - 70) * t)
  const a = Math.round((0.25 + 0.7 * t) * 255)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a.toString(16).padStart(2, '0')}`
}
