# Handoff: лист коры — вся сессия целиком (2026-11-13)

Цель документа: передать **другому человеку** полный контекст, чтобы он предложил,
как исправить текущее состояние. Факты, код, замеры — без выводов, которые не доказаны.

## 0. Проект и стартовая точка

ChatMap: offline-визуализация Telegram-экспорта (слова-узлы, совместные встречи-рёбра).
Чистая логика `src/core/` (vitest), layout считается в web worker (`src/core/worker.ts`
→ `layout()` в `src/core/graph.ts` → `spread()` в `src/core/spread.ts` → рендер sigma v4).
Тесты только на `src/core/`. Preflight: `typecheck + test + build`, всегда зелёный.

Стартовый layout (до сессии), `src/core/spread.ts` 751 строка:
- группы (`labelPropagate` + `partition` + `mergeToTarget` 3..9) на **одной горизонтальной
  оси** (`figureWidth/bandHalf/reachBudget`), ядра — идеальный подсолнух
  (`GOLDEN = PI*(3-sqrt5)`, `x*cos*r*1.2, y*sin*r*0.78`), райдеры — веер `FAN_HALF=0.62`
  с равномерным `pitch = 2.6*size+14` и `densityAt(t) = 1+5t²`, пыль — кольцо вокруг ядра.
- `graph.ts`: адаптер (`pxToWorld`), `resolveCollisions` O(N²), 28 проходов, `padScale`
  (`dustTight`: пыль 0.45, хабы 1.15), `seatNewNodes` — золотое кольцо
  `FRAME_START*(index+1)`, reuse-порог `cachedShare >= 0.6`.
- Гейты `tests/spread.test.ts`: S1 полоса `spanX/spanY ∈ [1.3, 3.2]`, S2 nuclei/clump,
  S3 `voidShare>=0.1`, S4 clearance, S5 топология, S6 strand, S7 детерминизм,
  S8 инкремент (`toEqual` кэша), S9 бюджет <400мс/1000 нод.

Жалоба пользователя: карта — «ботаника, а не нейро-карта»: регулярность, нет пустот,
нет асимметрии. Требование в конце сессии: **вытянутая плоскость, а не круг**.

## 1. План пользователя (два сообщения, сжато)

Отказ от FA2 (равномерно расталкивает). Assignment-based, сломать регулярность.
Финальная метафора: **смятый лист коры** — связная ткань (`kNN(5)=1`, без островов
и океанов), плотность из графа, `dist(plane) ~ dist(graph)`.

Новый pipeline в `spread.ts`:
```
landmarks (хабы групп) -> soft affinity (Dijkstra cost=1/w, phi=exp(-d/tau))
  -> init = взвесь landmarks -> stress по backbone (targetLen от веса)
  + слабые 2-hop пружины + затухающий якорь -> resolveCollisions с якорем
```
Архетипы групп, мини-ядра, warp, voids — отвергнуты во втором сообщении
(дают чанки/океаны). Оставлено: landmarks мягко, stress 140 итераций (потом 80),
`anchorK = 0.03*0.97^iter`, `targetLen` с `max/min=4.5`, `springs2` (`k*0.12`),
якорь солвера по размеру (0.12/0.06/0.02), `bundleEdges` от `softCentroid`,
`seatNewNodes` по соседям. Метрики: `Spearman < -0.5`, `kNN=1`,
`preservation@10 > 0.6`, `CV 0.4..0.7`, `max empty circle < 0.15*span`.

Аудит пользователя (5 точечных изменений, учтены все):
- A. Branch-coherent extrusion: `branch1` (первый шаг), `branch2` (перешеек
  `splitDist = tau*0.55`), вынос `dom > 0.55` + сдвиг лоскута.
- Б. Асимметричный stress landmarks (серп вместо колеса): `aff > 0.04` тянуть,
  иначе только близкое отталкивание (`d < 0.36*span`).
- В1. `targetLen` ×1.35 при `sim(a,b) < 0.65` (межзонные мосты длиннее).
- В2. `springs2` только при `sim(u,w) > 0.70` (не зашивать борозды).
- В3. Борозды в солвере: `sulcusPad = 10px` если оба `dom > 0.68` и группы разные.
Ответы 1–10 зафиксированы (tau, капы, `GATEWAY_CELLS=14`, `INTRA 0.75/0.25`,
изоляты в карман smallest-группы, `cachedShare >= 0.65`).

## 2. Что реализовано (файлы)

### 2.1. `src/core/leaf.ts` (НОВЫЙ, spike → переиспользован в production)

