import type Sigma from 'sigma'

export type CustomNodeState = { isActive: boolean; released?: boolean; releasedAt?: number }
export type CustomEdgeState = { isActive: boolean }
// lodRatio — camera.ratio: >1 = отдаление (пузыри гаснут к точкам, реф 1);
// releaseAlpha — затухание буста размера «уходящих» узлов при смене цели
export type CustomGraphState = { hasActiveSubgraph: boolean; dimAlpha: number; focusAlpha: number; lodRatio: number; releaseAlpha: number }

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

// Контраст подписи против цвета пузыря: тёмный текст на светлых голосах,
// светлый — на тёмных. По относительной светимости WCAG, не по размеру узла
// (пользовательские цвета авторов бывают любыми). Кэш по цвету.
const tintCache = new Map<string, string>()
const LABEL_DARK = '#1c1a16'
const LABEL_LIGHT = '#f4f2ec'
function labelTintFor(color: string | undefined | null): string {
  const key = String(color ?? '').slice(0, 7)
  const cached = tintCache.get(key)
  if (cached) return cached
  const h = (key.startsWith('#') ? key.slice(1) : key).slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  const ch = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const lum = 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
  const out = lum > 0.35 ? LABEL_DARK : LABEL_LIGHT
  tintCache.set(key, out)
  return out
}
// Альфа для УЖЕ выбранного цвета текста. Не тинтовать повторно: первый
// аргумент — финальный чёрный/белый от labelTextFor; повторный labelTintFor
// инвертировал их (белый на светлом пузыре, тёмный на тёмном чипе).
function labelRgba(color: string | undefined | null, a: number): string {
  const key = String(color ?? LABEL_LIGHT)
  const h = (key.startsWith('#') ? key.slice(1) : key).slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`
}
// Кегль подписи по эффективному (после LOD) размеру: влезает — посадочный,
// не влезает — пилюльный 13.5
function labelTextSizeFor(attrs: any, g?: CustomGraphState): number {
  if (!labelFits(attrs, g?.lodRatio)) return 13.5
  return fitKegel(lodScale((attrs.size ?? 0) as number, g?.lodRatio ?? 1), attrs.label) ?? 13.5
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
  // Нормализация экстента считается один раз после пересборки графа ('once');
  // иначе рост размера подсвеченного узла при hover/пине каждый кадр втягивает
  // размеры в extent, нормализация едет — карта сдвигается под курсором,
  // наведение срывается: текст пропадает и пузырь рывком возвращается.
  autoRescale: 'once',
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
  // Жест приближения: отзыв «жест посильнее» (1.42), всё ещё мягче дефолта 1.7
  zoomingRatio: 1.42,
  doubleClickZoomingRatio: 1.35,
}

// Кегль, при котором слово влезает в пузырь данного размера: вернуть кегль,
// иначе null — пилюля. Ширина слова грубо: 0.6em на символ; ≤85% диаметра.
// Ниже 12 не жмём — мелкий текст нечитаем. Размер — ЭФФЕКТИВНЫЙ (после LOD):
// на отдалении пузырь ужат и подпись обязана переворачиваться в пилюлю.
function fitKegel(sizePx: number, label: string | undefined): number | null {
  if (sizePx < 18) return null
  const len = Math.max(1, String(label ?? '').length)
  const fit = Math.floor(((sizePx * 2 * 0.85) / (len * 0.6)) * 2) / 2
  const shrunk = Math.min(sizePx >= 26 ? 15 : 14, fit)
  return shrunk >= 12 ? shrunk : null
}
function overSize(attrs: any): number | null {
  return fitKegel((attrs.size ?? 0) as number, attrs.label)
}
// Влезает ли текст в пузырь при ТЕКУЩЕМ LOD (эффективный размер)
function labelFits(attrs: any, lodRatio: number | undefined): boolean {
  const eff = lodScale((attrs.size ?? 0) as number, lodRatio ?? 1)
  return fitKegel(eff, attrs.label) !== null
}
// Цвет текста по МЕСТУ отрисовки: внутри пузыря (влезает при текущем LOD) —
// контраст к пузырю; пилюля — всегда светлая на тёмной плашке
function labelTextFor(attrs: any, g?: CustomGraphState): string {
  return labelFits(attrs, g?.lodRatio) ? labelTintFor(attrs.color as string) : LABEL_LIGHT
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
      // Слово живёт внутри пузыря, только если влезает ПРИ ТЕКУЩЕМ LOD:
      // на отдалении пузыри ужаты и подписи переворачиваются в светлые пилюли.
      labelPosition: (attrs: any, _s: any, g: CustomGraphState) => (labelFits(attrs, g?.lodRatio) ? 'over' : 'right'),
      // Черный/белый по светимости пузыря, когда текст внутри;
      // пилюля всегда светлая на тёмной плашке
      labelColor: (attrs: any, _state: any, g: CustomGraphState) => labelTextFor(attrs, g),
      labelSize: (attrs: any, state: any, g: CustomGraphState) => {
        if ((state as any)?.isActive || (state as any)?.isHighlighted) return 15
        if (!labelFits(attrs, g?.lodRatio)) return 13.5
        return fitKegel(lodScale((attrs.size ?? 0) as number, g?.lodRatio ?? 1), attrs.label) ?? 13.5
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
      // Плашка пилюли темнее бумаги и почти непрозрачная — чип читается на фоне
      // карты; рисуется всегда, когда текст НЕ влез в пузырь (в т.ч. из-за LOD)
      labelBackgroundColor: (attrs: any, _s: any, g: CustomGraphState) =>
        labelFits(attrs, g?.lodRatio) ? undefined : '#141311f2',
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
        // «Уходящий» узел (смена цели подсветки) плавно сдаёт буст размера по
        // СВОЕЙ метке времени. ВАЖНО: правило матчит весь фон карты, поэтому
        // размер обязан идти через lodScale — сырой attrs.size затирал бы
        // LOD-затухание базового правила и разносил фон при отдалении.
        size: (attrs: any, s: any, g: CustomGraphState) => {
          const st = s as CustomNodeState
          const base = lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)
          if (!st?.released || !st.releasedAt) return base
          const boost = Math.max(0, 1 - (performance.now() - st.releasedAt) / 170)
          return base * (1 + 0.1 * (Math.round(4 * boost) / 4))
        },
        color: (attrs: any, _s, g: CustomGraphState) =>
          mixHex(
            (attrs.color as string) || DIM_NODE,
            DIM_NODE,
            Math.max((Math.round(16 * (g.dimAlpha ?? 0)) / 16) * 0.82, lodDust((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
          ),
        labelColor: (attrs: any, _s, g: CustomGraphState) =>
          mixHex(labelTextFor(attrs, g), '#57534a', g.dimAlpha),
        // В фокус-режиме фоновые подписи прячем совсем, иначе — грязная каша
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          g.hasActiveSubgraph ? 'hidden' : undefined,
      },
    },
    {
      whenState: 'isHighlighted',
      then: {
        depth: 'topNodes',
        // Рост пузыря подсветки ступенями (4 шага на весь твiн): каждая ступень —
        // один репаш геометрии узла, иначе каждый кадр пина перегружал программу.
        // Соседи растут тем же твiном focusAlpha; LOD-масштаб сохраняем —
        // подсвеченные на отдалении не должны всплывать полноразмерными.
        size: (attrs: any, _s, g: CustomGraphState) =>
          lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1) * (1 + 0.1 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4)),
        // released после затухания здесь может досидеть: победа правила по
        // порядку — isHighlighted перекрывает not-active затухание своим ростом
        // Текст живёт в той же анимации: прозрачность непрерывно (rgba альфа
        // — не трогает атлас глифов), кегль — 4 ступени (иначе атлас растёт
        // на каждый промежуточный размер). Скрытие происходит при alpha≈0.
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          (g.focusAlpha ?? 0) > 0.02 ? 'visible' : 'auto',
        // Fade в цвет контраста места отрисовки (пузырь/пилюля по LOD)
        labelColor: (attrs: any, _s: any, g: CustomGraphState) =>
          labelRgba(labelTextFor(attrs, g), Math.round(40 * (g.focusAlpha ?? 0)) / 40),
        labelSize: (attrs: any, _s, g: CustomGraphState) =>
          Math.round(((labelTextSizeFor(attrs, g)) * (0.7 + 0.3 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))) * 2) / 2,
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
        // Активные соседи пина: размер только через lodScale (см. isHighlighted)
        size: (attrs: any, _s, g: CustomGraphState) => lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1),
        // Соседи хаба: тот же fade+scale текста, что и у центра подсветки
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          (g.focusAlpha ?? 0) > 0.02 ? 'visible' : 'auto',
        labelColor: (attrs: any, _s: any, g: CustomGraphState) =>
          labelRgba(labelTextFor(attrs, g), Math.round(40 * (g.focusAlpha ?? 0)) / 40),
        labelSize: (attrs: any, _s, g: CustomGraphState) =>
          Math.round(((labelTextSizeFor(attrs, g)) * (0.7 + 0.3 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))) * 2) / 2,
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
        // Соседи хаба: тот же fade+scale текста, что и у центра подсветки
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          (g.focusAlpha ?? 0) > 0.02 ? 'visible' : 'auto',
        labelColor: (_a: any, _s: any, g: CustomGraphState) =>
          `rgba(255,255,255,${(Math.round(40 * (g.focusAlpha ?? 0)) / 40).toFixed(3)})`,
        labelSize: (attrs: any, _s, g: CustomGraphState) =>
          Math.round(((overSize(attrs) ?? 13.5) * (0.7 + 0.3 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))) * 2) / 2,
      },
    },
  ],
}
