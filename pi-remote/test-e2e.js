// E2E test for pi-remote server.
// Requires the server to be running on http://localhost:7681 (or pass URL via env PI_REMOTE_URL).
// Runs through the user-facing flows: list projects, create room, send input via WS, see output, restart, delete.
//
// Usage: node test-e2e.js
//
// Exits with code 0 on full success, 1 on any failure.

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const BASE = process.env.PI_REMOTE_URL || 'http://localhost:7681';
const ORIGIN = new URL(BASE).origin;
const TARGET_ROOM = 'e2e_test_' + Date.now();
const TARGET_CWD = process.env.PI_REMOTE_E2E_CWD || 'C:\\MyProjects\\1cDevTry'; // pick a known-existing subdir
const SHELL = 'cmd.exe';                       // built-in, never needs a real agent

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  PASS ' + name); }
function bad(name, msg) { fail++; console.log('  FAIL ' + name + (msg ? ' -- ' + msg : '')); }

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function expectStatus(name, p, expected) {
  const r = await p;
  if (r.status === expected) ok(name + ' (HTTP ' + expected + ')');
  else bad(name, 'expected HTTP ' + expected + ', got ' + r.status + ' body=' + r.body.slice(0, 200));
}

// The server base64-encodes the raw pty bytes (UTF-8) before sending over WS.
// Decode: base64 -> raw bytes -> UTF-8 string.
// The server sends the raw pty output as a plain UTF-8 string (no base64).
// This helper is kept for backwards compat; it now just returns the string.
function b64decode(s) { return s; }

