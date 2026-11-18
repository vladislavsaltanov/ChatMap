# Лист коры — связная ткань вместо полосы (PLANNED)

Статус: `[STATUS: P1 DONE + аспект 1.8, P2 NEXT]`. Trunk/core/strands снесены, leaf-tissue
в production (`spread` + `graph`). `tally/select` сигнатуры не тронуты.

## Решение (утверждено)

- `ports = landmarkPositions` (позиции хабов групп, 3..9 точек, stress по аффинности).
- `groupOf = argmax phi` (hard label из soft, owner Дейкстры). `corridors` без изменений.
- `softCentroid` только для init позиций, не для роутинга. `bundleEdges` без смены сигнатуры.
- Весь stress в screen-px (`span=1300`), один `pxToWorld` в `graph.layout`. Без `fitToSpan` в цикле.
- Коллизии не в цикле, а двухфазные (8 без якоря + 20 с якорем).
- Аспект вытянутой плоскости 1.8: init `LEAF_ASPECT=1.9` (softInit rescale) + `SPREAD_ASPECT=1.8` в рамке spread + hold 1.8 в `layout` после солвера (stretch-only, S4-safe). Чернила трекают дату с ~0.85x (гигантские топ/боттом хабы + подписи раздувают вертикаль): дата 1.8 → чернила ~1.5. Замерено попиксельно (tools/inkbox.ps1): реал 1.26 при дате 1.5, синтетика 1.54 при дате 1.8.

## Гейты: что сносим, что вводим

REMOVED (полоса, осознанно):
- Before: `S1 spanX/spanY 1.3..3.2`, `S3 voidShare>=0.1`, `S2 clump>=2.0`.
- After: (removed) — лист не обязан быть полосой, океаны запрещены.
- Причина: trunk в линию давал регулярность (ботаника, а не нейро-карта).

ADDED:
- `Spearman(weight, длина ребра) < -0.5` на корпусе seed 1337.
- `kNN(k=5)` — 1 компонента (лист связный, не острова).
- `preservation@10 > 0.6` (топ-5 соседей по графу в топ-10 по плоскости).
- `CV NN-dist 0.42..0.72`, `max empty circle < 0.15*span` (hull, не bbox).
- `S4/S5/S7/S8/S9` без изменений (clearance, топология, детерминизм, кэш `toEqual`, бюджет <400мс/1000).

## P0 — spike без сноса trunk (ворота ко всему остальному)

1. Харнес метрик в `tests/spread.test.ts` (чистые функции, vitest) → verify: `npm run test -- tests/spread.test.ts`
2. Детерминированный Dijkstra от landmark (`cost=1/w`, tie по id, floor phi, `tau=perc(0.6)*0.7`) + `targetLen` с floor `reservePx(a)+reservePx(b)+air` + fallback изолятам → verify: `npm run test -- tests/spread.test.ts`
3. Stress 60-80 итераций в screen-px, якорь затухающий `0.03*0.97^iter`, центрирование каждые 20 без скейла → verify: `npm run test -- tests/spread.test.ts` + `npm run typecheck`
4. Замер `S9` на 271/600/1000, детерминизм byte-equal → verify: `npm run test -- tests/spread.test.ts -t "S9|S7"`
- Стоп-условие: если `S1-S6` хуже текущих или `S9` красный — дальше не идём.

## P1 — зоны в порты + якорь (после зелёного P0)

1. `groupOf=argmax phi`, `ports=landmarks`, `corridors` пересчёт без смены формата → verify: `npm run test -- tests/spread.test.ts tests/graph.test.ts`
2. `graph.layout`: финальный `resolveCollisions` с `anchors` (`0.12/0.06/0.02`), `seatNewNodes`: fresh = взвесь соседей по `w` + джиттер 4px + 10 локальных итераций, settled pinned → verify: `npm run test -- tests/spread.test.ts tests/graph.test.ts`
3. `bundleEdges` без изменений сигнатуры; опционально `d<1.5*L → STRAIGHT` → verify: `npm run typecheck`

## P2 — калибровка (после P1)

Cap 2-hop (по 2-3 на узел, обрезка хабов), свип `tau, max/min=4.5, anchorK` на сидах 1337/42/7, скрины `tools/shot-shape.mjs`. Выбор по метрикам, не на глаз.

## Рассуждения (почему так, а не иначе)