Dijkstra с трекингом веток + бинарная куча (куча добавлена позже: наивный
`pq.sort()` давал S9 = 601мс; лимит на кучу из аудита: только если S9 > 280мс):

```ts
type DijkstraTree = { dist: Map<number, number>; branch1: Map<number, number>; branch2: Map<number, number> }
function dijkstra(adj: Adjacency, src: number, splitDist = Infinity): DijkstraTree {
  // ... binary heap ordered by (dist, id); tie-break by id, never push order
  // cost = 1 / max(1e-6, w); branch1 = first step, branch2 = bottleneck crossing splitDist
}
```

Температура и soft-init (барицентр + вынос `dom > 0.55` + сдвиг лоскута +
изоляты в карман smallest + **рескейл облака на `0.9*span`** — добавлен позже,
см. §4.2):

```ts
export function computeTau(trees: DijkstraTree[]): number {
  // perc(0.55) * 0.75 только по конечным v > 0 (изоляты d=Inf отброшены)
}
export function softInit(nodes, landmarks, landmarkPos, trees, tau, seed, smallest?): SoftInit {
  // phi = exp(-d/tau)/sum; owner = argmax phi; dominance = max phi;
  // extrusion: fanAngle = base + (hash(b1)-0.5)*1.85, reach = min(1.6,dMin/tau)*span*0.085*((dom-0.55)/0.45);
  // lobe: kick = 0.032*span*min(1,(dMin-tau*0.55)/tau) — flat audit-минимум (был 0.032+0.028*hash)
  // rescale: uniform anode? НЕТ — см. §5: позже заменён на анизотропный LEAF_ASPECT (ниже)
}
```

Целевая длина и stress (якорь 0.03; проба 0.01 откачена — см. §3, A2):

```ts
export function targetLen(aSize, bSize, w, wmax, sim): number {
  const min = (reservePx(aSize) + reservePx(bSize)) * 1.0 + 4; // MODIFIED: было 0.85 (A)
  const max = min * 4.5;
  const t = Math.pow(1 - w / Math.max(1e-9, wmax), 0.55);
  const stretch = sim < 0.65 ? 1 + (0.65 - sim) * 0.55 : 1; // bridgeStretch до 1.35
  return (min + (max - min) * t) * stretch;
}
// stressLeaf: 80 итераций, k = 0.04*(0.35+0.65*sqrt(w/wmax)), springs k*0.12,
// anchorK = 0.03*0.97^iter, recenterOnly каждые 20 (без скейла).
// buildSprings: top-6 соседей у хаба, <=3 пружин на узел, sim > 0.70,
//   rest = min(L1+L2, minLen*3.2).
```

Landmarks и цепочка:

```ts
export function pickLandmarks(adj, nodes, k): { landmarks; trees } {
  // seed = max degree (tie: min id), дальше farthest-point (max min-dist, tie min id).
  // Причина: чистый top-k даёт k соседних хабов на равномерных графах (кольцо) —
  // зоны не покрывают граф, S4 падал с worst=-10.17.
}
export function landmarkPositions(ids, affinity, span, seed): Map<number, Pt> {
  // init: угол i*GOLDEN + hash, радиус span*(0.14+0.10*hash);
  // aff > 0.04: want = span*(0.16+0.30*(1-aff)), k = 0.015+0.025*aff;
  // иначе: только отталкивание при d < 0.36*span;
  // + MIN-SEP пол 0.22*span (аффинити схлопывала зоны: minPort 115px на кольце-271).
}
export function leafLayout(nodes, edges, seed, iters = 80) { /* pickLandmarks → tau → softInit → stressLeaf → resolveLeafCollisions */ }
```

### 2.2. `src/core/spread.ts` (переписан placement, ~450 строк trunk-грамматики удалено)

- Группы (`detectGroups/orderGroups`), хаб = max intra-degree (tie: min id) — остались.
- Аффинити групп = сумма весов кросс-рёбер, норма на max; `landmarkPositions(groupIds, affinity, span, seed)`.
- Dijkstra от хабов (×2 прохода, второй с `splitDist = tau*0.55`), `softInit(nodes, hubs, landmarkPos keyed by hub, ..., smallest = hub smallest-mass группы)`, `groupOf = argmax phi` (изоляты → smallest group), `ports = landmarkPos`, `corridors` без изменений, `SpreadResult.dominance` добавлен.
- `stressLeaf(..., {iters: 80})`, затем только центрирование (без фита).
- Удалено: `GOLDEN/CORE_SHARE/FAN_HALF/pitch/densityAt/growStrand/strandAt/walkOrder/avoidOf/meander/valueNoise1/FIGURE_ASPECT`-использования (константа-экспорт оставлена, используется small-nodes кольцом <8 нод).
- Рамка: `SPREAD_ASPECT = 1.8`, stretch-only (см. §5).

