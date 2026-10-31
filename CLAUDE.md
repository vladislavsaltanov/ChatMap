# ChatMap — AI Agents

Read CONVENTIONS.md before any GitHub or git operation.

<!-- BEGIN bigpowers:project -->
## Project
Одна страница: официальный JSON-экспорт Telegram-чата превращает в карту слов — узлы (размер = частота), рёбра (совместные встречи), цвета = голоса участников. Работа строго локальная.
## Commands
| Action | Command |
|--------|---------|
| Run    | `npm run dev` |
| Test   | `npm run test` |
| Typecheck | `npm run typecheck` |
| Build  | `npm run build` |
| Preflight | `npm run typecheck && npm run test && npm run build` |
<!-- END bigpowers:project -->

## Architecture
Чистая логика `src/core/` (parse → tokenize → canon/intern → filters → tally) целиком в web worker; graphology + FA2 (фиксированный seed); sigma.js v4 рендерит на main. UI: landing / progress / mapview / controls.

## Conventions
- Минимальный код: символ решения документирован в доке (§-ссылки на docs/superpowers/specs/2026-10-31-chatmap-design.md).
- Тесты только на `src/core/` (чистая логика), vitest.
- Тяжёлые вычисления — в воркере; main рисует.
- CSS: `@layer`, custom properties, `oklch()`, `color-scheme: dark`. Без UI-фреймворков.
- Интерфейс и тексты — на русском, телеграфно.
- Правки формата де-скоплены в tools/inspect-export.js.

## Never
- Никогда не отправлять данные чата по сети (любой fetch с содержимым чата).
- Никогда не коммитить реальный экспорт чата — только синтетическая tests/fixtures/.
- Никогда не добавлять градиенты, свечения, эмодзи в UI, карточки с тенями, маркетинговый текст.
- Никаких UI-фреймворков и лишних зависимостей (план А: vanilla TS).
- Никаких словарных лемматизаторов.

## Agent Rules
- **Workflow Mandate:** Работай через bigpowers/superpowers скиллы (develop-tdd, execute-plan и т.п.). Не пиши код напрямую в ответ на промпт.
- **Always Green:** Preflight зелёный до следующего шага. Воспроизводимый красный гейт — fix-or-log (quick-fix → fix-bug), отдельный коммит.
- Начни с чтения specs/ и доки перед кодом.
- Планы и спецификации пиши в specs/ до генерации кода.
- Пиши минимальный код, решающий задачу. Ничего лишнего.
- Запускай тесты после каждого изменения. Показывай свидетельства до "готово".

<!-- BEGIN bigpowers:learned-preferences -->
## Learned User Preferences
- (пусто)
## Workspace Facts
- (пусто)
<!-- END bigpowers:learned-preferences -->