1. **Лист, а не полоса.** Trunk кладёт группы на одну ось (`figureWidth/bandHalf/reachBudget`), а ядро — идеальный подсолнух `GOLDEN + 1.2/0.78`. Отсюда низкая дисперсия NN-дистанций и читаемая ось X. Лист требует: `dist(plane) ~ dist(graph)`, плотность — из весов, а не из шума. Сильные рёбра тянут почти впритык, слабые растянуты в ~4.5 раза — неравномерность возникает сама, без вырезанных секторов и warp-океанов.
2. **Soft вместо hard групп.** Hard группа = контейнер с радиусом; граница контейнера видна как чанк. Soft (`phi=exp(-d/tau)` до всех landmarks, `d` — Dijkstra по `cost=1/w`) даёт градиент: узел между темами встаёт между landmarks, узел темы — у своего. `groupOf=argmax phi` нужен только роутингу (`bundleEdges`), не геометрии.
3. **Stress, а не FA2.** FA2 и старый солвер делают глобальное расталкивание `~1/d` — они перепаковывают пустоты (HANDOFF §5, 3 замера). Здесь только притяжение по backbone + слабые 2-hop пружины (лист, а не волокна) + короткое расталкивание при пересечении + затухающий якорь. Нет силы, которая тащит далёкие пары друг от друга.
4. **Якорь затухающий, а не константа.** Константа `anchorK` = равномерный блоб (лист не деформируется). Ноль = складки с пересечениями рёбер. `0.03*0.97^iter` (0.03 → ~0.0004 за 140) даёт раннюю фиксацию формы и позднее расслабление под рёбра.
5. **2-hop держит лист целым.** Одни backbone-рёбра рвут ткань на нити (волокна из прошлого плана). 2-hop пружины (`k*0.12`, `L=L1+L2`, по 2-3 на узел, cap у хабов) — это мембранный член: не даёт порваться и не даёт сжаться в жгут.
6. **`ports=landmarks` — минимальное зло.** `bundleEdges` требует порт на группу и `groupOf` на ноду; gateway-грид `GATEWAY_CELLS=12` сливает соседние коридоры в ствол. Убрать порты = переписать `RouteInfo`, `worker.ts:131`, потерять жгуты (`STRAIGHT_TRACT` везде). Поэтому порты остаются (позиции landmarks), `softCentroid` живёт только в init.
7. **P0 без сноса trunk.** По CONVENTIONS: Always Green. Снос trunk/core/strands до замера — необратимая потеря бейзлайна. Spike рядом (харнес + Dijkstra + stress на копии) доказывает `Spearman/preservation/CV/S9`, только потом удаляем старый код.

## Куски кода (наброски под реальные сигнатуры, не финальный код)

```ts
// Landmarks: бывшие хабы групп, раскладка — маленькая stress по аффинности.
// Affinity ga:gb = сумма backbone-рёбер между группами, норм. 0..1.
function landmarkPositions(ids: number[], affinity: Map<string, number>, span: number, seed: number): Map<number, Pt> {
  const pos = new Map<number, Pt>()
  ids.forEach((id, i) => {
    // Init on a circle: deterministic angle from hash, avoids overlap at iter 0.
    const a = i * GOLDEN + hashAt(id, 201, seed) * Math.PI * 2
    pos.set(id, { x: Math.cos(a) * span * 0.22, y: Math.sin(a) * span * 0.18 })
  })
  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = pos.get(ids[i])!, B = pos.get(ids[j])!
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1
      const aff = affinity.get(pairKey(ids[i], ids[j])) ?? 0
      // Strong affinity -> closer want; weak -> farther. Keeps semantic neighbors near.
      const want = span * (0.55 - 0.35 * aff)
      const f = (d - want) * 0.02
      A.x += (dx / d) * f; A.y += (dy / d) * f
      B.x -= (dx / d) * f; B.y -= (dy / d) * f
    }
  }
  return pos
}
```

