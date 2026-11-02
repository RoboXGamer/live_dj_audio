import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const app = new Hono();
app.get('/api/network', c => c.json({ addresses: Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address) }));
app.use('/*', serveStatic({ root: fileURLToPath(new URL('../ui/dist/', import.meta.url)) }));
const listener = getRequestListener(app.fetch);
const tls = process.env.TLS_KEY && process.env.TLS_CERT;
const server = tls ? httpsServer({ key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) }, listener) : httpServer(listener);
const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 65536 });
const rooms = new Map();
const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  if (room.host === ws) { for (const peer of room.peers.values()) { send(peer, { type: 'room-closed' }); peer.close(); } rooms.delete(ws.room); }
  else if (room.peers.delete(ws.id)) send(room.host, { type: 'peer-left', id: ws.id });
  ws.room = null;
}
wss.on('connection', ws => {
  ws.on('error', () => {});
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'create' && !ws.room) {
      let code; do { code = randomBytes(4).toString('hex'); } while (rooms.has(code));
      ws.room = code; rooms.set(code, { host: ws, peers: new Map() }); send(ws, { type: 'created', room: code }); return;
    }
    if (m.type === 'join' && !ws.room) {
      const room = rooms.get(m.room); if (!room || room.peers.size >= 12) return send(ws, { type: 'error', message: 'Room not found or full.' });
      ws.room = m.room; ws.id = randomUUID(); ws.approved = false; ws.name = String(m.name || 'Microphone').trim().slice(0, 32) || 'Microphone'; room.peers.set(ws.id, ws);
      send(ws, { type: 'waiting' }); send(room.host, { type: 'peer-joined', id: ws.id, name: ws.name }); return;
    }
    const room = rooms.get(ws.room); if (!room) return;
    if (room.host === ws) {
      const peer = room.peers.get(m.id); if (!peer) return;
      if (m.type === 'approve' && !peer.approved) { peer.approved = true; send(peer, { type: 'approved' }); send(ws, { type: 'peer-approved', id: peer.id }); }
      else if (m.type === 'remove') { send(peer, { type: 'removed' }); peer.close(); }
      else if (m.type === 'signal' && peer.approved) send(peer, { type: 'signal', data: m.data });
    } else if (m.type === 'signal' && ws.approved) send(room.host, { type: 'signal', id: ws.id, data: m.data });
  });
  ws.on('close', () => leave(ws));
});
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Roomtone listening on ${tls ? 'https' : 'http'}://${process.env.HOST || '0.0.0.0'}:${port}`));



