# Аудит открытых вопросов ChatMap — пакет для внешней модели

Дата: 2026-11-14. Ветка: `feat/ponytail-audit-fix`.
Назначение: собрать ВСЕ незакрытые вопросы, сомнения и точки, где решение не принято,
с кусками кода и замерами, чтобы внешний аудитор (более мощная модель) дал вердикт.
Статус этого документа: черновик для аудита, не план работ.

## 0. Контекст проекта (что аудитору нужно знать)

ChatMap — локальное SPA: официальный JSON-экспорт Telegram → карта слов.
Узел = нормализованная лексема (размер = частота), ребро = совместная встречаемость
в сообщении / серии до 120 с / reply, цвет = доминирующий автор.
Приватность: данные чата не покидают браузер, тяжёлое — в Web Worker.
Стек: vanilla TS, Vite, Vitest 5, graphology, sigma.js v4, WebGL-шейдеры в `src/ui/neural.ts`.

Пайплайн: `src/core/worker.ts` → `parse.ts` → `tokenize.ts` → `filters.ts` →
`canon.ts` + `intern.ts` → `tally.ts` → `smart-merge.ts` → `select.ts` →
`spread.ts` (assignment-раскладка, P1 leaf-tissue) + `leaf.ts` (Dijkstra/softInit/stress) →
`graph.ts` (`layout()` → адаптер + `resolveCollisions` + `holdAspect`) →
`src/ui/mapview.ts` + `mapStyles.ts` (стили Sigma) + `neural.ts` (шейдеры).

Конвенции: тесты только на `src/core/` (vitest); UI проверяется стендом
`tools/shot-shape.mjs` (синтетический чат → метрики + скриншоты) и глазами на реальном экспорте.
Preflight: `npm run typecheck && npm run test && npm run build` — всегда зелёный.
Русский UI, телеграфно. Без градиентов/свечений/эмодзи/теней/маркетинга, без UI-фреймворков,
без словарных лемматизаторов.

Текущий preflight на момент написания:
- `git status --short`: `M src/core/geometry.ts, M src/ui/mapStyles.ts, M src/ui/neural.ts, M tests/geometry.test.ts`
  + untracked `specs/2026-11-14-fan-edges.md, specs/2026-11-14-node-size-law.md, specs/2026-11-14-zoom-labels-cross.md`.
- `git log --oneline -3`: `123b7aa feat(layout): flatten the frame target to 2.0`,
  `3737d39 fix(layout): keep the dust tail out of the frame`, `c9d6d07 feat(layout): lay the map out as a dendrite sheet`.
- Незакоммиченные правки 2026-11-14 — это три спека выше (фан-пропорции/рёбра на зуме,
  градация размеров, подписи/кегль/крестики). Их и надо аудитить в первую очередь.

---

## A. Релиз и процесс (блокеры, а не вкусовщина)

### Q1. Формат коммита: один или серия? Что делать с `tools/shot-shape.mjs`, `TASK_STATE.md`, `state.yaml`?

История вопроса: `specs/DEV_STATE_LATEST.md` §3.1 и `HANDOFF_2026-11-12.md` §6 требуют
«закоммитить серией по задачам (`fix(core): …`, `feat(ui): …`)», отдельно — правку гейта `(l)`.
По факту дерево снова грязное: 4 изменённых + 3 новых спека. Стенд `tools/shot-shape.mjs`
(26 КБ) то «не в репозитории — решать, коммитить или удалять», то уже лежит в `tools/`
(6 файлов: `debug-headless.mjs, e2e-headless.mjs, inkbox.ps1, inspect-export.js, shot-edges.mjs, shot-shape.mjs`)
и при этом `git ls-files --others` его не показывает как untracked — то есть он уже закоммичен,
а доки всё ещё пишут «не в репозитории». Противоречие не разрешено.

Дополнительно: `specs/state.yaml` (конвенция bigpowers) отсутствует; состояние ведётся в
`TASK_STATE.md` + `HANDOFF.md`. Аудит `specs/PLAN-AUDIT_LATEST.md` принял это как «локальный гейт»,
но `survey-context` каждый раз ругается. В корне замечен артефакт `NUL` (curl в Git Bash) — удалять?

```bash
# фактическое состояние на 2026-11-14
git status --short
#  M src/core/geometry.ts
#  M src/ui/mapStyles.ts
#  M src/ui/neural.ts
#  M tests/geometry.test.ts
# ?? specs/2026-11-14-fan-edges.md
# ?? specs/2026-11-14-node-size-law.md
# ?? specs/2026-11-14-zoom-labels-cross.md
git log --oneline -4
# 123b7aa feat(layout): flatten the frame target to 2.0 so the plane reads wider
# 3737d39 fix(layout): keep the dust tail out of the frame so the tissue reads elongated
# c9d6d07 feat(layout): lay the map out as a dendrite sheet instead of a round blob
# 082768b docs(handoff): sync graph physics and test counts
```

Вопрос аудитору:
1. Коммитить 4 изменённых файла одним коммитом или разбивать (геометрия/стили/шейдер/тест отдельно)?
2. `tools/shot-shape.mjs` — считать частью репозитория (оставить и документировать) или вынести?
3. Заводить ли `specs/state.yaml` или зафиксировать «живём в TASK_STATE/HANDOFF» и закрыть вопрос?

### Q2. UI-слой без юнит-тестов — чем закрывать регрессии?