### 2.3. `src/core/graph.ts`

- `SolverOpts {anchors?, groupOf?, dominance?, sulcusPad?}`; хот-цикл на плоских
  массивах (Int32/Float64/Uint8, ноль Map-get на пару — S9).
- Двухфазный солвер: 8 проходов без якоря (расширение пачки) + 20 с якорем
  (`anchors` = снапшот после фазы 1!) + sulcus. Причина двухфазности: якорь
  пригвождает узел к упакованному init (равнодействующая ~0), S4 стоял на worst=-0.87.
- `seatNewNodes(nodes, edges, positions, seed)`: взвешенное по `w` среднее соседей
  + джиттер ±4px + 10 локальных итераций (settled pinned); золотое кольцо удалено;
  порог reuse 0.6 → **0.65** (ответ 10 аудита).
- `LayoutResult.dominance`; `sulcusPad = 10*pxToWorld`; якорь `0.12/0.06/0.02`.
- `GATEWAY_CELLS 12 → 14`, `INTRA 1/0.35 → 0.75/0.25` — в `geometry.ts`.

### 2.4. Тесты

- `tests/leaf.test.ts` (16 тестов): детерминизм, tau, branch2, isolate-карман,
  экструзия, targetLen floor/4.5x/bridge, phiCos, springs cap, stressLeaf
  детерминизм + strong<weak, sulcus (сепарация/мост/якорь), P0.4 timing 271/600.
- `tests/spread.test.ts`: S1 полоса REMOVED → `kNN(5)==1` **на финальном layout**
  + аспект [1.6, 2.0]; остальные S2–S9 живы (S3/S6 пережили смену грамматики).
  Пробники метрик (Spearman/kNN/CV/maxVoid/voidShare/pres) без гейтов.
- `tests/graph.test.ts`: +anchor держит хабы, +sulcus только кросс-зона/доминанты.
- `tests/geometry.test.ts`: intra-тест обновлён под 0.75/0.25.
- `tools/inkbox.ps1` (новый): попиксельный ink-bbox PNG (аргумент против глазомера).

## 3. Все замеры по порядку (synth-271 hull, seed 1337, если не сказано иное)

| Этап | rho (<-0.5) | kNN (1) | pres@10 (>0.6) | CV (0.42–0.72) | maxVoid (<0.15) | voidShare (0.04–0.16) |
|---|---|---|---|---|---|---|
| trunk baseline | -0.229 | 1 | 0.289 | 0.700 | 0.138 | 0.429 |
| leaf v1 (affinity пустая) | **-0.762** | 5 | 0.058 | 1.399 | 0.270 | 0.622 |
| leaf v2 (+affinity зон) | **-0.760** | 2 | 0.017 | 1.174 | 0.230 | 0.417 |
| leaf + B3 (sulcus+якорь) | -0.251 | **1** | 0.076 | 0.986 | **0.130** | 0.257 |
| + floor 1.0 (A) | -0.334 | 1 | 0.051 | 1.030 | 0.152 | 0.313 |
| + kick flat 0.032 (B) | -0.334 | 1 | 0.051 | 1.030 | 0.152 | 0.313 |
| A2 якорь 0.01 | -0.16 | 1 | 0.03 | — | — | — → **ОТКАЧЕНО** (якорь хранит сигнал init) |
| P1 production spread() | -0.73 | 6 | 0.06 | 2.27 | 0.29 | 0.71 |
| P1 layout (финал) | — | **1** | — | — | — | — |

Ключевые находки по ходу:
- B3 (коллизии) чинит связность (kNN 2→1) и пустоты, но убивает rho (-0.76→-0.25):
  uniform-клиренс `ra+rb` + `sulcusPad` всем парам без оглядки на вес равняет сильные рёбра.
- A (floor 0.85→1.0): +0.08 к rho. B: нулевой эффект (кик почти не триггерится).
- S4 saga: worst=-10.17 (пачка; якорь держит) → двухфазный солвер → green.
- S9: 601ms → <400ms (бинарная куча в Dijkstra + плоские массивы в хот-цикле).
- minSep 0.22·span: аффинити схлопывала лендмарки (minPort 115px на кольце-271).
- rescale init на 0.9·span: stress диффузно не расширяет пачку за 80 итераций (кольцу-271 нужно O(N²)).

