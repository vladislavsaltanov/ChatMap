// fBm blob field for the figure silhouette. Design:
// specs/2026-11-15-blob-figure-design.md (approach A: warp the finished layout).
//
// The field is a radial edge modulation plus a weak 2D domain warp. The centroid
// is pinned, so layout() can add the offset to every point and port without
// shifting the figure. Pure and deterministic: integer lattice hash only, no
// Math.random; the same seed gives byte-identical coordinates.

export const EDGE_AMP = 0.38
export const DOMAIN_AMP = 0.06
export const FREQ = 3.0
export const OCTAVES = 4
export const LACUNARITY = 2.0
export const GAIN = 0.45
export const R_INNER = 0.35
export const R_FULL = 1.0

const smoothstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

// Deterministic lattice value in [0, 1). Same integer mix as hashAt in
// spread.ts, kept local so this module stays a leaf.
const latticeAt = (ix: number, iy: number, seed: number): number => {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Value noise with smoothstep interpolation between lattice nodes.
export function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smoothstep(x - ix)
  const fy = smoothstep(y - iy)
  const v00 = latticeAt(ix, iy, seed)
  const v10 = latticeAt(ix + 1, iy, seed)
  const v01 = latticeAt(ix, iy + 1, seed)
  const v11 = latticeAt(ix + 1, iy + 1, seed)
  const top = v00 + (v10 - v00) * fx
  const bottom = v01 + (v11 - v01) * fx
  return top + (bottom - top) * fy
}

// Sum of octaves normalized back to [0, 1]. Each octave gets its own seed so
// the scales do not line up.
export function fbmNoise(
  x: number,
  y: number,
  seed: number,
  octaves = OCTAVES,
  lacunarity = LACUNARITY,
  gain = GAIN,
): number {
  let sum = 0
  let norm = 0
  let amp = 1
  let fx = x
  let fy = y
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(fx, fy, seed + i * 1013)
    norm += amp
    amp *= gain
    fx *= lacunarity
    fy *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

// Raw displacement before the centroid is pinned.
const rawOffset = (
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfSpan: number,
  seed: number,
): { dx: number; dy: number } => {
  const px = x - cx
  const py = y - cy
  const rn = Math.hypot(px, py) / halfSpan
  const edge = smoothstep((rn - R_INNER) / (R_FULL - R_INNER))
  const theta = Math.atan2(py, px)

  // Seamless silhouette: the noise is sampled on the circle, so the edge stays
  // continuous all the way around.
  const circle = fbmNoise(
    Math.cos(theta) * FREQ,
    Math.sin(theta) * FREQ,
    seed + 101,
    OCTAVES,
    LACUNARITY,
    GAIN,
  )
  const radial = edge * (circle - 0.5) * 2 * EDGE_AMP * halfSpan

  // Weak domain warp of the whole plane; the second sample decorrelates axes.
  const nx = (px / halfSpan) * FREQ
  const ny = (py / halfSpan) * FREQ
  const domainX = DOMAIN_AMP * halfSpan * (fbmNoise(nx, ny, seed + 211, OCTAVES, LACUNARITY, GAIN) - 0.5)
  const domainY =
    DOMAIN_AMP *
    halfSpan *
    (fbmNoise(nx + 101, ny + 57, seed + 337, OCTAVES, LACUNARITY, GAIN) - 0.5)

  return {
    dx: radial * Math.cos(theta) + domainX,
    dy: radial * Math.sin(theta) + domainY,
  }
}

export function blobOffset(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfSpan: number,
  seed: number,
): { dx: number; dy: number } {
  // Guard: non-finite inputs stay non-finite through smoothstep/hypot — clamp
  // at the door so a corrupt coordinate can never poison the whole frame.
  if (!Number.isFinite(x + y + cx + cy + halfSpan)) return { dx: 0, dy: 0 }
  if (!(halfSpan > 0)) return { dx: 0, dy: 0 }
  const raw = rawOffset(x, y, cx, cy, halfSpan, seed)
  const pin = rawOffset(cx, cy, cx, cy, halfSpan, seed)
  // Hard bound: radial + domain excursions never exceed this per axis.
  const bound = (EDGE_AMP + DOMAIN_AMP) * halfSpan
  return {
    dx: Math.max(-bound, Math.min(bound, raw.dx - pin.dx)),
    dy: Math.max(-bound, Math.min(bound, raw.dy - pin.dy)),
  }
}
