# ChatMap Neural Map Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать карту «живой нейронной сетью» из метабольных капель ртути: разорванное пятно без чёткой структуры, отростки-дендриты к сильнейшим соседям, светящиеся синаптические жилы, эффектность и элегантность вместо кругов. Zoom-resolved LOD = «3D проекция»: на общем плане — только частые слова и их связи; с приближением проявляются редкие слова, их связи становятся заметнее.

**Architecture:** Шейдерная прослойка Sigma v4 (`layerSoma` — капля с дендритами, `layerAxon` — жила с импульсами) поверх ядра layout (FA2 + collision + shape-noise). Ядро выдаёт позиции и атрибуты `phase/arm*/bead/alpha`, `mapStyles` переводит их в переменные шейдеров, `mapview` регистрирует `NEURAL_PRIMITIVES` и тикает часы. Пятно рвётся в `graph.ts` через переразреживание лоб.

**Tech Stack:** TypeScript strict, Sigma v4 (`Sigma<any,any,any,CustomNodeState,CustomEdgeState,CustomGraphState>`), graphology + `graphology-layout-forceatlas2`, Vite, vitest, `betterwright` (playwright, есть ли пакет в репо проверить; если нет — `npx playwright` через `betterwright` skill).

**Spec:** Этот файл является и спецификацией, и планом. Плюс `HANDOFF.md` (статус), `CONVENTIONS.md` (always-green, тесты только core).

## Global Constraints
- Фон карты **не менять**: `backgroundColor: '#1d1c19'`. Любой другой цвет менять свободно.
- Свечение, градиенты, любые визуальные эффекты разрешены (запрет снят этим планом — исходный запрет `CONVENTIONS.md` здесь не применяется; шейдерные блики — главный инструмент).
- Никакой сети с содержимым чата (fetch/XHR/WebSocket с токенами). Только `tests/fixtures/sample-export.json` в git.
- Тесты только на `src/core/` (vitest). UI — вручную + `betterwright` скриншоты.
- Preflight зелёный до коммита: `npm run typecheck && npm run test && npm run build`.
- Никаких UI-фреймворков и новых зависимостей.
- Интерфейс на русском, телеграфно. conventional commits.

## Review Focus
1. 600+ узлов на fringe — гало сливаются в туман, тёмный фон тонет: ожидается обрезание гало на микро-яде, пыль только прозрачностью, не подмесом цвета.
2. Два хаба на <40px — шейдерный метабольный шов пайяет их в комок: ожидается крупный зазор из `graph.ts` (пятно рвётся), не из шейдера.
3. Дендрит к сильному соседу, но не на соседнюю ноду — удлинение не больше 0.6×дистанции до соседа и не перекрывает подпись (label `over` только в ядре).
4. Zoom-resolved LOD = «3D проекция»: на общем плане видны только частые слова (topN по частоте) и их связи; при зуме-in проявляются редкие слова, их рёбра и подписи становятся заметнее. Отдаление до overview (`lodRatio > 1.15`) — подписи скрыты, звёздная пыль, а не мусор: `lodScale` + `lodDust` + `opacity`, не `color`-mix.
5. Hover/pin каждый кадр — FPS: `mixCache` кванты 1/16, `labelSize` ступени 2px, `refresh({skipIndexation:true})`.

---

## File Structure
| File | Роль |
|---|---|
| `src/core/geometry.ts` | `edgeAlpha`, `haloPx/quadOf/coreFrac` (переезд из mapStyles), размеры узлов |
| `src/core/graph.ts` | `layout`, `resolveCollisions`, `shapeNoise`, рвань пятна |
| `src/core/worker.ts` | Пайплайн воркера, выдача `phase/arm*/bead/alpha` |
| `src/core/types.ts` | Типы `WorkerNode`/`WorkerEdge` (расширение) |
| `src/ui/neural.ts` | `layerSoma/layerAxon`, `NEURAL_PRIMITIVES`, `setNeuralTime` |
| `src/ui/mapStyles.ts` | Стили Sigma, LOD, `NODE_VARS`, подписи |
| `src/ui/mapview.ts` | Регистрация primitives, rAF-тик часов, загрузка в граф |
| `tests/graph.test.ts`, `tests/geometry.test.ts` | Юнит-тесты ядра |
| `tests/betterwright/` | Скриншот-гейты (4 сцены × 2 зума) |

