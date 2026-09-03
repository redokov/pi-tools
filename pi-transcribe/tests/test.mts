/**
 * test.mts -- unit + integration tests for pi-transcribe.
 *
 * Unit tests (no network): paths, output, pipeline argv + spawn (fake scripts).
 * Integration (real python + ffmpeg + wormsoft API):
 *   - WORMSOFT_TEST_TOKEN in env -> full API run;
 *   - otherwise the API step is SKIPPED with a clear message (token never hardcoded).
 *
 * Run: npm test  (tsx tests/test.mts)
 */

import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setProjectDir,
  getProjectDir,
  getInboxDir,
  getOutDir,
  getScriptsDir,
  validateInboxName,
  resolveSourcePath,
  baseNameOf,
  manifestPathFor,
  resultPathFor,
  manifestExists,
  latestInboxFile,
  listOutFiles,
  sourceExists,
  displayPath,
  MODEL_CHOICES,
  FORMAT_CHOICES,
} from "../src/paths.js";
import {
  readResult,
  truncateForChat,
  summarizeOut,
  hasManifest,
  fmtBytes,
} from "../src/output.js";
import {
  prepareCommand,
  transcribeCommand,
  runPrepare,
  runTranscribe,
} from "../src/pipeline.js";
import { askModelChoice } from "../src/prompt.js";

// --- minimal test harness ----------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
function eq(a: unknown, b: unknown, name: string): void {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log(`    actual:   ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
  assert(ok, name);
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  ⚠ SKIP ${name} — ${reason}`);
}
function section(title: string): void {
  console.log(`\n# ${title}`);
}

// --- fixtures: temporary transcribe project ---------------------------------

const FIXTURE_ROOT = join(tmpdir(), `pi-transcribe-test-${process.pid}`);
const FAKE_PROJECT = join(FIXTURE_ROOT, "project");

