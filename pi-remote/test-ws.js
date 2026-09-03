const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:7681/ws?room=__notify_index__');

ws.on('open', () => {
  console.log('CONNECTED to notify room');
  setTimeout(() => process.exit(0), 6000);
});
ws.on('message', (data) => {
  console.log('GOT MSG:', data.toString().slice(0, 300));
});
ws.on('error', (e) => {
  console.log('ERROR:', e.message);
  process.exit(1);
});
ws.on('close', () => console.log('CLOSED'));