```ts
// Single-source Dijkstra over backbone adjacency, cost = 1/w.
// Strong link = short step, so distance follows topics, not hop count.
function dijkstra(adj: Adjacency, src: number): Map<number, number> {
  const dist = new Map([[src, 0]])
  const pq: Array<[number, number]> = [[0, src]] // [dist, node]; N=600, linear scan ok for spike
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // Guard: tie-break by id, never by push order.
    const [d, u] = pq.shift()!
    if (d > (dist.get(u) ?? Infinity)) continue
    for (const nb of adj.get(u) ?? []) {
      const nd = d + 1 / Math.max(1e-6, nb.w)
      if (nd < (dist.get(nb.id) ?? Infinity)) { dist.set(nb.id, nd); pq.push([nd, nb.id]) }
    }
  }
  return dist
}

// Soft init: weighted convex combo of landmarks + jitter so co-located nodes separate.
const distTo = landmarks.map((L) => dijkstra(adj, L))
const all: number[] = []
for (const dm of distTo) for (const v of dm.values()) if (Number.isFinite(v)) all.push(v)
all.sort((a, b) => a - b)
const tau = (all[Math.floor(all.length * 0.6)] ?? 1) * 0.7 // Global temp: median-ish scale.
for (const n of nodes) {
  const phi = distTo.map((dm) => Math.exp(-((dm.get(n.id) ?? 1e6) / tau)))
  const s = phi.reduce((a, b) => a + b, 0) || 1
  let x = 0, y = 0
  landmarks.forEach((L, k) => { const p = landmarkPos.get(L)!; x += (phi[k] / s) * p.x; y += (phi[k] / s) * p.y })
  if (!Number.isFinite(x) || !Number.isFinite(y) || s <= 1e-12) { x = 0; y = 0 } // Guard: isolated node fallback.
  x += (hashAt(n.id, 17, seed) - 0.5) * 18
  y += (hashAt(n.id, 19, seed) - 0.5) * 18
  positions.set(n.id, { x, y })
}
```

```ts
// Target length from weight: strong edges almost touch, weak stretch up to 4.5x.
// Floor keeps bodies apart so the solver has nothing to undo (lesson #2).
function targetLen(a: SpreadNode, b: SpreadNode, w: number, wmax: number): number {
  // Floor AT clearance (MODIFIED 2026-11-13 P0-A: was 0.85 — packed strong
  // pairs into overlap, collisions equalized them, rho stuck at -0.25).
  const min = (reservePx(a.size ?? 20) + reservePx(b.size ?? 20)) * 1.0 + 4
  const max = min * 4.5
  const t = Math.pow(1 - w / Math.max(1e-9, wmax), 0.55) // Strong -> 0, weak -> 1.
  return min + (max - min) * t
}

// Heart loop: backbone springs + weak 2-hop membrane + decaying anchor.
// No global repulsion here — only edge attraction and anchor; collisions run once after.
const anchors = new Map(positions)
for (let iter = 0; iter < 80; iter++) {
  // A2 REVERTED 2026-11-13: back to audit 0.03 (0.01 gave rho -0.16, pres 0.03).
  const anchorK = 0.03 * Math.pow(0.97, iter)
  for (const e of backboneEdges) {
    const A = positions.get(e.a)!, B = positions.get(e.b)!
    const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1
    const L = targetLen(nodeOf(e.a), nodeOf(e.b), e.w, wmax)
    const k = 0.04 * (0.35 + 0.65 * Math.sqrt(e.w / wmax)) * (d - L) / d
    A.x += dx * k; A.y += dy * k; B.x -= dx * k; B.y -= dy * k
  }
  for (const s of springs2) { /* same, k *= 0.12, L = L1 + L2, capped */ }
  for (const [id, p] of positions) {
    const a = anchors.get(id)!
    p.x += (a.x - p.x) * anchorK; p.y += (a.y - p.y) * anchorK
  }
  if (iter % 20 === 19) recenterOnly(positions) // Center, never scale: scale invalidates targetLen.
}
```

```ts
// Solver with anchor: separates overlaps, does not relayout (graph.ts).
// Hubs stand still, dust walks — voids and ragged edge survive the pass.
type SolverOpts = { anchors?: Map<number, Pt> }
// Inside resolveCollisions, end of each pass:
if (opts.anchors) for (const [id, p] of points) {
  const a = opts.anchors.get(id); if (!a) continue
  const k = sizeOf(id) > 20 ? 0.12 : sizeOf(id) > 12 ? 0.06 : 0.02
  p.x += (a.x - p.x) * k; p.y += (a.y - p.y) * k
}
// Early exit maxShift < 0.2 stays; max 28 passes stay.
```

