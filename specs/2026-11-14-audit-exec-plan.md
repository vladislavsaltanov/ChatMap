# Exec-plan: аудит 2026-11-14 + Дополнение (к исполнению)

Источник решений: `specs/2026-11-14-audit.md` (5 вердиктов) + `# ДОПОЛНЕНИЕ` (5 ловушек, 4 развилки, порядок).
Статус: `[STATUS: IN_PROGRESS — Wave 1]`. Модель-лид: `muse-spark-1.3-contributor (xhigh)`.

## Волна 1 (параллельно, файлы не пересекаются)

| ID | Агент | Модель | In scope | Out of bounds | Верификация |
|---|---|---|---|---|---|
| A | worker | deepseek-v4.1-flash | `src/core/geometry.ts` (B1a: `WEAK_EDGE_CAP 0.38→0.16`; B3-хелпер `r<=SIZE_MIN?r:SIZE_MIN+(r-SIZE_MIN)*s`), `src/core/worker.ts` (вызов хелпера), `tests/geometry.test.ts` (пины) | `src/ui/*`, `specs/*` | `npx tsc --noEmit -p tsconfig.json`, `npx vitest run tests/geometry.test.ts` |
| B | worker | muse-spark-1.3-contributor | `src/core/spread.ts` (одна `FRAME_ASPECT=2.0`, удалить `FIGURE_ASPECT=1.9` как независимую), `src/core/graph.ts` (`holdAspect` по P10..P90, лог угла главной оси), `tests/spread.test.ts` (S1 на ту же меру `[1.85,2.15]` + кап хвостов) | `src/core/worker.ts`, `specs/*` | `npx tsc --noEmit -p tsconfig.json`, `npx vitest run tests/spread.test.ts` |
| C | worker | deepseek-v4.1-flash | `src/main.ts`, `src/ui/mapview.ts` (B4: на `error` чистить Sigma-карту / сбрасывать состояние вида; альтернатива — атомарный reset после успешного `parse`, выбрать и обосновать) | `src/core/*`, `specs/*` | `npx tsc --noEmit -p tsconfig.json` |
| D | worker | muse-spark-1.3-contributor | `src/ui/mapStyles.ts` (B1b: `closeFloor·ends·isolated·quiet`, ранговый пол `(0.09+0.13·freqTier)·localK`; подписи: сгладить ступеньки 12/22, LOD-ветка по базовому core, хабы в 0 по экранному радиусу, без таймеров) | `src/core/*`, `specs/*` | `npx tsc --noEmit -p tsconfig.json` |

Правила для всех: русский UI не трогать; инварианты §5 HANDOFF (один depth-бакет, `plateAlpha` с текстом, LOD-альфа одна функция); preflight-фрагмент зелёный до возврата; Two-Strike Stop (2 одинаковых фейла → стоп + 3 буллета).

## Волна 2 (после мержа Wave 1, последовательно)

1. E: `src/core/style-math.ts` (вынос чистой математики стилей) + property-тесты (непрерывность `ratio=1`, golden обзора `r≥1`, `plateAlpha≤labelAlpha`, монотонность `fanCoreFrac`) + метрики (`rho_intra`, overlap без внутристеблевых пар, медиана ≥5 сидов).
2. F: фикстура мега-хаба (Zipf + служебное слово p≈0.6–0.85, хаб 300+, 85% связей) + проверка связки `MAX_GROUP_SHARE→hashAt→trunkControls`, перф-прогон 2000.

## Волна 3 (кросс-ревью + коммиты)

- A↔D, B↔C: обмен ревью (правильность + соответствие аудиту), reviewer-агенты на диффы.
- 3 коммита по спекам (`git add -p`): sizes / edges+fan / labels+cross; фиксы B1a/B1b/B3 внутри своих спеков. После каждого — preflight.
- Доки: errata в `2026-11-14-audit-open-questions.md` (пины fanCoreFrac, shot-shape tracked, NUL отсутствует, guard nextId, уровни кеша, порядок footprint), CONVENTIONS +1 строка про стенд, убрать «не в репозитории».

## Не делать (осознанно отложено)

tanh-хвосты · весозависимый `minDist` · β-сплайн 5 точек · `·base²` · `SelectSpec`-рефакторинг · слайдер времени · `state.yaml`.