Тесты (260 passed) покрывают только `src/core/`. Всё визуальное — зонды стенда
(`metrics, pin, enter, filter, sweep, census, flicker, lod, gaps, fan, grow, focus`)
+ ручной скрин. Примеры гейтов, которые живут только в стенде:
остаточное мерцание подписей 16/250 (`flicker`), глубина пина (`pin`), ярусы веера (`fan`),
кадрирование транзитных рёбер (`sweep`). Любая правка `mapStyles.ts`/`neural.ts` может
молча сломать их — preflight этого не ловит.

Вопрос аудитору: оставить «стенд + глаза» как осознанный компромисс (записать в CONVENTIONS),
или выделить минимальный автотест-уровень для стилей (например, снапшоты `edgeOpacity`/
`labelAlphaFor`/`fanCoreFrac` как чистых функций при фиксированном `CustomGraphState`)?
Что именно снапшотить, чтобы не тестировать Sigma?

### Q3. PNG-экспорт и фото-режим не перепроверены после фокусных правок

`DEV_STATE_LATEST.md` §3.5: `photoMode` использует `egoTier`/`plateAlphaFor`/`promote`.
После правок фокуса (весь веер подсвечен, фон 0.78 вместо 0.93, плашки гаснут с текстом)
кнопка PNG и «Фото» в панели ноды визуально не проверялись.

Вопрос аудитору: какой минимальный чек-лист приёмки фото-режима (какие ratio/пин/фон),
и должен ли `photoMode` иметь отдельный гейт, или достаточно ручной проверки?

---

## B. Раскладка: геометрия фигуры (самый спорный блок)

### Q4. Три числа аспекта на одну фигуру: `SPREAD_ASPECT` vs `FIGURE_ASPECT` vs `holdAspect(2.0)` vs гейт S1

Сейчас ширина фигуры задаётся в трёх местах, и они не совпадают:

```ts
// src/core/spread.ts
export const FIGURE_ASPECT = 1.9; // «band on a widescreen plate (gate S1 allows 1.55..3.2)»

// src/core/graph.ts — layout()
const holdAspect = (target: number): { cx: number; cy: number; kx: number; ky: number } => {
  // ...
  if (w > 1e-9 && h > 1e-9) {
    const ratio = w / h;
    if (ratio < target) kx = target / ratio;
    else ky = ratio / target;
    for (const p of points) {
      p.x = cx + (p.x - cx) * kx;
      p.y = cy + (p.y - cy) * ky;
    }
  }
  return { cx, cy, kx, ky };
};
// Target 2.0 (was 1.8): the user asked for a clearly flattened plane. This number
// must match SPREAD_ASPECT in spread.ts and stay under the S1 upper bound.
const aspectMap = holdAspect(2.0);
```

Комментарий сам признаёт: «must match SPREAD_ASPECT», но 2.0 ≠ 1.9.
История саги «круг» (`specs/2026-11-13-session-handoff.md` §4): layout-аспект на синтетике 0.79
(портрет!), `LEAF_ASPECT=1.9` в рескейле → 1.36/1.13, `SPREAD_ASPECT=1.5` → 1.49/1.20,
hold 1.5 → ровно 1.50/1.50. То есть финальное число ставит только `holdAspect` stretch-only
растяжением бокса, а не сама раскладка.

Замер-аргумент против бокса: на реальном экспорте bbox-аспект 1.80 при массе q05..q95 всего 1.52 —
один оторванный хаб («меня» сверху) раздувает `maxY-minY`, и «вытянутость» формально есть,
а ткань остаётся круглой. Предложение из диагностики: нормировать по `P10..P90` + мягкое
поджатие выбросов (tanh) + PCA-поворот главной оси в горизонталь перед рамкой. Не внедрено.

Вопросы аудитору:
1. Оставить один источник истины (какой?) и удалить остальные два, или зафиксировать связку
   «spread строит 1.9, hold дотягивает до 2.0 только растяжением» как намеренную?
2. `holdAspect` по bbox или по квантилям массы? Готов ли аудитор принять tanh-прижатие хвостов
   как «не ломает S4» (stretch-only растит зазоры, но квантильный бокс — уже не stretch бокса)?
3. Нужен ли PCA-поворот (`alignPrincipalAxis` уже написан в `leaf.ts`, но вызывается ли он
   в `spread()`/`layout()` — проверить)? Диагональная ось ~125° + горизонтальный hold тянет
   поперёк волокон — это реальный дефект или артефакт одного скрина?

### Q5. `resolveCollisions`: изотропный взрыв vs весозависимый клиренс + анизотропный сдвиг

Диагностика утверждает: 8 бесякорных проходов работают как «взрыв мыльного пузыря»,
равномерно упаковывают кучу в кристалл, засыпают каньоны и обрушивают Спирмена `-0.76 → -0.25`.
Предложено: ранговая прогрессия радиуса в `softInit`, весозависимый клиренс
(внутри стебля `0.78*(ra+rb)`, но не ближе `max(ra,rb)`), `cleftPad=9px` между стеблями,
тангенциальный слайд (1.45 вдоль ветки / 0.55 поперёк).

Факт кода сейчас (`src/core/graph.ts`):

