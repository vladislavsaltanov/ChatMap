// Pure style math: numbers in, numbers out. No Sigma, no DOM, no camera objects.
// mapStyles.ts keeps only thin adapters (attrs/state extraction) over these kernels,
// so vitest can pin the rendering law on src/core without a renderer.
import {
  fanCoreFrac,
  lengthFade,
  lodPresence,
  LOD_GONE_PX,
  renderedNodeSize,
  weakEdgeCeiling,
} from './geometry'

export { fanCoreFrac, weakEdgeCeiling };

// LOD thresholds for distant overview. Spray dots stay visible (7, not 9):
// dissolved dust would erase the very spray the figure is made of.
// Mirrors the private threshold in geometry.ts (not exported there).
const LOD_DUST = 7

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// Fresh-map entrance: the whole map fades in over ENTER_TOTAL, every word on its
// own offset, so the figure assembles as a wave. Timings must match MapView.render().
const ENTER_MS = 900
const ENTER_OFFSET_MS = 900
export const ENTER_TOTAL_MS = ENTER_MS + ENTER_OFFSET_MS

// Default when the map has not published its own bar yet (tiny fixtures, first frame).
export const DEFAULT_LABEL_CORE_MIN = 6

// Share of a dense map driving the LOD stages. 0 = tiny map, 1 = dense overview.
export function densityOf(mapDensity: number): number {
  return clamp01(mapDensity ?? 0)
}

// Two disclosure stages, both driven by the REAL camera ratio.
// scalePhase acts first (bodies/edges shrink), fadePhase acts last (opacity removes noise).
export function scalePhase(ratio: number, mapDensity: number): number {
  return smoothstep(0.35, 0.78, ratio) * (0.12 + 0.88 * densityOf(mapDensity))
}
export function fadePhase(ratio: number, mapDensity: number): number {
  return smoothstep(0.82, 1.05, ratio) * (0.12 + 0.88 * densityOf(mapDensity))
}
export function deepPhase(ratio: number): number {
  return smoothstep(1.0, 2.2, ratio)
}

// Lines are quiet by default; visible on hover or strong zoom-in.
export function edgeReveal(ratio: number): number {
  return 1 - smoothstep(0.42, 0.85, ratio)
}

// A connection is only as bright as often it is used. Contrast steepens only on
// DEEP zoom-out; at the default overview frequency stays roughly linear.
export function edgeFrequencyTier(strength: number, cameraRatio: number): number {
  const s = clamp01(strength ?? 0)
  return 0.22 + 0.78 * Math.pow(s, 1 + 3 * deepPhase(cameraRatio ?? 1))
}

export type EdgeOpacityInput = {
  strength: number
  // Drawn body radius (px) of the WEAKER endpoint, after visualCoreRadius.
  core: number
  // Geometric reach: edge length vs the map median (zoom-independent).
  reach: number
  rank: number
  tractRank: number
  bundle: number
  cameraRatio: number
  lodRatio: number
  mapDensity: number
  enterAlpha: number
}

