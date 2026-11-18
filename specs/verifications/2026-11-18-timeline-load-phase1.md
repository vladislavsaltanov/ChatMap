# Верификация: фаза 1 — таймлайн + оптимизация загрузки

Дата: 2026-11-18. Ветка: `feat/timeline-load`.
План: `specs/2026-11-18-timeline-load-impl-plan.md` (Tasks 1-5, сплит 4a/4b — `e1f554c`).
Дизайн: `specs/2026-11-18-timeline-and-load-design.md` (утверждён владельцем).
Базис-замер: `specs/archive/spikes/SPIKE-load-pipeline-bench.md`.

## Цель против результата

| Метрика | Цель (план) | Базлайн (спайк) | Фаза 1 (замер) |
|---|---|---|---|
| Open-конвейер, 23.1 МБ / 58k сообщ. | ≈ 1–1.5 с | 3.7 с | **1.33 с (2.8×)** |
| Куча open-пути | ≤ 400 МБ | 856 МБ после resolve (1.4 ГБ к концу) | **115 МБ после resolve; дельта pass-2 110 МБ** |
| Гейт памяти (Task 5) | < 500 МБ | — | **пройден, запас 4.5×** |
| Материализуемые пары | радикально меньше | 1 912 336 | **88 992 (21×)** |
| Эквивалентность оракулу | property-гейт | — | **зелёный на матрице default / mat:true / customMat / smartMerge:true** |

## Стадии open-пути (реальный экспорт, Node 22, тот же V8, что в воркере)

| Стадия | Было (спайк) | Стало |
|---|---|---|
| decode + JSON.parse + parse() | 137 мс / 123 мс | 14 / 93 / 119 мс |
| resolve: tokenize + addUnits + countByBuckets | 225 мс (tokenize) + 3182 мс (tally) | **733 мс** (229 tokenize + 504 счёт) |
| countsUpTo / topIds / memberPreimage | — | 9 / 18 / 1 мс |
| Pass-2 tally (ограниченный скан) | 2998 мс (полный) | **343 мс** |
| select top-600 | 189 мс | 72 мс |

Контрольные прогоны оракула в замере сохранены для A/B (полный скан 3506 мс,
1 912 336 пар) — они не входят в продакшн-путь и живут только в gitignored бенче.

## Метод и ограничивающие допущения

- Инструмент: `tests/bench-tmp-load.test.ts` (gitignored, env-gated
  `CHATMAP_BENCH_FILE`, `--disableConsoleIntercept`), тождественен
  `worker.runPipeline` после Task 3 (проверено по диффам 4b).
- Одна машина, один прогон на стадию; wall-clock цифры — ориентир, гейт — память.
- Куча замерена с живым оракулом рядом (дельта 110 МБ включает его GC-шум);
  чистое состояние продакшн-пути после resolve — 115 МБ кучи.
- Слайсы: `buildSlice` на пин-раскладке (Task 4a) покрыт 7 юнит-тестами,
  включая бюджет `footprintScale` вселенной и clamping курсора; property-гейт
  `tests/slice-equiv.test.ts` держит равенство новой цепочки и оракула.

## Коммиты фазы

```
86a01cb feat(core): calendar buckets for timeline slices
e2caa2d feat(core): bucketed pass-1 counts in the open path
1bc2e16 feat(core): tally scan opts - membership mask and time cutoff
11a2ef2 feat(core): pure slice builder over pinned layout
804e2c5 feat(core): worker serves timeline slices
```

Полный preflight на финальном состоянии: tsc 0 ошибок, 334 passed / 2 skipped, build ок.

## Не покрыто (осознанно)

- Ручная браузерная проверка UI ленты — фаза 2 (Tasks 6-8), ядро UI-независимо.
- Perf-гейт S9 (раскладка 1000 узлов) не входил в скоуп и не менялся.
- Режим «окно за N месяцев» и объединение топов по бакетам — фаза 3 дизайна.
