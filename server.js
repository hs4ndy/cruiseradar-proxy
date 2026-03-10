/**
 * CruiseRadar Proxy — v0.1.7BF2
 * Railway WebSocket proxy for AISstream.io
 */

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3001;
const AIS_API_KEY = process.env.AIS_API_KEY || "9fb0ea568997a8bf8632a3bac61a4cbdfd2bf60a";
const AIS_ENDPOINT = "wss://stream.aisstream.io/v0/stream";

const CRUISE_MMSI = new Set([
  // Royal Caribbean
  311315000,311805000,311321000,311317000,311316000,311263000,311478000,311493000,
  311319000,311361000,311492000,311583000,311733000,309906000,309436000,309374000,
  311020600,311020700,311000396,311000660,311000267,311000274,311000397,311000749,
  311000912,311001033,311001259,311001178,311001551,
  // Norwegian
  311746000,311082000,311307000,311827000,308416000,309951000,309653000,311018500,
  311050800,311050900,311000341,311000599,311000710,311000879,308865000,311109000,
  311001059,311001127,311001559,
  // Disney
  308516000,308457000,311042900,311058700,311001098,311001221,311001540,311000934,
  // MSC
  357281000,356716000,356042000,357627000,352003000,372497000,355931000,352594000,
  370648000,357698000,373178000,371861000,249973000,248992000,215325000,215610000,
  215920000,248392000,248717000,247474400,256070000,256281000,249193000,
  // Carnival
  308017000,355831000,355833000,311001095,354215000,311001094,354277000,357657000,
  357659000,354298000,371154000,371083000,372808000,370490000,370491000,354842000,
  356883000,370039000,374527000,355263000,311001201,311001253,311001049,311001223,
  311001390,352003546,311001595,311001596,
  // Princess
  310327000,310376000,310384000,235103359,235103357,310423000,310500000,310531000,
  310567000,310661000,310674000,232002990,310780000,310791000,310812000,310841000,310869000,
  // Celebrity
  248325000,215105000,215808000,256191000,249457000,229074000,248939000,249409000,
  249666000,249667000,249046000,249047000,249055000,249048000,
  735059945, // Celebrity Flora (Ecuador-flagged, Galapagos expedition)
  // Virgin Voyages
  311000807,311000983,311001056,311001167,
  // Cunard
  310627000,310624000,310625000,310835000,
  // Holland America
  244830547,244140580,245464000,246648000,245206000,245417000,244128000,245304000,246028000,245968000,246442000,
  // Viking Ocean
  257903000,258215000,259186000,257034130,257058920,257552000,257800000,257850000,258024000,257526000,257944000,
  // Oceania
  538009952,538011254,538003668,538004353,538001663,538001665,538001664,538006842,
  // Regent
  538010706,538007673,538006712,311513000,311622000,311050600,
  // Silversea
  311001189,311001496,311001044,311000719,311000637,311022500,308628000,308322000,311000932,
  308814000,309027000, // Silver Wind (1995), Silver Cloud (1994)
  // Costa
  247391900,247431200,247353700,247282900,247187600,247258100,247311100,247313500,
  247094800, // Costa Fortuna (2003)
  // AIDA
  247435300,247389200,247385300,247353800,247322800,247312900,247302900,247282500,247255400,247229700,247187700,
]);

const TRAIL_MAX_POINTS = 2000;
const TRAIL_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;

const shipCache = new Map();

function updateShip(mmsi, info, lat, lon) {
  const now = Date.now();
  let entry = shipCache.get(mmsi);
  if (!entry) {
    entry = { info, trail: [] };
    shipCache.set(mmsi, entry);
  } else {
    entry.info = { ...entry.info, ...info };
  }
  const wasStationary = entry.info._wasStationary;
  const isMoving = (info.sog || 0) > 0.5;
  if (wasStationary && isMoving) entry.trail = [];
  entry.info._wasStationary = !isMoving;
  entry.trail.push({ lat, lon, ts: now });
  if (entry.trail.length > TRAIL_MAX_POINTS) entry.trail.shift();
}

