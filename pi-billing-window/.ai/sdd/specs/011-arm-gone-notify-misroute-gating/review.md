# Spec 011 — review

## Дата / вердикт

- 2026-10-06. **Merge readiness: GO** (деплой — по явному подтверждению
  пользователя, вне ревью).

## Coverage (requirements → реализация → evidence)

| Req | Реализация | Evidence |
|---|---|---|
| FR-011-1 arm-gone notify | index.ts:1047–1121 (снимок `lastArmSeen`, reason ttl-expired/repeat-exhausted, sendNotify `billing:cont-after-reset-arm-gone`); notifier.ts:32–39 (union) | tests/arm-gone-notify.test.mts кейсы ttl-expired / repeat-exhausted / no-dup |
| FR-011-2 switch-gating | index.ts fireContinue ~1530–1644: `switched`-флаг, `fire:switch-blocked` + `return` без отправки, fall-through удалён | session-isolation Rv-B: «продолжи» НЕ отправлена + `fire:switch-blocked` |
| FR-011-3 confirmed-budget | index.ts:2372–2392 (`remaining = armsGetArm()?.repeat ?? 0`, notify `billing:cont-after-reset-confirmed`) | arm-gone-notify C1 (осталось 2), C2 (исчерпаны) |
| FR-011-4 дедуп | `selfArmGoneKind` маркеры: off (:2781), capitulation (:1322), confirmed-exhausted (:2377) | кейсы off-без-notify, капитуляция-без-дубля, C2 дедуп |
| FR-011-5 housekeeping | INDEX.md (001–011, синхронизирован с .status), .status 004–010 = implementation:done | `for d in .ai/sdd/specs/0*/` — все валидны |
| TD-011-3 instant retry | index.ts ~1599–1630: один мгновенный `trySwitchToOwner` после `switch-revive:cmd` | Rv-A: `fire:switch-retry-ok`, доставка в том же раунде; Rv-A2 совместим (switchCalls=1) |
| TD-011-6 бейзлайн | state.ts (пред-создание маркер-файла лока), arms.ts/history.ts (тесный бюджет ретраев) | 8 из 14 сьютов были FATAL до фикса — см. Findings |

## Verification evidence (T5)

```
Command: bash scripts/run_all_suites.sh
Exit code: 0
Summary: 15/15 сьютов exit 0 — arm-gone-notify 42/0, arms 90/0, attribution 35/0,
  delivery-gating 0 fail, exit-hygiene 18/0, firelease.e2e 20/0, firelease 45/0,
  history 52/0, lifecycle 53/0, pending-window-retry 14/0, replacement 34/0,
  session-isolation 68/0, stale-capitulation 69/0, watchdog.e2e 58/0, watchdog 14/0
Verdict: PASS

Command: python tests/billing_report_test.py
Exit code: 0
Summary: passed: 32, failed: 0
Verdict: PASS
```

Известная хрупкость (не блокер): первый прогон сьюта после правок src/
(холодный tsx-кеш) может флакать на timing-ассертах — гейт считается по
повторному (тёплому) прогону; воспроизводимо и до спеки 011.

## Findings

1. **[pre-existing, fixed] state.ts withLock ENOENT-регрессия** — proper-lockfile
   realpath'ит путь лока ДО взятия; фикс ec9c495/e5cda97 убрал пред-создание
   маркер-файла → 8 сьютов FATAL. Возвращено по образцу arms/history; NOTE-коммент
   в state.ts был фактически неверен (лок-КАТАЛОГ — `<lock>.lock`, маркер-файл
   с ним не конфликтует).
2. **[pre-existing, fixed] arms/history `retries: 8`** — дефолтный LONG-бэкофф
   proper-lockfile превращает benign-гонку одного sync-тика (markFired vs
   extendArmTtl) в задержку раунда: детерминированный RED watchdog.e2e
   «probe→live» (документированная «РЕД»-заметка в тесте = эта гонка, не
   отсутствующая фича). Бюджет сужен до state.ts-паттерна.
3. **[side-effect cleaned] диагностика гонки** — временные index-dbg/arms-dbg
   копии писали в реальный `~/.pi/agent/pi-billing-window-arms.json` (расщепление
   модулей: пути set'ились в реальном arms.ts, писала копия). 9 мусорных записей
   `pbi-wd-probe-live-*` удалены; dbg-файлы удалены. Прод-arms.json чист.
4. **[design note] остаточный misroute-случай** — если после УСПЕШНОГО switch в
   этом же сбросе чужая сессия снова перезаймёт слот, отправка возможна без
   повторного switch (маркер `switchRoutedForReset === curReset`) — этот случай
   ловит существующая misroute-детекция (verifyDelivered → fire:send-misroute →
   капитуляция), оставлена намеренно (D-011-2, delivery-in-flight спеки 005).
5. **[obs] T2-агент обошёл тип через cast** — заменено на расширение union
   NotifyPayload (notifier.ts) при ревью.

## Аудит-сценарии 2026-10-05 — закрытие

- 19:17 switch-failed + 5×misroute → D2: fall-through удалён, «продолжи» без
  прошедшего switch не отправляется вообще; + TD-011-3 ускоряет доставку до
  секунд (мгновенный retry после revive).
- 23:35:51 arm-gone без уведомления → D1 + D3: при подтверждении с N=0 уходит
  confirmed-notify («исчерпаны, взведите снова»), arm-gone-переход закрыт
  маркером дедупа; внешние/TTL-исчезновения → arm-gone-notify.
- Ночные доставки видны пользователю по каждому окну (confirmed-notify с
  бюджетом N).

## Документация

- README §8a: bullets «switch-маршрутизация…» (дописан switch-gating +
  мгновенный retry), «arm-gone не молчит», «бюджет автопродолжений виден».
- docs/EVENTBUS.md — правка НЕ потребовалась: документирует каналы шины
  событий, notify-типы туда не входят (типы описаны в README §8a и
  src/notifier.ts, как и capitulation-тип до этого).
- .ai/sdd/INDEX.md и .status 004–011 — актуализированы (FR-011-5).
