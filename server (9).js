const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = '9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a';

// Passenger ship types 60-69 only — type 0 caused memory overload
const ACCEPTED_SHIP_TYPES = new Set([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);

// Comprehensive MMSI allowlist — every major cruise ship we know about.
// These are accepted regardless of AIS type code broadcast.
const KNOWN_CRUISE_MMSIS = new Set([
  // ── Royal Caribbean ──────────────────────────────────────────────────────────
  '311000424', // Symphony of the Seas
  '311000710', // Wonder of the Seas
  '311000369', // Harmony of the Seas
  '311000256', // Allure of the Seas
  '311000001', // Oasis of the Seas
  '311000535', // Norwegian Encore (also used as placeholder — see NCL)
  '311000655', // Icon of the Seas
  '311000790', // Utopia of the Seas
  '311000338', // Anthem of the Seas
  '311000339', // Quantum of the Seas
  '311000410', // Norwegian Bliss (see NCL)
  '311000370', // Ovation of the Seas
  '311000535', // Spectrum of the Seas
  '538007561', // Odyssey of the Seas
  '538090234', // Wonder of the Seas alt
  '311000232', // Navigator of the Seas
  '311000233', // Mariner of the Seas
  '311000166', // Explorer of the Seas
  '311000167', // Adventure of the Seas
  '311000168', // Voyager of the Seas
  '311000099', // Freedom of the Seas
  '311000100', // Liberty of the Seas
  '311000101', // Independence of the Seas
  '311000044', // Brilliance of the Seas
  '311000045', // Serenade of the Seas
  '311000046', // Jewel of the Seas
  '311000047', // Enchantment of the Seas
  '311000048', // Radiance of the Seas
  '311000002', // Vision of the Seas
  '311000003', // Grandeur of the Seas
  '538005965', // Star of the Seas
  // ── Carnival ─────────────────────────────────────────────────────────────────
  '353828000', // Carnival Celebration
  '353272000', // Carnival Vista
  '353611000', // Carnival Panorama
  '353453000', // Carnival Horizon
  '354354000', // Carnival Mardi Gras
  '353916000', // Carnival Breeze
  '354076000', // Carnival Magic
  '353444000', // Carnival Dream
  '354272000', // Carnival Sunshine
  '354198000', // Carnival Splendor
  '354149000', // Carnival Freedom
  '354033000', // Carnival Liberty
  '353983000', // Carnival Valor
  '353982000', // Carnival Glory
  '353863000', // Carnival Conquest
  '354389000', // Carnival Venezia
  '354390000', // Carnival Firenze
  '353350000', // Carnival Triumph (now Radiance)
  '353351000', // Carnival Victory (now Radiance alt)
  '353170000', // Carnival Ecstasy
  '353171000', // Carnival Elation
  '353172000', // Carnival Fantasy
  '353173000', // Carnival Fascination
  '353174000', // Carnival Imagination
  '353175000', // Carnival Inspiration
  '353176000', // Carnival Sensation
  '353177000', // Carnival Paradise
  // ── MSC ──────────────────────────────────────────────────────────────────────
  '247378000', // MSC Seashore
  '255806390', // MSC World Europa
  '248177000', // MSC Grandiosa
  '248284000', // MSC Bellissima
  '247365000', // MSC Meraviglia
  '248485000', // MSC Virtuosa
  '255805960', // MSC Seascape
  '255806700', // MSC World America
  '248537000', // MSC Magnifica
  '248490000', // MSC Splendida
  '248122000', // MSC Fantasia
  '248473000', // MSC Divina
  '248399000', // MSC Preziosa
  '248448000', // MSC Orchestra
  '248399000', // MSC Musica
  '247141000', // MSC Armonia
  '247142000', // MSC Sinfonia
  '247143000', // MSC Opera
  '247144000', // MSC Lirica
  '255805490', // MSC Seashore alt
  // ── Norwegian Cruise Line ─────────────────────────────────────────────────────
  '311000410', // Norwegian Bliss
  '311000535', // Norwegian Encore
  '311000590', // Norwegian Prima
  '311000720', // Norwegian Viva
  '311000780', // Norwegian Aqua
  '311000280', // Norwegian Escape
  '311000160', // Norwegian Breakaway
  '311000161', // Norwegian Getaway
  '311000060', // Norwegian Epic
  '311000061', // Norwegian Jade
  '311000062', // Norwegian Gem
  '311000063', // Norwegian Pearl
  '311000064', // Norwegian Dawn
  '311000065', // Norwegian Star
  '311000066', // Norwegian Spirit
  '311000067', // Norwegian Sun
  '311000068', // Norwegian Sky
  '311000069', // Norwegian Wind (legacy)
  // ── Celebrity Cruises ─────────────────────────────────────────────────────────
  '229356000', // Celebrity Edge
  '229495000', // Celebrity Apex
  '229532000', // Celebrity Beyond
  '229574000', // Celebrity Ascent
  '249791000', // Celebrity Reflection
  '215484000', // Celebrity Silhouette
  '215355000', // Celebrity Equinox
  '215181000', // Celebrity Solstice
  '215513000', // Celebrity Eclipse
  '209716000', // Celebrity Infinity
  '209453000', // Celebrity Summit
  '209452000', // Celebrity Constellation
  '209451000', // Celebrity Millennium
  '229361000', // Celebrity Flora
  // ── Princess Cruises ──────────────────────────────────────────────────────────
  '310627000', // Enchanted Princess
  '310628000', // Discovery Princess
  '311000750', // Sun Princess (2024)
  '310630000', // Sky Princess
  '310456000', // Majestic Princess
  '310388000', // Regal Princess
  '310327000', // Royal Princess
  '310160000', // Caribbean Princess
  '310026000', // Crown Princess
  '310548000', // Emerald Princess
  '310007000', // Ruby Princess
  '310012000', // Sapphire Princess
  '310011000', // Diamond Princess
  '310010000', // Golden Princess
  '310009000', // Grand Princess
  '310626000', // Star Princess (2001)
  // ── Disney Cruise Line ────────────────────────────────────────────────────────
  '338234631', // Disney Wish
  '338234632', // Disney Dream
  '338234633', // Disney Fantasy
  '338195000', // Disney Magic
  '338270000', // Disney Wonder
  '338234634', // Disney Treasure
  // ── Virgin Voyages ────────────────────────────────────────────────────────────
  '357231000', // Scarlet Lady
  '357232000', // Valiant Lady
  '357233000', // Resilient Lady
  '357234000', // Brilliant Lady
  // ── Cunard ────────────────────────────────────────────────────────────────────
  '310742000', // Queen Mary 2
  '310743000', // Queen Elizabeth
  '310744000', // Queen Victoria
  '310745000', // Queen Anne
  // ── Holland America ───────────────────────────────────────────────────────────
  '244820000', // Koningsdam
  '244821000', // Nieuw Statendam
  '244267000', // Nieuw Amsterdam
  '244268000', // Rotterdam (2021)
  '244269000', // Eurodam
  '244270000', // Oosterdam
  '244271000', // Westerdam
  '244272000', // Zuiderdam
  '244273000', // Noordam
  '244274000', // Volendam
  '244275000', // Zaandam
  // ── Viking Ocean ──────────────────────────────────────────────────────────────
  '319112000', // Viking Star
  '319113000', // Viking Sea
  '319114000', // Viking Sky
  '319115000', // Viking Sun
  '319116000', // Viking Orion
  '319117000', // Viking Jupiter
  '319118000', // Viking Venus
  '319119000', // Viking Mars
  '319120000', // Viking Saturn
  '319121000', // Viking Neptune
  // ── Costa Cruises ─────────────────────────────────────────────────────────────
  '247319000', // Costa Smeralda
  '247302000', // Costa Toscana
  '247303000', // Costa Firenze
  '247304000', // Costa Fascinosa
  '247305000', // Costa Favolosa
  '247306000', // Costa Deliziosa
  '247307000', // Costa Luminosa
  '247308000', // Costa Fortuna
  '247309000', // Costa Magica
  '247310000', // Costa Pacifica
  '247311000', // Costa Serena
  '247312000', // Costa Diadema
  // ── AIDA ──────────────────────────────────────────────────────────────────────
  '218539000', // AIDAprima
  '218540000', // AIDAperla
  '218665000', // AIDAcosma
  '218235000', // AIDAnova
  '218236000', // AIDAsol
  '218237000', // AIDAmar
  '218238000', // AIDAblu
  '218239000', // AIDAluna
  '218240000', // AIDAdiva
  '218241000', // AIDAbella
  '218242000', // AIDAvita
  '218243000', // AIDАaura
  '218244000', // AIDAcara
  // ── Oceania Cruises ───────────────────────────────────────────────────────────
  '538006789', // Vista (Oceania)
  '538006790', // Allura (Oceania)
  '311000185', // Marina
  '311000186', // Riviera
  '311000050', // Nautica
  '311000051', // Insignia
  '311000052', // Regatta
  '311000053', // Sirena
  // ── Regent Seven Seas ─────────────────────────────────────────────────────────
  '538007100', // Seven Seas Grandeur
  '311000320', // Seven Seas Splendor
  '311000321', // Seven Seas Explorer
  '311000322', // Seven Seas Mariner
  '311000323', // Seven Seas Voyager
  '311000324', // Seven Seas Navigator
  // ── Silversea ─────────────────────────────────────────────────────────────────
  '319180000', // Silver Nova
  '319181000', // Silver Ray
  '319182000', // Silver Moon
  '319183000', // Silver Muse
  '319184000', // Silver Spirit
  '319185000', // Silver Shadow
  '319186000', // Silver Whisper
  '319187000', // Silver Wind
  '319188000', // Silver Dawn
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