```ts
export function resolveCollisions(
  nodes: Array<{ id: number; x: number; y: number; size?: number }>,
  padding = 8, maxIterations = 80, scaleFactor = 1,
  padScale: ((size: number, index: number) => number) | null = null,
  opts: SolverOpts = {},
): void {
  // ...
  for (let iter = 0; iter < maxIterations; iter++) {
    // O(N^2) scan; uniform-grid broadphase slower on production clearances
    // ponytail: quadratic in node count, fine up to ~1000 nodes (topN cap).
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let minDist = ra + radii[j];
        if (hasCleft) {
          if (si >= 0 && sj >= 0 && (si >> 4) === (sj >> 4) && (sa === sb || sa === 0 || sb === 0)) {
            minDist = Math.max((ra + radii[j]) * SAME_STEM_PACK, Math.max(ra, radii[j]));
          } else if (si >= 0 && sj >= 0) minDist += cleftPad;
        }
        if (hasZones) {
          if (ga >= 0 && ga !== gids[j] && doms[i] > 0.68 && doms[j] > 0.68) minDist += sulcus;
        }
        // ... изотропный отпор вдоль nx,ny, без проекции на ось ветки
        a.x -= nx * shift; a.y -= ny * shift;
        b.x += nx * shift; b.y += ny * shift;
      }
    }
    if (opts.anchors !== undefined) { /* hubs stand still, dust walks */ }
    if (!hasCollision || maxShift < 0.2) break;
  }
}
```

То есть `SAME_STEM_PACK` (0.88), `cleftPad = 8*pxToWorld`, `sulcusPad = 10*pxToWorld`,
двухфазность (8 без якоря → `containTail` → 8 без якоря → якорь на `SOLVER_PASSES-16`)
— внедрены. Анизотропного сдвига (проекции на ось ветки) НЕТ — отпор строго по нормали пары.
Вес ребра в `minDist` НЕ входит: сильное ребро и слабое разводятся одинаково.

```ts
// src/core/graph.ts — layout(), вызовы солвера
const zoneOpts = {
  groupOf: figure.groupOf, dominance: figure.dominance, stemOf: figure.stemOf,
  cleftPad: 8 * pxToWorld, sulcusPad: 10 * pxToWorld,
};
resolveCollisions(points, 0, 8, ..., padScale, zoneOpts);
containTail(points);
resolveCollisions(points, 0, 8, ..., padScale, zoneOpts);
const anchors = new Map(points.map((p) => [p.id, { x: p.x, y: p.y }] as const));
resolveCollisions(points, 0, SOLVER_PASSES - 16, ..., padScale, { anchors, ...zoneOpts });
```

Вопросы аудитору:
1. Признать ли изотропный солвер с `cleftPad`/`sulcusPad` достаточным (каньюоны держатся
   назначением стеблей, а не физикой), или требовать весозависимый `minDist` и тангенциальный слайд?
2. Двухфазность (8+8+anchor) — не overfitting под синтетику-271? На каких картах она вредит
   (мелкие 30 слов, крупные 1500+)?
3. `cleftPad 8` vs предложенные `9`, `sulcusPad 10`, порог доминантности `0.68`, `SAME_STEM_PACK 0.88`
   — чем откалиброваны? Оставить как магические константы с замером или вывести из `reservePx`?

### Q6. Метрики чести: `rho`, `preservation@10`, `CV`, `kNN` — что из них вообще значит что-то?

Замеры саги «круг» (synth-271, seed 1337):

| Этап | rho (<-0.5) | kNN (1) | pres@10 (>0.6) | CV (0.42–0.72) | maxVoid (<0.15) | voidShare (0.04–0.16) |
|---|---|---|---|---|---|---|
| trunk baseline | -0.229 | 1 | 0.289 | 0.700 | 0.138 | 0.429 |
| leaf v1 | **-0.762** | 5 | 0.058 | 1.399 | 0.270 | 0.622 |
| leaf v2 | **-0.760** | 2 | 0.017 | 1.174 | 0.230 | 0.417 |
| leaf + B3 (sulcus+якорь) | -0.251 | **1** | 0.076 | 0.986 | **0.130** | 0.257 |
| production spread() P1 | -0.73 | 6 | 0.06 | 2.27 | 0.29 | 0.71 |
| P1 layout (финал) | — | **1** | — | — | — | — |

Интерпретация из сессии: B3 чинит связность (kNN 2→1) и пустоты, но убивает rho (-0.76→-0.25),
потому что uniform-клиренс равняет сильные рёбра. `pres@10 ≈ 0.05` везде: у звезды 100 лучей
10 ближайших в графе — листья того же хаба на 2 хопа, а `hashAt(b1)` разбрасывает их по сектору
±105°, солвер перемешивает по размеру. `CV > 1.2` — бимодальность «центр в 0 + хаб улетел на 400px»,
а не текстура. `kNN==1` на финале — тривиально после солвера (он только разнимает наложения)?

Гейты сейчас (`tests/spread.test.ts`): S1 полоса REMOVED → `kNN(5)==1` на финальном layout + аспект
[1.6, 2.0]; S2–S9 живы. То есть самый строгий топологический гейт заменён на самый слабый.

Вопросы аудитору:
1. Удалить ли `rho`/`pres@10`/`CV` как гейты (оставить пробниками без порогов), или переопределить
   их (ранговый `rho` внутри стебля? `pres@10` внутри `stemOf`? `CV` без выбросов)?
2. `kNN(5)==1` на финале — доказательство связности или тавтология солвера? Чем заменить
   (число компонент связности по backbone? доля мостов? ink-bbox?).
3. Порог `voidShare 0.04–0.16` и `maxVoid < 0.15*span` — откуда? На 1000 нод на полотне 1400×900
   «воздух и плотные кластеры несовместимы» (41px средний шаг) — не противоречит ли гейт физике?

### Q7. `softInit`/`stressLeaf`/`landmarkPositions`: температура, якоря, пружины — магия или калибровка?

Ключевые места `src/core/leaf.ts`:

