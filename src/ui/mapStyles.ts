import type Sigma from 'sigma'
import { coreFrac, fisheyePoint, labelZoomRatio, lengthFade, quadOf, renderedNodeSize, visualCoreRadius, zoomSizeRatio } from '../core/geometry'
import { DEFAULT_NODE_COLOR, NODE_LABEL_FAMILY } from './neural'

export type CustomNodeState = { isActive: boolean; released?: boolean; releasedAt?: number }
export type CustomEdgeState = { isActive: boolean }
// lodRatio — camera.ratio: >1 = zoom-out, <1 = zoom-in.
// releaseAlpha — size boost fade when deselecting an active node.
export type CustomGraphState = {
  hasActiveSubgraph: boolean
  dimAlpha: number
  focusAlpha: number
  lodRatio: number
  // Real camera ratio (unlike lodRatio it has no density bias) — for label sizing.
  cameraRatio: number
  // 0 = tiny map (no noise, keep every detail), 1 = dense map (full overview LOD).
  mapDensity: number
  releaseAlpha: number
  // Fresh-map enter animation: tweened 0 -> 1 on every render, multiplies all
  // opacities so the map fades in instead of popping.
  enterAlpha: number
  // A node is pinned: the whole ego-network keeps its labels regardless of LOD.
  pinActive: boolean
  // Photo export: hide everything outside the pinned ego-network.
  photoMode: boolean
  // Node keys whose label boxes would collide; recomputed on camera change.
  labelBlocked: Set<string>
  // Node keys whose caption overlaps ANOTHER node marker: only these get a
  // small translucent plate behind the text.
  labelBackdrop: Set<string>
  // Zoom-in fisheye: centre and reach in graph units, strength 0..1.
  // Sigma v4 accepts x/y style functions, so nodes, edges, labels and picking
  // all use the same displaced position without mutating the graph.
  fisheyeX: number
  fisheyeY: number
  fisheyeRadius: number
  fisheyeStrength: number
}

type MapSigma = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

// LOD thresholds for distant overview
const LOD_FLOOR = 2
const LOD_DUST = 7

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// Two disclosure stages, both driven by the REAL camera ratio (lodRatio keeps
// its density bias and stays responsible for labels only).
//   1. scalePhase — gradual, acts first: small bodies and edge thickness shrink.
//   2. fadePhase  — short and sharp, acts last: only then opacity removes noise.
function densityOf(g: CustomGraphState): number {
  return clamp01(g.mapDensity ?? 0)
}
function scalePhase(r: number, g: CustomGraphState): number {
  return smoothstep(0.35, 0.78, r) * (0.12 + 0.88 * densityOf(g))
}
function fadePhase(r: number, g: CustomGraphState): number {
  return smoothstep(0.82, 1.05, r) * (0.12 + 0.88 * densityOf(g))
}
function deepPhase(r: number): number { return smoothstep(1.00, 2.20, r) }

// Lines are quiet by default. They only become visible on hover (active edges
// bypass this entirely) or on a strong zoom-in. Absolute camera ratio: LOD
// stages must not resurrect hundreds of fibres on a close-up.
function edgeReveal(r: number): number {
  return 1 - smoothstep(0.42, 0.85, r)
}

// Hover and pin both focus an ego-network; the photo uses the same focus.
function egoActive(g: CustomGraphState): boolean {
  return Boolean(g.hasActiveSubgraph || g.pinActive || g.photoMode)
}

// Sigma divides every node size by zoomSizeRatio(camera.ratio). LOD decisions use
// the rendered size at the (density-biased) lodRatio; the size style itself must
// NOT scale a second time.
function lodScale(sizePx: number, lodRatio: number): number {
  return renderedNodeSize(sizePx, lodRatio)
}

// attrs.size is the layout reservation radius. The drawn body is smaller.
function drawnCore(attrs: any): number {
  return visualCoreRadius((attrs?.size ?? 0) as number)
}

// Small words are dust on the overview; landmark hubs (>= 18 px) never shrink.
function smallness(core: number): number {
  return clamp01((18 - core) / 13)
}
function lodNodeScale(core: number, g: CustomGraphState): number {
  return 1 - 0.88 * smallness(core) * scalePhase(g.cameraRatio ?? 1, g)
}

