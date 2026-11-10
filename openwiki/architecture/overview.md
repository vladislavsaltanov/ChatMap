---
type: architecture
title: Архитектура системы
description: Разделение worker/main, роль graphology и sigma.js, инвариант строгой локальности данных.
tags: [architecture, worker, sigma, privacy, overview]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-09T15:02:00.342Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-4f90ae4dca4f784d6ebcd414
    resource: repo://src/core/types.ts
  - id: openwiki-source-66d168c422ed87e616074e32
    resource: repo://src/core/worker.ts
  - id: openwiki-source-d4189bbeecb62806cb297b5a
    resource: repo://src/main.ts
  - id: openwiki-source-8837b206dbd5c7ef6a549ee2
    resource: repo://src/ui/mapview.ts
generated: { by: "pi", at: "2026-11-09T15:02:00.342Z" }
---

# Архитектура системы

ChatMap — одна статическая страница: JSON-экспорт Telegram превращается
в карту слов. Узел — слово (размер = частота), ребро — совместная встреча,
цвет — голос участника.

## Граница worker / main

Тяжёлая чистая логика живёт в `src/core/` и целиком выполняется в Web Worker:

- парсинг экспорта, токенизация, канонизация, фильтры, подсчёт связей;
- выборка узлов и рёбер, детерминированная раскладка ForceAtlas2.

Главный поток только рисует и управляет экранами:

- `src/main.ts` — экраны landing / progress / map, протокол с воркером;
- `src/ui/mapview.ts` — построение graphology-графа и рендер Sigma v4 на `<canvas>`;
- `src/ui/controls.ts`, `nodepanel.ts`, `legend.ts` — режимы, фильтры, панель слова.

Протокол воркера задан типами `WorkerIn` / `WorkerOut`:
`open` с текстом JSON, `update` с конфигом фильтров и вида;
назад — `progress`, `ready` (авторы, счётчики), `map` (узлы, рёбра, формы),
а также `warn` и `error`.

## Данные и приватность

Файл читается через `FileReader` в память вкладки и никуда не отправляется:
в коде нет `fetch` и `XMLHttpRequest` с содержимым чата.
Страница работает офлайн и в режиме полёта.
Реальный экспорт никогда не коммитится — только синтетическая фикстура
`tests/fixtures/sample-export.json`.

## Технологический каркас

TypeScript, Vite, graphology + `graphology-layout-forceatlas2`, sigma.js v4.
Стили — каскадные слои `@layer`, custom properties, `oklch()`, тёмная тема.
UI-фреймворков нет, зависимости минимальны.
