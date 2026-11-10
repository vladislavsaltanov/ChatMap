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
    segments: 18,
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
  return band * smoothstep(4.5, 8.0, soma.coreR) * (0.55 + 0.35 * soma.focus);
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
  return ticks * smoothstep(6.0, 11.0, soma.coreR);
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
  float orbit = 1.0 - smoothstep(0.9, 2.2, abs(soma.dPx));
  acc = somaOver(acc, vec4(soma.col, orbit * 0.30 * smoothstep(4.0, 9.0, soma.coreR)));

  // 2. Chunky beads: fewer, longer, 2.4px thick. Count encodes frequency and
  //    each word's own phase rotates the pattern.
  float beadsN = floor(mix(9.0, 20.0, smoothstep(5.0, 34.0, soma.coreR)) + 0.5);
  float seg = fract(atan(soma.p.y, soma.p.x) / TAU * beadsN + 0.5 + soma.phase);
  float beads = (1.0 - smoothstep(0.16, 0.34, abs(seg - 0.5)))
              * (1.0 - smoothstep(1.1, 2.6, abs(soma.dPx)))
              * smoothstep(4.5, 9.0, soma.coreR);
  vec3 beadCol = mix(soma.col, vec3(1.0), 0.62 + 0.22 * soma.focus);
  acc = somaOver(acc, vec4(beadCol, beads * (0.95 + 0.05 * soma.focus)));

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
  soma.disc = 1.0 - smoothstep(-0.5, 0.6, soma.dPx);
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
vec4 layer_axon(EdgeContext ctx) {
  float px = max(ctx.aaWidth, 1e-6);
  float halfPx = max(ctx.thickness * 0.5 / px, 1.0);
  float dPx = abs(ctx.sdf + ctx.thickness * 0.5) / px;
  float L = ctx.edgeLength / px;
  float s = clamp(v_axonStrength, 0.0, 1.0);
  float dens = clamp(v_axonBundle, 0.0, 1.0);
  float k = step(0.5, v_axonPulse);
  float lod = clamp(v_axonLod, 0.0, 1.0);
  float t = ctx.t;
  float ph = v_axonPhase * 6.2831853;

  // Liquid: two slow counter-running waves (flowing in / flowing out) and a
  // meniscus at both ends, so the filament pours into and out of its nodes.
  float wavelen = mix(150.0, 52.0, s);
  float speed = mix(0.045, 0.11, s) * u_motion;
  float w1 = sin(t * L / wavelen - u_time * speed * 6.2831853 + ph);
  float w2 = sin(t * L / wavelen + u_time * speed * 4.3 + ph + 1.7);
  float liquid = 0.5 + 0.5 * (0.62 * w1 + 0.38 * w2);
  float ends = pow(abs(2.0 * t - 1.0), 5.0);

  float toMid = (t - 0.5) * L;
  // Thickness IS the frequency: rare links are hairlines, frequent ones are
  // arteries. Round 12 raises the additive weight so the connecting fibres
  // match the heavier node strokes (1.54 px at s=0.3, 3.84 px at s=1.0).
  float fil = (0.08 + 1.55 * pow(s, 1.5) + 0.10 * dens * s
            + v_axonBead * 0.08 * exp(-(toMid * toMid) / 50.0)
            + 0.50 * (1.0 - 0.42 * s))
            * (1.0 - 0.5 * lod)
            * (0.86 + 0.28 * liquid)
            * (1.0 + 0.24 * ends);

  float d = dPx;
  float body = 1.0 - smoothstep(fil - 0.32, fil + 0.32, d);
  // Quiet by default; only hovered/selected fibres run white-hot.
  vec3 base = mix(v_sourceColor.rgb, v_targetColor.rgb, t);
  base = mix(base, vec3(1.0), (0.45 + 0.30 * k) * s);

  float rel = clamp(d / max(halfPx, 1.0), 0.0, 1.0);
  float glow = exp(-max(d - fil, 0.0) / max(halfPx * 0.09, 0.45))
             * (0.012 + 0.030 * s) * (1.0 - smoothstep(0.4, 1.0, rel))
             * (1.0 - 0.6 * lod);
  float a = min(1.0, body + (1.0 - body) * glow);
  vec3 rgb = a > 0.001 ? (base * (0.82 + 0.18 * body) + base * glow * (1.0 - body)) / a : base;
  rgb *= 0.84 + 0.30 * liquid;

  // Soft droplets travelling both ways; active links get a faster extra wave.
  float sig = mix(26.0, 12.0, s);
  float ppIn = fract(u_time * 0.055 + v_axonPhase);
  float ppOut = fract(u_time * 0.038 + v_axonPhase + 0.5);
  float dIn = (t - ppIn) * L;
  float dOut = (t - ppOut) * L;
  float drop = exp(-(dIn * dIn) / (2.0 * sig * sig))
             + 0.75 * exp(-(dOut * dOut) / (2.0 * sig * sig));
  float ppAct = fract(u_time * 0.32 + v_axonPhase);
  float dAct = (t - ppAct) * L;
  float dropAct = exp(-(dAct * dAct) / (2.0 * sig * sig));
  float pulse = u_motion * mix(drop * 0.45, drop * 0.45 + 0.8 * dropAct, k);

  vec3 hot = mix(base, vec3(1.0), 0.8);
  rgb = mix(rgb, hot, clamp(pulse, 0.0, 1.0) * 0.75);
  // Droplets brighten existing coverage only: they never widen the fibre.
  a = clamp(a + pulse * body * 0.4, 0.0, 1.0);
  return vec4(rgb, a);
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
