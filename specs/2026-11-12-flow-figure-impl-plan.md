# Flow Figure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace round-lobe placement with flow-field placement so the map reads as one horizontal torn neuron figure with merging fibres.

**Architecture:** Communities (existing voting + balance + affinity order) are released onto a horizontal curved spine and advected a few Euler steps through a seeded curl-noise field; fibres keep the existing cubic-tract shader with stronger FDEB pull; the solver only separates bodies.

**Tech Stack:** TypeScript, graphology (existing), sigma.js v4 custom edge program (existing `pathTract`), vitest, web worker (existing).

**Spec:** `specs/2026-11-12-flow-figure-plan.md` — the plan argues from the spec, so the spec travels with it; executors read both.

## Global Constraints
- No new dependencies (plan A: vanilla TS + graphology + sigma only).
- No network calls with chat data (any fetch with chat content is forbidden).
- Never commit a real chat export (only synthetic `tests/fixtures/`).
- No gradients, glows, emoji, shadows, marketing copy in UI; Russian telegraphic UI texts.
- Tests only on `src/core/` (pure logic), vitest; UI verified via `tools/shot-shape.mjs` + screenshots.
- File-scoped validation only (`npx vitest run tests/graph.test.ts`, `npm run typecheck`); full preflight (`typecheck && test && build`) before "done".
- Minimal code: nothing speculative; each step verified before the next.
- Determinism: identical seed + input = byte-identical positions (cached frames reuse them verbatim).

## Review Focus
- Filter updates add new words while reusing the cached frame (`reuseFrame`, `structural=false`): newcomers must be seated by the new pipeline without moving cached nodes, or the map scrambles on every filter switch — pinned by Task 4.
- A single dominant hub (85% of links) must not collapse into one disc — the existing balance cap guards it; Task 3 verification re-runs the MEGA bench.
- Fewer than 24 nodes: every new function must no-op (guards), covered by Task 1–3 tests.
- 1000-node perf: layout must stay within ~3s (bench), checked in Task 3 and Task 6.
- Far spray must not own the frame: the renderer fits the full extent, so post-scatter squeeze stays; Task 3 keeps the existing squeeze call untouched.

---

### Task 1: Flow field + spine primitives

**Files:**
- Modify: `src/core/graph.ts` (append near `fractalNoise`, ~line 140-180)
- Test: `tests/graph.test.ts` (new `describe('flowField')`)

**Interfaces:**
- Consumes: existing `valueNoise(x: number, y: number, seed: number): number`, `fractalNoise(angle: number, radius: number, phases: number[]): number`.
- Produces (used by Task 3):
  - `export function flowSample(x: number, y: number, phases: number[], seed: number): { dx: number; dy: number }`
  - `export function spinePoint(t: number, phases: number[], maxR: number): { x: number; y: number }`

- [ ] **Step 1: Write the failing tests**

```ts
describe('flowField (поток вместо дисков)', () => {
  it('детерминирован и ограничен', () => {
    const a = flowSample(0.3, -0.7, [0.1, 0.2, 0.3], 42)
    expect(flowSample(0.3, -0.7, [0.1, 0.2, 0.3], 42)).toEqual(a)
    expect(Math.hypot(a.dx, a.dy)).toBeLessThanOrEqual(1.0001)
    expect(Math.hypot(a.dx, a.dy)).toBeGreaterThan(0.05)
  })
  it('spinePoint идёт слева направо с изгибом', () => {
    const l = spinePoint(0, [0.1, 0.2, 0.3], 1000)
    const r = spinePoint(1, [0.1, 0.2, 0.3], 1000)
    expect(l.x).toBeLessThan(r.x)
    expect(spinePoint(0.5, [0.1, 0.2, 0.3], 1000)).toEqual(spinePoint(0.5, [0.1, 0.2, 0.3], 1000))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts -t "flowField"`
Expected: FAIL with "flowSample is not defined"

- [ ] **Step 3: Implement in `src/core/graph.ts`**

