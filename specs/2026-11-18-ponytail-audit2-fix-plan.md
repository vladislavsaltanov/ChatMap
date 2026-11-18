# Закрытие находок аудита 2026-11-18 — план

> **For agentic workers:** REQUIRED: execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax. The executor is a single mechanical worker (deepseek-v4.1-flash); the lead inspects the full diff after completion. Read `CONVENTIONS.md` before any git operation.

**Goal:** закрыть 7 находок аудита репозитория от 2026-11-18 (1 красный гейт, 3 should-fix, 3 nice-to-have), каждый дефект — отдельным коммитом.

**Architecture:** все правки точечные, в существующих файлах; архитектура не меняется, новых зависимостей и модулей нет. Тесты — только на `src/core/` (vitest).

**Tech Stack:** TypeScript 5.9, Vite 8, vitest 5, vanilla TS (без UI-фреймворков).

**Spec:** аудит-сессия 2026-11-18 (сводка ниже — план самодостаточен). Смежные доки: `specs/2026-11-14-audit.md`, `specs/2026-11-13-leaf-tissue-plan.md`, `HANDOFF.md`.

## Сводка находок (спека)

| # | Находка | Файлы |
|---|---------|-------|
| 1 | Perf-гейт S9 маргинален: медиана wall-clock 403 мс при пороге 400 — красный в 1 из 3 прогонов на одной машине | `tests/spread.test.ts:601-617` |
| 2 | `console.log`-диагностика («runtime stamp») пишется в прод-консоль на каждом апдейте карты, без DEV-гейта | `src/core/worker.ts`, `src/core/graph.ts:660-700` |
| 3 | `seatNewNodes`: линейный `nodes.find` внутри 10-итерационной релаксации на каждое новое слово → O(fresh×10×deg×N) на каждом переключении фильтра | `src/core/graph.ts:436-449` |
| 4 | Шапка `leaf.ts` врёт («Copy for measurement only», «spread.ts stay untouched») — это прод-библиотека, на которой строит `spread.ts`; `leafLayout` — тестовая сборка без прод-вызовов | `src/core/leaf.ts:1-3` |
| 5 | Мёртвый параметр `bundleEdges(_maxWeight)`: прод-вызов передаёт значение, которое функция игнорирует | `src/core/geometry.ts`, `src/core/worker.ts`, 3 тест-файла |
| 6 | `authorId` в parse обходит строгий парсер: голый `Number()` принимает crafted `"1e3"`/`"0x10"` и склеивает разных авторов; id сообщений уже идут через `parsePositiveInt` | `src/core/parse.ts:103-116` |
| 7 | `HANDOFF.md` §3.3 описывает «graphology + FA2», которого в коде больше нет (раскладка — leaf-tissue + солвер коллизий) | `HANDOFF.md` |

## Global Constraints

- Preflight зелёный на completion gate: `npm run typecheck && npm run test && npm run build`.
- Тесты только на `src/core/` (vitest). UI и sigma не трогать.
- Комментарии в коде — строго английские, короткие, технические. Русский — только в тестовых названиях и доке.
- Ноль новых зависимостей, ноль сетевых вызовов, ноль ре-форматирования неположенных строк.
- Conventional Commits; один дефект = один коммит; ветка `fix/ponytail-audit2` от `main`; мерж только после зелёного preflight.
- File-scoped проверки на каждом шаге; полный preflight — один раз, в Task 8.
- Two-Strike: если шаг проверки падает дважды с той же ошибкой — STOP и отчёт, ничего не «дочищать» самому.

## Review Focus

1. Полный прогон vitest под нагрузкой → S9 без запаса красный → закрывает Task 1 (гейт 550 при цели 400).
2. Crafted `from_id: "1e3"` → голос склеивается с id 1000 → закрывает тест Task 6.
3. Переключение фильтра с ~35 % свежих узлов → O(N)-поиск в горячем цикле → Task 3; поведенческий пин — существующие тесты S8/reuse в `tests/graph.test.ts` обязаны остаться зелёными.
4. Пропущенный вызов `bundleEdges` после смены сигнатуры → ловит `npm run typecheck` (Task 5, 7 кодовых вызовов).
5. Прод-консоль воркера должна быть чистой → проверка grep по `dist/` на completion gate (Task 8).

