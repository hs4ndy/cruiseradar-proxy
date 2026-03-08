const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = '9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a';

const TRACKED_MMSI = [
  311000424, 311000710, 311000369,
  353828000, 353272000, 247378000,
  255806390, 311000410, 311000535,
  229356000, 353611000, 248177000,
];

// Cache of latest position per MMSI — sent immediately to new clients
const positionCache = {};

// All currently connected browser clients
const clients = new Set();

// =====================
// HTTP SERVER
// =====================
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CruiseRadar AIS Proxy running');
});

// =====================
// BROWSER WEBSOCKET
// =====================
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log(`[Proxy] Browser client connected (${clients.size + 1} total)`);
  clients.add(clientWs);

  // Send cached positions immediately so client doesn't wait
  const cached = Object.values(positionCache);
  if (cached.length > 0) {
    console.log(`[Proxy] Sending ${cached.length} cached positions to new client`);
    cached.forEach(msg => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(msg));
      }
    });
  }

  clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

  clientWs.on('close', () => {
    clients.delete(clientWs);
    console.log(`[Proxy] Browser client disconnected (${clients.size} remaining)`);
  });

  clientWs.on('error', (err) => {
    clients.delete(clientWs);
    console.error('[Proxy] Client error:', err.message);
  });
});

// =====================
// PERSISTENT AIS CONNECTION
// =====================
function broadcast(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  });
}

let msgCount = 0;

function connectAIS() {
  console.log('[AIS] Connecting to AISstream...');
  const aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');

  aisWs.on('open', () => {
    console.log('[AIS] Connected to AISstream');
    aisWs.send(JSON.stringify({
      APIKey: AIS_API_KEY,
      MessageType: 'Subscribe',
      FilterMessageTypes: ['PositionReport'],
      BoundingBoxes: [[[-90, -180], [90, 180]]] // whole world
    }));
    broadcast({ type: 'status', status: 'connected' });
  });

  aisWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.MessageType !== 'PositionReport') return;

      msgCount++;
      if (msgCount % 100 === 0) console.log(`[AIS] ${msgCount} total messages received`);

      const mmsi = String(msg.Message.PositionReport.UserID);

      // Only forward ships we care about
      if (!TRACKED_MMSI.includes(Number(mmsi))) return;

      // Cache latest position for this ship
      positionCache[mmsi] = msg;

      // Forward to all connected browser clients
      broadcast(msg);

      console.log(`[AIS] Position update: MMSI ${mmsi} — ${clients.size} client(s) notified`);
    } catch (e) {
      console.warn('[AIS] Parse error:', e.message);
    }
  });

  aisWs.on('close', () => {
    console.log('[AIS] AISstream disconnected — reconnecting in 5s...');
    broadcast({ type: 'status', status: 'reconnecting' });
    setTimeout(connectAIS, 5000);
  });

  aisWs.on('error', (err) => {
    console.error('[AIS] Error:', err.message);
  });
}

// =====================
// START
// =====================
server.listen(PORT, () => {
  console.log(`[Proxy] Listening on port ${PORT}`);
  connectAIS(); // Connect to AIS once on startup, stays connected permanently
});
