// Regenerates server/airports.json from OurAirports (public domain): node scripts/build-airports.js
const fs = require('node:fs');
const path = require('node:path');

const row = (line) => [...line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);

(async () => {
  const csv = await (await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv')).text();
  const [head, ...lines] = csv.trim().split('\n');
  const col = Object.fromEntries(row(head).map((name, i) => [name, i]));
  const out = {};
  for (const line of lines) {
    const r = row(line);
    const code = r[col.iata_code];
    if (!/^[A-Z]{3}$/.test(code) || !['large_airport', 'medium_airport', 'small_airport'].includes(r[col.type])) continue;
    out[code] = [r[col.name], r[col.municipality], r[col.iso_country], +(+r[col.latitude_deg]).toFixed(4), +(+r[col.longitude_deg]).toFixed(4)];
  }
  fs.writeFileSync(path.join(__dirname, '../server/airports.json'), JSON.stringify(out));
  console.log(Object.keys(out).length + ' airports');
})();