function setupFakeProject(): void {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  for (const d of [getInboxDir(), getOutDir(), getScriptsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const scriptSrc = (marker: string) =>
    `import sys, json, pathlib\n` +
    `pathlib.Path(${JSON.stringify(join(FIXTURE_ROOT, "argv.json"))}).write_text(\n` +
    `    json.dumps({${JSON.stringify(marker)}: True, "args": sys.argv[1:]}, ensure_ascii=False), encoding="utf-8")\n` +
    `print("ok")\n`;
  fs.writeFileSync(join(getScriptsDir(), "prepare.py"), scriptSrc("prepare"));
  fs.writeFileSync(join(getScriptsDir(), "transcribe.py"), scriptSrc("transcribe"));
  fs.writeFileSync(join(getInboxDir(), "foo.mp4"), "not a real video");
  fs.writeFileSync(join(getInboxDir(), ".gitkeep"), "");
}

// Point the extension at the fake project BEFORE any file-based assertion.
setProjectDir(FAKE_PROJECT);

// --- paths.ts ----------------------------------------------------------------

async function testPaths(): Promise<void> {
  section("paths.ts");

  eq(getProjectDir(), FAKE_PROJECT, "setProjectDir re-points project root");
  eq(getInboxDir(), join(FAKE_PROJECT, "inbox"), "inbox dir derived from project");
  eq(getOutDir(), join(FAKE_PROJECT, "out"), "out dir derived from project");

  // validateInboxName
  eq(validateInboxName("meeting.mp4"), null, "valid name accepted");
  assert(validateInboxName("x.txt") !== null, "unknown extension rejected");
  assert(validateInboxName("../secrets.mp4") !== null, "traversal rejected");
  assert(validateInboxName("a\\b.mp4") !== null, "backslash path rejected");
  assert(validateInboxName("C:\\x.mp4") !== null, "drive letter rejected");
  assert(validateInboxName("") !== null, "empty rejected");

  // resolveSourcePath
  let r = resolveSourcePath("meeting.mp4");
  assert(r.ok && r.path === join(getInboxDir(), "meeting.mp4"), "plain name -> inbox/<name>");
  r = resolveSourcePath(join(getInboxDir(), "abs.wav"));
  assert(r.ok && r.path === join(getInboxDir(), "abs.wav"), "absolute path passed through");
  r = resolveSourcePath(join(getInboxDir(), "..", "x.mp4"));
  assert(r.ok && !r.path.includes(".."), "absolute path with .. is normalized, not rejected");
  assert(validateInboxName("..\\x.mp4") !== null, "relative traversal name rejected");
  r = resolveSourcePath("bad.xyz");
  assert(!r.ok, "bad extension rejected via resolveSourcePath");

  // baseNameOf
  eq(baseNameOf("meeting.mp4"), "meeting", "baseNameOf strips extension");
  eq(baseNameOf(join(getOutDir(), "a.manifest.json")), "a", "baseNameOf strips .manifest.json");
  eq(baseNameOf("c/d/e.mp3"), "e", "baseNameOf handles full path");

  // manifest/result paths
  eq(manifestPathFor("meeting"), join(getOutDir(), "meeting.manifest.json"), "manifestPathFor");
  eq(resultPathFor("meeting", "text"), join(getOutDir(), "meeting.txt"), "resultPathFor text");
  eq(resultPathFor("meeting", "verbose_json"), join(getOutDir(), "meeting.verbose.json"), "resultPathFor verbose_json");
  eq(resultPathFor("meeting", "srt"), join(getOutDir(), "meeting.srt"), "resultPathFor srt");

  // manifestExists / sourceExists
  assert(manifestExists("meeting") === false, "manifestExists false when absent");
  fs.writeFileSync(manifestPathFor("meeting"), "{}");
  assert(manifestExists("meeting") === true, "manifestExists true after write");
  assert(sourceExists(join(getInboxDir(), "foo.mp4")) === true, "sourceExists true for inbox file");
  assert(sourceExists(join(getInboxDir(), "nope.mp4")) === false, "sourceExists false for missing");
  fs.rmSync(manifestPathFor("meeting"));

  // latestInboxFile
  const latest = latestInboxFile();
  assert(latest === join(getInboxDir(), "foo.mp4"), "latestInboxFile finds foo.mp4, ignores .gitkeep");

  // listOutFiles
  fs.writeFileSync(join(getOutDir(), "foo.txt"), "hello");
  const listed = listOutFiles();
  assert(listed.some((f) => f.name === "foo.txt"), "listOutFiles lists results");
  fs.rmSync(join(getOutDir(), "foo.txt"));

  // displayPath
  eq(displayPath(join(getInboxDir(), "meeting.mp4")), "inbox/meeting.mp4", "displayPath relative");

  // constants
  eq([...MODEL_CHOICES], ["gigaam", "whisper-large"], "MODEL_CHOICES");
  eq([...FORMAT_CHOICES], ["text", "srt", "vtt", "json", "verbose_json"], "FORMAT_CHOICES");
}

// --- output.ts ----------------------------------------------------------------

async function testOutput(): Promise<void> {
  section("output.ts");

  const base = "out-test";
  const p = resultPathFor(base, "text");
  fs.writeFileSync(p, "line1\nline2\nline3");

  let r = readResult(base, "text");
  assert(r.ok && r.text === "line1\nline2\nline3" && r.lines.length === 3, "readResult reads text");

  fs.rmSync(p);
  r = readResult(base, "text");
  assert(!r.ok, "readResult error for missing file");

  // truncateForChat
  const lines = Array.from({ length: 300 }, (_, i) => `L${i}`);
  const t = truncateForChat(lines, 200, "/tmp/x.txt");
  eq(t.total, 300, "truncate: total lines");
  assert(t.shown.split("\n").length === 200, "truncate: shown capped at 200");
  assert(t.note !== null && t.note.includes("первые 200"), "truncate: note mentions cap");
  const t2 = truncateForChat(["a"], 200, "/tmp/x.txt");
  eq(t2.note, null, "no note when short");

  // hasManifest
  fs.writeFileSync(manifestPathFor(base), "{}");
  assert(hasManifest(base) === true, "hasManifest true");
  fs.rmSync(manifestPathFor(base));
  assert(hasManifest(base) === false, "hasManifest false after remove");

  // summarizeOut
  fs.writeFileSync(join(getOutDir(), "a.txt"), "x");
  fs.writeFileSync(join(getOutDir(), "a.srt"), "x");
  fs.writeFileSync(join(getOutDir(), "b.manifest.json"), "{}");
  const summary = summarizeOut(listOutFiles().map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtime })));
  assert(summary.includes("a") && summary.includes("b"), "summarizeOut groups by base name");
  assert(summary.includes("a.txt") && summary.includes("a.srt"), "summarizeOut lists files");
  for (const f of ["a.txt", "a.srt", "b.manifest.json"]) fs.rmSync(join(getOutDir(), f));

  // fmtBytes
  eq(fmtBytes(10), "10 B", "fmtBytes small");
  eq(fmtBytes(2048), "2.0 KB", "fmtBytes KB");
  eq(fmtBytes(5 * 1024 * 1024), "5.0 MB", "fmtBytes MB");
}