## 4. Сага «круг» (главный открытый вопрос)

1. Жалоба: карта круглая. Замер layout-аспекта (synth): **0.79** (портрет!).
2. `LEAF_ASPECT=1.9` в рескейле init → 1.36/1.13 (271/600).
3. `SPREAD_ASPECT=1.5` в рамке spread → 1.49/1.20 (солвер скругляет большую карту).
4. Hold 1.5 в `layout` после солвера (stretch-only): ровно **1.50/1.50**, S1-gate. S4 зелёный.
5. Подозрение на stale-код: проверено — `worker.ts` пишет в консоль
   `[chatmap-layout] leaf-P1 aspect hold 1.8: nodes=600 aspect=1.50 fullRun=true`
   (сейчас строка говорит 1.8 после п.7). У пользователя строка есть → код новый,
   fullRun, 600 нод, аспект 1.50 **в данных**.
6. Подозрение на рендер: прочитан `sigma.esm.js` — `createNormalizationFunction`
   uniform (`ratio = max(w,h)`), камера uniform. Рендер невиновен.
7. Харнес `shot-shape.mjs`: gaps-probe меряет aspect через `graphToViewport`
   (экранные px): **1.5/1.8** — экран честный на синтетике.
8. Попиксельный замер чернил (`tools/inkbox.ps1`, порог lum>48, кроп по канве):
   - пользовательский скрин (реальный экспорт): **ink 1.26 при дате 1.50**;
   - синтетика: **ink 1.54 при дате 1.5** и **1.54 при дате 1.8** (два разных PNG!).
9. Вывод: чернила трекают дату с ~0.85x (гигантские топ/боттом хабы + подписи
   раздувают вертикаль). Таргет поднят **1.5 → 1.8** (`SPREAD_ASPECT` + hold +
   строка лога + S1-gate [1.6, 2.0]). Синтетика: зонд 1.8, чернила 1.54.
10. Статус: префлайт зелёный (typecheck 0, 252 passed / 1 skipped, build ok).
    Пользователь должен Ctrl+F5 + переоткрыть JSON и прислать скрин; чернила
    ожидаются ~1.5. На момент документа — скриншота после 1.8 нет.

## 5. Вопросы к консультанту (что спросить у другого человека)

1. **Чернила vs дата.** Чернила трекают аспект центров с ~0.85x, причём по-разному
   на корпусах (реал 1.26/1.5, синтетика 1.54/1.8). Правильно ли вообще гнаться за
   числом в рамке? Или вытянутость должна следовать из данных (например, вдоль
   главной оси аффинности / PCA landmarks), а не из фиксированной константы?
2. **`preservation@10 ≈ 0.05` везде** (trunk 0.29, leaf 0.02–0.08). Ворота >0.6
   не выполняет никто. Это ворота кривые для звездообразных графов (у хаба 20
   соседей, в топ-10 плоскости все не влезут), или раскладка реально рвёт соседство?
3. **Два толстых диагональных жгута** вместо одного ствола на реальном экспорте
   (коридоры «меня»/«просто» идут рядом, но не сливаются). `GATEWAY_CELLS=14`
   слишком мелко? Или порты слишком далеко друг от друга?
4. **rho умирает в коллизиях** (-0.76 без них → -0.25 с ними): uniform-клиренс
   `ra+rb` равняет сильные рёбра. Лечится ли это весозависимым клиренсом
   (сильные пары ближе), или это принципиальный конфликт «clearance vs семантика»?
5. **CV 1.0–2.3 против ворот 0.42–0.72.** Ворота взяты из аудита; trunk давал 0.70.
   Это признак болезни (рваные выбросы) или ворота надо перекалибровать под лист?
6. **Диагональная ось.** На реальном скрине внутренняя структура идёт по диагонали
   (жгуты сверху-влево вниз-вправо). Если главная ось данных диагональна, фиксированная
   горизонтальная вытяжка работает против графа. Стоит ли ориентировать плоскость
   по данным?

## 6. Где что лежит (для быстрого старта консультанта)

