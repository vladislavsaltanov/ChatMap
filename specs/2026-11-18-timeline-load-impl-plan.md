# План: двухпроходная статистика + таймлайн-лента

> **For agentic workers:** REQUIRED: execute task-by-task in order; steps use checkbox (`- [ ]`). Phase 1 (Tasks 1-5) — trust-boundary core (`tally`), исполняет Lead. Phase 2 (Tasks 6-8) — UI/протокол, может исполнять worker по дословному плану с инспекцией диффа. Read `CONVENTIONS.md` before any git operation.

**Goal:** ускорить загрузку реальных экспортов (open ≈ 1–1.5 с вместо 3.7 с, куча ≤ 400 МБ вместо 1.4 ГБ) и дать opt-in таймлайн-ленту «как менялась карта сквозь время» на одном фундаменте: частоты по бакетам времени + ограниченный скан рёбер на срез.

**Architecture:** pass 1 при open копит `токен × автор × бакет → count` (месячные бакеты); частоты любого среза = префиксная сумма. Pass 2 по запросу сканирует юниты и копит пары только между словами топа среза (`tally(units, opts)` — та же реализация, optional-параметры). Раскладка — пин: считается один раз по всей истории, срез меняет только counts/authorLead/размеры/рёбра. Worker → main: `timelineMeta` + `slice`-сообщения, latest-wins.

**Tech Stack:** TS 5.9, Vite 8, vitest 5, vanilla, sigma v4. Без новых зависимостей.

**Spec:** `specs/2026-11-18-timeline-and-load-design.md` (утверждён 2026-11-18; решения пользователя и планка «красиво + информативно-правдиво» внутри). Замер-базис: `specs/archive/spikes/SPIKE-load-pipeline-bench.md`.

## Global Constraints

- Планка владельца: красиво (существующий дизайн-язык, oklch-токены, без градиентов/свечений/эмодзи) и информативно-правдиво (каждое число — из реальных данных, размеры пересчитываются по срезу).
- Preflight зелёный на completion gate: `npm run typecheck && npm run test && npm run build`.
- Тесты только на `src/core/` (vitest); UI/sigma — ручные браузерные критерии.
- Комментарии в коде — английские, плотные. Русский — тестовые названия/доки/UI-тексты.
- Ноль новых зависимостей, ноль сети, ноль реальных экспортов в коммитах (бенч — env-gated, gitignored).
- Conventional Commits; ветка `feat/timeline-load` от `fix/ponytail-audit2` (перебазировать на main после её мержа); один таск = один коммит.
- File-scoped проверки на тасках; полный preflight — Tasks 5 и 8.
- Two-Strike: два падения одного шага с одной ошибкой — СТОП и отчёт.
- Свойство-инвариант фазы 1: **при T = «вся история» новая цепочка даёт байт-идентичный `Selection` старой цепочки `tally + select`** — главный гейт правдивости.

## Review Focus

1. Эквивалентность T=full: старый `tally()+select()` vs новый путь — property-тест (Task 3) на фикстурах sample-export, megahub, синтетика, ≥3 filter-cfg.
2. Сообщения без даты (`dateMs <= 0`): юнит без бакета никогда не отбрасывается срезом; счёт всегда включён (guard-тест Task 2).
3. Короткий чат (< 14 дней): `timelineEligible === false`, лента не показывается, поведение карты = вчерашнее (тест Task 1, ручной кейс Task 8).
4. Переключение фильтров при активной ленте: pass 1 и slice перегоняются, ключ кеша содержит filter (тест Task 2/4).
5. Память: `heapUsed` дельта нового open-пути < 500 МБ на 58k-сообщениях (замер Task 5; старый путь = 1.4 ГБ — запас трёхкратный).

---

## Фаза 1 — фундамент (core, без UI)

### Task 1: Бакеты времени — `src/core/timebuckets.ts`

**Files:**
- Create: `src/core/timebuckets.ts`
- Test: `tests/timebuckets.test.ts`

