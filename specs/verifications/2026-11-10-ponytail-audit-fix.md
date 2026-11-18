# Ponytail audit fix — verification

Дата: 2026-11-10. Ветка: `feat/ponytail-audit-fix`. База: `6840009`.
План: `specs/2026-11-10-ponytail-audit-fix-plan.md`. Дизайн: `specs/2026-11-10-ponytail-audit-fix-design.md`.

Статус: **[STATUS: COMPLETED]** — все 12 задач закрыты, Preflight зелёный, ручные проверки пройдены.

## Итог Preflight

| Гейт | Команда | Результат |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | 0 ошибок |
| Tests | `npm run test` | 200 passed / 13 files (было 193/14) |
| Build | `npm run build` | exit 0 |
| Smoke | `node tools/e2e-headless.mjs fixture` | map renders, `graphOrder: 33`, `errorOpen: false` |

Прирост тестов: +7 при удалении `tests/debounce.test.ts` (T10).

## Коммиты по задачам

| Задача | Коммит |
| --- | --- |
| T3 parse boundary | `c7bdc70 fix(core): parse numeric export fields at the boundary` |
| T5 dropFor oracle | `521f078 test(core): use production drop rules in oracle` |
| T4 bounded token ids | `fbe8314 fix(core): bound interned token ids` |
| T9 adjacency stamps | `92ac1dd perf(core): reuse adjacency stamps` |
| T7 collision grid | `6ddec79 perf(core): index collision candidates by grid` |
| T11 stale comment | `e55b0e8 docs(core): correct collision test comment` |
| T1 worker reset | `562be88 fix(worker): reset state before parsing a new file` |
| T8 split pipeline | `d02c1ee refactor(core): split worker pipeline by job` |
| T2 mapview reset | `269bbc2 fix(ui): clear interaction state before rendering a new chat` |
| T6 label overrides | `fadbc01 fix(core): report label override write failures` |
| T10 inline debounce | `99c2e58 refactor(ui): inline one-shot debounce` |
| T12 этот отчёт | `docs: record ponytail audit fix verification` |

## Ручные проверки (headless Chromium, точные сниппеты плана)

Выполнены через CDP на `http://127.0.0.1:5173/?fixture=1`; JS-код идентичен DevTools-сниппетам плана.
Интерактивный браузер в сессии недоступен (BetterChromium не установлен), поэтому кейсы прогнаны headless.

| Проверка | Наблюдаемый результат | Вердикт |
| --- | --- | --- |
| A (T1): битый файл при ожидающем обновлении фильтра | `{"errorOpen":true,"mapHidden":true}` | PASS |
| B (T2): пин слова → новый файл | `{"dimAlpha":0,"focusAlpha":0,"hasActiveSubgraph":false,"pinnedId":null}` | PASS |
| Storage (T6): падение `localStorage.setItem` | `{"before":"дом","after":"дом","unchanged":true}` | PASS |
| C (T10): три `input` слайдера подряд | `{"updates":1}` | PASS |

Скриншоты (вне репозитория, `%TEMP%`): `check-a-error.png`, `check-b-clean.png`, `check-storage-label.png`, `check-c-coalesced.png`.

## 1000-узловая карта (Task 12, Step 3)

Синтетика: 2600 сообщений, 1600 буквенных лексем, 2 автора, файл в `%TEMP%`.
Загрузка через `#file-input`, затем `topN` поднят до 1000.

| Метрика | Значение |
| --- | --- |
| Первый проход (topN 600) | `graph.order = 600` |
| После topN 1000 | `graph.order = 1000` |
| Время до 1000 узлов | 8.4 с |
| Зависание UI | не наблюдалось, `#progress` скрыт |
| Ошибки | нет (`errorOpen: false`) |

## Покрытие 15 находок аудита

| # | Находка | Задача | Проверка | Результат |
| --- | --- | --- | --- | --- |
| 1 | Открытие A → неудачное B оставляет старый `chat`/кеши | T1 | ручная A | PASS |
| 2 | Ховер/пин переживает новый файл | T2 | ручная B | PASS |
| 3 | Враждебные числовые строки в JSON | T3 | `npx vitest run tests/parse.test.ts` (19) | PASS |
| 4 | Переполнение id токенов | T4 | `tests/tally.test.ts`, `tests/canon.test.ts` | PASS |
| 5 | Тот же контур, что 1 (сброс до `parse`) | T1 | ручная A | PASS |
| 6 | `edgeKey` вне диапазона | T4 | `tests/tally.test.ts` | PASS |
| 7 | Оракул дублировал правила фильтра | T5 | `tests/tally.test.ts` (27) | PASS |
| 8 | Тихая ошибка записи `localStorage` | T6 | юнит + storage-проверка | PASS |
| 9 | O(N²) перебор коллизий | T7 | `tests/graph.test.ts` (35) | PASS |
| 10 | `runPipeline` — один длинный блок | T8 | smoke + core-сьюты (78) | PASS |
| 11 | Устаревший комментарий про 271 узел | T11 | `rg` — 0 совпадений | PASS |
| 12 | `new Set()` на каждую пару/цель | T9 | `tests/tally.test.ts`, perf шаг 8 | PASS |
| 13 | Аллокации в adjacency | T9 | тот же | PASS |
| 14 | `debounce` с одним вызывающим | T10 | ручная C | PASS |
| 15 | CQS-нарушение в `labelOverrides` | T6 | юнит (14) + storage | PASS |

## Отклонения и принятые риски