---

### Task 1: Пятно разорвать (graph.ts layout)

**Files:**
- Modify: `src/core/graph.ts:241-325`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: сид 1337, `shapePhases` из `layout()` (6 значений от rng).
- Produces: разорванное пятно — хабы на fringe-лобах (радиус > 1.2×median радиуса fringe), `voidRatio(100) > 0.05` (≥5% ячеек 100×100 пустые внутри bbox). `resolveCollisions` с реальным гало, capped 30 пассов при переполнении + jitter fallback при >400 узлов если пассов не хватило.
- Контекст (Sigma context7 /jacomyal/sigma.js): variables = типизированные атрибуты, мост data→GPU. `layerPlain` берёт цвет через `EdgeColorValue` (`{node:'source'}` читает живой цвет ноды из GPU-текстуры — для axon оставлено `v_sourceColor/v_targetColor`, это корректно). `uniforms` + `lifecycle.beforeRender` — путь для `u_time` в soma; edge-layer time идёт через `edgeTime/edgeMotion` в `layerAxon`.
- Большая фикстура (локально, не в git): `ChatExport_2026-11-03/result.json` — 142k сообщений, 2 автора, 64k raw-токенов, 55 МБ. Используется как perf-шкала: topN=600 по умолчанию, fringe-проверка на 600 нодах. Переписка не печатается, только счётчики.

- [ ] **Step 1: Написать тест рвани пятна** — синтетика, без реального файла
  ```ts
  it('(h) пятно разорвано: хабы на fringe-лобах, void>0.05', () => {
    const nodes = Array.from({length: 120}, (_,i)=>({id:i+1, size: 20}));
    const edges: Array<{a:number;b:number;weight:number}> = [];
    // 12 хабов × 9 лучей — структура лобовая, детерминирована
    for (let h = 1; h <= 12; h++) for (let k = 1; k <= 9; k++) edges.push({a: h, b: 12 + (h-1)*9 + k, weight: 3 + (k % 4)});
    const res = layout(nodes, edges, {seed: 1337, fullRun: true});
    const pts = [...res.positions.values()];
    const centroid = pts.reduce((a,p)=>({x:a.x+p.x/pts.length, y:a.y+p.y/pts.length}), {x:0,y:0});
    const radii = pts.map(p => Math.hypot(p.x-centroid.x, p.y-centroid.y)).sort((a,b)=>a-b);
    const median = radii[Math.floor(radii.length/2)];
    const hubs = pts.slice(0,12);
    for (const h of hubs) expect(Math.hypot(h.x-centroid.x, h.y-centroid.y)).toBeGreaterThan(median);
    const cell = 100, seen = new Set<string>();
    for (const p of pts) seen.add(`${Math.floor((p.x+5000)/cell)},${Math.floor((p.y+5000)/cell)}`);
    const minX = Math.floor((Math.min(...pts.map(p=>p.x))+5000)/cell), maxX = Math.floor((Math.max(...pts.map(p=>p.x))+5000)/cell);
    const minY = Math.floor((Math.min(...pts.map(p=>p.y))+5000)/cell), maxY = Math.floor((Math.max(...pts.map(p=>p.y))+5000)/cell);
    const total = (maxX-minX+1)*(maxY-minY+1);
    expect(1 - seen.size/total).toBeGreaterThan(0.05);
  })
  ```

- [ ] **Step 2: Запустить тест, убедиться, что падает**
  ```bash
  npm.cmd run test -- tests/graph.test.ts -t "пятна разорвано"
  ```
  Ожидание: FAIL, `voidRatio < 0.05` или хаб в центре как у ядра FA2.

- [ ] **Step 3: Реализация — рвань в `graph.ts`**
  В `layout()`, блок post-FA2 (строки 241-290):
  - Дворки хабов раскидывать: после stretch+noise — push хабов (ранг < 0.1) наружу вдоль радиуса: `p *= 1.25` для них.
  - `shapeNoise` амплитуду: fringe — `0.18+0.5*t → 0.35+0.75*t`, `Math.min(1, order/30)` → `Math.min(1, order/20)`.
  - Мешает 6 фаз, не 3: добавить 2 октавы (октавы 21, 27) в `shapeNoise` weights `[0.4,0.24,0.14,0.1,0.07,0.05] → [...,0.03,0.02]` и `shapePhases` — 8 значений.
  - `resolveCollisions`: `padScale = s => 26*scaleFactor*min(1,max(0.45,s/24))` оставить; пассы `>400 → 120` оставить; добавить capped: если после `passes` остались пересечения >2% пар — jitter fallback: раскидывать перекрывающиеся на спайраль золотого угла, 10 итераций. Сигнатура не меняется.
  - Сид сохранить 1337. `MAX_SCALE_FACTOR=8` оставить.

