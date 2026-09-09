#!/usr/bin/env node
// E2E MOBILE tests for pi-remote (TZ-mobile-ui-fixes.md, section 6.1, scenarios T1..T5).
// Pattern: test-e2e-rooms.cjs -- vanilla Node + raw CDP + headless Chrome, no new deps.
//
// The test spawns ITS OWN server instance on a TEST port (default 7981) and creates a
// cmd.exe room. The production instance on port 7681 (if running) is never touched.
// Mobile emulation: Emulation.setDeviceMetricsOverride 390x844 DSF3 mobile:true +
// Emulation.setTouchEmulationEnabled.
//
// Scenarios:
//   T1: typing with spaces (RU+EN) via Input.insertText; page/.xterm-viewport scrollLeft
//       must stay 0 at every step; .xterm-screen left drift <= 2px; screenshots.
//   T2: fill the buffer (cmd for-loop), touch swipe up, tap the "scroll to bottom" button.
//   T3: rotation (device metrics override): resize message must be sent over WS (ws.send hook),
//       PTY actually resized (mode con), and after rotation from an arbitrary position we
//       always land at the bottom.
//   T4: virtual keys panel: tap every button (incl. 6 Ctrl combos) and compare the intercepted
//       ws.send bytes with the TZ table; xterm focus must not be lost; localStorage state.
//   T5: regression: xterm created, a typed key reaches the PTY and is rendered in .xterm-rows.
//
// Auth: the test server is spawned with PI_REMOTE_PASSWORD in env; the test logs in
// via a plain HTTP login (cookie for the API helpers) and via the CDP browser
// (login form UI, same pattern as test-e2e-delete.cjs).
//
// Artifacts: e2e-mobile-*.png screenshots in the project root.
// Usage: node test-e2e-mobile.cjs [port]
// Exit code 0 on success, 1 on any failure.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.PI_REMOTE_MOBILE_PORT || '7981', 10);
const BASE = `http://localhost:${PORT}`;
const ROOM = 'e2emob';
const PASSWORD = 'mobile-e2e-password';
const CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : (process.env.CHROME_PATH || '/usr/bin/google-chrome');

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

// TZ table (section 3.2): label -> expected bytes sent over WS (hex), variant A Ctrl combos.
// Note: standard xterm arrow sequences: A=up, B=down, C=right(forward), D=left(back);
// the TZ example "\\x1b[A" for the up arrow confirms the standard mapping.
const EXPECTED_KEYS = [
  { l: 'Esc', hex: '1b' },
  { l: 'Tab', hex: '09' },
  { l: '\u2191', hex: '1b5b41' },
  { l: '\u2193', hex: '1b5b42' },
  { l: '\u2190', hex: '1b5b44' },
  { l: '\u2192', hex: '1b5b43' },
  { l: 'Home', hex: '1b5b48' },
  { l: 'End', hex: '1b5b46' },
  { l: 'PgUp', hex: '1b5b357e' },
  { l: 'PgDn', hex: '1b5b367e' },
  { l: 'Enter', hex: '0d' },
  { l: 'Ctrl+C', hex: '03' },
  { l: 'Ctrl+D', hex: '04' },
  { l: 'Ctrl+Z', hex: '1a' },
  { l: 'Ctrl+U', hex: '15' },
  { l: 'Ctrl+R', hex: '12' },
  { l: 'Ctrl+L', hex: '0c' },
];

let serverProc = null;
let serverLogTail = '';
let chromeProc = null;
let cdpWs = null;
let cdpPort = 9200 + Math.floor(Math.random() * 50);
let cdpTargetId = null;
let cdpSeq = 0;
const cdpPending = new Map();

function log(...a) { console.log('[e2e-mobile]', ...a); }
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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------- CDP helpers (same pattern as test-e2e-rooms.cjs) ----------
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
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for: ' + label + (lastErr ? ' (' + lastErr.message + ')' : ''));
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
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_REMOTE_PASSWORD: PASSWORD } });
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

