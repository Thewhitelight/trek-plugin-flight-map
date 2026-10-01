const AIRPORTS = require('./airports.json'); // IATA -> [name, city, country, lat, lng]
const RAD = Math.PI / 180;

function haversineKm(lat1, lng1, lat2, lng2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD)
    * Math.sin((lng2 - lng1) * RAD / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function metaOf(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

// ISO country of the airport; '' when unknown so it never counts as a country
function regionOf(airport) {
  if (airport.country) return String(airport.country);
  const known = AIRPORTS[String(airport.code || '').toUpperCase()];
  return known ? known[2] : '';
}

function airport(endpoint) {
  return {
    code: String(endpoint.code || '').toUpperCase(),
    name: String(endpoint.name || endpoint.code || 'Airport'),
    lat: Number(endpoint.lat), lng: Number(endpoint.lng),
    region: regionOf(endpoint),
  };
}

const MAX_FLIGHT_MINUTES = 20 * 60; // longest scheduled flight is ~19h

// ponytail: ~800 km/h cruise + 30 min taxi/climb; used when no real times are known
function estimateMinutes(distanceKm) {
  return Math.round(distanceKm / 13.3 + 30);
}

// Wall-clock "YYYY-MM-DDTHH:mm" in an IANA zone -> epoch ms; NaN without a time of day.
function instant(value, tz) {
  const s = String(value || '').trim().replace(' ', 'T');
  if (!/T\d{2}:\d{2}/.test(s)) return NaN;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.parse(s);
  const wall = Date.parse(s + 'Z');
  if (!tz || !Number.isFinite(wall)) return wall;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(wall)).map((x) => [x.type, x.value]));
    // ponytail: offset read at the wall time taken as UTC, can be 1h off right at a DST switch
    return wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - wall);
  } catch (_) { return wall; }
}

// Minutes for leg i (endpoints[i-1] -> endpoints[i]). Reservation-wide duration and
// times only describe the first departure / last arrival, never every leg.
function durationMinutes(reservation, endpoints, i, leg, meta, distanceKm) {
  const first = i === 1, last = i === endpoints.length - 1;
  const given = leg.duration_minutes ?? leg.durationMinutes ?? leg.duration
    ?? (first && last ? meta.duration_minutes ?? meta.durationMinutes ?? meta.duration : undefined);
  if (Number(given) > 0) return Math.round(Number(given));
  const from = endpoints[i - 1], to = endpoints[i];
  const local = (e) => (e.local_date && e.local_time ? e.local_date + 'T' + e.local_time : '');
  const start = instant(leg.departure_time || leg.departureTime || local(from) || (first ? reservation.reservation_time : ''),
    from.timezone || (first ? meta.departure_timezone : ''));
  const end = instant(leg.arrival_time || leg.arrivalTime || local(to) || (last ? reservation.reservation_end_time : ''),
    to.timezone || (last ? meta.arrival_timezone : ''));
  const minutes = Math.round((end - start) / 60000);
  return minutes > 0 && minutes <= MAX_FLIGHT_MINUTES ? minutes : estimateMinutes(distanceKm);
}

function aircraftModel(leg, meta) {
  return String(leg.aircraft_icao || leg.aircraft || leg.equipment || leg.aircraft_type
    || meta.aircraft_icao || meta.aircraft || meta.equipment || meta.aircraft_type || '').toUpperCase();
}

function collectFlights(reservations) {
  const flights = [];
  for (const reservation of reservations || []) {
    if (!reservation || reservation.type !== 'flight') continue;
    const endpoints = (reservation.endpoints || []).slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    const meta = metaOf(reservation.metadata);
    for (let i = 1; i < endpoints.length; i++) {
      const from = airport(endpoints[i - 1]);
      const to = airport(endpoints[i]);
      if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) continue;
      const leg = Array.isArray(meta.legs) ? meta.legs[i - 1] || {} : {};
      const airline = String(leg.airline || meta.airline || meta.airline_name || 'Unknown airline');
      const date = String(endpoints[i - 1].local_date || reservation.reservation_time || '').slice(0, 10);
      const distanceKm = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng));
      flights.push({
        id: String(reservation.id) + '-' + i,
        tripId: reservation.tripId,
        airline, date, year: /^\d{4}/.test(date) ? date.slice(0, 4) : 'Unknown', from, to,
        flightNumber: String(leg.flight_number || leg.flightNumber || meta.flight_number || meta.flightNumber || '').toUpperCase(),
        aircraft: aircraftModel(leg, meta),
        durationMinutes: durationMinutes(reservation, endpoints, i, leg, meta, distanceKm),
        routeKey: (from.code || from.lat.toFixed(2) + ',' + from.lng.toFixed(2)) + ':' + (to.code || to.lat.toFixed(2) + ',' + to.lng.toFixed(2)),
        distanceKm,
      });
    }
  }
  return flights;
}

// One flight per line: "date, FROM, TO[, flight number[, airline[, aircraft]]]" (comma or tab),
// or "date FROM TO [flight number]". Blank lines and lines starting with # are skipped.
function parseManual(text) {
  const rows = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = (/[,\t]/.test(line) ? line.split(/[,\t]/) : line.split(/\s+/)).map((c) => c.trim());
    const date = cells[0].replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    const from = (cells[1] || '').toUpperCase(), to = (cells[2] || '').toUpperCase();
    const fail = (message) => errors.push({ line: i + 1, text: line, message });
    // round-trip check: Date.parse happily rolls 2019-02-30 over to March
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
    if (!valid) return fail('invalid date, use YYYY-MM-DD');
    if (!AIRPORTS[from]) return fail('unknown airport ' + (from || '(empty)'));
    if (!AIRPORTS[to]) return fail('unknown airport ' + (to || '(empty)'));
    if (from === to) return fail('departure and arrival are the same');
    rows.push({ date, from, to, flightNumber: (cells[3] || '').toUpperCase(), airline: cells[4] || '', aircraft: (cells[5] || '').toUpperCase() });
  });
  return { rows, errors };
}

function manualFlight(row) {
  const place = (code) => {
    const [name, city, country, lat, lng] = AIRPORTS[code];
    return { code, name: city || name, lat, lng, region: country };
  };
  const from = place(row.from_code), to = place(row.to_code);
  const distanceKm = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng));
  return {
    id: 'm' + row.id, manualId: row.id, tripId: null,
    airline: row.airline || 'Unknown airline', date: row.date, year: row.date.slice(0, 4), from, to,
    flightNumber: row.flight_number || '', aircraft: row.aircraft || '',
    durationMinutes: estimateMinutes(distanceKm),
    routeKey: from.code + ':' + to.code, distanceKm,
  };
}

// The same flight booked in two trips (a copied trip, one booking per traveller) or also
// typed in by hand counts once. Earlier entries win, so trip bookings beat manual rows.
// Same day + route is one flight unless both sides carry different flight numbers.
function dedupeFlights(flights) {
  const byRoute = new Map(); // date|from|to -> flight numbers seen ('' = none given)
  return flights.filter((f) => {
    if (!f.date || !f.from.code || !f.to.code) return true;
    const key = [f.date, f.from.code, f.to.code].join('|');
    const numbers = byRoute.get(key);
    if (!numbers) {
      byRoute.set(key, new Set([f.flightNumber]));
      return true;
    }
    if (!f.flightNumber || numbers.has('') || numbers.has(f.flightNumber)) return false;
    numbers.add(f.flightNumber);
    return true;
  });
}

module.exports = { collectFlights, parseManual, manualFlight, dedupeFlights, haversineKm, durationMinutes, aircraftModel };
