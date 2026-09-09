#!/usr/bin/env node
// E2E AUTH tests for pi-remote (TASK-auth.md, section 6).
// Pattern: test-e2e-delete.cjs -- vanilla Node + ws, no browser needed.
//
// The test spawns ITS OWN server instance on a TEST port (default 7983) with
// PI_REMOTE_PASSWORD / PI_REMOTE_NOTIFY_TOKEN in the spawn env (real env and
// the project .env are overridden by the spawn env). The production instance
// on 7681 (if running) is never touched.
//
// Checks:
//   A0: fail-closed -- server without PI_REMOTE_PASSWORD exits with code 1
//   A1: GET / without cookie -> 302 to /login?next=
//   A2: GET /api/rooms without cookie -> 401 {error:'unauthorized'}
//   A3: POST /api/login wrong password -> 401
//   A4: POST /api/login correct password -> 200 + Set-Cookie pi_session
//   A5: GET /api/rooms with the cookie -> 200
//   A6: WS upgrade without cookie -> rejected (connect error)
//   A7: WS upgrade with the cookie -> connects (notify room, no PTY needed)
//   A8: POST /api/logout -> the old cookie no longer works (401)
//   A9: POST /api/notify with X-Notify-Token works WITHOUT any cookie
//   A10: rate limit -- 5 wrong passwords in a row -> 6th is blocked (429)
//
// Usage: node test-e2e-auth.cjs [port]
// Exit code 0 on success, 1 on any failure.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PI_REMOTE_AUTH_PORT || '7983', 10);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'test12345';
const NOTIFY_TOKEN = 'authtoken123';

let serverProc = null;
let serverLogTail = '';

function log(...a) { console.log('[e2e-auth]', ...a); }
function ok(step, msg) { console.log(`OK: ${step}${msg ? ' ' + msg : ''}`); }

// ---------- HTTP helpers (plain node) ----------
function httpReq(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: pathname,
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data || '{}'); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, body });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function postJson(pathname, obj, headers) {
  return httpReq(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(obj),
  });
}

function cookieFrom(res) {
  const sc = res.headers['set-cookie'] || [];
  const list = Array.isArray(sc) ? sc : [sc];
  return list.map(c => c.split(';')[0]).join('; ');
}

