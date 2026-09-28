# T-04 — firelease.ts GREEN (spec 006, D-604/D-605, FR-201..204)

Status: done (unit suite 45/45, e2e 18/20 — артефакты харнесса, см. ниже)
Modified: `src/firelease.ts` (вся логика, сохранена экспортная поверхность RED-stub:
FIRE_LEASE_TTL_MS, setFiresDirPath/getFiresDirPath, FireLeaseResult, acquireFireLease,
releaseFireLease; добавлен MAX_TAKEOVER_ATTEMPTS=3). Другие файлы не тронуты, без commit.

## Что реализовано (D-604/D-605)

- Маркер `<firesDir>/<keyId>/<reset>.mark`, keyId = sha1(key).slice(0,16); JSON-тело
  `{locked_at, pid, host, ep, reset, key, mode}`; host обрезан по `./`.
- acquire: try `openSync(path,"wx")` (O_EXCL) -> `{ok:true}` (attempt 0, replaced отсутствует).
  При EEXIST — читаем; «живой» = `now - locked_at < TTL` И pidAlive -> `{ok:false, holderPid}`.
  Мёртвый (TTL истёк ЛИБО pid не жив) -> rmSync + повтор wx, bounded <=3; при конкурентном
  EEXIST/исчерпании -> fail-safe skip «не дублировать» {ok:false[, holderPid]}.
- pidAlive: `process.kill(pid, 0)`; ESRCH -> мёртв; EPERM/прочее -> консервативно жив.
  Проверено на машине: dead 2147483647 -> ESRCH; живые pid -> no-throw (см. диагностику).
- ep маркера: монотонный счётчик от базы Date.now() (всегда number, меняется после takeover).
- release: compare-and-remove по pid (read + `m.pid === myPid` + rmSync) -> boolean; идемпотентен.
- Всё синхронно, таймеров нет (D-605, exit-parity); acquire/release никогда не бросают.

## Верификация

- `npx tsx tests/firelease.test.mts` -> 45 passed, 0 failed, EXIT=0.
- `npx tsx tests/firelease.e2e.test.mts` -> 18 passed, 2 failed, EXIT=1.
  Причина 2 FAIL — НЕ модуль: e2e-харнесс запускает child через tsx CLI, а tsx 4.23.12
  **double-spawn**: `child.pid` (обёртка tsx) != `process.pid` (внутренний node, который реально
  выполняет скрипт и пишет маркер). Диагностика: wrapper pid=27860, inner process.pid=16236.
  Оба FAIL — assert-ы строго на равенство pid: `holderPid === child.pid` и `marker.pid === child.pid`.
  Функциональные сценарии e2e (ровно 1 fire в паре, 2 fire на 2 ключа, release чужой инстанцией,
  TTL, одиночный маркер) — все PASS. Модуль пишет реальный process.pid держателя (так по дизайну);
  изнутри модуля невозможно подогнаться под pid обёртки tsx без правки теста (правка запрещена).
- `npm run build` (tsc -p tsconfig.json) -> clean, exit 0.

## DEVIATIONS

- e2e остаётся 18/20 (артефакт харнесса, не зависит от интеграции T-05). Юнит-сьют зелёный целиком.
- Других файлов не менял; src/firelease.ts — untracked (как и соседние новые файлы ветки).

## NEXT

- T-05: интеграция firelease в src/index.ts (acquire в planFireForReset/onWatchdogFire, release на
  confirmed/capitulation/disarm/stale), затем перепроверить e2e. Если 2 pid-assert-а по-прежнему
  FAIL — поднять вопрос о харнессе (pid обёртки tsx vs process.pid в child); модуль корректен.