**Interfaces (Produces, для Tasks 2, 4, 6):**
```ts
export type BucketMeta = {
  count: number                    // 1..K
  eligible: boolean                // false => чат < 14 дней, лента отключена
  monthStarts: number[]            // count+1 границ (мс); [i] = начало бакета i, [count] = конец
  labels: string[]                 // count подписей курсора: «мар 2024», «2024», «нед. 3»
  msgCounts: Uint32Array           // count: сообщений в бакете (полоса активности)
  bucketOf: (dateMs: number) => number // guard: dateMs<=0/NaN => 0; upper-clamp
}
export function buildBucketMeta(chat: ChatExport): BucketMeta
```
Правило гранулярности: span ≥ 6 месяцев → календарные месяцы; ≥ 14 дней → недели; иначе `count=1, eligible=false`.

- [ ] Шаг 1.1 — TDD: падающий тест: месячная гранулярность на синтетике 8 месяцев; недельная на 20 дней; ineligible на 5 дней; `bucketOf(0) === 0`, `bucketOf(-5) === 0`, `bucketOf(дата вне диапазона)` клампится; `msgCounts` сходится с ручным подсчётом.
- [ ] Шаг 1.2 — Запуск: `npx vitest run tests/timebuckets.test.ts` → FAIL (модуля нет).
- [ ] Шаг 1.3 — Реализация `timebuckets.ts` (чистая, без I/O; английские комментарии, guard-строки на каждую ветку).
- [ ] Шаг 1.4 — Запуск: PASS.
- [ ] Шаг 1.5 — Commit: `feat(core): calendar buckets for timeline slices`.

### Task 2: Pass 1 — частоты по бакетам + кеш

**Files:**
- Modify: `src/core/tally.ts` (PipelineCache.resolve; RawUnit; новые экспорты)
- Modify: `src/core/worker.ts` (open-путь)
- Test: `tests/tally.test.ts` (миграция кеш-секций), `tests/bench-tmp-load.test.ts` (не трогать — атрибуция)

**Interfaces:**
- `RawUnit` получает **optional** `bucket?: number` (не ломает литералы в тестах; `undefined` = всегда включён — семантика dateMs<=0).
- Produces (для Tasks 3-6):
```ts
export type BucketCounts = Map<number, Map<AuthorId, Uint32Array>> // tokId -> author -> [bucket]
export type ResolveResult = {
  ia: Intern; units: RawUnit[]; merged?: Map<number, number>
  meta: BucketMeta; bucketCounts: BucketCounts
  countsCached: boolean  // замена tallyCached для прогресс-коллбеков
}
export function countsUpTo(bc: BucketCounts, t: number): Map<number, Map<AuthorId, number>>
```
`addUnits` проставляет `unit.bucket = meta.bucketOf(message.dateMs)` (meta прокидывается через новый optional-параметр; без meta — не проставляет).
`PipelineCache.resolve(chat, cfg, callbacks)` → **возвращает ResolveResult** (tally-этап исчезает: pass 1 = `countByBuckets(units)`, ~50 мс). Слоты кеша: tokenized (как было) + 2 слота `{units, bucketCounts, ia, merged}` по `filterCacheKey`/`mergeCacheKey` — семантика A→B→A сохранена.

- [ ] Шаг 2.1 — Миграция кеш-тестов в `tests/tally.test.ts`: переименовать `PipelineCache`-секции под новый резолв; падают (новые поля).
- [ ] Шаг 2.2 — Реализация в `tally.ts`: `countByBuckets` (один линейный проход по юнитам, разреженные аллокации авторов), `countsUpTo` (префикс до t включительно), рефактор `resolve`. Guard: юнит без `bucket` (undefined или ≤ 0... нет — bucket 0 валиден!) — ровно `unit.bucket === undefined` → всегда включён. Guard-комментарий обязателен.
- [ ] Шаг 2.3 — `worker.ts`: open-путь = `buildBucketMeta` (после parse, progress-стадия «Определение авторов...» не меняется) → `resolve` → **материализация полных counts** `countsUpTo(bc, meta.count - 1)` → `tally(units)` (полный скан; ограничение по memberSet вводит Task 3 — `select` с пустыми pairs вернул бы пустой набор узлов) → `select` с реальными pairs → layout как сегодня. Прогресс-проценты стадий сохранить.
- [ ] Шаг 2.4 — `npx vitest run tests/tally.test.ts` → PASS; `npm run typecheck` → 0.
- [ ] Шаг 2.5 — Commit: `feat(core): bucketed pass-1 counts replace full-pair tally in the open path`.