`flowSample`: curl of the existing noise — sample `fractalNoise` for potential `psi` at `(x+e,y)`, `(x-e,y)`, `(x,y+e)`, `(x,y-e)` with `e=0.05`, return normalized `(-dpsi_dy, dpsi_dx)`; zero fallback `(1,0)` if degenerate. `spinePoint(t, phases, maxR)`: `x = (t - 0.42) * 2 * 1.05 * maxR`, `y = maxR * 0.35 * Math.sin(t * Math.PI * 1.3 + (phases[0] ?? 0) * 2 * Math.PI)` clamped to `[-maxR, maxR]`. Both Commands? No — pure Queries (no mutation), document as such.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph.test.ts -t "flowField"`
Expected: PASS

### Task 2: Community advection placement

**Files:**
- Modify: `src/core/graph.ts` (append after `placeGroupsOnRing`)
- Test: `tests/graph.test.ts` (new `describe('placeGroupsOnFlow')`)

**Interfaces:**
- Consumes: `flowSample`, `spinePoint` (Task 1); groups as `string[][]` + `order: number[]` (same shapes as `placeGroupsOnRing`); node points `{ id, x, y }`.
- Produces (used by Task 3):
  - `export function placeGroupsOnFlow(nodes: Array<{ id: number; x: number; y: number }>, groups: string[][], order: number[], phases: number[], maxR: number, seed: number): void`

- [ ] **Step 1: Write the failing tests**

```ts
describe('placeGroupsOnFlow (сообщества вдоль ствола)', () => {
  const pts = (): Array<{ id: number; x: number; y: number }> =>
    Array.from({ length: 20 }, (_, i) => ({ id: i, x: (i % 5) * 10, y: Math.floor(i / 5) * 10 }))
  const groups = [Array.from({ length: 10 }, (_, i) => String(i)), Array.from({ length: 10 }, (_, i) => String(10 + i))]
  it('держит сообщество вместе и детерминирован', () => {
    const nodes = pts()
    placeGroupsOnFlow(nodes, groups, [0, 1], [0.2, 0.5, 0.8], 500, 7)
    const centroid = (ks: string[]) => {
      let x = 0, y = 0
      for (const k of ks) { const p = nodes[Number(k)]; x += p.x; y += p.y }
      return { x: x / ks.length, y: y / ks.length }
    }
    const c0 = centroid(groups[0]); const c1 = centroid(groups[1])
    // Head group sits left of the tail group.
    expect(c0.x).toBeLessThan(c1.x)
    const again = pts()
    placeGroupsOnFlow(again, groups, [0, 1], [0.2, 0.5, 0.8], 500, 7)
    expect(again).toEqual(nodes)
  })
  it('no-op на вырожденном входе', () => {
    const nodes = pts()
    const before = nodes.map((p) => ({ ...p }))
    placeGroupsOnFlow(nodes, [], [], [0.1], 500, 7)
    placeGroupsOnFlow(nodes, groups, [0], [0.1], 500, 7)
    placeGroupsOnFlow(nodes, groups, [0, 1], [0.1], 0, 7)
    expect(nodes).toEqual(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts -t "placeGroupsOnFlow"`
Expected: FAIL with "placeGroupsOnFlow is not defined"

- [ ] **Step 3: Implement `placeGroupsOnFlow` in `src/core/graph.ts`**

For each group in `order` order: `t = pos / max(1, count - 1)`; release centre = `spinePoint(t, …)`; release radius = `0.35 * maxR / Math.sqrt(count)`; per member (deterministic index `k`): release point = centre + disk jitter from `hash2(k, seed)`; advect 3 Euler steps of `0.08 * maxR` along `flowSample`; write final point. Document as Command (mutates points).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph.test.ts -t "placeGroupsOnFlow"`
Expected: PASS

### Task 3: Wire flow placement into `layout()`

**Files:**
- Modify: `src/core/graph.ts` (`layout()`, step 5 area — replaces lobe-site + sub-ring placement, keeps voting/balance/affinity/sublobe-assignment)
- Test: existing gates in `tests/graph.test.ts` (`(l)`, `(l2)`, `(n)`, dust test)

**Interfaces:**
- Consumes: `lobeLabels` (existing), `subOf` via existing `subOut` param, `terminalGroups` (existing), `orderGroupsByAffinity` (existing), `placeGroupsOnFlow` (Task 2).
- Produces: positions via existing `{ positions, iterationsDone }` return.

- [ ] **Step 1: Run gates to record the baseline (they pass now)**

Run: `npx vitest run tests/graph.test.ts`
Expected: PASS (49 tests) — baseline before rewiring.

- [ ] **Step 2: Rewire placement: terminal groups → affinity order → flow**

Replace the `scatterLobes`-site + sub-ring positioning effect for the full-run path with: `terminalGroups(lobeLabels, subOf, 60)` → `orderGroupsByAffinity(graph, groups)` → `placeGroupsOnFlow(positionedNodes, groups, order, shapePhases, trunkR, seed)`, where `trunkR` is the current max radius (same computation as today). Keep `scatterLobes`/`scatterSublobes` calls (assignment + tests rely on them); their site writes become the intermediate the flow pass overwrites. Keep scatter/squeeze/solve calls untouched.

- [ ] **Step 3: Run gates + bench**

Run: `npx vitest run tests/graph.test.ts` — Expected: PASS, all 49+.
Run: `BENCH=1 npx vitest run tests/bench-tmp-shape.test.ts --reporter=verbose --silent=false` — record CE/clump/fill/E; CE direction must not regress vs 0.68/0.63 (600/1000) by more than 0.1 or stop and report.

### Task 4: Seat newcomers on filter updates without moving the cached frame

**Files:**
- Modify: `src/core/graph.ts` (`layout()`, incremental path)
- Test: `tests/graph.test.ts` (extend `(n)`-style: new test `(n2)`)

**Interfaces:**
- Consumes: `lobeLabels` of cached nodes (recompute voting on the kept graph), `placeGroupsOnFlow` (Task 2).
- Produces: newcomers placed near their voted group; cached nodes byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
it('(n2) новые слова садятся к своей группе, кэш не едет', () => {
  // full run on 240, then incremental with 60 new words attached to old hubs;
  // kept nodes byte-identical, new nodes within group spread of their hub.
})
```
(Exact assertion style mirrors test `(n)`: reuse `mixedNodes`/`hubEdges`, attach new leaves to hubs 1..12, assert `kept` positions `toEqual` prev and each newcomer within `3 * groupRadius` of its hub.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts -t "(n2)"`
Expected: FAIL (newcomers land at FA2 spots / `toEqual` breaks or distance assertion fails).

- [ ] **Step 3: Implement newcomer seating in the `reuseFrame` branch**

For nodes without `prevXY`: vote group by heaviest-neighbour edge into cached labels (reuse `voteLobes` with seeds = one representative key per cached group, 1 round, scope = full label map), then advect from that group's current centroid via `flowSample` (3 steps, same as Task 2). Cached nodes untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph.test.ts -t "(n2)"`
Expected: PASS

### Task 5: Turn up fibre bundling (curves that merge)

**Files:**
- Modify: `src/core/geometry.ts` (`bundleEdges` pull coefficients)
- Test: `tests/geometry.test.ts` (bundle convergence unit test) + стенд screenshot

**Interfaces:**
- Consumes: existing `bundleEdges(points, edges, maxWeight)` return `{ tract, bundle, rank, tractRank }`.
- Produces: same shapes, stronger pull (exact numbers below).

- [ ] **Step 1: Write the failing test**

Assert on a synthetic fan (1 hub + 6 leaves, parallel directions): after `bundleEdges`, the middle-third control points (tract[0..1] vs tract[2..3] decoded per the `(delta, perp)` basis documented in `neural.ts`) of same-sector fibres lie closer together than the straight-line positions (i.e. pull > 0 and monotonic in sector alignment). Mirror the existing bundle test style in `tests/geometry.test.ts` (check current imports first).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/geometry.test.ts -t "bundle"`
Expected: FAIL with the current pull values.

- [ ] **Step 3: Raise pull `base` 0.78/0.92/0.82 → 0.88/0.97/0.92 in `bundleEdges`**

One-line-per-pass change only; do NOT touch sector logic, ranks, or the shader.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/geometry.test.ts -t "bundle"`
Expected: PASS

- [ ] **Step 5: Стенд mesh-check (one tune iteration max)**

Run: `node tools/shot-shape.mjs flow 900 4000 600`, view `flow-overview.png`. If grey mesh returns, dial `quiet` floor 0.30 → 0.22 once and re-shoot; if still mesh, stop and report (do not chase).

### Task 6: Preflight, стенд, spec update, report

**Files:**
- Modify: `specs/2026-11-12-flow-figure-plan.md` (append round: measured numbers)
- Test: full suite + стенд screenshots

- [ ] **Step 1: Full preflight**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 0 errors, all green (2 skipped pre-existing), build ok.

- [ ] **Step 2: Стенд + screenshots for the user verdict**

Run: `node tools/shot-shape.mjs flow 900 4000 600`, read `flow-overview.png` + `flow-zoom-2.png`, confirm: horizontal figure, head left, spray, black voids, merging curved fibres.

- [ ] **Step 3: Report**

Post the 3–4 line summary (approach delta, verification commands + results, state) and the reload instruction (close map → reopen page → reopen export). No code in this step.
