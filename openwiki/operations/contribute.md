---
type: operations
title: Разработка, тесты и регламент
description: Команды preflight, тесты только ядра на vitest, стенд с фиксированным сидом и правила коммитов.
tags: [contributing, testing, vitest, workflow]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-15T11:24:14.683Z
sources:
  - id: openwiki-source-4836932a35eecac763c0633e
    resource: repo://CONVENTIONS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-b5b2c30da3a1fd58a31c0d9d
    resource: repo://tests/blob.test.ts
  - id: openwiki-source-f497d8a99f78eab8edc255b1
    resource: repo://tests/fixtures/sample-export.json
  - id: openwiki-source-77418010b0828f69e241e63b
    resource: repo://tests/graph.test.ts
  - id: openwiki-source-5554805a2767312e63dfdebc
    resource: repo://tests/spread.test.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "pi", at: "2026-11-15T11:24:14.683Z" }
---

# Разработка, тесты и регламент

## Команды

- `npm run dev` — локальный запуск;
- `npm run test` — тесты (vitest);
- `npm run typecheck` — проверка типов (`tsc --noEmit`);
- `npm run build` — сборка (Vite, цель `es2023`).

Preflight перед следующим шагом: `typecheck && test && build`.
Красный гейт не игнорируется и не списывается на «пре-эксистинг».

## Тесты: только ядро

Тестируется только чистая логика `src/core/` через vitest.
UI и sigma проверяются вручную по критериям этапов и стендом.

Покрыты: парсинг, токенизация, канонизация, фильтры,
подсчёт связей, выборка (включая срезку слов без связей),
геометрия, чистая математика стилей (`style-math`),
поле fBm-силуэта (`blob`), гейты раскладки (`graph`, `spread`,
включая golden-хеш и mass-weighted отклик),
`legend`, `escapeHtml`, smart-merge, debounce, `labelOverrides`.
Бюджет S9 (раскладка 1000 узлов быстрее 400 мс) меряется
прогревом и медианой из 3 — одиночный замер на shared-раннере флапает.

Реальный чат в репозиторий не коммитится.
Тестовые данные — только синтетические фикстуры
(`sample-export.json`, генератор мега-хаба).

## Стенд

`tools/shot-shape.mjs` строит синтетический чат, прогоняет его через
реальный файловый ввод и снимает скриншоты с метриками формы.
`?seed=` в URL фиксирует сид раскладки: повтор того же сида даёт
те же метрики (детерминизм end-to-end), разные сиды — разные фигуры.

## Дефекты по пути

Баг, найденный по пути, чинится отдельным коммитом и не смешивается с фичей.
Лестница: `quick-fix` (тривиальный дата-фикс) → `fix-bug` / `investigate-bug`
(нужна TDD) → если чинить нельзя, запись в `specs/bugs/registry.yaml`
отдельным коммитом.

## Гит

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
Ветка этапа, мерж после зелёного Preflight.

## Документация

Решения фиксируются в `HANDOFF.md` и `specs/`:
вердикты — в `specs/verifications/`, ADR — в `specs/adr/`.
