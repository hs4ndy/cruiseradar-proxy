const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = '9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a';

// Broadened — accept passenger types AND type 0 (unspecified) since many cruise
// ships broadcast as 0. We let the client do name-based filtering.
const ACCEPTED_SHIP_TYPES = new Set([0, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);

// Known cruise ship MMSIs — always accept these regardless of type
const KNOWN_CRUISE_MMSIS = new Set([
  '311000424','311000710','311000369','311000535','311000410',
  '353828000','353272000','353611000','353453000','354354000',
  '247378000','255806390','248177000','248284000','247365000',
  '229356000','310627000','310627000','338234631','338234632',
]);

// Trail history config
const MAX_TRAIL_POINTS = 2000;
const HISTORY_MAX_AGE  = 48 * 60 * 60 * 1000;
const STATIONARY_SPEED = 0.4;
const DEPART_SPEED     = 1.0;

const positionCache = {};
const trailHistory  = {};
const lastSpeed     = {};
const clients       = new Set();

// Debug counters
let msgCount = 0, shipCount = 0, rejectedType = 0, rejectedCoords = 0;

// ─── HTTP server (health check) ───────────────────────────────────────────────
const server = createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('CruiseRadar AIS Proxy running');
});

// ─── WebSocket server (browser clients) ───────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log(`[Proxy] Browser client connected (${clients.size + 1} total)`);
  clients.add(clientWs);

  // Send all cached ships + their trail history to the new client
  const cached = Object.values(positionCache).filter(s => s.static && s.position);
  if (cached.length > 0) {
    console.log(`[Proxy] Sending ${cached.length} cached ships to new client`);
    cached.forEach(s => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      const trail = trailHistory[s.mmsi] || [];
      clientWs.send(JSON.stringify({
        type:     'position',
        mmsi:     s.mmsi,
        position: s.position,
        static:   s.static,
        trail:    trail,
        lastSeen: s.lastSeen || Date.now()
      }));
    });
  }

  clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

  clientWs.on('close', () => {
    clients.delete(clientWs);
    console.log(`[Proxy] Client disconnected (${clients.size} remaining)`);
  });
  clientWs.on('error', () => { clients.delete(clientWs); });
});

// ─── Broadcast to all browser clients ─────────────────────────────────────────
function broadcast(data) {
  const str = JSON.stringify(data);
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  });
}

// ─── Trail helpers ─────────────────────────────────────────────────────────────

function pruneOldPoints(mmsi) {
  if (!trailHistory[mmsi]) return;
  const cutoff = Date.now() - HISTORY_MAX_AGE;
  trailHistory[mmsi] = trailHistory[mmsi].filter(p => p.ts >= cutoff);
}

function addTrailPoint(mmsi, lat, lon) {
  if (!trailHistory[mmsi]) trailHistory[mmsi] = [];
  trailHistory[mmsi].push({ lat, lon, ts: Date.now() });
  // Cap to max points
  if (trailHistory[mmsi].length > MAX_TRAIL_POINTS) {
    trailHistory[mmsi].shift();
  }
}

function resetTrail(mmsi) {
  trailHistory[mmsi] = [];
}

// ─── Periodic trail cleanup (every 30 min) ────────────────────────────────────
setInterval(() => {
  let pruned = 0;
  Object.keys(trailHistory).forEach(mmsi => {
    const before = trailHistory[mmsi].length;
    pruneOldPoints(mmsi);
    pruned += before - trailHistory[mmsi].length;
  });
  if (pruned > 0) console.log(`[Trail] Pruned ${pruned} old trail points`);
}, 30 * 60 * 1000);

// ─── AIS connection ────────────────────────────────────────────────────────────
let msgCount = 0, shipCount = 0;

