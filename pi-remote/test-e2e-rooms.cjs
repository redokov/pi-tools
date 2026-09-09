#!/usr/bin/env node
// E2E tests for pi-remote: room creation, auto-name, Start click, restart.
// Vanilla Node + ws + CDP (no puppeteer/playwright).
//
// NOTE (auth): runs against a LIVE server (default port 7681) that now requires a
// session cookie. The test logs in via CDP using the password from PI_REMOTE_PASSWORD
// or from the .env file next to server.js (the password is never logged). If the
// server is not reachable, the test prints SKIP and exits 0 (does not block CI).
//
// Spawns a headless Chrome with --remote-debugging-port, drives it via raw CDP
// (WebSocket), navigates to the pi-remote server, and asserts:
//   1. Auto-name: selecting a project populates #name with a transliterated name.
//   2. Start: clicking Start creates a room, navigates to /room/:name, renders xterm.
//   3. Restart: clicking Restart pi on a room page re-spawns the PTY, xterm stays active.
//
// Usage: node test-e2e-rooms.cjs [port]
// Exit code 0 on success, non-zero on any failure.

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.PI_REMOTE_PORT || '7681', 10);
const BASE = `http://localhost:${PORT}`;
const CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : (process.env.CHROME_PATH || '/usr/bin/google-chrome');

const SHOTS_DIR = path.join(__dirname, '');
function shotName() { return null; } // screenshots are captured by the caller (pi-remote agent)

let chromeProc = null;
let cdpWs = null;
let cdpPort = 9222;
let cdpTargetId = null;
let cdpSeq = 0;
const cdpPending = new Map();

function log(...a) { console.log('[e2e]', ...a); }
function fail(step, reason) {
  console.error(`FAIL ${step} ${reason}`);
  process.exit(1);
}
function ok(step, msg) { console.log(`OK: ${step}${msg ? ' ' + msg : ''}`); }

// ---------- HTTP helpers (plain node) ----------
let apiCookie = '';
function authHeaders() { return apiCookie ? { Cookie: apiCookie } : {}; }

// password for the live server: env var first, then .env (never logged)
function readEnvPassword() {
  if (process.env.PI_REMOTE_PASSWORD) return process.env.PI_REMOTE_PASSWORD;
  try {
    const t = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*PI_REMOTE_PASSWORD\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}

async function httpLogin(pw) {
  const r = await httpJson(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ password: pw, next: '/' }) });
  if (r.status !== 200) throw new Error('http login failed: ' + r.status);
  const sc = r.headers['set-cookie'] || [];
  apiCookie = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]).join('; ');
}

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------- CDP helpers ----------
function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSeq;
    cdpPending.set(id, { resolve, reject });
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

