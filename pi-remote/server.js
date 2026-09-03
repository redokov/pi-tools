// Pi Remote v2 - web-based remote terminal for AI-agent sessions (multiple clients, shared PTY)
// Usage: node server.js [port] [shell-cmd] [projects-root] [idle-timeout-sec]
// Defaults: port=7681, shell="~\AppData\Roaming\npm\pi.cmd", projects="C:\MyProjects", idle=120
// NOTE: this file is intentionally pure ASCII. All UI strings are in English (transliterated
// from the original Russian). Room names are normalized to latin via the TRANSLIT table.
//
// Notify flow: pi-billing-window POSTs to /api/notify with X-Notify-Token = PI_REMOTE_NOTIFY_TOKEN;
// the server validates the token, then broadcasts {type:'notify', notify:{...}} to every WS client.
// The index page keeps a notify-only WS connection (room __notify_index__) and shows toasts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] || process.env.PORT || '7681', 10);
const DEFAULT_SHELL_CMD = process.argv[3] || (process.env.APPDATA
  ? process.env.APPDATA + '\\npm\\pi.cmd'
  : 'pi');
const PROJECTS_ROOT = process.argv[4] || 'C:\\MyProjects';
const IDLE_TIMEOUT_MS = (parseInt(process.argv[5], 10) || 120) * 1000;
const NOTIFY_TOKEN = process.env.PI_REMOTE_NOTIFY_TOKEN || '';
const NOTIFY_ROOM_NAME = '__notify_index__';

function shortId() { return crypto.randomBytes(3).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function listSubdirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}
function safeRoomName(s) {
  if (typeof s !== 'string' || !s.trim()) return '';
  let out = s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
  if (out.length === 40 && !/[a-z0-9]/.test(out[39])) out = out.slice(0, 39) + 'x';
  return out;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- room state ----------

const rooms = new Map(); // name -> { name, cwd, cmd, proc, clients:Set<ws>, createdAt, lastOutput, outputBuf, alive }

function attachPty(room, proc) {
  room.proc = proc;
  room.alive = true;
  room.lastOutput = Date.now();
  proc.onData(data => {
    room.outputBuf += data;
    if (room.outputBuf.length > 2 * 1024 * 1024) room.outputBuf = room.outputBuf.slice(-1 * 1024 * 1024);
    room.lastOutput = Date.now();
    for (const ws of room.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'out', data: data.toString('utf8') }));
      }
    }
  });
  proc.onExit(({ exitCode }) => {
    room.alive = false;
    console.log(`[-] room "${room.name}" pty exited (code ${exitCode})`);
    for (const ws of room.clients) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
  });
}

// node-pty prebuilds (1.1.0 / 1.2.0-beta) on this machine mangle 0x5C (backslash)
// in string args passed to the native layer ("C:\\foo" -> "C:foo"), which makes
// every Windows path in pty.spawn() come back as "File not found". Forward slashes
// survive intact and both conpty and winpty accept them, so we normalize cmd and cwd
// to forward slashes right before spawn.
function toForwardSlashes(p) {
  return p.replace(/\\/g, '/');
}

function createRoom({ name, cwd, cmd }) {
  if (rooms.has(name)) throw new Error('EXISTS');
  const spawnCwd = toForwardSlashes(cwd);
  const spawnCmd = toForwardSlashes(cmd);
  let proc;
  try {
    proc = pty.spawn(spawnCmd, [], { cwd: spawnCwd, name: 'xterm-256color', cols: 120, rows: 32, env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, useConpty: true });
  } catch (e) {
    console.log(`[!] pty spawn failed for "${name}" cmd=${spawnCmd} cwd=${spawnCwd}: ${e.message}`);
    throw e;
  }
  const room = { name, cwd, cmd, proc, clients: new Set(), createdAt: Date.now(), lastOutput: Date.now(), outputBuf: '', alive: true };
  attachPty(room, proc);
  rooms.set(name, room);
  console.log(`[+] room "${name}" created cwd=${cwd} cmd=${cmd}`);
  return room;
}

function destroyRoom(name) {
  const room = rooms.get(name);
  if (!room) return false;
  if (room.proc) { try { room.proc.kill(); } catch {} }
  rooms.delete(name);
  console.log(`[-] room "${name}" destroyed`);
  return true;
}

