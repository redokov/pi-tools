#!/usr/bin/env node
// E2E test: per-room delete/terminate UI.
//   - index page: every room card has a "Close session" button -> DELETE /api/rooms/:name
//     (confirm-guarded; confirm-cancel keeps the room, confirm-ok destroys it)
//   - room page: "Delete" button in the toolbar -> destroys the room and navigates to '/',
//     a WS client attached to the room receives the 'exit' message (PTY killed)
// Pattern: test-e2e-mobile.cjs -- vanilla Node + raw CDP headless Chrome, no new deps.
// The test spawns ITS OWN server on a TEST port (default 7981); the production instance
// on 7681 (if running) is never touched.
// Screenshots: e2e-delete-*.png in the project root. Exit 0 on success, 1 on failure.
//
// Usage: node test-e2e-delete.cjs [port]

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.PI_REMOTE_DELETE_PORT || '7981', 10);
const BASE = `http://localhost:${PORT}`;
const ROOM = 'delui';
const CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : (process.env.CHROME_PATH || '/usr/bin/google-chrome');

let serverProc = null;
let serverLogTail = '';
let chromeProc = null;
let cdpWs = null;
let cdpPort = 9200 + Math.floor(Math.random() * 50);
let cdpTargetId = null;
let cdpSeq = 0;
const cdpPending = new Map();

function log(...a) { console.log('[e2e-delete]', ...a); }
function ok(step, msg) { console.log(`OK: ${step}${msg ? ' ' + msg : ''}`); }

// ---------- HTTP helpers (plain node) ----------
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
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
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
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const st = await cdpEval('document.readyState');
    if (st === 'complete') return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('navigate timeout: ' + url);
}

async function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v = false;
    try { v = await fn(); } catch (e) {}
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for: ' + label);
}

async function screenshot(name) {
  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, name), Buffer.from(shot.data, 'base64'));
  log('Screenshot saved: ' + name);
}

// ---------- test server lifecycle ----------
function startServer() {
  return new Promise((resolve, reject) => {
    log('spawning test server on port ' + PORT + ' (production on 7681 is not touched)');
    serverProc = spawn(process.execPath, [
      path.join(__dirname, 'server.js'), String(PORT), 'cmd.exe', 'C:\\MyProjects', '3600',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    serverProc.stdout.on('data', c => { out += c; if (out.length > 20000) out = out.slice(-20000); serverLogTail = out; });
    serverProc.stderr.on('data', c => { out += c; if (out.length > 20000) out = out.slice(-20000); serverLogTail = out; });
    const deadline = Date.now() + 15000;
    (function poll() {
      httpJson(BASE + '/health').then(r => {
        if (r.status === 200 && r.body && r.body.ok) return resolve();
        retry();
      }).catch(retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('test server did not start on port ' + PORT + '\n' + out));
        setTimeout(poll, 200);
      }
    })();
  });
}

function killServer() {
  if (!serverProc) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { serverProc.kill(); } catch {} }
  } else {
    try { serverProc.kill('SIGTERM'); } catch {}
  }
}

async function roomExists() {
  const r = await httpJson(BASE + '/api/rooms/' + ROOM);
  return r.status === 200;
}

async function createRoom() {
  const cr = await httpJson(BASE + '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: ROOM, cwd: 'C:\\MyProjects', cmd: 'cmd.exe' }),
  });
  if (cr.status !== 200) throw new Error('room creation failed: ' + JSON.stringify(cr.body));
}

