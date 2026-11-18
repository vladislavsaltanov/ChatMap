# Blob Figure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ноды ложатся рваной fBm-кляксой: силуэт деформированного эллипса, внутри неоднородно, каждый сид — новая фигура.

**Architecture:** Новый чистый модуль `src/core/blob.ts` (решётчатый value-noise + fBm + радиально-взвешенный варп); `layout()` применяет его к точкам и портам после `containTail`, до `holdAspect`. Внутренняя механика (доли, стебли, солвер) не трогается.

**Tech Stack:** vanilla TS, Vitest, существующие `hashAt`-приёмы сидирования (без `Math.random`).

**Spec:** `specs/2026-11-15-blob-figure-design.md` — план спорит от спеки, спека едет вместе с ним.

## Global Constraints

- Чистая логика только в `src/core/`; тесты — vitest, только на `src/core/`.
- Детерминизм побайтовый: тот же сид — те же координаты (S7 живёт).
- `Math.random` запрещён везде; сидирование — целочисленным хешем.
- `holdAspect(2.0)` остаётся последним шагом; S1/S4/S5 не ослабляются.
- Preflight зелёный после каждого коммита: `npm run typecheck && npx vitest run && npm run build`.
- Комментарии в коде — сжатый технический английский.

## Review Focus

- Варп кладёт две ноды друг на друга (наложение тел) — S4 обязан остаться зелёным; стенд меряет overlap до/после.
- Варп рвёт «сильная связь ближе слабой» (S5) — гладкость поля держит локальную изометрию; S5-гейт на синтетике ловит.
- Два разных сида дают одинаковый силуэт (слабый хеш) — тест сид-чувствительности в Task 1.
- Переключатель фильтра двигает силуэт (повторный варп кэша) — reuse-путь варп не трогает; S8 + явный ассёрт.
- NaN/Infinity на вырожденных входах (0,0 / огромные координаты) — extreme-входы в Task 1.

---

### Task 1: fBm-ядро и варп-поле

**Files:**
- Create: `src/core/blob.ts`
- Test: `tests/blob.test.ts`

**Interfaces:**
- Consumes: ничего (только `seed: number` извне).
- Produces (для Task 2): `valueNoise2(x: number, y: number, seed: number): number` (выход [0,1]); `fbmNoise(x: number, y: number, seed: number, octaves?: number, lacunarity?: number, gain?: number): number`; `blobOffset(x: number, y: number, cx: number, cy: number, halfSpan: number, seed: number): { dx: number; dy: number }`; константы `EDGE_AMP = 0.22`, `DOMAIN_AMP = 0.05`, `FREQ = 2.5`, `OCTAVES = 4`, `LACUNARITY = 2.0`, `GAIN = 0.45`, `R_INNER = 0.35`, `R_FULL = 1.0`.