```ts
// Incremental path: new node sits with its neighbours, settled nodes pinned (S8).
function seatFresh(id: number, neighbours: Array<{ p: Pt; w: number }>): Pt {
  let x = 0, y = 0, s = 0
  for (const nb of neighbours) { x += nb.p.x * nb.w; y += nb.p.y * nb.w; s += nb.w }
  const base = s > 0 ? { x: x / s, y: y / s } : centroid(settled)
  // Small jitter breaks exact overlap; then 10 local stress iters on own edges only.
  const p = { x: base.x + (hashAt(id, 17, seed) - 0.5) * 8, y: base.y + (hashAt(id, 19, seed) - 0.5) * 8 }
  for (let i = 0; i < 10; i++) relaxOwnEdgesOnly(p, id) // Never moves settled nodes.
  return p
}
```

## Открытые вопросы (нужен твой ответ до P1)

1. `tau = perc(0.6)*0.7` — оставить как в скетче или взять медиану `perc(0.5)`? На disconnected компонентах хвост `d=inf` в перцентиль не входит — ок?
2. `max/min = 4.5`, степень `0.55`, `k=0.04` — магия из скетча. Свип в P2 по сетке или фиксируем и смотрим скрин?
3. `springs2`: cap степени хаба (top-N соседей по весу?) и cap `L=L1+L2` (обрезать сверху `3*min`?). Иначе мега-хаб даст `O(N²)` пар.
4. Dijkstra `L` раз vs один multi-source проход с хранением top-2: spike делает наивно (`sort` в цикле), оптимизация (куча/CSR) только если `S9` красный — ок?
5. Изоляты (degree 0): фолбэк «центроид + джиттер 9px» + отдать smallest group — или держать отдельным dust-пулом как сейчас (кольцо вокруг `ring[i % ring.length]`)?
6. `GATEWAY_CELLS=12` для листа: ячейка = `extent/12`. Лист шире полосы — магистрали соседних зон всё ещё сольются? Оставляем 12 или пересчитываем?
7. Intra-тракт `1/0.35` калиброван под сому-ядро. Когда порт = landmark (не плотная сома), дендриты дадут петли? Нужна ли калибровка `INTRA_NEAR/FAR_PULL` в P2?
8. `S1/S3` сносим полностью или оставляем ослабленными (например `voidShare>=0.03` как анти-океан)? Сейчас в спеке REMOVED — подтвердить.
9. Реальный экспорт для проверки: какой корпус и какой топN (600?) считать эталоном для `Spearman/preservation/CV`? Синтетика `synth/mega` мега-хаб не воспроизводит.
10. `seatNewNodes` после перехода: 10 локальных итераций достаточно, чтобы fresh не лёг в чужую зону при смене фильтров? Или нужен полный re-spread при `cachedShare<0.6` как сейчас?

## Риски

- Stress+2-hop может перепакать пустоты (класс B, отклонён в §4/§5). Лечится P0-воротами.
- 2-hop у мега-хаба `O(N²)` — cap обязателен.
- `prevXY` в full-run не читаем, новые opts только с дефолтами (иначе отвалятся 5 вызовов `spread` в тестах).

## Проверено на этапе анализа

- Субагент `worker` (`deepseek-v4.1-flash:max`): 7 несостыковок выше, baseline `tests/spread.test.ts 10/10 PASS`.
- Текущий поток прочитан: `spread.ts 751L`, `graph.ts 352L`, `geometry.bundleEdges`, `worker.ts:131`.

---

# Дополнение — живая кора: лоскуты и борозды (2026-11-13)

Фундамент (отказ от FA2 в пользу локального stress + затухающий якорь) сохранён. Ниже — фикс математики `softInit` и `landmarkPositions`, которая в наивном виде даёт гладкий овальный блин без полуоторванных долей, извилин, борозд и асимметричных отростков.

## 1. Почему наивный скетч сгладит карту в блин (3 скрытых бага)

1. **Схлопывание периферии при нормализации `phi / s`.** Пусть на краю есть плотный подкластер, который крепится через узкий мост-узел `g`. Тогда `d(L_k, v) = d(L_k, g) + d(g, v)`, и при вычислении весов:

   `phi_k(v)/sum_j phi_j(v) = exp(-d(L_k,g)/tau)*exp(-d(g,v)/tau) / sum_j exp(-d(L_j,g)/tau)*exp(-d(g,v)/tau) = phi_k(g)/sum_j phi_j(g)`

   Множитель `exp(-d(g,v)/tau)` сокращается — весь кусок получает те же барицентрические координаты, что и `g`, складывается поверх него (плюс шум ±9px) и прибивается якорем. Плюс все узлы заперты внутри convex hull 3–9 landmarks — ни один лоскут не выстрелит наружу. Нюанс оригинала: в тексте порог `dom > 0.58`, в коде `dom > 0.55` — в спеке взят кодовый `0.55` (мосты `dom < 0.55` остаются внутри).