// ---------- Chrome lifecycle ----------
async function startChrome() {
  cdpPort = 9200 + Math.floor(Math.random() * 50);
  const tmp = path.join(os.tmpdir(), 'pi-remote-mobile-chrome-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmp}`,
    '--window-size=390,844',
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

// ---------- mobile emulation ----------
async function setMetrics(m) {
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width: m.width, height: m.height, deviceScaleFactor: 3, mobile: true,
  });
}

// In-page bootstrap: ws.send hook (captures every frame the page sends) + drain helper.
// Must be installed BEFORE the page scripts run.
const WS_HOOK = `
window.__wsLog = [];
window.__drainWsLog = function () { var l = window.__wsLog.slice(); window.__wsLog.length = 0; return l; };
(function () {
  var Orig = window.WebSocket;
  function Patched(url) {
    var sock = new Orig(url);
    var origSend = sock.send.bind(sock);
    sock.send = function (d) { try { window.__wsLog.push(String(d)); } catch (e) {} return origSend(d); };
    return sock;
  }
  Patched.prototype = Orig.prototype;
  try { Patched.CONNECTING = 0; Patched.OPEN = 1; Patched.CLOSING = 2; Patched.CLOSED = 3; } catch (e) {}
  window.WebSocket = Patched;
})();
`;

