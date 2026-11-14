import type { EdgeLayer, EdgePath, FragmentLayer } from 'sigma/rendering'
import { labelZoomRatio } from '../core/geometry'

export const neuralClock = { t: 0, motion: 1 }

const edgeTime = { name: 'u_time', type: 'float' as const, value: 0 }
const edgeMotion = { name: 'u_motion', type: 'float' as const, value: 1 }

export function setNeuralTime(seconds: number, motion: number): void {
  neuralClock.t = seconds % 7200
  neuralClock.motion = motion
  edgeTime.value = neuralClock.t
  edgeMotion.value = motion
}

// Node captions are rasterised by Sigma's SDF atlas from a CSS font shorthand.
// The primitive and the node styles must name the SAME family, otherwise the
// atlas and the measured label boxes disagree. Obel Mono is self-hosted.
export const NODE_LABEL_FAMILY = '"Obel Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// Cubic tract: two control points per edge let a whole group of fibres share a
// corridor (FDEB look) instead of crossing or only touching at one point.
// Coefficients are dimensionless in the (delta, perp) basis of the edge, so
// Sigma's uniform normalization and camera transforms leave the curve intact.
export function pathTract(): EdgePath {
  const { FLOAT } = WebGL2RenderingContext
  // language=GLSL
  const glsl = /*glsl*/ `
vec2 tractControl(vec2 source, vec2 d, vec2 perp, vec2 uv) {
  return source + d * uv.x + perp * uv.y;
}

vec2 path_tract_position(float t, vec2 source, vec2 target) {
  vec2 d = target - source;
  vec2 perp = vec2(-d.y, d.x);
  vec2 c1 = tractControl(source, d, perp, v_tract.xy);
  vec2 c2 = tractControl(source, d, perp, v_tract.zw);
  float u = 1.0 - t;
  return u * u * u * source + 3.0 * u * u * t * c1 + 3.0 * u * t * t * c2 + t * t * t * target;
}

float path_tract_length(vec2 source, vec2 target) {
  float len = 0.0;
  vec2 prev = path_tract_position(0.0, source, target);
  for (int i = 1; i <= 8; i++) {
    vec2 cur = path_tract_position(float(i) / 8.0, source, target);
    len += length(cur - prev);
    prev = cur;
  }
  return len;
}
`
  // language=GLSL
  const tangent = /*glsl*/ `
vec2 path_tract_tangent(float t, vec2 source, vec2 target) {
  vec2 d = target - source;
  vec2 perp = vec2(-d.y, d.x);
  vec2 c1 = tractControl(source, d, perp, v_tract.xy);
  vec2 c2 = tractControl(source, d, perp, v_tract.zw);
  float u = 1.0 - t;
  vec2 deriv = 3.0 * u * u * (c1 - source) + 6.0 * u * t * (c2 - c1) + 3.0 * t * t * (target - c2);
  return length(deriv) > 1e-8 ? normalize(deriv) : normalize(d);
}
vec2 path_tract_normal(float t, vec2 source, vec2 target) {
  vec2 tng = path_tract_tangent(t, source, target);
  return vec2(-tng.y, tng.x);
}
`
  return {
    name: 'tract',
    // 48 subdivisions instead of 18: a fibre can span several thousand world units,
    // and at 18 the strip was polygonal — the visible kinks on the real map. The
    // cost is vertices only (~50k strips for a full map), not fragments.
    segments: 48,
    glsl,
    uniforms: [],
    attributes: [{ name: 'a_tract', size: 4, type: FLOAT, source: 'tract' }],
    analyticalTangentGlsl: tangent,
  }
}

// The plate colour must match --paper (oklch(0.16 0.01 85)) and the PNG export.
export const PLATE_COLOR = '#0f0d08'

// Primary node voices, given as RGB triples. The first two authors get exactly
// these colours; extra authors fall back to generated hues. A node with no
// author lead takes the first one, and edges inherit their lead's tint.
const rgb = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
export const NODE_COLORS = [rgb(102, 12, 212), rgb(221, 109, 49)] as const
export const DEFAULT_NODE_COLOR = NODE_COLORS[0]

