import type Sigma from 'sigma'
import { coreFrac, egoNodeScale, fanCoreFrac, fisheyePoint, focusYield, labelZoomRatio, lengthFade, LOD_GONE_PX, lodPresence, quadOf, renderedNodeSize, smallness, visualCoreRadius, weakEdgeCeiling, zoomSizeRatio } from '../core/geometry'
import { DEFAULT_NODE_COLOR, NODE_LABEL_FAMILY } from './neural'

export type CustomNodeState = {
  isActive: boolean
  // Part of the focused word's fan but not one of its strongest few: full
  // brightness, no forced caption, no size boost.
  isEgo?: boolean
  released?: boolean
  releasedAt?: number
}
// egoTier: weight of a link RELATIVE to the strongest link of the focused word
// (0..1). The whole fan is lit; the tier decides dim / medium / glowing.
export type CustomEdgeState = { isActive: boolean; egoTier?: number }
// lodRatio — camera.ratio: >1 = zoom-out, <1 = zoom-in.
// releaseAlpha — size boost fade of a word that just LOST the focus: the body
// shrinks from its hover size instead of snapping back (read by the `released`
// node in the dim branch).
export type CustomGraphState = {
  hasActiveSubgraph: boolean
  dimAlpha: number
  focusAlpha: number
  // Hover growth of the focused word 0..1: the body grows over ~110ms instead of
  // appearing 12% larger in a single frame.
  growAlpha: number
  // Where the selected word sits (graph units), how far its disc reaches (px) and
  // the current px-per-graph-unit: bodies whose discs touch it yield their paper to
  // it (see focusYield). Published by the view on every focus change, so the
  // clearing follows the pointer instead of being recomputed from node flags.
  focusX: number
  focusY: number
  focusReach: number
  focusPxPerUnit: number
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
  // Pin lift animation 0..1: a pinned word grows and brightens as it rides to the
  // top depth bucket, so the promotion reads as a movement instead of a jump.
  promote: number
  // Photo export: hide everything outside the pinned ego-network.
  photoMode: boolean
  // Absolute drawn-core bar (px) above which a body earns a caption. Published by
  // the view per map: a fixed px threshold cannot serve both a 30-word map and a
  // 600-word one.
  labelCoreMin: number
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

// LOD thresholds for distant overview. Spray dots stay visible (7, not 9):
// the references show bright terminals everywhere — dissolved dust would erase
// the very spray the figure is made of.
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
// Density-driven shrink. The old 0.88 erased dust down to 12% of its size on a
// dense map, which turned the silhouette into a sprinkle of invisible dots; 0.62
// keeps the dust legible as texture while the haystack still recedes.
function lodNodeScale(core: number, g: CustomGraphState): number {
  return 1 - 0.62 * smallness(core) * scalePhase(g.cameraRatio ?? 1, g)
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
  // Point 1: an edge is exactly as present as its WEAKER endpoint. Sharing the
  // node's own LOD alpha (not a second size guess) is what killed the old bug of
  // 1000 lines still pointing at bodies that were already gone. No floor: 10% of
  // a line is still a line into nothing.
  const ends = bodyAlpha(core, g)
  // Point 2: a link whose weaker end is a small word never becomes a corridor.
  const ceiling = weakEdgeCeiling(core)
  // Only the axis of a tract stays legible; dozens of stacked fibres made the
  // white slabs. They all come back on zoom-in (fade -> 0).
  const rank = Math.max(0, (attrs.rank as number) ?? 0)
  // Fibre suppression is an OVERVIEW treatment. Zoomed into a chunk interior the
  // eye needs the axons: dots without fibres read as uniform sprinkle no matter
  // how the nodes are placed. The gate relaxes spine/skeleton below on close-up
  // (rank-6 fibre 0.13 -> 0.38, not full) while the overview keeps clean axes.
  const suppressGate = 0.25 + 0.75 * smoothstep(0.30, 0.85, r)
  // Once a chat is big enough to have crossing corridors, the whole spine
  // treatment applies; a 30-word map keeps every fibre on close-up.
  const dense = Math.min(1, densityOf(g) * 1.6) * suppressGate
  // The axis of a tract stays legible at EVERY LOD, not just on the overview:
  // dozens of stacked fibres are the visual noise on a close-up, even when each
  // individual hairline is faint.
  // Neurone look: every dendrite stays visible. Suppression is dialed to a whisper
  // (was 1.1/0.6 hiding all but the axis) so fans read as fans, not single lines.
  const spine = 1 / (1 + rank * (0.35 * dense + 0.3 * fade))
  // Keep a handful of whole corridors; one stray fibre from every tract is
  // exactly the "scattered everywhere" noise the overview must not show.
  const tractRank = Math.max(0, (attrs.tractRank as number) ?? 0)
  // Only a handful of whole corridors are legible at ANY LOD. On a close-up
  // that keeps the detail view from turning back into a mesh of stray fibres.
  const skeleton = 1 - (0.6 * dense + 0.15 * fade) * smoothstep(10, 40, tractRank)
  const bundle = clamp01((attrs.bundle as number) ?? 0)
  const isolated = 1 - 0.82 * fade * (1 - bundle)
  // Fibres are legible in the general view, brighter on strong zoom-in;
  // hovered edges take the `isActive` style below and stay bright.
  const quiet = 0.30 + 0.55 * edgeReveal(r)
  const base = edgeFrequencyTier(attrs, g) * ends * spine * skeleton * isolated * quiet
  // The web itself is the figure: every fibre gets its whisper, gated only by
  // endpoint presence (`ends`). Thousands of thin hairlines on black read as
  // tissue, not mesh — the references prove it. Mesh insurance that stays:
  // `ends`, the weak cap, `skeleton` for extreme ranks, `reachFade`.
  const es = clamp01((attrs.strength as number) ?? 0)
  const trace = 0.07 * (1 - edgeReveal(r)) * (1 - 0.7 * deepPhase(r))
  // A lone wire across a void is figure, not noise: links much longer than the
  // median hang off satellites in empty paper — few and isolated by construction,
  // so showing them cannot rebuild the mesh. Hiding them strands the satellites
  // as debris and the map reads as broken pieces instead of one web.
  const reach = (attrs.reach as number) ?? 1
  const loneWire = 0.10 * smoothstep(2.0, 3.2, reach) * (1 - smoothstep(0.10, 0.40, es)) * ends
  // Long weak links dissolve by geometric reach (mapview sets it); strong
  // corridors are spared. Applied to the trace too, or the mesh persists.
  // The lone wire above is exempt on purpose: it is the anti-debris exception.
  const reachFade = lengthFade(reach, (attrs.strength as number) ?? 0)
  // The universal whisper is gated by the SAME endpoint presence: a trace is for
  // the web of live bodies, not for a link into a body that is no longer drawn.
  // The weak-link cap is a MAX alpha, not a factor: capping an already quiet line
  // twice would erase the very connection the cap is supposed to mark as weak.
  return Math.min(clamp01((g.enterAlpha ?? 1) * reachFade * Math.max(base, trace * ends) + loneWire), ceiling)
}

// Query: LOD alpha of a BODY before the entrance tween — the single number that
// both the node style and its edges answer to. 0 means the body does not exist:
// no caption, no line into it, and nothing downstream may resurrect it.
function bodyAlpha(core: number, g: CustomGraphState): number {
  const lodRatio = g.lodRatio ?? 1
  const alpha = lodTier(core, lodRatio) * (1 - lodDust(core, lodRatio)) * lodPresence(renderedNodeSize(core, g.cameraRatio ?? 1))
  // Dead zone at the first visible step (the opacity style is quantised to 0.02):
  // without it a 1% body still counted as alive and kept a 1% line alive with it.
  return alpha < 0.02 ? 0 : alpha
}

// Overview dust fade degree: 0 = full brightness, up to 1 = dissolved.
// The ramp ends exactly where `lodPresence` reaches zero, so brightness and
// existence never disagree about a body.
// Quantized to 0.02 to avoid thrashing per-frame caches.
function lodDust(sizePx: number, lodRatio: number): number {
  const s = lodScale(sizePx, lodRatio)
  if (s >= LOD_DUST) return 0
  const dust = Math.max(0, Math.min(1, (LOD_DUST - s) / (LOD_DUST - LOD_GONE_PX)))
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
function lodNodeOpacity(sizePx: number, g: CustomGraphState, attrs: any): number {
  return Math.round(bodyAlpha(sizePx, g) * enterProgress(attrs, g) * 50) / 50
}

// Fresh-map entrance: the whole map fades in over ENTER_TOTAL, and every word
// starts on its own offset, so the figure assembles as a wave instead of a
// single global fade. Both timings must match the tween in MapView.render().
const ENTER_MS = 900
const ENTER_OFFSET_MS = 900
export const ENTER_TOTAL_MS = ENTER_MS + ENTER_OFFSET_MS

// Per-node entrance progress 0..1 (eased). The offset comes from the node's own
// deterministic phase, so the same words always arrive in the same order.
function enterProgress(attrs: any, g: CustomGraphState): number {
  const clock = clamp01(g.enterAlpha ?? 1)
  const phase = clamp01((attrs?.phase as number) ?? 0)
  const elapsed = clock * ENTER_TOTAL_MS - phase * ENTER_OFFSET_MS
  const p = clamp01(elapsed / ENTER_MS)
  // easeOutCubic: quick arrival, soft settle
  return 1 - Math.pow(1 - p, 3)
}

// Query: label alpha. Words stay readable much farther out than before:
// hubs never fade, medium words survive to ratio 2.2, satellites to ~1.8.
// The kegel itself is constant in screen px (labelZoomRatio), so there is no
// "inside a shrunken bubble" penalty any more.
// Default when the map has not published its own bar yet (tiny fixtures, first frame).
const DEFAULT_LABEL_CORE_MIN = 6

// A caption is a NAME, not a texture: at the overview only bodies above the map's
// own prominence bar carry one. The bar is the p80 of the filled size distribution,
// published per map by MapView, because a fixed px threshold fails in both
// directions — measured: with 12px captions a 600-word map rendered 221 captions
// (text on almost every dot), while the old 18.5px kegel allowed only 48 by
// collision alone. The bar rises slightly on zoom-out so words stay landmarks.
function labelMinCore(ratio: number, minCore: number): number {
  return Math.max(3.5, minCore * (0.85 + 0.15 * clamp01(ratio)))
}

function labelAlphaFor(attrs: any, ratio: number, minCore: number = DEFAULT_LABEL_CORE_MIN): number {
  const size = drawnCore(attrs)
  // The gate moves with the camera, so the decision is continuous instead of a pop.
  const bar = labelMinCore(ratio, minCore)
  const gate = smoothstep(bar - 1.2, bar + 1.2, size)
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
  return Math.round(alpha * gate * 40) / 40
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
  const vis = lodNodeOpacity(drawnCore(attrs), state, attrs)
  // The word arrives with the body and leaves with it: no whisper floor. The ramp
  // starts at the first visible steps, so a speck does not scatter grey text over
  // the paper — measured: captions of dissolved bodies still read at ratio 2.
  return smoothstep(0.05, 0.16, vis)
}

function labelTextAlpha(attrs: any, g?: CustomGraphState): number {
  const state = g ?? ({} as CustomGraphState)
  return labelAlphaFor(attrs, labelRatio(g), state.labelCoreMin) * labelProminence(attrs, g)
}

// Legibility gate for the label collision resolver only: a caption that is
// already fading out must not TAKE a slot, because it would pop in for a couple
// of zoom steps and vanish again. Never use it to decide whether to draw — the
// draw gate stays the 0.02 alpha threshold (see baseLabelVisibility).
export function labelIsLegible(attrs: any, ratio: number, minCore?: number): boolean {
  return labelAlphaFor(attrs, ratio, minCore) > 0.30
}

// A caption is anchored to the node's QUAD, not to its core: growing the quad of a
// fan member shoved every connected word's text right by half the growth (measured:
// 257 of 274 neighbours moved, up to 2px). The fan therefore fills more of its own
// quad on the focus ramp (`core`), and its quad never changes.
function fanCore(attrs: any, g: CustomGraphState): number {
  const core = drawnCore(attrs)
  return fanCoreFrac(coreFrac(core), lodNodeScale(core, g), g.growAlpha ?? 0)
}

// The same ramp lifts the fan out of the LOD dim instead of popping it to full
// brightness: weak bodies arrive with the link, not before it. The crowd yield is
// multiplied on top: a fan body whose disc touches the selected word is the one
// crowding it most, so it steps back like every other body does.
function fanAlpha(attrs: any, g: CustomGraphState): number {
  const base = lodNodeOpacity(drawnCore(attrs), g, attrs)
  return (base + (1 - base) * clamp01(g.growAlpha ?? 0)) * yieldTo(attrs, g)
}

// Caption of a fan member: full ink on the fan ramp, ghosted when the body yields.
function fanLabelColor(attrs: any, g: CustomGraphState): string {
  return hexToRgba(LABEL_LIGHT, labelTextAlpha(attrs, g) * yieldTo(attrs, g))
}

// 'auto' lets Sigma's LabelGrid arbitrate between nearby labels by node size.
// 'visible' is reserved for the focused ego-network (it forces past the grid).
// The threshold is deliberately tiny: the LOD ramp already produces continuous
// alpha, so a caption fades rather than popping. Raising it to "legible" levels
// wiped most of the captions on a 600-word map (measured: a plate-only map).
function baseLabelVisibility(attrs: any, g?: CustomGraphState): 'auto' | 'hidden' {
  if (g?.labelBlocked?.has(String(attrs?.nodeId))) return 'hidden'
  return labelTextAlpha(attrs, g) > 0.02 ? 'auto' : 'hidden'
}

function baseNodeVisibility(attrs: any, g: CustomGraphState): 'visible' | 'hidden' {
  // Visibility answers to the same alpha the renderer uses: a body below the
  // visible step cannot be picked, labelled or counted as present.
  return bodyAlpha(drawnCore(attrs), g) > 0 ? 'visible' : 'hidden'
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
// Effective caption alpha for the current node state — the same numbers the
// text styles use. The plate is composited from it below: an opaque chip behind
// 20%-alpha text reads as an empty frame, and its edge flickers while the dim
// tween moves on every hover retarget.
function plateAlphaFor(s: any, attrs: any, g: CustomGraphState): number {
  const ego = Boolean(s?.isActive || s?.isHighlighted)
  const alpha = ego
    ? enterProgress(attrs, g)
    : labelTextAlpha(attrs, g) * (1 - 0.55 * (g.dimAlpha ?? 0))
  return Math.max(0, Math.min(1, alpha))
}

function labelBackgroundColorFor(attrs: any, s: any, g: CustomGraphState): string {
  if (!g.labelBackdrop?.has(String(attrs?.nodeId))) return ''
  return hexToRgba('#0f0d08', 0.68 * plateAlphaFor(s, attrs, g))
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
  // Wider analytic feather on the SDF strokes: 1px left step edges on the
  // sub-pixel hairlines and on the dashed orbits.
  antiAliasingFeather: 1.3,
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
// designed 18.5px at every zoom level. Exported because the label collision
// resolver must predict the SAME on-screen text size without reading the applied
// display data (that read closed a feedback loop and made captions flicker).
export const LABEL_FONT_PX = 18.5

// Caption weight answers to the body: a 5px dot must not carry the same 18.5px word
// as a landmark hub, or the text outweighs the map it describes (reported from a real
// export: captions were the largest thing on screen). 0.62 at dust, 1.0 from ~18px.
export function labelFontPxFor(attrs: any): number {
  const core = drawnCore(attrs)
  return LABEL_FONT_PX * (0.62 + 0.38 * clamp01((core - 5) / 13))
}

function labelTextSizeFor(attrs: any, g?: CustomGraphState): number {
  return labelFontPxFor(attrs) * labelZoomRatio(Math.max(0.05, g?.cameraRatio ?? 1))
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
  return hexToRgba(LABEL_LIGHT, labelTextAlpha(attrs, g) * (1 - 0.55 * (g.dimAlpha ?? 0)) * yieldTo(attrs, g))
}

// Query: how much a body yields to the selected word (1 = untouched). A body whose
// disc touches the focused disc steps back so the word is never crossed by it; the
// test is geometric, so the crowd closes again on its own when the focus moves.
// Distances are converted to px (the unit the node sizes live in) with the factor
// the view publishes for the current camera.
function yieldTo(attrs: any, g: CustomGraphState): number {
  const dim = g.dimAlpha ?? 0
  const perUnit = g.focusPxPerUnit ?? 0
  if (dim <= 0 || perUnit <= 0) return 1
  const dx = (attrs?.x ?? 0) - (g.focusX ?? 0)
  const dy = (attrs?.y ?? 0) - (g.focusY ?? 0)
  return focusYield(Math.hypot(dx, dy) * perUnit, g.focusReach ?? 0, visualCoreRadius((attrs?.size as number) ?? 0), dim)
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
        quadOf(drawnCore(attrs)) * lodNodeScale(drawnCore(attrs), g) * (0.55 + 0.45 * enterProgress(attrs, g)),
      // A selected word rides into the last depth bucket, which Sigma paints after
      // every other body and caption, so nothing on the map can cover it. Depth is
      // categorical in v4: the item moves between buckets without reprocessing the
      // rest of the graph, which `zIndex` would do on every tween frame.
      // The lift waits for the dim to settle (dimAlpha > 0.9, i.e. ~90ms into the
      // 100ms focus tween): by then the crowd around the word has already yielded
      // its opacity, so the layer swap is invisible instead of a pop. On the way
      // out dimAlpha falls past the same bar within ~10ms, which puts the body back
      // before the crowd returns.
      depth: (_attrs: any, s: any, g: CustomGraphState): 'nodes' | 'topNodes' =>
        s?.isHighlighted && (g.dimAlpha ?? 0) > 0.9 ? 'topNodes' : 'nodes',
      // EVERY caption lives in the last depth bucket, so text always paints over
      // every body. Keeping the labels in one bucket also matters for rendering:
      // Sigma rebuilds the shared label buffer once per depth pass, and splitting
      // captions between 'nodes' and 'topNodes' made the whole 'nodes' pass
      // disappear from the pixels (measured: 54 labels "displayed", none drawn).
      labelDepth: (): 'topNodes' => 'topNodes',
      color: { attribute: 'color', defaultValue: DEFAULT_NODE_COLOR },
      opacity: (attrs: any, _s: any, g: CustomGraphState) => lodNodeOpacity(drawnCore(attrs), g, attrs),
      label: { attribute: 'label' },
      visibility: (attrs: any, _s: any, g: CustomGraphState) => baseNodeVisibility(attrs, g),
      // Captions always sit outside the marker and are reached by its leader.
      labelPosition: 'right',
      labelColor: (attrs: any, _s: any, g: CustomGraphState) => labelTextColorFor(attrs, g),
      labelSize: (attrs: any, _s: any, g: CustomGraphState) => labelTextSizeFor(attrs, g),
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
      // Outside the ego network: recede. The fan of the focused word (isEgo) is
      // NOT dimmed — it is the whole point of the hover.
      when: (_a, s) => Boolean(!s?.isActive && !s?.isHighlighted && !s?.isEgo),
      then: {
        // Keep the body opaque so edges never shine through it; recede via tint.
        // The one exception is the crowd around the selected word: a body whose
        // disc touches the focused disc yields its opacity (and its caption), so
        // the word is never crossed by it.
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          lodNodeOpacity(drawnCore(attrs), g, attrs) * yieldTo(attrs, g),
        // A word that just lost the focus keeps the boost it had reached and hands
        // it back over `releaseAlpha`, so the ego network dissolves instead of
        // snapping back to resting size. Every other body has released = false.
        size: (attrs: any, s: any, g: CustomGraphState) =>
          quadOf(drawnCore(attrs)) *
          lodNodeScale(drawnCore(attrs), g) *
          egoNodeScale(s?.released ? (g.releaseAlpha ?? 0) : 0, 0) *
          (0.55 + 0.45 * enterProgress(attrs, g)),
        color: (attrs: any, _s, g: CustomGraphState) =>
          dimTint(attrs?.color as string, 1 - 0.72 * (g.dimAlpha ?? 0)),
        labelColor: (attrs: any, _s, g: CustomGraphState) => focusedLabelColor(attrs, g),
        // Keep the captions that were readable before the focus; only dim them.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) => baseLabelVisibility(attrs, g),
      },
    },
    {
      // The rest of the fan: full brightness and full size (so the lit links land
      // on something visible), but no forced caption — those stay a typography
      // budget for the strongest few neighbours.
      when: (_a, s) => Boolean(s?.isEgo),
      then: {
        opacity: (attrs: any, _s: any, g: CustomGraphState) => fanAlpha(attrs, g),
        // The reveal happens INSIDE the quad: nothing here may move a caption.
        ...({ core: (attrs: any, _s: any, g: CustomGraphState) => fanCore(attrs, g) } as Record<string, unknown>),
        visibility: (_a: any, _s: any, g: CustomGraphState) =>
          egoActive(g) ? 'visible' : baseNodeVisibility(_a, g),
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) => baseLabelVisibility(attrs, g),
        labelColor: (attrs: any, _s: any, g: CustomGraphState) => fanLabelColor(attrs, g),
      },
    },
    {
      whenState: 'isActive',
      then: {
        // Focus must not bypass the entrance: a hover during the assembly wave
        // would pop the body to full size and full brightness.
        opacity: (attrs: any, _s: any, g: CustomGraphState) => fanAlpha(attrs, g),
        ...({ core: (attrs: any, _s: any, g: CustomGraphState) => fanCore(attrs, g) } as Record<string, unknown>),
        // NO size: a labelled neighbour keeps its quad, so its caption stays put.
        visibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoActive(g) ? 'visible' : baseNodeVisibility(attrs, g),
        // Connected neighbours keep their words on HOVER and on pin alike.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoLabelVisibility(attrs, g, baseLabelVisibility(attrs, g)),
        labelColor: (attrs: any, _s: any, g: CustomGraphState) =>
          hexToRgba(LABEL_LIGHT, enterProgress(attrs, g) * yieldTo(attrs, g)),
        labelFont: labelFontFocus,
        ...({
          glow: (_a: any, _s: any, g: CustomGraphState) => 1 + 0.6 * (g.focusAlpha ?? 0),
        } as Record<string, unknown>),
      },
    },
    {
      whenState: 'isHighlighted',
      then: {
        // The pinned word is promoted to the last depth bucket by the base rule
        // in `depth`/`labelDepth`: its body is painted after every other body and
        // its caption after every other caption, so nothing can cover it. Hover
        // shares this branch but not the promotion (that needs `pinActive`).
        opacity: (attrs: any, _s: any, g: CustomGraphState) => enterProgress(attrs, g),
        // The hovered word is always captioned; the whole ego-network is too.
        labelVisibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoLabelVisibility(
            attrs,
            g,
            lodScale(drawnCore(attrs), g.lodRatio ?? 1) >= 6 ? 'visible' : baseLabelVisibility(attrs, g),
          ),
        visibility: (attrs: any, _s: any, g: CustomGraphState) =>
          egoActive(g) ? 'visible' : baseNodeVisibility(attrs, g),
        size: (attrs: any, _s: any, g: CustomGraphState) =>
          quadOf(drawnCore(attrs)) *
          egoNodeScale(g.growAlpha ?? 0, g.promote ?? 0) *
          (0.55 + 0.45 * enterProgress(attrs, g)),
        labelColor: (attrs: any, _s: any, g: CustomGraphState) =>
          hexToRgba(LABEL_LIGHT, enterProgress(attrs, g)),
        labelFont: labelFontFocus,
        ...({
          glow: (_a: any, _s: any, g: CustomGraphState) =>
            1 + 1.2 * (g.focusAlpha ?? 0) + 0.5 * (g.promote ?? 0),
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
        opacity: (attrs: any, _s: any, g: CustomGraphState) => lodNodeOpacity(drawnCore(attrs), g, attrs),
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
        // Outside the fan the rest of the web must stay VISIBLE, not vanish: the
        // old 93% dim left ~7% of a quiet line, i.e. nothing. 78% keeps it as a
        // legible background mesh.
        opacity: (attrs: any, _s, g: CustomGraphState) =>
          edgeOpacity(attrs, g) * (1 - 0.78 * (Math.round(16 * (g.dimAlpha ?? 0)) / 16)),
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topEdges',
        // Transit culling (mapview hides edges whose endpoints left the frame)
        // runs on camera moves, not on hover: at a deep zoom the fan was already
        // hidden before the pointer arrived, so hovering a word showed NO lines
        // until the next camera move. The focused fan must not lose to that cache.
        visibility: 'visible',
        // Ego fan: every link of the focused word is lit, tiered by its weight
        // relative to the strongest link of that word. Weak links stay dim but
        // clearly above the dimmed background (0.14 vs ~0.07 of a quiet line) so
        // the fan COUNT is readable; the heaviest links glow and run droplets.
        // Without `egoTier` (photo mode) the frequency tier applies as before.
        opacity: (attrs: any, s: any, g: CustomGraphState) => {
          const focus = g.focusAlpha ?? 0
          const tier = (s as CustomEdgeState)?.egoTier
          if (typeof tier !== 'number') {
            const base = edgeFrequencyTier(attrs, g)
            return Math.min(1, base + (1 - base) * focus)
          }
          const lit = 0.10 + 0.90 * Math.pow(tier, 3)
          return Math.min(1, lit * (0.25 + 0.75 * focus))
        },
        size: (attrs: any, s: any, g: CustomGraphState) => {
          const tier = (s as CustomEdgeState)?.egoTier ?? 0
          return ((attrs.size as number) ?? 2.4) * (1 + 0.45 * tier * (g.focusAlpha ?? 0))
        },
        // Only the very top of the fan carries the travelling glow. A cube ramp on
        // the rank tier keeps the rest strictly weaker and weaker: rank 1 -> 1.0,
        // rank 16 -> 0.63, rank 82 -> 0.21, tail -> 0.10.
        ...({ pulse: (_a: any, s: any) => ((s as CustomEdgeState)?.egoTier ?? 1) >= 0.94 ? 1 : 0 } as Record<string, unknown>),
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
