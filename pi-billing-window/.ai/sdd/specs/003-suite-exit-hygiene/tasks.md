# Tasks: Гигиена завершения тест-процессов (003-suite-exit-hygiene)

> Status: Approved (владелец: автономный режим)
> Спека: `.ai/sdd/specs/003-suite-exit-hygiene/` (requirements.md, design.md)

## T01 — Мета-сьют exit-hygiene (RED) — P0 · 40m
- [x] `tests/exit-hygiene.test.mts` по design D-303: unit-часть (старт ticker/statusUpdater,
  `hasRefForTests() === false`, стоп) + e2e-часть (спавн 8 сьютов, exit 0, таймаут 90 с).
  - Черновик — субагент deepseek-v4-flash; RED подтверждён владельцем: `FATAL: TypeError: ticker.hasRefForTests is not a function`.
  - Исправлен баг черновика: сьют `test` лежит в `tests/test.mts` (не `test.test.mts`) — добавлен `suitePath()`.

## T02 — Production fix: unref + probes (GREEN) — P0 · 30m
- [x] `src/ui.ts`: `currentInterval.unref()` после setInterval; экспорт `hasRefForTests()`.
- [x] `src/ticker.ts`: `intervalHandle.unref()` после setInterval; экспорт `hasRefForTests()`.
  - Диагноз поставлен эмпирически (патч unref → replacement exit=0) ДО планирования спеки;
  - лишился заблуждения о «флейке» test.mts: все его exit=1 в циклах регресса — опечатка
  `tests/test.test.mts` в bash-циклах владельца (100% воспроизводится, не флейк).
- Files: `src/ui.ts`, `src/ticker.ts`
- Verify: `npx tsx tests/exit-hygiene.test.mts` — 12 PASS 0 FAIL; `npm run build` — 0 ошибок.
- Dependencies: T01

## T03 — Документация — P1 · 20m
- [x] README §5 (список тестов): + exit-hygiene; упоминание политики unref для всех таймеров.
- [x] `docs/ARCHITECTURE.md`: пункт «гигиена таймеров» в обзоре модулей.
- [x] `.ai/sdd/INDEX.md`: строка 003.
- Verify: grep-проверка упоминаний.
- Dependencies: T02

## T04 — Регресс + deploy + коммит + пуш — P0 · 30m
- [x] Полный прогон 9 сьютов (8 + exit-hygiene) — 426 asserts, 0 FAIL.
- [x] `npm run build` — 0 ошибок; `deploy.ps1`; diff рабочей копии.
- [x] Conventional Commit `fix(pi-billing-window): ...`, push origin.
- Dependencies: T02, T03

## Requirement Coverage

| Requirement | Task IDs |
|---|---|
| FR-001 (сьюты завершаются) | T01, T02, T04 |
| FR-002 (unref паритет) | T02 |
| FR-003 (юнит-контракт) | T01, T02 |
| FR-004 (e2e-регрессия exit) | T01, T04 |
| FR-005 (без регрессии) | T02, T04 |

## Execution Log

| Task | Status | Evidence |
|------|--------|----------|
| T01 | done | черновик субагентом; RED владельцем: `TypeError: ticker.hasRefForTests is not a function` (без синтаксического брака); фикс пути `suitePath()` после спавн-прогона |
| T02 | done | `currentInterval.unref()` (ui.ts) + `intervalHandle.unref()` (ticker.ts) + пробы `hasRefForTests()`; GREEN: exit-hygiene 12/12, replacement exit=0 (было — вечный вис) |
| T03 | done | README (дерево тестов + bullet §8a), docs/ARCHITECTURE.md (пункт unref), INDEX.md — субагентом, проверено владельцем |
| T04 | done | 9 сьютов — 136+66+52+43+14+51+8+44+12 = 426 asserts, 0 FAIL; build 0 ошибок; deploy + push |