- План и эволюция решений: `specs/2026-11-13-leaf-tissue-plan.md` (§1-6 + дополнение «живая кора»).
- Spike-движок: `src/core/leaf.ts` (Dijkstra+куча, tau, softInit+рескейл, targetLen, stressLeaf, springs, resolveLeafCollisions, pickLandmarks, landmarkPositions, leafLayout).
- Production: `src/core/spread.ts` (цепочка §~430-520, рамка SPREAD_ASPECT в конце), `src/core/graph.ts` (SolverOpts, двухфазный солвер, holdAspect, seatNewNodes), `src/core/geometry.ts` (GATEWAY_CELLS=14, INTRA 0.75/0.25).
- Диагностика: `src/core/worker.ts` — строка `[chatmap-layout]` с аспектом после каждого fullRun.
- Замеры: `tests/spread.test.ts` (пробники + S1 kNN+аспект), `tests/leaf.test.ts` (16 шт.), `tools/shot-shape.mjs` (харнес), `tools/inkbox.ps1` (чернила PNG).
- Скрины: `tests/betterwright/shape/leafaspect18-overview.png` (синтетика, data 1.8);
  пользовательские: `Screenshot 2026-11-13 225745.png` и `225943.png` (старый код, круг), `230941.png` (новый код? круг + DevTools), `231219.png` (новый код, маркер aspect=1.50, ink 1.26) — все в `C:\Users\vlads\Pictures\Screenshots\`.

## 7. Куски кода (дословно, на конец сессии 2026-11-13)

Ниже — точный код, а не пересказ. Человек без него ничего не поймёт: вся дьявольщина в константах (`0.55`, `0.68`, `0.03`, `1.9`, `1.8`) и в порядке операций.

### 7.1. Dijkstra + куча + tau (`src/core/leaf.ts`)

```ts
type HeapItem = [number, number] // [dist, node]
function heapLess(a: HeapItem, b: HeapItem): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
}
function heapPush(h: HeapItem[], item: HeapItem): void {
  h.push(item)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!heapLess(h[i]!, h[p]!)) break
    const t = h[p]!
    h[p] = h[i]!
    h[i] = t
    i = p
  }
}
// heapPop: стандартный sift-down, tie-break живёт в heapLess (по id).
export function dijkstra(adj: Adjacency, src: number, splitDist = Infinity): DijkstraTree {
  const dist = new Map([[src, 0]])
  const branch1 = new Map([[src, src]])
  const branch2 = new Map([[src, src]])
  const pq: HeapItem[] = [[0, src]]
  let item = heapPop(pq)
  while (item !== undefined) {
    const d = item[0]
    const u = item[1]
    if (d > (dist.get(u) ?? Infinity)) { item = heapPop(pq); continue }
    for (const nb of adj.get(u) ?? []) {
      const nd = d + 1 / Math.max(1e-6, nb.w) // cost = 1/w: сильная связь = короткий шаг
      if (nd < (dist.get(nb.id) ?? Infinity)) {
        dist.set(nb.id, nd)
        const b1 = u === src ? nb.id : (branch1.get(u) ?? nb.id)
        branch1.set(nb.id, b1)
        const b2 = d < splitDist && nd >= splitDist ? nb.id : (branch2.get(u) ?? b1)
        branch2.set(nb.id, b2)
        heapPush(pq, [nd, nb.id])
      }
    }
    item = heapPop(pq)
  }
  return { dist, branch1, branch2 }
}