// ---------- test server lifecycle ----------
function spawnServer(env, port) {
  return spawn(process.execPath, [
    path.join(__dirname, 'server.js'), String(port), 'cmd.exe', 'C:\\MyProjects', '3600',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
}

function waitForExit(proc, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not exit within ' + ms + 'ms')), ms);
    proc.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

async function startServer() {
  log('spawning test server on port ' + PORT + ' (production on 7681 is not touched)');
  serverProc = spawnServer({ PI_REMOTE_PASSWORD: PASSWORD, PI_REMOTE_NOTIFY_TOKEN: NOTIFY_TOKEN }, PORT);
  let out = '';
  serverProc.stdout.on('data', c => { out += c; if (out.length > 20000) out = out.slice(-20000); serverLogTail = out; });
  serverProc.stderr.on('data', c => { out += c; if (out.length > 20000) out = out.slice(-20000); serverLogTail = out; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await httpReq('/health');
      if (r.status === 200 && r.body && r.body.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('test server did not start on port ' + PORT + '\n' + out);
}

function killServer(proc) {
  const p = proc || serverProc;
  if (!p) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { p.kill(); } catch {} }
  } else {
    try { p.kill('SIGTERM'); } catch {}
  }
}

// ---------- WebSocket helpers ----------
function tryWs(cookie) {
  return new Promise((resolve) => {
    const WebSocket = require('ws').WebSocket || require('ws');
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=__notify_index__`, { headers });
    let opened = false;
    const t = setTimeout(() => { // 8s is plenty for a local upgrade
      try { ws.terminate(); } catch {}
      resolve({ opened, err: 'timeout' });
    }, 8000);
    ws.on('open', () => { opened = true; });
    ws.on('message', (raw) => {
      clearTimeout(t);
      let m = null; try { m = JSON.parse(raw.toString()); } catch {}
      try { ws.close(); } catch {}
      resolve({ opened, msg: m });
    });
    ws.on('error', (err) => {
      clearTimeout(t);
      resolve({ opened: false, err: String(err && err.message || err) });
    });
  });
}

// ---------- Scenarios ----------

async function a0_failClosed() {
  log('A0: fail-closed -- no password -> exit 1');
  const proc = spawnServer({ PI_REMOTE_PASSWORD: '' }, 7984); // empty string overrides .env
  let out = '';
  proc.stdout.on('data', c => out += c);
  proc.stderr.on('data', c => out += c);
  const { code } = await waitForExit(proc, 10000);
  if (code !== 1) throw new Error('A0: expected exit code 1, got ' + code);
  if (!out.includes('PI_REMOTE_PASSWORD')) throw new Error('A0: error output does not mention PI_REMOTE_PASSWORD');
  ok('A0', 'server without a password exits 1 with a clear error');
}

async function main() {
  let code = 1;
  let cookie = '';
  try {
    await a0_failClosed();
    await startServer();

    // A1: page redirect
    const r1 = await httpReq('/');
    if (r1.status !== 302) throw new Error('A1: expected 302 on /, got ' + r1.status);
    const loc = r1.headers.location || '';
    if (!loc.startsWith('/login?next=%2F')) throw new Error('A1: unexpected Location: ' + loc);
    ok('A1', 'GET / -> 302 ' + loc);

    // A2: API 401
    const r2 = await httpReq('/api/rooms');
    if (r2.status !== 401 || !r2.body || r2.body.error !== 'unauthorized') {
      throw new Error('A2: expected 401 unauthorized, got ' + r2.status + ' ' + r2.text);
    }
    ok('A2', 'GET /api/rooms -> 401 {error:unauthorized}');

    // login page is served without a cookie
    const rl = await httpReq('/login');
    if (rl.status !== 200 || !rl.text.includes('password') || !rl.text.includes('loginForm')) {
      throw new Error('A-login: /login page missing or malformed');
    }
    ok('A-login', 'GET /login -> 200 with the password form');

    // A3: wrong password
    const r3 = await postJson('/api/login', { password: 'wrong-password' });
    if (r3.status !== 401) throw new Error('A3: expected 401 for a wrong password, got ' + r3.status);
    if ((r3.headers['set-cookie'] || []).length) throw new Error('A3: wrong login must not set a cookie');
    ok('A3', 'wrong password -> 401, no cookie');

    // A4: correct password
    const r4 = await postJson('/api/login', { password: PASSWORD, next: '/' });
    if (r4.status !== 200) throw new Error('A4: expected 200, got ' + r4.status + ' ' + r4.text);
    cookie = cookieFrom(r4);
    if (!/^pi_session=[0-9a-f]{64}$/.test(cookie)) throw new Error('A4: bad Set-Cookie: ' + cookie);
    const sc = (r4.headers['set-cookie'] || []).join('\n');
    if (!/HttpOnly/i.test(sc) || !/SameSite=Lax/i.test(sc)) throw new Error('A4: cookie flags missing: ' + sc);
    ok('A4', 'correct password -> 200, Set-Cookie pi_session (HttpOnly, SameSite=Lax)');

    // A5: API with cookie
    const r5 = await httpReq('/api/rooms', { headers: { Cookie: cookie } });
    if (r5.status !== 200) throw new Error('A5: expected 200 with cookie, got ' + r5.status);
    ok('A5', 'GET /api/rooms with cookie -> 200');

    // A6: WS without cookie -> upgrade refused
    const w6 = await tryWs(null);
    if (w6.opened) throw new Error('A6: WS connected without a cookie!');
    ok('A6', 'WS upgrade without cookie rejected (' + (w6.err || 'error') + ')');

    // A7: WS with cookie -> connects
    const w7 = await tryWs(cookie);
    if (!w7.opened) throw new Error('A7: WS with cookie did not connect: ' + w7.err);
    if (!w7.msg || w7.msg.type !== 'ready' || w7.msg.notify !== true) {
      throw new Error('A7: no {type:ready,notify:true} message: ' + JSON.stringify(w7.msg));
    }
    ok('A7', 'WS upgrade with cookie -> connected, got {type:ready,notify:true}');

    // A8: logout
    const r8 = await postJson('/api/logout', {}, { Cookie: cookie });
    if (r8.status !== 200) throw new Error('A8: logout failed: ' + r8.status);
    const r8b = await httpReq('/api/rooms', { headers: { Cookie: cookie } });
    if (r8b.status !== 401) throw new Error('A8: old cookie still works after logout (got ' + r8b.status + ')');
    ok('A8', 'logout -> 200, old cookie -> 401');

    // A9: notify with token, no cookie
    const r9 = await postJson('/api/notify', { type: 'test', title: 'auth-e2e' }, { 'X-Notify-Token': NOTIFY_TOKEN });
    if (r9.status !== 200) throw new Error('A9: notify failed: ' + r9.status + ' ' + r9.text);
    const r9b = await postJson('/api/notify', { type: 'test', title: 'auth-e2e' }, { 'X-Notify-Token': 'wrong' });
    if (r9b.status !== 403) throw new Error('A9: wrong token must give 403, got ' + r9b.status);
    ok('A9', '/api/notify works with X-Notify-Token and NO cookie (403 on wrong token)');

    // A10: rate limit -- 5 wrong passwords -> blocked
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await postJson('/api/login', { password: 'nope-' + i });
      statuses.push(r.status);
    }
    const blocked = statuses.filter(s => s === 429).length;
    if (statuses[statuses.length - 1] !== 429 || blocked < 1) {
      throw new Error('A10: rate limit did not kick in, statuses: ' + statuses.join(','));
    }
    if (statuses.includes(200)) throw new Error('A10: a wrong login got 200?! ' + statuses.join(','));
    ok('A10', '5 wrong logins -> blocked: statuses=' + statuses.join(','));

    console.log('ALL OK');
    code = 0;
  } catch (e) {
    console.error('FAIL', (e && e.message) || e);
    if (serverLogTail) console.error('--- server log tail ---\n' + serverLogTail.slice(-1500));
    code = 1;
  }
  killServer();
  setTimeout(() => process.exit(code), 500); // let taskkill land
}

main();