```ts
// Global temperature: 55th percentile of finite positive distances, scaled 0.75.
export function computeTau(trees: DijkstraTree[]): number {
  const all: number[] = [];
  for (const t of trees) for (const v of t.dist.values()) {
    if (Number.isFinite(v) && v > 0) all.push(v);
  }
  if (all.length === 0) return 1;
  all.sort((a, b) => a - b);
  return (all[Math.floor(all.length * 0.55)] ?? 1) * 0.75;
}
```

```ts
const STEM_MARGIN = 0.4; // (d2-d1)/d2 — масштабно-свободный гейт принадлежности стеблю
const SLOT_OFFSETS = [-1.45, -0.72, 0, 0.72, 1.45]; // фиксированные углы стеблей
const STEMS = 5;
```

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

```ts
export function pickLandmarks(adj, nodes, k): { landmarks; trees } {
  // seed = max degree (tie: min id), дальше farthest-point (max min-dist, tie min id).
  // Причина: чистый top-k даёт k соседних хабов на равномерных графах (кольцо) — S4 падал с worst=-10.17.
}
```

Неразрешённое: `tau = p55*0.75` — почему 0.55/0.75? `STEM_MARGIN 0.4` vs старый `dom > 0.55`
(который «мёртв в проде: 8 стеблей на 600 нод»)? `SLOT_OFFSETS ±1.45` — откуда ширина веера?
`anchorK 0.03` vs проба `0.01` (откачена: «якорь хранит сигнал init»)? 80 итераций vs 140
(плато 3→4→5 фаз: 0.97/0.96/0.97)? `MAX_GROUP_SHARE 0.3`, `MIN_GROUP 3`, `GROUP_SWEEPS 8`,
`GATEWAY_CELLS 14` (было 12), `INTRA 0.75/0.25` (было 1/0.35), `cachedShare >= 0.65` (было 0.6)?
`containTail` (`TAIL_CUTOFF_Q 0.965 / TAIL_LIMIT 1.05`, `WARP_FIT_SLACK 1.2`) — монотонное сжатие
радиуса с асимптотой, «never reordered» — доказано ли, что порядок не меняется?

Вопрос аудитору: какие из этих констант — калибровка под замер (принять и задокументировать),
а какие — overfitting под synth-271 (требовать чувствительность/абляцию)? Что мерить на реальном
экспорте, чтобы решить?

### Q8. Мега-хаб: 85% слов на одном слове — синтетика его не ловит

Факт из handoff: реальный чат даёт мега-хаб (85% слов на одном слове), синтетика — равномерные хабы.
Митигации в коде: `MAX_GROUP_SHARE = 0.3` (жёсткий кап массы группы), `LOBE_CAP_SHARE = 1.6`
(доля не больше 1.6× среднего, иначе один хаб собирает 85% в один диск), sub-доли, подпряди,
кап массы ядра. Замер: мега-хаб фикстура `clarkEvans 1.13 → 0.96`, `mega-clump 11 → 13`.

Открытый риск (дословно): «серая веерная каша на реальном мега-хабе (стенд её не ловит —
у него равномерные хабы). Верификация = скрин реальной карты пользователя».

Вопрос аудитору: достаточно ли капа 0.3/1.6 + подпрядей, или нужен отдельный режим
«звезда» (хаб в центре, листья по дендритам, а не группа)? Какой стенд сгенерировать,
чтобы воспроизвести мега-хаб без реального экспорта (степенное распределение весов с одним
выбросом)? Можно ли принять работу без скрина реального чата?

---

## C. Рёбра и шейдеры: как линии должны выглядеть

### Q9. `bundleEdges`/`trunkControls`: две точки vs иерархический сплайн с поздним расклеиванием

Диагностика требует 5-точечный маршрут `Soma → StemNeck → TwigFork → PreTerminalNeck → Node`
со стяжкой `β1=0.96 → β2=0.90 → β3=0.82` (слипание 85–86% длины, расклейка только в конце).
Сейчас в `src/core/geometry.ts`:

```ts
const SPINE_NEAR = 0.3;   // общая точка слияния на 30% руки
const SPINE_TRUNK = 0.86; // развилка на 86% проекции — расклейка у кончика
const SPINE_MIN_R = 2;
const SPINE_PROJ_CAP = 1.15;
const SPINE_WEIGHT = 0.2; // вес дальнего тяжёлого в направлении руки
const CORRIDOR_FAN = 2;   // поперечный разброс коридора, world units (было 6 — «видимые параллельные волоски»)
const INTRA_NEAR_PULL = 0.75;
const INTRA_FAR_PULL = 0.25;
export const GATEWAY_CELLS = 14;

function trunkControls(a, b, stemA, stemB, spines): { c1, c2 } | null {
  if (stemA === undefined || stemB === undefined || stemA < 0 || stemB < 0) return null;
  const owner = Math.floor(stemA / 16);
  // §2.1: same owner and either the same slot or one end is the soma (slot 0).
  if (owner !== Math.floor(stemB / 16) || (slotA !== slotB && slotA !== 0 && slotB !== 0)) return null;
  // ... neck на 30% руки, split на 86% проекции к терминалу
}
```

То есть общий ствол есть, но только 2 контрольные точки (neck + split), а не 3 внутренние.
`CORRIDOR_FAN = 2` (sub-pixel на обзоре, расходится только на зуме) vs старое 6.
`gatewayOf` снапает порты к сетке `GATEWAY_CELLS=14` — «порты соседних ядер делят ОДИН ствол».