function connectAIS() {
  console.log('[AIS] Connecting...');
  let aisWs;
  try {
    aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');
  } catch(e) {
    console.error('[AIS] WS create failed:', e.message);
    setTimeout(connectAIS, 5000);
    return;
  }

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
      if (msgCount % 500 === 0) {
        console.log(`[AIS] ${msgCount} msgs, ${shipCount} cruise ships tracked`);
      }

      // ── Static data ──────────────────────────────────────────────────────────
      if (msg.MessageType === 'ShipStaticData') {
        const mmsi     = String(msg.Message.ShipStaticData.UserID);
        const shipType = msg.Message.ShipStaticData.Type;
        const name     = (msg.Message.ShipStaticData.Name || '').trim();

        // Accept if: known cruise MMSI, passenger type, OR type 0 with a name
        const isKnown    = KNOWN_CRUISE_MMSIS.has(mmsi);
        const isPassenger= ACCEPTED_SHIP_TYPES.has(shipType);

        if (!isKnown && !isPassenger) {
          rejectedType++;
          if (rejectedType % 200 === 0) console.log(`[AIS] Rejected ${rejectedType} non-passenger static msgs so far`);
          return;
        }

        if (!positionCache[mmsi]) positionCache[mmsi] = { mmsi };
        positionCache[mmsi].static = msg.Message.ShipStaticData;

        if (name) console.log(`[Static] ${mmsi} | type:${shipType} | name:"${name}"`);

        if (positionCache[mmsi].position) {
          broadcast({
            type:     'position',
            mmsi,
            position: positionCache[mmsi].position,
            static:   positionCache[mmsi].static,
            trail:    trailHistory[mmsi] || [],
            lastSeen: positionCache[mmsi].lastSeen || Date.now()
          });
        }
        return;
      }

      // ── Position report ───────────────────────────────────────────────────────
      if (msg.MessageType !== 'PositionReport') return;

      const mmsi = String(msg.Message.PositionReport.UserID);
      const pos  = msg.Message.PositionReport;

      // Sanity check coordinates
      if (pos.Latitude === 0 && pos.Longitude === 0) { rejectedCoords++; return; }
      if (Math.abs(pos.Latitude) > 90 || Math.abs(pos.Longitude) > 180) { rejectedCoords++; return; }

      const speedKnots = pos.Sog || 0;
      const prevSpeed  = lastSpeed[mmsi] || 0;

      // Departure detection — was stationary, now moving → reset trail
      if (prevSpeed < STATIONARY_SPEED && speedKnots >= DEPART_SPEED) {
        console.log(`[Trail] Departure detected for MMSI ${mmsi} — resetting trail`);
        resetTrail(mmsi);
      }

      // Add position to trail if ship is underway
      if (speedKnots >= DEPART_SPEED) {
        addTrailPoint(mmsi, pos.Latitude, pos.Longitude);
      }

      lastSpeed[mmsi] = speedKnots;

      const now = Date.now();

      if (!positionCache[mmsi]) positionCache[mmsi] = { mmsi };
      const wasNew = !positionCache[mmsi].position;
      positionCache[mmsi].position = pos;
      positionCache[mmsi].lastSeen = now;

      if (positionCache[mmsi].static) {
        if (wasNew) {
          shipCount++;
          const name = positionCache[mmsi].static.Name || mmsi;
          const type = positionCache[mmsi].static.Type;
          console.log(`[AIS] ✓ Ship online: "${name}" | MMSI:${mmsi} | type:${type} | (${shipCount} total)`);
        }
        broadcast({
          type:     'position',
          mmsi,
          position: pos,
          static:   positionCache[mmsi].static,
          trail:    trailHistory[mmsi] || [],
          lastSeen: now
        });
      } else {
        positionCache[mmsi].position = pos;
      }

    } catch(e) {
      console.warn('[AIS] Parse error:', e.message);
    }
  });

  aisWs.on('close', () => {
    console.log('[AIS] Disconnected — reconnecting in 5s');
    broadcast({ type: 'status', status: 'reconnecting' });
    setTimeout(connectAIS, 5000);
  });

  aisWs.on('error', (err) => {
    console.error('[AIS] Error:', err.message);
  });
}

server.listen(PORT, () => {
  console.log(`[Proxy] Listening on port ${PORT}`);
  connectAIS();
});