// A connection is only as bright as often it is used. The contrast steepens
// only on DEEP zoom-out; at the default overview frequency stays roughly linear.
function edgeFrequencyTier(attrs: any, g: CustomGraphState): number {
  const s = clamp01((attrs?.strength as number) ?? 0)
  return 0.22 + 0.78 * Math.pow(s, 1 + 3 * deepPhase(g.cameraRatio ?? 1))
}

// Overview composition: an edge survives only if its endpoints are still there,
// it belongs to a tract, and it is the tract's spine rather than a redundant fibre.
// Every suppressive factor is gated by fadePhase, i.e. applied AFTER the scale stage.
function edgeOpacity(attrs: any, g: CustomGraphState): number {
  const r = g.cameraRatio ?? 1
  const fade = fadePhase(r, g)
  const core = visualCoreRadius((attrs.lodSize as number) ?? 99)
  // Point 1: a link to a node dissolved by LOD dissolves with it.
  const rendered = renderedNodeSize(core, Math.max(0.05, r)) * lodNodeScale(core, g)
  const ends = 0.10 + 0.90 * smoothstep(0.6, 5.5, rendered)
  // Only the axis of a tract stays legible; dozens of stacked fibres made the
  // white slabs. They all come back on zoom-in (fade -> 0).
  const rank = Math.max(0, (attrs.rank as number) ?? 0)
  // Once a chat is big enough to have crossing corridors, the whole spine
  // treatment applies; a 30-word map keeps every fibre on close-up.
  const dense = Math.min(1, densityOf(g) * 1.6)
  // The axis of a tract stays legible at EVERY LOD, not just on the overview:
  // dozens of stacked fibres are the visual noise on a close-up, even when each
  // individual hairline is faint.
  const spine = 1 / (1 + rank * (1.1 * dense + 0.6 * fade))
  // Keep a handful of whole corridors; one stray fibre from every tract is
  // exactly the "scattered everywhere" noise the overview must not show.
  const tractRank = Math.max(0, (attrs.tractRank as number) ?? 0)
  // Only a handful of whole corridors are legible at ANY LOD. On a close-up
  // that keeps the detail view from turning back into a mesh of stray fibres.
  const skeleton = 1 - (0.85 * dense + 0.15 * fade) * smoothstep(6, 22, tractRank)
  const bundle = clamp01((attrs.bundle as number) ?? 0)
  const isolated = 1 - 0.82 * fade * (1 - bundle)
  // A barely perceptible trace in the general view, revealed on strong
  // zoom-in; hovered edges take the `isActive` style below and stay bright.
  const quiet = 0.16 + 0.62 * edgeReveal(r)
  const base = edgeFrequencyTier(attrs, g) * ends * spine * skeleton * isolated * quiet
  // A universal whisper so the general view shows the whole web as a faint
  // trace, while strong suppression still keeps it from becoming a mesh.
  const trace = 0.05 * (1 - edgeReveal(r)) * (1 - 0.7 * deepPhase(r))
  // Long weak links dissolve by geometric reach (mapview sets it); strong
  // corridors are spared. Applied to the trace too, or the mesh persists.
  const reachFade = lengthFade((attrs.reach as number) ?? 1, (attrs.strength as number) ?? 0)
  return clamp01((g.enterAlpha ?? 1) * reachFade * Math.max(base, trace))
}

// Overview dust fade degree: 0 = full brightness, up to 1 = dissolved.
// Quantized to 0.02 to avoid thrashing per-frame caches.
function lodDust(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= LOD_DUST) return 0
  const dust = Math.max(0, Math.min(1, (LOD_DUST - s) / (LOD_DUST - LOD_FLOOR)))
  return Math.round(dust * 50) / 50
}

// Zoom-resolved LOD brightness tier: large hubs bright on overview, small nodes dim background.
function lodTier(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= 8) return 1
  const ramp = s < 4 ? 0.15 : 0.15 + 0.85 * ((s - 4) / 4)
  return Math.round(ramp * 20) / 20
}