export function computeTau(trees: DijkstraTree[]): number {
  const all: number[] = []
  for (const t of trees) for (const v of t.dist.values()) {
    if (Number.isFinite(v) && v > 0) all.push(v) // изоляты (Inf) отброшены до сортировки
  }
  if (all.length === 0) return 1
  all.sort((a, b) => a - b)
  return (all[Math.floor(all.length * 0.55)] ?? 1) * 0.75 // perc(0.55)*0.75
}
```

### 7.2. softInit целиком (`src/core/leaf.ts`)

```ts
export function softInit(
  nodes: LeafNode[], landmarks: number[], landmarkPos: Map<number, Pt>,
  trees: DijkstraTree[], tau: number, seed: number, smallest?: number,
): SoftInit {
  const positions = new Map<number, Pt>()
  const phi = new Map<number, number[]>()
  const dominance = new Map<number, number>()
  let cx = 0, cy = 0
  for (const p of landmarkPos.values()) { cx += p.x; cy += p.y }
  cx /= Math.max(1, landmarks.length); cy /= Math.max(1, landmarks.length)
  const span = 1300
  for (const n of nodes) {
    const raw = trees.map((t) => Math.exp(-((t.dist.get(n.id) ?? 1e6) / tau)))
    const s = raw.reduce((a, b) => a + b, 0) || 1
    const norm = raw.map((v) => v / s)
    phi.set(n.id, norm)
    let owner = 0
    for (let k = 1; k < norm.length; k++) if (norm[k] > norm[owner]) owner = k
    const dom = norm[owner] ?? 0
    dominance.set(n.id, dom)
    let x = 0, y = 0
    landmarks.forEach((L, k) => { const p = landmarkPos.get(L)!; x += norm[k] * p.x; y += norm[k] * p.y })
    const dMin = trees[owner]?.dist.get(n.id) ?? Infinity
    if (Number.isFinite(dMin) && dom > 0.55) {
      const lp = landmarkPos.get(landmarks[owner])!
      const base = Math.atan2(lp.y - cy, lp.x - cx)
      const b1 = trees[owner].branch1.get(n.id) ?? n.id
      const b2 = trees[owner].branch2.get(n.id) ?? b1
      const fan = base + (hashAt(b1, 31, seed) - 0.5) * 1.85 // сектор ±105°
      const reach = Math.min(1.6, dMin / tau) * span * 0.085 * ((dom - 0.55) / 0.45)
      x += Math.cos(fan) * reach; y += Math.sin(fan) * reach
      if (dMin > tau * 0.55 && b2 !== landmarks[owner]) { // полуоторванный лоскут целиком
        const lobeAngle = fan + (hashAt(b2, 43, seed) - 0.5) * 1.1
        const kick = 0.032 * span * Math.min(1, (dMin - tau * 0.55) / tau) // flat min (B)
        x += Math.cos(lobeAngle) * kick; y += Math.sin(lobeAngle) * kick
      }
    } else if (!Number.isFinite(dMin) || s <= 1e-12) {
      const small = smallest ?? landmarks.slice().sort((a, b) => a - b)[0] ?? landmarks[0]
      const lp = landmarkPos.get(small)!
      const a = hashAt(n.id, 53, seed) * Math.PI * 2
      x = lp.x + Math.cos(a) * 35; y = lp.y + Math.sin(a) * 35 // карман 35px
    }
    x += (hashAt(n.id, 17, seed) - 0.5) * 12
    y += (hashAt(n.id, 19, seed) - 0.5) * 12
    positions.set(n.id, { x, y })
  }
  // Рескейл на 0.9*span x LEAF_ASPECT: барицентр пакует всё в центр, stress
  // диффузно не расширяет за 80 итераций (S4 стоял worst=-10.17 без этого).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX, h = maxY - minY
  if (w > 1e-9 && h > 1e-9) {
    const sx = (span * 0.9) / w, sy = (span * 0.9) / LEAF_ASPECT / h
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    for (const p of positions.values()) { p.x = cx + (p.x - cx) * sx; p.y = cy + (p.y - cy) * sy }
  }
  return { positions, phi, dominance, tau }
}
const LEAF_ASPECT = 1.9 // init с запасом: stress+коллизии скругляют вниз
```

### 7.3. targetLen + springs + stress (`src/core/leaf.ts`)

```ts
export function targetLen(aSize, bSize, w, wmax, sim): number {
  const min = (reservePx(aSize) + reservePx(bSize)) * 1.0 + 4 // MODIFIED: было 0.85 (A)
  const max = min * 4.5
  const t = Math.pow(1 - w / Math.max(1e-9, wmax), 0.55) // сильный -> 0, слабый -> 1
  const stretch = sim < 0.65 ? 1 + (0.65 - sim) * 0.55 : 1 // мост до 1.35x (B1)
  return (min + (max - min) * t) * stretch
}

export function buildSprings(adj, phi, len, minLen): Spring[] {
  const out = []
  for (const [u, nbs] of adj) {
    const top = [...nbs].sort((a, b) => b.w - a.w || a.id - b.id).slice(0, 6) // cap хаба
    const cands = []
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const x = top[i].id, y = top[j].id
      if (x === u || y === u) continue
      const sim = phiCos(x, y, phi)
      if (!(sim > 0.7)) continue // B2: не зашивать борозды
      cands.push({ w: y, rest: Math.min(len(x, u) + len(u, y), minLen(x, y) * 3.2), sim })
    }
    cands.sort((a, b) => b.sim - a.sim)
    for (const c of cands.slice(0, 3)) out.push({ a: u, b: c.w, rest: c.rest, k: 0.12 })
  }
  return out
}

