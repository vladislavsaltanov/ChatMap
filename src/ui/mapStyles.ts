import type Sigma from 'sigma'

export type CustomNodeState = { isActive: boolean }
export type CustomEdgeState = { isActive: boolean }
// lodRatio — camera.ratio: >1 = отдаление (пузыри гаснут к точкам, реф 1)
export type CustomGraphState = { hasActiveSubgraph: boolean; dimAlpha: number; focusAlpha: number; lodRatio: number }

type MapSigma = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

const DIM_NODE = '#26241f'

// LOD обзора (реф 1): при отдалении экранная величина гасится к точке, а
// «пыль» (2…7 px) плавно тает в цвет фона и лишь почти невидимой прячется
// совсем (2 px). Без этого лёгкое отдаление резко проскакивало на порогe.
const LOD_FLOOR = 2
const LOD_DUST = 7
function lodScale(sizePx: number, lodRatio: number): number {
  return lodRatio > 1 ? sizePx * Math.pow(lodRatio, -0.75) : sizePx
}
// Степень пыли узла на обзорном зуме: 0 = обычный цвет, до 1 = растворился.
// Квантуется до 0.02: каждый кадр зума иначе рожал новый ключ цвета —
// кэш mixHex рос без предела, отдаление лагало (зум-ин давал k=0 и не тратился).
function lodDust(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= LOD_DUST) return 0
  const dust = Math.max(0, Math.min(1, (LOD_DUST - s) / (LOD_DUST - LOD_FLOOR)))
  return Math.round(dust * 50) / 50
}

// mixHex интерполирует #rgb / #rrggbb / #rrggbbaa; кэш по ключу (цвета повторяются на каждый refresh)
const mixCache = new Map<string, string>()