- [ ] **Step 4: Тест проходит, регрессия по старым тестам**
  ```bash
  npm.cmd run test -- tests/graph.test.ts
  npm.cmd run typecheck
  ```
  Ожидание: PASS все 12+новых, tsc 0.

- [ ] **Step 5: Скриншотгейт (betterwright)**
  ```bash
  betterwright check --scene core100 --zoom 1
  ```
  Ожидание: пятно не круг. Если betterwright нет в репо — `npx playwright screenshot` + `?fixture=1`. Артефакт в `tests/betterwright/after-t1.png`. Предметно: хабы разнесены, void заметен.

- [ ] **Step 6: Коммит**
  ```bash
  git add src/core/graph.ts tests/graph.test.ts
  git commit -m "feat(graph): разорвать пятно — fringe в меш, хабы в лобы"
  ```

---

### Task 2: `edgeAlpha` и `halo/quad/coreFrac` в ядро (geometry.ts)

**Files:**
- Modify: `src/core/geometry.ts`, `src/ui/mapStyles.ts` (удалить дубли, импортировать из geometry)
- Test: `tests/geometry.test.ts`

**Interfaces:**
- Produces: экспорты `edgeAlpha(w,wmax): number`, `haloPx(core): number`, `quadOf(core): number`, `coreFrac(core): number`. `edgeColor`/`edgeWidth` не трогаем.
- `mapStyles.ts` импортирует из `../core/geometry` (сейчас там определены `haloPx`, `quadOf`, `coreFrac` — перенести без смены математики).

- [ ] **Step 1: Тесты на новые экспорты**
  ```ts
  import { edgeAlpha, haloPx, quadOf, coreFrac } from '../src/core/geometry'
  it('edgeAlpha: монотонна и в [0.1,0.6]', () => {
    expect(edgeAlpha(0,100)).toBe(0.1)
    expect(edgeAlpha(100,100)).toBeCloseTo(0.6)
    expect(edgeAlpha(25,100)).toBeCloseTo(0.1+0.5*0.5)
  })
  it('haloPx/quadOf/coreFrac: квад = ядро+гало, монотонность', () => {
    expect(quadOf(20)).toBe(20+haloPx(20))
    expect(coreFrac(20)).toBeCloseTo(20/quadOf(20))
    expect(haloPx(5)).toBeGreaterThanOrEqual(12)
    expect(haloPx(60)).toBeLessThanOrEqual(44)
  })
  ```

- [ ] **Step 2: `npm.cmd run test -- tests/geometry.test.ts` — FAIL (экспорт отсутствует)**

- [ ] **Step 3: Реализация**
  `geometry.ts` добавить три чистых функции (те же формулы, что в `mapStyles.ts:29-37`):
  ```ts
  export function haloPx(core:number){ return Math.min(44, Math.max(12, core*0.8+9)) }
  export function quadOf(core:number){ return core+haloPx(core) }
  export function coreFrac(core:number){ return core/quadOf(core) }
  ```
  `edgeAlpha` уже есть (строка 72-76), не трогать.
  `mapStyles.ts`: импортировать, удалить дубли.

- [ ] **Step 4: `npm.cmd run test -- tests/geometry.test.ts` + `npm.cmd run typecheck` — PASS**

- [ ] **Step 5: Коммит**
  ```bash
  git add src/core/geometry.ts src/ui/mapStyles.ts tests/geometry.test.ts
  git commit -m "refactor(geometry): вынести halo/quad/coreFrac в ядро"
  ```

---

### Task 3: Атрибуты `phase/arm*/bead/alpha` из воркера (worker.ts + types.ts)

**Files:**
- Modify: `src/core/worker.ts`, `src/core/types.ts`
- Test: ручной инспект `MapMsg` через браузер (в воркере тестов нет), но контракт проверяется типом; + скрингейт в Task 5.