export function stressLeaf(nodes, edges, init, phi, { iters = 80, seed } = {}) {
  const pos = new Map([...init].map(([id, p]) => [id, { ...p }]))
  const anchors = new Map([...init].map(([id, p]) => [id, { ...p }]))
  // ... sizeOf, wOf/wmax, wBetween, len (через targetLen+phiCos), minLen (floor 1.0) ...
  for (let iter = 0; iter < iters; iter++) {
    const anchorK = 0.03 * Math.pow(0.97, iter) // A2 (0.01) откачен: якорь хранит сигнал init
    for (const e of edges) { // backbone-пружины
      const A = pos.get(e.a), B = pos.get(e.b); if (!A || !B) continue
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1
      const k = 0.04 * (0.35 + 0.65 * Math.sqrt(e.weight / wmax))
      const f = ((d - len(e.a, e.b)) / d) * k
      A.x += dx * f; A.y += dy * f; B.x -= dx * f; B.y -= dy * f
    }
    for (const s of springs) { /* то же, k *= 0.12 */ }
    for (const [id, p] of pos) { const a = anchors.get(id); if (a) { p.x += (a.x - p.x) * anchorK; p.y += (a.y - p.y) * anchorK } }
    if (iter % 20 === 19) { /* recenterOnly без скейла */ }
  }
  return pos
}
```

### 7.4. pickLandmarks + landmarkPositions + leafLayout (`src/core/leaf.ts`)

```ts
export function pickLandmarks(adj, nodes, k) {
  // seed = max degree (tie: min id); дальше farthest-point (max min-dist, tie min id).
  // Чистый top-k давал k соседних хабов на кольце — зоны не покрывали граф (S4 -10).
  const byDeg = [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.id - b.id)
  const landmarks = [byDeg[0].id]
  const trees = [dijkstra(adj, landmarks[0])]
  const minD = new Map(nodes.map((n) => [n.id, trees[0].dist.get(n.id) ?? Infinity]))
  while (landmarks.length < k) { /* argmax minD (tie min id) -> push + dijkstra + обновить minD */ }
  return { landmarks, trees } // деревья переиспользуются: k прогонов, а не 2k
}

export function landmarkPositions(ids, affinity, span, seed) {
  // init: угол i*GOLDEN + hash, радиус span*(0.14+0.10*hash), x*1.15 / y*0.85
  for (let iter = 0; iter < 80; iter++) for (const [A, B] of pairs(ids)) {
    const aff = affinity.get(pairKey) ?? 0
    if (aff > 0.04) { want = span*(0.16+0.30*(1-aff)); k = 0.015+0.025*aff }
    else if (d < span*0.36) { /* только близкое отталкивание, k=0.02 */ }
    // Floor: центры зон не совпадают (аффинити схлопывала: minPort 115px на кольце)
    if (d < span*0.22) { const f = (d - span*0.22) * 0.03; /* раздвинуть */ }
  }
}

export function leafLayout(nodes, edges, seed, iters = 80) {
  // pickLandmarks -> owner=argmin dist -> affinity=cross-zone weight/max ->
  // landmarkPositions -> tau -> trees(splitDist=tau*0.55) -> softInit ->
  // stressLeaf -> resolveLeafCollisions(anchors=stress output, sulcusPad=10)
}
```

### 7.5. resolveLeafCollisions (`src/core/leaf.ts`, spike-версия; в `graph.ts` тот же алгоритм + плоские массивы)

```ts
export function resolveLeafCollisions(positions, anchors, groupOf, dominance, sizeOf, sulcusPad = 10, maxPasses = 28) {
  // minDist = ra + rb; если группы разные И dom(a)>0.68 И dom(b)>0.68: minDist += sulcusPad (B3)
  // мосты (dom 0.45..0.60) — без pad, остаются сшиты
  // раздвинуть overlap*0.5; якорь: size>20 -> 0.12, >12 -> 0.06, иначе 0.02
  // ранний выход maxShift < 0.2
}
```

### 7.6. Production-цепочка в `spread()` (`src/core/spread.ts`, ~строки 355-470)

```ts
// Hub = max intra-degree (tie: min id) — Dijkstra-источник зоны.
const hubOf = new Map()
for (const g of groups) {
  const inG = new Set(g.members)
  /* deg = Σ intra-w; tie -> min id */
}
// Аффинити: вес кросс-рёбер пар групп / max.
const landmarks = groups.map((g) => hubOf.get(g.id)!)
const landmarkPos = landmarkPositions(groups.map((g) => g.id), affinity, span, seed)
const raw = landmarks.map((h) => dijkstra(adj, h))
const tau = computeTau(raw)
const trees = landmarks.map((h) => dijkstra(adj, h, tau * 0.55))
const smallestGroup = [...groups].sort((a, b) => a.mass - b.mass || a.id - b.id)[0]!
const init = softInit(nodes, landmarks,
  new Map(groups.map((g, i) => [landmarks[i]!, landmarkPos.get(g.id)!])),
  trees, tau, seed, hubOf.get(smallestGroup.id))
