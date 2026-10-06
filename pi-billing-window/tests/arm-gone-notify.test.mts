/**
 * arm-gone-notify.test.mts -- spec 011 (T2, D1): уведомление при сгорании
 * флага cont-after-reset (FR-011-1) и дедуп само-снятия (FR-011-4).
 * Спека 011 (T4, D3): confirmed-notify после успешного токен-ответа —
 * бюджет автопродолжений (FR-011-3) и дедуп исчерпания подтверждением
 * (FR-011-4, selfArmGoneKind="confirmed-exhausted").
 *
 * Run: npx tsx tests/arm-gone-notify.test.mts
 *
 * Детерминизм: реальные минуты не ждём. arm-gone-переходы гоняются через
 * __syncWatchdogForTests(); TTL-истечение имитируется переписью arms.json
 * с коротким expiresAt + sleep; capitulation-цепочка — как в
 * stale-capitulation.test.mts (sendUserMessage бросает stale, pacing
 * сжат через setStaleRetryMsForTests(0)). Notify перехватывается моком
 * globalThis.fetch (образец -- testCapitulationNotify).
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setStaleRetryMsForTests,
  setResetGraceMsForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
  __syncWatchdogForTests,
  __resetStaleStateForTests,
  setVerifyDeliveredForTests,
} from "../src/index.ts";
import {
  mutateState,
  writeStateSync,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
  isArmed as armsIsArmed,
  getArm as armsGetArm,
  RESET_GRACE_MS,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";

// --- tiny assert harness ------------------------------------------------------

const results: string[] = [];
let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    results.push(`PASS: ${name}`);
  } else {
    failed++;
    results.push(`FAIL: ${name}`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// --- mock pi / ctx --------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

/**
 * Mock ExtensionAPI whose sendUserMessage rejects with pi's exact
 * stale-ctx error (капитуляционный сценарий); `reject` переключается на
 * рантайме, как в stale-capitulation.test.mts.
 */
function makeMockPi(): {
  pi: unknown;
  handlers: Map<string, SessionHandler[]>;
  commands: Map<string, CommandHandler>;
  sends: Array<{ content: unknown; opts: unknown }>;
  reject: { enabled: boolean };
} {
  const handlers = new Map<string, SessionHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const sends: Array<{ content: unknown; opts: unknown }> = [];
  const reject = { enabled: true };
  const busSubs = new Map<string, Array<(d: unknown) => void>>();

  const pi = {
    events: {
      emit: (_ch: string, _data: unknown) => {},
      on: (ch: string, h: (d: unknown) => void) => {
        const arr = busSubs.get(ch) ?? [];
        arr.push(h);
        busSubs.set(ch, arr);
        return () => {
          const i = arr.indexOf(h);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    on: (ev: string, h: SessionHandler) => {
      const arr = handlers.get(ev) ?? [];
      arr.push(h);
      handlers.set(ev, arr);
    },
    registerCommand: (name: string, spec: { handler: CommandHandler }) => {
      commands.set(name, spec.handler);
    },
    sendUserMessage: async (content: unknown, opts?: unknown) => {
      sends.push({ content, opts });
      if (reject.enabled) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
      return undefined;
    },
  };
  return { pi, handlers, commands, sends, reject };
}

function makeCtx(sessionFile: string): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => [],
    },
  };
}

// --- paths / seeding helpers ---------------------------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;

function applyPaths(tmp: string): void {
  stateSetPaths(join(tmp, "state.json"), join(tmp, "state.lock"));
  armsSetPaths(join(tmp, "arms.json"), join(tmp, "arms.lock"));
  historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));
  setArmsLogPath(join(tmp, "armslog.log"));
}

function cleanupPaths(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
  stateResetPaths();
  armsResetPaths();
  historyResetPaths();
}

function handlerOf(
  handlers: Map<string, SessionHandler[]>,
  name: string,
): SessionHandler {
  const h = handlers.get(name)?.[0];
  if (!h) throw new Error(`no handler registered for ${name}`);
  return h;
}

function commandOf(
  commands: Map<string, CommandHandler>,
  name: string,
): CommandHandler {
  const h = commands.get(name);
  if (!h) throw new Error(`no command registered for ${name}`);
  return h;
}

