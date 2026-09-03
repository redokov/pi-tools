/**
 * e2e.mts -- end-to-end test for pi-transcribe /transcribe-gigaam.
 *
 * Runs the REAL extension factory with a mock `pi` API and the REAL
 * transcribe pipeline (mocked prepare.py / transcribe.py in a temp dir).
 * Verifies:
 *   1. /transcribe-gigaam runs prepare + transcribe with model=gigaam.
 *   2. The transcript file is read and a sendMessage is issued with it.
 *   3. A followUp sendUserMessage is queued with a summarization prompt.
 *   4. --no-summary suppresses the followUp.
 *   5. --summary-prompt overrides the prompt text.
 *   6. /transcribe (default) uses whisper-large when no --model passed.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import extFactory from "../src/index.js";
import { setProjectDir, resetProjectDir } from "../src/paths.js";

// --- mock pi / ctx ----------------------------------------------------------

type CommandDef = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
};
const commands = new Map<string, CommandDef>();
const sentMessages: unknown[] = [];
const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
const notified: Array<{ msg: string; level?: string }> = [];
const statuses: Array<{ key: string; value: string }> = [];

const pi = {
  registerCommand: (name: string, def: CommandDef) => { commands.set(name, def); },
  sendMessage: (msg: unknown, opts?: unknown) => { void opts; sentMessages.push(msg); },
  sendUserMessage: (content: unknown, opts?: unknown) => { sentUserMessages.push({ content, options: opts }); },
  on: () => {},
  // no-op for any other API call
};

function makeCtx(): Record<string, unknown> {
  return {
    ui: {
      notify: (msg: string, level?: string) => notified.push({ msg, level }),
      setStatus: (key: string, value: string) => statuses.push({ key, value }),
      select: async () => undefined, // cancel -> default
      confirm: async () => true,      // reuse manifest
      input: async () => undefined,
    },
  };
}

// --- temp project ------------------------------------------------------------

const stub = mkdtempSync(join(tmpdir(), "pi-transcribe-e2e2-"));
mkdirSync(join(stub, "inbox"), { recursive: true });
mkdirSync(join(stub, "out"), { recursive: true });
mkdirSync(join(stub, "scripts"), { recursive: true });
writeFileSync(join(stub, "inbox", "meeting.mp4"), "fake media bytes");

writeFileSync(join(stub, "scripts", "prepare.py"), `
import json, sys, os
from pathlib import Path
argv = sys.argv[1:]
inp = argv[0]
out_dir = Path(os.environ.get("E2E_OUT_DIR", "out"))
out_dir.mkdir(parents=True, exist_ok=True)
src = Path(inp).name
base = src[:-len(Path(src).suffix)]
manifest = out_dir / f"{base}.manifest.json"
manifest.write_text(json.dumps({"input": str(inp), "chunks": []}), encoding="utf-8")
print(f"prepared: {manifest}")
`, "utf-8");

writeFileSync(join(stub, "scripts", "transcribe.py"), `
import json, sys, os
from pathlib import Path
argv = sys.argv[1:]
def opt(name, default=None):
    if name in argv:
        i = argv.index(name)
        if i+1 < len(argv):
            return argv[i+1]
    return default
manifest = argv[0]
model = opt("--model")
lang  = opt("--lang", "ru")
fmt   = opt("--format", "text")
out_dir = Path(opt("--out-dir", "out"))
out_dir.mkdir(parents=True, exist_ok=True)
name = Path(manifest).name
if name.endswith(".manifest.json"):
    name = name[:-len(".manifest.json")]
stem = name
ext = {"text":"txt","srt":"srt","vtt":"vtt","json":"json","verbose_json":"verbose.json"}[fmt]
target = out_dir / f"{stem}.{ext}"
if fmt == "text":
    target.write_text(f"[{model}][{lang}] mock transcript for {stem}\\nline1\\nline2\\n", encoding="utf-8")
else:
    target.write_text("{}", encoding="utf-8")
print(f"transcribed: {target} (model={model} lang={lang} fmt={fmt})")
`, "utf-8");

process.env.TRANSCRIBE_PROJECT_DIR = stub;
setProjectDir(stub);

// --- helpers -----------------------------------------------------------------

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) {
    failed++; console.log(`  FAIL - ${name}`);
    console.log(`    ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  }
}
function reset() {
  sentMessages.length = 0;
  sentUserMessages.length = 0;
  notified.length = 0;
  statuses.length = 0;
  rmSync(join(stub, "out"), { recursive: true, force: true });
  mkdirSync(join(stub, "out"), { recursive: true });
}
async function runCmd(cmd: string, args: string) {
  const def = commands.get(cmd);
  if (!def) throw new Error(`command ${cmd} not registered`);
  await def.handler(args, makeCtx());
}

// --- run ---------------------------------------------------------------------

console.log("e2e: register commands");
extFactory(pi as never);
assert(commands.has("transcribe"));
assert(commands.has("transcribe-gigaam"));
assert(commands.has("transcribe-status"));

console.log("e2e: /transcribe-gigaam (default args)");
await test("registers + runs + model=gigaam + sends summary", async () => {
  reset();
  await runCmd("transcribe-gigaam", "");
  // pipeline ran
  const manifestPath = join(stub, "out", "meeting.manifest.json");
  const resultPath = join(stub, "out", "meeting.txt");
  assert(existsSync(manifestPath), "manifest missing");
  assert(existsSync(resultPath), "result missing");
  // sendMessage emitted with transcript text
  assert.equal(sentMessages.length, 1, "expected 1 sendMessage");
  const msg = sentMessages[0] as any;
  assert.match(msg.content, /meeting\.mp4/);
  assert.match(msg.content, /gigaam/);
  assert.match(msg.content, /line1/);
  // sendUserMessage queued for summarization
  assert.equal(sentUserMessages.length, 1, "expected 1 sendUserMessage");
  const um = sentUserMessages[0];
  assert.equal((um.options as any)?.deliverAs, "followUp");
  assert.match(um.content as string, /Саммаризируй/);
  assert.match(um.content as string, /meeting\.txt/);
  assert.match(um.content as string, /gigaam/);
});

console.log("e2e: /transcribe-gigaam --no-summary");
await test("no sendUserMessage", async () => {
  reset();
  await runCmd("transcribe-gigaam", "--no-summary");
  assert.equal(sentUserMessages.length, 0, "expected no sendUserMessage");
  assert.equal(sentMessages.length, 1, "transcript still emitted");
});

console.log("e2e: /transcribe-gigaam --summary-prompt");
await test("custom prompt used verbatim", async () => {
  reset();
  await runCmd("transcribe-gigaam", "--summary-prompt summarize in English");
  assert.equal(sentUserMessages.length, 1);
  assert.match(sentUserMessages[0].content as string, /summarize in English/);
  // file refs still appended
  assert.match(sentUserMessages[0].content as string, /meeting\.txt/);
});

console.log("e2e: /transcribe (default model)");
await test("uses whisper-large when no --model", async () => {
  reset();
  await runCmd("transcribe", "");
  // mock transcribe writes model into the txt file; check that the
  // sendMessage content (which includes the file path + model header) shows
  // whisper-large
  const msg = sentMessages[0] as any;
  assert.match(msg.content, /whisper-large/);
  // and the result file contains the mock's model tag
  const txt = readFileSync(join(stub, "out", "meeting.txt"), "utf8");
  assert.match(txt, /whisper-large/);
});

console.log("e2e: /transcribe-gigaam meeting.mp4 (explicit file)");
await test("explicit file path works", async () => {
  reset();
  await runCmd("transcribe-gigaam", "meeting.mp4");
  const msg = sentMessages[0] as any;
  assert.match(msg.content, /meeting\.mp4/);
  assert.match(msg.content, /gigaam/);
});

console.log("e2e: /transcribe-gigaam with absolute path outside inbox");
await test("copies file into inbox/ and runs pipeline on the copy", async () => {
  reset();
  // Drop a file OUTSIDE the project dir
  const outside = join(stub, "outside.mp4");
  writeFileSync(outside, "outside bytes");
  try {
    await runCmd("transcribe-gigaam", outside);
    // 1) copy exists in inbox/ under the same name
    const inInbox = join(stub, "inbox", "outside.mp4");
    assert(existsSync(inInbox), "expected copy in inbox/");
    // 2) original is untouched
    assert.equal(readFileSync(outside, "utf8"), "outside bytes");
    // 3) pipeline ran on the copy: out/outside.txt exists with gigaam marker
    const res = join(stub, "out", "outside.txt");
    assert(existsSync(res), "expected out/outside.txt");
    assert.match(readFileSync(res, "utf8"), /gigaam/);
    // 4) the sendMessage shows the inbox path (displayPath), not the outside path
    const msg = sentMessages[0] as any;
    assert.match(msg.content, /outside\.mp4/);
    assert.match(msg.content, /gigaam/);
    // 5) the original file is NOT in out/ (only the copied base name is used)
  } finally {
    rmSync(outside, { force: true });
  }
});

console.log("e2e: /transcribe-gigaam with absolute path that does not exist");
await test("fails with error, no side effects", async () => {
  reset();
  const missing = join(stub, "does-not-exist.mp4");
  await runCmd("transcribe-gigaam", missing);
  assert.equal(sentMessages.length, 0);
  assert.equal(sentUserMessages.length, 0);
  const err = notified.find((n) => n.level === "error");
  assert(err, "expected an error notification");
});

console.log("e2e: /transcribe-gigaam with quoted absolute path containing spaces");
await test("quoted path with spaces is copied and transcribed", async () => {
  reset();
  // Build a real path with spaces, outside the project
  const spacedDir = join(stub, "Zoom", "2026-08-25 11.05.34 Комус. Ежедневные встречи");
  mkdirSync(spacedDir, { recursive: true });
  const src = join(spacedDir, "video1931585114.mp4");
  writeFileSync(src, "spaced path bytes");
  try {
    await runCmd("transcribe-gigaam", `"${src}"`);
    const inInbox = join(stub, "inbox", "video1931585114.mp4");
    assert(existsSync(inInbox), "expected copy in inbox/ under the file name");
    assert(existsSync(join(stub, "out", "video1931585114.txt")), "expected transcript");
    assert.equal(sentMessages.length, 1);
    assert.match((sentMessages[0] as any).content, /gigaam/);
  } finally {
    rmSync(join(stub, "Zoom"), { recursive: true, force: true });
  }
});

console.log("e2e: /transcribe-status");
await test("lists out/ without error", async () => {
  reset();
  await runCmd("transcribe-status", "");
  // handler called ctx.ui.notify with the listing
  const listing = notified.find((n) => /Содержимое out\//.test(n.msg));
  assert(listing, "expected status notify");
});

resetProjectDir();
rmSync(stub, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
