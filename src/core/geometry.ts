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

export function edgeWidth(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) {
    return 0
  }
  return Math.pow(w / wmax, 0.6)
}

export function edgeColor(w: number, maxWeight: number, tint = '#e8e2d6'): string {
  // Нить в цвете голоса: слабая — призрак бумаги, сильная — светится.
  // Бумага — приближение --paper (oklch 0.16), чтобы слабое растворялось в фоне.
  const PAPER: [number, number, number] = [36, 34, 29]
  const h = (tint.startsWith('#') ? tint.slice(1) : tint).slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  const tcol: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const mix = (k: number): [number, number, number] =>
    [PAPER[0] + (tcol[0] - PAPER[0]) * k, PAPER[1] + (tcol[1] - PAPER[1]) * k, PAPER[2] + (tcol[2] - PAPER[2]) * k].map((v) =>
      Math.round(v),
    ) as [number, number, number]
  const hex = (r: number, g: number, b: number, a: number): string =>
    `#${[r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  if (maxWeight <= 0 || w <= 0) {
    const [r, g, b] = mix(0.25)
    return hex(r, g, b, Math.round(0.1 * 255))
  }
  const t = Math.max(0, Math.min(1, Math.pow(w / maxWeight, 0.45)))
  const [r, g, b] = mix(0.25 + 0.75 * t)
  return hex(r, g, b, Math.round((0.1 + 0.55 * t) * 255))
}

// Прозрачность светящейся нити по весу связи: слабые — туман, сильные — яркие жилы.
export function edgeAlpha(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) return 0.1
  const t = Math.max(0, Math.min(1, Math.pow(w / wmax, 0.5)))
  return 0.1 + 0.5 * t
}

// Тело нейрона = ядро (радиус = size) + гало. Квад узла в sigma — ядро + гало;
// шейдер знает долю ядра через coreFrac. Тоже самое жило в mapStyles — теперь
// единый источник, чтобы layout (Task 1/6) и стили считали одинаково.
export function haloPx(core: number): number {
  return Math.min(44, Math.max(12, core * 0.8 + 9))
}

export function quadOf(core: number): number {
  return core + haloPx(core)
}

export function coreFrac(core: number): number {
  return core / quadOf(core)
}
