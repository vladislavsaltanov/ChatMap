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
- Минимальный код: символ решения документирован в доке (см. ARCHITECTURE.md и specs/).
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
- **Subagents:** `delegate_to_subagents` запрещён навсегда — субагенты запускаются только напрямую через `subagent`. Без `hy4` и сторонних моделей: только текущая модель агента.
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

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Use the repository's documented maintenance process to refresh generated pages after source changes. Check its configuration and completed runs before relying on automatic updates. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