- [ ] **Step 1: Write the failing test** — `tests/blob.test.ts`: детерминизм (`blobOffset` дважды — побайтово равно); границы (`|dx|,|dy| <= (EDGE_AMP+DOMAIN_AMP)*halfSpan` на сетке 11×11, halfSpan ∈ {100, 1300, 8000}); сид-чувствительность (два сида → средний |Δ| > 1e-3 halfSpan); центр pinned (`blobOffset(cx,cy,...)` ≈ {0,0} с точностью 1e-9); extreme (`NaN/Infinity`/нули/1e12 — finite, в границах).
- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/blob.test.ts`. Expected: FAIL (файл/модуль отсутствует).
- [ ] **Step 3: Implement `src/core/blob.ts`** — решётчатый value-noise (целочисленный хеш узла + smoothstep-интерполяция), fBm суммой октав, радиальная компонента: `edge = smoothstep(R_INNER, R_FULL, r/R)`, `radial = edge * (fbm(cos θ, sin θ …) - 0.5) * 2 * EDGE_AMP * halfSpan` вдоль луча; доменная: `DOMAIN_AMP * halfSpan * (fbm(vec)-0.5)` по x/y; минус значение поля в центроиде (pin). Бесшовность — выборкой шума по окружности, как в референсах.
- [ ] **Step 4: Run tests to verify they pass** — Run: `npx vitest run tests/blob.test.ts` + `npm run typecheck`. Expected: PASS, 0 ошибок.
- [ ] **Step 5: Commit** — `git add src/core/blob.ts tests/blob.test.ts && git commit -m "feat(core): fBm blob field (value noise, radial+domain warp)"`.

### Task 2: Врезка варпа в layout()

**Files:**
- Modify: `src/core/graph.ts` (reuse-путь НЕ трогать; варп только в full-run ветке после `containTail`, до `holdAspect`)
- Test: расширить `tests/blob.test.ts` или `tests/graph.test.ts` интеграционным кейсом (имя: `layout applies blob warp`)

**Interfaces:**
- Consumes: `blobOffset` из Task 1; `opts.seed` как сид поля.
- Produces (для Task 3): силуэт с рваным краем при зелёных S1/S4/S5.

- [ ] **Step 1: Write the failing test** — full-run `layout()` на синтетике 2×271 (сид 7 и 8): силуэты различаются (дисперсия радиуса края отличается > 1e-6); S1-аспект обоих в [1.6, 2.1]; reuse-вариант (≥65% prevXY) побайтово равен кэшу (варп не пересчитывается).
- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/graph.test.ts`. Expected: FAIL (силуэты одинаковы — варпа нет).
- [ ] **Step 3: Implement в `layout()`** — после `containTail`+солвер-фаз: центроид точек, `halfSpan = measuredSpan(points)/2` (существующий хелпер), `p += blobOffset(p, centroid, halfSpan, seed)` для точек И портов (порты уже в мировых единицах к этому месту — проверить порядок конверсии в коде, не дублировать pxToWorld); дальше существующий `holdAspect` без изменений.
- [ ] **Step 4: Run tests to verify they pass** — Run: `npm run typecheck && npx vitest run tests/graph.test.ts tests/blob.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/core/graph.ts tests/blob.test.ts tests/graph.test.ts && git commit -m "feat(layout): warp finished figure into fBm blob"`.

### Task 3: Калибровка на стенде и приёмка

**Files:**
- Modify: константы в `src/core/blob.ts` (только числа)
- Test: стенд `tools/shot-shape.mjs` (существующие зонды) + скриншоты 3 сидов × 600 нод

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: числа в спеке, финальный коммит калибровки.

- [ ] **Step 1: Прогнать стенд** — Run: `node tools/shot-shape.mjs blob 900 4000 600` на сидах из лога layout (3 прогона). Собрать: overlap, S1-аспект, clarkEvans, скриншоты.
- [ ] **Step 2: Подкрутить `EDGE_AMP/DOMAIN_AMP/FREQ`** — цель: рваный край виден глазом, overlap не хуже baseline+0.05, S1 в гейте, CV плотности до/после в пределах ±10% (не гомогенизирует). Только числа, без рефакторинга.
- [ ] **Step 3: Записать числа в `specs/2026-11-15-blob-figure-design.md`** (таблица замеров + финальные константы).
- [ ] **Step 4: Preflight + commit** — Run: `npm run typecheck && npx vitest run && npm run build`. Expected: всё зелёное. Commit: `git add src/core/blob.ts specs/2026-11-15-blob-figure-design.md && git commit -m "feat(layout): calibrate blob warp on the stand"`.

## Self-Review

1. **Spec coverage:** рваный край → Task 2+3 (зонд+глаза); уникальность на сид → Task 1 (сид-чувствительность) + Task 2 (разные силуэты); неоднородность внутри → край взвешен радиусом + CV-чек в Task 3; без Math.random → констрейн + решётка в Task 1; детерминизм → Task 1. ✅
2. **Step scan:** шаги — по одному действию с проверяемым результатом; тел функций нет, только сигнатуры и ассёрты. ✅
3. **Type consistency:** `blobOffset`/`valueNoise2`/`fbmNoise` одинаково именуются в задачах 1–2; поля портов `{x, y}` совпадают с `LayoutPort`. ✅
4. **Review Focus:** все 5 пунктов привязаны: наложение → S4+стенд (Task 3); S5 → гейт (Task 2); сид-чувствительность → Task 1; дрейф при фильтре → S8-ассёрт (Task 2); NaN → Task 1. ✅
5. **Proportion:** план короче спеки, тел кода нет. ✅
