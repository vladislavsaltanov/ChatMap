# Dendrite pass — implementation contract (2026-11-13)

Reference: `specs/2026-11-13-work.md` (the consultant plan). That document is
**diagnosis + ideas**, not a patch: three of its four snippets do not compile
against the real code and two of them cannot work with the current renderer
(reasons in §1.3). This file is the authoritative spec. Where the two disagree,
this file wins.

Goal: replace the filled oval ("блин") with a horizontally elongated sheet of
**5 fanned fascicles per hub separated by angular canyons**, and turn the two
straight "searchlight" fans into **fused axon trunks that only split at the
terminals**. All gates in `tests/` stay green.

---

## 0. Baseline (measured before this pass)

- `npm run typecheck` → 0 errors.
- `npx vitest run` → 252 passed, 1 skipped, 16 files green.
- Gates that must survive: S1 (`kNN(5)==1`, aspect ∈ [1.6, 2.0]), S2 (`clump ≥ 2.0`,
  `ports ≥ 3`), S2b (`voidShare ≥ 0.08`), S3 (`voidShare ≥ 0.1`), S4
  (`d − max(size) > 0` for every pair), S5, S6 (core median < 0.7 × tip median),
  S7 (byte-identical on same seed), S8 (cached coordinates untouched), S9 (< 400 ms
  for 1000 nodes).

## 1. Diagnosis, pinned to the code that exists

1. `softInit` (`leaf.ts:176-186`): `fan = base + (hashAt(b1)-0.5)*1.85` — one
   continuous ±105° sector per first-hop branch `b1`. A hub with 50-120 distinct
   `b1` paints the whole semicircle with no gap. **Root cause of the pancake.**
2. `softInit` `reach = min(1.6, dMin/tau) * span * 0.085` — on a star graph every
   leaf shares almost the same `dMin`, so dozens land on one circle.
3. `layout()` (`graph.ts`): first 8 passes run anchorless and isotropic, which
   packs every canyon shut before phase 2 can re-anchor.
4. `holdAspect` / `SPREAD_ASPECT` measure the **bounding box**. One detached hub
   (`«меня»` at the top) inflates the box, so the target aspect is met by stretching
   a round blob instead of by having an elongated shape.
5. `bundleEdges` (`geometry.ts`): control point 1 is `a + 0.75*(port − a)` computed
   **per edge**. A hub with 200 leaves therefore emits 200 different curves that
   diverge from `t≈0.05` — a linear beam, not a tract.

### 1.3. What the reference plan gets wrong (do not copy)

- `SoftInit.waypoints` is unused by its own `buildFascicleSpines`, which derives
  the spine from **final positions**. Dead plumbing through worker → renderer.
  **Dropped.**
- The `t=0.86` five-point spline cannot be represented: `types.ts` `EdgeMsg.tract`
  is a **cubic** `[u1,v1,u2,v2]` and `ui/neural.ts` evaluates exactly that cubic in
  the shader. Polyline/spline support would be a renderer rewrite. **Out of scope.**
- `enforceNeuralFrame` clamps outliers, i.e. *shrinks*, then re-stretches. Shrinking
  can lose clearance (S4). Elongation is created at its source instead (§2.1).
  **Dropped.**
- Weakening every cross-stem spring to `0.14` lets bridges drift off their Dijkstra
  positions. Softened to `0.35` + rest × 1.2 (§2.3).

## 2. Contract (types). Identical in every file.

### 2.1. Stem identity — the one shared invariant

A **stem** is a quantized first-hop fascicle of one hub. Id encoding:

```
stemId = ownerIndex * 16 + slot        slot 0 = the hub (soma), 1..5 = stems
stemOwner(id) = Math.floor(id / 16)
stemSlot(id)  = id % 16                (safe: ids are >= 0)
ISOLATE_STEM = -1                      no fascicle, never merged, never padded
```

Rules every consumer must apply identically:

- `stemOf` maps **node id → stemId**. Missing entry or `-1` = no stem.
- Two nodes belong to the same fascicle iff `s === s2` and `s >= 0`
  (`slot 0` vs `slot 3` is **not** the same fascicle), **except** that a hub is the
  root of its own arms: for the solver's pack/cleft rule and for edge routing,
  equal owner plus either slot `0` also counts as the same fascicle
  `owner*16 + max(slot)`. Without that union the cleft also fired between a soma and
  its own leaves and pushed every hub out of its arm (found in cross-review).
