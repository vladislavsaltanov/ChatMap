# Ponytail Audit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 15 findings from the 2026-11-10 `ponytail-audit` report without changing the app architecture or adding dependencies.

**Architecture:** Keep the current split: pure logic in `src/core/`, heavy work in the Web Worker, drawing on the main thread. Fix each trust boundary in a small vertical slice. UI-only state sequences are checked manually in a DEV browser through the existing `window.__mapview` hook; `tools/e2e-headless.mjs fixture` is only a smoke check.

**Tech Stack:** TypeScript 5.9.3, Vite 8.3.5, Vitest 5.0.5, Sigma 4.0.4, graphology 0.26.0, graphology-layout-forceatlas2 0.10.1, @sigma/export-image 4.0.0.

**Spec:** `specs/2026-11-10-ponytail-audit-fix-design.md`

## Global Constraints

- `Preflight зелёный до следующего шага`: `npm run typecheck && npm run test && npm run build`.
- `Тесты только на src/core/ (чистая логика), vitest`; UI и sigma — ручная проверка по критериям этапов.
- `Тяжёлые вычисления — в воркере; main рисует`.
- `Никогда не отправлять данные чата по сети`.
- `Никогда не коммитить реальный экспорт чата — только синтетическая tests/fixtures/`.
- `Никаких UI-фреймворков и лишних зависимостей`.
- `Интерфейс и тексты — на русском, телеграфно`.
- Комментарии и docstrings в коде — строго на английском, короткие и технические.
- `Conventional Commits`; `main` защищена; найденный дефект — отдельным коммитом.
- File-scoped validation на каждом шаге; полный Preflight — только на completion gate.
- Не добавлять новые режимы в `tools/e2e-headless.mjs`; только `fixture` smoke и ручные DevTools-проверки A/B/C.

## Review Focus

1. **Failed open + pending filter update:** open A, start a 150 ms filter change, open bad B; no `map` screen may follow the error. Pinned to Task 1, Step 2: manual DevTools check A.
2. **Hover/pin state across a new file:** pin a word in A, open B; B must open with `dimAlpha=0`, `focusAlpha=0`, `hasActiveSubgraph=false`, `pinnedId=null`. Pinned to Task 2, Step 2: manual DevTools check B.
3. **Hostile numeric strings in JSON:** `id: "1e3"`, `date_unixtime: "1e309"`, and `reply_to_message_id: "123"` must not create Infinity, null replies, or duplicate ids. Pinned to Task 3, Step 2: `npx vitest run tests/parse.test.ts`.
4. **Token id overflow:** at `MAX_TOKEN_ID + 1`, `Intern.intern()` and `edgeKey()` must throw `RangeError`; id `MAX_TOKEN_ID` stays valid. Pinned to Task 4, Step 2: `npx vitest run tests/tally.test.ts tests/canon.test.ts`.
5. **Storage write failure:** when `localStorage.setItem` throws, the node panel keeps the old label. Pinned to Task 6, Step 5: manual DevTools storage-failure check.

---

### Task 1: Reset worker state before a new file is parsed

**Files:**
- Modify: `src/core/worker.ts:198-246`
- Check: manual DevTools check A
- Commit: `fix(worker): reset state before parsing a new file`

**Interfaces:**
- Consumes: module-level `chat`, `pipelineCache`, `positionsCache`, `PipelineCache`, `parse()`.
- Produces: `resetWorkerState(): void`, private to `worker.ts`; `chat` is assigned only from a local `nextChat` after `parse()` succeeds.

- [ ] **Step 1: Define manual DevTools check A**

On `http://127.0.0.1:5173/?fixture=1`, wait for the map, then paste:

```js
(async () => {
  const input = document.querySelector('#file-input')
  const dt = new DataTransfer()
  dt.items.add(new File(['<html>'], 'bad.json', { type: 'application/json' }))
  document.querySelector('#filter-mat').dispatchEvent(new Event('change', { bubbles: true }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 300))
  return { errorOpen: document.querySelector('#error').open, mapHidden: document.querySelector('#map').hidden }
})()
```

- [ ] **Step 2: Run it to verify it fails**

Run: paste check A in the DevTools console.
Expected: FAIL with `{ errorOpen: true, mapHidden: false }` — the stale map came back.

- [ ] **Step 3: Implement `resetWorkerState()` in `src/core/worker.ts`**