**Interfaces:**
- `WorkerNode` получает: `phase: number` (0..1), `arm0..arm4: number` (повороты 0..1 или -1), опционально `bead?: number`.
- `WorkerEdge` получает: `alpha: number`.

- [ ] **Step 1: Типы**
  ```ts
  // src/core/types.ts, WorkerNode после authorLead
  phase: number; arm0: number; arm1: number; arm2: number; arm3: number; arm4: number;
  // WorkerEdge
  alpha: number;
  ```

- [ ] **Step 2: `npm.cmd run typecheck` — FAIL (worker.ts не заполняет новые поля)**

- [ ] **Step 3: Реализация**
  `worker.ts` после `layoutResult` и перед `nodes.push`:
  - соседства по `backboneEdges`: для каждого узла топ-5 соседей по весу, углы `atan2(dy,dx)/(2π) → 0..1`, иначе -1. Сортировка по весу desc, детерминированность по id.
  - `phase` — от seeded rng (seed 1337) `0..1`, не от позиции (чтобы не дрожал при инкременте).
  - `alpha` на ребро — `edgeAlpha(edge.weight, selection.maxWeight)`.
  - В цикле `nodes.push({...})` добавить поля.

- [ ] **Step 4: `npm.cmd run typecheck` + `npm.cmd run test` — PASS**

- [ ] **Step 5: Коммит**
  ```bash
  git add src/core/types.ts src/core/worker.ts
  git commit -m "feat(core): выдача phase/arm/bead/alpha для нейронного вида"
  ```

---

### Task 4: Шейдеры как нейросеть (neural.ts + mapStyles.ts)

**Files:**
- Modify: `src/ui/neural.ts`, `src/ui/mapStyles.ts` (NODE_VARS, стили)
- Test: `betterwright` (playwright) скриншоты.

**Interfaces:**
- `layerSoma(vec4 v_somaColor, float v_somaCore, float v_somaGlow, float v_somaPhase, float v_somaA0…v_somaA4, float u_time)` — сигнатура не меняется.
- `layerAxon(EdgeContext ctx)` — сигнатура не меняется.
- `setNeuralTime(seconds, motion)` — сигнатура не меняется, вызывается с rAF.
- `NEURAL_PRIMITIVES` — форма не меняется, только содержание слоёв.

- [ ] **Step 1: Скриншот-база (betterwright)**
  ```bash
  betterwright check --scene fixture600 --zoom 1
  betterwright check --scene fixture100 --zoom 2.5
  betterwright check --scene fixturePinned --pin 42
  betterwright check --scene fixtureOverview --zoom 0.3
  ```
  Ожидание: зафиксированы артефакты `*-before.png` (сейчас схематично).

- [ ] **Step 2: Усилить дендриты**
  `neural.ts`, `somaArm`: длина отростка `lenMax = (1.0-c)*0.84 → (1.0-c)*1.15`, tipR `0.075*c → 0.045*c` (тонче, ветвистее), rootR `0.36*c → 0.28*c`. В `somaField`: вес дендритов `smoothstep(4+2.4i, 7.5+2.4i, coreR)` расширить порог — мелким хабам (coreR 4-10) отростки тоже давать (0.5× длина). Добавить второй ряд мелких побочных отростков: 2-3 коротких на каждый arm.
  `mapStyles.ts`: `arm` переменные оставляем; `coreFrac` маппинг тот же.

- [ ] **Step 3: Биение и звёзды**
  Шейдер: `breathe` амплитуда `0.1 sin → 0.06 + 0.04*sin(2t)` — «пластичное» покачивание больше, не пульс. Мелкие узлы (coreR<8) — звезда с внутренним белым центром уже есть, поднять конт: `solid = mix(col, vec3(1), 0.6*pow(d,1.6)) → 0.85*pow(d,1.3)`. Гало `haloK = (1-c)*0.34 → (1-c)*0.22` — плотнее ртуть, меньше туман.

- [ ] **Step 4: Синапсы и импульсы**
  `layerAxon`: `bead` — диаметр бусины `halfPx*0.55 → halfPx*0.4`, цвет бусины — горячее (mix to white 0.85). Фоновая частота импульсов `u_time*0.1 → u_time*0.07`, на активных — `0.55 → 0.4` (дольше бежит). Сильные связи (alpha>0.4) — двойной импульс (вторая гармоника gauss).
  `mapStyles.ts`: `pulse: 1` только на `isActive`, фон 0 оставляем.