// Overview composition: an edge survives only if its endpoints are still there,
// it belongs to a tract, and it is the tract's spine. Every suppressive factor
// is gated by fadePhase, i.e. applied AFTER the scale stage.
export function edgeOpacity(input: EdgeOpacityInput): number {
  const r = input.cameraRatio ?? 1
  const mapDensity = input.mapDensity ?? 0
  const fade = fadePhase(r, mapDensity)
  const core = input.core
  const reach = input.reach ?? 1
  // An edge is exactly as present as its WEAKER endpoint: sharing the node's own
  // LOD alpha (not a second size guess) killed lines pointing at dissolved bodies.
  const ends = bodyAlpha(core, input.lodRatio ?? 1, r)
  // A link whose weaker end is a small word never becomes an overview corridor:
  // the cap holds at 0.16 (weakEdgeCeiling) for r >= 1 and lifts toward 1 on
  // zoom-in, so the small word's links return instead of staying overview dust.
  const ceiling = weakEdgeCeiling(core)
  const closeK = 1 - smoothstep(0.45, 1.0, r)
  // Zoom-in priority goes to links between visible neighbours; a trans-frame
  // hairline keeps its overview dissolve. Overview (closeK = 0) is untouched.
  const localK = closeK * (1 - smoothstep(1.2, 2.8, reach))
  const liftedCeiling = ceiling + (1 - ceiling) * localK
  // Only the axis of a tract stays legible; stacked fibres made white slabs.
  const rank = Math.max(0, input.rank ?? 0)
  // Fibre suppression is an OVERVIEW treatment; zoomed into a chunk the eye needs
  // the axons. Transit culling is what keeps the close-up from meshing.
  const suppressGate = (0.25 + 0.75 * smoothstep(0.3, 0.85, r)) * smoothstep(0.22, 0.6, r)
  const dense = Math.min(1, densityOf(mapDensity) * 1.6) * suppressGate
  // Suppression dialed to a whisper so fans read as fans, not single lines.
  const spine = 1 / (1 + rank * (0.35 * dense + 0.3 * fade))
  const tractRank = Math.max(0, input.tractRank ?? 0)
  const skeleton = 1 - (0.6 * dense + 0.15 * fade) * smoothstep(10, 40, tractRank)
  const bundle = clamp01(input.bundle ?? 0)
  const isolated = 1 - 0.82 * fade * (1 - bundle)
  const quiet = 0.3 + 0.55 * edgeReveal(r)
  // Zoom-in: every PRESENT link stays visible. The floor is rank-tiered and
  // answers to the same quiet/isolated gates, so the overview dissolve is never
  // bypassed — only spine/skeleton suppression lifts.
  const freqTier = edgeFrequencyTier(input.strength ?? 0, r)
  const closeFloor = (0.09 + 0.13 * freqTier) * localK
  const base = Math.max(freqTier * ends * spine * skeleton * isolated * quiet, closeFloor * ends * isolated * quiet)
  // The web itself is the figure: every fibre gets its whisper, gated only by
  // endpoint presence. Mesh insurance: ends, the weak cap, skeleton, reachFade.
  const es = clamp01(input.strength ?? 0)
  const trace = 0.07 * (1 - edgeReveal(r)) * (1 - 0.7 * deepPhase(r))
  // A lone wire across a void is figure, not noise: showing it cannot rebuild
  // the mesh, hiding it strands satellites as debris.
  const loneWire = 0.1 * smoothstep(2.0, 3.2, reach) * (1 - smoothstep(0.1, 0.4, es)) * ends
  // Long weak links dissolve by geometric reach; strong corridors are spared.
  const reachFade = lengthFade(reach, input.strength ?? 0)
  const closeReachFade = reachFade + (1 - reachFade) * localK
  // The weak-link cap is a MAX alpha, not a factor: capping an already quiet line
  // twice would erase the connection the cap is supposed to mark as weak.
  return Math.min(
    clamp01((input.enterAlpha ?? 1) * closeReachFade * Math.max(base, trace * ends) + loneWire),
    liftedCeiling,
  )
}

// LOD alpha of a BODY before the entrance tween — the single number both the node
// style and its edges answer to. 0 means the body does not exist.
export function bodyAlpha(core: number, lodRatio: number, cameraRatio: number): number {
  const lod = lodRatio ?? 1
  const alpha =
    lodTier(core, lod) * (1 - lodDust(core, lod)) * lodPresence(renderedNodeSize(core, cameraRatio ?? 1))
  // Dead zone at the first visible step (opacity is quantised to 0.02): without
  // it a 1% body still counted as alive and kept a 1% line alive with it.
  return alpha < 0.02 ? 0 : alpha
}

// Overview dust fade degree: 0 = full brightness, 1 = dissolved. Ends exactly
// where lodPresence reaches zero, so brightness and existence never disagree.
// Quantized to 0.02 to avoid thrashing per-frame caches.
export function lodDust(sizePx: number, lodRatio: number): number {
  const s = renderedNodeSize(sizePx, lodRatio)
  if (s >= LOD_DUST) return 0
  const dust = Math.max(0, Math.min(1, (LOD_DUST - s) / (LOD_DUST - LOD_GONE_PX)))
  return Math.round(dust * 50) / 50
}