---

### Task 0: Ветка (складывается в Task 1)

**Files:** нет.

- [ ] **Step 0.1:** от `main` (дерево чистое) создать ветку:
  `git checkout -b fix/ponytail-audit2`

---

### Task 1: Гейт S9 получает запас на wall-clock

**Files:**
- Modify: `tests/spread.test.ts:601-617`

- [ ] **Step 1.1:** Точный edit (заголовок + комментарий):

```ts
  it('S9 budget: layout of 1000 nodes stays under 550 ms gate (target 400)', () => {
    const { nodes, edges } = synth(1000)
    // Warmup + median of 3: a single shot on a shared CI runner flakes on
    // worker contention (vitest isolates test files into competing workers).
    // Gate 550 = target 400 + wall-clock headroom: the median measured 403 ms
    // on an unloaded dev machine, so a zero-margin bar is not reproducibly
    // green. Regressions measured in hundreds of ms still trip the gate.
```

И порог: `expect(ms).toBeLessThan(400)` → `expect(ms).toBeLessThan(550)`.

- [ ] **Step 1.2:** Run: `npx vitest run tests/spread.test.ts`
  Expected: 16 passed. (Вит-вывод может печатать `layout principal axis…` — это существует и после Task 2 в тестах допустимо; не трогать.)

- [ ] **Step 1.3:** Commit (только этот файл):
  `fix(test): give the S9 wall-clock gate regression headroom`

---

### Task 2: Runtime-stamp диагностика — dev-only

**Files:**
- Modify: `src/core/worker.ts` (блок `// Runtime stamp: proves which layout code…`, перед ним стоит комментарий из 2 строк)
- Modify: `src/core/graph.ts:660-663` (блок `// Principal-axis probe (log only)…`)

- [ ] **Step 2.1:** `src/core/worker.ts` — заменить открытие bare-блока на DEV-гейт (закрывающая скобка не меняется):

```ts
  // Runtime stamp: proves which layout code the (dev) browser runs and what
  // shape it produced. Dev-only: the production console stays clean on
  // every filter update.
  if (import.meta.env.DEV) {
```

- [ ] **Step 2.2:** `src/core/graph.ts` — то же самое для блока principal-axis:

```ts
  // Principal-axis probe (dev-only log): area-weighted covariance on the
  // held frame. Local on purpose — leaf.ts owns alignPrincipalAxis but
  // imports reservePx from here, so importing it would close a cycle.
  // Rotation stays OFF unless the axis sits stably >15deg off horizontal
  // on synthetic (guards: L1/L2>1.2, dx>=0).
  if (import.meta.env.DEV) {
```

- [ ] **Step 2.3:** Run: `npm run typecheck && npx vitest run tests/graph.test.ts tests/spread.test.ts`
  Expected: tsc 0 errors; все тесты зелёные. Логи в vitest-выводе остаются (vitest сам ставит DEV=true) — это ожидаемо, не «чинить».

- [ ] **Step 2.4:** Commit (два файла):
  `fix(core): runtime-stamp diagnostics are dev-only`

---

### Task 3: `seatNewNodes` — O(1) lookup размера соседа

**Files:**
- Modify: `src/core/graph.ts:412` (сразу после `const fresh = …`) и `:441`

- [ ] **Step 3.1:** После строки `const fresh = nodes.filter((n) => !n.prevXY).sort((a, b) => a.id - b.id)` добавить:

```ts
  // O(1) neighbour size lookup: a linear nodes.find inside the 10-iteration
  // relax loop cost fresh * 10 * degree * N scans on every filter switch.
  const sizeOf = new Map(nodes.map((n) => [n.id, n.size ?? 20] as const))
```

- [ ] **Step 3.2:** Строку
  `const rest = own + reservePx(nodes.find((m) => m.id === nb.id)?.size ?? 20)`
  заменить на
  `const rest = own + reservePx(sizeOf.get(nb.id) ?? 20)`

- [ ] **Step 3.3:** Run: `npm run typecheck && npx vitest run tests/graph.test.ts tests/spread.test.ts`
  Expected: зелёные, в частности кейс кэшированных координат (S8/reuse) не изменился.