Симптом-основание: «два прямых фиолетовых конуса-прожектора» от «меня» и «просто» —
кубика с одной промежуточной точкой математически достаточно, чтобы пучок из 200 линий
расширился к середине до полдиаметра облака. Вопрос: лечат ли 2 точки (neck/split) прожекторы,
или нужны 3 внутренние точки с β-стяжкой? Замер `tests/betterwright/shape/*-*.png` глазами —
воспроизводимого числового гейта на «прожекторность» нет.

Вопросы аудитору:
1. Хватает ли neck/split (0.30/0.86) + `CORRIDOR_FAN 2` + `gatewayOf(14)`, или требовать
   3 внутренние точки и явные β?
2. `SPINE_WEIGHT 0.2`, `SPINE_PROJ_CAP 1.15`, `SPINE_MIN_R 2` — калибровка или магия?
3. Какой числовой гейт ввести на «слипание» (доля длины, где ширина пучка < X), чтобы не глазами?

### Q10. Zoom-in релиз рёбер 2026-11-14: `localK`, `closeFloor 0.22`, `WEAK_EDGE_CAP 0.38` — не ярко ли?

До правки (`specs/2026-11-14-fan-edges.md`): на ratio 0.6 медиана рёбер 0.027 — «поле без линий».
После: 0.027 → **0.18**, кадр `zoom-0_4` — «волокна мелких нод читаются». Код сейчас:

```ts
// src/core/geometry.ts
const WEAK_EDGE_CAP = 0.38; // было 0.16 — «слабые волокна должны читаться как волокна»
export function weakEdgeCeiling(weakEndpointCore: number): number {
  return 1 - (1 - WEAK_EDGE_CAP) * smallness(weakEndpointCore);
}
```

```ts
// src/ui/mapStyles.ts — edgeOpacity()
const ceiling = weakEdgeCeiling(core);
const closeK = 1 - smoothstep(0.45, 1.0, r);
const localK = closeK * (1 - smoothstep(1.2, 2.8, reach));
const liftedCeiling = ceiling + (1 - ceiling) * localK;
const suppressGate = (0.25 + 0.75 * smoothstep(0.30, 0.85, r)) * smoothstep(0.22, 0.60, r);
const closeFloor = 0.22 * localK;
const base = Math.max(
  edgeFrequencyTier(attrs, g) * ends * spine * skeleton * isolated * quiet,
  closeFloor * ends,
);
// ...
const reachFade = lengthFade(reach, (attrs.strength as number) ?? 0);
const closeReachFade = reachFade + (1 - reachFade) * localK;
return Math.min(clamp01((g.enterAlpha ?? 1) * closeReachFade * Math.max(base, trace * ends) + loneWire), liftedCeiling);
```

Всё скоупировано на `r < 1` (`closeK = 0` при `r >= 1` — обзор битово тот же, пины в тестах держат).
Рычаги отката записаны в спеке: «пол 0.22 ярок — крутить `closeFloor`, не рампу».

Сомнения:
1. Пол `0.22 * localK * ends` на плотной карте 1000 нод — сотни линий по 0.22 на зуме 0.4 —
   это «ткань» или «мешанина»? Замер только на синтетике 400/2000/271; на реальном чате 1500+ слов
   с хабом степени 300+ не профилировано и не скриншотилось.
2. `localK` режет транскадровые диагонали (`reach 1.2–2.8`) — а если пользователь на зуме хочет
   именно длинную связь через кадр (цитата чата через 50 сообщений)? Это фича или потеря?
3. `WEAK_EDGE_CAP 0.16 → 0.38` — потолок слабой связи поднят в 2.4 раза глобально, а не только
   на зуме. На обзоре слабые теперь ярче — иерархия «хаб-коридор vs пыль» не размыта ли?
4. Стоимость: `edgeOpacity` считается на каждое ребро на каждый кадр; `localK`/`closeFloor` —
   ещё 3 smoothstep на ребро. На 3000+ рёбер это заметно?

Вопрос аудитору: принять ли связку (0.38 / 0.22 / 1.2–2.8 / 0.45–1.0 / 0.22–0.60) как калибровку,
или требовать: а) снизить пол до ~0.12–0.15, б) поднять `WEAK_EDGE_CAP` только на зуме
(через `localK`), в) ввести гейт «число видимых рёбер на ratio 0.4 < N»?

---

## D. Узлы, LOD, подписи (незакоммиченные правки 2026-11-14)

### Q11. Закон размеров: `SIZE_GAMMA 0.62`, `SIZE_MAX 68`, `footprintScale` — решётка вернётся?

Было (`src/core/geometry.ts`): `2.8 + 73.2·q^0.85`, где `q = count/maxCount`. При max=3000
слово 1/10/100 получало 2.9/3.4/6.9px (неразличимо), хаб — 76px (башня).
Стало:

```ts
const SIZE_MIN = 2.8;
const SIZE_MAX = 68;    // было 76 — «топ сливается в тир»
const SIZE_GAMMA = 0.62; // было 0.85 — «низ расходится 3.3–10.7px вместо 2.9–6.9»
export const MAP_FOOTPRINT_PX2 = 170_000;
const FOOTPRINT_MIN_SCALE = 0.28;

export function nodeFitSize(word: string, count: number, boundA: number, boundB = 0): number {
  // ...
  const q = Math.max(0, Math.min(1, count / maxCount));
  return Math.round((SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.pow(q, SIZE_GAMMA)) * 10) / 10;
}

export function footprintScale(sizes: number[], budget = MAP_FOOTPRINT_PX2): number {
  const footprint = Math.PI * sizes.reduce((acc, r) => acc + Math.max(0, r) ** 2, 0);
  if (footprint <= 0 || footprint <= budget) return 1;
  return Math.max(FOOTPRINT_MIN_SCALE, Math.sqrt(budget / footprint));
}
```