function mixHex(from: string, to: string, t: number): string {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : Math.round(t * 1000) / 1000
  if (k === 0) return from
  const key = `${from}|${to}|${k}`
  const cached = mixCache.get(key)
  if (cached) return cached
  const parse = (hex: string): [number, number, number, number] => {
    const h = (hex.startsWith('#') ? hex.slice(1) : hex).slice(0, 8)
    const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
    return h.length <= 4 || h.length === 6
      ? [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
      : [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const [r1, g1, b1, a1] = parse(from)
  const [r2, g2, b2, a2] = parse(to)
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k)
  const hex2 = (n: number) => n.toString(16).padStart(2, '0')
  const out = `#${hex2(ch(r1, r2))}${hex2(ch(g1, g2))}${hex2(ch(b1, b2))}${hex2(ch(a1, a2))}`
  mixCache.set(key, out)
  // Предохранитель: длинная сессия с падающими по кадрам значениями
  // иначе раздувает Map до сотен тысяч строковых ключей
  if (mixCache.size > 4096) mixCache.clear()
  return out
}

export const MAP_SIGMA_SETTINGS: Partial<ReturnType<MapSigma['getSettings']>> = {
  allowInvalidContainer: true,
  itemSizesReference: 'screen',
  autoRescaleContent: 'nodes',
  stagePadding: 60,
  labelRenderedSizeThreshold: 18,
  labelDensity: 4,
  labelGridCellSize: 128,
  labelPixelSnapping: true,
  enableCameraRotation: false,
  enableCameraMouseRotation: false,
  // Глубокий зум не раздувает рёбра в «балки»: потолок на утолщение экранного масштаба
  zoomToSizeRatioFunction: (ratio: number) => Math.min(Math.sqrt(ratio), 1),
  minEdgeThickness: 1,
  // Жест приближения заметно спокойнее дефолта (1.7), отзыв «са более слабая»
  zoomingRatio: 1.15,
  doubleClickZoomingRatio: 1.35,
}

// Кегль слова внутри пузыря: влезает — вернуть размер, нет — null (пилюля).
// Ширина слова грубо: 0.6em на символ; текст должен занять ≤85% диаметра.
// Проверяем ВСЕ пузыри: раньше топы (s>=26) получали 15 без проверки и вылезали.
// Ниже 12 не жмём — мелкий текст внутри пузыря нечитаем, лучше пилюля на зуме.
function overSize(attrs: any): number | null {
  const s = (attrs.size ?? 0) as number
  if (s < 18) return null
  const len = Math.max(1, String(attrs.label ?? '').length)
  const fit = Math.floor(((s * 2 * 0.85) / (len * 0.6)) * 2) / 2
  const shrunk = Math.min(s >= 26 ? 15 : 14, fit)
  return shrunk >= 12 ? shrunk : null
}

export const MAP_SIGMA_STYLES: ReturnType<MapSigma['getStyles']> = {
  nodes: [
    {
      color: (attrs: any, _s: any, g: CustomGraphState) => {
        const dust = lodDust((attrs.size ?? 0) as number, g.lodRatio ?? 1)
        return dust > 0 ? mixHex((attrs.color as string) || DIM_NODE, DIM_NODE, dust) : attrs.color
      },
      size: (attrs: any, _s: any, g: CustomGraphState) => lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1),
      label: { attribute: 'label' },
      visibility: (attrs: any, _s: any, g: CustomGraphState) =>
        (g.dimAlpha ?? 0) === 0 && lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1) < LOD_FLOOR
          ? 'hidden'
          : 'visible', // скрывается только уже растворившаяся пыль — переход незаметен
      // Слово живёт внутри пузыря, только если влезает: иначе — пилюля справа.
      // Топы (s>=26) строятся под слово; средним кегль жмём до посадки, минимум 10.
      labelPosition: (attrs: any) => (overSize(attrs) !== null ? 'over' : 'right'),
      labelColor: (attrs: any, state: any) =>
        (state as any)?.isActive || (state as any)?.isHighlighted
          ? '#ffffff'
          : ((attrs.size ?? 0) >= 18 ? '#1c1a16' : '#f4f2ec'),
      labelSize: (attrs: any, state: any) => {
        if ((state as any)?.isActive || (state as any)?.isHighlighted) return 15
        return overSize(attrs) ?? 13.5
      },
      // NOTE: sigma parseFontString понимает только «вес семейство» — размер
      // (px) в строке ломает атлас глифов (текст схлопывается в чёрточку).
      // Кегль задаётся через labelSize выше.
      labelFont: '600 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      // На обзорном зуме подписи прячем целиком: остаются точки и нити (реф 1)
      labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
        (g.lodRatio ?? 1) > 1.15
          ? 'hidden'
          : (attrs.size ?? 0) >= 18
            ? 'visible'
            : 'auto',
      labelBackgroundColor: (attrs: any) => ((attrs.size ?? 0) < 18 ? '#242320f5' : undefined),
      labelBackgroundPadding: 5,
    },
    {
      // SAFETY: sigma passes untyped state here; keys match CustomNodeState above.
      // Затемнение неактивных: положения state isActive/isHighlighted уже заняты подсветкой.
      when: (_a, s) =>
        Boolean(
          !(s as unknown as CustomNodeState)?.isActive &&
            !(s as unknown as { isHighlighted?: boolean })?.isHighlighted,
        ),
      then: {
        color: (attrs: any, _s, g: CustomGraphState) =>
          mixHex(
            (attrs.color as string) || DIM_NODE,
            DIM_NODE,
            Math.max(g.dimAlpha * 0.82, lodDust((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
          ),
        labelColor: (attrs: any, _s, g: CustomGraphState) =>
          mixHex((attrs.size ?? 0) >= 18 ? '#1c1a16' : '#f4f2ec', '#57534a', g.dimAlpha),
        // В фокус-режиме фоновые подписи прячем совсем, иначе — грязная каша
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          g.hasActiveSubgraph ? 'hidden' : undefined,
      },
    },
    {
      whenState: 'isHighlighted',
      then: {
        depth: 'topNodes',
        size: (attrs: any, _s, g: CustomGraphState) => (attrs.size ?? 0) * (1 + 0.1 * g.focusAlpha),
        labelVisibility: 'visible',
        labelColor: '#ffffff',
        backdropVisibility: 'visible',
        backdropBorderColor: '#ffffff',
        backdropBorderWidth: (_a, _s, g: CustomGraphState) => 2.5 * g.focusAlpha,
        backdropArea: 'node',
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topNodes',
        labelVisibility: 'visible',
        labelColor: '#ffffff',
        backdropVisibility: 'visible',
        backdropBorderColor: '#f0c979',
        backdropBorderWidth: (_a, _s, g: CustomGraphState) => 2 * g.focusAlpha,
        backdropArea: 'node',
      },
    },
  ],
  edges: [
    // path/curvature — переменные программы pathCurved (объявляются primitives
    // в MapView); through spread: тип StylesDeclaration не знает о нестандартных
    // переменных. Все нити — дуги (рефы 1 и 4); кривизна — атрибут ребра.
    {
      color: { attribute: 'color' },
      size: { attribute: 'size' },
      ...({ path: 'curved', curvature: { attribute: 'curvature', defaultValue: 0.15 } } as Record<string, unknown>),
    },
    {
      // SAFETY: sigma passes untyped state/graph here; keys match types above.
      when: (_a, s) => !(s as unknown as CustomEdgeState)?.isActive,
      then: {
        color: (attrs: any, _s, g: CustomGraphState) =>
          mixHex((attrs.color as string) || '#232530', '#1b1a17', g.dimAlpha * 0.88),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topEdges',
        color: (attrs: any, _s, g: CustomGraphState) => mixHex((attrs.color as string) || '#f0c979', '#f0c979', Math.max(g.focusAlpha, 0.5)),
        size: (attrs: any, _s, g: CustomGraphState) => (attrs.size ?? 1) + (2.2 - (attrs.size ?? 1)) * g.focusAlpha,
      },
    },
  ],
}