function cdpSetup() {
  return new Promise((resolve, reject) => {
    const ws = new (require('ws').WebSocket || require('ws'))(`ws://127.0.0.1:${cdpPort}/devtools/page/${cdpTargetId}`);
    ws.on('open', () => { cdpWs = ws; resolve(); });
    ws.on('close', () => { cdpWs = null; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id && cdpPending.has(msg.id)) {
        const p = cdpPending.get(msg.id); cdpPending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function cdpEval(expr, awaitPromise = true) {
  const r = await cdpSend('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('CDP eval exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

async function cdpNavigate(url) {
  await cdpSend('Page.navigate', { url });
  // Wait for load
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const st = await cdpEval('document.readyState');
    if (st === 'complete') return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('navigate timeout: ' + url);
}

async function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

function serverLogSize() {
  try { return fs.statSync(path.join(__dirname, 'server.log')).size; } catch { return 0; }
}
function serverLogTail(fromByte) {
  try {
    const fd = fs.openSync(path.join(__dirname, 'server.log'), 'r');
    const len = fs.fstatSync(fd).size - fromByte;
    if (len <= 0) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromByte);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for: ' + label);
}

// ---------- Chrome lifecycle ----------
async function startChrome() {
  // Pick a free port
  cdpPort = 9200 + Math.floor(Math.random() * 50);
  const tmp = path.join(os.tmpdir(), 'pi-remote-chrome-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmp}`,
    `--window-size=1280,800`,
    'about:blank',
  ];
  chromeProc = spawn(CHROME, args, { stdio: 'ignore' });
  // Wait for CDP
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/version' }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
      });
      const v = JSON.parse(r);
      if (v.webSocketDebuggerUrl) {
        // Find the "page" target (the about:blank tab)
        const targets = await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/list' }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          });
          req.on('error', reject);
        });
        const list = JSON.parse(targets);
        const page = list.find(t => t.type === 'page') || list[0];
        if (!page) throw new Error('no page target');
        cdpTargetId = page.id;
        await cdpSetup();
        await cdpSend('Runtime.enable');
        await cdpSend('Page.enable');
        return;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Chrome CDP did not come up');
}

function stopChrome() {
  try { if (chromeProc) chromeProc.kill(); } catch {}
  try { if (cdpWs) cdpWs.close(); } catch {}
}

// ---------- Tests ----------

async function testAutoName() {
  log('Test 1: auto-name on project select');
  await cdpNavigate(BASE + '/');
  await waitUntil(async () => await cdpEval(`document.querySelectorAll('#cwd option').length > 1`), 10000, 'projects loaded');
  const opts = await cdpEval(`JSON.stringify([...document.querySelectorAll('#cwd option')].map(o => ({v:o.value, t:o.textContent})))`);
  const list = JSON.parse(opts);
  // Pick a project that is NOT the root (v !== '')
  const target = list.find(o => o.v && o.v.length > 2) || list[1];
  if (!target) throw new Error('no project option');
  // Cyrillic project for transliteration check (if present), else any
  const cyr = list.find(o => o.v && /[\u0400-\u04FF]/.test(o.v));
  const pick = cyr || target;
  await cdpEval(`(() => {
    const sel = document.getElementById('cwd');
    sel.value = ${JSON.stringify(pick.v)};
    sel.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await waitMs(50);
  const nameVal = await cdpEval(`document.getElementById('name').value`);
  const cwdVal = await cdpEval(`document.getElementById('cwdCustom').value`);
  // Verify name is non-empty and transliterated (no Cyrillic, lowercase, latin+digits+_-)
  if (!nameVal || nameVal.length === 0) fail('auto-name', 'name is empty after select');
  if (/[а-яА-ЯёЁ]/.test(nameVal)) fail('auto-name', `name has Cyrillic: ${nameVal}`);
  if (nameVal !== nameVal.toLowerCase()) fail('auto-name', `name not lowercase: ${nameVal}`);
  if (nameVal.length > 40) fail('auto-name', `name too long: ${nameVal}`);
  if (!nameVal) fail('auto-name', 'empty name');
  ok('auto-name', `picked "${pick.t}" -> name="${nameVal}", cwd="${cwdVal}"`);
  // Screenshot
  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-room-fixed.png'), Buffer.from(shot.data, 'base64'));
  log('Screenshot saved: e2e-room-fixed.png');

  // Verify manual typing still works
  const manualOk = await cdpEval(`(() => {
    const n = document.getElementById('name');
    const before = n.value;
    n.value = 'manual-test';
    const editable = n.readOnly === false && !n.disabled;
    n.value = before;
    return editable;
  })()`);
  if (!manualOk) fail('auto-name', 'name field is readonly/disabled');
  ok('auto-name-manual', 'field is editable');

  // Verify empty option clears name
  const cleared = await cdpEval(`(() => {
    const sel = document.getElementById('cwd');
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    return document.getElementById('name').value === '';
  })()`);
  if (cleared !== true) fail('auto-name', 'empty option did not clear name');
  ok('auto-name-clear', 'root option clears name');
}

async function testStart() {
  log('Test 2: Start button creates room and renders xterm');
  // Pick a fresh project (use a unique subfolder to avoid 409)
  const uniq = 'e2e_' + Date.now().toString(36);
  const uniqDir = `C:\\MyProjects\\${uniq}`;
  fs.mkdirSync(uniqDir, { recursive: true });

  await cdpNavigate(BASE + '/');
  await waitUntil(async () => await cdpEval(`document.querySelectorAll('#cwd option').length > 1`), 10000, 'projects loaded');
  // Set cwdCustom to the fresh dir (the select may not include it, but createRoom reads cwdCustom)
  await cdpEval(`(() => { document.getElementById('name').value = 'e2e_start'; document.getElementById('cwdCustom').value = ${JSON.stringify(uniqDir)}; return true; })()`);
  const logOffsetStart = serverLogSize();
  const beforeUrl = await cdpEval(`location.href`);
  await cdpEval(`(() => { createRoom(); return true; })()`);
  // Wait for navigation to /room/...
  await waitUntil(async () => (await cdpEval(`location.pathname`)).startsWith('/room/'), 15000, 'navigation to /room/');
  // Wait for xterm to fully initialize (DOM + cursor element)
  await waitUntil(async () => await cdpEval(`!!document.querySelector('.xterm') && !!document.querySelector('.xterm-rows') && !!document.querySelector('.xterm-cursor')`), 15000, 'xterm init (cursor)');
  await waitMs(5000); // let PTY spawn, xterm paint pi TUI (pi startup ~3s + render)
  const state = await cdpEval(`JSON.stringify({
    url: location.href,
    xterm: !!document.querySelector('.xterm'),
    xtermRows: !!document.querySelector('.xterm-rows'),
    xtermCursor: !!document.querySelector('.xterm-cursor'),
    msg: document.getElementById('msg').textContent,
    xtermLoaded: typeof Terminal,
    fitLoaded: typeof FitAddon
  })`);
  const s = JSON.parse(state);
  if (s.url === beforeUrl) fail('start', 'URL did not change after Start');
  if (!s.xterm) fail('start', 'no .xterm element in DOM');
  if (!s.xtermRows) fail('start', 'no .xterm-rows in DOM');
  if (s.msg && /error|fail|failed/i.test(s.msg)) fail('start', `msg shows error: ${s.msg}`);
  // server.log must contain the join line for this room
  const logTail = serverLogTail(logOffsetStart);
  if (!logTail.includes(`[+] client joined "e2e_start"`)) fail('start', 'server.log has no [+] client joined "e2e_start" line');
  ok('start', `room created at ${s.url}, xterm=${s.xterm}, rows=${s.xtermRows}, cursor=${s.xtermCursor}, msg="${s.msg}", log=[+] client joined`);
  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-start-after.png'), Buffer.from(shot.data, 'base64'));
  log('Screenshot saved: e2e-start-after.png');
  return { uniqDir, roomName: (await cdpEval(`location.pathname.slice(6)`)).split('?')[0] };
}

async function testRestart(roomInfo) {
  log('Test 3: Restart pi on room page re-spawns PTY');
  const { uniqDir, roomName } = roomInfo;
  await cdpNavigate(BASE + '/room/' + encodeURIComponent(roomName));
  await waitMs(4000); // let xterm repaint pi TUI after restart
  // Click Restart
  const logOffsetRestart = serverLogSize();
  await cdpEval(`(() => { restartRoom(); return true; })()`);
  // Wait for restart to complete (fetch + reconnect)
  await waitUntil(async () => {
    const v = await cdpEval(`document.getElementById('msg').textContent`);
    return /reconnected|connected|restarted/i.test(v) || v === '';
  }, 15000, 'restart to settle');
  await waitMs(1500);
  const state = await cdpEval(`JSON.stringify({
    xterm: !!document.querySelector('.xterm'),
    xtermRows: !!document.querySelector('.xterm-rows'),
    xtermCursor: !!document.querySelector('.xterm-cursor'),
    msg: document.getElementById('msg').textContent,
    url: location.href
  })`);
  const s = JSON.parse(state);
  if (!s.xterm) fail('restart', 'xterm missing after restart');
  if (!s.xtermRows) fail('restart', 'xterm-rows missing after restart');
  if (s.msg && /error|fail|failed/i.test(s.msg)) fail('restart', `msg shows error: ${s.msg}`);
  // server.log must contain a fresh "room created" line after the restart
  const logTailR = serverLogTail(logOffsetRestart);
  if (!logTailR.includes(`[+] room "${roomName}" created`)) fail('restart', `server.log has no fresh [+] room "${roomName}" created line`);
  ok('restart', `xterm active after restart: url=${s.url}, msg="${s.msg}", log=[+] room "${roomName}" created`);
  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-restart.png'), Buffer.from(shot.data, 'base64'));
  log('Screenshot saved: e2e-restart.png');
  // Cleanup: delete the e2e room and folder
  try { await httpJson(`${BASE}/api/rooms/${encodeURIComponent(roomName)}`, { method: 'DELETE', headers: authHeaders() }); } catch {}
  try { fs.rmSync(uniqDir, { recursive: true, force: true }); } catch {}
}

// Login through the real login page in the CDP browser (auth is required on the live server).
async function cdpLogin(pw) {
  await cdpNavigate(BASE + '/');
  await waitUntil(async () => await cdpEval(`location.pathname === '/login' && !!document.getElementById('pw')`), 10000, 'login form');
  await cdpEval(`document.getElementById('pw').value = ${JSON.stringify(pw)}; true`);
  await cdpEval(`document.getElementById('loginBtn').click(); true`);
  await waitUntil(async () => await cdpEval(`location.pathname === '/' && !!document.querySelector('.new')`), 10000, 'redirect to index after login');
  ok('login', 'CDP login form submitted, redirected back to the index');
}

async function main() {
  // live server pre-check: skip (exit 0) when it is not running
  try {
    const h = await httpJson(BASE + '/health');
    if (h.status !== 200 || !h.body.ok) throw new Error('health: ' + h.status);
  } catch (e) {
    console.log('SKIP: no live pi-remote server on port ' + PORT + ' (' + (e.message || e) + ')');
    process.exit(0);
  }
  // auth pre-check: the running server must be the auth-enabled build (302 to /login)
  const page = await httpJson(BASE + '/');
  if (page.status !== 302) {
    console.log('SKIP: live server on port ' + PORT + ' does not redirect to /login (pre-auth build still running; restart it to test auth)');
    process.exit(0);
  }
  const password = readEnvPassword();
  if (!password) {
    console.log('SKIP: PI_REMOTE_PASSWORD not found (env or .env) -- cannot log in to the live server');
    process.exit(0);
  }
  await httpLogin(password);
  log('http login ok, session cookie captured');
  log('Starting headless Chrome via CDP...');
  await startChrome();
  log('Chrome ready on CDP port ' + cdpPort);
  await cdpLogin(password);
  try {
    await testAutoName();
    const roomInfo = await testStart();
    await testRestart(roomInfo);
    console.log('ALL OK');
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e.message || e);
    process.exit(1);
  } finally {
    stopChrome();
  }
}

main();
