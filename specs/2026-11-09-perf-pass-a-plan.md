# Perf Pass A — дешёвые победы (без смены архитектуры)

Актуализировано: 2026-11-10. План добавлен `cd14976`; код после 09.11 ушёл вперёд.
Статус: ЗАКРЫТ. Вердикт: `specs/verifications/2026-11-10-perf-pass-a.md`.

## Контекст

Ветка `feat/token-links-filters` влита в `main` (PR #2), дерево чистое.
`HANDOFF.md`: 192 теста, typecheck и build зелёные на 10.11.

Шаги 1–5 и 7 уже в коде. Шаг 6 закрыт частично. Шаг 8 не сделан.

## Цель и критерии

Цель: удешевить update-цикл (тик фильтра) и full-run на десятках тысяч сообщений.
Масштаб: синтетика 120 / 271 / 600 узлов, `?fixture=1`, без реального экспорта.

Baseline снимается до правок: медиана 3 прогонов
`npm run test -- tests/graph.test.ts --reporter=verbose` на одной машине и Node.
Числа фиксируются в `specs/verifications/2026-11-10-perf-pass-a.md`.

Update-цикл: 3 прогона A→B→A, где A — `DEFAULT_FILTER_CFG`, B — тот же cfg
с `mat: true`. Замер `performance.now()` вокруг сообщения `map` в headless Chrome.
Метод и числа — в том же вердикте.

Критерий успеха: p50 full-run и update-цикла не хуже baseline более чем на 5%;
quality-гейты `tests/graph.test.ts` зелёные; Preflight зелёный.
Порог 5% — принятое допущение; при ином решении зафиксировать до шага 0.

HARD GATE: без воспроизводимого baseline и чисел «после» B/C не начинаются.
Красный гейт дважды подряд — СТОП.

## Границы

In scope: `src/core/`, замер, регрессия сброса кешей, шаг 8, локальные тесты.

Out of scope: смена архитектуры, новые зависимости, UI, harness-правки, CI/lint,
реальные экспорты, многослотовый `PipelineCache` (кандидат B).

Отклонения приняты: lint-скрипта и CI нет; механический гейт — локальный
Preflight. `specs/state.yaml` не ведётся.

## Решения

- Работа на `main`; новая ветка не нужна, дерево чистое.
- Регресс-тест на `positionsCache.clear()` не пишется: `worker.ts` использует
  `self` на module scope. Риск принят; компенсация — ручной open→open на двух
  синтетических файлах с общим словом: координаты не наследуются.
- Дефект по пути оформляется отдельным коммитом, не смешивается с A: при ошибке
  `parse()` в `open` кеши не сбрасываются, старый `chat` остаётся доступным.
- `dropFor` живёт в `tally.ts`; `armsFor` → `buildArmsIndex`/`armsFromIndex`;
  `pruneBackbone` → `pruneSortedBackbone` в `select.ts`, не в `graph.ts`.

## Состояние шагов

| N | Статус | Что в коде | Verify |
| --- | --- | --- | --- |
| 0 | DONE | База снята с `326f0e9` (гейт) и `42159fc` (до pass A); метод и числа — в вердикте | `tests/bench-tmp.test.ts`, 3 прогона |
| 1 | DONE | `worker.ts:208` `positionsCache.clear()` в `open` | `typecheck` + `test` + ручной open→open |
| 2 | DONE | `graph.ts:388` FA2 1200/20; `graph.ts:596` collision full/25 | `tests/graph.test.ts` |
| 3 | DONE | `tally.ts:40` числовой `edgeKey`, `KEY_BASE = 2**24` | `tests/tally.test.ts`, `tests/select.test.ts` |
| 4 | DONE | `geometry.ts:466` индекс смежности | `tests/geometry.test.ts` |
| 5 | DONE | `canon.ts:20` `RU_ENDINGS_BY_LAST` | `tests/canon.test.ts` |
| 6 | DONE | `compileWordRules`: списки компилируются раз на конфиг, слово нормализуется раз; `dropFor` — тонкая обёртка | `tests/tally.test.ts`, `tests/filters.test.ts` |
| 7 | DONE | `pruneSortedBackbone` не пересортировывает вход | `tests/select.test.ts` |
| 8 | DONE | `92ac1dd`: stamp-мапы вместо `new Set` на пару | `tests/tally.test.ts` |
| 9 | DONE | Замер «после» + вердикт | `npm run typecheck && npm run test && npm run build` |

## Находки аудита

- `PipelineCache` держит по одной записи tally/merge; переключение фильтров
  вызывает полный пересчёт. Кандидат B после замера A.
- `Intern.nextId` не ограничен; `KEY_BASE = 2**24` молча ломается при
  >16 777 215 уникальных канон-токенов. Нужен guard или явная граница.
- `graph.ts:591` утверждает «test graphs stay under 271», но
  `tests/graph.test.ts:493` уже содержит 600 узлов. Комментарий устарел.
- `tests/tally.test.ts:268` дублирует `dropFor`; `tests/filters.test.ts`
  его не тестирует.
- «Одна сортировка вместо трёх» неточна: сортировки остаются в `worker.ts`,
  `graph.ts`, `select.ts`, `geometry.ts`.
- `armsFromIndex` сортирует соседей каждого узла: реальная сложность
  `O(N + Σ d·log d)`, а не `O(N+E)`.
- `matchesMatCustom` и `isMatAllowlisted` остаются линейными; шаг 6 частичен.

Статус находок на 2026-11-10: закрыты `Intern.nextId` (`fbe8314`), устаревший комментарий
(`e55b0e8`), дубль `dropFor` в тестах (`521f078` + тесты в `tests/filters.test.ts`),
линейные `matchesMatCustom`/`isMatAllowlisted` (шаг 6), per-pair `Set` (шаг 8).
Открыты: один слот `PipelineCache`, лишние сортировки, `armsFromIndex`.

## Кандидаты B/C

Рассматриваются только после HARD GATE:

- Многослотовый LRU-кеш `PipelineCache` по `filterCacheKey` / `mergeCacheKey`.
- Top-5 соседей без полной сортировки в `armsFromIndex`.

Снят: замена per-pair `Set` — закрыта шагом 8.

## Финал

`npm run typecheck && npm run test && npm run build`.

Вердикт: `specs/verifications/2026-11-10-perf-pass-a.md`.
Только после него — решение по B/C.
