# Вердикт 2026-11-08 (12) — «Созвездие», плотная версия

План: `specs/2026-11-08-bold-constellation.md`.
Метод: `playwright-cli` (Chrome 1440×900, `?fixture=1`, плотная синтетическая
карта 271 узел / 535 рёбер, 3×-кроп ноды), плюс
`tools/shot-edges.mjs bold-check check`. Реальный экспорт не использовался.

## Preflight
| Гейт | Результат |
|---|---|
| `npm run typecheck` | 0 ошибок |
| `npm run test` | **156 / 156** (13 файлов) |
| `npm run build` | зелёный, 42 модуля |
| `node -c tools/shot-edges.mjs` | синтаксис OK |
| Ошибки консоли / GLSL | **0** на всех прогонах |
| `liquidMotion` | `changed: true` |

## 1. Замеры (было → стало)
| Метрика | Раунд 11 | Раунд 12 |
|---|---|---|
| Кегль подписи | 11.5 px / 500 | **13.5 px / 600** |
| Полуширина нити min / p50 / max | 0.273 / 1.663 / 1.71 px | **0.602 / 1.876 / 1.92 px** |
| Полная ширина нити фон / магистраль | 0.94 / 3.42 px | **1.54 / 3.84 px** |
| α рёбер p50 на обзоре | 0.081 | **0.144** |
| Показано подписей r1 / r2 / r3.4 / 0.32 | 32 / 27 / 15 / 8 | 30 / 27 / 13 / 8 |
| Фото узла | 184 994 B | **239 743 B**, 1352×689 |

## 2. Критерии приёмки
| Критерий | Результат |
|---|---|
| Один язык узлов, переключатель удалён | да: `skinBead/Frame/Gauge`, `u_skin`, `NODE_SKINS`, `?node=` убраны |
| Все штрихи плотнее | да: `bold-ratio1.png`, `bold-crop.png`, `bold-dense.png` vs `skin-star-*` |
| Обводка орбиты появилась | да: сплошное кольцо 2.2 px под бусинами |
| Звезда, тики, выноска, ретикл толще | да: 2.6 / 1.6 / 1.6 / 2.0 px |
| Соединительные нити толще | да: 1.54 px фон (+64 %), 3.84 px магистраль (+12 %) |
| Плотная карта без спагетти | да: `bold-dense.png`, LOD spine/skeleton сохранены |
| Рёбра не просвечивают | да: маска `α = 1` сохранена |
| LOD / подписи | кегль 13.5 px на r1/r2/r3.4/rin, `shown` 30 → 27 → 13 → 8 |
| Hover / pin / Escape / фото | `dim 1, focus 1, active 3`; `panel true`; `photo 239 743 B`; `escape pin false` |
| Исключения | `errors: []` |

## 3. Снимки
- До: `tests/betterwright/skin-star-ratio1.png`, `skin-star-dense.png`,
  `skin-star-crop.png`.
- После: `tests/betterwright/bold-ratio1.png`, `bold-dense.png`,
  `bold-crop.png`, `bold-closeup.png`, `bold-hover.png`.
- Регрессия: `tests/betterwright/bold-check-*`.

## 4. Файлы
Изменены: `src/ui/neural.ts`, `src/ui/mapStyles.ts`, `src/ui/mapview.ts`,
`src/ui/controls.ts`, `src/main.ts`, `src/styles/tokens.css`,
`src/styles/base.css`, `src/styles/map.css`, `tools/shot-edges.mjs`.
Ядро, типы и тесты не тронуты.
Коммит не создавался: рабочее дерево содержит незакоммиченные правки пользователя.
