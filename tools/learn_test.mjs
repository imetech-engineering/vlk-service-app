// Test: kalibratie leren uit twee opnames en daarna dezelfde ritten afspelen
import { readFileSync } from 'node:fs';
import { learn, suggestEnd, replay } from '../js/endstop.js';
const dir = process.argv[2];
const load = (f) => readFileSync(`${dir}/${f}`, 'utf8').split('\n').map((l) => l.split(',').map(Number)).filter((r) => r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
const o = load('open_1m.csv'), d = load('dicht_1m.csv');
const runs = [{ closing: false, samples: o, endMs: suggestEnd(o) }, { closing: true, samples: d, endMs: suggestEnd(d) }];
const p = learn(runs);
console.log('eindpunt voorstel', runs.map((r) => r.endMs), JSON.stringify(p));
const ok = [replay(o, p, false, { full: true }).result, replay(d, p, true, { full: true }).result];
console.log('na kalibratie:', ok.join(', '));
const early = load('gekalibreerd_te_vroeg.csv');
console.log('te vroeg:', replay(early, p, false, { full: true }).result);
if (ok.join() !== 'eind_ok,eind_ok') process.exit(1);