// ---------- touch helpers (Emulation.setTouchEmulationEnabled is on) ----------
async function tapAt(x, y) {
  await cdpSend('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await waitMs(40);
  await cdpSend('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function swipe(x0, y0, x1, y1, steps = 10, delayMs = 30) {
  await cdpSend('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  await waitMs(40);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps;
    const y = y0 + (y1 - y0) * i / steps;
    await cdpSend('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await waitMs(delayMs);
  }
  await cdpSend('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function centerOf(sel) {
  const s = await cdpEval(`JSON.stringify((function () {
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })())`);
  const v = JSON.parse(s);
  if (!v) throw new Error('element not found: ' + sel);
  return v;
}

// ---------- page-state readers ----------
async function bufState() {
  const s = await cdpEval(`JSON.stringify((function () {
    if (!window.xterm) return null;
    var buf = xterm.buffer.active;
    return { viewportY: buf.viewportY, length: buf.length, rows: xterm.rows, cols: xterm.cols,
             bottom: Math.max(0, buf.length - xterm.rows) };
  })())`);
  const v = JSON.parse(s);
  if (!v) throw new Error('xterm is not initialized on the page');
  return v;
}

async function btDisplay() {
  return await cdpEval(`(function () {
    var b = document.getElementById('bt');
    return b ? (b.style.display || getComputedStyle(b).display) : 'missing';
  })()`);
}

async function hMetrics() {
  const s = await cdpEval(`JSON.stringify((function () {
    var sc = document.scrollingElement,
        vp = document.querySelector('.xterm-viewport'),
        scr = document.querySelector('.xterm-screen');
    return { pageSL: sc ? sc.scrollLeft : -1,
             vpSL: vp ? vp.scrollLeft : -1,
             screenLeft: scr ? scr.getBoundingClientRect().left : -999 };
  })())`);
  return JSON.parse(s);
}

async function bufferText(lines) {
  return await cdpEval(`(function () {
    var buf = xterm.buffer.active, out = [];
    for (var i = Math.max(0, buf.length - ${lines}); i < buf.length; i++) {
      var l = buf.getLine(i);
      if (l) out.push(l.translateToString(true));
    }
    return out.join('\\n');
  })()`);
}

async function drainWsLog() {
  return JSON.parse(await cdpEval('JSON.stringify(__drainWsLog())'));
}

// Drag the finger down (= scroll up into history) until the viewport detaches from the
// bottom. Synthetic touch scroll physics in headless can under-scroll a single gesture,
// so retry up to 4 times. Returns the detached buffer state.
async function detachBySwipe(x) {
  let st = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await swipe(x, 120, x, 360, 14, 25);
    await waitMs(450);
    st = await bufState();
    if (st.viewportY < st.bottom - 1) return st;
  }
  throw new Error('could not detach from the bottom by swipe (viewportY=' + st.viewportY + ', bottom=' + st.bottom + ')');
}

function parseFrames(frames) {
  return frames.map(f => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
}

// ---------- Scenarios ----------

// T1: typing with spaces (RU+EN) keeps every scrollable level at scrollLeft 0,
// .xterm-screen does not drift horizontally.
async function t1() {
  log('T1: typing RU+EN with spaces, horizontal clamp');
  await cdpEval(`(function () {
    var ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    return document.activeElement === ta;
  })()`);
  await screenshot('e2e-mobile-t1-before.png');
  // "privet mir test 123" -- RU+EN with spaces, as in the TZ acceptance 1.3
  const chunks = ['\u043f\u0440\u0438\u0432\u0435\u0442', ' ', '\u043c\u0438\u0440', ' ', 'test', ' ', '123'];
  let base = null;
  for (let i = 0; i < chunks.length; i++) {
    await cdpSend('Input.insertText', { text: chunks[i] });
    await waitMs(220);
    const m = await hMetrics();
    if (m.pageSL !== 0) throw new Error('T1: page scrollLeft=' + m.pageSL + ' after chunk #' + i);
    if (m.vpSL !== 0) throw new Error('T1: .xterm-viewport scrollLeft=' + m.vpSL + ' after chunk #' + i);
    if (base === null) base = m.screenLeft;
    const drift = Math.abs(m.screenLeft - base);
    if (drift > 2) throw new Error('T1: .xterm-screen left drifted ' + drift.toFixed(1) + 'px after chunk #' + i);
    if (i === 3) await screenshot('e2e-mobile-t1-during.png');
  }
  await screenshot('e2e-mobile-t1-after.png');
  // make sure the latin part actually reached the terminal (cmd.exe echoes it back);
  // search recent buffer lines -- the prompt line may sit high above the empty viewport rows
  const txt = await bufferText(60);
  if (!txt.includes('test') || !txt.includes('123')) {
    throw new Error('T1: typed text did not reach the terminal; recent lines: ' + JSON.stringify(txt.slice(-300)));
  }
  ok('T1', 'scrollLeft(page)=0, scrollLeft(.xterm-viewport)=0 at every step; .xterm-screen drift <= 2px; text echoed');
}

// T2: fill the buffer, touch-swipe up, tap the "scroll to bottom" button.
async function t2() {
  log('T2: fill buffer, touch swipe up, tap "down Bt"');
  await drainWsLog(); // discard setup noise (prompt, initial resize)
  // flush whatever is pending on the cmd input line from T1, then fill the buffer
  await cdpEval(`sendInput('\\r')`);
  await waitMs(600);
  await cdpEval(`sendInput('for /l %i in (1,1,200) do @echo LINE-%i-of-200 ..........................................\\r')`);
  await waitMs(3000);
  let st = await bufState();
  if (st.length < st.rows + 50) throw new Error('T2: buffer not filled, length=' + st.length);
  if (st.viewportY !== st.bottom) throw new Error('T2: expected to be at bottom after output, viewportY=' + st.viewportY + '/' + st.bottom);
  if (await btDisplay() !== 'none') throw new Error('T2: Bt button must be hidden at the bottom');
  ok('T2-fill', 'buffer filled (' + st.length + ' lines), at bottom, Bt hidden');
  // touch swipe (finger dragged down = scroll up into history) -> detach from the bottom
  // -> the button appears (position is checked every 500ms)
  st = await detachBySwipe(195);
  await waitUntil(async () => (await btDisplay()) === 'block', 2500, 'Bt button becomes visible after swipe');
  await waitUntil(async () => (await btDisplay()) === 'block', 2500, 'Bt button becomes visible after swipe');
  st = await bufState();
  if (!(st.viewportY < st.bottom - 1)) {
    throw new Error('T2: expected to be detached from the bottom after swipe, viewportY=' + st.viewportY + '/' + st.bottom);
  }
  ok('T2-swipe', 'detached: viewportY=' + st.viewportY + ', bottom=' + st.bottom + ', Bt visible');
  await screenshot('e2e-mobile-t2-bt-visible.png');
  // tap the button -> back to the bottom, button hides
  const c = await centerOf('#bt');
  await tapAt(c.x, c.y);
  await waitMs(500);
  st = await bufState();
  if (st.viewportY !== st.bottom) throw new Error('T2: Bt tap did not return to the bottom, viewportY=' + st.viewportY + '/' + st.bottom);
  if (await btDisplay() !== 'none') throw new Error('T2: Bt button must hide after the tap');
  ok('T2-bt', 'after tap: viewportY=' + st.viewportY + ' == bottom=' + st.bottom + ', Bt hidden');
  await screenshot('e2e-mobile-t2-bt-after.png');
}

// T3: rotation -> resize message over WS, PTY really resized, always land at the bottom.
async function t3() {
  log('T3: rotation (portrait -> landscape -> portrait)');
  await drainWsLog();
  await screenshot('e2e-mobile-t3-portrait.png');
  await setMetrics(LANDSCAPE);
  await waitMs(1300); // debounce 150ms + double rAF + ws roundtrip
  const resizes = parseFrames(await drainWsLog()).filter(m => m.type === 'resize');
  if (!resizes.length) throw new Error('T3: no resize message sent after rotation (ws.send hook)');
  const r0 = resizes[resizes.length - 1];
  if (!(r0.cols > r0.rows)) throw new Error('T3: after landscape rotation cols<=rows: ' + JSON.stringify(r0));
  let st = await bufState();
  if (st.cols !== r0.cols || st.rows !== r0.rows) {
    throw new Error('T3: xterm ' + st.cols + 'x' + st.rows + ' != resized ' + r0.cols + 'x' + r0.rows);
  }
  if (st.viewportY !== st.bottom) throw new Error('T3: after rotation not at the bottom: viewportY=' + st.viewportY + '/' + st.bottom);
  ok('T3-landscape', 'resize sent ' + r0.cols + 'x' + r0.rows + ' (cols>rows), still at bottom');
  // server-side proof: the PTY itself was resized (mode con reflects the console size)
  await drainWsLog();
  await cdpEval(`sendInput('mode con\\r')`);
  await waitMs(1500);
  const modeTxt = await bufferText(60);
  const cm = modeTxt.match(/(?:Columns|\u0421\u0442\u043e\u043b\u0431\u0446\u044b):\s*(\d+)/i);
  const rm = modeTxt.match(/(?:Lines|Rows|\u0421\u0442\u0440\u043e\u043a\u0438):\s*(\d+)/i);
  st = await bufState();
  if (!cm || parseInt(cm[1], 10) !== st.cols) {
    throw new Error('T3: PTY columns=' + (cm ? cm[1] : '?') + ' != xterm.cols=' + st.cols + '\nmode con output:\n' + modeTxt.slice(-400));
  }
  if (!rm || parseInt(rm[1], 10) !== st.rows) {
    throw new Error('T3: PTY rows=' + (rm ? rm[1] : '?') + ' != xterm.rows=' + st.rows + '\nmode con output:\n' + modeTxt.slice(-400));
  }
  ok('T3-pty', 'mode con: Columns=' + cm[1] + ' Lines=' + rm[1] + ' == xterm ' + st.cols + 'x' + st.rows + ' (PTY resized)');
  await screenshot('e2e-mobile-t3-landscape.png');
  // detach (finger-drag down = scroll into history) from an arbitrary position,
  // rotate back -> must ALWAYS land at the bottom
  await detachBySwipe(422);
  await waitUntil(async () => (await btDisplay()) === 'block', 2500, 'detached before rotating back');
  st = await bufState();
  log('  (detached before rotation back: viewportY=' + st.viewportY + '/' + st.bottom + ')');
  await setMetrics(PORTRAIT);
  await waitMs(1300);
  st = await bufState();
  if (st.viewportY !== st.bottom) {
    throw new Error('T3: after rotation back not at the bottom: viewportY=' + st.viewportY + '/' + st.bottom);
  }
  ok('T3-portrait', 'after rotation back from an arbitrary position: at bottom (always-to-bottom)');
  await screenshot('e2e-mobile-t3-portrait-after.png');
}

// T4: virtual keys panel: every button sends the exact bytes from the TZ table,
// xterm focus is not lost, state is persisted in localStorage.
async function t4() {
  log('T4: virtual keys panel, exact bytes per button');
  const tg = await centerOf('#keysToggle');
  await tapAt(tg.x, tg.y);
  await waitMs(300);
  const vis = await cdpEval(`getComputedStyle(document.getElementById('keys')).display`);
  if (vis !== 'block') throw new Error('T4: keys panel did not open (display=' + vis + ')');
  const ls = await cdpEval(`localStorage.getItem('piKeysPanel')`);
  if (ls !== '1') throw new Error('T4: localStorage piKeysPanel=' + ls + ', expected "1"');
  // focus xterm explicitly so the focus check below is meaningful
  await cdpEval(`(function () {
    var ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    return document.activeElement === ta;
  })()`);
  await screenshot('e2e-mobile-t4-keys-panel.png');
  const btns = JSON.parse(await cdpEval(`JSON.stringify([...document.querySelectorAll('#keys button')].map(function (b) {
    var r = b.getBoundingClientRect();
    return { l: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }))`));
  if (btns.length !== EXPECTED_KEYS.length + 1) {
    throw new Error('T4: expected ' + (EXPECTED_KEYS.length + 1) + ' panel buttons (17 keys + Bt), got ' + btns.length);
  }
  const byLabel = {};
  btns.forEach(b => { byLabel[b.l] = b; });
  for (const exp of EXPECTED_KEYS) {
    const b = byLabel[exp.l];
    if (!b) throw new Error('T4: panel has no button "' + exp.l + '"');
    // the rows scroll horizontally on a narrow screen -- bring the button into view first
    const idx = await cdpEval(`(function () {
      var btns = [...document.querySelectorAll('#keys button')];
      var i = btns.findIndex(function (b) { return b.textContent === ${JSON.stringify(exp.l)}; });
      if (i < 0) return -1;
      btns[i].scrollIntoView({ block: 'nearest', inline: 'center' });
      return i;
    })()`);
    if (idx < 0) throw new Error('T4: panel has no button "' + exp.l + '"');
    await waitMs(180); // let the row settle after scrollIntoView
    const pos = JSON.parse(await cdpEval(`JSON.stringify((function () {
      var b = document.querySelectorAll('#keys button')[${idx}];
      var r = b.getBoundingClientRect();
      return { l: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })())`));
    if (pos.l !== exp.l) throw new Error('T4: button index mismatch: ' + pos.l + ' != ' + exp.l);
    if (pos.x < 0 || pos.x > PORTRAIT.width || pos.y < 0 || pos.y > PORTRAIT.height) {
      throw new Error('T4: button "' + exp.l + '" is outside the viewport at ' + JSON.stringify(pos));
    }
    await drainWsLog();
    await tapAt(pos.x, pos.y);
    await waitMs(180);
    const ins = parseFrames(await drainWsLog()).filter(m => m.type === 'in');
    if (ins.length !== 1) throw new Error('T4: "' + exp.l + '" expected exactly 1 input message, got ' + ins.length);
    const bytes = Buffer.from(ins[0].data, 'base64').toString('hex');
    if (bytes !== exp.hex) throw new Error('T4: "' + exp.l + '" sent ' + bytes + ', expected ' + exp.hex);
  }
  ok('T4-bytes', 'all ' + EXPECTED_KEYS.length + ' keys sent exact sequences from the TZ table (incl. 6 Ctrl combos)');
  // the panel duplicate "Bt" button: no input bytes, scrolls to the bottom
  const bt = byLabel['\u2193 Bt'];
  if (!bt) throw new Error('T4: panel has no duplicate Bt button');
  // bring the rightmost row-2 button into view, then detach by swipe
  await cdpEval(`(function () {
    var btns = [...document.querySelectorAll('#keys button')];
    var i = btns.findIndex(function (b) { return b.textContent === '\u2193 Bt'; });
    if (i >= 0) btns[i].scrollIntoView({ block: 'nearest', inline: 'center' });
    return i;
  })()`);
  await waitMs(180);
  await detachBySwipe(195);
  await waitUntil(async () => (await btDisplay()) === 'block', 2500, 'detached before panel Bt tap');
  // re-read the panel Bt position (the row was scrolled)
  const btPos = JSON.parse(await cdpEval(`JSON.stringify((function () {
    var btns = [...document.querySelectorAll('#keys button')];
    var i = btns.findIndex(function (b) { return b.textContent === '\u2193 Bt'; });
    var r = btns[i].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })())`));
  await drainWsLog();
  await tapAt(btPos.x, btPos.y);
  await waitMs(500);
  const ins = parseFrames(await drainWsLog()).filter(m => m.type === 'in');
  if (ins.length !== 0) throw new Error('T4: panel Bt button must not send input bytes');
  const st = await bufState();
  if (st.viewportY !== st.bottom) throw new Error('T4: panel Bt tap did not scroll to the bottom');
  ok('T4-panel-bt', 'panel Bt: no bytes sent, scrolled to bottom');
  // focus must not be lost by the taps
  const focused = await cdpEval(`(function () {
    var ta = document.querySelector('.xterm-helper-textarea');
    return document.activeElement === ta;
  })()`);
  if (focused !== true) {
    throw new Error('T4: xterm textarea lost focus after key taps, activeElement=' +
      (await cdpEval('document.activeElement && document.activeElement.className')));
  }
  ok('T4-focus', 'xterm textarea keeps focus after all taps');
  // close the panel; the state must flip in localStorage
  await tapAt(tg.x, tg.y);
  await waitMs(300);
  const vis2 = await cdpEval(`getComputedStyle(document.getElementById('keys')).display`);
  const ls2 = await cdpEval(`localStorage.getItem('piKeysPanel')`);
  if (vis2 !== 'none' || ls2 !== '0') throw new Error('T4: panel did not close (display=' + vis2 + ', ls=' + ls2 + ')');
  ok('T4-close', 'panel closed, localStorage piKeysPanel="0"');
}

// T5: regression -- xterm is alive, a typed key reaches the PTY and lands in .xterm-rows.
async function t5() {
  log('T5: regression, typed key reaches PTY and renders');
  await drainWsLog();
  // Ctrl+C clears whatever the T4 key taps left on the cmd input line, then cls
  await cdpEval(`sendInput('\\x03cls\\r')`);
  await waitMs(1000);
  // the T4 close-panel tap moved focus to the toolbar button -- give it back to xterm
  await cdpEval(`(function () {
    var ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    return document.activeElement === ta;
  })()`);
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'H', text: 'H', unmodifiedText: 'H',
    windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72,
  });
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'H', windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72,
  });
  await waitMs(900);
  const frames = parseFrames(await drainWsLog()).filter(m => m.type === 'in');
  const gotH = frames.some(f => {
    try { return Buffer.from(f.data, 'base64').toString('utf8') === 'H'; } catch { return false; }
  });
  if (!gotH) throw new Error('T5: no ws input message with byte "H"');
  // the PTY echo: the cmd prompt + typed H appears near the cursor (after cls the
  // prompt sits at the top of the cleared screen, so tail reads hit empty rows)
  let echoLine = null;
  await waitUntil(async () => {
    echoLine = await cdpEval(`(function () {
      var buf = xterm.buffer.active, out = null;
      for (var i = Math.max(0, buf.cursorY - 3); i <= Math.min(buf.length - 1, buf.cursorY + 3); i++) {
        var l = buf.getLine(i);
        var t = l ? l.translateToString(true) : '';
        if (/\u003eH\\s*$/.test(t)) out = t;
      }
      return out;
    })()`);
    return !!echoLine;
  }, 5000, 'echo of H (prompt line ending with >H) near the cursor');
  log('  (echo line: ' + JSON.stringify(echoLine.trim()) + ')');
  const rowsTxt = await cdpEval(`(document.querySelector('.xterm-rows') || { textContent: '' }).textContent`);
  if (!rowsTxt.includes('H')) throw new Error('T5: "H" not found in .xterm-rows text');
  await screenshot('e2e-mobile-t5.png');
  ok('T5', 'H went over WS, echoed by the PTY, rendered in .xterm-rows');
}