- An edge routes through fascicle `f` iff both stems are `>= 0`, `stemOwner` is
  equal, and (`slotA === slotB` or `slotA === 0` or `slotB === 0`);
  then `f = stemOwner * 16 + max(slotA, slotB)`. This is what lets hub→leaf edges
  (slot 0 → slot n) share the leaf's trunk without extra plumbing.

### 2.2. Type changes

```ts
// src/core/leaf.ts
export type SoftInit = {
  positions: Map<number, Pt>
  phi: Map<number, number[]>
  dominance: Map<number, number>
  tau: number
  stemOf: Map<number, number>   // NEW, required: softInit always produces it
}
export function alignPrincipalAxis(positions: Map<number, Pt>): void // NEW, exported

export function stressLeaf(
  nodes, edges, init, phi,
  opts: { iters?: number; seed?: number; stemOf?: Map<number, number> }, // stemOf NEW, optional
): Map<number, Pt>

// src/core/graph.ts
export type SolverOpts = {
  anchors?: Map<number, { x: number; y: number }>
  groupOf?: Map<number, number>
  dominance?: Map<number, number>
  sulcusPad?: number
  stemOf?: Map<number, number>   // NEW, optional
  cleftPad?: number              // NEW, optional, world units
}
export type LayoutResult = { /* existing */ stemOf?: Map<number, number> } // NEW

// src/core/geometry.ts
export type RouteInfo = {
  ports: Map<number, { x: number; y: number }>
  groupOf: Map<number, number>
  stemOf?: Map<number, number>   // NEW, optional
}

// src/core/spread.ts
export type SpreadResult = { /* existing */ stemOf?: Map<number, number> } // NEW
```

No other exported signature changes. `stemOf` stays optional everywhere except
`SoftInit`, so a caller that does not pass it keeps today's behaviour byte-for-byte
(S7/S8 depend on that).

---

## 3. Steps

### Step 1 — `landmarkPositions`: constructive MST spine (owner: A, file `src/core/leaf.ts`)

Replace the golden-circle seed + 80 affinity iterations. The old loop *is* the
wheel generator: an isotropic relaxation seeded on a circle converges to a circle.
A constructive spine cannot.

`landmarkPositions(ids, affinity, span, seed)` keeps its signature.

1. `k = ids.length`; `k === 0` → empty, `k === 1` → `{0,0}`.
2. **Prim MST** by max affinity, deterministic: prefer larger `aff`, then smaller
   `(min(u,v), max(u,v))`. Affinity of an absent pair is `0`.
3. **Root** = the MST node with the largest sum of incident affinity, tie → min id.
4. **DFS pre-order** from the root; children sorted by `subtreeSize` desc, then
   `aff` desc, then id asc. `subtreeSize` = number of zones below the child.
5. **Constructive placement**, as a fraction of `span`:
   - root at `(0, 0)`, its `baseAngle = 0`.
   - `step = span * (0.22 + 0.14 * (1 - aff))` — a weakly bonded zone sits far.
   - trunk child (index 0 in the sorted children): `angle = baseAngle + bend`,
     `bend = ±0.35 * hashAt(child, 11, seed)` (the main backbone is an S-curve, not a line).
   - side child (index `j ≥ 1`): `angle = baseAngle + sign * (0.72 + 0.22 * (j - 1))
     + (hashAt(child, 13, seed) - 0.5) * 0.24`, where `sign` alternates `+1, -1, ...`
     with `j` and flips per parent (`hashAt(parent, 17, seed) > 0.5`).
   - `pos = parentPos + (cos(angle) * step, sin(angle) * step * 0.72)` — the `0.72`
     on Y keeps the zone cloud already wider than tall.
6. **Repair relaxation only, 40 iterations** (no affinity attraction — the
   construction already encodes it, and any attraction lets the loop re-invent the
   wheel):
   - all pairs: if `d < 0.20 * span`, push apart with `(d - minSep) * 0.05`;
   - MST pairs: if `d > 0.36 * span`, pull together with `(d - maxSep) * 0.05`.
   Both forces are clamped to `±0.5 * span` per application; `d < 1e-3` gets the
   deterministic id nudge already used in `resolveLeafCollisions`.
7. `alignPrincipalAxis(pos)` — see Step 2.
8. Recenter on the centroid.

### Step 2 — `alignPrincipalAxis` (owner: A, file `src/core/leaf.ts`)

Exported, pure, `(positions: Map<number, Pt>) => void`, in place.