export function layerSoma(): FragmentLayer {
  const { FLOAT, UNSIGNED_BYTE } = WebGL2RenderingContext
  // language=GLSL
  const glsl = /*glsl*/ `
// A soft-edged band between two values, in screen pixels.
float somaBand(float v, float lo, float hi, float feather) {
  return smoothstep(lo - feather, lo + feather, v)
       * (1.0 - smoothstep(hi - feather, hi + feather, v));
}

// Same "over" compositing Sigma uses between fragment layers.
vec4 somaOver(vec4 bg, vec4 fg) {
  return vec4(mix(bg.rgb, fg.rgb, fg.a), bg.a + fg.a * (1.0 - bg.a));
}

const vec3 PLATE = vec3(0.058824, 0.050980, 0.031373); // rgb(15, 13, 8)
const vec3 WARM = vec3(0.945, 0.937, 0.902);
const float TAU = 6.2831853;

// "Constellation" is the one and only node language: a dotted orbit, a star
// and a halo. Round 12 deliberately thickens EVERY stroke so the fine version
// does not disappear on a dense plate. Edges are still masked by the disc.
struct SomaState {
  vec2 p;
  float r;
  float pxu;
  float c;
  float coreR;
  float haloPx;
  float focus;
  float dPx;
  float disc;
  float phase;
  vec3 col;
  vec3 ink;
  vec3 point;
};
SomaState soma;

float somaFadeEdge() {
  return 1.0 - smoothstep(soma.haloPx - 2.0, soma.haloPx - 0.2, max(soma.dPx, 0.0));
}

// Leader is now 1.6px so it matches the heavier caption.
float somaLeader() {
  float band = somaBand(soma.p.x / soma.pxu, soma.coreR + 0.6, 1.0 / soma.pxu - 0.8, 0.8)
             * (1.0 - smoothstep(0.75, 1.6, abs(soma.p.y) / soma.pxu));
  return band * smoothstep(14.0, 19.0, soma.coreR) * (0.55 + 0.35 * soma.focus);
}

// Focus reticle: a second, heavier orbit at +3.4px.
float somaReticle() {
  return (1.0 - smoothstep(0.85, 2.1, abs(soma.dPx - 3.4)))
       * soma.focus * smoothstep(6.0, 12.0, soma.coreR)
       * step(4.2, soma.haloPx) * 0.70;
}

float somaPoint(float radiusPx) {
  return 1.0 - smoothstep(radiusPx - 0.7, radiusPx + 0.7, soma.r / soma.pxu);
}

// Four chunky diagonal registration ticks.
float somaTicks() {
  float gapPx = min(2.2, soma.haloPx * 0.26);
  float tickLen = max(0.0, min(7.0, soma.haloPx - gapPx - 1.0));
  float ticks = 0.0;
  if (tickLen > 0.5) {
    for (int i = 0; i < 4; i++) {
      float ang = 0.7853982 + float(i) * 1.5707963;
      vec2 dir = vec2(cos(ang), sin(ang));
      float u = dot(soma.p, dir) / soma.pxu;
      float v = dot(soma.p, vec2(-dir.y, dir.x)) / soma.pxu;
      ticks = max(ticks, somaBand(u, soma.coreR + gapPx, soma.coreR + gapPx + tickLen, 0.8)
                       * (1.0 - smoothstep(0.75, 1.6, abs(v))));
    }
  }
  return ticks * smoothstep(19.0, 26.0, soma.coreR);
}

// Four-ray star with 2px arms instead of hairlines.
float somaStarRay(float len) {
  float rayX = (1.0 - smoothstep(1.10, 2.60, abs(soma.p.y) / soma.pxu))
             * (1.0 - smoothstep(len * 0.55, len, abs(soma.p.x) / soma.pxu));
  float rayY = (1.0 - smoothstep(1.10, 2.60, abs(soma.p.x) / soma.pxu))
             * (1.0 - smoothstep(len * 0.55, len, abs(soma.p.y) / soma.pxu));
  return max(rayX, rayY);
}

vec4 skinConstellation() {
  vec4 acc = vec4(PLATE, soma.disc);

  // 1. Quiet continuous orbit: the outline that holds the beads together.
  //    Dust (< 8px) deliberately has NO orbit: a field of small rings reads as a
  //    chain of interlocking links, while the same nodes as bare stars read as
  //    texture. The ring is the language of a body worth naming, so it fades in
  //    across 12..30px instead of snapping on at 14: a mid-size word must not
  //    carry a hub-weight frame (reported: frames crowded the small nodes).
  float orbit = 1.0 - smoothstep(0.9, 2.2, abs(soma.dPx));
  acc = somaOver(acc, vec4(soma.col, orbit * 0.26 * smoothstep(12.0, 30.0, soma.coreR)));

  // 2. Chunky beads: fewer, longer, 2.4px thick. Count encodes frequency and
  //    each word's own phase rotates the pattern.
  float beadsN = floor(mix(9.0, 20.0, smoothstep(16.0, 34.0, soma.coreR)) + 0.5);
  float seg = fract(atan(soma.p.y, soma.p.x) / TAU * beadsN + 0.5 + soma.phase);
  float beads = (1.0 - smoothstep(0.16, 0.34, abs(seg - 0.5)))
              * (1.0 - smoothstep(1.1, 2.6, abs(soma.dPx)))
              * smoothstep(16.0, 24.0, soma.coreR);
  vec3 beadCol = mix(soma.col, vec3(1.0), 0.62 + 0.22 * soma.focus);
  // Beads answer to the body too: full weight only on real hubs, so the frame of a
  // mid-size word stays a trace rather than a solid dashed circle.
  acc = somaOver(acc, vec4(beadCol, beads * (0.55 + 0.45 * smoothstep(18.0, 34.0, soma.coreR)) * (1.0 + 0.05 * soma.focus)));

  // 3. Coloured halo, wider and stronger than the thin version.
  float halo = exp(-pow((soma.r / soma.pxu) / (0.50 * soma.coreR + 4.0), 2.0)) * 0.28;
  acc = somaOver(acc, vec4(soma.col, halo));

  // 4. Star: heavy cross + a large white core.
  float ray = somaStarRay(min(soma.coreR * 0.85, 22.0) + 2.0 * soma.focus)
            * (0.85 + 0.15 * soma.focus);
  acc = somaOver(acc, vec4(soma.point, ray));
  acc = somaOver(acc, vec4(WARM, somaPoint(3.0 + 0.7 * soma.focus)));

  // 5. Ticks, leader, outer aura and focus reticle.
  acc = somaOver(acc, vec4(soma.ink, somaTicks() * 0.95));
  acc = somaOver(acc, vec4(soma.ink, somaLeader()));
  float aura = exp(-max(soma.dPx, 0.0) / 3.4) * somaFadeEdge() * (0.20 + 0.24 * soma.focus);
  acc = somaOver(acc, vec4(soma.col, aura * (1.0 - soma.disc)));
  acc = somaOver(acc, vec4(soma.point, somaReticle()));
  return acc;
}

vec4 layer_soma(vec4 v_somaColor, float v_somaCore, float v_somaGlow, float v_somaPhase,
                float v_somaA0, float v_somaA1, float v_somaA2, float v_somaA3, float v_somaA4) {
  soma.p = context.uv;
  soma.r = length(soma.p);
  soma.pxu = max(context.pixelToUV, 1e-5);
  soma.c = clamp(v_somaCore, 0.05, 0.96);
  soma.coreR = soma.c / soma.pxu;
  soma.haloPx = max(0.0, (1.0 - soma.c) / soma.pxu);
  soma.focus = clamp(v_somaGlow - 1.0, 0.0, 1.0);
  soma.dPx = (soma.r - soma.c) / soma.pxu;
  soma.disc = 1.0 - smoothstep(-0.7, 0.85, soma.dPx);
  soma.phase = v_somaPhase;
  soma.col = v_somaColor.rgb;
  soma.ink = mix(soma.col, WARM, 0.24 + 0.38 * soma.focus);
  soma.point = mix(soma.col, vec3(1.0), 0.76 + 0.20 * soma.focus);

  return skinConstellation();
}
`
  return {
    name: 'soma',
    uniforms: [],
    attributes: [
      { name: 'somaColor', size: 4, type: UNSIGNED_BYTE, normalized: true, source: 'color' },
      { name: 'somaCore', size: 1, type: FLOAT, source: 'core' },
      { name: 'somaGlow', size: 1, type: FLOAT, source: 'glow' },
      { name: 'somaPhase', size: 1, type: FLOAT, source: 'phase' },
      { name: 'somaA0', size: 1, type: FLOAT, source: 'arm0' },
      { name: 'somaA1', size: 1, type: FLOAT, source: 'arm1' },
      { name: 'somaA2', size: 1, type: FLOAT, source: 'arm2' },
      { name: 'somaA3', size: 1, type: FLOAT, source: 'arm3' },
      { name: 'somaA4', size: 1, type: FLOAT, source: 'arm4' },
    ],
    glsl,
  }
}