// Query: computes overall node opacity. Hubs stay fully opaque at every zoom:
// their paper disc must keep masking the edges behind it. Only small dust
// recedes; the ring itself handles hub prominence through its own alpha.
function lodNodeOpacity(sizePx: number, g: CustomGraphState): number {
  const lodRatio = g.lodRatio ?? 1
  const base = lodTier(sizePx, lodRatio) * (1 - lodDust(sizePx, lodRatio))
  const out = base * (1 - 0.94 * smallness(sizePx) * fadePhase(g.cameraRatio ?? 1, g))
  return Math.round(out * (g.enterAlpha ?? 1) * 50) / 50
}

// Query: label alpha. Words stay readable much farther out than before:
// hubs never fade, medium words survive to ratio 2.2, satellites to ~1.8.
// The kegel itself is constant in screen px (labelZoomRatio), so there is no
// "inside a shrunken bubble" penalty any more.
function labelAlphaFor(attrs: any, ratio: number): number {
  const size = drawnCore(attrs)
  let alpha: number
  if (size >= 22) {
    // Landmark hubs: always readable; only a slight soften on deep zoom-in.
    if (ratio < 0.7) {
      const hubK = clamp01((size - 22) / 30)
      const zoomDepth = clamp01((0.7 - ratio) / 0.5)
      alpha = 1 - 0.3 * hubK * Math.pow(zoomDepth, 1.2)
    } else {
      alpha = 1
    }
  } else if (ratio > 3.4) {
    alpha = 0
  } else if (size >= 12) {
    // Medium words stay legible far beyond the default overview.
    alpha = ratio <= 1.6 ? 1 : clamp01((3.4 - ratio) / 1.8)
  } else {
    // Small satellites: full strength at the default view, slow fade afterwards.
    const progress = clamp01((2.6 - ratio) / 1.4)
    const threshold = clamp01((12 - size) / 13) * 0.5
    alpha = progress <= threshold
      ? 0
      : Math.pow((progress - threshold) / (1 - threshold), 1.1)
  }
  return Math.round(alpha * 40) / 40
}

// Labels answer to the REAL camera, not the density-biased lodRatio used for
// node dust. Otherwise a 600-node chat loses every word already at 2x zoom-out.
function labelRatio(g?: CustomGraphState): number {
  return Math.max(0.05, g?.cameraRatio ?? 1)
}

// A word is only as present as its bubble. Dust nodes get a faint caption;
// the moment a node is just a little more visible, its word is at least half
// legible. Uses the same node opacity the renderer actually draws.
function labelProminence(attrs: any, g?: CustomGraphState): number {
  const state = g ?? ({} as CustomGraphState)
  const vis = lodNodeOpacity(drawnCore(attrs), state)
  // vis < 0.05 -> a whisper; from vis 0.08 the word is already >= 0.5.
  return 0.18 + 0.82 * smoothstep(0.03, 0.12, vis)
}

function labelTextAlpha(attrs: any, g?: CustomGraphState): number {
  return labelAlphaFor(attrs, labelRatio(g)) * labelProminence(attrs, g)
}

// 'auto' lets Sigma's LabelGrid arbitrate between nearby labels by node size.
// 'visible' is reserved for the focused ego-network (it forces past the grid).
function baseLabelVisibility(attrs: any, g?: CustomGraphState): 'auto' | 'hidden' {
  if (g?.labelBlocked?.has(String(attrs?.nodeId))) return 'hidden'
  return labelTextAlpha(attrs, g) > 0.02 ? 'auto' : 'hidden'
}

function baseNodeVisibility(attrs: any, g: CustomGraphState): 'visible' | 'hidden' {
  return (g.dimAlpha ?? 0) === 0 && lodScale(drawnCore(attrs), g.lodRatio ?? 1) < LOD_FLOOR
    ? 'hidden'
    : 'visible'
}

// Hover, pin and photo all force every connected node's caption past the
// LabelGrid, the alpha ramp and the dust hiding (#1).
function egoLabelVisibility(_attrs: any, g: CustomGraphState, hoverRule: 'visible' | 'auto' | 'hidden'): 'visible' | 'auto' | 'hidden' {
  return egoActive(g) ? 'visible' : hoverRule
}