- centroid over all points; covariance `sxx, syy, sxy` with a Huber cap on the
  radius (`w = r > 600 ? 600 / r : 1`) so one detached hub cannot steer the axis.
- `angle = 0.5 * atan2(2*sxy, sxx - syy)`; rotate by `-angle` about the centroid.
- Guard: `< 3` points or a degenerate covariance (`|sxx-syy| < 1e-9 && |sxy| < 1e-9`)
  → return untouched.

### Step 3 — `softInit`: quantized stems (owner: A, file `src/core/leaf.ts`)

Keep the existing phi/dominance/bridge/isolate logic. Replace only the extrusion:

1. Bridges (`dom ≤ 0.55`) keep today's barycentric position + jitter. **Unchanged** —
   this is what keeps zones stitched (S1) and it is ~40% of the risk budget.
2. Per owner hub, collect owned nodes: **ownership margin** `(d2−d1)/d2 > 0.4`
   between the nearest and second-nearest zone, finite `dMin`, `id !== hub`.
   (Amended: the original `dom > 0.55` gate was dead in production — see §5.)
3. `b1Mass` per `trees[owner].branch1` value (sum of `node.size ?? 20`); the top
   `STEMS = 5` by `(mass desc, id asc)` are major slots.
4. Every remaining `b1` is assigned by `hashAt(b1, 29, seed)` (deterministic),
   **not** to the geometrically nearest stem — `softInit` has no adjacency, and
   hash assignment is O(1). Document this in the comment.
5. **Angular slots**: `base = atan2(lp.y - cy, lp.x - cx)`, one fixed offset per
   slot `[-1.45, -0.72, 0, 0.72, 1.45]` plus `(hashAt(hub + slot, 31, seed) - 0.5) * 0.20`.
   Gaps between neighbours are ≥ 0.32 rad minus stem width — the canyons.
6. Per stem: sort nodes by `(dMin asc, size desc, id asc)`, `rankRatio = (i+1)/count`,
   `reach = span * (0.20 + 0.14 * min(1, count / 24))`.
   `progress = 0.45 * min(1.3, dMin / (tau * 1.35)) + 0.55 * rankRatio ** 0.8`
   `r = span * 0.03 + progress * reach`
   — the rank term is what breaks the single-radius ring of a star graph.
7. `theta = base + slotOffset + curl + twig + tip`:
   - `curl = sign * (0.22 + 0.14 * hashAt(hub + slot, 37, seed)) * progress ** 1.3`
     with `sign = hashAt(hub * 31 + slot, 41, seed) > 0.5 ? 1 : -1` (S-bend);
   - `twig = (hashAt(b2, 43, seed) - 0.5) * 0.40 * max(0, (progress - 0.35) / 0.65) ** 1.2`
     (secondary fork opens after 35%);
   - `tip = (hashAt(id, 47, seed) - 0.5) * 0.26 * max(0, (progress - 0.78) / 0.22)`
     (terminals fan only over the last 22%).
8. `stemOf.set(id, ownerIndex * 16 + slot + 1)`; the hub node gets
   `ownerIndex * 16`; isolates get `ISOLATE_STEM = -1` and keep the smallest-landmark
   pocket (unchanged, `stemOf` entry added).
9. Keep the existing 12 px jitter and the global anisotropic rescale to
   `0.9*span × LEAF_ASPECT` — S4 depends on it, shape is not changed by it.
10. Return `stemOf` in `SoftInit`.

### Step 4 — `stressLeaf`: stem-aware springs (owner: A, file `src/core/leaf.ts`)

`opts.stemOf` optional; absent = today's behaviour exactly.

- `sameStem(a, b)` per §2.1.
- `isHubEdge` = either endpoint `size > 22` (a hub edge is never two fascicles).
- Backbone springs: `k * (sameStem || isHubEdge ? 1 : 0.35)`, and for cross-stem
  non-hub edges `restLen * 1.2`. **Keep compression** (a dropped compression term
  re-creates overlaps that the solver then has to pay for, S4).
- 2-hop springs: skip when both endpoints have stems and they differ.
- Anchor, recenter and iteration count unchanged.

### Step 5 — `resolveCollisions`: fascicle clearance (owner: B, file `src/core/graph.ts`)

Keep the two-phase structure, the flat hot-loop arrays and the early exit.
Add two optional knobs, both precomputed into typed arrays once (zero Map lookups
per pair):