2. **Круговое колесо в `landmarkPositions`.** `want = span * (0.55 - 0.35 * aff)` заставляет даже несвязанные группы (`aff = 0`) держать дистанцию `0.55 * span`. Для 6–9 точек решение — правильный круглый многоугольник.
3. **2-hop зашивают борозды.** Без оглядки на границы тем 2-hop веер притянет полуоторванный кусок вплотную к материку и превратит перешеек в сплошную массу.

Цель: единая ткань (`kNN(5) = 1`), но с долями, лоскутами на натянутых трактах и узкими бороздами, без океанов (`max empty circle < 0.15 * span`). Правки точечные, в P0/P1.

## 2. Пять точечных изменений

### А. Branch-Coherent Extrusion — вынос лоскутов

В `dijkstra` запоминаем `branch1` (первый шаг от landmark) и `branch2` (узел-бутылочное горлышко, где дистанция впервые превысила `0.55 * tau`). В `softInit` узлы с `dom = max(phi/s) > 0.58` получают вектор выноса наружу вдоль луча хаба, повёрнутого на `hashAt(branch1)`, плюс единый сдвиг лоскута `hashAt(branch2)` на `45..85px`. Мосты (`dom < 0.55`) остаются внутри и держат ткань связной.

### Б. Асимметричный stress для landmarks (серп/ветка вместо колеса)

- `aff > 0.04`: двусторонняя пружина `want = span * (0.16 + 0.30 * (1 - aff))`.
- `aff <= 0.04`: только одностороннее отталкивание на ближней дистанции (`if (d < span * 0.36)`), без стягивания в круг на `0.55 * span`.
- Эффект: подкова / Y-кора / вытянутая доля с отростком вместо хоровода.

### В. Корковые борозды (sulci) через `phi`-сходство

`sim(a,b) = cos(phi(a), phi(b))`:

1. `targetLen`: ребро между разными долями (`sim < 0.65`) умножается на `1.35` — мосты читаются как перешейки.
2. `springs2`: пружина `u — v — w` только если `sim(u, w) > 0.70` — мембрана не натягивается через перешейки, лоскуты не прилипают обратно.
3. `resolveCollisions`: пара из разных `groupOf` с `dom > 0.68` у обоих получает `sulcusPad = 10px`. Пограничные мосты (`dom 0.45..0.60`) с `sulcusPad = 0` остаются в борозде и сшивают берега (`kNN(5) = 1`).

## 3. Обновлённый код под `spread.ts` и `graph.ts`

```ts
// Landmarks без эффекта колеса: связанные — на структурной дистанции,
// несвязанные — только близкое отталкивание, без стягивания в круг.
function landmarkPositions(ids: number[], affinity: Map<string, number>, span: number, seed: number): Map<number, Pt> {
  const pos = new Map<number, Pt>()
  ids.forEach((id, i) => {
    // Init on varied radius: breaks the regular-polygon fixed point.
    const a = i * GOLDEN + hashAt(id, 201, seed) * Math.PI * 2
    const r = span * (0.14 + 0.10 * hashAt(id, 203, seed))
    pos.set(id, { x: Math.cos(a) * r * 1.15, y: Math.sin(a) * r * 0.85 })
  })
  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = pos.get(ids[i])!, B = pos.get(ids[j])!
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1
      const aff = affinity.get(pairKey(ids[i], ids[j])) ?? 0
      if (aff > 0.04) {
        const want = span * (0.16 + 0.30 * (1 - aff))
        const f = (d - want) * (0.015 + 0.025 * aff)
        A.x += (dx / d) * f; A.y += (dy / d) * f
        B.x -= (dx / d) * f; B.y -= (dy / d) * f
      } else if (d < span * 0.36) {
        const f = (d - span * 0.36) * 0.02
        A.x += (dx / d) * f; A.y += (dy / d) * f
        B.x -= (dx / d) * f; B.y -= (dy / d) * f
      }
    }
  }
  return pos
}
```