- [ ] **Step 5: Шрифты и подписи**
  `mapStyles.ts`: пилюля никогда — `labelPosition: 'right'` для `!labelFits` оставляем; `labelBackgroundColor: '#0f0e0bc7'` → `'#1d1c19b3'` (фон карты с прозрачностью — подписть сливается с фоном, не с градиентом). `labelBackgroundPadding: 5 → 3`.

- [ ] **Step 6: `npm.cmd run typecheck && npm.cmd run build` — PASS**

- [ ] **Step 7: Скриншот-гейт**
  ```bash
  betterwright check --scene fixture600 --zoom 1
  betterwright check --scene fixture100 --zoom 2.5
  betterwright check --scene fixturePinned --pin 42
  betterwright check --scene fixtureOverview --zoom 0.3
  ```
  Ожидание: 4 артефакта `*-after.png`. Критерии: (1) сходство с Colorpong/Trantor — сеть, не круги; (2) элегантность — нет слизи в fringe; (3) читаемость подписи хаба.

- [ ] **Step 8: Коммит**
  ```bash
  git add src/ui/neural.ts src/ui/mapStyles.ts
  git commit -m "feat(ui): дендриты ветвятся, ртуть плотнее, синапсы горячее"
  ```

---

### Task 5: Проводка и часы (mapview.ts)

**Files:**
- Modify: `src/ui/mapview.ts`, `src/ui/mapStyles.ts`
- Test: `betterwright` runtime (rAF идёт, FPS не замеряется программно — визуально).

**Interfaces:**
- `NEURAL_PRIMITIVES` от Task 4; `setNeuralTime(seconds, motion)` от Task 4.
- `initRenderer` подписывает primitives; rAF тикает `setNeuralTime`.

- [ ] **Step 1: Регистрация primitives**
  `mapview.ts:130-140`: `primitives: { edges: { paths: [pathLine(), pathCurved()] } }` заменить на `primitives: NEURAL_PRIMITIVES` (nodes+edges). `MAX_ARMS` не нужен в UI — задан в атрибутах воркера.

- [ ] **Step 2: Часы**
  В `initRenderer` после создания renderer: rAF-петля `let start = performance.now(); const tick = () => { setNeuralTime((performance.now()-start)/1000, document.hidden ? 0 : 1); requestAnimationFrame(tick) }`. `motion` 0 при скрытой вкладке. Остановить не нужно — время по модулю 7200 в `setNeuralTime`. Стор в поле класса `neuralRaf`, отмена при `destroy` (если есть).

- [ ] **Step 3: Проложить атрибуты в граф**
  В `render(msg)`, при `addNode`: добавить `phase, arm0..arm4` из `node.phase/arm*`; при `addEdge`: добавить `alpha: edge.alpha`, `bead: 0` (дефолт), `curvature` уже есть. `NODE_VARS` в `mapStyles.ts` уже читает `phase/arm*` — не трогать.

- [ ] **Step 4: `npm.cmd run typecheck && npm.cmd run test && npm.cmd run build` — PASS**

- [ ] **Step 5: Скриншот-гейт**
  ```bash
  betterwright check --scene fixture600 --zoom 1
  betterwright check --scene fixture100 --zoom 2.5
  ```
  Ожидание: дендриты тянутся к соседям, капли дышат (два кадра с паузой 500мс различаются Гало, но не прыгают).

- [ ] **Step 6: Коммит**
  ```bash
  git add src/ui/mapview.ts
  git commit -m "feat(ui): подключить нейронные шейдеры и часы"
  ```

---

### Task 6: Zoom-resolved LOD (3D проекция)

**Files:**
- Modify: `src/ui/mapStyles.ts`, `src/ui/neural.ts` (LOD-ветви)
- Test: `betterwright` сцены «общий план» vs «приближение»

**Interfaces:**
- Пользователь сразу видит самые используемые слова и их связи; при зуме — больше (реже используемых) слов. Реализация: видимость узла по порогу `size` — его функция лога от частоты: порог = f(lodScale): на zod > 1 только крупные (r>14), на lodRatio=1 — все; подпись порог — `size >= 18` (уже есть `labelFits/labelVisibility`); рёбра видимо только если оба конца видимы; при зуме-in рёбра ярче (`alpha` растёт с lodScale соседей).