```ts
const hasCleft = (opts.cleftPad ?? 0) > 0 && opts.stemOf !== undefined && opts.dominance !== undefined
const stems = Int32Array(count).fill(-1)   // only filled when hasCleft
```

Per pair, in this order (accumulate — never replace an existing pad):

1. same stem (`stems[i] >= 0 && stems[i] === stems[j]`): `minDist = (ra + rb) * 0.88`
2. different stem, both `doms > 0.58`: `minDist += cleftPad`
3. existing sulcus rule: `minDist += sulcus`

`0.88` is safe against S4 because the gate compares `d` with raw `size` while the
solver reserves `reservePx(size) ≥ size` per body plus padding.

**No vector reprojection / tangential slide.** The reference plan's
"radial 1.38 / tangential 0.62" push is measured against the map origin, which is
only aligned with a stem for the outer arms; it distorts the inner ones for no
measurement benefit. Canals come from (1)+(2).

### Step 6 — `bundleEdges`: fascicle spine + late split (owner: B, file `src/core/geometry.ts`)

The renderer evaluates a cubic, so "fuse 86% then split" is approximated by
choosing control points that are **shared per fascicle** where it matters.

1. Precompute, once per call (only when `routes.stemOf` is given):
   `spineOf(fascicleId) => { hub: Pt, dx, dy, maxR }`:
   - `hub` = `ports.get(stemOwner(f))` (the soma port of the group);
   - direction = weighted mean of `(p - hub) * |p - hub|^0.2` over the fascicle's
     nodes (falls back to `{1, 0}` when degenerate);
   - `maxR` = max `|p - hub|` over the fascicle, `>= 1e-6`;
   - `minProj` guard: a fascicle whose nodes are all closer than `2` world units to
     the hub is **not** registered (no spine, no bundling).
2. For an edge that `routesThroughFascicle(a, b)` per §2.1 (and `a`, `b` placed):
   - `proj = dot(b - hub, dir)` clamped to `[0, maxR * 1.15]`;
   - `c1 = hub + dir * (0.30 * maxR)` — **shared by every edge of this fascicle**;
   - `c2 = 0.86 * (hub + dir * proj) + 0.14 * b` — late split near the terminal;
   - `tract = tractFromControls(a, b, c1, c2, fan)` (`fan` unchanged).
3. Everything else keeps today's routing (intra `INTRA_NEAR/FAR_PULL`, cross
   gateway cubic, straight fallback). Cross-nucleus routing is **not** touched.
4. Guards: `a`/`b` missing, or `proj <= 0`, or no spine → today's behaviour.
5. Keep `GATEWAY_CELLS`, `INTRA_*`, `CORRIDOR_FAN` untouched: the existing
   `tests/geometry.test.ts` cases pin them.

### Step 7 — wiring (owner: lead)

- `spread.ts`: pass `stemOf: init.stemOf` to `stressLeaf`; return `init.stemOf` in
  `SpreadResult`. Also pass it through the `< 8 nodes` early return as `undefined`.
- `graph.ts` `layout()`: `zoneOpts` gains `stemOf: figure.stemOf`,
  `cleftPad: 8 * pxToWorld`; both solver phases keep the zone opts;
  `LayoutResult` returns `stemOf: figure.stemOf`.
- `worker.ts`: `bundleEdges(..., { ports, groupOf, stemOf: layoutResult.stemOf })`.

### Step 8 — verification and calibration (owner: lead)

1. `npx vitest run tests/leaf.test.ts tests/geometry.test.ts tests/graph.test.ts`
2. `npm run typecheck`
3. `npx vitest run` — all 253, S1..S9 green.
4. Metric probes from `tests/spread.test.ts` (`spearman`, `knnComponents`, `cvNN`,
   `gridStats`) on synth 271/600: record `rho, kNN, pres@10, CV, voidShare, clump`
   in the STATE file. Target: `rho ≤ -0.5`, `kNN == 1`, `voidShare ≥ 0.15`,
   `clump ≥ 2.0`. Numbers, not adjectives.
5. `node tools/shot-shape.mjs` (or the documented harness) → screenshot; compare
   with `tests/betterwright/shape/leafaspect18-overview.png`.

### Step 9 — cross-review (owner: A reviews B's diff, B reviews A's diff)

Each reviewer reports **only** concrete defects, ≤ 150 words, no restating:
1) unproven assumptions, 2) broken callers/edge cases, 3) contract violations vs
§2, 4) simpler alternative. `LGTM` if none.

---

## 4. File ownership (hard)

