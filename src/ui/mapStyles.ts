import type Sigma from 'sigma'
import { coreFrac, quadOf } from '../core/geometry'

export type CustomNodeState = { isActive: boolean; released?: boolean; releasedAt?: number }
export type CustomEdgeState = { isActive: boolean }
// lodRatio — camera.ratio: >1 = отдаление (тела сжимаются, мелочь тает в пыль);
// releaseAlpha — затухание буста размера «уходящих» узлов при смене цели
export type CustomGraphState = { hasActiveSubgraph: boolean; dimAlpha: number; focusAlpha: number; lodRatio: number; releaseAlpha: number }

type MapSigma = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

// LOD обзора: при отдалении радиус ядра гасится к точке, а «пыль» (2…7 px)
// плавно тает прозрачностью и лишь потом скрывается совсем.
const LOD_FLOOR = 2
const LOD_DUST = 7
function lodScale(sizePx: number, lodRatio: number): number {
  return lodRatio > 1 ? sizePx * Math.pow(lodRatio, -0.75) : sizePx
}
// Степень пыли узла на обзорном зуме: 0 = полная яркость, до 1 = растворился.
// Квантуется до 0.02, чтобы не плодить значения на каждый кадр зума.
function lodDust(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= LOD_DUST) return 0
  const dust = Math.max(0, Math.min(1, (LOD_DUST - s) / (LOD_DUST - LOD_FLOOR)))
  return Math.round(dust * 50) / 50
}

// Zoom-resolved LOD = «3D проекция»: крупный хаб на общем плане яркий, мелочь
// лишь тёмным фоном; с приближением lodScale растит s и мелочь всплывает.
// Ступени квантуются до 0.05 — без дрожи на каждый кадр зума.
function lodTier(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= 8) return 1
  const ramp = s < 4 ? 0.15 : 0.15 + 0.85 * ((s - 4) / 4)
  return Math.round(ramp * 20) / 20
}

// Тело нейрона = ядро + гало (haloPx/quadOf/coreFrac — из src/core/geometry.ts).
const LABEL_LIGHT = '#eef0f7'
// Альфа для светлого текста подписи (прозрачность — не трогает атлас глифов)
function labelRgba(a: number): string {
  return `rgba(238,240,247,${a.toFixed(3)})`
}
// Кегль подписи по эффективному (после LOD) размеру ядра: влезает — посадочный,
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
  // Предохранитель: длинная сессия с падающими по кадрам значениями раздувает Map
  if (mixCache.size > 4096) mixCache.clear()
  return out
}