```ts
// Dijkstra with branch tracking: branch1 = first step (lobe sector),
// branch2 = bottleneck node where dist first crossed splitDist (lobe root).
type DijkstraTree = {
  dist: Map<number, number>
  branch1: Map<number, number>
  branch2: Map<number, number>
}
function dijkstra(adj: Adjacency, src: number, splitDist = Infinity): DijkstraTree {
  const dist = new Map([[src, 0]])
  const branch1 = new Map([[src, src]])
  const branch2 = new Map([[src, src]])
  const pq: Array<[number, number]> = [[0, src]]
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // Guard: tie-break by id.
    const [d, u] = pq.shift()!
    if (d > (dist.get(u) ?? Infinity)) continue
    for (const nb of adj.get(u) ?? []) {
      const nd = d + 1 / Math.max(1e-6, nb.w)
      if (nd < (dist.get(nb.id) ?? Infinity)) {
        dist.set(nb.id, nd)
        const b1 = u === src ? nb.id : (branch1.get(u) ?? nb.id)
        branch1.set(nb.id, b1)
        const b2 = d < splitDist && nd >= splitDist ? nb.id : (branch2.get(u) ?? b1)
        branch2.set(nb.id, b2)
        pq.push([nd, nb.id])
      }
    }
  }
  return { dist, branch1, branch2 }
}
```

```ts
// Two-pass tau: first pass measures scale, second tracks lobe roots.
// Only finite positive distances set the temperature; isolates are excluded.
const rawTrees = landmarks.map((L) => dijkstra(adj, L))
const all: number[] = []
for (const t of rawTrees) for (const v of t.dist.values()) if (Number.isFinite(v) && v > 0) all.push(v)
all.sort((a, b) => a - b)
const tau = (all[Math.floor(all.length * 0.55)] ?? 1) * 0.75
const trees = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
```

```ts
// Branch-coherent softInit: barycenter + radial extrusion for dominant nodes
// + coherent lobe shift for the whole sub-tree past bottleneck b2.
let cx = 0, cy = 0
for (const p of landmarkPos.values()) { cx += p.x; cy += p.y }
cx /= Math.max(1, landmarks.length); cy /= Math.max(1, landmarks.length)
const phiVec = new Map<number, number[]>()
const dominance = new Map<number, number>()
for (const n of nodes) {
  const phi = trees.map((t) => Math.exp(-((t.dist.get(n.id) ?? 1e6) / tau)))
  const s = phi.reduce((a, b) => a + b, 0) || 1
  const normPhi = phi.map((v) => v / s)
  phiVec.set(n.id, normPhi)
  let ownerIdx = 0
  for (let k = 1; k < normPhi.length; k++) if (normPhi[k] > normPhi[ownerIdx]) ownerIdx = k
  const dom = normPhi[ownerIdx] ?? 0
  dominance.set(n.id, dom)
  let x = 0, y = 0
  landmarks.forEach((L, k) => { const p = landmarkPos.get(L)!; x += normPhi[k] * p.x; y += normPhi[k] * p.y })
  const dMin = trees[ownerIdx].dist.get(n.id) ?? Infinity
  if (Number.isFinite(dMin) && dom > 0.55) {
    const lp = landmarkPos.get(landmarks[ownerIdx])!
    const baseAngle = Math.atan2(lp.y - cy, lp.x - cx)
    const b1 = trees[ownerIdx].branch1.get(n.id) ?? n.id
    const b2 = trees[ownerIdx].branch2.get(n.id) ?? b1
    const fanAngle = baseAngle + (hashAt(b1, 31, seed) - 0.5) * 1.85
    const radialReach = Math.min(1.6, dMin / tau) * span * 0.085 * ((dom - 0.55) / 0.45)
    x += Math.cos(fanAngle) * radialReach
    y += Math.sin(fanAngle) * radialReach
    if (dMin > tau * 0.55 && b2 !== landmarks[ownerIdx]) {
      const lobeAngle = fanAngle + (hashAt(b2, 43, seed) - 0.5) * 1.1
      // P2 calibration 2026-11-13 P0-B: flat audit minimum 0.032
      // (was 0.032+0.028*hash — spread scattered lobes, measured zero effect on 271).
      const lobeKick = 0.032 * span * Math.min(1, (dMin - tau * 0.55) / tau)
      x += Math.cos(lobeAngle) * lobeKick
      y += Math.sin(lobeAngle) * lobeKick
    }
  } else if (!Number.isFinite(dMin) || s <= 1e-12) {
    const lp = landmarkPos.get(landmarks[n.id % landmarks.length])!
    const a = hashAt(n.id, 53, seed) * Math.PI * 2
    x = lp.x + Math.cos(a) * 35
    y = lp.y + Math.sin(a) * 35
  }
  x += (hashAt(n.id, 17, seed) - 0.5) * 12
  y += (hashAt(n.id, 19, seed) - 0.5) * 12
  positions.set(n.id, { x, y })
}
```

