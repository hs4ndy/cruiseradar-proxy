const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = process.env.AIS_API_KEY || '9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a';

const TRACKED_MMSI = [
  311000424, 311000710, 311000369,
  353828000, 353272000, 247378000,
  255806390, 311000410, 311000535,
  229356000, 353611000, 248177000,
];

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CruiseRadar AIS Proxy running');
});

const wss = new WebSocketServer({ server });

console.log(`[Proxy] Starting on port ${PORT}`);

wss.on('connection', (clientWs, req) => {
  const origin = req.headers.origin || 'unknown';
  console.log(`[Proxy] Client connected from ${origin}`);

  // Connect to AISstream on behalf of this client
  const aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');

  aisWs.on('open', () => {
    console.log('[Proxy] Connected to AISstream');
    aisWs.send(JSON.stringify({
      APIKey: AIS_API_KEY,
      MessageType: 'Subscribe',
      FilterMessageTypes: ['PositionReport'],
      MMSI: TRACKED_MMSI
    }));
    // Let the client know we're live
    clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
  });

  // Forward AIS messages to the browser client
  aisWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  aisWs.on('close', () => {
    console.log('[Proxy] AISstream connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
    }
  });

  aisWs.on('error', (err) => {
    console.error('[Proxy] AISstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'status', status: 'error' }));
    }
  });

  // Clean up AIS connection when browser disconnects
  clientWs.on('close', () => {
    console.log('[Proxy] Client disconnected');
    aisWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('[Proxy] Client error:', err.message);
    aisWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`[Proxy] Listening on port ${PORT}`);
});
