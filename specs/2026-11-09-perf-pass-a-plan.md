# Perf Pass A — дешёвые победы (без смены архитектуры)

Цель: удешевить update-цикл (тик фильтра) и full-run. Масштаб по умолчанию —
десятки тысяч сообщений. Подход B/C — только после замера эффекта A.

Решения:
- Работа на текущей ветке `feat/token-links-filters` (дерево уже грязное
  связанной работой; новая ветка унесла бы грязь с собой).
- Регресс-тест на фикс positionsCache не пишется: `worker.ts` дёргает `self`
  на module scope, импорт в vitest/node падает без harness-правок, а harness
  вне скоупа (YAGNI). Проверка — typecheck + suite + инспекция.

Шаги (каждый: правка → verify → green → дальше; красный дважды подряд — СТОП):

| N | Задача | Файлы/функции | Verify |
|---|--------|----------------|--------|
| 1 | fix: сброс positionsCache на open | `worker.ts` ветка `open` | `typecheck` + `test` |
| 2 | Бюджет коллизий full/update | `graph.ts` `layout()` passes | `tests/graph.test.ts` |
| 3 | Числовые ключи пар вместо `"a:b"` | `tally.ts` edgeKey/parseEdgeKey, `select.ts` | `tests/tally.test.ts` `tests/select.test.ts` |
| 4 | armsFor через смежность, O(N+E) | `geometry.ts` armsFor | `tests/geometry.test.ts` |
| 5 | Индекс окончаний стеммера | `canon.ts` stemRu/stemLatin | `tests/canon.test.ts` |
| 6 | Быстрый путь dropFor/matchesMat | `filters.ts` | `tests/filters.test.ts` |
| 7 | Одна сортировка вместо трёх | `select.ts` select, `graph.ts` pruneBackbone | `tests/select.test.ts` (+ где тестируется prune) |
| 8 | Adjacent без Set-аллокаций | `tally.ts` tally | `tests/tally.test.ts` |

Финал: `npm run typecheck && npm run test && npm run build`.