A/B стенд (seed фиксирован): overlap at1/at06/at15 0.12/0.04/0.20 → **0.14/0.08/0.28**,
minGap −10.4 → **−16.1** (отрицательный был уже в базе), p90 зазоров 12.4 → 18.8.
Тест-пин `hub ≈ 76 → 68` обновлён; ассёрты `rare < 8, hub/rare ≥ 10, mid > rare·2` живы.
Комментарий в коде честно предупреждает: «0.62 лежит внутри старого 0.42–0.7 диапазона,
который когда-то давал решётку; разница — бюджет площади `footprintScale`».

Сомнения:
1. Прирост overlap +40–100% относительных (0.04→0.08 на 0.6, 0.20→0.28 на 1.5) — цена
   градации или начало решётки? На реальных экспортах (не синтетика) не проверено.
2. `FOOTPRINT_MIN_SCALE = 0.28` — пыль становится субпиксельной точкой? LOD `GONE 1.6px`
   её добьёт — не теряем ли хвост?
3. Рычаг отката «жать гамму (→0.7), а не крышку» — согласен ли аудитор, или крышка 68
   тоже под вопросом (два хаба 68 vs один 76 — тир или каша)?

### Q12. Фан-пропорции: `fanCoreFrac` с множителем `·base` — хватит ли?

Было: рост фана шёл к фиксированному заполнению квада 0.96 для всех — мелочь вырастала
сильнее всех и становилась одинаковыми кольцами. Стало:

```ts
const FAN_CORE_MAX = 0.96;
export function fanCoreFrac(base: number, lodScale: number, grow: number): number {
  const scale = Math.max(0.05, Math.min(1, lodScale));
  const target = Math.min(FAN_CORE_MAX, base / scale);
  const k = Math.max(0, Math.min(1, grow));
  return base + (target - base) * k * base; // рост пропорционален собственной доле
}
```

Пины: 0.8 → 0.72 (хаб почти не рос и не растёт — правильно?), 0.96 → 0.7923.
Рычаг из спека: «если фан снова сравняется — жать множитель (`·base` → `·base²`), не потолок».

Вопрос аудитору: принять ли `·base` (линейно-пропорциональный рост) или сразу `·base²`
(квадратичный — мелочь почти не растёт)? Что считать гейтом «иерархия в фане сохранена»
(отношение max/min core в фане? дисперсия?)? Хаб с base 0.8, который «не рос и не растёт» —
это нормально (ему некуда) или баг (фан должен подсвечивать и хаб)?

### Q13. Подписи на зуме + кегль + крестики: пороги `0.30/0.70/0.35`, `LABEL_FONT_PX 20`, `somaStarRay`

Было: хабы (`size ≥ 22`) на приближении лишь мягчели на 30%, мелкие (`<12`) сразу имели альфу 1
(их держала планка `labelMinCore`, которая на зуме почти не двигалась: −7.5% к ratio 0.5).
Стало (`src/ui/mapStyles.ts`):

```ts
function labelMinCore(ratio: number, minCore: number): number {
  if (ratio >= 1) return Math.max(3.5, minCore * (0.85 + 0.15 * clamp01(ratio)));
  // Zoom-in: планка быстро тонет к полу 3.5 — мелкие всплывают одна за одной,
  // полная сила уже после ~одного тика колеса. Стык в 1.0 непрерывен.
  return Math.max(3.5, minCore * (0.45 + 0.55 * smoothstep(0.35, 1.0, ratio)));
}

function labelAlphaFor(attrs: any, ratio: number, minCore = DEFAULT_LABEL_CORE_MIN): number {
  const size = drawnCore(attrs);
  const bar = labelMinCore(ratio, minCore);
  const gate = smoothstep(bar - 1.2, bar + 1.2, size);
  const nearFade = smoothstep(0.30, 0.70, ratio);
  let alpha: number;
  if (size >= 22) {
    alpha = nearFade; // хабы: полное исчезновение к ratio ~0.3
  } else if (ratio > 3.4) {
    alpha = 0;
  } else if (size >= 12) {
    const far = ratio <= 1.6 ? 1 : clamp01((3.4 - ratio) / 1.8);
    alpha = far * (1 - clamp01((size - 12) / 10) * (1 - nearFade));
  } else {
    // ... мелкие через тонущую планку
  }
}
```

Плюс: `LABEL_FONT_PX = 18.5 → 20` (кривая `0.62+0.38·t`: 11.5→18.5 стало 12.4→20),
крест `somaStarRay`: рукава `smoothstep(0.80, 1.90)` (было 1.10–2.60), длина
`min(coreR·0.62, 15)` (было 0.85/22), сердцевина `r = 2.2` (было 3.0).
Дальнее поведение (zoom-out) не тронуто; пороги `labelIsLegible > 0.30`, гейт отрисовки `> 0.02`
не менялись. Проверка: зонд `census` — 27→83→126→79→44 подписей по ratio 1→0.25, flicker ≤ 3,
`plateMismatch 0`.

Сомнения:
1. Пороги `0.30/0.70` (хабы гаснут), `0.35/1.0` (планка тонет), полка `3.5px`, окно гейта `±1.2px`,
   `nearK = (size−12)/10` — откуда? Почему хабы должны ИСЧЕЗАТЬ на глубоком зуме, а не оставаться
   landmark-ами (альтернатива: держать 0.25–0.3 минимум)?
