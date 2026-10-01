const { collectFlights, parseManual, manualFlight, dedupeFlights } = require('./flight-data');
// OSM's tile policy asks for an identifying User-Agent.
const USER_AGENT = 'TREK-Flight-Map (TREK plugin)';
const TILE_CACHE_MAX = 500; // base64 tiles live in the plugin heap (192 MB cap)
const MAX_IMPORT_CHARS = 200000;
const LOOKUP_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const tileCache = new Map();

function response(body, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function getTile(z, x, y) {
  const key = z + '/' + x + '/' + y;
  const cached = tileCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.src;
  const src = await (async () => {
    const url = 'https://tile.openstreetmap.org/' + key + '.png';
    const result = await fetch(url, { headers: { accept: 'image/png', 'user-agent': USER_AGENT } });
    if (!result.ok) throw new Error('OSM tile request failed: ' + result.status);
    return 'data:image/png;base64,' + Buffer.from(await result.arrayBuffer()).toString('base64');
  })();
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value); // ponytail: FIFO cap, LRU if hit rate matters
  tileCache.set(key, { src, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return src;
}

async function getTileResponse(query) {
  const z = Math.max(0, Math.min(8, Math.floor(Number(query.z)) || 0));
  const count = 2 ** z;
  const rawX = Math.floor(Number(query.x) || 0);
  const x = ((rawX % count) + count) % count;
  const y = Math.max(0, Math.min(count - 1, Math.floor(Number(query.y) || 0)));
  return { src: await getTile(z, x, y) };
}

// Results (misses included) are stored, so the AirLabs quota is spent once per flight
// number rather than on every click or page load.
async function lookupAircraft(flightNumber, ctx) {
  const flight = String(flightNumber || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(flight)) return {};
  const [known] = await ctx.db.query('SELECT aircraft, checked_at FROM aircraft_lookups WHERE flight_number = ?', flight);
  if (known && (known.aircraft || Date.now() - Date.parse(known.checked_at) < LOOKUP_RETRY_MS)) {
    return known.aircraft ? { aircraft: known.aircraft } : {};
  }
  const apiKey = String(ctx.config?.airlabs_api_key || '');
  if (!apiKey) return { error: 'No AirLabs API key configured' };
  const url = 'https://airlabs.co/api/v9/flights?flight_iata=' + encodeURIComponent(flight) + '&_fields=aircraft_icao&api_key=' + encodeURIComponent(apiKey);
  const result = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!result.ok) return { error: 'AirLabs request failed (' + result.status + ')' };
  const data = await result.json();
  if (data?.error) return { error: 'AirLabs: ' + String(data.error.message || data.error.code || 'error') };
  const row = Array.isArray(data?.response) ? data.response[0] : Array.isArray(data) ? data[0] : null;
  const aircraft = row?.aircraft_icao ? String(row.aircraft_icao).toUpperCase() : '';
  await ctx.db.exec('INSERT OR REPLACE INTO aircraft_lookups (flight_number, aircraft, checked_at) VALUES (?, ?, ?)',
    flight, aircraft, new Date().toISOString());
  return aircraft ? { aircraft } : {};
}

async function withKnownAircraft(flights, ctx) {
  let rows = [];
  try { rows = await ctx.db.query("SELECT flight_number, aircraft FROM aircraft_lookups WHERE aircraft != ''"); } catch (_) { /* lookups are optional */ }
  const known = new Map(rows.map((r) => [r.flight_number, r.aircraft]));
  return flights.map((f) => (!f.aircraft && known.has(f.flightNumber) ? Object.assign({}, f, { aircraft: known.get(f.flightNumber) }) : f));
}

const MANUAL_TABLE = `CREATE TABLE IF NOT EXISTS manual_flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL,
  from_code TEXT NOT NULL, to_code TEXT NOT NULL, flight_number TEXT, airline TEXT, aircraft TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP)`;
const LOOKUP_TABLE = `CREATE TABLE IF NOT EXISTS aircraft_lookups (
  flight_number TEXT PRIMARY KEY, aircraft TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL)`;

async function manualFlights(ctx, userId) {
  const rows = await ctx.db.query('SELECT * FROM manual_flights WHERE user_id = ? ORDER BY date', userId);
  return rows.map(manualFlight);
}

module.exports = {
  async onLoad(ctx) {
    await ctx.db.migrate('001_manual_flights', MANUAL_TABLE);
    await ctx.db.migrate('002_aircraft_lookups', LOOKUP_TABLE);
  },
  routes: [{
    method: 'GET', path: '/flights', auth: true,
    async handler(req, ctx) {
      let manual = [];
      try { manual = await manualFlights(ctx, req.user.id); } catch (_) { /* manual flights are optional */ }
      let reservations;
      // One RPC for every trip's bookings; a per-trip loop pays one round trip each.
      try { reservations = await ctx.reservations.listMine(); } catch (_) {
        return response({ flights: await withKnownAircraft(manual, ctx), error: 'Could not read your trips' });
      }
      const rows = (Array.isArray(reservations) ? reservations : []).map((r) => Object.assign({}, r, { tripId: r.trip_id }));
      return response({ flights: await withKnownAircraft(dedupeFlights(collectFlights(rows).concat(manual)), ctx) });
    },
  }, {
    method: 'POST', path: '/manual', auth: true,
    async handler(req, ctx) {
      const text = String((req.body && req.body.text) || '');
      if (text.length > MAX_IMPORT_CHARS) return response({ error: 'import is too large, split it into smaller batches' }, 400);
      const parsed = parseManual(text);
      if (parsed.rows.length > 1000) return response({ error: 'at most 1000 flights per import' }, 400);
      const existing = await ctx.db.query('SELECT date, from_code, to_code FROM manual_flights WHERE user_id = ?', req.user.id);
      const seen = new Set(existing.map((r) => r.date + '|' + r.from_code + '|' + r.to_code));
      const rows = parsed.rows.filter((r) => {
        const key = r.date + '|' + r.from + '|' + r.to;
        return !seen.has(key) && seen.add(key);
      });
      const errors = parsed.errors;
      // ctx.db.tx takes at most 100 statements
      for (let i = 0; i < rows.length; i += 100) {
        await ctx.db.tx(rows.slice(i, i + 100).map((r) => ({
          sql: 'INSERT INTO manual_flights (user_id, date, from_code, to_code, flight_number, airline, aircraft) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [req.user.id, r.date, r.from, r.to, r.flightNumber, r.airline, r.aircraft],
        })));
      }
      return response({ added: rows.length, skipped: parsed.rows.length - rows.length, errors });
    },
  }, {
    method: 'DELETE', path: '/manual', auth: true,
    async handler(req, ctx) {
      const { changes } = await ctx.db.exec('DELETE FROM manual_flights WHERE id = ? AND user_id = ?', Number(req.query.id), req.user.id);
      return response({ deleted: changes });
    },
  }, {
    method: 'GET', path: '/tile', auth: true,
    async handler(req) {
      try { return response(await getTileResponse(req.query || {})); }
      catch (_) { return response({}); }
    },
  }, {
    method: 'GET', path: '/aircraft', auth: true,
    async handler(req, ctx) {
      try { return response(await lookupAircraft(req.query?.flight, ctx)); }
      catch (_) { return response({ error: 'Aircraft lookup failed' }); }
    },
  }],
};
