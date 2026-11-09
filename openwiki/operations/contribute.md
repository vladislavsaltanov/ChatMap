---
type: operations
title: Разработка, тесты и регламент
description: Команды preflight, тесты только ядра на vitest, фикстуры и правила коммитов.
tags: [contributing, testing, vitest, workflow]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-09T15:02:00.342Z
sources:
  - id: openwiki-source-4836932a35eecac763c0633e
    resource: repo://CONVENTIONS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-f497d8a99f78eab8edc255b1
    resource: repo://tests/fixtures/sample-export.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "pi", at: "2026-11-09T15:02:00.342Z" }
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
UI и sigma проверяются вручную по критериям этапов.

Покрыты: парсинг, токенизация, канонизация, фильтры,
подсчёт связей, выборка, геометрия, legend, escapeHtml,
smart-merge, debounce, labelOverrides.

Реальный чат в репозиторий не коммитится.
Тестовые данные — только синтетическая фикстура
`tests/fixtures/sample-export.json`.

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