- [ ] **Step 3.4:** Commit:
  `fix(core): seatNewNodes neighbour size lookup is O(1)`

---

### Task 4: Честная шапка `leaf.ts`

**Files:**
- Modify: `src/core/leaf.ts:1-3`

- [ ] **Step 4.1:** Три строки шапки заменить на:

```ts
// Leaf-tissue kernels: Dijkstra + branch-coherent soft init + bridge-aware
// targetLen + stress. PRODUCTION library — spread.ts builds its pipeline on
// these kernels. leafLayout() below is a test-only assembly (no production
// caller); tests pin determinism through it.
// All pure and deterministic: ties by id, no Math.random, hashing via spread.hashAt.
```

- [ ] **Step 4.2:** Run: `npm run typecheck`
  Expected: 0 errors (комментарий — единственное изменение).

- [ ] **Step 4.3:** Commit:
  `docs(core): leaf.ts header states its production role`

---

### Task 5: Удалить мёртвый параметр `bundleEdges(_maxWeight)`

**Files:**
- Modify: `src/core/geometry.ts` (сигнатура `bundleEdges`, строки с комментарием «Kept in the signature for callers that still pass…»)
- Modify: `src/core/worker.ts` (вызов с `selection.maxWeight`)
- Modify: `tests/megahub.test.ts:197`, `tests/graph.test.ts:251-252`, `tests/geometry.test.ts:187,188,194,204`

**Interfaces:**
- Produces: `bundleEdges(points: BundlePoint[], edges: BundleEdgeInput[], routes?: RouteInfo): BundleInfo[]` (третий параметр удалён, `routes` становится третьим).

- [ ] **Step 5.1:** `src/core/geometry.ts` — сигнатура и комментарий:

```ts
export function bundleEdges(
  points: BundlePoint[],
  edges: BundleEdgeInput[],
  routes?: RouteInfo,
): BundleInfo[] {
```

(двустрочный комментарий «Kept in the signature…» удалить целиком).

- [ ] **Step 5.2:** Все вызовы (7 шт.) — убрать третий позиционный аргумент, `routes` сдвигается на его место:
  - `src/core/worker.ts`: `bundleEdges(posList, backboneEdges, {`
  - `tests/megahub.test.ts:197`: `bundleEdges(points, graph.backbone, {`
  - `tests/graph.test.ts:251-252`: убрать и аргумент `maxW`, и ставшую неиспользуемой строку `const maxW = Math.max(...)`
  - `tests/geometry.test.ts:187,188,194,204`: `bundleEdges(points, edges, routes)`

- [ ] **Step 5.3:** Run: `npm run typecheck && npx vitest run tests/geometry.test.ts tests/graph.test.ts tests/megahub.test.ts`
  Expected: tsc ловит любой пропущенный вызов; тесты зелёные.

- [ ] **Step 5.4:** Commit:
  `fix(core): drop the unused bundleEdges maxWeight parameter`

---

### Task 6: `authorId` через строгий парсер (TDD)

**Files:**
- Test: `tests/parse.test.ts` (в конец `describe('parse', …)`, стиль буквенных кейсов)
- Modify: `src/core/parse.ts` (внутри `authorId`, строки `const num = Number(cleanStr)`)

- [ ] **Step 6.1:** Написать падающий тест (в стиле файла, русский заголовок):

```ts
  it('(k) from_id "1e3" не становится id 1000: строгий парсер id', () => {
    const parsed = parse(
      JSON.stringify({
        messages: [
          { id: 1, type: 'message', date: '2024-01-01T00:00:00', from: 'Эхо', from_id: '1e3', text: 'привет' },
          { id: 2, type: 'message', date: '2024-01-01T00:01:00', from: 'Бета', from_id: '1000', text: 'привет' },
        ],
      }),
    )
    // Crafted exponent id stays on the string-key path: two voices, not one.
    expect(parsed.messages[0].authorId).not.toBe(parsed.messages[1].authorId)
    // Digit-string ids still take the numeric path.
    expect(parsed.messages[1].authorId).toBe(1000)
  })
```

