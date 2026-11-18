# Полировка UI: панели и легенда, обрезано — план

[STATUS: COMPLETED — код] · Preflight зелёный · визуал за человеком (dev :5174 + фикстура)

## Скоуп (из ответов пользователя)
- Экран: панели и легенда. Симптом: обрезано / не доходит. Данные: фикстура.
- Браузера-автомата в песочнице нет (BetterChromium не установлен) — визуал проверяет человек на `npm run dev` + `tests/fixtures/sample-export.json`.

## Найдено чтением кода (без браузера)
1. `.map-controls` (`bottom: 48px; right: 24px; z-index: 10`) уходит ПОД `.nodepanel` (`z-index: 20`, ширина 280, `right: 16`) — кнопки зума/PNG недоступны при открытой панели.
2. `.plate span` (колонтитул, `white-space: nowrap`, без `max-width`) — на узких вылезает за канвас; при открытой панели перекрыт ею.
3. `.check-label`: `gap: 4px` (наследуется от общего правила) — чекбокс прилипает к тексту.
4. Лендинг без мобильного правила: `section padding: 32px` + `.dropzone padding: 44px 32px` — на 360px всё зажато.
5. `.hover-line`: длинное слово переносит строку → прыгает высота второй строки грида. Нужны `nowrap + ellipsis`.

## Шаги (все — CSS, JS не трогаем)
- [x] Step 1 — `src/styles/map.css`: при открытом `.nodepanel` сдвигать `.map-controls` левее панели (`:has`, только `min-width: 720px`).
- [x] Step 2 — УБРАН ЦЕЛИКОМ по просьбе: `span` колонтитула выпилен из `mapview.ts` и CSS, вместо ellipsis/скрытия.
- [x] Step 6 — `.map-controls bottom: 48px → 54px`: воздух от канваса = 8px, как справа.
- [x] Step 3 — `src/styles/map.css`: `.check-label { gap: 8px; }`.
- [x] Step 4 — `src/styles/base.css`: `@media (max-width: 719px)` — `section padding: 24px 16px`, `.dropzone padding: 32px 20px`.
- [x] Step 5 — `src/styles/map.css`: `.hover-line` — `nowrap + ellipsis`.
- [x] Step 7 — `.plate inset: 10px → 20px` (больше воздуха от краёв); stale-упоминание колонтитула из коммента убрано.
- [x] Step 8 — `.drawer top/left: 16px → 24px`: воздух от канваса как у кнопок (8px).
- [x] Step 9 — портретный блок: `index.html` + `base.css`, `@media (max-aspect-ratio: 1/1)` прячет `main`, кажет заглушку.

## Верификация
- `npm run typecheck && npm run test && npm run build` (preflight по CONVENTIONS).
- Ручная (человек): dev `:5174` → загрузить фикстуру → панель слова открыть → контролы видны; 360px — без горизонтального скролла; hover-строка в одну линию.
- Реестр `specs/bugs/registry.yaml` не заводим: quick-fix чинится на месте, не откладывается.

## Вне скоупа
- Легенда-canvas (`legend.ts`, BOTTOM/MAX_WIDTH) — геометрия внутри `.canvas`, с flow-сеткой не конфликтует.
- «Где-то ещё» — жду следующий конкретный симптом или скриншот.