/**
 * Минимальный посев для arm-gone-кейсов: окно + session_start + взвод флага.
 * state.lastResetAt остаётся 0 — TTL-продление (spec 010) не срабатывает и
 * не мешает переписи arms.json; сброс окна не нужен (доставку не проверяем).
 */
async function seedArmed(
  commands: Map<string, CommandHandler>,
  handlers: Map<string, SessionHandler[]>,
  ctx: unknown,
): Promise<void> {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
  await handlerOf(handlers, "session_start")({}, ctx);
  await commandOf(commands, "cont-after-reset")("", ctx);
}

/** Посев с «прошлым» сбросом окна — для капитуляционного сценария. */
async function seedArmedWithPastReset(
  commands: Map<string, CommandHandler>,
  handlers: Map<string, SessionHandler[]>,
  ctx: unknown,
): Promise<void> {
  await seedArmed(commands, handlers, ctx);
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - 60_000 } };
  });
}

// --- arms.json хирургия --------------------------------------------------------

type ArmRecord = {
  armedAt: number;
  lastResetAtAtArm: number;
  expiresAt: number;
  phase?: string;
  repeat?: number;
};

function readArmsMap(tmp: string): Record<string, ArmRecord> {
  return JSON.parse(
    readFileSync(join(tmp, "arms.json"), "utf8"),
  ) as Record<string, ArmRecord>;
}

function writeArmsMap(
  tmp: string,
  map: Record<string, ArmRecord>,
): void {
  writeFileSync(join(tmp, "arms.json"), JSON.stringify(map, null, 2), "utf8");
}

/** Переписать единственную запись arms.json (мутация на месте). */
function rewriteArm(
  tmp: string,
  mutate: (rec: ArmRecord) => ArmRecord,
): void {
  const map = readArmsMap(tmp);
  const key = Object.keys(map)[0];
  if (!key) throw new Error("no arm on disk");
  map[key] = mutate(map[key]);
  writeArmsMap(tmp, map);
}

// --- fetch-мок (notifier) -------------------------------------------------------

type Fetched = { url: string; body: unknown; headers: unknown };

function armGoneNotifies(fetched: Fetched[]): Fetched[] {
  return fetched.filter(
    (f) =>
      f.body !== null &&
      (f.body as { type?: string }).type ===
        "billing:cont-after-reset-arm-gone",
  );
}

/** Spec 011 (D3): confirmed-notify-пейдгоады из fetched. */
function confirmedNotifies(fetched: Fetched[]): Fetched[] {
  return fetched.filter(
    (f) =>
      f.body !== null &&
      (f.body as { type?: string }).type ===
        "billing:cont-after-reset-confirmed",
  );
}

// --- Spec 011 (D3, T4): confirm-контекст и посев полного цикла доставки ---

/** Токен-несущие entries владельца: успешный ответ подтверждает pending. */
const TOKEN_ENTRIES = [
  { type: "message", message: { role: "assistant", usage: { input: 1200, output: 300 } } },
];

/** 0-token entries (фоновый вызов без сжигания токенов). */
const ZERO_TOKEN_ENTRIES = [
  { type: "message", message: { role: "assistant", usage: { input: 0, output: 0 } } },
];

/** Как makeCtx, но с управляемым getEntries (confirm-путь читает usage). */
function makeConfirmCtx(sessionFile: string, entries: unknown[]): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => entries,
    },
  };
}

/**
 * Полный цикл доставки до pending (как в watchdog.e2e сценарий 4/5):
 * свежее окно → session_start → взвод /cont-after-reset <repeatArg> →
 * сброс окна (backdate windowStartedAt) → watchdog fire →
 * доставка «продолжи» → флаг в phase=pending.
 * Требует setResetGraceMsForTests(40) и reject.enabled=false у мок-пи.
 */
async function seedPendingDelivery(
  commands: Map<string, CommandHandler>,
  handlers: Map<string, SessionHandler[]>,
  ctx: unknown,
  repeatArg: string,
): Promise<void> {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
  await handlerOf(handlers, "session_start")({}, ctx);
  await commandOf(commands, "cont-after-reset")(repeatArg, ctx);
  // Граница окна в прошлом: fire внутри выполнит реальный сброс окна.
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, windowStartedAt: Date.now() - WINDOW_MS - 1000 } };
  });
  await __fireWatchdogForTests();
  await sleep(300); // grace сжат до 40 мс — доставке хватает
}

