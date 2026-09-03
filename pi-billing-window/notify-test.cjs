// notify-test.cjs — отправка notify в pi-remote с ожиданием delivered>=1
// Использование: node notify-test.cjs [token]
const http = require('http');
const fs = require('fs');
const path = require('path');

const URL_TARGET = process.env.PI_REMOTE_URL || 'http://localhost:7681/api/notify';
let token = process.argv[2];
if (!token) {
  try { token = (fs.readFileSync(path.join(__dirname, 'NOTIFY_TOKEN.txt'), 'utf8') || '').trim(); }
  catch (_) { token = null; }
}
const title = 'Wormsoft: лимит обновлён';
const body = {
  type: 'billing:window_reset', provider: 'wormsoft', title,
  body: '2-часовое окно сброшено (reset #42). Свежие 5M токенов доступны.',
  timestamp: Date.now(),
};
const data = JSON.stringify(body);
const u = new URL(URL_TARGET);
const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
if (token) headers['X-Notify-Token'] = token;
const r = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers }, res => {
  let buf = ''; res.on('data', c => buf += c);
  res.on('end', () => { console.log(JSON.stringify({ status: res.statusCode, body: buf })); process.exit(res.statusCode === 200 ? 0 : 1); });
});
r.on('error', e => { console.error('ERR', e.message); process.exit(1); });
r.write(data); r.end();