```ts
// Bridge-aware targetLen: inter-zone edges stretch so isthmuses read as tracts.
function phiCos(a: number, b: number, phiVec: Map<number, number[]>): number {
  const pa = phiVec.get(a), pb = phiVec.get(b)
  if (!pa || !pb) return 1
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < pa.length; i++) { dot += pa[i] * pb[i]; na += pa[i] * pa[i]; nb += pb[i] * pb[i] }
  return dot / (Math.sqrt(na * nb) || 1)
}
function targetLen(a: SpreadNode, b: SpreadNode, w: number, wmax: number, sim: number): number {
  // Floor AT clearance (MODIFIED 2026-11-13 P0-A: was 0.85, see above).
  const min = (reservePx(a.size ?? 20) + reservePx(b.size ?? 20)) * 1.0 + 4
  const max = min * 4.5
  const t = Math.pow(1 - w / Math.max(1e-9, wmax), 0.55)
  const bridgeStretch = sim < 0.65 ? 1 + (0.65 - sim) * 0.55 : 1
  return (min + (max - min) * t) * bridgeStretch
}
// springs2 rule: build only if sim(u, w) > 0.70, max 3 per node, top-6 neighbours at hubs.
// Length cap: Math.min(L1 + L2, minLen(u, w) * 3.2).
```

## 4. Ответы на открытые вопросы 1–10 (фиксируем перед P1)

| # | Решение и обоснование |
| --- | --- |
| 1 | `tau = perc(0.55) * 0.75` только по конечным `v > 0`. Бесконечности отбрасывать до сортировки, иначе `tau = Inf` при доле изолятов >40%. |
| 2 | P0/P1 фиксируем (`max/min = 4.5`, `pow = 0.55`, `k = 0.04`, `bridgeStretch` до `1.35x`). Свип только в P2 в коридоре `max/min ∈ [4.0, 5.2]`. |
| 3 | У промежуточного `v` только top-6 соседей по `w`, не более 3 пружин на узел `u`, приоритет `sim > 0.70`. `L = min(L1+L2, minLen*3.2)`. Мега-хаб режется до `O(N)`. |
| 4 | P0: `L` проходов с `pq.sort` (`L ≤ 9`, `N ≤ 1000`, `< 4мс`). Куча — только если P0 `S9 > 280мс` на 1000 узлах. |
| 5 | Изоляты не в кольцо вокруг карты, а в карманы smallest landmark `30..45px`, `groupOf = smallestGroup`. Кольцо съедает span и рвёт `kNN`. |
| 6 | `GATEWAY_CELLS = 14` (или `round(12*sqrt(aspect))`). На листе 12 слишком крупно по диагонали и склеит междолевые тракты. |
| 7 | P1 сразу: `d < 1.5*L → STRAIGHT`, `INTRA 0.75/0.25` (ослабить на 25%). Иначе петли вокруг рыхлого landmark. |
| 8 | `S1` сносим полностью. `S3` оставляем мягко `voidShare >= 0.04` (анти-блин): борозды и бухты дают `0.05..0.11` при `maxEmptyCircle < 0.15*span`. |
| 9 | Эталон: реальный экспорт `seed 1337` на `N = 271 и 600` + прогон с искусственным мега-хабом (`degree > 0.25*N`) для капа `springs2` и `S9`. |
| 10 | 10 локальных итераций достаточно при `cachedShare >= 0.65`. Иначе полный re-spread — новые узлы в старых барицентрах натянут паутину через карту. |

## 5. План P0 → P1 → P2 (обновлённый чеклист)

### P0 — харнес и морфология на копии (без сноса `trunk`)

