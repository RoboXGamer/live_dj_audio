import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('room approval gates signaling and host departure closes the room', async () => {
  const port = 18347;
  const server = spawn(process.execPath, ['index.mjs'], { cwd: import.meta.dirname, env: { ...process.env, PORT: String(port), TLS_KEY: '', TLS_CERT: '' } });
  const sockets = [];
  const connect = async () => { const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`); sockets.push(ws); await once(ws, 'open'); ws.messages = []; ws.on('message', x => ws.messages.push(JSON.parse(x))); return ws; };
  const next = async (ws, type) => { const until = Date.now() + 2000; while (Date.now() < until) { const i = ws.messages.findIndex(x => x.type === type); if (i >= 0) return ws.messages.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 10)); } throw Error(`Timed out waiting for ${type}`); };
  try {
    await once(server.stdout, 'data');
    const response = await fetch(`http://127.0.0.1:${port}/`); assert.equal(response.status, 200); assert.match(await response.text(), /Roomtone/);
    const host = await connect(); host.send(JSON.stringify({ type: 'create' })); const created = await next(host, 'created');
    const phone = await connect(); phone.send(JSON.stringify({ type: 'join', room: created.room, name: 'Singer' })); await next(phone, 'waiting'); const joined = await next(host, 'peer-joined');
    phone.send(JSON.stringify({ type: 'signal', data: { test: 'blocked' } })); await new Promise(r => setTimeout(r, 50)); assert.equal(host.messages.some(x => x.type === 'signal'), false);
    host.send(JSON.stringify({ type: 'approve', id: joined.id })); await next(phone, 'approved'); await next(host, 'peer-approved');
    phone.send(JSON.stringify({ type: 'signal', data: { test: 'allowed' } })); assert.equal((await next(host, 'signal')).data.test, 'allowed');
    host.close(); await next(phone, 'room-closed');
  } finally { sockets.forEach(s => s.terminate()); server.kill(); }
});