export function layerAxon(): EdgeLayer {
  const { FLOAT } = WebGL2RenderingContext
  // language=GLSL
  const glsl = /*glsl*/ `
// Axon fibre: a tube rather than a ribbon. Shading, specular and the braid all
// need the SIGNED offset from the axis; ctx.sdf is measured to the strip edge
// and is unsigned across it, so the flank sign is taken from the standard
// v_side varying. Every length below is in screen pixels (px = aaWidth).
float axonWrap(float t, float p, float L) {
  return (fract(t - p + 0.5) - 0.5) * L;
}

// Asymmetric comet: sharp head, long fading wake; both branches meet at dd = 0.
float axonComet(float dd, float sig) {
  float tau = mix(sig * 0.65, sig * 2.8, step(dd, 0.0));
  return exp(-(dd * dd) / (2.0 * sig * sig)) * exp(-abs(dd) / tau);
}

vec4 layer_axon(EdgeContext ctx) {
  float px = max(ctx.aaWidth, 1e-6);
  float t = clamp(ctx.t, 0.0, 1.0);
  float L = max(ctx.edgeLength / px, 1.0);
  float halfPx = ctx.thickness * 0.5 / px;
  float s = clamp(v_axonStrength, 0.0, 1.0);
  float dens = clamp(v_axonBundle, 0.0, 1.0);
  float bead = clamp(v_axonBead, 0.0, 1.0);
  float lod = clamp(v_axonLod, 0.0, 1.0);
  float k = step(0.5, v_axonPulse);
  float ph = v_axonPhase * 6.2831853;
  float motion = clamp(u_motion, 0.0, 1.0);
  float flow = u_time * motion;

  // Absolute-length features (meniscus, mid varicosity) must not fill a short
  // link: their gaussians are 10-18 px wide, so a 30 px edge would swell into a
  // bead and lose its hairline character.
  float longEdge = smoothstep(16.0, 44.0, L);

  // Axis distance keeps the sdf magnitude (zone-safe) and only borrows the sign.
  float d = sign(v_side) * abs(ctx.sdf + ctx.thickness * 0.5) / px;
  float ad = abs(d);

  // Liquid: two slow waves running along the fibre. The first one also breathes
  // the thickness, so the tube pulses instead of only brightening.
  float wavelen = mix(160.0, 54.0, s);
  float waveArg = t * L / wavelen * 6.2831853;
  float w1 = sin(waveArg - flow * 1.2 + ph);
  float w2 = sin(waveArg * 0.57 + flow * 0.75 + ph * 1.7);
  float liquid = 0.5 + 0.5 * (0.65 * w1 + 0.35 * w2);
  float peri = w1;

  // Thickness IS the frequency: the round-12 law, multiplied by taper, breath,
  // LOD, a meniscus that pours the fibre into its nodes and a mid varicosity
  // for the heaviest links.
  float toMid = (t - 0.5) * L;
  float fromEnd = min(t, 1.0 - t) * L;
  float taper = mix(0.80, 1.0, pow(max(1.0 - pow(abs(2.0 * t - 1.0), 4.0), 0.0), 0.6));
  float fil = (0.08 + 1.55 * pow(s, 1.5) + 0.10 * dens * s + 0.50 * (1.0 - 0.42 * s))
            * taper
            * (1.0 + 0.15 * peri * (1.0 - lod))
            * (1.0 - 0.45 * lod)
            * (0.88 + 0.24 * liquid)
            + longEdge * (0.30 * exp(-(fromEnd * fromEnd) / 90.0)
            + bead * 0.50 * exp(-(toMid * toMid) / 648.0));
  // The quad is edgeSize wide (mapview.ts); a breath that outgrows it is cut
  // square by the geometry, which reads as a chopped fibre.
  fil = clamp(fil, 0.35, halfPx + 0.4);

  // 0.38 of the radius is a deliberate, softened edge: a 0.7px fibre
  // antialiased over a sub-pixel band shimmered into stair steps while moving.
  float feather = clamp(fil * 0.38, 0.38, 0.80);
  float body = 1.0 - smoothstep(fil - feather, fil + feather, ad);

  // Quiet by default; hovered and selected fibres run white-hot through the core.
  vec3 base = mix(v_sourceColor.rgb, v_targetColor.rgb, t);
  base = mix(base, base * vec3(1.08, 0.96, 1.14), liquid * 0.35);
  float rel = clamp(ad / max(fil, 1e-3), 0.0, 1.0);
  float shade = 0.58 + 0.62 * pow(max(1.0 - rel * rel, 0.0), 0.7);

  // Braided bundle: two strands twist around the axis and darken the groove
  // between them. On |d| both strands would mirror into one hollow smear.
  float twist = sin(t * L * 0.45 - flow * 2.2 + ph);
  float strandOff = twist * fil * 0.55 * dens;
  float strandW = max(fil * 0.45, 0.40);
  float ds1 = d - strandOff;
  float ds2 = d + strandOff;
  float strand = 0.5 * (exp(-(ds1 * ds1) / (2.0 * strandW * strandW))
                      + exp(-(ds2 * ds2) / (2.0 * strandW * strandW)));
  shade *= 1.0 - 0.20 * dens * (1.0 - strand) * (1.0 - lod);
  vec3 col = base * shade;

  // Specular on one flank of the tube; only ever inside the body.
  float specOff = d - fil * 0.38;
  float specW = max(fil * 0.32, 0.35);
  float spec = exp(-(specOff * specOff) / (2.0 * specW * specW)) * body;
  col += vec3(1.0) * spec * (0.08 + 0.20 * s + 0.28 * k) * (1.0 - 0.7 * lod);

  // Bright fibre core: the light that makes the line read as optic, not paint.
  float coreW = max(fil * 0.38, 0.28);
  float core = 1.0 - smoothstep(coreW - feather * 0.6, coreW + feather * 0.6, ad);
  // The white mix is capped at 1: extrapolating past white pushed the core over
  // 1.0 and the framebuffer clamp then erased the author tint along the axis.
  vec3 coreCol = mix(base, vec3(1.0), min(0.35 + 0.45 * s + 0.30 * k, 1.0));
  col = mix(col, coreCol * (1.02 + 0.22 * liquid), core * (0.40 + 0.35 * s));

  // Tinted halo, a pixel or two wide; LOD drops it first so zooming out leaves
  // pure fibre instead of haze.
  float glowRange = max(halfPx * 0.55, 2.2 + 3.0 * s);
  float glow = exp(-max(ad - fil, 0.0) / glowRange) * (1.0 - body);
  glow *= (0.05 + 0.10 * s + 0.12 * k) * (1.0 - 0.65 * lod);
  col += base * glow * 1.2;
  float a = clamp(body + glow * 1.6, 0.0, 1.0);

  // Comets travel both ways; the active link adds a third, faster wave. The
  // cyclic wrap keeps them alive across the t = 0/1 seam instead of cutting.
  float sig = mix(20.0, 10.0, s);
  float ddIn = axonWrap(t, fract(flow * 0.045 + v_axonPhase), L);
  float ddOut = axonWrap(t, fract(flow * 0.030 + v_axonPhase + 0.5), L);
  float comet = axonComet(ddIn, sig) + 0.65 * axonComet(ddOut, sig * 1.25);
  float ddAct = axonWrap(t, fract(flow * 0.28 + v_axonPhase), L);
  float cometAct = axonComet(ddAct, sig * 0.8);
  float pulse = clamp(motion * mix(comet * 0.55, comet * 0.55 + cometAct * 1.15, k)
                    * (1.0 - 0.7 * lod), 0.0, 1.5);

  vec3 hot = mix(coreCol, vec3(1.0), 0.65);
  col = mix(col, hot * (1.05 + 0.45 * pulse), clamp(pulse, 0.0, 1.0) * 0.85);
  // Droplets brighten existing coverage only: they never widen the fibre.
  a = clamp(a + pulse * body * 0.35, 0.0, 1.0);

  // Flow bands live on the core, so the flanks keep their cylinder shade.
  float flowBand = 0.5 + 0.5 * sin(t * L * 0.22 - flow * (1.0 + 2.0 * s) + ph);
  col *= 0.94 + 0.12 * flowBand * core;
  float inflow = longEdge * exp(-(fromEnd * fromEnd) / 120.0);
  col *= 1.0 + 0.16 * inflow * (0.5 + 0.5 * liquid);

  // Sigma composites layers as blendOver (straight alpha) and then multiplies
  // rgb by the geometric coverage, so rgb already carries a. Dividing it out
  // keeps the halo energy linear and leaves ONE brightness multiplier — the
  // style opacity — applied exactly once.
  return a > 0.001 ? vec4(col / a, a) : vec4(0.0);
}
`
  return {
    name: 'axon',
    uniforms: [edgeTime, edgeMotion],
    attributes: [
      { name: 'a_axonPulse', size: 1, type: FLOAT, source: 'pulse', defaultValue: 0 },
      { name: 'a_axonPhase', size: 1, type: FLOAT, source: 'phase', defaultValue: 0 },
      { name: 'a_axonBead', size: 1, type: FLOAT, source: 'bead', defaultValue: 0 },
      { name: 'a_axonBundle', size: 1, type: FLOAT, source: 'bundle', defaultValue: 0 },
      { name: 'a_axonStrength', size: 1, type: FLOAT, source: 'strength', defaultValue: 0 },
      { name: 'a_axonLod', size: 1, type: FLOAT, source: 'lod', defaultValue: 0 },
    ],
    needsNodeColors: true,
    glsl,
  }
}