2. Кегль 20 vs 18.5 (+8%) — есть ли замер «читаемость vs коллизии»? `labelDensity = 5`
   (подписей на ячейку 120px) не стала ли тесной?
3. Крестики меньше — субъективно. Есть ли гейт «крест не перекрывает подпись/тело соседа»?
4. Остаточное мерцание 16/250 (`DEV_STATE` §3.2): «подпись освобождается от коллизии и через
   2–4 шага вытесняется плотностью». Предложено временное затухание при смене решения или
   монотонная по зуму раскладка. Какой путь выбрать? Текущий `STICKY_PADDING`/`STICKY_PRIORITY`
   + `labelIsLegible (alpha > 0.25)` + «видимая держит слот (зазор ×0.35, приоритет +20),
   гаснущие не занимают слот» — достаточно или нужен hysteresis по времени?

---

## E. Ядро: лингвистика и отбор (тихие долгожители)

### Q14. Стеммер `STEM_DOMINANCE = 25`, `Intern`, `PipelineCache`, `smart-merge` — где граница «честности»?

Исправленный кейс (`specs/bugs/2026-11-12-stem-overmerge.md`): `меня` (2085) склеивалось с
`менять/меняет/меняют` (15/7/4) — остаток стеммера `меня` (4 буквы) проходил охранника.
Правка:

```ts
// src/core/canon.ts — stemRu получает карту частот форм
// Если остаток — самостоятельная форма корпуса и встречается в STEM_DOMINANCE раз чаще
// самого слова, стемминг не выполняется (return word).
const STEM_DOMINANCE = 25; // 139x у ошибочного слияния vs <10x у настоящих парадигм
```

```ts
// src/core/intern.ts — Intern принимает частоты в конструкторе, передаёт в canon
// src/core/tally.ts — один проход считает поверхностные частоты plain-токенов
// ponytail: one linear pass over the cached units (~100k distinct forms); revisit ...
```

Сознательное ограничение: парадигма `менять/меняет/меняют` распадается на редкие ноды
(общей основы ≥4 букв нет, словаря нет — «это честнее ложного слияния», но карта беднеет).

Параллельно: `smart-merge` склеивает опечатки по триграммному Жаккару ≥ 0.5 для слов ≥6 букв.
План-аудит (`PLAN-AUDIT_LATEST.md`) добавил находки, которые так и не закрыты:
`PipelineCache` однослотовый (переключение фильтров пересчитывает tally/merge — кандидат B),
`Intern.nextId` не ограничен (`KEY_BASE = 2**24` не защищён от >16M ID),
`matchesMatCustom`/`isMatAllowlisted` линейны, ошибка `parse()` в `open` оставляет старые кеши и `chat`.

```ts
// src/core/tally.ts
// shortcut: fixed two slots, no byte accounting; raise slots only with a memory budget
```

Вопросы аудитору:
1. Порог 25 — калибровка на одном кейсе (`меня/менять`) или робастен? Что делать со следующей
   парой-омонином (какой тест/мониторинг ввести — словарь исключений, метрика «топ-N склеек»)?
2. Распад парадигмы `менять` на 3 ноды — принять как цену без-словарности, или ввести
   минимальный «парадигмный» merge (окончания глаголов) без полного словаря?
3. Жаккар 0.5 / длина ≥6 — не дублирует ли `smart-merge` работу стеммера (двойная склейка)?
   Какой порядок правильнее (merge до/после tally)?
4. Однослотовый `PipelineCache` + незащищённый `nextId` + stale-keeps после ошибки парса —
   чинить сейчас (какие гейты?) или логировать как принятый долг?

### Q15. `select.ts`/`filters.ts`: topN, minWeight, backbone — кто решает, что попадает на карту?

Контекст: backbone-фильтр (`pruneSortedBackbone`: до 2 сильнейших рёбер на узел + Serrano disparity
α=0.05, бюджет `max(300, 3.5·N)`), режимы «вместе/автор», `topN`, `minWeight`, N>2 участников
(«пересечения» скрыта). Пользовательские стоп-слова (`filters.ts`: стоп, мат, смех `ахах/lmao/кскс`
+ кастом). Всё это — граница «парсинг, а не валидация», но решения размазаны по
`worker.ts`/`select.ts`/`geometry.ts` (сортировки в 4 местах — отмечено аудитом).

Вопрос аудитору: где должна жить единственная точка решения «что показать»
(один модуль, один гейт)? Нужно ли вынести `topN/minWeight/backbone` в явный `SelectSpec`
с тестом-инвариантом, или текущее распределение приемлемо?

---

## F. Производительность и надёжность (что не замерено)

### Q16. Сложность `layout()`/`resolveCollisions`/`bundleEdges`: cc 86/50/64 — рефакторить или оставить?

Факты: `src/core/graph.ts` — контурный блок (осевое растяжение + угловой шум + выталкивание
лобов) кандидат на `sculptContour()`; `resolveCollisions` cc=86 (хот-цикл на плоских массивах —
намеренно, «S9 saver»), `bundleEdges` cc=50, `layout()` cc=64 (было 53). Покрыто тестами
`(g)/(h)/(j)` в `graph.test.ts`, но читаемость низкая. `seatNewNodes` cc=38.

```ts
// src/core/graph.ts
// Production clearances make a uniform-grid broadphase slower than this scan:
// its neighbourhood radius spans several cells. Keep the O(N^2) scan unless maps
// get an order of magnitude bigger.
// ponytail: quadratic in node count, fine up to ~1000 nodes (topN cap).
```