// Query: converts hex color and alpha [0, 1] to rgba() string for WebGL SDF label rendering.
function hexToRgba(hex: string, alpha: number): string {
  const h = (hex.startsWith('#') ? hex.slice(1) : hex).slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  if (isNaN(n)) return `rgba(244,242,236,${alpha.toFixed(3)})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

// There is no coloured body any more: text always sits on the plate, so a
// single warm-white tint replaces the old WCAG tint-per-bubble logic.
const LABEL_LIGHT = '#f4f1e8'

// Only when a marker is directly behind the word: a small plate-colored chip
// masks the strokes without hiding the map. Sigma packs the alpha channel.
// An empty string is the "no chip" value: Sigma treats it as transparent.
const LABEL_BACKDROP = 'rgba(15, 13, 8, 0.68)'
function labelBackgroundColorFor(attrs: any, _s: any, g: CustomGraphState): string {
  return g.labelBackdrop?.has(String(attrs?.nodeId)) ? LABEL_BACKDROP : ''
}

// Dim a node by DARKENING its colour, not by lowering its alpha: translucent
// bodies let background edges show through them, which reads as visual dirt.
function dimTint(color: string | undefined | null, k: number): string {
  const h = String(color ?? '').replace('#', '').slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  if (isNaN(n)) return DEFAULT_NODE_COLOR
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

export const MAP_SIGMA_SETTINGS: Partial<ReturnType<MapSigma['getSettings']>> = {
  allowInvalidContainer: true,
  itemSizesReference: 'screen',
  autoRescale: 'once',
  autoRescaleContent: 'nodes',
  // Widescreen: a smaller frame padding lets the layout use the full width.
  stagePadding: 28,
  // Words must be readable from afar: never cull a caption just because the
  // body shrank to dust. Collision resolution is done by resolveLabelBoxes.
  labelRenderedSizeThreshold: 0,
  // ceil(density / ratio²) captions per cell: the heavier 18.5px kegel needs
  // a little more air, so the grid admits fewer words per cell than before.
  labelDensity: 5,
  labelGridCellSize: 120,
  // Analytical AA for the WebGL primitives stays on; pixel snapping is what
  // made captions look stair-stepped, so glyphs keep subpixel positions.
  antialiasNodes: true,
  antialiasEdges: true,
  labelPixelSnapping: false,
  enableCameraRotation: false,
  enableCameraMouseRotation: false,
  // Radii shrink with the graph on zoom-out: hubs never "grow" relative to it.
  zoomToSizeRatioFunction: zoomSizeRatio,
  minEdgeThickness: 1.0,
  zoomingRatio: 1.42,
  doubleClickZoomingRatio: 1.35,
  nodePickingPadding: 10,
  nodeLabelEvents: 'extend',
}

// One kegel for every word. Sigma divides it by labelZoomRatio in the shader;
// the style pre-multiplies by the same value so the caption stays at its
// designed 18.5px at every zoom level.
const LABEL_KEGEL = 18.5
function labelTextSizeFor(_attrs: any, g?: CustomGraphState): number {
  return LABEL_KEGEL * labelZoomRatio(Math.max(0.05, g?.cameraRatio ?? 1))
}

// Sigma parses `labelFont` as a CSS shorthand: weight first, then the family
// list. Obel Mono is variable (100–900): 700 for ordinary words, 900 Black for
// landmark hubs and the focused ego-network.
function labelFontFor(attrs: any): string {
  return `${drawnCore(attrs) >= 22 ? 900 : 700} ${NODE_LABEL_FAMILY}`
}
const labelFontFocus = (): string => `900 ${NODE_LABEL_FAMILY}`

// Continuous alpha keeps the LOD fade; the tint is always the plate's ink.
function labelTextColorFor(attrs: any, g?: CustomGraphState): string {
  return hexToRgba(LABEL_LIGHT, labelTextAlpha(attrs, g))
}

// While an ego-network is focused, the rest of the map keeps its words — just
// quieter. Dropping them altogether made previously readable captions vanish.
function focusedLabelColor(attrs: any, g: CustomGraphState): string {
  return hexToRgba(LABEL_LIGHT, labelTextAlpha(attrs, g) * (1 - 0.55 * (g.dimAlpha ?? 0)))
}

export const MAP_SIGMA_STYLES: ReturnType<MapSigma['getStyles']> = {
  nodes: [
    {
      // Stage 1: small bodies shrink geometrically, before any opacity change.
      // A gentle radial spread opens up the neighbourhood of the camera focus
      // on zoom-in. At ratio >= 1 `fisheyeStrength` is 0 and this is identity.
      x: (attrs: any, _s: any, g: CustomGraphState) => fisheyePoint(attrs.x, attrs.y, g).x,
      y: (attrs: any, _s: any, g: CustomGraphState) => fisheyePoint(attrs.x, attrs.y, g).y,
      size: (attrs: any, _s: any, g: CustomGraphState) =>
        quadOf(drawnCore(attrs)) * lodNodeScale(drawnCore(attrs), g),
      color: { attribute: 'color', defaultValue: DEFAULT_NODE_COLOR },
      opacity: (attrs: any, _s: any, g: CustomGraphState) => lodNodeOpacity(drawnCore(attrs), g),
      label: { attribute: 'label' },
      visibility: (attrs: any, _s: any, g: CustomGraphState) => baseNodeVisibility(attrs, g),
      // Captions always sit outside the marker and are reached by its leader.
      labelPosition: 'right',
      labelColor: (attrs: any, _s: any, g: CustomGraphState) => labelTextColorFor(attrs, g),
      labelSize: (_attrs: any, _s: any, g: CustomGraphState) => labelTextSizeFor(_attrs, g),
      labelFont: labelFontFor,
      labelVisibility: (attrs: any, _s: any, g: CustomGraphState) => baseLabelVisibility(attrs, g),
      labelBackgroundColor: labelBackgroundColorFor,
      labelBackgroundPadding: 3,
      ...({
        core: (attrs: any) => coreFrac(drawnCore(attrs)),
        glow: 1,
        phase: { attribute: 'phase', defaultValue: 0 },
        arm0: { attribute: 'arm0', defaultValue: -1 },
        arm1: { attribute: 'arm1', defaultValue: -1 },
        arm2: { attribute: 'arm2', defaultValue: -1 },
        arm3: { attribute: 'arm3', defaultValue: -1 },
        arm4: { attribute: 'arm4', defaultValue: -1 },
      } as Record<string, unknown>),
    },
    {
      when: (_a, s) =>
        Boolean(
          !(s as unknown as CustomNodeState)?.isActive &&
            !(s as unknown as { isHighlighted?: boolean })?.isHighlighted,
        ),
      then: {
        // Keep the body opaque so edges never shine through it; recede via tint.
        opacity: (attrs: any, _s, g: CustomGraphState) => lodNodeOpacity(drawnCore(attrs), g),
        color: (attrs: any, _s, g: CustomGraphState) =>
          dimTint(attrs?.color as string, 1 - 0.72 * (g.dimAlpha ?? 0)),
        labelColor: (attrs: any, _s, g: CustomGraphState) => focusedLabelColor(attrs, g),
        // Keep the captions that were readable before the focus; only dim them.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) => baseLabelVisibility(attrs, g),
      },
    },
    {
      whenState: 'isActive',
      then: {
        opacity: 1,
        // A focused ego-network keeps full-size bodies regardless of LOD.
        size: (attrs: any, _s: any, g: CustomGraphState) =>
          quadOf(drawnCore(attrs)) * (egoActive(g) ? 1 : lodNodeScale(drawnCore(attrs), g)),
        visibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoActive(g) ? 'visible' : baseNodeVisibility(attrs, g),
        // Connected neighbours keep their words on HOVER and on pin alike.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoLabelVisibility(attrs, g, baseLabelVisibility(attrs, g)),
        labelColor: () => hexToRgba(LABEL_LIGHT, 1),
        labelFont: labelFontFocus,
        ...({
          glow: (_a: any, _s: any, g: CustomGraphState) => 1 + 0.6 * (g.focusAlpha ?? 0),
        } as Record<string, unknown>),
      },
    },
    {
      whenState: 'isHighlighted',
      then: {
        // No custom depth here. Sigma reallocates the label buffer per depth
        // layer: putting the hovered word on 'topNodes' wiped every other
        // caption, and pinning only its label to 'nodes' hid it behind its own
        // body. All labels stay on the default layer and draw after the bodies.
        opacity: 1,
        // The hovered word is always captioned; the whole ego-network is too.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoLabelVisibility(
            attrs,
            g,
            lodScale(drawnCore(attrs), g.lodRatio ?? 1) >= 6 ? 'visible' : baseLabelVisibility(attrs, g),
          ),
        visibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoActive(g) ? 'visible' : baseNodeVisibility(attrs, g),
        size: (attrs: any) => quadOf(drawnCore(attrs)) * 1.12,
        labelColor: () => hexToRgba(LABEL_LIGHT, 1),
        labelFont: labelFontFocus,
        ...({
          glow: (_a: any, _s: any, g: CustomGraphState) => 1 + 1.2 * (g.focusAlpha ?? 0),
        } as Record<string, unknown>),
      },
    },
    {
      // Photo export: the ego-network is the subject, but the rest of the map
      // keeps the SAME captions as the live screenshot — just quieter.
      when: (_a, s, g: CustomGraphState) =>
        Boolean(g.photoMode) && !(s as unknown as CustomNodeState)?.isActive,
      then: {
        visibility: 'visible',
        opacity: (attrs: any, _s: any, g: CustomGraphState) => lodNodeOpacity(drawnCore(attrs), g),
        color: (attrs: any) => dimTint(attrs?.color as string, 0.45),
      },
    },
  ],
  edges: [
    {
      // Stage 1: edges thin out geometrically before their opacity is touched.
      // Transit culling (mapview sets isHidden per camera) needs an explicit
      // rule: custom stages replace the default visibility mapping.
      visibility: (_a: any, s: { isHidden?: boolean }) => (s.isHidden ? 'hidden' : 'visible'),
      size: (attrs: any, _s: any, g: CustomGraphState) =>
        ((attrs.size as number) ?? 2.4) * (1 - 0.3 * scalePhase(g.cameraRatio ?? 1, g)),
      opacity: (attrs: any, _s: any, g: CustomGraphState) => edgeOpacity(attrs, g),
      ...({
        path: 'tract',
        phase: { attribute: 'phase', defaultValue: 0 },
        bundle: { attribute: 'bundle', defaultValue: 0 },
        strength: { attribute: 'strength', defaultValue: 0 },
        rank: { attribute: 'rank', defaultValue: 0 },
        tractRank: { attribute: 'tractRank', defaultValue: 0 },
        lod: (_a: any, _s: any, g: CustomGraphState) => scalePhase(g.cameraRatio ?? 1, g),
        pulse: 0,
      } as Record<string, unknown>),
    },
    {
      when: (_a, s) => !(s as unknown as CustomEdgeState)?.isActive,
      then: {
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          edgeOpacity(attrs, g) * (1 - 0.93 * (Math.round(16 * (g.dimAlpha ?? 0)) / 16)),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topEdges',
        opacity: (attrs: any, _s, g: CustomGraphState) => {
          const tier = edgeFrequencyTier(attrs, g)
          return Math.min(1, tier + (1 - tier) * (g.focusAlpha ?? 0))
        },
        size: (attrs: any, _s, g: CustomGraphState) => ((attrs.size as number) ?? 2.4) + 0.35 * (g.focusAlpha ?? 0),
        ...({ pulse: 1 } as Record<string, unknown>),
        labelVisibility: 'hidden',
      },
    },
    {
      // Photo export: context lines remain as a barely visible trace.
      when: (_a, s, g: CustomGraphState) =>
        Boolean(g.photoMode) && !(s as unknown as CustomEdgeState)?.isActive,
      then: {
        opacity: (attrs: any, _s: any, g: CustomGraphState) =>
          Math.min(0.07, edgeOpacity(attrs, g)),
      },
    },
  ],
}