// --- pipeline.ts (argv construction + fake python) ----------------------------

async function testPipelineUnit(): Promise<void> {
  section("pipeline.ts (argv)");

  const prepArgs = { input: "/x/foo.mp4", lang: "ru" };
  eq(
    prepareCommand(prepArgs),
    [join(getScriptsDir(), "prepare.py"), "/x/foo.mp4", "--lang", "ru"],
    "prepareCommand basic",
  );
  eq(
    prepareCommand({ ...prepArgs, lang: "en", chunkSeconds: 300 }),
    [join(getScriptsDir(), "prepare.py"), "/x/foo.mp4", "--lang", "en", "--chunk-seconds", "300"],
    "prepareCommand with chunk-seconds",
  );

  const trArgs = { input: "out/foo.manifest.json", model: "gigaam" as const, lang: "ru", format: "text" as const };
  eq(
    transcribeCommand(trArgs),
    [
      join(getScriptsDir(), "transcribe.py"),
      "out/foo.manifest.json",
      "--model", "gigaam",
      "--lang", "ru",
      "--format", "text",
      "--out-dir", getOutDir(),
      "--no-interactive",
    ],
    "transcribeCommand default (no-interactive)",
  );
  eq(
    transcribeCommand({ ...trArgs, model: "whisper-large", lang: "en", format: "srt", noInteractive: false }),
    [
      join(getScriptsDir(), "transcribe.py"),
      "out/foo.manifest.json",
      "--model", "whisper-large",
      "--lang", "en",
      "--format", "srt",
      "--out-dir", getOutDir(),
    ],
    "transcribeCommand whisper-large + srt, interactive allowed",
  );
}

async function testPipelineSpawn(): Promise<void> {
  section("pipeline.ts (spawn, fake scripts)");

  const argvFile = join(FIXTURE_ROOT, "argv.json");

  const p = await runPrepare(
    { input: join(getInboxDir(), "foo.mp4"), lang: "ru" },
    { python: "python", cwd: FAKE_PROJECT },
  );
  assert(p.ok, "runPrepare exits 0 with fake script");
  if (fs.existsSync(argvFile)) {
    const recorded = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    eq(recorded.args, [join(getInboxDir(), "foo.mp4"), "--lang", "ru"], "runPrepare argv recorded");
  }

  const t = await runTranscribe(
    { input: "out/foo.manifest.json", model: "gigaam", lang: "ru", format: "text" },
    { python: "python", cwd: FAKE_PROJECT },
  );
  assert(t.ok, "runTranscribe exits 0 with fake script");
  if (fs.existsSync(argvFile)) {
    const recorded = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    eq(recorded.args[0], "out/foo.manifest.json", "runTranscribe argv input");
    eq(recorded.args.slice(1, 5), ["--model", "gigaam", "--lang", "ru"], "runTranscribe argv flags");
    assert(recorded.args.includes("--no-interactive"), "runTranscribe passes --no-interactive");
  }
}

// --- prompt.ts ----------------------------------------------------------------

async function testPrompt(): Promise<void> {
  section("prompt.ts");

  const ui = {
    select: async (_t: string, items: string[]) => items[0],
    confirm: async () => true,
    notify: () => {},
  };
  eq(await askModelChoice(ui, "ru"), "gigaam", "askModelChoice picks first option");

  const uiCancel = {
    select: async () => undefined,
    confirm: async () => true,
    notify: () => {},
  };
  eq(await askModelChoice(uiCancel, "ru"), "gigaam", "askModelChoice cancel -> default gigaam");

  const ui2 = {
    select: async (_t: string, items: string[]) => items[1],
    confirm: async () => false,
    notify: () => {},
  };
  eq(await askModelChoice(ui2, "ru"), "whisper-large", "askModelChoice can pick whisper-large");

  eq(await askModelChoice(undefined, "ru"), "gigaam", "no UI -> default without prompting");
}

// --- integration: real python + ffmpeg + wormsoft API -------------------------

