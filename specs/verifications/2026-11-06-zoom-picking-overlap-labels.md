# Верификация 2026-11-06 — зум / выбор / перекрытия / подписи

Спецификация: `specs/bugs/2026-11-06-zoom-picking-overlap-labels.md`.
Метод: Vite `?fixture=1` + headless Chrome (CDP), синтетическая фикстура, 33 узла.

## Preflight
| Гейт | До | После |
|---|---|---|
| `npm run typecheck` | КРАСНЫЙ (4 ошибки) | зелёный |
| `npm run test` | не запускался | 134 / 134 |
| `npm run build` | не запускался | зелёный |

Найденные по пути дефекты (красный гейт + крэш) устранены в том же наборе правок:
несуществующий `Sigma#setStyles`, `labelMargin` в Settings, `margin` в `downloadAsPNG`,
`node.color` вне `WorkerNode`, дженерик `downloadAsPNG`.

## Измерения (528 пар узлов)
| ratio камеры | квад-пересечения (до → после) | ядро-пересечения (до → после) | радиус квада хаба |
|---|---|---|---|
| 1.00 | 141 → 2 | 67 → 0 | 116 → 48 px |
| 1.50 | 226 → 2 | 128 → 0 | 106 → 32 px |
| 2.25 | 297 → 2 | 221 → 0 | 98 → 21 px |
| 3.375 | 381 → 2 | 313 → 0 | 98 → 14 px |
| 0.667 (зум-ин) | 106 → 0 | 55 → 0 | 142 → 59 px |

`zoomToSizeRatioFunction`: до `min(sqrt(r), 1)` (при отдалении = 1, ноды не уменьшались),
после `r` при `r >= 1` и `sqrt(r)` при `r < 1`. Экранный радиус хаба при отдалении падает
116 → 48 → 32 → 21 → 14 px, т.е. большие ноды больше не растут и не создают новых пересечений.

## Взаимодействие (CDP mouse/key)
- hover крупной ноды: `.hover-line` = `альфа · 30`, `subgraphKey = 17`, `isHovered = true`.
- click: `pinnedId = 17`, `.nodepanel` открыта.
- hover/click малой ноды (5 px) при зуме 0.44: `привет · 1`, `pinnedId = 1`, панель открыта.
- `Escape` и клик по пустому полю снимают пин.
- `Runtime.exceptionThrown`: 0 (до правок — `this.renderer.setStyles is not a function`).

## Подписи
- `primitives.nodes.label.margin = 2`, `zoomToLabelSizeRatioFunction = zoomSizeRatio`
  (подтверждено через `getPrimitives()` в браузере).
- Гало до 44 px → 3..10 px: квад больше не отодвигает `right`-подпись от точки.
- Скриншоты: `tight` подписи вплотную к малым точкам, у хабов текст по центру,
  при отдалении подписи плавно гаснут, а не слипаются в кучу.

## Файлы
`src/core/geometry.ts`, `src/ui/mapStyles.ts`, `src/ui/neural.ts`, `src/ui/mapview.ts`,
`tests/geometry.test.ts`, `specs/bugs/...`, `specs/verifications/...`.
Коммит не создавался: в рабочем дереве уже были незакоммиченные правки пользователя.
