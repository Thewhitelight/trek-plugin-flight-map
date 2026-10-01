const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../server/index');
const { dedupeFlights } = require('../server/flight-data');

// ctx.db over a real in-memory SQLite, so the plugin's SQL actually runs
function fakeCtx(reservations, config = {}) {
  const sql = new DatabaseSync(':memory:');
  return {
    config,
    reservations: { listMine: async () => reservations },
    db: {
      migrate: async (_name, ddl) => sql.exec(ddl),
      query: async (q, ...args) => sql.prepare(q).all(...args),
      exec: async (q, ...args) => ({ changes: Number(sql.prepare(q).run(...args).changes) }),
      tx: async (stmts) => stmts.forEach((s) => sql.prepare(s.sql).run(...s.args)),
    },
  };
}
const route = (method, path) => plugin.routes.find((r) => r.method === method && r.path === path).handler;
const call = async (method, path, req, ctx) => JSON.parse((await route(method, path)(Object.assign({ user: { id: 1 }, query: {} }, req), ctx)).body);

function testDedupe() {
  const f = (date, from, to, flightNumber) => ({ date, from: { code: from }, to: { code: to }, flightNumber });
  const kept = dedupeFlights([
    f('2024-01-01', 'PVG', 'LAX', 'MU583'), f('2024-01-01', 'PVG', 'LAX', 'MU583'), // copied trip
    f('2024-01-01', 'PVG', 'LAX', ''), // typed in by hand without a number
    f('2024-01-01', 'PVG', 'LAX', 'CA987'), // a second flight that day
    f('2024-01-02', 'PVG', 'LAX', 'MU583'),
    f('', 'PVG', 'LAX', ''), f('', 'PVG', 'LAX', ''), // undated: never merged
  ]);
  assert.deepEqual(kept.map((x) => x.date + ' ' + x.flightNumber), ['2024-01-01 MU583', '2024-01-01 CA987', '2024-01-02 MU583', ' ', ' ']);
}

async function testRoutes() {
  const booking = { id: 1, trip_id: 9, type: 'flight', metadata: { flight_number: 'MU583' }, endpoints: [
    { code: 'PVG', lat: 31.14, lng: 121.8, sequence: 0, local_date: '2024-01-01' },
    { code: 'LAX', lat: 33.94, lng: -118.41, sequence: 1 },
  ] };
  const ctx = fakeCtx([booking, Object.assign({}, booking, { id: 2, trip_id: 10 })], { airlabs_api_key: 'k' });
  await plugin.onLoad(ctx);

  // the manual copy of a booked flight is imported once and then hidden by the booking
  let res = await call('POST', '/manual', { body: { text: '2024-01-01, PVG, LAX\n2024-01-01, PVG, LAX\n2019-05-01, PEK, SFO' } }, ctx);
  assert.deepEqual([res.added, res.skipped], [2, 1]);
  res = await call('POST', '/manual', { body: { text: '2019-05-01, PEK, SFO' } }, ctx);
  assert.deepEqual([res.added, res.skipped], [0, 1]);
  res = await call('POST', '/manual', { body: { text: 'x'.repeat(200001) } }, ctx);
  assert.ok(res.error);

  let flights = (await call('GET', '/flights', {}, ctx)).flights;
  assert.deepEqual(flights.map((f) => f.routeKey + ' ' + f.date), ['PVG:LAX 2024-01-01', 'PEK:SFO 2019-05-01']);
  assert.equal(flights[0].tripId, 9);

  // AirLabs is asked once per flight number; hits and misses are both remembered
  let calls = 0;
  global.fetch = async () => (calls++, { ok: true, json: async () => ({ response: calls === 1 ? [{ aircraft_icao: 'b77w' }] : [] }) });
  assert.deepEqual(await call('GET', '/aircraft', { query: { flight: 'MU583' } }, ctx), { aircraft: 'B77W' });
  assert.deepEqual(await call('GET', '/aircraft', { query: { flight: 'MU583' } }, ctx), { aircraft: 'B77W' });
  assert.deepEqual(await call('GET', '/aircraft', { query: { flight: 'CA987' } }, ctx), {});
  assert.deepEqual(await call('GET', '/aircraft', { query: { flight: 'CA987' } }, ctx), {});
  assert.equal(calls, 2);
  // a quota/key failure is reported, not cached
  global.fetch = async () => ({ ok: false, status: 429 });
  assert.match((await call('GET', '/aircraft', { query: { flight: 'MU5101' } }, ctx)).error, /429/);

  // stored aircraft survive a reload
  flights = (await call('GET', '/flights', {}, ctx)).flights;
  assert.equal(flights[0].aircraft, 'B77W');
}

testDedupe();
testRoutes().then(() => console.log('server tests passed'), (e) => { console.error(e); process.exit(1); });