Вопрос аудитору: принять ли O(N²) + высокий cc как цену S9 (<400мс/1000 нод), или требовать
вынос `sculptContour()`/`seatNewNodes()`/трейсинга рёбер в отдельные модули с сохранением
побайтового детерминизма? Есть ли риск, что «плоские массивы ради S9» станут нечитаемыми
для следующего контрибьютора?

### Q17. S9 и реальный масштаб: 400мс/1000 нод — а дальше?

Гейт S9: <400мс на 1000 нод. Достигнуто бинарной кучей в Dijkstra (было 601мс) + плоскими
массивами. Но: реальный экспорт — 1500+ слов, хаб степени 300+ (эго-веер пишет `degree`
состояний рёбер + `degree` состояний узлов за ховер — 165+166 на синтетике-271, не профилировано).
Предложение из `DEV_STATE`: «ярус считать формулой в стиле, а не хранить в состоянии» —
не сделано. `footprintScale` сжимает всё равномерно — на 2000+ нод карта станет мелкой пылью?

Вопросы аудитору:
1. Поднять ли topN-кап / ввести виртуализацию (показывать топ-N, остальное — по зуму),
   или держать «всё сразу» и упираться в O(N²)?
2. Эго-веер на хабе 300+: хранить `egoTier` на ребре (память O(degree)) или формулу
   `opacity = 0.10+0.90·tier³, толщина +45·tier%` перенести в шейдер/стиль без состояния?
3. Нужен ли отдельный перф-прогон на «мега-чате» (сгенерировать синтетику 2000/5000 с
   степенным распределением) до релиза?

### Q18. Что считать «готово»: живого чата всё ещё нет

Все замеры — синтетика (топологический стенд `tests/bench-tmp-shape.test.ts` + браузерный
`tools/shot-shape.mjs`). Пользователь «проверяет на своём экспорте», но скрина/ solution-приёмки
в репозитории нет. `specs/2026-11-12-timeline-slider-backlog.md` (слайдер времени) отложен
как «делать ОТДЕЛЬНО после фигуры» — требует меток времени в parse (есть ли?), среза tally
по окну, стабильности кадров (`cachedShare`/tween). Не начат.

Вопрос аудитору: можно ли считать фигуру принятой без скрина реального экспорта?
Если нет — какой минимальный протокол приёмки (какие кадры ratio, какие зонды, какой инкбокс
`tools/inkbox.ps1` vs глазами)? Слайдер — отдельный эпик или часть этого релиза?

---

## G. Прямые вопросы аудитору (сводка решений)

1. Аспект: bbox-stretch 2.0 vs квантильный бокс + PCA — что выбрать единственным источником?
2. Солвер: оставить изотропный + cleft/sulcus, или требовать весозависимость + анизотропию?
3. Метрики: удалить `rho`/`pres@10`/`CV` как гейты или переопределить? Чем заменить `kNN==1`?
4. Константы leaf (`tau p55*0.75`, `STEM_MARGIN 0.4`, `anchorK 0.03`, `MAX_GROUP_SHARE 0.3`,
   `GATEWAY 14`, `INTRA 0.75/0.25`, `cachedShare 0.65`) — калибровка или overfit? Что абблировать?
5. Рёбра на зуме (`WEAK_CAP 0.38`, `closeFloor 0.22`, `localK 1.2–2.8`) — не ярко ли? Снижать пол?
6. Размеры (`GAMMA 0.62`, `MAX 68`, overlap +40–100%) — цена приемлема? Откатывать гамму первой?
7. Фан (`·base` vs `·base²`) и хаб 0.8 без роста — норма или баг?
8. Подписи (пороги 0.30/0.70/0.35, кегль 20, полк 3.5) + мерцание 16/250 — временной hysteresis или монотонность по зуму?
9. Стеммер (порог 25, распад `менять`) + `smart-merge` 0.5/≥6 + `PipelineCache`/stale-keeps — чинить сейчас?
10. Коммиты/стенд/`state.yaml`/`NUL` — какой формат закрытия релиза?
11. UI-тесты (снапшоты чистых функций стилей) — вводить или зафиксировать «стенд + глаза»?
12. Мега-хаб без реального скрина — можно ли принимать? Какой синтетический мега-хаб сгенерировать?

---

## H. Как воспроизвести (для аудитора)

```bash
npm run typecheck && npx vitest run && npm run build   # гейт
npm run dev                                             # 127.0.0.1:5173 (часто уже занят — это ожидаемо)
node tools/shot-shape.mjs <tag> 900 4000 600            # синтетика → метрики + скриншоты
# зонды: metrics, pin, enter, filter, sweep, census, flicker, lod, gaps, fan, grow, focus
# скриншоты: tests/betterwright/shape/<tag>-*.png
# попиксельный инкбокс: powershell tools/inkbox.ps1 <png>
BENCH=1 npx vitest run tests/bench-tmp-shape.test.ts --reporter=verbose --silent=false
```

Инварианты, которые нельзя ломать (из `DEV_STATE_LATEST.md` §5):
1. Данные чата не покидают браузер; тяжёлое — в воркере, main рисует.
2. Все подписи — в одном (последнем) depth-бакете; разнесение убивает отрисовку.
3. Зазор коллизий — в экранных px через `pxToWorld`; абсолютные мировые константы запрещены.
4. Переиспользование кадра при фильтре: без FA2 и без повторной нормировки (иначе силуэт рвётся).
5. Плашка гаснет с текстом (`plateAlphaFor`), иначе пустая рамка.
6. LOD-альфа тела — одна функция (`bodyAlpha`); ребро делит её с более слабым концом.