export const NEURAL_PRIMITIVES = {
  nodes: {
    layers: [layerSoma()],
    // Captions sit just outside the marker. Obel Mono Bold keeps the plate
    // typographic and matches the heavier strokes of the constellation.
    label: {
      margin: 5,
      zoomToLabelSizeRatioFunction: labelZoomRatio,
      font: { family: NODE_LABEL_FAMILY, weight: '700' },
    },
    variables: {
      core: { type: 'number', default: 0.5 },
      glow: { type: 'number', default: 1 },
      phase: { type: 'number', default: 0 },
      arm0: { type: 'number', default: -1 },
      arm1: { type: 'number', default: -1 },
      arm2: { type: 'number', default: -1 },
      arm3: { type: 'number', default: -1 },
      arm4: { type: 'number', default: -1 },
    },
  },
  edges: {
    paths: [pathTract()],
    layers: [layerAxon()],
    variables: {
      pulse: { type: 'number', default: 0 },
      phase: { type: 'number', default: 0 },
      bead: { type: 'number', default: 0 },
      bundle: { type: 'number', default: 0 },
      strength: { type: 'number', default: 0 },
      // rank is used by the style layer only; lod drives the shader thickness.
      rank: { type: 'number', default: 0 },
      tractRank: { type: 'number', default: 0 },
      lod: { type: 'number', default: 0 },
      // vec4 of path coefficients, supplied straight from the graph attribute.
      tract: { type: 'number', default: 0 },
    },
  },
} as const