### Task 3: Pass 2 — `tally(units, opts)`; property-гейт эквивалентности

**Files:**
- Modify: `src/core/tally.ts` (signature tally + скан-гарды)
- Test: `tests/tally.test.ts` (секция «slice scan»), Create: `tests/slice-equiv.test.ts`

**Interfaces:**
```ts
export type ScanOpts = { memberSet?: Set<number>; maxBucket?: number }
export function tally(units: RawUnit[], opts?: ScanOpts): TallyResult
```
- `select.ts` += `export function topIds(counts, cfg, merged): number[]` — [Query] топ-N id по mode (together/author; cross до Task 6 — все id со счётом). `worker.ts` здесь же переключает open-путь: `countsUpTo` → `topIds` → `tally(units, { memberSet })` → `select` (реальные pairs) — выигрыш по памяти/времени приземляется на этом шаге.
- `memberSet` живёт в RAW-id пространстве: это ПРООБРАЗ selected под `merged` (raw id включён ⟺ root = merged.get(id) ?? id лежит в topIds). Без этого smartMerge терял бы пары вариантов, склеивающихся в выбранные корни.
Гарды в скане пар (до `edgeKey`): `if (opts?.memberSet !== undefined && (!mset.has(u) || !mset.has(v))) continue`; `if (opts?.maxBucket !== undefined && (unit.bucket ?? 0) > opts.maxBucket) skip unit`. `tally(units)` без opts — байт-идентично сегодняшнему (оракул).

- [ ] Шаг 3.1 — TDD: тесты среза — юнит с `bucket > maxBucket` исключён; пара вне memberSet не в pairs; пара с undefined-bucket включена всегда.
- [ ] Шаг 3.2 — Property-тест `tests/slice-equiv.test.ts`: для фикстур `tests/fixtures/sample-export.json`, megahub-генератора и синтетики tally-тестов, ≥3 cfg (default, mat:true, customMat, smartMerge:true): `select(tally(units), view)` DEEP-EQUAL `select({counts: countsUpTo(bc, last), pairs: tally(units, {memberSet})}, view)` при memberSet = прообраз topIds (см. выше). FAIL (opts нет).
- [ ] Шаг 3.3 — Реализация opts в `tally` (только гарды, ноль изменения семантики без opts).
- [ ] Шаг 3.4 — Оба файла PASS; `npx vitest run tests/tally.test.ts tests/slice-equiv.test.ts`.
- [ ] Шаг 3.5 — Commit: `feat(core): tally scan opts — membership mask and time cutoff`.

### Task 4: Срез как чистая функция — `buildSlice`

**Files (parallel-batch split per APPEND_SYSTEM §3 — no two writers on one file):**
- Task 4a (PARALLEL with Task 3 — disjoint files): Create `src/core/slice.ts` + `tests/slice.test.ts`; `SliceNode`/`SliceMsg` types live IN `slice.ts`. Imports of `countsUpTo`/`ScanOpts` are pinned by Tasks 2-3 and may not exist yet when 4a starts — write against the pinned shapes, never define them here.
- Task 4b (spine, sequential after Task 3): Modify `src/core/types.ts` (`WorkerOut |= SliceMsg` via import from slice.ts) + `src/core/worker.ts` (slice handler + `lastPinned` layout state).

**Interfaces (Produces, для Tasks 6-8):**
```ts
// slice.ts
export type SliceNode = { id: number; count: number; authorLead: AuthorId; size: number }
export type SliceMsg = {
  type: 'slice'; bucket: number
  nodes: SliceNode[]; edges: WorkerEdge[]
  maxCount: number; maxWeight: number
}
export function buildSlice(args: {
  units: RawUnit[]; bucketCounts: BucketCounts; merged?: Map<number, number>
  meta: BucketMeta; bucket: number; view: ViewCfg
  ia: Intern; layout: { positions: Map<number, {x;y}>; ports?: Map<number, LayoutPort>; groupOf?: Map<number,number>; stemOf?: Map<number,number> }
  memberUniverse: Set<number>   // пин-множество = топ-N всего чата
}): SliceMsg
```
Логика: `countsUpTo` → отбор по mode (cross — из `crossCandidates`, см. Task 6) → `tally(units, { memberSet: selected∩universe, maxBucket: bucket })` → `select`-часть (minWeight/MAX_EDGES/backbone — переиспользовать `pruneSortedBackbone`, `dropEdgelessNodes` с пин-множеством как фильтром) → размеры по закону срезов: `nodeFitSize(bestForm, count, sliceMax, sliceMin)` + `footprintScale` **относительно всечатовых размеров** (пин: иерархия среза честная, но глобальный масштаб не прыгает) → bundles по пин-layout (`bundleEdges` с пин ports/groupOf/stemOf) → WorkerEdge.
Worker: `self.onmessage` += `{type:'slice'}` → `buildSlice` → `send(msg)`; состояние `memberUniverse`/`layout`/`meta` хранится с open (layout-результат уже сохраняется неявно — вынести в module-scope переменную `lastPinned`).