Add the private function, call it as the first action inside `msg.type === 'open'`, and replace `chat = parse(...)` with `const nextChat = parse(...)` followed by `chat = nextChat`. The function sets `chat = null`, `pipelineCache = new PipelineCache()`, and `positionsCache.clear()`.

- [ ] **Step 4: Re-run check A and file-scoped diff check**

Run: check A again; then `git diff --check -- src/core/worker.ts`.
Expected: PASS with `{ errorOpen: true, mapHidden: true }`, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/worker.ts
git commit -m "fix(worker): reset state before parsing a new file"
```

### Task 2: Clear interaction state when a new map renders

**Files:**
- Modify: `src/ui/mapview.ts:513-617`
- Check: manual DevTools check B
- Commit: `fix(ui): clear interaction state before rendering a new chat`

**Interfaces:**
- Consumes: `SubgraphHighlight`, `SubgraphAnimator`, `Sigma.setGraphState`, `pinnedId`, `subgraphKey`.
- Produces: `private resetInteractionState(): void`, called at the top of `render(msg: MapMsg)`.

- [ ] **Step 1: Define manual DevTools check B**

On `?fixture=1`, wait for the map, then paste:

```js
(async () => {
  const mv = window.__mapview
  mv.pin(Number(mv.graph.nodes()[0]))
  const input = document.querySelector('#file-input')
  const dt = new DataTransfer()
  const json = JSON.stringify({ messages: [{ id: 1, from: 'A', from_id: 'user1', date: '2024-01-01T00:00:00', text: 'дом кот' }] })
  dt.items.add(new File([json], 'b.json', { type: 'application/json' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 800))
  const g = mv.renderer.getGraphState()
  return { dimAlpha: g.dimAlpha, focusAlpha: g.focusAlpha, hasActiveSubgraph: g.hasActiveSubgraph, pinnedId: mv.pinnedId }
})()
```

- [ ] **Step 2: Run it to verify it fails**

Run: paste check B in the DevTools console.
Expected: FAIL with `dimAlpha > 0`, `hasActiveSubgraph: true`, or `pinnedId !== null`.

- [ ] **Step 3: Implement `resetInteractionState()` in `src/ui/mapview.ts`**

The method calls `highlight.clear(renderer)`, `animator.jump('dim', 0)`, `animator.jump('focus', 0)`, `animator.jump('release', 0)`, sets `pinnedId = null`, `subgraphKey = null`, and writes `hasActiveSubgraph:false`, `dimAlpha:0`, `focusAlpha:0`, `releaseAlpha:0`, `pinActive:false`. Call it before `this.graph.clear()`.

- [ ] **Step 4: Re-run check B and file-scoped diff check**

Run: check B again; then `git diff --check -- src/ui/mapview.ts`.
Expected: PASS with all zeros, `false`, and `null`, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/mapview.ts
git commit -m "fix(ui): clear interaction state before rendering a new chat"
```

### Task 3: Parse numeric export fields at the boundary

**Files:**
- Modify: `src/core/parse.ts:46-62`, `src/core/parse.ts:150-163`
- Test: `tests/parse.test.ts`
- Commit: `fix(core): parse numeric export fields at the boundary`

**Interfaces:**
- Consumes: `RawMessage`, `parseDateMs`, `Date.parse`.
- Produces:
```ts
export function parsePositiveInt(value: unknown): number | null
export function parseFinitePositiveNumber(value: unknown): number | null
```

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects exponent ids and infinity dates, accepts digit-only strings', () => {
  expect(parsePositiveInt('1e3')).toBeNull()
  expect(parsePositiveInt('123')).toBe(123)
  expect(parseFinitePositiveNumber('1e309')).toBeNull()
  expect(parseFinitePositiveNumber(Infinity)).toBeNull()
})