(async () => {
  console.log('pi-remote e2e tests against ' + BASE);
  console.log('');

  // --- 0. preconditions ---
  console.log('[0] preconditions');
  if (!fs.existsSync(TARGET_CWD)) {
    bad('cwd exists: ' + TARGET_CWD);
    process.exit(1);
  } else ok('cwd exists: ' + TARGET_CWD);

  // --- 1. /health ---
  console.log('\n[1] /health');
  const h = await req('GET', '/health');
  if (h.status === 200 && h.json && h.json.ok === true) ok('GET /health ok');
  else bad('GET /health', JSON.stringify(h));

  // --- 2. /api/rooms (empty / no virtual) ---
  console.log('\n[2] /api/rooms (virtual notify must be hidden)');
  const list = await req('GET', '/api/rooms');
  if (list.status === 200 && Array.isArray(list.json.rooms)) ok('GET /api/rooms');
  else bad('GET /api/rooms', JSON.stringify(list));
  if (list.json.rooms.find(r => r.name === '__notify_index__')) {
    bad('/api/rooms hides __notify_index__', 'virtual room leaks into UI list');
  } else {
    ok('/api/rooms hides __notify_index__');
  }

  // --- 3. /api/projects ---
  console.log('\n[3] /api/projects');
  const proj = await req('GET', '/api/projects');
  if (proj.status === 200 && Array.isArray(proj.json.projects)) ok('GET /api/projects');
  else bad('GET /api/projects', JSON.stringify(proj));
  if (proj.json.projects.length >= 50) ok('/api/projects returns >= 50 items (got ' + proj.json.projects.length + ')');
  else bad('/api/projects >= 50 items', 'got ' + proj.json.projects.length);
  if (proj.json.projects.find(p => p === TARGET_CWD || (proj.json.root + '\\' + p) === TARGET_CWD)) ok('target cwd found in projects');
  else bad('target cwd in projects');

  // --- 4. /room/:name serves HTML with the right room name ---
  console.log('\n[4] /room/:name page');
  const page = await req('GET', '/room/probe');
  if (page.status === 200 && page.body.includes('xterm.js') && /id="rname">probe<\/span>/.test(page.body)) {
    ok('GET /room/:name serves terminal page with room name inlined');
  } else bad('GET /room/:name serves page', 'len=' + page.body.length + ', rname-match=' + /id="rname">probe<\/span>/.test(page.body));

  // --- 5. / (index) renders ---
  console.log('\n[5] / (index page)');
  const idx = await req('GET', '/');
  if (idx.status === 200 && idx.body.includes('Pi Remote') && idx.body.includes('load()')) {
    ok('GET / serves index with embedded load()');
  } else bad('GET / index');

  // --- 6. POST /api/rooms creates a room ---
  console.log('\n[6] POST /api/rooms');
  await expectStatus('POST /api/rooms -> 200', req('POST', '/api/rooms', {
    name: TARGET_ROOM, cwd: TARGET_CWD, cmd: SHELL,
  }), 200);

  const after = await req('GET', '/api/rooms');
  const created = after.json.rooms.find(r => r.name === TARGET_ROOM);
  if (created && created.running) ok('created room is running');
  else bad('created room not running', JSON.stringify(created));

  // --- 7. POST /api/rooms duplicate -> 409 ---
  console.log('\n[7] POST /api/rooms duplicate');
  await expectStatus('POST /api/rooms duplicate -> 409', req('POST', '/api/rooms', {
    name: TARGET_ROOM, cwd: TARGET_CWD, cmd: SHELL,
  }), 409);

  // --- 8. POST /api/rooms bad cwd -> 400 ---
  console.log('\n[8] POST /api/rooms bad cwd');
  await expectStatus('POST /api/rooms bad cwd -> 400', req('POST', '/api/rooms', {
    name: 'never_' + Date.now(), cwd: 'C:\\nonexistent_xyz_abc', cmd: SHELL,
  }), 400);

  // --- 9. POST /api/rooms missing fields -> 400 ---
  console.log('\n[9] POST /api/rooms missing fields');
  await expectStatus('POST /api/rooms empty body -> 400', req('POST', '/api/rooms', {}), 400);

  // --- 10. WebSocket: connect, get 'ready', send 'in', get 'out' ---
  console.log('\n[10] WebSocket flow');
  const wsUrl = ORIGIN.replace('http', 'ws') + '/ws?room=' + encodeURIComponent(TARGET_ROOM);
  const marker = 'PIE2E' + Date.now();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch(_){}; reject(new Error('ws timeout')); }, 8000);
    let gotReady = false;
    let gotOut = false;
    const outChunks = [];
    ws.on('open', () => {
      // wait a moment so the pty prompt is ready, then send one command and exit
      setTimeout(() => {
        const cmd = 'echo ' + marker + '\r\nexit\r';
        try { ws.send(JSON.stringify({ type: 'in', data: Buffer.from(cmd, 'utf8').toString('base64') })); } catch (_){}
      }, 1500);
    });
    let evaluated = false;
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') { gotReady = true; }
      if (m.type === 'out') {
        const text = b64decode(m.data);
        outChunks.push(text);
        if (text.includes(marker)) gotOut = true;
      }
      if (m.type === 'exit' && !evaluated) {
        evaluated = true;
        clearTimeout(t);
        // allow one more 'out' to arrive before evaluating
        setTimeout(() => {
          if (gotReady) ok('ws got ready'); else bad('ws got ready');
          if (gotOut) ok('ws received output with our marker'); else bad('ws received output', 'chunks=' + outChunks.length + ' text=' + JSON.stringify(outChunks.join('').slice(0, 300)));
          try { ws.close(); } catch(_){}
          resolve();
        }, 500);
      }
    });
    ws.on('error', e => { clearTimeout(t); reject(e); });
  }).catch(e => bad('ws flow', e.message));

  // give server a moment to write out
  await new Promise(r => setTimeout(r, 300));

  // --- 11. POST /api/rooms/:name restarts ---
  console.log('\n[11] POST /api/rooms/:name restart');
  await expectStatus('POST /api/rooms/:name -> 200', req('POST', '/api/rooms/' + encodeURIComponent(TARGET_ROOM), {}), 200);
  const after2 = await req('GET', '/api/rooms/' + encodeURIComponent(TARGET_ROOM));
  if (after2.json && after2.json.room && after2.json.room.running) ok('room is running after restart');
  else bad('room running after restart', JSON.stringify(after2));

  // --- 12. DELETE /api/rooms/:name destroys ---
  console.log('\n[12] DELETE /api/rooms/:name');
  await expectStatus('DELETE /api/rooms/:name -> 200', req('DELETE', '/api/rooms/' + encodeURIComponent(TARGET_ROOM), null), 200);
  const after3 = await req('GET', '/api/rooms/' + encodeURIComponent(TARGET_ROOM));
  if (after3.status === 404) ok('GET on deleted room -> 404');
  else bad('GET on deleted room', 'status=' + after3.status);

  // --- 13. /api/notify broadcasts to all ws clients ---
  console.log('\n[13] /api/notify broadcast');
  // open a notify-only ws
  const notifyWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=__notify_index__');
  const notifyMsg = await new Promise((resolve, reject) => {
    notifyWs.on('open', () => {
      // call /api/notify (with token if server uses one)
      const u = new URL('/api/notify', BASE);
      const data = JSON.stringify({ type: 'info', title: 'e2e-ping', body: 'hello' });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
      if (process.env.PI_REMOTE_NOTIFY_TOKEN) headers['X-Notify-Token'] = process.env.PI_REMOTE_NOTIFY_TOKEN;
      const r = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
        headers },
        res => { res.resume(); res.on('end', resolve); });
      r.on('error', reject);
      r.write(data); r.end();
    });
    notifyWs.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'notify' && m.notify && m.notify.title === 'e2e-ping') resolve(m);
    });
    notifyWs.on('error', reject);
    setTimeout(() => reject(new Error('notify timeout')), 4000);
  });
  if (notifyMsg && notifyMsg.notify && notifyMsg.notify.title === 'e2e-ping') ok('/api/notify delivered');
  else bad('/api/notify delivered', JSON.stringify(notifyMsg));
  notifyWs.close();

  // --- 13b. /api/notify broadcast reaches a room's terminal WS client ---
  console.log('\n[13b] /api/notify delivery to terminal page WS');
  // recreate the target room (destroyed in [12]), connect a room WS, then notify
  await expectStatus('POST /api/rooms (recreate for 13b)', req('POST', '/api/rooms', {
    name: TARGET_ROOM, cwd: TARGET_CWD, cmd: SHELL,
  }), 200);
  const roomWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=' + encodeURIComponent(TARGET_ROOM));
  const roomNotify = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('room notify timeout')), 5000);
    roomWs.on('open', () => {
      const u = new URL('/api/notify', BASE);
      const data = JSON.stringify({ type: 'info', title: 'e2e-room-notify', body: 'delivered to room page' });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
      if (process.env.PI_REMOTE_NOTIFY_TOKEN) headers['X-Notify-Token'] = process.env.PI_REMOTE_NOTIFY_TOKEN;
      const r = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers },
        res => { res.resume(); res.on('end', () => {}); });
      r.on('error', reject);
      r.write(data); r.end();
    });
    roomWs.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'notify' && m.notify && m.notify.title === 'e2e-room-notify') {
        clearTimeout(t); resolve(m);
      }
    });
    roomWs.on('error', e => { clearTimeout(t); reject(e); });
  }).catch(e => ({ error: e.message }));
  if (roomNotify && roomNotify.notify && roomNotify.notify.title === 'e2e-room-notify') ok('room ws got notify with e2e-room-notify');
  else bad('room ws got notify', JSON.stringify(roomNotify));
  try { roomWs.close(); } catch (_) {}

  // --- 14. WS to unknown room -> error message ---
  console.log('\n[14] WS unknown room -> error');
  const unknownWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=nope_' + Date.now());
  const errMsg = await new Promise((resolve, reject) => {
    unknownWs.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'error') resolve(m);
    });
    unknownWs.on('error', reject);
    setTimeout(() => reject(new Error('no error msg')), 3000);
  }).catch(e => ({ error: e.message }));
  if (errMsg.type === 'error' && /no such room/.test(errMsg.error)) ok('ws unknown room -> error');
  else bad('ws unknown room', JSON.stringify(errMsg));

  // --- 15. Room survives after all clients disconnect ---
  console.log('\n[15] Room survives after disconnect');
  const SURVIVE_ROOM = 'e2e_survive_' + Date.now();
  await expectStatus('POST /api/rooms (survive) -> 200', req('POST', '/api/rooms', {
    name: SURVIVE_ROOM, cwd: TARGET_CWD, cmd: SHELL,
  }), 200);

  const surviveWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=' + encodeURIComponent(SURVIVE_ROOM));
  await new Promise((resolve, reject) => {
    surviveWs.on('open', resolve);
    surviveWs.on('error', reject);
    setTimeout(() => reject(new Error('survive ws open timeout')), 5000);
  });
  surviveWs.close();
  await new Promise(r => setTimeout(r, 3500)); // wait longer than old idle timeout

  const surviveList = await req('GET', '/api/rooms');
  const surviveRoom = surviveList.json.rooms.find(r => r.name === SURVIVE_ROOM);
  if (surviveRoom) ok('room still exists 3s after disconnect');
  else bad('room still exists 3s after disconnect', 'room missing');

  // --- 16. Room survives after PTY exit ---
  console.log('\n[16] Room survives after PTY exit');
  const exitWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=' + encodeURIComponent(SURVIVE_ROOM));
  await new Promise((resolve, reject) => {
    exitWs.on('open', resolve);
    exitWs.on('error', reject);
    setTimeout(() => reject(new Error('exit ws open timeout')), 5000);
  });
  // Send exit command
  exitWs.send(JSON.stringify({ type: 'in', data: Buffer.from('exit\r\n', 'utf8').toString('base64') }));
  await new Promise((resolve) => {
    exitWs.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'exit') resolve();
    });
    setTimeout(() => resolve(), 5000);
  });
  exitWs.close();
  await new Promise(r => setTimeout(r, 3500));

  const exitList = await req('GET', '/api/rooms');
  const exitRoomFound = exitList.json.rooms.find(r => r.name === SURVIVE_ROOM);
  if (exitRoomFound && !exitRoomFound.running) ok('room exists after pty exit and is not running');
  else if (!exitRoomFound) bad('room exists after pty exit', 'room missing');
  else bad('room exists after pty exit', 'room still running');

  // --- 17. Reconnect to dead room works ---
  console.log('\n[17] Reconnect to dead room');
  const deadWs = new WebSocket(ORIGIN.replace('http','ws') + '/ws?room=' + encodeURIComponent(SURVIVE_ROOM));
  const deadReady = await new Promise((resolve, reject) => {
    let gotReady = false;
    deadWs.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') { gotReady = true; resolve(m); }
    });
    deadWs.on('error', reject);
    setTimeout(() => { if (!gotReady) reject(new Error('dead room ready timeout')); }, 5000);
  }).catch(e => ({ error: e.message }));
  if (deadReady.type === 'ready') ok('reconnect to dead room got ready');
  else bad('reconnect to dead room', JSON.stringify(deadReady));
  deadWs.close();

  // --- 18. Restart dead room ---
  console.log('\n[18] Restart dead room');
  await expectStatus('POST /api/rooms/:name restart -> 200', req('POST', '/api/rooms/' + encodeURIComponent(SURVIVE_ROOM), {}), 200);
  const restartCheck = await req('GET', '/api/rooms/' + encodeURIComponent(SURVIVE_ROOM));
  if (restartCheck.json && restartCheck.json.room && restartCheck.json.room.running) ok('room is running after restart');
  else bad('room running after restart', JSON.stringify(restartCheck));

  // --- 19. Cleanup survive room ---
  console.log('\n[19] Cleanup survive room');
  await expectStatus('DELETE /api/rooms/:name -> 200', req('DELETE', '/api/rooms/' + encodeURIComponent(SURVIVE_ROOM), null), 200);
  const afterDel = await req('GET', '/api/rooms/' + encodeURIComponent(SURVIVE_ROOM));
  if (afterDel.status === 404) ok('survive room deleted -> 404');
  else bad('survive room deleted', 'status=' + afterDel.status);

  // --- summary ---
  console.log('\n=========================');
  console.log('PASSED: ' + pass + '  FAILED: ' + fail);
  console.log('=========================');
  process.exit(fail === 0 ? 0 : 1);
})();
