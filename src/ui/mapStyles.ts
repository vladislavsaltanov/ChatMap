import type Sigma from 'sigma'

export type CustomNodeState = { isActive: boolean }
export type CustomEdgeState = { isActive: boolean }
export type CustomGraphState = { hasActiveSubgraph: boolean; dimAlpha: number; focusAlpha: number }

type MapSigma = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

const DIM_NODE = '#1a1b22'

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
  return out
}

export const MAP_SIGMA_SETTINGS: Partial<ReturnType<MapSigma['getSettings']>> = {
  allowInvalidContainer: true,
  itemSizesReference: 'screen',
  autoRescaleContent: 'nodes',
  stagePadding: 60,
  labelRenderedSizeThreshold: 0,
  labelDensity: 1.2,
  labelPixelSnapping: true,
  enableCameraRotation: false,
  enableCameraMouseRotation: false,
}

export const MAP_SIGMA_STYLES: ReturnType<MapSigma['getStyles']> = {
  nodes: [
    {
      color: { attribute: 'color' },
      size: { attribute: 'size' },
      label: { attribute: 'label' },
      labelPosition: (attrs: any) => ((attrs.size ?? 0) >= 18 ? 'over' : 'right'),
      labelColor: (attrs: any, state: any) =>
        (state as any)?.isActive || (state as any)?.isHighlighted
          ? '#ffffff'
          : ((attrs.size ?? 0) >= 18 ? '#0e1015' : '#f0f3ff'),
      labelFont: '600 11.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      labelSize: 11.5,
      labelVisibility: (attrs: any) => ((attrs.size ?? 0) >= 18 ? 'visible' : 'auto'),
      labelBackgroundColor: (attrs: any) => ((attrs.size ?? 0) < 18 ? '#15171fe6' : undefined),
      labelBackgroundPadding: 3,
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
          mixHex((attrs.color as string) || DIM_NODE, DIM_NODE, g.dimAlpha * 0.82),
        labelColor: (attrs: any, _s, g: CustomGraphState) =>
          mixHex((attrs.size ?? 0) >= 18 ? '#0e1015' : '#f0f3ff', '#3b3f52', g.dimAlpha),
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
        backdropBorderColor: '#68a4ff',
        backdropBorderWidth: (_a, _s, g: CustomGraphState) => 2 * g.focusAlpha,
        backdropArea: 'node',
      },
    },
  ],
  edges: [
    { color: { attribute: 'color' }, size: { attribute: 'size' } },
    {
      // SAFETY: sigma passes untyped state/graph here; keys match types above.
      when: (_a, s) => !(s as unknown as CustomEdgeState)?.isActive,
      then: {
        color: (attrs: any, _s, g: CustomGraphState) =>
          mixHex((attrs.color as string) || '#232530', '#13141b', g.dimAlpha * 0.88),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topEdges',
        color: (attrs: any, _s, g: CustomGraphState) => mixHex((attrs.color as string) || '#68a4ff', '#68a4ff', Math.max(g.focusAlpha, 0.5)),
        size: (attrs: any, _s, g: CustomGraphState) => (attrs.size ?? 1) + (2.2 - (attrs.size ?? 1)) * g.focusAlpha,
      },
    },
  ],
}