| Owner | Files (write) | Reads |
|---|---|---|
| A (`muse-spark-1.3-contributor:high`) | `src/core/leaf.ts`, `tests/leaf.test.ts` | everything |
| B (`deepseek-v4.1-flash:max`) | `src/core/graph.ts`, `src/core/geometry.ts`, `tests/geometry.test.ts`, `tests/graph.test.ts` | everything |
| lead | `src/core/spread.ts`, `src/core/worker.ts`, `src/core/types.ts`, `specs/*`, `AGENTS.md` | everything |

Nobody touches `package.json`, `tsconfig.json`, `vitest.config.ts`, `git`, or a
file owned by someone else. Needing a change outside your set = stop and report.

Writing files in the same working tree in parallel is intentional: the sets are
disjoint. A global `tsc --noEmit` may briefly report errors in the *other* owner's
file — ignore those, they are not yours, and the lead reconciles.

---

## 5. What was actually built, and what the numbers say

### 5.1. Deviations from Steps 1-6, and why

1. **Stem gate is an ownership margin, not `dom > 0.55`.** phi is a softmax at
   temperature `tau`, so with `k` zones a typical word lands near `1/k`. Measured on
   600 nodes: the gate matched only the 8 hubs, `stemOf` had 8 entries, and
   `trunkEdges` was **0/599** — the whole fascia layer was dead code at runtime.
   Replaced with the scale-free margin `(d2-d1)/d2 > 0.4`: 48 stems, 492/599 edges
   trunk-routed. `dominance` (max phi) is still produced unchanged for the sulcus.
2. **Cleft keys on stem presence, not `doms > 0.58`.** Same root cause; the second
   gate kept the clefts permanently off. `CLEFT_DOMINANCE` deleted.
3. **Fascicle union includes slot 0.** The solver's pack/cleft rule now uses the very
   same predicate as routing: equal owner and (`same slot` or either is the soma).
   Before, the cleft fired between a hub and its own leaves.
4. **Pack floor.** `minDist = max(0.88*(ra+rb), max(ra,rb))`: at extreme size ratios
   `0.88*(ra+rb)` can fall below the larger radius. Production radii are `>= 4.6x`
   `size` so it was unreachable, but the floor makes non-overlap provable at any ratio.
5. **`trunkControls` picks the terminal by distance**, not by argument name: edge ids
   are canonicalised min-first, so a hub edge is stored `(leaf, hub)` as often as
   `(hub, leaf)`, and keying on `b` un-bundled about half of every hub's fibres.
6. **Dropped** (kept out of the build, see §1.3): `waypoints` plumbing, five-point
   spline, `enforceNeuralFrame` quantile clamp, tangential vector reprojection.
7. **Post-review fixes:** `owner` now comes from the `d1` argmin instead of
   `argmax phi` (the two diverge under `exp` underflow, sending a trunk to the wrong
   soma); Prim gets a duplicate-id guard (it could loop forever).

### 5.2. Measured (`synth 271`, spread stage, seed 1337)

| metric | before | after | gate |
|---|---|---|---|
| Spearman rho | -0.73 | **-0.857** | <= -0.5 |
| kNN components | 6 | **2** | 1 (gate is on `layout()`) |
| CV | 2.27 | **1.308** | 0.42..0.72 |
| maxVoid | 0.29 | **0.101** | < 0.15 |
| voidShare | 0.71 | **0.358** | 0.04..0.16 |
| preservation@10 | 0.06 | **0.143** (x2.4) | > 0.6 |

Fascicle routing coverage: 492/599 edges (synth 600), 622/798 (mega-hub 600).
Data aspect is exactly 1.80 by construction (stretch-only hold), S1 in [1.6, 2.0].

### 5.3. Known open defects (not fixed in this pass)

- **One ganglion still sits above the band** (`шагризилу` on the synthetic corpus).
  It now carries fused trunks instead of a hairline fan, so it reads as a soma at the
  apex of its tissue rather than a searchlight, but the geometric detachment from the
  plan's §1.2 is still there. Root cause is not established.
- **Ink vs data aspect is unmeasured.** `tools/inkbox.ps1`'s crop is pinned by static
  chrome and a background dot grid: all three screenshots measure an identical box
  (1.53..1.58) at thresholds 48 and 90, so it cannot confirm the ~0.85x claim.
- `CV` and `preservation@10` are still outside their gates; both gates predate the
  leaf grammar and no configuration has met them yet.

