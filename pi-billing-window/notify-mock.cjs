// notify-mock.js — имитирует POST /api/notify, как его делает pi-billing-window
// Использование:
//   node notify-mock.js [token]
//   (token по умолчанию — из NOTIFY_TOKEN.txt в том же каталоге)
//
// Отправляет payload, идентичный тому, что шлёт notifier.ts:
//   { type: "billing:window_reset", provider: "wormsoft", title, body, timestamp }
// с заголовком X-Notify-Token.

const http = require('http');
const fs = require('fs');
const path = require('path');

const URL_TARGET = process.env.PI_REMOTE_URL || 'http://localhost:7681/api/notify';
const tokenArg = process.argv[2];
let token = tokenArg;
if (!token) {
  try {
    const f = path.join(__dirname, 'NOTIFY_TOKEN.txt');
    token = (fs.readFileSync(f, 'utf8') || '').trim();
  } catch (_) { token = null; }
}

const body = {
  type: 'billing:window_reset',
  provider: 'wormsoft',
  title: 'Wormsoft: лимит обновлён',
  body: '2-часовое окно сброшено (reset #' + (Math.floor(Math.random() * 999) + 1) + '). Свежие 5M токенов доступны.',
  timestamp: Date.now(),
};

const data = JSON.stringify(body);
const u = new URL(URL_TARGET);
const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
if (token) headers['X-Notify-Token'] = token;

console.log('[mock] POST', URL_TARGET, 'token set =', !!token);
const r = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers }, res => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    console.log('[mock] status', res.statusCode, 'body', buf);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});
r.on('error', e => { console.error('[mock] error', e.message); process.exit(1); });
r.write(data);
r.end();
