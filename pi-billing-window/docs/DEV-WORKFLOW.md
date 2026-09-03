# Рабочий процесс разработки

## 1. Где что лежит

| Путь | Что |
|---|---|
| `C:\Tools\pi-billing-window\` | Проект разработки (этот каталог). Правим здесь. |
| `C:\Tools\pi-billing-window\src\` | Исходники. Скомпилировать или собрать здесь. |
| `C:\Tools\pi-billing-window\tests\` | Unit-тесты (запускать через `tsx`). |
| `C:\Users\r.edokov\.pi\agent\extensions\pi-billing-window\` | Рабочая (загружаемая pi) копия. Сюда нужно доставить изменения, чтобы pi их подхватил. |

## 2. Цикл правки

```
1. edit src/*.ts in C:\Tools\pi-billing-window
2. cd C:\Tools\pi-billing-window
3. npx tsc -p tsconfig.json         # type-check
4. npx tsx tests/test.mts           # unit-тесты
5. copy src\* to working dir        # см. ниже
6. restart pi / reload extension    # см. § 4
7. проверка в TUI
```

### Шаг 5: доставка в рабочий каталог

**Вариант A — копирование (надёжно, медленно):**

```powershell
$src = "C:\Tools\pi-billing-window\src"
$dst = "$env:USERPROFILE\.pi\agent\extensions\pi-billing-window"
Copy-Item -Force "$src\index.ts"     "$dst\index.ts"
Copy-Item -Force "$src\state.ts"     "$dst\state.ts"
Copy-Item -Force "$src\ticker.ts"    "$dst\ticker.ts"
Copy-Item -Force "$src\ui.ts"        "$dst\ui.ts"
Copy-Item -Force "$src\parser.ts"    "$dst\parser.ts"
Copy-Item -Force "$src\notifier.ts"  "$dst\notifier.ts"
```

**Вариант B — симлинк (быстро, но проверьте поддержку pi):**

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-billing-window" `
  -Target "C:\Tools\pi-billing-window"
```

`New-Item -ItemType Junction` создаёт NTFS junction (не требует прав администратора в отличие от `SymbolicLink`). Заменяет существующий каталог.

> ⚠️ Если pi кеширует расширение — после правки всё равно потребуется `/reload` или перезапуск.

## 3. Пересборка / чистка

У проекта `noEmit: true` — компилятор только валидирует типы. Рантайм-транспиляцию делает сам `pi` (грузит `index.ts` напрямую). Поэтому:

- Не нужен шаг `tsc --build` с emit.
- Достаточно `tsc -p .` для проверки типов.
- Если `pi` всё-таки ругается на синтаксис — проверьте версию Node в `package.json#engines` и совпадение `@types/node`.

## 4. Перезагрузка расширения

Зависит от того, как вы запускаете pi:

| Способ | Что делать после правки |
|---|---|
| TUI-сессия | `/reload` (slash-command pi) — перезагрузит все расширения. |
| Программный запуск | Перезапустить процесс. |
| Демонстрация в браузере | Перезапустить pi-remote **не нужно** (расширение с ним не связано постоянным соединением — оно делает HTTP POST при reset). Достаточно `/reload`. |

## 5. Тесты

```powershell
cd C:\Tools\pi-billing-window
npx tsx tests/test.mts
```

Тесты не требуют поднятого pi — они мокают `ctx`, `globalThis.fetch`, `setInterval`, `setTimeout`. Запускаются за <1 с.

Покрытие (`tests/test.mts`, ~100 кейсов):

- `state`: read/write/parse/missing, atomic rename через tmp, lock acquisition, mutate с null-state, перезапись путей через `setPaths`.
- `ticker`: reset, дедуп < 10 мин, about-to-reset, null-state, ошибка под локом, рестарт ticker без двойного интервала.
- `ui`: `renderStatusBar` (включая «осталось 0»), `forceUpdate`, `startStatusUpdater` в TUI и не-TUI режиме, очистка интервала при повторном старте.
- `parser`: все форматы + ошибки.
- `notifier`: успех, не-2xx, таймаут, сетевая ошибка, отсутствие url/token, env-переменная `PI_REMOTE_NOTIFY_TOKEN`.

## 6. Линтинг и форматирование

В проекте нет `eslint`/`prettier`. Если хочется — добавьте:

```powershell
npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier
```

Рекомендуемые правила:
- `strict: true` (уже в `tsconfig.json`).
- `noUnusedLocals: true`, `noUnusedParameters: true` (раскомментируйте, если добавляете eslint).
- 2 spaces, LF/CRLF — на ваш вкус; главное — единообразно.

## 7. Релиз / версионирование

- Правим `version` в `package.json` по SemVer.
- Тэг в git: `pi-billing-window-vX.Y.Z`.
- Changelog — в [`CHANGELOG.md`](./CHANGELOG.md) (создать при первом релизе).
- Доставка в `C:\Users\r.edokov\.pi\agent\extensions\pi-billing-window\`:
  - скопировать `src/*.ts`;
  - **обязательно** обновить `package.json` (если меняли `pi.extension` или версии зависимостей);
  - убедиться, что `node_modules` в рабочей копии содержит `proper-lockfile` (иначе запуск упадёт с `Cannot find module`).

## 8. Частые проблемы

| Симптом | Причина | Решение |
|---|---|---|
| `Cannot find module 'proper-lockfile'` после копирования | В рабочей копии нет `node_modules` | Запустите `npm install` в `C:\Users\r\.pi\agent\extensions\pi-billing-window`. |
| `setStatus` не обновляется | Режим != tui (rpc, print) | Виджет работает только в TUI. Используйте `/billing-status` для проверки. |
| Событие `billing:window_reset` не приходит подписчику | Подписчик зарегистрировался **до** `session_start` нашего расширения | Сделайте отложенную подписку в собственном `session_start` (см. `examples/subscribe.ts`). |
| `tsx tests/test.mts` валится на `lockfile` | На Windows иногда глючит `proper-lockfile` с UNC-путями. Тесты используют `mkdtempSync` — убедитесь, что `tmpdir` доступен. | Запустите `node -e "console.log(require('os').tmpdir())"` — путь должен существовать. |
| Несколько процессов постоянно дерутся за лок | `withLock` имеет `retries: 8` — после исчерпания бросает. | Увеличьте `retries` в `src/state.ts` или завершите конкурирующие процессы. |

## 9. Расширение другими провайдерами

Сейчас `PROVIDER = "wormsoft"` — единственная константа. Чтобы добавить, например, `anotherprov`:

1. Превратите `PROVIDER` в `PROVIDERS = ["wormsoft", "anotherprov"]`.
2. В `onAfterProviderResponse` фильтруйте по `PROVIDERS.includes(providerName)`.
3. `State.provider` — теперь будет принимать любой из этих имён.
4. В `ui.ts::applyStatus` показывайте виджет, если `PROVIDERS.includes(provider)`.
5. Не забудьте: команды `/billing-reset`, `/settimer` сейчас работают на единственный state. Для нескольких провайдеров нужно либо разные state-файлы, либо `Record<string, State>` в одном файле.

## 10. Вклад в общий EventBus

Если вы пишете **подписчик** на события `pi-billing-window`, оформите его как отдельное расширение в `C:\Users\r\.pi\agent\extensions\<your-subscriber>\`:

```ts
// examples/subscribe.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  let off: (() => void) | null = null;

  pi.on("session_start", async (_evt, ctx: ExtensionContext) => {
    const bus = (ctx as any).events as
      | { on: (ch: string, h: (d: unknown) => void) => () => void }
      | undefined;
    if (!bus) return;

    off = bus.on("billing:window_reset", async (raw) => {
      const s = raw as { provider: string; resetCount: number };
      // пример: сбросить локальный rate-limit
      // myLimiter.reset(s.provider);
      console.log(`[subscriber] reset #${s.resetCount} for ${s.provider}`);
    });
  });

  pi.on("session_shutdown", () => {
    off?.();
    off = null;
  });
}
```

В `package.json` подписчика:
```json
{ "pi": { "extension": "./subscribe.ts" } }
```