function pruneTrails() {
  const cutoff = Date.now() - TRAIL_MAX_AGE_MS;
  for (const [mmsi, entry] of shipCache) {
    entry.trail = entry.trail.filter(p => p.ts >= cutoff);
    if (entry.trail.length === 0 && !entry.info.lat) shipCache.delete(mmsi);
  }
}
setInterval(pruneTrails, PRUNE_INTERVAL_MS);

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`CruiseRadar Proxy v0.1.7BF2 — ${shipCache.size} ships cached`);
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (client) => {
  console.log(`[WS] Browser connected. Sending cache (${shipCache.size} ships)`);
  for (const [mmsi, entry] of shipCache) {
    if (client.readyState !== WebSocket.OPEN) break;
    client.send(JSON.stringify({ type: "snapshot", mmsi, info: entry.info, trail: entry.trail }));
  }
  client.on("error", (err) => console.error("[WS] Client error:", err.message));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

let aisWs = null;
let reconnectTimer = null;
let reconnectDelay = 5000;

function connectAIS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log("[AIS] Connecting to AISstream...");
  aisWs = new WebSocket(AIS_ENDPOINT);

  aisWs.on("open", () => {
    console.log("[AIS] Connected. Subscribing...");
    reconnectDelay = 5000;
    // AISstream limits FiltersShipMMSI to 50 entries max — we have 214 ships,
    // so we cannot use that filter. Instead subscribe to world feed and filter locally.
    aisWs.send(JSON.stringify({
      APIKey: AIS_API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
  });

  aisWs.on("message", (raw) => {
    try { handleAISMessage(JSON.parse(raw)); } catch (e) {}
  });

  aisWs.on("close", () => {
    console.warn(`[AIS] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    reconnectTimer = setTimeout(connectAIS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 60000);
  });

  aisWs.on("error", (err) => { console.error("[AIS] Error:", err.message); aisWs.terminate(); });
}

function handleAISMessage(msg) {
  const type = msg.MessageType;
  const meta = msg.MetaData || {};
  const mmsi = parseInt(meta.MMSI || 0, 10);
  if (!mmsi) return;

  if (type === "PositionReport") {
    const pos = msg.Message?.PositionReport;
    if (!pos) return;
    const lat = pos.Latitude, lon = pos.Longitude;
    if (lat === undefined || lon === undefined) return;

    const cached = shipCache.get(mmsi);
    if (!CRUISE_MMSI.has(mmsi)) return;

    const info = {
      mmsi, name: meta.ShipName || cached?.info?.name || `Ship ${mmsi}`,
      lat, lon,
      sog: pos.Sog ?? 0, cog: pos.Cog ?? 0,
      heading: pos.TrueHeading ?? pos.Cog ?? 0,
      navStatus: pos.NavigationalStatus ?? 0,
      ts: Date.now(),
    };
    updateShip(mmsi, info, lat, lon);
    broadcast({ type: "position", mmsi, info });

  } else if (type === "ShipStaticData") {
    const stat = msg.Message?.ShipStaticData;
    if (!stat) return;
    if (!CRUISE_MMSI.has(mmsi)) return;
    const sType = stat.Type ?? 0;

    const info = {
      mmsi, name: meta.ShipName || stat.Name || `Ship ${mmsi}`,
      callsign: stat.CallSign, imo: stat.ImoNumber,
      shipType: sType, destination: stat.Destination,
      draught: stat.MaximumStaticDraught, eta: stat.Eta,
    };
    const cached = shipCache.get(mmsi);
    if (cached) cached.info = { ...cached.info, ...info };
    else shipCache.set(mmsi, { info, trail: [] });
    broadcast({ type: "static", mmsi, info });
  }
}

httpServer.listen(PORT, () => {
  console.log(`[HTTP] CruiseRadar Proxy v0.1.7BF2 listening on port ${PORT}`);
  connectAIS();
});