- [ ] **Step 6.2:** Run: `npx vitest run tests/parse.test.ts`
  Expected: FAIL — `parsed.messages[0].authorId` равен `parsed.messages[1].authorId` (оба 1000), потому что `Number("1e3") === 1000`.

- [ ] **Step 6.3:** Фикс в `src/core/parse.ts`, внутри `authorId`:

```ts
      // Same strict gate as message ids: bare Number() turns crafted "1e3"
      // (and hex "0x10") into numeric author ids and merges distinct voices.
      const cleanStr = String(rawId).replace(/^(?:(?:user|channel|chat)_?|-)+/i, '')
      const num = parsePositiveInt(cleanStr)
      if (num !== null) {
```

(тело ветки не меняется; `parsePositiveInt` уже импортирован в том же файле выше по коду — он объявлен в этом же модуле).

- [ ] **Step 6.4:** Run: `npx vitest run tests/parse.test.ts`
  Expected: все зелёные, включая новый `(k)` и существующие `(e)` (`"-123"` → 123) и `(h)` (`'user999'` → 999) — префиксы и отрицательные id не сломаны.

- [ ] **Step 6.5:** Commit (два файла):
  `fix(core): author ids pass through the strict boundary parser`

---

### Task 7: `HANDOFF.md` §3.3 — честное описание раскладки

**Files:**
- Modify: `HANDOFF.md` (раздел «### 3.3. Физика графа и Backbone-фильтрация»)

- [ ] **Step 7.1:** Буллет «Backbone Pruning» не трогать. Блок из трёх буллетов «Весо-чувствительный ForceAtlas2 (1200 итераций…)» (со вложенными `edgeWeightInfluence`, `linLogMode`, `scalingRatio`) заменить на:

```markdown
- **Раскладка листовой ткани (заменила FA2; см. [`specs/2026-11-13-leaf-tissue-plan.md`](specs/2026-11-13-leaf-tissue-plan.md) и [`specs/2026-11-14-audit.md`](specs/2026-11-14-audit.md)):**
  - `spread.ts` / `leaf.ts`: группы → landmarks + мягкая аффинность (Dijkstra) → stress; сульви между чистыми зонами держит солвер коллизий.
  - `graph.ts`: две фазы солвера коллизий (бюджет 28 проходов), сдерживание хвоста, fBm-warp силуэта (`blob.ts`), аспект рамки 2.0.
  - Инкрементальный путь (≥60 % кэшированных координат): без пересборки — новые слова садятся к кэшированным соседям (`seatNewNodes`).
```

- [ ] **Step 7.2:** Run: не требуется (markdown). Убедиться, что остальные разделы не тронуты.

- [ ] **Step 7.3:** Commit:
  `docs: HANDOFF 3.3 describes the leaf-tissue layout, not FA2`

---

### Task 8: Completion gate

- [ ] **Step 8.1:** Run: `npm run typecheck && npm run test && npm run build`
  Expected: всё зелёное; S9-гейт проходит с запасом (цель 400, гейт 550).

- [ ] **Step 8.2:** Прод-консоль чистая: в собранных чанках нет runtime-stamp строк.
  Run: `grep -r "chatmap-layout\|principal axis" dist/` (или PowerShell-эквивалент `Select-String -Path dist\*.js,dist\assets\*.js -Pattern "chatmap-layout"`)
  Expected: пусто.

- [ ] **Step 8.3:** Run: `git log --oneline main..fix/ponytail-audit2`
  Expected: 7 коммитов, по одному на Task 1-7, в порядке плана.

- [ ] **Step 8.4:** Отчёт исполнителя: статус каждого таска, вывод шага 8.1 (хвост), результат 8.2, список изменённых файлов (`git diff --stat main..fix/ponytail-audit2`).

---

## Что сознательно НЕ входит (YAGNI)

- Удаление `leafLayout`/`resolveLeafCollisions` с переброской тестов на прод-цепочку: отдельно зафиксировано как отложенная опция (шапка Task 4 честно документирует статус вместо дублирования правил в двух местах).
- Вынос perf-гейтов в отдельный npm-скрипт: гейт с запасом в Task 1 решает проблему меньшей правкой.
- Полная переработка `HANDOFF.md` под пост-11-12 реальность: правится только §3.3, где доку противоречит код.
