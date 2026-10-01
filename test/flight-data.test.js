const assert = require('node:assert/strict');
const { collectFlights, parseManual, manualFlight, haversineKm } = require('../server/flight-data');

function testCollectFlights() {
  const flights = collectFlights([
    { id: 1, tripId: 10, type: 'flight', metadata: { airline: 'Japan Airlines', legs: [{ aircraft_icao: 'B789', duration_minutes: 720 }] }, endpoints: [
      { code: 'NRT', name: 'Narita', lat: 35.77, lng: 140.39, timezone: 'Asia/Tokyo', sequence: 0 },
      { code: 'LHR', name: 'Heathrow', lat: 51.47, lng: -0.45, timezone: 'Europe/London', sequence: 1 },
    ] },
    { id: 2, tripId: 10, type: 'flight', metadata: { airline: 'Japan Airlines' }, endpoints: [
      { code: 'NRT', name: 'Narita', lat: 35.77, lng: 140.39, timezone: 'Asia/Tokyo', sequence: 0 },
      { code: 'LHR', name: 'Heathrow', lat: 51.47, lng: -0.45, timezone: 'Europe/London', sequence: 1 },
    ] },
  ]);

  assert.equal(flights.length, 2);
  assert.equal(flights[0].routeKey, 'NRT:LHR');
  assert.equal(flights[0].airline, 'Japan Airlines');
  assert.equal(flights[0].aircraft, 'B789');
  assert.equal(flights[0].durationMinutes, 720);
  assert.ok(flights[0].distanceKm > 9500);
  assert.equal(flights[0].from.region, 'JP');
  assert.equal(flights[0].to.region, 'GB');
}

function testParseManual() {
  const { rows, errors } = parseManual([
    '# history',
    '2019-05-01, pek, SFO, ca985, Air China, B77W',
    '2019/5/9\tSFO\tPEK',
    '2020-01-02 HGH PKX MU5101',
    '',
    '2020-13-40, HGH, PEK',
    '2019-02-30, HGH, PEK',
    '2020-01-02, HGH, ZZZ',
    '2020-01-02, HGH, HGH',
  ].join('\n'));
  assert.deepEqual(rows, [
    { date: '2019-05-01', from: 'PEK', to: 'SFO', flightNumber: 'CA985', airline: 'Air China', aircraft: 'B77W' },
    { date: '2019-05-09', from: 'SFO', to: 'PEK', flightNumber: '', airline: '', aircraft: '' },
    { date: '2020-01-02', from: 'HGH', to: 'PKX', flightNumber: 'MU5101', airline: '', aircraft: '' },
  ]);
  assert.deepEqual(errors.map((e) => [e.line, e.message]), [
    [6, 'invalid date, use YYYY-MM-DD'], [7, 'invalid date, use YYYY-MM-DD'], [8, 'unknown airport ZZZ'], [9, 'departure and arrival are the same'],
  ]);

  const f = manualFlight({ id: 7, date: '2019-05-01', from_code: 'PEK', to_code: 'SFO', flight_number: 'CA985', airline: '', aircraft: '' });
  assert.equal(f.id, 'm7');
  assert.equal(f.year, '2019');
  assert.equal(f.airline, 'Unknown airline');
  assert.equal(f.from.region, 'CN');
  assert.equal(f.to.region, 'US');
  assert.ok(f.distanceKm > 9000 && f.distanceKm < 10000);
  assert.ok(f.durationMinutes > 600 && f.durationMinutes < 800);
}

function testDurations() {
  const at = (code, lat, lng, timezone, extra) => Object.assign({ code, lat, lng, timezone }, extra);
  const minutes = (r) => collectFlights([Object.assign({ id: 1, type: 'flight', metadata: {} }, r)]).map((f) => f.durationMinutes);
  // wall times are local to each airport: LHR 10:00 -> NRT 07:00 next day is 12h, not 21h
  assert.deepEqual(minutes({ reservation_time: '2025-03-01T10:00', reservation_end_time: '2025-03-02T07:00',
    endpoints: [at('LHR', 51.47, -0.45, 'Europe/London', { sequence: 0 }), at('NRT', 35.77, 140.39, 'Asia/Tokyo', { sequence: 1 })] }), [720]);
  // east -> west arrives "before" it left: NRT 17:00 JST -> SFO 10:00 PDT same day is 9h
  assert.deepEqual(minutes({ reservation_time: '2025-07-01T17:00', reservation_end_time: '2025-07-01T10:00',
    endpoints: [at('NRT', 35.77, 140.39, 'Asia/Tokyo', { sequence: 0 }), at('SFO', 37.62, -122.38, 'America/Los_Angeles', { sequence: 1 })] }), [540]);
  // multi-leg: the reservation-wide 35h is not stamped onto each leg
  const legs = minutes({ reservation_time: '2025-03-01T11:00', reservation_end_time: '2025-03-02T22:00', metadata: { duration_minutes: 2100 },
    endpoints: [at('SFO', 37.62, -122.38, 'America/Los_Angeles', { sequence: 0 }), at('HKG', 22.31, 113.91, 'Asia/Hong_Kong', { sequence: 1 }),
      at('NRT', 35.77, 140.39, 'Asia/Tokyo', { sequence: 2 })] });
  assert.ok(legs[0] > 700 && legs[0] < 1000, 'SFO-HKG ~15h, got ' + legs[0]);
  assert.ok(legs[1] > 200 && legs[1] < 400, 'HKG-NRT ~4-5h, got ' + legs[1]);
  // per-leg local times win over the estimate
  assert.deepEqual(minutes({ endpoints: [at('HGH', 30.23, 120.43, 'Asia/Shanghai', { sequence: 0, local_date: '2025-01-01', local_time: '08:00' }),
    at('CAN', 23.39, 113.3, 'Asia/Shanghai', { sequence: 1, local_date: '2025-01-01', local_time: '10:15' })] }), [135]);
}

function testHaversine() {
  assert.equal(haversineKm(35.77, 140.39, 35.77, 140.39), 0);
}

testCollectFlights();
testParseManual();
testDurations();
testHaversine();
console.log('flight-data tests passed');