export const MAP_SIGMA_SETTINGS: Partial<ReturnType<MapSigma['getSettings']>> = {
  allowInvalidContainer: true,
  itemSizesReference: 'screen',
  // Нормализация экстента считается один раз после пересборки графа ('once');
  // иначе рост размера подсвеченного узла при hover/пине каждый кадр втягивает
  // размеры в extent, нормализация едет — карта сдвигается под курсором,
  // наведение срывается.
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

// Кегль, при котором слово влезает в ядро данного радиуса: вернуть кегль,
// иначе null — пилюля. Ширина слова грубо: 0.6em на символ; ≤85% диаметра.
// Ниже 12 не жмём — мелкий текст нечитаем. Размер — ЭФФЕКТИВНЫЙ (после LOD):
// на отдалении ядро ужато и подпись обязана переворачиваться в пилюлю.
function fitKegel(sizePx: number, label: string | undefined): number | null {
  if (sizePx < 18) return null
  const len = Math.max(1, String(label ?? '').length)
  const fit = Math.floor(((sizePx * 2 * 0.85) / (len * 0.6)) * 2) / 2
  const shrunk = Math.min(sizePx >= 26 ? 15 : 14, fit)
  return shrunk >= 12 ? shrunk : null
}
// Влезает ли текст в ядро при ТЕКУЩЕМ LOD (эффективный размер)
function labelFits(attrs: any, lodRatio: number | undefined): boolean {
  const eff = lodScale((attrs.size ?? 0) as number, lodRatio ?? 1)
  return fitKegel(eff, attrs.label) !== null
}

// Кастомные переменные шейдеров (см. neural.ts): типы стилей их не знают
const NODE_VARS = (extra: Record<string, unknown> = {}) => extra as Record<string, unknown>

export const MAP_SIGMA_STYLES: ReturnType<MapSigma['getStyles']> = {
  nodes: [
    {
      // Квад = ядро + гало; ядро — attrs.size (с LOD)
      size: (attrs: any, _s: any, g: CustomGraphState) => quadOf(lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
      color: { attribute: 'color', defaultValue: '#9db0d8' },
      // Пыль тает прозрачностью + zoom-resolved tier: мелочь — фон, хабы — свет
      opacity: (attrs: any, _s: any, g: CustomGraphState) =>
        lodTier((attrs.size ?? 0) as number, g.lodRatio ?? 1) * (1 - lodDust((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
      label: { attribute: 'label' },
      visibility: (attrs: any, _s: any, g: CustomGraphState) =>
        (g.dimAlpha ?? 0) === 0 && lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1) < LOD_FLOOR
          ? 'hidden'
          : 'visible', // скрывается только уже растворившаяся пыль — переход незаметен
      // Слово живёт внутри ядра, только если влезает ПРИ ТЕКУЩЕМ LOD:
      // на отдалении ядра ужаты и подписи переворачиваются в пилюли справа.
      labelPosition: (attrs: any, _s: any, g: CustomGraphState) => (labelFits(attrs, g?.lodRatio) ? 'over' : 'right'),
      // Ядро — тёмное стекло / яркая звезда: текст всегда светлый
      labelColor: LABEL_LIGHT,
      labelSize: (attrs: any, state: any, g: CustomGraphState) => {
        if ((state as any)?.isActive || (state as any)?.isHighlighted) return 15
        if (!labelFits(attrs, g?.lodRatio)) return 13.5
        return fitKegel(lodScale((attrs.size ?? 0) as number, g?.lodRatio ?? 1), attrs.label) ?? 13.5
      },
      // NOTE: sigma parseFontString понимает только «вес семейство» — размер
      // (px) в строке ломает атлас глифов (текст схлопывается в чёрточку).
      // Кегль задаётся через labelSize выше.
      labelFont: '600 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      // На обзорном зуме подписи прячем целиком: остаются огни и нити
      labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
        (g.lodRatio ?? 1) > 1.15
          ? 'hidden'
          : (attrs.size ?? 0) >= 18
            ? 'visible'
            : 'auto',
      // Плашка пилюли — цвет бумаги, полупрозрачная: нити под текстом гаснут, но не пропадают
      labelBackgroundColor: (attrs: any, _s: any, g: CustomGraphState) =>
        labelFits(attrs, g?.lodRatio) ? undefined : '#1d1c19b3',
      labelBackgroundPadding: 3,
      ...NODE_VARS({
        core: (attrs: any, _s: any, g: CustomGraphState) => coreFrac(lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
        glow: 1,
        phase: { attribute: 'phase', defaultValue: 0 },
        // Углы дендритов к сильнейшим соседям (в оборотах 0…1; -1 — нет отростка)
        arm0: { attribute: 'arm0', defaultValue: -1 },
        arm1: { attribute: 'arm1', defaultValue: -1 },
        arm2: { attribute: 'arm2', defaultValue: -1 },
        arm3: { attribute: 'arm3', defaultValue: -1 },
        arm4: { attribute: 'arm4', defaultValue: -1 },
      }),
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
          if (!st?.released || !st.releasedAt) return quadOf(base)
          const boost = Math.max(0, 1 - (performance.now() - st.releasedAt) / 170)
          return quadOf(base * (1 + 0.1 * (Math.round(4 * boost) / 4)))
        },
        // Не в фокусе — гаснет почти в ноль (ступени 1/16 против дрожи кэшей)
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          (1 - lodDust((attrs.size ?? 0) as number, g.lodRatio ?? 1)) * (1 - 0.88 * (Math.round(16 * (g.dimAlpha ?? 0)) / 16)),
        labelColor: (_a: any, _s, g: CustomGraphState) => mixHex(LABEL_LIGHT, '#57534a', g.dimAlpha),
        // В фокус-режиме фоновые подписи прячем совсем, иначе — грязная каша
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          g.hasActiveSubgraph ? 'hidden' : undefined,
        ...NODE_VARS({
          core: (attrs: any, s: any, g: CustomGraphState) => {
            const st = s as CustomNodeState
            const base = lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)
            if (!st?.released || !st.releasedAt) return coreFrac(base)
            const boost = Math.max(0, 1 - (performance.now() - st.releasedAt) / 170)
            return coreFrac(base * (1 + 0.1 * (Math.round(4 * boost) / 4)))
          },
        }),
      },
    },
    {
      whenState: 'isHighlighted',
      then: {
        depth: 'topNodes',
        // Рост тела подсветки ступенями (4 шага на весь твин): каждая ступень —
        // один репаш геометрии узла. LOD-масштаб сохраняем: подсвеченные на
        // отдалении не должны всплывать полноразмерными.
        size: (attrs: any, _s, g: CustomGraphState) =>
          quadOf(lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1) * (1 + 0.1 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))),
        opacity: 1,
        // Текст живёт в той же анимации: прозрачность непрерывно (rgba альфа
        // — не трогает атлас глифов), кегль — 4 ступени (иначе атлас растёт
        // на каждый промежуточный размер). Скрытие происходит при alpha≈0.
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          (g.focusAlpha ?? 0) > 0.02 ? 'visible' : 'auto',
        labelColor: (_a: any, _s: any, g: CustomGraphState) => labelRgba(Math.round(40 * (g.focusAlpha ?? 0)) / 40),
        labelSize: (attrs: any, _s, g: CustomGraphState) =>
          Math.round(((labelTextSizeFor(attrs, g)) * (0.7 + 0.3 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))) * 2) / 2,
        ...NODE_VARS({
          core: (attrs: any, _s: any, g: CustomGraphState) => {
            const c = lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1) * (1 + 0.1 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))
            return coreFrac(c)
          },
          // Центр фокуса вспыхивает: гало раздувается вместе с твином
          glow: (_a: any, _s: any, g: CustomGraphState) => 1 + 1.1 * (g.focusAlpha ?? 0),
        }),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topNodes',
        // Активные соседи пина: размер только через lodScale (см. isHighlighted)
        size: (attrs: any, _s, g: CustomGraphState) => quadOf(lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
        opacity: 1,
        // Соседи хаба: тот же fade+scale текста, что и у центра подсветки
        labelVisibility: (_a: any, _s: any, g: CustomGraphState) =>
          (g.focusAlpha ?? 0) > 0.02 ? 'visible' : 'auto',
        labelColor: (_a: any, _s: any, g: CustomGraphState) => labelRgba(Math.round(40 * (g.focusAlpha ?? 0)) / 40),
        labelSize: (attrs: any, _s, g: CustomGraphState) =>
          Math.round(((labelTextSizeFor(attrs, g)) * (0.7 + 0.3 * (Math.round(4 * (g.focusAlpha ?? 0)) / 4))) * 2) / 2,
        ...NODE_VARS({
          core: (attrs: any, _s: any, g: CustomGraphState) => coreFrac(lodScale((attrs.size ?? 0) as number, g.lodRatio ?? 1)),
          glow: (_a: any, _s: any, g: CustomGraphState) => 1 + 0.45 * (g.focusAlpha ?? 0),
        }),
      },
    },
  ],
  edges: [
    // path/curvature/pulse/phase — переменные программы (neural.ts); через spread:
    // тип StylesDeclaration не знает о нестандартных переменных.
    // Нить светится сама (layerAxon) — цвет берёт у узлов-концов; здесь только
    // толщина (ширина свечения), прозрачность по весу связи и кривизна.
    {
      size: { attribute: 'size', defaultValue: 2.4 },
      // Нити мелкой пары — фоном (lodSize = мин. размер концов, кладёт mapview)
      opacity: (attrs: any, _s: any, g: CustomGraphState) =>
        ((attrs.alpha as number) ?? 0.2) * lodTier((attrs.lodSize as number) ?? 99, g.lodRatio ?? 1),
      ...({
        path: 'curved',
        curvature: { attribute: 'curvature', defaultValue: 0.15 },
        phase: { attribute: 'phase', defaultValue: 0 },
        pulse: 0,
      } as Record<string, unknown>),
    },
    {
      // SAFETY: sigma passes untyped state/graph here; keys match types above.
      when: (_a, s) => !(s as unknown as CustomEdgeState)?.isActive,
      then: {
        // Фоновые нити в фокус-режиме почти гаснут (ступени 1/16)
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          ((attrs.alpha as number) ?? 0.2) *
          lodTier((attrs.lodSize as number) ?? 99, g.lodRatio ?? 1) *
          (1 - 0.93 * (Math.round(16 * (g.dimAlpha ?? 0)) / 16)),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topEdges',
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          Math.min(1, ((attrs.alpha as number) ?? 0.2) + (0.95 - ((attrs.alpha as number) ?? 0.2)) * (g.focusAlpha ?? 0)),
        size: (attrs: any, _s, g: CustomGraphState) => ((attrs.size as number) ?? 2.4) + 2.2 * (g.focusAlpha ?? 0),
        // Импульс бежит по связям подсвеченного подграфа
        ...({ pulse: 1 } as Record<string, unknown>),
        // Подписи рёбер не используются, но правило держим коротким
        labelVisibility: 'hidden',
      },
    },
  ],
}