- [ ] **Step 1: Скрин-база LOD**
  betterwright: общий план (zoom 1), средний (zoom 1.5), крупный (zoom 2.5). Ожидание: на общем — только хабы и сильные нити, на крупном — мелочь.

- [ ] **Step 2: Пороги видимости**
  `mapStyles.ts` `visibility`: сейчас прячет только пыль <2px. Добавить порог по размеру: `lodScale(size) < 4` → на фоне (opacity 0.15, не hidden — структура важна), `lodScale(size) < 10` → opacity 0.5. На зуме-in (`lodRatio < 0.8`) — opacity → 1. Подписи уже гейтятся через `labelFits` и `labelVisibility`: при `lodRatio > 1.15` hidden, при `size >= 18` visible — оставить.

- [ ] **Step 3: Рёбра заметнее при зуме**
  `mapStyles.ts` edges base `opacity: { attribute: 'alpha' }` — оставить для фона; при `lodRatio < 1` усилить по соседям: `visibility` рёбер: рёбра обоих концах <4px → 0.2 opacity; иначе alpha.

- [ ] **Step 4: Скрин-гейт LOD**
  Те же три сцены. Критерии: общий план — сеть, не каша; крупный — мелочь читается; подписи только где влезают.

- [ ] **Step 5: Коммит**
  ```bash
  git add src/ui/mapStyles.ts src/ui/neural.ts
  git commit -m "feat(ui): zoom-resolved LOD — 3D проекция по частоте"
  ```

---

### Task 7: Каша при большом количестве нод (финальный чек)

**Files:**
- Modify: по результату проверок — `graph.ts` / `mapStyles.ts` / `neural.ts`
- Test: `betterwright` + ручной чек

- [ ] **Step 1: Загрузка fixture600 и fixture2000**
  ```bash
  betterwright check --scene fixture600 --zoom 1
  betterwright check --scene fixture2000 --zoom 1
  ```
  Критерий каши: в центре (300×300) не должно быть >40% пикселей ненулевой яркости; подписи хабов читаются с 5м дистанции (zoom 1). Если каша — крутить только в рамках графа/гайдлайнов: fringe-tle `scalingRatio 22000 → 28000`, `gravity 0.0001 → 0.00006`, `haloK 0.22 → 0.16`, капля fringe `coreFrac` < 0.25 — без гало вообще.

- [ ] **Step 2: Фиксация результата**
  Записать в `specs/verifications/neural-look.md` какие параметры выбраны и почему, со ссылками на скриншоты.

- [ ] **Step 3: Коммит**
  ```bash
  git add specs/verifications/neural-look.md src/
  git commit -m "feat(ui): финальная настройка плотности нейросети"
  ```



---

## Self-review
- Все пункты запроса закопаны: нейросеть — Tasks 4-5; метаболы/капли ртути — Task 4; разорванное пятно без структуры — Task 1; каша при большом N — Task 6 + Task 1 fallback; фон не менять — Global Constraints; betterwright — во всех скрин-гейтах.
- Типы: `phase/arm*/bead/alpha` в `types.ts` (T3) → `worker.ts` (T3) → `mapview.ts` (T5) → `NODE_VARS`/`NEURAL_PRIMITIVES` (T4). Сигнатура `layout()` не меняется, `resolveCollisions` сигнатура не меняется, `setNeuralTime`/`layerSoma`/`layerAxon` не меняются.
- Сид 1337 сохранён везде, детерминизм сохранён.
- Каждый шаг — один тестовый прогон или один скриншот; коммит в конце задачи.

## Execution Handoff
План сохранён в `specs/neural-map-plan.md`. Просмотри пожалуйста. Каким путём идти?

- **Subagent-driven** — свежий субагент на задачу + ревьюер перед следующей. Дороже, надёжнее для шейдеров.
- **Native** — я сам по задачам в этой сессии, ревьюер в конце. Быстрее, дешевле.

Рекомендую **Native**, потому что задачи идут последовательно через одни и те же переменные (`phase/arm*`), и свежий агент каждый раз терял бы контекст шейдера.
