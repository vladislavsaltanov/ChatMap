---
type: "Справочник"
title: "Граф, раскладка и рендер"
description: "Отбор слов без сирот, assignment-раскладка с fBm-силуэтом, бандлинг рёбер и WebGL-рендер."
tags: [graph, layout, render, sigma, routing]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-15T11:24:14.683Z
sources:
  - id: openwiki-source-cce57285a393001fbc239a2b
    resource: repo://src/core/geometry.ts
  - id: openwiki-source-0759206e62730e1bd21c4964
    resource: repo://src/core/graph.ts
  - id: openwiki-source-29775e617d72607dad6291ba
    resource: repo://src/core/labels.ts
  - id: openwiki-source-5ee26bb4e615e1ab2348919e
    resource: repo://src/core/leaf.ts
  - id: openwiki-source-f492728fa0fbb5bd2b55e9a8
    resource: repo://src/core/select.ts
  - id: openwiki-source-985a5be8bba8d5061d9e2b12
    resource: repo://src/core/spread.ts
  - id: openwiki-source-6ec5e427df9b94a26400e220
    resource: repo://src/core/style-math.ts
  - id: openwiki-source-4f90ae4dca4f784d6ebcd414
    resource: repo://src/core/types.ts
  - id: openwiki-source-66d168c422ed87e616074e32
    resource: repo://src/core/worker.ts
  - id: openwiki-source-e19036f56eb8723352f283fd
    resource: repo://src/ui/mapStyles.ts
  - id: openwiki-source-8837b206dbd5c7ef6a549ee2
    resource: repo://src/ui/mapview.ts
generated: { by: "pi", at: "2026-11-15T11:24:14.683Z" }
---

# Граф, раскладка и рендер

Отвечает за превращение статистики совстречаемости в интерактивную карту:
отбор видимых узлов и рёбер, детерминированную раскладку assignment-методом
и отрисовку через WebGL.

## Выборка: `select()`

Вход — результат `tally` (частоты по токенам и статистика пар).
Выход — до `topN` узлов и до `10000` рёбер, отсортированных по убыванию веса.

- Режим `together`: вес ребра — сумма всех авторских встреч плюс межрепликовые.
- Режим `author`: учитываются только встречи выбранного участника.
- Режим `cross`: учитываются только межрепликовые встречи, узлы без таких встреч отсекаются.
- Порог `minWeight` отбрасывает слабые рёбра до обрезки по лимиту.
- Слово без единого видимого ребра на карту не попадает (`dropEdgelessNodes`):
  у него нет позиции, а карман изолятов из сотен таких слов взрывался бы
  отдельным мёртвым листом. `maxCount` при этом считается до отсечения,
  чтобы размеры не прыгали при движении слайдера.

## Скелет графа: disparity backbone

Отобранные рёбра проходят через `pruneSortedBackbone`:

- каждый узел гарантированно сохраняет 2 самых сильных ребра;
- дополнительно сохраняются рёбра, значимые по критерию Серрано `(1 - w/s)^(k-1) < alpha`;
- бюджет — `max(300, nodes * 3.5)`, сначала top-2, остаток — disparity-рёбрами.

Это убирает «кашу» на 600 узлах: сильные локальные связи остаются, шум срезается.

## Раскладка: assignment + fBm-силуэт (ForceAtlas2 удалён)

Силовых итераций по всему графу больше нет. Пайплайн в `layout()`:

1. `spread()`: группы слов, лендмарки зон (`leaf.ts`, Дейкстра от хабов,
   стебли-фасклы), стресс по backbone-рёбрам, релаксация коллизий
   с весозависимым откликом (тяжёлые тела стоят, пыль расходится).
2. `blobOffset`: fBm-деформация готового силуэта — радиальные шипы по краю,
   downhill-выжигание войд внутри, слабый domain-warp; затем повторный
   `containTail` и короткий anchored relax-проход.
3. `holdAspect(2.0)`: только растяжение меньшей оси по P10..P90 массе.
4. Маршруты рёбер (`bundleEdges`): общий ствол для одного стебля
   (`trunkControls`), коридоры через общие gateway-точки соседних зон,
   внутриядерные дендриты; вес ранжирует детализацию (`bundle`, `rank`).

Сид роллится на каждое открытие файла (`?seed=` в URL фиксирует его для
воспроизводимых стендов); переключение фильтров сид хранит.
Кэш позиций (`positionsCache`, LRU до 2000 записей, ключ — каноническая форма)
переиспользует координаты, а `assignGroups` пересчитывает топики и порты-центроиды
под новую выборку — силуэт не прыгает, а линии не выпрямляются в fallback.

Размер узла — степенной закон от частоты (`SIZE_GAMMA`, крышка `SIZE_MAX`,
бюджет площади `footprintScale`); отрисовываемый радиус сжимается через
`visualCoreRadius`, чтобы в плотных кластерах оставался визуальный зазор.

## Чистая математика стилей

Вся LOD/alpha-математика — чистые функции `src/core/style-math.ts`
(`edgeOpacity`, `labelAlphaFor`, `bodyAlpha`, `fanCoreFrac` и др.):
тело и его рёбра делят одну LOD-альфу, плашка гаснет вместе с текстом.
`mapStyles.ts` — тонкий адаптер атрибутов Sigma к этим ядрам.

## Передача в UI: `WorkerNode` / `WorkerEdge`

Воркер отдаёт готовые к рисованию массивы:

- узел: `id`, `label` (лучшая словоформа), `canon`, `x/y`, `size`, `count`,
  `authorLead` (автор-лидер по частоте), `phase` и руки `arm0..arm4` для нейро-стиля;
- ребро: `a/b`, `weight`, `alpha`, `bead`, `tract`, `bundle`, `rank`;
- отдельно — `forms`: отсортированный список словоформ с частотами для панели узла.

## Рендер: sigma.js поверх graphology

`MapView` строит `graphology`-граф и рисует его через Sigma v4 на `<canvas>` (WebGL).
Стили узлов, рёбер, LOD-иерархия и fisheye-увеличение вычисляются от состояния
камеры. Подписи проходят через резолвер коллизий (`resolveLabelBoxes`):
побеждает более приоритетный (крупный, sticky-держит слот) узел, подпись,
перекрывающая чужой маркер, получает подложку (`resolveLabelBackdrops`).

## Представительные тесты

- `tests/graph.test.ts`: golden-хеш раскладки, mass-weighted отклик,
  routing reuse-кадра без straight-fallback, детерминизм S7/S8.
- `tests/spread.test.ts`: S-гейты (аспект, зазор, топология, бюджет S9
  медианой из 3 с прогревом), `assignGroups`.
- `tests/select.test.ts`: режимы together/author/cross, пороги topN/minWeight,
  срезка слов без связей, `dropEdgelessNodes`.
- `tests/style-math.test.ts`, `tests/blob.test.ts`, `tests/geometry.test.ts`,
  `tests/megahub.test.ts` + стенд `tools/shot-shape.mjs` (`?seed=` для
  воспроизводимых прогонов).
