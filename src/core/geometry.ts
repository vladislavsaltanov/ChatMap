export function nodeFitSize(
  word: string,
  count: number,
  maxCount: number,
  minCount: number = 0
): number {
  const len = Math.max(2, word ? word.length : 2)
  const fullFitRadius = Math.round(Math.max(24, len * 7.5 + 10) / 2 + 4)

  if (maxCount <= 0 || count <= 0 || maxCount <= minCount) {
    return fullFitRadius
  }

  // Relative log-ratio across visible words in the chat: t in [0, 1]
  const logMin = Math.log(1 + Math.max(0, minCount))
  const logMax = Math.log(1 + maxCount)
  const logVal = Math.log(1 + count)

  if (logMax <= logMin) {
    return fullFitRadius
  }

  const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)))

  // Scale node sizes:
  // Rare words (t < 0.3) -> small compact dots (r = 5..9) whose labels hide until zoom-in
  // Medium words (0.3 <= t < 0.7) -> moderate circles (r = 9..20)
  // Top landmark words (t >= 0.7) -> large bubbles (r = 22..45) that comfortably enclose full word text
  if (t < 0.30) {
    return Math.round(5 + 4 * (t / 0.30))
  }
  if (t < 0.70) {
    const p = (t - 0.30) / 0.40
    return Math.round(9 + 11 * p)
  }
  const p = (t - 0.70) / 0.30
  const minHub = 22
  const target = Math.max(minHub, fullFitRadius)
  return Math.round(minHub + (target - minHub) * Math.pow(p, 0.6))
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
    return '#23253030'
  }
  const t = Math.max(0, Math.min(1, Math.pow(w / maxWeight, 0.45)))
  // Smoothly grade from subtle slate to luminous blue
  const r = Math.round(36 + (180 - 36) * t)
  const g = Math.round(44 + (205 - 44) * t)
  const b = Math.round(68 + (255 - 68) * t)
  const a = Math.round((0.20 + 0.75 * t) * 255)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a.toString(16).padStart(2, '0')}`
}
