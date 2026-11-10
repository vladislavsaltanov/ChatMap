---
type: "Справочник"
title: "Граф, раскладка и рендер"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-09T15:02:00.342Z
sources:
  - id: openwiki-source-cce57285a393001fbc239a2b
    resource: repo://src/core/geometry.ts
  - id: openwiki-source-0759206e62730e1bd21c4964
    resource: repo://src/core/graph.ts
  - id: openwiki-source-29775e617d72607dad6291ba
    resource: repo://src/core/labels.ts
  - id: openwiki-source-f492728fa0fbb5bd2b55e9a8
    resource: repo://src/core/select.ts
  - id: openwiki-source-4f90ae4dca4f784d6ebcd414
    resource: repo://src/core/types.ts
  - id: openwiki-source-66d168c422ed87e616074e32
    resource: repo://src/core/worker.ts
  - id: openwiki-source-e19036f56eb8723352f283fd
    resource: repo://src/ui/mapStyles.ts
  - id: openwiki-source-8837b206dbd5c7ef6a549ee2
    resource: repo://src/ui/mapview.ts
  - id: openwiki-source-88b21a84ffe3cb9b63b6bcdb
    resource: repo://tests/select.test.ts
generated: { by: "pi", at: "2026-11-09T15:02:00.342Z" }
---


# Граф, раскладка и рендер

Отвечает за превращение статистики совстречаемости в интерактивную карту:
отбор видимых узлов и рёбер, детерминированную раскладку и отрисовку через WebGL.

## Выборка: `select()`

Вход — результат `tally` (частоты по токенам и статистика пар).
Выход — до `topN` узлов и до `10000` рёбер, отсортированных по убыванию веса.

- Режим `together`: вес ребра — сумма всех авторских встреч плюс межрепликовые.
- Режим `author`: учитываются только встречи выбранного автора.
- Режим `cross`: учитываются только межрепликовые встречи, узлы без таких встреч отсекаются.
- Порог `minWeight` отбрасывает слабые рёбра до обрезки по лимиту.

## Скелет графа: disparity backbone

Отобранные рёбра проходят через `pruneSortedBackbone`:

- каждый узел гарантированно сохраняет 2 самых сильных ребра;
- дополнительно сохраняются рёбра, значимые по критерию Серрано `(1 - w/s)^(k-1) < alpha`;
- бюджет — `max(300, nodes * 3.5)`, сначала top-2, остаток — disparity-рёбрами.

Это убирает «кашу» на 600 узлах: сильные локальные связи остаются, шум срезается.

## Раскладка: детерминированный ForceAtlas2

Раскладка вызывается из воркера с фиксированным `seed: 1337`.
Случайность инициализации и шума полностью выводится из seed,
поэтому одна и та же карта пересобирается одинаково.
Кэш позиций (`positionsCache`, LRU до 2000 записей, ключ — каноническая форма)
переиспользует координаты при смене фильтров, чтобы карта не «прыгала».

Размер узла резервируется функцией `nodeFitSize`:
редкие слова — компактные точки, частотные хабы — крупные якоря.
Отрисовываемый радиус сжимается через `visualCoreRadius`,
чтобы в плотных кластерах оставался визуальный зазор.

## Передача в UI: `WorkerNode` / `WorkerEdge`

Воркер отдаёт готовые к рисованию массивы:

- узел: `id`, `label` (лучшая словоформа), `canon`, `x/y`, `size`, `count`,
  `authorLead` (автор-лидер по частоте), `phase` и руки `arm0..arm4` для нейро-стиля;
- ребро: `a/b`, `weight`, `alpha`, `bead`, `tract`, `bundle`, `rank`.
- отдельно — `forms`: отсортированный список словоформ с частотами для панели узла.

## Рендер: sigma.js поверх graphology

`MapView` строит `graphology`-граф и рисует его через Sigma v4 на `<canvas>` (WebGL).
Стили узлов, рёбер, LOD-иерархия, fisheye-увеличение иcollision подписей
реализованы как функции от состояния камеры в `mapStyles` и `geometry`.
Подписи проходят через резолвер коллизий: побеждает более приоритетный
(крупный) узел, перекрытые подписи скрываются или получают подложку.

## Представительные тесты

- `tests/graph.test.ts`: 600 узлов не дают кашу, центр разрежен;
  инварианты LRU-кэша и детерминированности раскладки.
- `tests/select.test.ts`: режимы together/author/cross, пороги topN/minWeight.
- `tests/geometry.test.ts`: размеры узлов, ширина и цвет рёбер, fisheye.