// --- 1. TTL-истечение → notify ttl-expired (+ 5. дублей нет) -------------------

async function testTtlExpiredNotify(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-1.jsonl"));
    await seedArmed(commands, handlers, ctx);
    assert(armsIsArmed(), "ttl: флаг взведён");

    // Имитация естественного TTL-истечения: переписать expiresAt на
    // now+250 (запись ещё живая), тик обновляет снимок, затем время
    // выходит и следующий тик видит arm === null.
    rewriteArm(tmp, (rec) => ({ ...rec, expiresAt: Date.now() + 250 }));
    __syncWatchdogForTests(); // снимок := expiresAt = now+250
    await sleep(600); // TTL истёк
    __syncWatchdogForTests(); // переход arm-gone → notify
    await sleep(300); // fire-and-forget fetch

    const notifies = armGoneNotifies(fetched);
    assert(
      notifies.length === 1,
      `ttl: arm-gone-notify РОВНО 1 (получено ${notifies.length})`,
    );
    if (notifies.length > 0) {
      const body = notifies[0].body as {
        provider?: string;
        title?: string;
        body?: string;
      };
      assert(
        body.title === "cont-after-reset: флаг сгорел",
        "ttl: title «флаг сгорел»",
      );
      assert(
        body.provider === "wormsoft",
        "ttl: provider=wormsoft",
      );
      assert(
        (body.body ?? "").includes("истёк"),
        "ttl: body сообщает об истечении срока годности",
      );
      assert(
        (body.body ?? "").includes("/cont-after-reset"),
        "ttl: body содержит подсказку взвести снова",
      );
    }
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(log.includes("arm-gone"), "ttl: armslog содержит arm-gone");
    assert(
      log.includes("reason=ttl-expired"),
      "ttl: armslog содержит reason=ttl-expired",
    );

    // --- 5. Повторный тик без флага НЕ дублирует notify ---
    const before = armGoneNotifies(fetched).length;
    __syncWatchdogForTests();
    await sleep(300);
    const after = armGoneNotifies(fetched).length;
    assert(
      after === before,
      `dup: повторный тик не дублирует arm-gone-notify (${before} → ${after})`,
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 2. repeat-exhausted (внешнее снятие pending repeat=1) --------------------

async function testRepeatExhaustedNotify(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-2.jsonl"));
    await seedArmed(commands, handlers, ctx);

    // Запись «на последнем автопродолжении»: pending, repeat=1, TTL жив.
    rewriteArm(tmp, (rec) => ({
      ...rec,
      phase: "pending",
      repeat: 1,
      expiresAt: Date.now() + 60 * 60 * 1000,
    }));
    __syncWatchdogForTests(); // снимок := { pending, 1, будущее }

    // «Подтверждение» сняло флаг — записи больше нет.
    writeArmsMap(tmp, {});
    __syncWatchdogForTests(); // переход arm-gone → reason repeat-exhausted
    await sleep(300);

    const notifies = armGoneNotifies(fetched);
    assert(
      notifies.length === 1,
      `rep: arm-gone-notify РОВНО 1 (получено ${notifies.length})`,
    );
    if (notifies.length > 0) {
      const body = (notifies[0].body as { body?: string }).body ?? "";
      assert(
        body.includes("исчерпаны"),
        "rep: body сообщает «автопродолжения исчерпаны»",
      );
      assert(
        body.includes("/cont-after-reset"),
        "rep: body содержит подсказку взвести снова",
      );
    }
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("reason=repeat-exhausted"),
      "rep: armslog содержит reason=repeat-exhausted",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 3. /cont-after-reset off — само-снятие, notify НЕТ ------------------------

async function testOffNoNotify(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-3.jsonl"));
    await seedArmed(commands, handlers, ctx);
    assert(armsIsArmed(), "off: флаг взведён");

    // Пользователь снял флаг командой: arm-gone-переход должен пройти с
    // маркером kind=off — лог есть, notify НЕТ.
    await commandOf(commands, "cont-after-reset")("off", ctx);
    __syncWatchdogForTests(); // контрольный тик после снятия
    await sleep(300);

    assert(
      armGoneNotifies(fetched).length === 0,
      "off: arm-gone-notify НЕ отправлен (само-снятие)",
    );
    assert(!armsIsArmed(), "off: флаг снят");
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("arm-gone"),
      "off: armslog содержит arm-gone",
    );
    assert(
      log.includes("kind=off"),
      "off: armslog содержит kind=off",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 4. Капитуляция — только capitulation-notify, arm-gone-notify НЕТ ---------

async function testCapitulationOnlyCapitulationNotify(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setStaleRetryMsForTests(0);
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-4.jsonl"));
    await seedArmedWithPastReset(commands, handlers, ctx);

    // Полная capitulation-цепочка: 6 stale-неудач (как в
    // testCapitulationNotify из stale-capitulation.test.mts).
    await __fireWatchdogForTests(); // попытка 1
    await sleep(150);
    for (let n = 2; n <= 6; n++) {
      setStaleRetryMsForTests(0);
      await __retryTickForTests();
      await sleep(80);
    }
    assert(!armsIsArmed(), "cap: флаг снят капитуляцией");

    // Контрольный sync-тик после капитуляции: переход arm-gone уже
    // отработал внутри capitulate() с маркером — дубля быть не должно.
    __syncWatchdogForTests();
    await sleep(400); // fire-and-forget fetch

    const capNotifies = fetched.filter(
      (f) =>
        f.body !== null &&
        (f.body as { type?: string }).type ===
          "billing:cont-after-reset-capitulation",
    );
    assert(
      capNotifies.length === 1,
      `cap: capitulation-notify РОВНО 1 (получено ${capNotifies.length})`,
    );
    assert(
      armGoneNotifies(fetched).length === 0,
      "cap: arm-gone-notify НЕ отправлен (дедуп само-снятия)",
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("capitulation:after-6"),
      "cap: armslog содержит capitulation:after-6",
    );
    assert(
      log.includes("arm-gone") && log.includes("kind=capitulation"),
      "cap: armslog содержит arm-gone с kind=capitulation",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 6 (C1). Spec 011 (D3): confirmed при repeat=3 → осталось 2, перевзвод ---

/**
 * FR-011-3: после успешного токен-ответа на «продолжи» при repeat=3
 * уходит confirmed-notify «Осталось автопродолжений: 2», arm-gone-notify
 * нет, флаг перевзведён (repeat=2, phase=armed).
 */
async function testConfirmedNotifyRepeatRemaining(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setResetGraceMsForTests(40);
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands, sends, reject } = makeMockPi();
    reject.enabled = false; // доставка «продолжи» успешна
    piBillingWindowFactory(pi as never);

    const ctx = makeConfirmCtx(join(tmp, "sess-5.jsonl"), TOKEN_ENTRIES);
    await seedPendingDelivery(commands, handlers, ctx, "3");
    assert(sends.length === 1, "c1: «продолжи» доставлен (одна отправка)");
    assert(
      armsGetArm()?.phase === "pending",
      "c1: флаг в pending до успешного ответа",
    );

    // Успешный токен-ответ владельца → confirmSuccess → confirmed-notify.
    await handlerOf(handlers, "after_provider_response")( { status: 200, headers: {} }, ctx);
    await sleep(300); // fire-and-forget notify-fetch

    const confirms = confirmedNotifies(fetched);
    assert(
      confirms.length === 1,
      `c1: confirmed-notify РОВНО 1 (получено ${confirms.length})`,
    );
    if (confirms.length > 0) {
      const body = confirms[0].body as { title?: string; body?: string };
      assert(
        (body.body ?? "").includes("Осталось автопродолжений: 2"),
        "c1: body сообщает «Осталось автопродолжений: 2»",
      );
      assert(
        (body.title ?? "").includes("осталось 2"),
        "c1: title содержит «осталось 2»",
      );
    }
    assert(
      armGoneNotifies(fetched).length === 0,
      "c1: arm-gone-notify НЕ отправлен (флаг жив, repeat=2)",
    );
    const arm = armsGetArm();
    assert(
      arm !== null && arm.repeat === 2 && arm.phase === "armed",
      "c1: флаг перевзведён (repeat=2, phase=armed)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 7 (C2). Spec 011 (D3): одноразовый → исчерпаны + дедуп arm-gone ---

/**
 * FR-011-3 + FR-011-4: подтверждение одноразового флага шлёт
 * confirmed-notify «Автопродолжения исчерпаны … /cont-after-reset N»;
 * последующий sync-тик НЕ дублирует его arm-gone-notify
 * (selfArmGoneKind="confirmed-exhausted"), но пишет arm-gone в armslog.
 */
async function testConfirmedExhaustedDedup(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setResetGraceMsForTests(40);
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands, sends, reject } = makeMockPi();
    reject.enabled = false; // доставка «продолжи» успешна
    piBillingWindowFactory(pi as never);

    const ctx = makeConfirmCtx(join(tmp, "sess-6.jsonl"), TOKEN_ENTRIES);
    await seedPendingDelivery(commands, handlers, ctx, ""); // одноразовый
    assert(sends.length === 1, "c2: «продолжи» доставлен (одна отправка)");
    assert(
      armsGetArm()?.phase === "pending",
      "c2: флаг в pending до успешного ответа",
    );

    await handlerOf(handlers, "after_provider_response")( { status: 200, headers: {} }, ctx);
    await sleep(300); // fire-and-forget notify-fetch

    const confirms = confirmedNotifies(fetched);
    assert(
      confirms.length === 1,
      `c2: confirmed-notify РОВНО 1 (получено ${confirms.length})`,
    );
    if (confirms.length > 0) {
      const body = (confirms[0].body as { body?: string }).body ?? "";
      assert(
        body.includes("Автопродолжения исчерпаны"),
        "c2: body сообщает «Автопродолжения исчерпаны»",
      );
      assert(
        body.includes("/cont-after-reset"),
        "c2: body содержит подсказку взвести снова: /cont-after-reset N",
      );
    }
    assert(armsGetArm() === null, "c2: одноразовый флаг снят");

    // Дедуп: контрольный sync-тик после исчерпания подтверждением —
    // arm-gone-notify не должен появиться (selfArmGoneKind уже сработал).
    __syncWatchdogForTests();
    await sleep(300);
    assert(
      armGoneNotifies(fetched).length === 0,
      "c2: arm-gone-notify НЕ отправлен (дедуп confirmed-exhausted)",
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(log.includes("arm-gone"), "c2: armslog содержит arm-gone");
    assert(
      log.includes("kind=confirmed-exhausted"),
      "c2: armslog содержит kind=confirmed-exhausted",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 8 (C3). Spec 011 (D3): ответ без токенов → confirm не происходит ---

/**
 * FR-011-3 (негатив): 0-token ответ (usage input=0, output=0) при pending
 * не подтверждает флаг — confirmed-notify не уходит, флаг остаётся pending.
 */
async function testZeroTokenResponseNoConfirm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-armgone-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setResetGraceMsForTests(40);
  const originalFetch = globalThis.fetch;
  const fetched: Fetched[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands, reject } = makeMockPi();
    reject.enabled = false; // доставка «продолжи» успешна
    piBillingWindowFactory(pi as never);

    const ctx = makeConfirmCtx(join(tmp, "sess-7.jsonl"), ZERO_TOKEN_ENTRIES);
    await seedPendingDelivery(commands, handlers, ctx, "3");

    // Ответ без сжигания токенов: confirmEligible=false → без подтверждения.
    await handlerOf(handlers, "after_provider_response")( { status: 200, headers: {} }, ctx);
    await sleep(300);

    assert(
      confirmedNotifies(fetched).length === 0,
      "c3: confirmed-notify НЕ отправлен (ответ без токенов)",
    );
    const arm = armsGetArm();
    assert(
      arm !== null && arm.phase === "pending",
      "c3: флаг остался в pending (без подтверждения)",
    );
    assert(
      armGoneNotifies(fetched).length === 0,
      "c3: arm-gone-notify НЕ отправлен",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  // Спека 007: моки не пишут entries в session-файл — стаб delivery-верификации
  // всегда-true (как в stale-capitulation / lifecycle).
  setVerifyDeliveredForTests(() => true);
  console.log(
    "\n=== Arm-gone notify tests (spec 011 D1: сгорание флага + дедуп) ===",
  );
  await testTtlExpiredNotify();
  await testRepeatExhaustedNotify();
  await testOffNoNotify();
  await testCapitulationOnlyCapitulationNotify();
  // Спека 011 (D3, T4): confirmed-notify после успешного токен-ответа.
  await testConfirmedNotifyRepeatRemaining();
  await testConfirmedExhaustedDedup();
  await testZeroTokenResponseNoConfirm();

  console.log("\n========================================");
  for (const r of results) console.log(r);
  console.log("========================================");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