const REAL_PROJECT = "C:\\MyProjects\\transcribe";

function runCmd(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env }, windowsHide: true });
    let so = "", se = "";
    child.stdout?.on("data", (c: Buffer) => (so += c));
    child.stderr?.on("data", (c: Buffer) => (se += c));
    child.on("error", () => resolveP({ code: -1, stdout: so, stderr: se }));
    child.on("close", (code) => resolveP({ code: code ?? -1, stdout: so, stderr: se }));
  });
}

async function testIntegration(): Promise<void> {
  section("integration (real python + ffmpeg + API)");

  if (!fs.existsSync(join(REAL_PROJECT, "scripts", "prepare.py"))) {
    skip("integration", `реальный проект не найден: ${REAL_PROJECT}`);
    return;
  }

  const py = spawnSync("python", ["--version"], { windowsHide: true });
  if (py.status !== 0) {
    skip("integration", "python не найден в PATH");
    return;
  }
  const ff = spawnSync("ffmpeg", ["-version"], { windowsHide: true });
  if (ff.status !== 0) {
    console.log("  ✗ ffmpeg не найден в PATH — prepare.py не запустить (проблема окружения, не API).");
    failed++;
    failures.push("ffmpeg missing");
    return;
  }

  const token = process.env.WORMSOFT_TEST_TOKEN;
  const fixtureDir = join(FIXTURE_ROOT, "integration");
  const inbox = join(fixtureDir, "inbox");
  const out = join(fixtureDir, "out");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const wav = join(inbox, "tiny_silent.wav");

  // 1) Generate fixture audio: 2s sine wave (tone, not silence — but no speech).
  const gen = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "-ar", "16000", wav],
    { windowsHide: true },
  );
  if (gen.status !== 0 || !fs.existsSync(wav)) {
    console.log(`  ✗ ffmpeg не смог сгенерировать fixture:\n${gen.stderr.toString().slice(-500)}`);
    failed++;
    failures.push("fixture generation failed");
    return;
  }
  assert(true, "fixture tiny_silent.wav создан (2s sine 440 Hz)");

  const realPrepare = join(REAL_PROJECT, "scripts", "prepare.py");
  const realTranscribe = join(REAL_PROJECT, "scripts", "transcribe.py");

  // 2) Real prepare.py on the fixture (needs ffmpeg, not the API token).
  const prepProc = await runCmd("python", [realPrepare, wav, "--lang", "ru", "--out-dir", out, "--inbox-dir", inbox], REAL_PROJECT);
  if (prepProc.code !== 0) {
    console.log(`    prepare stdout: ${prepProc.stdout.slice(-400)}`);
    console.log(`    prepare stderr: ${prepProc.stderr.slice(-400)}`);
  }
  assert(prepProc.code === 0, "prepare.py exit 0 (реальный скрипт + ffmpeg)");
  const manifest = join(out, "tiny_silent.manifest.json");
  assert(fs.existsSync(manifest), "manifest tiny_silent.manifest.json создан");

  if (!token) {
    skip("transcribe API call", "WORMSOFT_TEST_TOKEN не задан — API-вызов пропускается (токен не хардкодится). Задай переменную, чтобы прогнать полностью.");
    return;
  }

  // 3) Real API call via transcribe.py.
  const trProc = await runCmd(
    "python",
    [realTranscribe, manifest, "--model", "gigaam", "--lang", "ru", "--format", "text", "--out-dir", out, "--no-interactive"],
    REAL_PROJECT,
  );
  if (trProc.code !== 0) {
    console.log(`    transcribe stdout: ${trProc.stdout.slice(-500)}`);
    console.log(`    transcribe stderr: ${trProc.stderr.slice(-500)}`);
  }
  assert(trProc.code === 0, "transcribe.py (реальный API wormsoft) exit 0");
  const txt = join(out, "tiny_silent.txt");
  assert(fs.existsSync(txt), "результат tiny_silent.txt создан");
}

// --- cleanup ------------------------------------------------------------------

function cleanup(): void {
  try {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {}
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("pi-transcribe tests");
  console.log(`fixture project: ${FAKE_PROJECT}`);

  setupFakeProject();

  await testPaths();
  await testOutput();
  await testPipelineUnit();
  await testPipelineSpawn();
  await testPrompt();
  await testIntegration();

  cleanup();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Test run crashed:", e);
  cleanup();
  process.exit(1);
});