- [ ] Шаг 4.1 — TDD: чистые тесты buildSlice на мини-чате: срез меньших индексов даёт меньшие counts; рёбра только внутри пин-множества; `maxBucket` сквозной; размеры уважают `footprintScale` вселенной; edges-геометрия идентична полному бакету при T=last (тракт-коэффициенты).
- [ ] Шаг 4.2 (a) — Реализация `slice.ts` (parallel track; unresolved-import diagnostics on `./tally` countsUpTo/ScanOpts are EXPECTED until the spine lands).
- [ ] Шаг 4.3 (a) — `npx vitest run tests/slice.test.ts` + typecheck → PASS (Main runs after the spine batch lands).
- [ ] Шаг 4.4 (a) — Commit: `feat(core): pure slice builder over pinned layout`.
- [ ] Шаг 4.5 (b, после Task 3) — Обвязка types.ts + worker-хендлер; verify: `npx vitest run tests/slice.test.ts` + typecheck; Commit: `feat(core): worker serves timeline slices`.

### Task 5: Гейт скорости/памяти фазы 1

**Files:**
- Modify: `tests/bench-tmp-load.test.ts` (env-gated, gitignored)

- [ ] Шаг 5.1 — Расширить бенч: после resolve/new-path `assert(process.memoryUsage().heapUsed - heapAtStart < 500 * 1048576)`; напечатать open-итог по стадиям. Запуск с CHATMAP_BENCH_FILE (реальный файл, вне коммита): фиксирую числа в верификационном доке.
- [ ] Шаг 5.2 — Полный preflight: `npm run typecheck && npm run test && npm run build` → зелёный.
- [ ] Шаг 5.3 — Верификационный док: `specs/verifications/2026-11-18-timeline-load-phase1.md` (числа open/память/эквивалентность).
- [ ] Шаг 5.4 — Commit: `test(bench): phase-1 perf gate and verification numbers`.

## Фаза 2 — протокол, UI, ручные критерии

### Task 6: Протокол таймлайна + cross-кандидаты

**Files:**
- Modify: `src/core/types.ts`, `src/core/worker.ts`, `src/core/slice.ts`
- Test: `tests/slice.test.ts`

**Interfaces:**
```ts
// WorkerIn |= { type: 'timelineOn' } | { type: 'slice'; bucket: number }
// WorkerOut |= { type: 'timelineMeta'; meta: {count; eligible; monthStarts; labels; msgCounts} }
//               | SliceMsg (Task 4)
// slice.ts +=
export function crossCandidates(units: RawUnit[], meta: BucketMeta): Set<number> // полный диапазон
```
- `timelineOn` → выслать meta (без повторного счёта; `msgCounts` уже из Task 1) + запомнить `timelineActive`.
- cross-режим при активной ленте: `crossCandidates` — лениво, один скан при первом включении cross (без материализации пар, бит-сет токенов; ~0.5–1 с, кешится до смены фильтра). В `buildSlice` для `mode: 'cross'` отбор = candidates ∩ пин-вселенная по cross-весу среза.
- `slice`-хендлер: latest-wins — новый запрос перезаписывает `pendingBucket`; воркер обрабатывает один за раз.
- Guard: `slice` без открытого чата → игнор; `bucket` вне `[0, count)` → кламп.

- [ ] Шаг 6.1 — TDD: meta-форма; cross-кандидаты на мини-чате (пара разных авторов внутри юнита → токен в сете); latest-wins имитацией двух сообщений подряд.
- [ ] Шаг 6.2 — Реализация; тесты PASS; typecheck 0.
- [ ] Шаг 6.3 — Commit: `feat(core): timeline protocol — meta, latest-wins slices, cross candidates`.