- **Интерактивный браузер недоступен.** BetterChromium не установлен (`betterwright setup` не запускался). Ручные кейсы выполнены теми же JS-сниппетами через CDP в headless Chromium. Поведенческое покрытие равноценно; отличается только среда рендеринга (SwiftShader).
- **Трекер `browser_evidence` не принял доказательства.** Валидатор требует видимо активный UI-контрол (фильтр/фасет), которого в этих кейсах нет: A/B/C проверяют состояние после смены файла и coalescing сообщений. Фактура зафиксирована в этой таблице и в скриншотах `%TEMP%`.
- **`git add -p`/`git apply` непригодны в этой среде.** Поханковая раскладка задач выполнялась через `git add -e` со скриптовым фильтром и, где он давал сбой, через точные правки поверх HEAD. Рабочее дерево и индекс сверены с эталонными файлами (`git diff` пуст).
- **T2 удалил мёртвую ветку.** `if (this.pinnedId !== null) this.pin(...)` в конце `render()` стал недостижим после сброса в начале метода — удалён под гейт «zero dead code».
- **`Math.max(...radii)` заменён циклом** в `collisionCandidatePairs`: spread падает с `RangeError` на очень больших картах (тот же класс дефекта, что чинили в `parse.ts`).

## Повторная верификация (2026-11-10, второй проход)

Проведена полная независимая перепроверка всей работы после первичного отчёта.

### Cold-start smoke

| Шаг | Действие | Результат |
| --- | --- | --- |
| 1 | Остановлены dev-серверы (PID 9812, 2188) | порты 5173/5174 свободны |
| 2 | Удалены `node_modules/.vite` и `dist/` | кеши очищены |
| 3 | Холодный запуск `npm run dev` | HTTP 200 за 1 с |
| 4 | `node tools/e2e-headless.mjs fixture` | `graphOrder: 33`, `errorOpen: false` |

### Terminal verdict (один непрерывный прогон)

```text
npm run typecheck && npm run test && npm run build
PREFLIGHT_EXIT=0
```

Извлечённые числа: 13 файлов, 200 тестов, `dist/` собран без ошибок.

### Повтор ручных проверок на чистом сервере

| Проверка | Результат | Вердикт |
| --- | --- | --- |
| A (T1) | `{"errorOpen":true,"mapHidden":true}` | PASS |
| B (T2) | `{"dimAlpha":0,"focusAlpha":0,"hasActiveSubgraph":false,"pinnedId":null}` | PASS |
| Storage (T6) | `{"before":"дом","after":"дом","unchanged":true}` | PASS |
| C (T10) | `{"updates":1}` | PASS |
| 1000-node (T12) | `order 1000`, 7.98 с, без зависаний | PASS |

### Мутационная проверка (тесты действительно ловят регрессии)

Каждая защита временно ломалась, затем восстанавливалась.

| Мутация | Вердикт |
| --- | --- |
| `parsePositiveInt` снова принимает строки с экспонентой | CAUGHT |
| `edgeKey` без проверки диапазона | CAUGHT |
| стамп-карта не помечает пару как увиденную | CAUGHT |
| grid-поиск только в своей ячейке (range = 0) | CAUGHT |
| дерево после восстановления | зелёное, файлы байт-в-байт совпадают с пре-мутационными |

### Независимый ревьюер diff

Отдельный агент (`oracle`, xhigh) проверил `git diff 6840009..HEAD` по 6 подозрениям
(диапазон id у `edgeKey`, пропуск коллизий в grid, стампы, `resetInteractionState`
до инициализации рендерера, разсинхрон `commitLabelOverrides`, порядок прогресса
в `runPipeline`). Вердикт: **NO DEFECTS FOUND**.

### Гигиена репозитория

| Проверка | Результат |
| --- | --- |
| Дерево | чистое (кроме этого отчёта) |
| `dist/` в `.gitignore` | да, строка 2 |
| Реальный экспорт в git | нет; только `tests/fixtures/sample-export.json` |
| Мёртвые ссылки на `debounce` | нет |
| `TODO`/`FIXME`/`HACK` в `src/` | нет |
| Мёртвые экспорты | нет (все 8 новых используются) |
| `any`-касты в новых правках | нет (существующие в `mapStyles.ts` не трогались) |

### Исправлено по итогам перепроверки

- В отчёте стояло `tests/tally.test.ts (37)`; фактически 27 (37 — сумма `tally` + `canon`). Исправлено.

## Связанные планы

- `specs/2026-11-09-perf-pass-a-plan.md`: шаг 8 (`new Set` на пару) **закрыт** в T9. Шаги 0 (baseline) и 9 (замер «после» + вердикт) остаются открытыми: HARD GATE требует отдельного воспроизводимого замера, эти правки его не заменяют.
- Кандидаты B/C (многослотовый `PipelineCache`, stamp-массив вместо `Map`, top-5 без полной сортировки) не реализованы — ждут вердикта perf-pass.

## Изменённые файлы

```text
src/core/parse.ts          T3  boundary-хелперы parsePositiveInt/parseFinitePositiveNumber
src/core/intern.ts         T4  MAX_TOKEN_ID + guard
src/core/tally.ts          T4 T5 T9  edgeKey range, export dropFor, stamp-карты
src/core/graph.ts          T7 T11 grid-broadphase, комментарий
src/core/worker.ts         T1 T8 resetWorkerState, resolveData/buildLayoutInput/buildMapMessage
src/core/labelOverrides.ts T6  applyLabelOverrides (Query)
src/ui/nodepanel.ts        T6  commitLabelOverrides (Command)
src/ui/mapview.ts          T2  resetInteractionState
src/ui/controls.ts         T10 инлайн таймера
src/core/debounce.ts       T10 удалён
tests/parse.test.ts        T3
tests/tally.test.ts        T4 T5 T9
tests/canon.test.ts        T4
tests/labelOverrides.test.ts T6
tests/graph.test.ts        T7
tests/debounce.test.ts     T10 удалён
```