// ---------- auth helpers ----------
let apiCookie = '';
function authHeaders() { return apiCookie ? { Cookie: apiCookie } : {}; }

async function httpLogin() {
  const r = await httpJson(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD, next: '/' }) });
  if (r.status !== 200) throw new Error('http login failed: ' + r.status + ' ' + JSON.stringify(r.body));
  const sc = r.headers['set-cookie'] || [];
  apiCookie = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]).join('; ');
  log('http login ok, session cookie captured');
}

// Login through the real login page in the CDP browser (covers the /login form UI).
async function cdpLogin() {
  await cdpNavigate(BASE + '/');
  await waitUntil(async () => await cdpEval(`location.pathname === '/login' && !!document.getElementById('pw')`), 10000, 'login form');
  await cdpEval(`document.getElementById('pw').value = ${JSON.stringify(PASSWORD)}; true`);
  await cdpEval(`document.getElementById('loginBtn').click(); true`);
  await waitUntil(async () => await cdpEval(`location.pathname === '/' && !!document.querySelector('.new')`), 10000, 'redirect to index after login');
  ok('login', 'CDP login form submitted, redirected back to the index');
}

// ---------- main ----------
async function main() {
  let code = 1;
  try {
    await startServer();
    await httpLogin();
    const cr = await httpJson(BASE + '/api/rooms', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: ROOM, cwd: 'C:\\MyProjects', cmd: 'cmd.exe' }),
    });
    if (cr.status !== 200) throw new Error('room creation failed: ' + JSON.stringify(cr.body));
    log('room "' + ROOM + '" created (cmd.exe)');
    await startChrome();
    log('Chrome ready on CDP port ' + cdpPort + ', mobile emulation 390x844 DSF3');
    await cdpLogin();
    await cdpSend('Page.addScriptToEvaluateOnNewDocument', { source: WS_HOOK });
    await setMetrics(PORTRAIT);
    await cdpSend('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdpNavigate(BASE + '/room/' + ROOM);
    await waitUntil(async () => await cdpEval(`!!window.xterm && !!document.querySelector('.xterm-rows')`), 15000, 'xterm init');
    await waitMs(1800); // let cmd.exe print its prompt
    await t1();
    await t2();
    await t3();
    await t4();
    await t5();
    console.log('ALL OK');
    code = 0;
  } catch (e) {
    console.error('FAIL', (e && e.message) || e);
    try {
      const tail = await bufferText(20);
      console.error('--- last 20 buffer lines ---\n' + tail);
    } catch {}
    if (serverLogTail) console.error('--- server log tail ---\n' + serverLogTail.slice(-1500));
    code = 1;
  }
  // cleanup: delete the room first (kills the PTY), then chrome, then the test server
  try { await httpJson(BASE + '/api/rooms/' + ROOM, { method: 'DELETE', headers: authHeaders() }); } catch {}
  stopChrome();
  killServer();
  process.exit(code);
}

main();