### Task 7: UI ленты — `src/ui/timeline.ts` + mapview + CSS

**Files:**
- Create: `src/ui/timeline.ts`
- Modify: `src/ui/controls.ts` (кнопка «Таймлайн»), `src/ui/mapview.ts` (`applySlice`), `src/main.ts` (wiring), `src/styles/map.css` (полоса)

**Behaviour:**
- Кнопка в группе «Карта» (рядом с «Подсказка на карте»); активация шлёт `timelineOn`, полоса живёт в обычном потоке ПОД канвой — нижняя граница канвы сдвигается вверх на высоту полосы (канва сжимается, не перекрывается). Решение владельца 2026-11-18 по референс-фото (визуал полосы — фаза 2, итерация по скриншотам).
- Полоса — визуальная грамматика по референсу владельца (iOS-стиль, 2026-11-18): широкая капсула на всю ширину канвы, полностью скруглённые торцы (radius = высота/2), плоская заливка тоном чуть светлее бумаги — без рамок и разделителей, разделение чисто тональное. Внутри капсулы — спектр активности: один вертикальный тик на бакет (1–2 px), высота = реальный `msgCounts[i]` линейно к максимуму, тики вертикально центрированы; пройденная часть (бакет ≤ курсора) — акцентный мягкий синий проекта, оставшаяся — приглушённая тушь. Playhead — сплошная белая вертикаль 1.5–2 px на всю высоту капсулы, квадратные концы; drag указателем, ←/→ (шаг = бакет), Home/End. Внутри капсулы слева — компактная подпись курсора: «мар 2024 · 12 345 сообщ.» (реальные числа среза). Годовые границы — тик января чуть плотнее (опция, не блокер). Спектр не рисует ничего, чего нет в данных; без градиентов/теней/эмодзи.
- Drag: указателем/клавиатурой (←/→ шаг = бакет, Home/End); debounce 150 мс; отпускание не релеклутит (пин).
- `MapView.applySlice(msg)`: обновить `count`/`authorLead`/`size` у пин-узлов (missing = размер 0 не рисуем: `hidden`), рёбра заменить на `msg.edges`, пересчитать `labelCoreMin` по срезу, `renderer.refresh()`; morph-анимация NOT в v1 (мгновенно после compute; документировано в YAGNI).
- Выключение ленты (кнопка) → `slice` на T=last → прежний вид; полоса скрыта.

- [ ] Шаг 7.1 — Реализация UI по критериям выше (wiring в `main.ts`: `timelineMeta` → `timeline.show(meta)`, `slice` → `mapView.applySlice`).
- [ ] Шаг 7.2 — `npm run typecheck && npm run build` → 0/ок.
- [ ] Шаг 7.3 — Commit: `feat(ui): timeline strip over the pinned map`.

### Task 8: Completion gate — ручные критерии + preflight

- [ ] Шаг 8.1 — Полный preflight зелёный.
- [ ] Шаг 8.2 — Ручные браузерные критерии (`?fixture=1` + реальный файл локально): (a) без ленты — поведение идентично прежнему; (b) лента вкл → полоса с реальной активностью, дефолт = правый край; (c) скраб: слова на местах, точки растут/гаснут, рёбра меняются, подпись курсора честная; (d) смена фильтра при активной ленте — карта пересобирается, лента жива; (e) cross-режим: первый сдвиг ~1 с (кандидаты), дальше быстро; (f) чат < 14 дней (`tests/fixtures`) — кнопка скрывает полосу; (g) Escape/кнопка — лента выкл, вид вернулся. Каждое — скриншот-свидетельство в верификационный док.
- [ ] Шаг 8.3 — `specs/verifications/2026-11-18-timeline-load.md` + Commit: `docs: timeline+load verification report`.

## YAGNI (сознательно вне плана)

- Morph-анимация между срезами (v1: мгновенно после compute; анимация — отдельная задача, если скраб покажется резким).
- Режим «окно за N месяцев» и объединение топов по бакетам — фаза 3 дизайна.
- Кеш срезов (latest-wins без LRU), кеш cross-кандидатов только до смены фильтра.
- Гранулярность тоньше недели; таймзоны (локальное календарное время устройства принято).