it('keeps a string reply id', () => {
  const chat = parse(JSON.stringify({ messages: [{ id: 1, reply_to_message_id: '123', text: 'x' }] }))
  expect(chat.messages[0].replyTo).toBe(123)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parse.test.ts`
Expected: FAIL with missing helpers and null `replyTo`.

- [ ] **Step 3: Implement both helpers in `src/core/parse.ts`**

`parsePositiveInt` accepts finite integers `> 0` and digit-only strings. `parseFinitePositiveNumber` accepts finite numbers `> 0` and digit-only strings. Use them for `id`, `reply_to_message_id`, `date_unixtime`, and numeric `date`; keep ISO strings on `Date.parse`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parse.test.ts && git diff --check -- src/core/parse.ts tests/parse.test.ts`
Expected: PASS, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/parse.ts tests/parse.test.ts
git commit -m "fix(core): parse numeric export fields at the boundary"
```

### Task 4: Bound interned token ids and pair keys

**Files:**
- Modify: `src/core/intern.ts:1-43`, `src/core/tally.ts:35-46`
- Test: `tests/tally.test.ts`, `tests/canon.test.ts`
- Commit: `fix(core): bound interned token ids`

**Interfaces:**
- Consumes: `TokClass`, `canon`, `Intern`.
- Produces:
```ts
export const MAX_TOKEN_ID: number = 2 ** 24 - 1
export function edgeKey(a: number, b: number): number // throws RangeError outside [1, MAX_TOKEN_ID]
```

- [ ] **Step 1: Write the failing tests**

```ts
it('throws before pair keys can collide', () => {
  expect(() => edgeKey(1, MAX_TOKEN_ID + 1)).toThrow(RangeError)
  expect(parseEdgeKey(edgeKey(MAX_TOKEN_ID - 1, MAX_TOKEN_ID))).toEqual([MAX_TOKEN_ID - 1, MAX_TOKEN_ID])
})

it('assigns the last valid id, then throws', () => {
  const ia = new Intern()
  Reflect.set(ia, 'nextId', MAX_TOKEN_ID)
  expect(ia.intern('last', 'plain').id).toBe(MAX_TOKEN_ID)
  expect(() => ia.intern('overflow', 'plain')).toThrow(RangeError)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tally.test.ts tests/canon.test.ts`
Expected: FAIL with `MAX_TOKEN_ID is not defined` or no throw.

- [ ] **Step 3: Implement the guard**

Export `MAX_TOKEN_ID` from `src/core/intern.ts`, throw `RangeError` in `intern()` only when `nextId > MAX_TOKEN_ID`, import the constant into `src/core/tally.ts`, set `KEY_BASE = MAX_TOKEN_ID + 1`, and make `edgeKey()` reject non-integer or out-of-range ids.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tally.test.ts tests/canon.test.ts && git diff --check -- src/core/intern.ts src/core/tally.ts tests/tally.test.ts tests/canon.test.ts`
Expected: PASS, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/intern.ts src/core/tally.ts tests/tally.test.ts tests/canon.test.ts
git commit -m "fix(core): bound interned token ids"
```

### Task 5: Use production filter rules in the tally oracle

**Files:**
- Modify: `src/core/tally.ts:291-298`
- Test: `tests/tally.test.ts:267-278`
- Commit: `test(core): use production drop rules in oracle`

**Interfaces:**
- Consumes: `FilterCfg`, `Tok`, `isStopword`, `matchesMat`, `matchesLaugh`.
- Produces: `export function dropFor(cfg: FilterCfg): (t: Tok) => boolean`.

- [ ] **Step 1: Write the failing import**

Replace the local oracle `dropFor` with `import { dropFor } from '../src/core/tally'` and keep the existing `oracle()` assertions unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tally.test.ts`
Expected: FAIL with `dropFor is not exported`.

- [ ] **Step 3: Export `dropFor`**

Add `export` to the existing function in `src/core/tally.ts`. Delete the 7-line duplicate from `tests/tally.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tally.test.ts && git diff --check -- src/core/tally.ts tests/tally.test.ts`
Expected: PASS, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/tally.ts tests/tally.test.ts
git commit -m "test(core): use production drop rules in oracle"
```

### Task 6: Make label override writes observable without CQS violation

**Files:**
- Modify: `src/core/labelOverrides.ts`, `src/ui/nodepanel.ts:1-33`, `src/ui/nodepanel.ts:130-144`
- Test: `tests/labelOverrides.test.ts`
- Commit: `fix(core): report label override write failures`

**Interfaces:**
- Consumes: `parseLabelOverrides`, `isOverridableKey`, `localStorage`.
- Produces:
```ts
export type LabelOverrideChange = [key: string, label: string | null]
export function applyLabelOverrides(raw: string | null, changes: LabelOverrideChange[]): string | null
// UI shell only:
function commitLabelOverrides(changes: LabelOverrideChange[]): void // throws on storage failure
```

- [ ] **Step 1: Write the failing tests**

```ts
it('applies several changes in one serialization', () => {
  expect(applyLabelOverrides('{"a":"x","b":"y"}', [['a', null], ['b', null]])).toBe('{}')
  expect(applyLabelOverrides(null, [['дом', 'домик']])).toBe('{"дом":"домик"}')
})

it('rejects forbidden keys for save and clear', () => {
  expect(applyLabelOverrides(null, [['__proto__', 'x']])).toBeNull()
  expect(applyLabelOverrides(null, [['__proto__', null]])).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/labelOverrides.test.ts`
Expected: FAIL with `applyLabelOverrides is not defined`.

- [ ] **Step 3: Implement pure core Query and UI Command**

In `src/core/labelOverrides.ts`, `applyLabelOverrides` parses once, checks every key with `isOverridableKey`, applies all set/delete changes, and returns one JSON string or `null`. In `src/ui/nodepanel.ts`, `commitLabelOverrides` reads `localStorage` once, calls the pure function, writes once, and throws on storage error; it returns no data. `renderForms()` catches the error and keeps the old label. `autoBtn` calls `commitLabelOverrides([[canon, null], [label, null], [defaultLabel, null]])` once.

- [ ] **Step 4: Run unit tests and diff check**

Run: `npx vitest run tests/labelOverrides.test.ts && git diff --check -- src/core/labelOverrides.ts src/ui/nodepanel.ts tests/labelOverrides.test.ts`
Expected: PASS, no diff-check errors.

- [ ] **Step 5: Run the manual storage-failure check**

Pin a node, then paste in DevTools:

```js
(() => {
  const orig = Storage.prototype.setItem
  const before = document.querySelector('#node-title').textContent
  Storage.prototype.setItem = () => { throw new Error('quota') }
  document.querySelector('.form-btn')?.click()
  const after = document.querySelector('#node-title').textContent
  Storage.prototype.setItem = orig
  return { before, after, unchanged: before === after }
})()
```

Expected before fix: `{ unchanged: false }`; after fix: `{ unchanged: true }`.

- [ ] **Step 6: Commit**

```bash
git add src/core/labelOverrides.ts src/ui/nodepanel.ts tests/labelOverrides.test.ts
git commit -m "fix(core): report label override write failures"
```

### Task 7: Index collision candidates by grid

**Files:**
- Modify: `src/core/graph.ts:262-330`
- Test: `tests/graph.test.ts`
- Commit: `perf(core): index collision candidates by grid`

**Interfaces:**
- Consumes: `resolveCollisions`, `MAX_SCALE_FACTOR`, `padScale`.
- Produces:
```ts
export function collisionCandidatePairs(
  nodes: Array<{ x: number; y: number; size?: number }>,
  padding: number,
  scaleFactor: number,
  padScale: ((size: number) => number) | null,
): Array<[number, number]>
```

- [ ] **Step 1: Write the failing tests**

Build 1000 well-spread nodes. Assert `collisionCandidatePairs(...).length < nodes.length * 12`. Move one node by 1000 units and assert the candidate list changes, proving it reads current positions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph.test.ts`
Expected: FAIL with `collisionCandidatePairs is not defined`.

- [ ] **Step 3: Implement the grid helper in `src/core/graph.ts`**

Use a `Map<string, number[]>` keyed by `Math.floor(x / CELL):Math.floor(y / CELL)` with `CELL = 120`. Call `collisionCandidatePairs` at the start of every `resolveCollisions` pass, from current positions; never reuse the list across passes. Replace the `i/j` double loop with the candidate list; keep the existing shift math and early break unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph.test.ts && git diff --check -- src/core/graph.ts tests/graph.test.ts`
Expected: PASS, 600-node clearance test still passes, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph.ts tests/graph.test.ts
git commit -m "perf(core): index collision candidates by grid"
```

### Task 8: Split `runPipeline` by job

**Files:**
- Modify: `src/core/worker.ts:38-196`
- Check: `node tools/e2e-headless.mjs fixture`
- Commit: `refactor(core): split worker pipeline by job`

**Interfaces:**
- Consumes: `PipelineCache`, `select`, `pruneSortedBackbone`, `layout`, `bundleEdges`, `buildArmsIndex`, `MapMsg`.
- Produces, all private to `worker.ts`:
```ts
type NodeInfo = { bestForm: string; forms: Array<[string, number]>; size: number }
type PipelineData = { ia: Intern; tallyResult: TallyResult; merged?: Map<number, number> }
function resolveData(chat: ChatExport, cfg: FilterCfg, callbacks: PipelineCallbacks): PipelineData
function buildLayoutInput(
  selection: Selection,
  ia: Intern,
  positionsCache: Map<string, { x: number; y: number }>,
): { layoutNodes: LayoutNodeInput[]; backboneEdges: SelectionEdge[]; nodeInfoMap: Map<number, NodeInfo> }
function buildMapMessage(
  selection: Selection,
  layoutResult: LayoutResult,
  ia: Intern,
  tallyResult: TallyResult,
  backboneEdges: SelectionEdge[],
  nodeInfoMap: Map<number, NodeInfo>,
): MapMsg
```

- [ ] **Step 1: Record the current browser smoke result**

Run: `node tools/e2e-headless.mjs fixture`
Expected: PASS, map renders from the synthetic fixture.

- [ ] **Step 2: Extract `resolveData`**

Move only the `pipelineCache.resolve(...)` call and its callbacks into the new function. Keep message order unchanged.

- [ ] **Step 3: Extract `buildLayoutInput`**

Move node-form sizing, `prevXY`, and `pruneSortedBackbone` into the new function. Keep `MAX_POS_CACHE` and `seed: 1337` in `runPipeline`.

- [ ] **Step 4: Extract `buildMapMessage`**

Move `bundleEdges`, `buildArmsIndex`, node/edge construction, and the final `WorkerOut` object into the new function. Keep progress messages in `runPipeline`.

- [ ] **Step 5: Verify the refactor**

Run: `node tools/e2e-headless.mjs fixture && npx vitest run tests/tally.test.ts tests/select.test.ts tests/graph.test.ts && git diff --check -- src/core/worker.ts`
Expected: PASS, same fixture map, no diff-check errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/worker.ts
git commit -m "refactor(core): split worker pipeline by job"
```

### Task 9: Remove per-pair Set allocations in tally

**Files:**
- Modify: `src/core/tally.ts:235-283`
- Test: `tests/tally.test.ts`
- Commit: `perf(core): reuse adjacency stamps`

**Interfaces:**
- Consumes: `edgeKey`, `addPair`, `intraMaxList`, `unitsByMsgId`.
- Produces: no new exported API; local `seenStamp: Map<number, number>` and `stamp: number` replace `seen` and `seenReply`.

- [ ] **Step 1: Add the regression assertion**

Add one test that builds two adjacent messages with repeated token pairs and asserts the repeated pair appears exactly once.

- [ ] **Step 2: Run tests to verify they pass before refactor**

Run: `npx vitest run tests/tally.test.ts`
Expected: PASS; this records the baseline.

- [ ] **Step 3: Replace both Sets**

Use one stamp map per outer loop; increment `stamp` for each message pair or reply target. Treat a key as seen only when `seenStamp.get(key) === stamp`. Keep `prevA.has(key)` and `prevB.has(key)` probes unchanged.

- [ ] **Step 4: Run tests to verify they still pass**

Run: `npx vitest run tests/tally.test.ts && git diff --check -- src/core/tally.ts tests/tally.test.ts`
Expected: PASS, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/tally.ts tests/tally.test.ts
git commit -m "perf(core): reuse adjacency stamps"
```

### Task 10: Inline the one-caller debounce

**Files:**
- Modify: `src/ui/controls.ts:1-3`, `src/ui/controls.ts:87-92`
- Delete: `src/core/debounce.ts`, `tests/debounce.test.ts`
- Check: manual DevTools check C
- Commit: `refactor(ui): inline one-shot debounce`

**Interfaces:**
- Consumes: `getCfg`, `changeCallbacks`.
- Produces: `private changeTimer: number | null = null` and `private debouncedTriggerChange(): void` inside `Controls`.

- [ ] **Step 1: Define manual DevTools check C**

```js
(() => {
  const orig = Worker.prototype.postMessage
  let updates = 0
  Worker.prototype.postMessage = function (msg, ...rest) {
    if (msg?.type === 'update') updates++
    return orig.call(this, msg, ...rest)
  }
  const slider = document.querySelector('#slider-top-n')
  for (let i = 0; i < 3; i++) {
    slider.value = String(600 + i * 50)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return new Promise(resolve => setTimeout(() => {
    Worker.prototype.postMessage = orig
    resolve({ updates })
  }, 300))
})()
```

- [ ] **Step 2: Run it to verify current behavior**

Run: paste check C in DevTools.
Expected: `{ updates: 1 }`.

- [ ] **Step 3: Inline the timer and delete both files**

Replace the `debounce(...)` field with the two private members. Remove the import from `src/ui/controls.ts`, then delete `src/core/debounce.ts` and `tests/debounce.test.ts`.

- [ ] **Step 4: Re-run check C and diff checks**

Run: check C, `npx vitest run tests/tally.test.ts`, and `git diff --check -- src/ui/controls.ts`.
Expected: `{ updates: 1 }`, no references to `../core/debounce`, no diff-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/controls.ts src/core/debounce.ts tests/debounce.test.ts
git commit -m "refactor(ui): inline one-shot debounce"
```

### Task 11: Correct the stale collision comment

**Files:**
- Modify: `src/core/graph.ts:591`
- Commit: `docs(core): correct collision test comment`

**Interfaces:** None.

- [ ] **Step 1: Replace the comment**

Change `Test graphs stay under 271 nodes, so this branch is prod-only` to `The 600-node test covers the large-map branch`.

- [ ] **Step 2: Verify**

Run: `rg -n "test graphs stay under 271" src/core/graph.ts; git diff --check -- src/core/graph.ts`
Expected: no matches from `rg`, no diff-check errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/graph.ts
git commit -m "docs(core): correct collision test comment"
```

### Task 12: Completion gate and verification report

**Files:**
- Create: `specs/verifications/2026-11-10-ponytail-audit-fix.md`
- Modify: `.pi/active-task.md`
- Commit: `docs: record ponytail audit fix verification`

**Interfaces:**
- Consumes: all previous task commits, `HANDOFF.md`, `CONVENTIONS.md`.
- Produces: a verification table with 15 findings, exact command outputs, and `[STATUS: COMPLETED]`.

- [ ] **Step 1: Run the full preflight**

Run: `npm run typecheck && npm run test && npm run build`
Expected: 0 type errors, 193+ tests passing, build exit 0.

- [ ] **Step 2: Run the smoke and manual checks**

Run: `node tools/e2e-headless.mjs fixture`. Then repeat manual checks A, B, C, and the Task 6 storage-failure check. Expected: all PASS.

- [ ] **Step 3: Run the 1000-node manual check**

Load a 1000-node synthetic map and confirm the worker finishes without a visible freeze. Record the result in the verification doc.

- [ ] **Step 4: Write the verification report**

Create `specs/verifications/2026-11-10-ponytail-audit-fix.md` with one row per finding: audit number, fix task, command or manual check, and observed result. State the preflight counts and the manual results.

- [ ] **Step 5: Update state and check the tree**

Set `[STATUS: COMPLETED]` in `.pi/active-task.md`. Run `git diff --check && git status --short`. Expected: only intended files, no real exports, no `dist/`, no temp logs.

- [ ] **Step 6: Commit**

```bash
git add specs/verifications/2026-11-10-ponytail-audit-fix.md .pi/active-task.md
git commit -m "docs: record ponytail audit fix verification"
```

## Coverage map

| Audit # | Task | Verification |
| --- | --- | --- |
| 1 | 1 | manual DevTools check A |
| 2 | 2 | manual DevTools check B |
| 3 | 3 | `npx vitest run tests/parse.test.ts` |
| 4 | 4 | `npx vitest run tests/tally.test.ts tests/canon.test.ts` |
| 5 | 1 | manual DevTools check A |
| 6 | 4 | `npx vitest run tests/tally.test.ts tests/canon.test.ts` |
| 7 | 5 | `npx vitest run tests/tally.test.ts` |
| 8 | 6 | unit tests + manual storage-failure check |
| 9 | 7 | `npx vitest run tests/graph.test.ts` |
| 10 | 8 | `node tools/e2e-headless.mjs fixture` + core suites |
| 11 | 2 | manual DevTools check B |
| 12 | 11 | `rg -n "test graphs stay under 271"` |
| 13 | 9 | `npx vitest run tests/tally.test.ts` |
| 14 | 10 | manual DevTools check C |
| 15 | 6 | unit tests + manual storage-failure check |

## Self-review

- **Spec coverage:** all 15 findings map to a task; the 3 omitted wording-only notes stay out of scope.
- **Step scan:** each step names one action, one command, and one expected result; no step says `TBD` or `handle edge cases`.
- **Type consistency:** `MAX_TOKEN_ID`, `KEY_BASE`, `dropFor`, `applyLabelOverrides`, `LabelOverrideChange`, `commitLabelOverrides`, `collisionCandidatePairs`, `resolveData`, `buildLayoutInput`, and `buildMapMessage` keep the same names in every task.
- **Review Focus:** all five failure modes have a named check in Tasks 1, 2, 3, 4, and 6.
- **Proportion:** the plan fixes decisions and interfaces, not function bodies; only test assertions, manual checks, and signatures are pinned.
