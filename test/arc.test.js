const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const arcPoints = new Function(html.match(/function arcPoints\(p,q,sep,down\)\{.*?return out\}/)[0] + ';return arcPoints')();
const round = (pts) => pts.map((pt) => pt.map((v) => v.toFixed(6)));

// pixel points: y grows downward
const hgh = { x: 850, y: 300 }, can = { x: 830, y: 318 };
const there = arcPoints(hgh, can, 0);

assert.equal(there.length, 65);
assert.deepEqual(there[0], [hgh.x, hgh.y]);
assert.deepEqual(there[64], [can.x, can.y]);
// bows up (north) from the chord midpoint
assert.ok(there[32][1] < (hgh.y + can.y) / 2);
// same arc regardless of direction
assert.deepEqual(round(arcPoints(can, hgh, 0)), round(there).reverse());
assert.deepEqual(arcPoints(hgh, hgh, 0), []);

// flights on one short route stay apart: 6px sep -> 3px at the apex, both directions
const next = arcPoints(hgh, can, 6), back = arcPoints(can, hgh, 6);
assert.ok(Math.hypot(next[32][0] - there[32][0], next[32][1] - there[32][1]) >= 3 - 1e-9);
assert.deepEqual(round(back), round(next).reverse());

// return leg bows down (mirror of the outbound), still direction-independent
const down = arcPoints(hgh, can, 0, true);
assert.ok(down[32][1] > (hgh.y + can.y) / 2);
assert.deepEqual(round(arcPoints(can, hgh, 0, true)), round(down).reverse());

// trans-Pacific stays on the map: one arc across, no wrap past the edges
const nrt = { x: 455, y: 205 }, lax = { x: 88, y: 208 };
const pac = arcPoints(nrt, lax, 0);
assert.ok(pac.every(([x]) => x >= lax.x && x <= nrt.x));
console.log('arc tests passed');