const order = groups.map((g) => g.id)
for (const n of nodes) {
  groupOf.set(n.id, order[argmax(init.phi.get(n.id))]) // = argmax phi
  dominance.set(n.id, init.dominance.get(n.id) ?? 0)
}
for (const g of groups) { const p = landmarkPos.get(g.id)!; ports.set(g.id, { x: p.x, y: p.y, mass: g.mass, members: g.members.length }) }
const stressed = stressLeaf(nodes, edges, init.positions, init.phi, { iters: 80, seed })
for (const [id, p] of stressed) positions.set(id, p)
for (const id of isolated) groupOf.set(id, smallestGroup.id) // изоляты → smallest mass
// corridors: без изменений (ga:gb -> count). Рамка: только центрирование +
// SPREAD_ASPECT = 1.8 (stretch-only: kx = 1.8/ratio если ratio < 1.8, иначе ky = ratio/1.8).
return { positions, ports, groupOf, corridors, dominance }
```

### 7.7. Двухфазный солвер + holdAspect + seatNewNodes (`src/core/graph.ts`)

```ts
export type SolverOpts = { anchors?: Map<number, Pt>; groupOf?: Map<number, number>; dominance?: Map<number, number>; sulcusPad?: number }
// layout():
const zoneOpts = { groupOf: figure.groupOf, dominance: figure.dominance, sulcusPad: 10 * pxToWorld }
resolveCollisions(points, 0, 8, scale, padScale, zoneOpts) // фаза 1: без якоря — расширение
const anchors = new Map(points.map((p) => [p.id, { x: p.x, y: p.y }]))
resolveCollisions(points, 0, SOLVER_PASSES - 8, scale, padScale, { anchors, ...zoneOpts }) // фаза 2: с якорем
// holdAspect(1.8): двухфазник расширяет вдоль людной оси и скругляет (600: 1.5 -> 1.2).
// Re-enforce stretch-only: растёт только отстающая ось => зазоры только растут (S4 цел).
// Порты едут тем же аффинным мапом при конверсии в world (figure.ports остаются в screen px до конверсии).
const aspectMap = holdAspect(1.8) // {cx, cy, kx, ky}; kx = 1.8/ratio если ratio < 1.8
// seatNewNodes(nodes, edges, positions, seed): fresh = взвесь соседей по w + джиттер ±4px
//   + 10 локальных итераций к rest = reservePx(own)+reservePx(nb) (settled pinned, S8 цел);
//   порог reuse 0.6 -> 0.65 (ответ 10: ниже — полный ре-спред, иначе паутина).
```

### 7.8. S1-gate и маркер воркера

```ts
// tests/spread.test.ts — S1 (REMOVED полоса 1.3..3.2; вместо неё связность + аспект):
it('S1 connectivity: ...', () => {
  for (const n of [271, 600]) {
    const res = layout(nodes.map(...), edges, { seed: 7, fullRun: true })
    expect(knnComponents(pts, 5)).toBe(1) // единый лист, не острова
    // аспект layout w/h в [1.6, 2.0] (hold держит ровно 1.8; было 0.79 — круг)
  }
})
// src/core/worker.ts, после layout():
console.log(`[chatmap-layout] leaf-P1 aspect hold 1.8: nodes=${...size} aspect=${aspect.toFixed(2)} fullRun=${fullRun}`)
// Читать в DevTools консоли после переоткрытия файла: доказывает, какой код выполняется.
```

### 7.9. Ключевые цифры для сверки (все измерены, не придуманы)

- S4 worst: trunk-наследие pass → -10.17 (пачка) → двухфазный солвер → green.
- S9 layout-1000: 601ms (наивный Dijkstra) → 475ms (куча) → <400ms (плоские массивы в хот-цикле).
- minSep 0.22·span: minPort 115px → >286px (кольцо-271).
- Рескейл init 0.9·span: spread bbox 217×249 → ~1170px экстент.
- Чернила попиксельно (tools/inkbox.ps1, порог lum>40, кроп по канве): реал 1.26 при дате 1.50; синтетика 1.54 при дате 1.5 и 1.54 при дате 1.8 (прокси шумный ±0.2 — лейблы и пыль).
- Харнес gaps.probe (graphToViewport, экранные px): 1.5 / 1.8 ровно — рендер честный, sigma uniform.
- Префлайт финал: typecheck 0, 252 passed / 1 skipped, build ok.