// ---------- Chrome lifecycle ----------
async function startChrome() {
  const tmp = path.join(os.tmpdir(), 'pi-remote-delete-chrome-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmp}`,
    '--window-size=1280,800',
    'about:blank',
  ];
  chromeProc = spawn(CHROME, args, { stdio: 'ignore' });
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

// ---------- Scenarios ----------

// D1: index page -- card button exists; confirm-cancel keeps the room; confirm-ok deletes it.
async function d1() {
  log('D1: index page "Close session" button on room cards');
  await cdpNavigate(BASE + '/');
  await waitUntil(async () => await cdpEval(`!!document.querySelector('#rooms .card')`), 10000, 'room cards rendered');
  // our room's card must carry the delete button
  const cardInfo = JSON.parse(await cdpEval(`JSON.stringify((function () {
    var cards = [...document.querySelectorAll('#rooms .card')];
    var card = cards.find(function (c) { var a = c.querySelector('a'); return a && a.textContent === ${JSON.stringify(ROOM)}; });
    if (!card) return null;
    var b = card.querySelector('button.del');
    return { hasDel: !!b, label: b ? b.textContent : null };
  })())`));
  if (!cardInfo) throw new Error('D1: card for room "' + ROOM + '" not found on the index page');
  if (!cardInfo.hasDel) throw new Error('D1: room card has no "Close session" button');
  ok('D1-button', 'card has button "' + cardInfo.label.trim() + '"');
  await screenshot('e2e-delete-index.png');
  // confirm-cancel: room must survive
  await cdpEval(`window.__confirmResult = false; window.confirm = function () { return window.__confirmResult; }; true`);
  await cdpEval(`(function () {
    var cards = [...document.querySelectorAll('#rooms .card')];
    var card = cards.find(function (c) { var a = c.querySelector('a'); return a && a.textContent === ${JSON.stringify(ROOM)}; });
    card.querySelector('button.del').click();
    return true;
  })()`);
  await waitMs(700);
  if (!(await roomExists())) throw new Error('D1: room was deleted despite confirm() = false');
  const cardStill = await cdpEval(`[...document.querySelectorAll('#rooms .card')].some(function (c) { var a = c.querySelector('a'); return a && a.textContent === ${JSON.stringify(ROOM)}; })`);
  if (!cardStill) throw new Error('D1: card disappeared despite confirm() = false');
  ok('D1-cancel', 'confirm() = false: room kept, card still rendered');
  // confirm-ok: room must be destroyed, card must disappear
  await cdpEval(`window.__confirmResult = true; true`);
  await cdpEval(`(function () {
    var cards = [...document.querySelectorAll('#rooms .card')];
    var card = cards.find(function (c) { var a = c.querySelector('a'); return a && a.textContent === ${JSON.stringify(ROOM)}; });
    card.querySelector('button.del').click();
    return true;
  })()`);
  await waitUntil(async () => !(await roomExists()), 8000, 'room deleted via index card button');
  await waitUntil(async () => !(await cdpEval(`[...document.querySelectorAll('#rooms .card')].some(function (c) { var a = c.querySelector('a'); return a && a.textContent === ${JSON.stringify(ROOM)}; })`)), 8000, 'card removed from the index');
  ok('D1-delete', 'confirm() = true: room destroyed (API 404), card removed');
}

// D2: room page -- toolbar Delete button destroys the room, navigates to '/',
// and a WS client attached to the room receives the 'exit' message (PTY killed).
async function d2() {
  log('D2: room page "Delete" button in the toolbar');
  await createRoom();
  // attach a plain WS client to the room BEFORE the UI delete: it must receive 'exit'
  const WebSocket = require('ws').WebSocket || require('ws');
  const roomWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}`);
  await new Promise((resolve, reject) => {
    roomWs.on('open', resolve);
    roomWs.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 8000);
  });
  const exitPromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 10000);
    roomWs.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'exit') { clearTimeout(t); resolve('exit-message'); }
    });
    roomWs.on('close', () => { clearTimeout(t); resolve('ws-closed'); });
  });
  await cdpNavigate(BASE + '/room/' + ROOM);
  await waitUntil(async () => await cdpEval(`!!window.xterm && !!document.querySelector('.xterm-rows')`), 15000, 'xterm init');
  await waitMs(1200); // let the PTY prompt arrive
  const btn = await cdpEval(`(function () {
    var b = document.getElementById('delBtn');
    return b ? { text: b.textContent, visible: b.offsetParent !== null } : null;
  })()`);
  if (!btn) throw new Error('D2: toolbar has no Delete button (#delBtn)');
  if (!btn.visible) throw new Error('D2: Delete button is not visible');
  ok('D2-button', 'toolbar button "' + btn.text.trim() + '" is visible');
  await screenshot('e2e-delete-room-bar.png');
  // confirm-cancel keeps the room
  await cdpEval(`window.__confirmResult = false; window.confirm = function () { return window.__confirmResult; }; true`);
  await cdpEval(`document.getElementById('delBtn').click(); true`);
  await waitMs(700);
  if (!(await roomExists())) throw new Error('D2: room was deleted despite confirm() = false');
  ok('D2-cancel', 'confirm() = false: room kept, still on the room page');
  // confirm-ok: room destroyed + navigated back to '/'
  await cdpEval(`window.__confirmResult = true; true`);
  await cdpEval(`document.getElementById('delBtn').click(); true`);
  await waitUntil(async () => (await cdpEval(`location.pathname`)) === '/', 10000, 'navigation back to /');
  if (await roomExists()) throw new Error('D2: room still exists after Delete click');
  const exitResult = await exitPromise;
  if (exitResult === 'timeout') throw new Error('D2: WS client got neither "exit" message nor close (PTY not terminated?)');
  ok('D2-delete', 'room destroyed (API 404), navigated to /, WS got: ' + exitResult);
  try { roomWs.close(); } catch {}
  await screenshot('e2e-delete-after.png');
}

// ---------- main ----------
async function main() {
  let code = 1;
  try {
    await startServer();
    await createRoom();
    await startChrome();
    log('Chrome ready on CDP port ' + cdpPort);
    await d1();
    await d2();
    console.log('ALL OK');
    code = 0;
  } catch (e) {
    console.error('FAIL', (e && e.message) || e);
    if (serverLogTail) console.error('--- server log tail ---\n' + serverLogTail.slice(-1500));
    code = 1;
  }
  try { await httpJson(BASE + '/api/rooms/' + ROOM, { method: 'DELETE' }); } catch {}
  stopChrome();
  killServer();
  process.exit(code);
}

main();