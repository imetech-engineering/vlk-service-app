// Node-versie van de afspeeltool, voor de vergelijking met de C-code (tools/replay/run_tests.py)
// gebruik: node es_replay_node.mjs <csv> <open|dicht> [sleutel=waarde ...] (zelfde sleutels als es_replay.c)
import { readFileSync } from 'node:fs';
import { replay, esDefaults, ES_CALIBRATED } from '../js/endstop.js';

const [file, dir, ...args] = process.argv.slice(2);
const p = esDefaults();
let full = false, calibrate = false;
for (const a of args) {
  const [k, v] = a.split('=');
  const n = Number(v);
  if (k === 'run_o') p.run_ma[0] = n; else if (k === 'run_c') p.run_ma[1] = n;
  else if (k === 'peak_o') p.peak_ma[0] = n; else if (k === 'peak_c') p.peak_ma[1] = n;
  else if (k === 'trav_o') p.travel_ds[0] = n; else if (k === 'trav_c') p.travel_ds[1] = n;
  else if (k === 'sens') p.sens = n; else if (k === 'full') full = n !== 0; else if (k === 'cal') calibrate = n !== 0;
}
if (p.run_ma[0] || p.run_ma[1]) p.flags |= ES_CALIBRATED;
const samples = readFileSync(file, 'utf8').split('\n')
  .map((l) => l.split(',').map(Number))
  .filter((r) => r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
const r = replay(samples, p, dir === 'dicht' || dir === 'close', { calibrate, full });
process.stdout.write(JSON.stringify(r) + '\n');