// ---------- notify-only virtual room ----------
// Virtual room for the index page's notify-only WS connection (no PTY).
// Stored in the same rooms Map so /api/notify broadcast reaches it.
rooms.set(NOTIFY_ROOM_NAME, { name: NOTIFY_ROOM_NAME, cwd: '', cmd: '', proc: null, clients: new Set(), createdAt: Date.now(), lastOutput: Date.now(), outputBuf: '', alive: true });

// ---------- HTTP ----------

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // /health
  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, { ok: true, uptime: process.uptime(), rooms: rooms.size });
  }

  // / -> index with room list + "new room" form
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }

  // /room/:name -> terminal page for a specific room (served for any name so the
  // page can render; the WS connection will fail fast if the room does not exist)
  if (url.pathname.startsWith('/room/') && req.method === 'GET') {
    const name = decodeURIComponent(url.pathname.slice(6));
    const room = rooms.get(name);
    const cwd = room ? room.cwd : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(terminalPageHtml(name, cwd));
    return;
  }

  // /api/rooms
  if (url.pathname === '/api/rooms' && req.method === 'GET') {
    const list = [...rooms.values()].filter(r => r.name !== NOTIFY_ROOM_NAME).map(r => ({
      name: r.name, cwd: r.cwd, cmd: r.cmd,
      clients: r.clients.size,
      running: !!r.alive,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
    return json(res, { rooms: list });
  }

  // /api/rooms POST { name, cwd, cmd? }
  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return json(res, { error: 'bad json' }, 400); }
    const rawName = String(body.name || '').trim();
    const cwd = String(body.cwd || '').trim();
    const cmd = String(body.cmd || DEFAULT_SHELL_CMD).trim() || DEFAULT_SHELL_CMD;
    const name = safeRoomName(rawName || shortId());
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!cwd) return json(res, { error: 'cwd required' }, 400);
    if (!fs.existsSync(cwd)) return json(res, { error: `cwd does not exist: ${cwd}` }, 400);
    if (rooms.has(name)) return json(res, { error: 'room exists' }, 409);
    try {
      const room = createRoom({ name, cwd, cmd });
      return json(res, { ok: true, room: { name: room.name, cwd: room.cwd, cmd: room.cmd } }, 200);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  }

  // /api/projects -> list subdirs under projects root (for the "new room" form)
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    return json(res, { root: PROJECTS_ROOT, projects: listSubdirs(PROJECTS_ROOT) });
  }

  // /api/notify -- broadcast a notify event to all connected clients (toast + system notification)
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    if (NOTIFY_TOKEN) {
      const provided = req.headers['x-notify-token'];
      if (provided !== NOTIFY_TOKEN) {
        return json(res, { error: 'invalid token' }, 403);
      }
    }

    let body;
    try { body = await readJsonBody(req); } catch { return json(res, { error: 'bad json' }, 400); }

    if (!body || typeof body !== 'object' || !body.type || !body.title) {
      return json(res, { error: 'type and title required' }, 400);
    }

    const payload = JSON.stringify({ type: 'notify', notify: body });
    let count = 0;
    for (const room of rooms.values()) {
      for (const ws of room.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(payload);
          count++;
        }
      }
    }
    console.log(`[*] notify "${body.title}" -> ${count} clients`);
    return json(res, { ok: true, delivered: count });
  }

  // /api/rooms/:name GET -> room info
  if (url.pathname.startsWith('/api/rooms/') && req.method === 'GET') {
    const name = decodeURIComponent(url.pathname.slice('/api/rooms/'.length));
    const room = rooms.get(name);
    if (!room) return json(res, { error: 'not found' }, 404);
    return json(res, { room: { name: room.name, cwd: room.cwd, cmd: room.cmd, running: !!room.alive, clients: room.clients.size } });
  }

  // /api/rooms/:name POST { action: 'restart' }
  if (url.pathname.startsWith('/api/rooms/') && req.method === 'POST') {
    const name = decodeURIComponent(url.pathname.slice('/api/rooms/'.length));
    const room = rooms.get(name);
    if (!room) return json(res, { error: 'not found' }, 404);
    let body = {};
    try { body = await readJsonBody(req); } catch {}
    if (!body || Object.keys(body).length === 0 || body.action === 'restart') {
      try { if (room.proc) room.proc.kill(); } catch {}
      rooms.delete(name);
      try {
        const fresh = createRoom({ name: room.name, cwd: room.cwd, cmd: room.cmd });
        return json(res, { ok: true, room: { name: fresh.name, cwd: fresh.cwd } });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }
    return json(res, { error: 'unknown action' }, 400);
  }

  // /api/rooms/:name DELETE
  if (url.pathname.startsWith('/api/rooms/') && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.slice('/api/rooms/'.length));
    const okd = destroyRoom(name);
    return json(res, { ok: okd });
  }

  // /static/* -> local xterm files (offline-safe, CDN 404 fallback)
  if (url.pathname.startsWith('/static/')) {
    const file = url.pathname.slice('/static/'.length);
    const safe = /^[ -\u007f]+$/.test(file) && !file.includes('..');
    if (safe) {
      const p = path.join(__dirname, 'static', file);
      if (fs.existsSync(p)) {
        const ct = p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  // anything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://localhost');
  const roomName = u.searchParams.get('room');
  const room = roomName ? rooms.get(roomName) : null;

  if (!roomName || !room) {
    ws.send(JSON.stringify({ type: 'error', error: 'no such room: ' + (roomName || 'none') }));
    return ws.close(1008, 'no such room');
  }

  room.clients.add(ws);
  if (room.name === NOTIFY_ROOM_NAME) {
    // notify-only connection: no PTY output, just the notify messages
    console.log(`[+] notify client joined (${room.clients.size} clients)`);
    ws.send(JSON.stringify({ type: 'ready', room: room.name, notify: true }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
    ws.on('close', () => {
      room.clients.delete(ws);
      console.log(`[-] notify client left (${room.clients.size} clients)`);
    });
    return;
  }

  console.log(`[+] client joined "${room.name}" (${room.clients.size} clients)`);
  ws.send(JSON.stringify({
    type: 'ready', room: room.name, cwd: room.cwd,
    buffer: room.outputBuf.slice(-64 * 1024),
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if ((msg.type === 'input' || msg.type === 'in') && typeof msg.data === 'string') {
        try {
          if (room.proc) {
            // 'data' is base64 (from the client); decode to UTF-8 and write bytes
            const raw = Buffer.from(msg.data, 'base64').toString('utf8');
            room.proc.write(raw);
          }
        } catch {}
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        try { if (room.proc) room.proc.resize(Math.floor(msg.cols), Math.floor(msg.rows)); } catch {}
      }
    } catch {}
  });
  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[-] client left "${room.name}" (${room.clients.size} clients)`);
  });
});

// ---------- HTML templates ----------

const INDEX_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Remote</title>
<style>
  body { background: #1e1e1e; color: #ddd; font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 20px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: #2d2d2d; border-radius: 8px; padding: 12px 16px; min-width: 240px; }
  .card a { color: #7ec; font-size: 1.05rem; text-decoration: none; font-weight: 600; }
  .card .meta { color: #888; font-size: 0.75rem; margin-top: 6px; }
  .card .del { display:block; margin-top:8px; background:#3a2424; color:#e89; border:1px solid #644; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:0.8rem; }
  .card .del:hover { background:#4a2c2c; }
  .new { background: #1e2e1e; border: 1px dashed #4a4; margin-top: 20px; padding: 16px; border-radius: 8px; }
  .new input, .new select { background: #1e1e1e; color: #ddd; border: 1px solid #555; padding: 6px 10px; border-radius: 4px; margin-right: 8px; }
  .new button { background: #2a5; color: #fff; border: none; padding: 8px 20px; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  .new button:hover { background: #3b6; }
  #err { color: #f77; margin-top: 8px; font-size: 0.85rem; }
</style>
</head><body>
<h1>Pi Remote</h1>
<div class="sub">sessions on this server</div>
<div id="rooms" class="cards"></div>
<div class="new">
  <b>New session</b>
  <input id="name" placeholder="komus" required maxlength="40">
  <select id="cwd"><option>load projects...</option></select>
  <input id="cwdCustom" placeholder="C:\\MyProjects\\komus" style="width:220px" required>
  <button onclick="createRoom()">Start</button>
  <div id="err"></div>
</div>
<script>
async function deleteRoom(name) {
  if (!confirm('Terminate session "' + name + '"? The PTY process will be killed.')) return;
  try {
    const r = await fetch('/api/rooms/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) {
      document.getElementById('err').textContent = 'Failed to terminate "' + name + '" (HTTP ' + r.status + ')';
      return;
    }
  } catch (e) {
    document.getElementById('err').textContent = 'Failed to terminate "' + name + '": ' + e.message;
    return;
  }
  load();
}
async function load() {
  const r = await fetch('/api/rooms'); const d = await r.json();
  const box = document.getElementById('rooms');
  box.innerHTML = '';
  for (const room of d.rooms) {
    const div = document.createElement('div');
    div.className = 'card';
    const a = document.createElement('a'); a.href = '/room/' + encodeURIComponent(room.name); a.textContent = room.name;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = room.cwd + '  \u00b7  ' + room.clients + ' client(s)  \u00b7  ' + new Date(room.createdAt).toLocaleTimeString();
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '\u2715 Close session';
    del.title = 'Terminate this session (kills the PTY)';
    del.onclick = function () { deleteRoom(room.name); };
    div.appendChild(a); div.appendChild(meta); div.appendChild(del);
    box.appendChild(div);
  }
}
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',
  щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function autoNameFromCwd(cwd) {
  if (!cwd) return '';
  const seg = cwd.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || '';
  const low = seg.toLowerCase();
  let out = '';
  for (const ch of low) { out += TRANSLIT[ch] ?? (/[a-z0-9_-]/.test(ch) ? ch : '_'); }
  out = out.replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'room';
  return out;
}
async function loadProjects() {
  const r = await fetch('/api/projects'); const d = await r.json();
  const sel = document.getElementById('cwd');
  sel.innerHTML = '';
  const all = document.createElement('option'); all.value = ''; all.textContent = d.root + '\\...';
  sel.appendChild(all);
  for (const p of d.projects) {
    const o = document.createElement('option'); o.value = d.root + '\\\\' + p; o.textContent = p;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    document.getElementById('cwdCustom').value = sel.value;
    document.getElementById('name').value = autoNameFromCwd(sel.value);
  };
  document.getElementById('name').value = autoNameFromCwd(sel.value);
}
async function createRoom() {
  const name = document.getElementById('name').value.trim();
  const cwd = document.getElementById('cwdCustom').value.trim();
  const errEl = document.getElementById('err'); errEl.textContent = '';
  if (!name) { errEl.textContent = 'Name required'; return; }
  if (!cwd) { errEl.textContent = 'Working directory required'; return; }
  const r = await fetch('/api/rooms', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, cwd }) });
  const d = await r.json();
  if (r.status === 409) { // room already exists -- open it, don't show an error
    window.location.href = '/room/' + encodeURIComponent(name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40));
    return;
  }
  if (!r.ok) { errEl.textContent = d.error || 'Failed'; return; }
  window.location.href = '/room/' + encodeURIComponent(d.room.name);
}
load(); loadProjects();
setInterval(load, 5000);
// Notify WebSocket: listens for billing-window reset notifications and shows toasts
(function () {
  function showToast(title, body, type) {
    var toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;max-width:380px;padding:14px 18px;border-radius:10px;'
      + 'background:#1a1a2e;color:#eee;font:14px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);'
      + 'border-left:4px solid ' + (type === 'billing:window_reset' ? '#4caf50' : '#2196f3') + ';'
      + 'transition:opacity .5s;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:4px;';
    h.textContent = title;
    var p = document.createElement('div');
    p.textContent = body || '';
    toast.appendChild(h); toast.appendChild(p);
    document.body.appendChild(toast);
    setTimeout(function () { toast.style.opacity = '0'; }, 9000);
    setTimeout(function () { toast.remove(); }, 10000);
  }
  function connectNotify() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    console.log('[notify-ws] connecting to', proto + '//' + location.host + '/ws?room=__notify_index__');
    var nws = new WebSocket(proto + '//' + location.host + '/ws?room=__notify_index__');
    nws.onopen = function () { console.log('[notify-ws] connected'); };
    nws.onerror = function (e) { console.error('[notify-ws] error', e); };
    nws.onclose = function (e) { console.log('[notify-ws] closed', e.code, e.reason); setTimeout(connectNotify, 3000); };
    nws.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        console.log('[notify-ws] msg:', JSON.stringify(msg));
        if (msg.type === 'notify' && msg.notify) {
          var n = msg.notify;
          showToast(n.title, n.body, n.type);
          if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification(n.title, { body: n.body }); } catch (e2) {}
          }
        }
      } catch (err) {}
    };
  }
  connectNotify();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(function () {});
  }
})();
</script>
</body></html>`;

function terminalPageHtml(roomName, cwd) {
  const rn = escapeAttr(roomName);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Pi Remote — ${escapeHtml(roomName)}</title>
<link rel="stylesheet" href="/static/xterm.css">
<style>
  html,body { margin:0; padding:0; height:100%; background:#000; overflow:hidden; }
  #wrap { display:flex; flex-direction:column; height:100%; }
  #bar { background:#1a1a1a; color:#ccc; font:13px system-ui,sans-serif; padding:6px 12px; border-bottom:1px solid #333; display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; }
  #bar a { color:#7ec; text-decoration:none; }
  #bar .cwd { color:#777; font-size:12px; }
  #bar button { background:#333; color:#ccc; border:1px solid #555; padding:3px 10px; border-radius:4px; cursor:pointer; font-size:12px; }
  #bar button:hover { background:#444; }
  #bar button.danger { background:#3a2424; color:#e8a; border-color:#644; }
  #bar button.danger:hover { background:#4a2c2c; }
  #x { flex:1; overflow:hidden; }
  #x .xterm { touch-action: pan-y; }
  #msg { color:#f77; font:12px system-ui,sans-serif; padding:0 12px; min-height:18px; }
  /* Task 2: "scroll to bottom" button, fixed bottom-right, 44x44, dark theme, safe-area aware */
  #bt { position:fixed; right:12px; bottom:calc(12px + env(safe-area-inset-bottom, 0px)); z-index:60; width:44px; height:44px; border-radius:22px; background:#2a2a2a; color:#ddd; border:1px solid #555; font:13px system-ui,sans-serif; cursor:pointer; display:none; padding:0; }
  #bt:active { background:#3a3a3a; }
  /* Task 3: virtual keys panel (in normal flow at the bottom of #wrap so it never overlays
     the TUI input line; the terminal refits above it). Hidden by default. */
  #keys { display:none; background:#161616; border-top:1px solid #333; padding:4px 4px calc(4px + env(safe-area-inset-bottom, 0px)); user-select:none; -webkit-user-select:none; }
  #keys .krow { display:flex; overflow-x:auto; -webkit-overflow-scrolling:touch; gap:4px; padding:2px 0; }
  #keys button { flex:0 0 auto; min-width:44px; height:44px; padding:0 10px; background:#2a2a2a; color:#ddd; border:1px solid #555; border-radius:6px; font:14px system-ui,sans-serif; cursor:pointer; touch-action:manipulation; }
  #keys button:active { background:#444; }
</style>
</head><body>
<div id="wrap">
  <div id="bar">
    <a href="/">&larr; sessions</a>
    <span id="rname">${escapeHtml(roomName)}</span>
    <span class="cwd">${escapeHtml(cwd)}</span>
    <button onclick="reconnect()">Reconnect</button>
    <button onclick="restartRoom()">Restart pi</button>
    <button id="keysToggle" onclick="toggleKeys()">&#x2328; Keys</button>
    <button id="delBtn" class="danger" onclick="deleteRoom()" title="Terminate the session (kills the PTY) and return to sessions">Delete</button>
  </div>
  <div id="msg"></div>
  <div id="x"></div>
  <div id="keys"></div>
</div>
<button id="bt" type="button" title="Scroll to bottom">&#x2193; Bt</button>
<script src="/static/xterm.js"></script>
<script src="/static/xterm-addon-fit.js"></script>
<script>
var roomName = ${JSON.stringify(roomName)};
var cwd = ${JSON.stringify(cwd)};
var xterm = null;
var fit = null;
var ws = null;
var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
var msgEl = document.getElementById('msg');
// ---------- Mobile UI support: shared input path, horizontal scroll clamp, scroll-to-bottom
// button, resize/orientation handling, virtual keys panel (all per the agreed mobile TZ) ----------
// Shared input path: xterm.onData and the virtual keys panel both send through sendInput(),
// so every byte goes over WS as {type:'in', data:base64} in exactly the same way.
function sendInput(d) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'in', data: btoa(unescape(encodeURIComponent(d))) })); } catch (e) {}
  }
}
// Task 1 fix: Android Chrome pans the page / .xterm-viewport sideways while the IME
// composition view grows past the right edge; clamp scrollLeft back to 0 everywhere.
function clampHScroll(el) { if (el && el.scrollLeft !== 0) el.scrollLeft = 0; }
document.addEventListener('scroll', function (e) {
  var t = e.target;
  if (t === document.scrollingElement || (t && t.classList && t.classList.contains('xterm-viewport'))) clampHScroll(t);
}, true);
setInterval(function () { clampHScroll(document.scrollingElement); }, 250); // safety net
// Task 2 helpers: bottom detection + visibility of the "scroll to bottom" button.
function atBottom() {
  if (!xterm) return true;
  try {
    var buf = xterm.buffer.active;
    return buf.viewportY >= buf.length - xterm.rows - 1;
  } catch (e) { return true; }
}
function scrollToBottom() {
  if (!xterm) return;
  try {
    // xterm v6: buffer.viewportY is read-only in this build, so use the public
    // scrollToBottom() API; the viewportY write stays as a fallback for older builds.
    if (typeof xterm.scrollToBottom === 'function') xterm.scrollToBottom();
    else xterm.buffer.active.viewportY = Math.max(0, xterm.buffer.active.length - xterm.rows);
  } catch (e) {}
  updateBtBtn();
}
function updateBtBtn() {
  var b = document.getElementById('bt');
  if (b) b.style.display = atBottom() ? 'none' : 'block';
}
// Task 3: virtual keys panel data. Sequences are plain JS escapes; arrow labels use unicode
// escapes so this file stays ASCII. Ctrl combos are ready-made control bytes (variant A).
var KEY_ROWS = [
  [
    { l: 'Esc', d: '\\x1b' },
    { l: 'Tab', d: '\\x09' },
    { l: '\\u2191', d: '\\x1b[A' },
    { l: '\\u2193', d: '\\x1b[B' },
    { l: '\\u2190', d: '\\x1b[D' },
    { l: '\\u2192', d: '\\x1b[C' },
    { l: 'Home', d: '\\x1b[H' },
    { l: 'End', d: '\\x1b[F' },
    { l: 'PgUp', d: '\\x1b[5~' },
    { l: 'PgDn', d: '\\x1b[6~' },
    { l: 'Enter', d: '\\x0d' }
  ],
  [
    { l: 'Ctrl+C', d: '\\x03' },
    { l: 'Ctrl+D', d: '\\x04' },
    { l: 'Ctrl+Z', d: '\\x1a' },
    { l: 'Ctrl+U', d: '\\x15' },
    { l: 'Ctrl+R', d: '\\x12' },
    { l: 'Ctrl+L', d: '\\x0c' },
    { l: '\\u2193 Bt', bt: true }
  ]
];
function buildKeysPanel() {
  var panel = document.getElementById('keys');
  if (!panel || panel.getAttribute('data-built')) return panel;
  panel.setAttribute('data-built', '1');
  for (var r = 0; r < KEY_ROWS.length; r++) {
    var row = document.createElement('div');
    row.className = 'krow';
    for (var i = 0; i < KEY_ROWS[r].length; i++) {
      (function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = k.l;
        var fire = function (e) {
          e.preventDefault(); // do not drop xterm focus
          if (k.bt) scrollToBottom(); else sendInput(k.d);
          if (xterm && xterm.focus) xterm.focus();
        };
        b.addEventListener('touchstart', fire, { passive: false });
        b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus on desktop too
        b.addEventListener('click', function (e) { e.preventDefault(); if (k.bt) scrollToBottom(); else sendInput(k.d); });
        row.appendChild(b);
      })(KEY_ROWS[r][i]);
    }
    panel.appendChild(row);
  }
  return panel;
}
function toggleKeys(force) {
  var panel = buildKeysPanel();
  if (!panel) return;
  // compare against the computed style: the initial hidden state comes from the
  // stylesheet, so the inline style is empty on the very first toggle
  var show = (typeof force === 'boolean') ? force : (getComputedStyle(panel).display === 'none');
  panel.style.display = show ? 'block' : 'none';
  try { localStorage.setItem('piKeysPanel', show ? '1' : '0'); } catch (e) {}
  var bt = document.getElementById('bt');
  if (bt) bt.style.bottom = show ? (panel.offsetHeight + 16) + 'px' : ''; // keep Bt above the panel
  if (show && xterm) { fitNow(); afterFit(); } // terminal refits in the space above the panel
}
// Task 2: resize / orientation handling, debounced ~150ms.
// Orientation change (aspect ratio flipped) -> refit, then ALWAYS jump to the bottom (agreed).
// Keyboard-only viewport resize (visualViewport, no orientation change) -> keep reading position.
var lastLandscape = null;
var resizeTimer = null;
function currentLandscape() { return (window.innerWidth || 0) > (window.innerHeight || 0); }
function fitNow() { try { fit.fit(); } catch (e) {} }
function afterFit() {
  try { if (xterm && xterm.refresh) xterm.refresh(); } catch (e) {}
  if (ws && ws.readyState === 1 && xterm) {
    try { ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows })); } catch (e) {}
  }
  updateBtBtn();
}
function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    resizeTimer = null;
    var landscape = currentLandscape();
    var rotated = (lastLandscape !== null && landscape !== lastLandscape);
    lastLandscape = landscape;
    if (rotated) {
      requestAnimationFrame(function () { // double rAF: let the rotated layout settle
        requestAnimationFrame(function () {
          fitNow();
          scrollToBottom(); // always to bottom after rotation
          afterFit();
        });
      });
    } else {
      fitNow();
      afterFit();
    }
  }, 150);
}
function setupResizeHandling() {
  lastLandscape = currentLandscape();
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  setInterval(updateBtBtn, 500); // onScroll does not fire on term.write()
}
// Toast for /api/notify events (same style as the index page)
function showToast(title, body, type) {
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;max-width:380px;padding:14px 18px;border-radius:10px;'
    + 'background:#1a1a2e;color:#eee;font:14px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);'
    + 'border-left:4px solid ' + (type === 'billing:window_reset' ? '#4caf50' : '#2196f3') + ';'
    + 'transition:opacity .5s;';
  var h = document.createElement('div');
  h.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:4px;';
  h.textContent = title;
  var p = document.createElement('div');
  p.textContent = body || '';
  toast.appendChild(h); toast.appendChild(p);
  document.body.appendChild(toast);
  setTimeout(function () { toast.style.opacity = '0'; }, 9000);
  setTimeout(function () { toast.remove(); }, 10000);
}
// Do not fit() until the container actually has size (first frames after open() can be 0x0)
function fitWhenReady(cb) {
  var attempts = 0;
  (function step() {
    var box = document.getElementById('x');
    if (box && box.getBoundingClientRect().height > 0) return cb();
    if (++attempts > 60) return cb(); // ~1s of rAFs, proceed anyway
    requestAnimationFrame(step);
  })();
}
function logMsg(m) { msgEl.textContent = m; setTimeout(function(){ if (msgEl.textContent === m) msgEl.textContent = ''; }, 3000); }
function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(proto + '//' + location.host + '/ws?room=' + encodeURIComponent(roomName));
  ws.onopen = function () {
    logMsg('connected');
    if (xterm) xterm.focus();
  };
  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.type === 'ready') {
      if (!xterm) {
        try {
          fit = new (typeof FitAddon !== 'function' ? FitAddon.FitAddon : FitAddon)();
          xterm = new Terminal({ fontSize: 14, fontFamily: 'Consolas, Menlo, monospace', cursorBlink: true, theme: { background: '#000000', foreground: '#cccccc' } });
          xterm.loadAddon(fit);
          xterm.open(document.getElementById('x'));
          xterm.onData(function (d) {
            sendInput(d);
            // Force scroll to cursor on input (restored README 5.8 feature): keeps the IME
            // composition view inside the visible area on mobile, no sideways pan needed.
            setTimeout(function () { try { scrollToBottom(); } catch (e) {} }, 0);
          });
          setupResizeHandling();
        } catch (e) { logMsg('xterm init failed: ' + e.message); return; }
      }
      if (msg.buffer) xterm.write(msg.buffer);
      fitWhenReady(function () {
        try { fit.fit(); } catch (err) { logMsg('fit failed: ' + err.message); }
        afterFit();
      });
    } else if (msg.type === 'out') {
      // Server emits: data.toString('utf8') -> JSON-stringified. msg.data is a plain
      // UTF-8 string (ANSI escapes included). No base64 in this channel -- the original
      // Buffer.from(..., 'base64') branch silently produced empty xterm rows in browsers.
      if (xterm) xterm.write(msg.data);
    } else if (msg.type === 'exit') {
      logMsg('pty exited (code ' + msg.exitCode + '), reconnecting...');
      if (ws) ws.close();
      setTimeout(connect, 1500);
    } else if (msg.type === 'notify' && msg.notify) {
      // /api/notify broadcast: toast + system notification (unknown msg.type are ignored)
      var n = msg.notify;
      showToast(n.title, n.body, n.type);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body }); } catch (e2) {}
      }
    }
  };
  ws.onclose = function (e) {
    logMsg('connection closed (code ' + e.code + '), retrying...');
    setTimeout(connect, 2000);
  };
  ws.onerror = function () { logMsg('ws error, retrying...'); };
}
async function restartRoom() {
  logMsg('restarting...');
  var r = await fetch('/api/rooms/' + encodeURIComponent(roomName), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ action: 'restart' }) });
  var d = await r.json();
  if (!r.ok) { logMsg('restart failed: ' + (d.error || r.status)); return; }
  logMsg('restarted, reconnecting...');
  if (ws) { ws.onclose = null; ws.close(); }
  ws = null;
  if (xterm) xterm.clear();
  setTimeout(connect, 800);
}
// Terminate the session: DELETE /api/rooms/:name (kills the PTY, removes the room),
// then return to the sessions list. Confirm-guarded; WS is closed first so the page
// does not flash "connection closed, retrying..." while navigating away.
async function deleteRoom() {
  if (!confirm('Terminate session "' + roomName + '"? The PTY process will be killed.')) return;
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
  try { await fetch('/api/rooms/' + encodeURIComponent(roomName), { method: 'DELETE' }); } catch (e) {}
  window.location.href = '/';
}
function reconnect() {
  if (ws) { ws.onclose = null; ws.close(); }
  ws = null;
  if (xterm) xterm.clear();
  connect();
}
// Mobile UI init: bind the scroll-to-bottom button, restore the keys panel visibility
// from localStorage (panel is hidden by default).
(function initMobileUi() {
  var b = document.getElementById('bt');
  if (b) {
    b.addEventListener('touchstart', function (e) { e.preventDefault(); scrollToBottom(); }, { passive: false });
    b.addEventListener('click', function (e) { e.preventDefault(); scrollToBottom(); });
  }
  var saved = '0';
  try { saved = localStorage.getItem('piKeysPanel') || '0'; } catch (e) {}
  if (saved === '1') toggleKeys(true);
})();
connect();
</script>
</body></html>`;
}

// ---------- start ----------

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n[+] HTTP+WS listening on http://0.0.0.0:${PORT}`);
  try {
    const ip = require('child_process').execSync('tailscale ip -4 2>nul || ipconfig 2>nul | findstr IPv4', { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim();
    if (ip) console.log(`    http://${ip}:${PORT}    <-- Tailscale (use from phone)`);
  } catch {}
  console.log(`  Projects root: ${PROJECTS_ROOT}`);
  console.log(`  Shell: ${DEFAULT_SHELL_CMD}`);
  if (!NOTIFY_TOKEN) console.log(`  [!] PI_REMOTE_NOTIFY_TOKEN not set -- notify endpoint open without auth\n`);
  console.log(`  Press Ctrl+C to stop\n`);
});
