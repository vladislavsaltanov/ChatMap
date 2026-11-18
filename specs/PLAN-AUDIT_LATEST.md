# Аудит плана — ChatMap Perf Pass A
**Date:** 2026-11-10 · **Verdict:** READY

## Principles Alignment
| Проверка | Статус | Замечание |
| --- | --- | --- |
| Вертикальные срезы | ⚠️ | 8 микро-оптимизаций, без пользовательского среза |
| Границы скоупа | ✅ | `In scope` / `Out of scope` зафиксированы |
| Критерии успеха | ✅ | Baseline, p50, порог 5%, вердикт |
| HARD GATE | ✅ | B/C только после воспроизводимого замера |
| Язык домена | ✅ | Термины устойчивы в specs/ и коде |

## Conventions Completeness
| Проверка | Статус | Замечание |
| --- | --- | --- |
| AGENTS / CLAUDE / CONVENTIONS | ✅ | Присутствуют |
| `specs/` | ✅ | Есть; `state.yaml` отсутствует, принято |
| Conventional Commits | ✅ | `CONVENTIONS.md` |
| Git-режим | ✅ | solo-git, `main` защищён |
| CI | ⚠️ | `.github/workflows` нет; принято как локальный гейт |
| lint | ⚠️ | lint-скрипта нет; принято как локальный Preflight |

## Pre-flight Answers
| Поле | Значение |
| --- | --- |
| test | `npm run test` |
| build | `npm run build` |
| typecheck | `npm run typecheck` |
| lint | отсутствует, принято |
| CI | отсутствует, принято |
| solo / team | solo |
| язык / стек | vanilla TS, Vite, Vitest 5, Sigma 4, graphology |
| кодовая база | существующая |

## Open Gaps
- [ ] Блокирующих пробелов нет.
- [ ] Принятые отклонения: нет регресс-теста на `positionsCache.clear()`; компенсация — ручной open→open.
- [ ] Принятые отклонения: нет lint/CI/`state.yaml`; гейт — локальный Preflight.
- [ ] Работы плана, а не пробелы аудита: шаг 0 baseline, шаг 8, шаг 9 вердикт.

## Новые находки при доаудите
- `PipelineCache` однослотовый: переключение фильтров пересчитывает tally/merge; кандидат B.
- `Intern.nextId` не ограничен, `KEY_BASE = 2**24` не защищён от >16 777 215 ID.
- `graph.ts:591` устарел: `tests/graph.test.ts:493` уже содержит 600 узлов.
- `tests/tally.test.ts:268` дублирует `dropFor`; `filters.test.ts` его не покрывает.
- Сортировки остаются в `worker.ts`, `graph.ts`, `select.ts`, `geometry.ts`.
- `armsFromIndex`: `O(N + Σ d·log d)`, а не `O(N+E)`.
- `matchesMatCustom` / `isMatAllowlisted` линейны; шаг 6 частичен.
- Ошибка `parse()` в `open` оставляет старые кеши и `chat`; отдельный дефект.

## Verdict
READY — план актуализирован; далее `survey-context` или `execute-plan` по шагу 0.