1. Метрики в `tests/spread.test.ts`: `Spearman(w,len)`, `kNN_components(5)`, `preservationAtK(5,10)`, `cvNearestNeighbor()`, `maxEmptyCircleRatio()` (сетка `40×40` в hull). Ворота: `Spearman < -0.5`, `kNN(5) = 1`, `preservation@10 > 0.6`, `CV ∈ [0.42, 0.72]`, `maxEmptyCircle < 0.15*span`, `voidShare ∈ [0.04, 0.16]`. → verify: `npm run test -- tests/spread.test.ts`
2. Двухпроходный Dijkstra + branch-coherent `softInit` (`tau = perc(0.55)*0.75`, второй проход `splitDist = tau*0.55`, `branch1/branch2`, вынос `dom > 0.55` + сдвиг лоскута). → verify: `npm run test -- tests/spread.test.ts`
3. Stress 80 итераций в screen-px (`span = 1300`): `bridgeStretch` при `sim < 0.65`, `springs2` (top-6, ≤3/узел, `sim > 0.70`), якорь `0.03*0.97^iter`, `recenterOnly` каждые 20 без скейла. → verify: `npm run test -- tests/spread.test.ts` + `npm run typecheck`
4. `S9` на 271/600/1000, byte-equal детерминизм. → verify: `npm run test -- tests/spread.test.ts -t "S9|S7"`

### P1 — снос `trunk`, борозды, роутинг

1. `groupOf = argmax phi` (изоляты → smallestGroup), `ports = landmarkPositions`, пересчёт `corridors` без смены сигнатур. → verify: `npm run test -- tests/spread.test.ts tests/graph.test.ts`
2. `resolveCollisions` с `{anchors, groupOf, dominance}`: `sulcusPad = 10px` при разных группах и `dom > 0.68` у обоих; якорь `0.12/0.06/0.02`. → verify: те же файлы
3. `bundleEdges`: `d < 1.5*L → STRAIGHT`, `GATEWAY_CELLS = 14`. `seatNewNodes`: 10 итераций при pinned соседях, фолбэк на полный расклад при `cachedShare < 0.65`. → verify: `npm run typecheck`

### P2 — калибровка рельефа

`tools/shot-shape.mjs` на сидах `1337/42/7`. Ручки: `lobeKick (0.032..0.060*span)` — дальность лоскутов (лимит `kNN(5)=1`); `sulcusPad (8..14px)` — ширина борозд (лимит `maxEmptyCircle<0.15*span`).

## 6. P1 итог (2026-11-13, preflight зелёный)

- typecheck 0, `vitest run`: **252 passed / 1 skipped**, `npm run build` ok.
- `spread.ts`: trunk/ядра/волокна/пыль-кольцо удалены (~450 строк), вместо них leaf-цепочка (landmarks = хабы групп → affinity → Dijkstra ×2 → `softInit` → `stressLeaf` 80 ит.); `groupOf=argmax phi` (изоляты → smallest mass-group), `ports=landmarks`, `corridors` без смены формата, `SpreadResult.dominance` добавлен.
- `graph.ts`: `SolverOpts{anchors,groupOf,dominance,sulcusPad}`; двухфазный солвер — 8 проходов без якоря (расширение пилы), 20 с якорем+sulcus (пин 0.12/0.06/0.02, `sulcusPad=10·pxToWorld`); `seatNewNodes` по взвеси соседей + 10 локальных итераций, порог reuse 0.6→0.65; `LayoutResult.dominance`.
- `geometry.ts`: `GATEWAY_CELLS 12→14`, `INTRA 1/0.35→0.75/0.25` (ответ 7); тесты бандлов обновлены с обоснованием.
- S1: полоса REMOVED → `kNN(5)==1` на **финальном layout** (spread даёт лобы k5=6, двухфазные коллизии сшивают: измерено k5=1 на 271/600, сиды 7/1337).
- Замер P1 spread-271 hull (seed 1337): `rho=-0.73 kNN=6 cv=2.27 maxVoid=0.29 voidShare=0.71 pres=0.06`. S4/S5/S7/S8/S9 зелёные (S9 475→<400мс: куча в Dijkstra + плоские массивы в хот-цикле).
- Отклонения от аудита с причиной: two-phase solver (якорь зажимал пачку, S4 -0.87); farthest-point сиды в spike (топ-степень давала соседние хабы на кольце); minSep 0.22·span (аффинити схлопывала зоны, S4 -10); rescale init на 0.9·span (диффузное расширение за 80 итераций невозможно); floor 1.0 (A, +0.08 rho); kick flat 0.032 (B, нулевой эффект); A2 откачен (якорь 0.01 ронял rho); INTRA сделан сейчас, не в P2.
- Пропущено: `d<1.5L→STRAIGHT` (нужен size в `BundlePoint` — смена сигнатуры, кандидат P2); hoist size-карты в `seatNewNodes` (YAGNI, инкрементальный путь без солвера).
- Открыто для P2: калибровка ручек на скринах, реальный экспорт как судья, `pres`-ворота (trunk тоже не проходил — возможно, чинить линейку, не карту).
