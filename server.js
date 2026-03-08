const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = '9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a';

// AIS ship types 60-69 = all passenger vessel subtypes
const CRUISE_SHIP_TYPES = new Set([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);

const positionCache = {};
const clients = new Set();

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('CruiseRadar AIS Proxy running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log(`[Proxy] Browser client connected (${clients.size + 1} total)`);
  clients.add(clientWs);

  const cached = Object.values(positionCache).filter(s => s.static && s.position);
  if (cached.length > 0) {
    console.log(`[Proxy] Sending ${cached.length} cached ships to new client`);
    cached.forEach(s => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'position', mmsi: s.mmsi, position: s.position, static: s.static }));
      }
    });
  }

  clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

  clientWs.on('close', () => { clients.delete(clientWs); console.log(`[Proxy] Client disconnected (${clients.size} remaining)`); });
  clientWs.on('error', (err) => { clients.delete(clientWs); });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

let msgCount = 0, shipCount = 0;

function connectAIS() {
  console.log('[AIS] Connecting...');
  let aisWs;
  try { aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream'); }
  catch(e) { console.error('[AIS] WS create failed:', e.message); setTimeout(connectAIS, 5000); return; }

  aisWs.on('open', () => {
    console.log('[AIS] Connected — subscribing worldwide passenger ships');
    aisWs.send(JSON.stringify({
      APIKey: AIS_API_KEY,
      MessageType: 'Subscribe',
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      BoundingBoxes: [[[-90, -180], [90, 180]]]
    }));
    broadcast({ type: 'status', status: 'connected' });
  });

  aisWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      msgCount++;
      if (msgCount % 500 === 0) console.log(`[AIS] ${msgCount} msgs, ${shipCount} cruise ships`);

      if (msg.MessageType === 'ShipStaticData') {
        const mmsi = String(msg.Message.ShipStaticData.UserID);
        const shipType = msg.Message.ShipStaticData.Type;

        // Accept all passenger ship types 60-69
        if (CRUISE_SHIP_TYPES.has(shipType)) {
          if (!positionCache[mmsi]) positionCache[mmsi] = {};
          positionCache[mmsi].static = msg.Message.ShipStaticData;
          positionCache[mmsi].mmsi = mmsi;
          if (positionCache[mmsi].position) {
            broadcast({ type: 'position', mmsi, position: positionCache[mmsi].position, static: positionCache[mmsi].static });
          }
        }
        return;
      }

      if (msg.MessageType !== 'PositionReport') return;

      const mmsi = String(msg.Message.PositionReport.UserID);
      const pos = msg.Message.PositionReport;

      if (pos.Latitude === 0 && pos.Longitude === 0) return;
      if (Math.abs(pos.Latitude) > 90 || Math.abs(pos.Longitude) > 180) return;

      const known = positionCache[mmsi];
      if (known && known.static) {
        const wasNew = !known.position;
        positionCache[mmsi].position = pos;
        if (wasNew) { shipCount++; console.log(`[AIS] Cruise ship online: ${known.static.Name || mmsi} (${shipCount} total)`); }
        broadcast({ type: 'position', mmsi, position: pos, static: known.static });
      } else {
        if (!positionCache[mmsi]) positionCache[mmsi] = { mmsi };
        positionCache[mmsi].position = pos;
      }
    } catch(e) { console.warn('[AIS] Parse error:', e.message); }
  });

  aisWs.on('close', () => { console.log('[AIS] Disconnected — reconnecting in 5s'); broadcast({ type: 'status', status: 'reconnecting' }); setTimeout(connectAIS, 5000); });
  aisWs.on('error', (err) => { console.error('[AIS] Error:', err.message); });
}

server.listen(PORT, () => { console.log(`[Proxy] Listening on port ${PORT}`); connectAIS(); });