// Zoom-resolved LOD brightness tier: hubs bright on overview, dust dim background.
export function lodTier(sizePx: number, lodRatio: number): number {
  const s = renderedNodeSize(sizePx, lodRatio)
  if (s >= 8) return 1
  const ramp = s < 4 ? 0.15 : 0.15 + 0.85 * ((s - 4) / 4)
  return Math.round(ramp * 20) / 20
}

// Per-node entrance progress 0..1 (easeOutCubic: quick arrival, soft settle).
// The offset is the node's own deterministic phase: the same words always arrive first.
export function enterProgress(phase: number, enterAlpha: number): number {
  const clock = clamp01(enterAlpha ?? 1)
  const ph = clamp01(phase ?? 0)
  const elapsed = clock * ENTER_TOTAL_MS - ph * ENTER_OFFSET_MS
  const p = clamp01(elapsed / ENTER_MS)
  return 1 - Math.pow(1 - p, 3)
}

// A caption is a NAME, not texture: at the overview only bodies above the map's
// own prominence bar carry one. The bar rises slightly on zoom-out so words stay
// landmarks; on zoom-in it sinks fast so small words surface one by one. Both
// branches yield minCore at ratio 1: the bar is continuous through the overview.
export function labelMinCore(ratio: number, minCore: number): number {
  if (ratio >= 1) return Math.max(3.5, minCore * (0.85 + 0.15 * clamp01(ratio)))
  return Math.max(3.5, minCore * (0.45 + 0.55 * smoothstep(0.35, 1.0, ratio)))
}

// Caption alpha for a body of drawn-core `core` px. Size branches blend over ~2px
// windows: hard cuts read as pops when the bar sinks past them on zoom.
export function labelAlphaFor(core: number, ratio: number, minCore: number = DEFAULT_LABEL_CORE_MIN): number {
  const size = core
  const bar = labelMinCore(ratio, minCore)
  const gate = smoothstep(bar - 1.2, bar + 1.2, size)
  // Zoom-in disclosure, one shared ramp: landmarks yield to the detail (gone by
  // ratio ~0.3), medium words lean out, small words surface through the sinking bar.
  const nearFade = smoothstep(0.3, 0.7, ratio)
  // Landmark hubs leave by SCREEN body radius only: a disc covering the view
  // becomes background, a small disc keeps its caption at any zoom (no ratio
  // gate — nearFade stays in medAlpha only). No floor.
  const hubAlpha = 1 - smoothstep(60, 110, renderedNodeSize(size, ratio))
  const far = ratio <= 1.6 ? 1 : clamp01((3.4 - ratio) / 1.8)
  const medAlpha = ratio > 3.4 ? 0 : far * (1 - clamp01((size - 12) / 10) * (1 - nearFade))
  const progress = clamp01((2.6 - ratio) / 1.4)
  const threshold = clamp01((12 - size) / 13) * 0.5
  const smallAlpha = progress <= threshold ? 0 : Math.pow((progress - threshold) / (1 - threshold), 1.1)
  const wHub = smoothstep(21, 23, size)
  const wMed = smoothstep(11, 13, size)
  const alpha = wHub * hubAlpha + (1 - wHub) * (wMed * medAlpha + (1 - wMed) * smallAlpha)
  return Math.round(clamp01(alpha) * gate * 40) / 40
}

// Effective plate alpha for the current node state. The plate is composited from
// the same caption alpha the text styles use: an opaque chip behind faint text
// reads as an empty frame, so the plate must fade WITH the text, never above it.
export function plateAlpha(ego: boolean, textAlpha: number, enterP: number, dimAlpha: number): number {
  const alpha = ego ? enterP : textAlpha * (1 - 0.55 * dimAlpha)
  return Math.max(0, Math.min(1, alpha))
}
