// endstop.js - eindherkenning, 1-op-1 overgezet van firmware/src/endstop.c (versie 2, 13-11-2026)
// Fysiek beeld: loopstroom -> stijging aan het eind -> motor schakelt zichzelf af.
// Gebruikt in de app om opnames af te spelen en om de kalibratie te leren.
// Wijzig je de C-code, wijzig dan ook dit bestand; tools/replay/run_tests.py vergelijkt beide.
// IMeTech Engineering, project 5008

export const ES_WINDOW_MS = 50;
export const ES_CALIBRATED = 1;
const BLANK_MS = 1500, OFF_HOLD_MS = 300, OFF_MIN_MA = 40, BLOCK_HOLD_MS = 1000;
const RUN_MIN_WINDOWS = 10, TIMEOUT_UNCAL_MS = 120000, TIMEOUT_MAX_MS = 180000, HIST = 64;
const RISE_PCT = [25, 50, 35, 25, 15, 10];
const EARLY_PCT = [70, 50, 60, 70, 80, 85];

export const RESULT_NAMES = ['gestopt', 'eind_ok', 'eind_zonder_piek', 'te_vroeg', 'al_in_eindstand', 'blokkade', 'max_tijd'];
export const RESULT_TEXT = {
  gestopt: 'gestopt', eind_ok: 'eindstand (bevestigd)', eind_zonder_piek: 'eindstand, zonder stijging',
  te_vroeg: 'te vroeg gestopt (obstakel?)', al_in_eindstand: 'stond al in de eindstand', blokkade: 'blokkade', max_tijd: 'maximale looptijd',
};
export const RESULT_OK = ['eind_ok'];

// struct es_params: run_ma[2], peak_ma[2], travel_ds[2], sens, flags (index 0 = OPEN, 1 = DICHT)
export function esDefaults() {
  return { run_ma: [0, 0], peak_ma: [0, 0], travel_ds: [0, 0], sens: 3, flags: 0 };
}

const sensOf = (p) => (p.sens >= 1 && p.sens <= 5 ? p.sens : 3);
const calibrated = (p, c) => !!(p.flags & ES_CALIBRATED) && p.run_ma[c] > 0 && p.travel_ds[c] > 0;

export class Endstop {
  constructor(params, closing, calibrate = false, full = false) {
    this.p = params; this.closing = closing ? 1 : 0; this.calibrate = calibrate; this.full = full;
    this.t = 0; this.runN = 0; this.runSum = 0; this.runAvg = 0; this.max = 0;
    this.hist = new Array(HIST).fill(0); this.histI = 0;
    this.offSince = 0; this.blockSince = 0; this.endPeak = 0; this.result = 0;
  }

  runRef() {
    if (this.runN >= RUN_MIN_WINDOWS) return this.runAvg;
    return calibrated(this.p, this.closing) ? this.p.run_ma[this.closing] : 0;
  }
  offMa() { return Math.max(OFF_MIN_MA, Math.floor(this.runRef() / 4)); }
  blockMa() {
    let b = this.runRef() * 3;
    if (calibrated(this.p, this.closing)) b = Math.max(b, Math.floor(this.p.peak_ma[this.closing] * 3 / 2));
    return Math.min(65535, Math.max(1500, b));
  }
  timeoutMs() {
    if (this.calibrate || !calibrated(this.p, this.closing)) return TIMEOUT_UNCAL_MS;
    return Math.min(TIMEOUT_MAX_MS, this.p.travel_ds[this.closing] * 150 + 5000);
  }
  riseSeen() {
    const run = this.runAvg;
    let thr = run + Math.floor(run * RISE_PCT[sensOf(this.p)] / 100);
    const p = this.p, c = this.closing;
    if (calibrated(p, c) && p.peak_ma[c] > p.run_ma[c]) thr = Math.min(thr, run + Math.floor((p.peak_ma[c] - p.run_ma[c]) / 2));
    thr = Math.max(thr, run + 20);
    return this.endPeak >= thr;
  }

  feed(t, ma) {
    if (this.result !== 0) return this.result;
    this.t = t;
    if (ma > this.max) this.max = ma;
    if (t >= this.timeoutMs()) return (this.result = 6);
    if (t < BLANK_MS) return 0;
    const off = this.offMa();
    if (ma < off) {
      if (this.offSince === 0) { this.offSince = t; this.endPeak = Math.max(...this.hist); }
      if (t - this.offSince >= OFF_HOLD_MS) {
        if (this.runN < RUN_MIN_WINDOWS) return (this.result = 4);
        if (!this.calibrate && this.full && calibrated(this.p, this.closing) &&
            this.offSince < this.p.travel_ds[this.closing] * EARLY_PCT[sensOf(this.p)]) return (this.result = 3);
        return (this.result = this.riseSeen() ? 1 : 2);
      }
      return 0;
    }
    this.offSince = 0;
    if (ma >= this.blockMa()) {
      if (this.blockSince === 0) this.blockSince = t;
      else if (t - this.blockSince >= BLOCK_HOLD_MS) return (this.result = 5);
    } else this.blockSince = 0;
    if (this.runN < RUN_MIN_WINDOWS || (ma * 100 <= this.runAvg * 115 && ma * 100 >= this.runAvg * 70)) {
      this.runSum += ma; this.runN++; this.runAvg = Math.floor(this.runSum / this.runN);
    }
    this.hist[this.histI] = ma;
    this.histI = (this.histI + 1) % HIST;
    return 0;
  }
  resultName() { return RESULT_NAMES[this.result]; }
}

// Speel een opname af: samples = [[t_ms, ma], ...] met 5 ms stap (200 Hz), venster = gemiddelde
export function replay(samples, params, closing, { calibrate = false, full = false } = {}) {
  const es = new Endstop(params, closing, calibrate, full);
  let sum = 0, n = 0, tEnd = 0;
  for (const [t, ma] of samples) {
    sum += ma;
    if (++n >= ES_WINDOW_MS / 5) {
      const r = es.feed(t, Math.floor(sum / n));
      n = 0; sum = 0;
      if (r !== 0) { tEnd = t; break; }
    }
  }
  return { result: es.resultName(), t_ms: tEnd, off_ms: es.offSince, max_ma: es.max, run_ma: es.runAvg, end_peak_ma: es.endPeak };
}

// ---------------------------------------------------------------------------------------
// Kalibratie leren uit bevestigde opnames. runs = [{closing, samples, endMs}], endMs = het
// moment waarop de koepel volgens de gebruiker open/dicht was (stroom valt weg).
// Uitkomst: es_params met per richting de mediaan van loopstroom, eindpiek en looptijd.
// ---------------------------------------------------------------------------------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Voorstel voor het eindpunt: het moment waarop de stroom na het lopen wegvalt
export function suggestEnd(samples) {
  const win = [];
  for (let i = 0; i + 10 <= samples.length; i += 10) {
    const sl = samples.slice(i, i + 10);
    win.push([sl[sl.length - 1][0], sl.reduce((a, b) => a + b[1], 0) / 10]);
  }
  const running = win.filter(([t]) => t > BLANK_MS).map(([, m]) => m);
  const run = median(running.filter((m) => m > OFF_MIN_MA));
  const off = Math.max(OFF_MIN_MA, run / 4);
  for (let i = 0; i < win.length; i++) {
    if (win[i][0] > BLANK_MS && win[i][1] < off) return win[i][0];
  }
  return samples.length ? samples[samples.length - 1][0] : 0;
}

export function analyseRun(samples, endMs) {
  const inRun = samples.filter(([t]) => t > BLANK_MS && t < endMs - 3000);
  const run = Math.round(median(inRun.map(([, m]) => m)));
  const tail = samples.filter(([t]) => t >= endMs - 3000 && t < endMs);
  // eindpiek: hoogste gemiddelde over 50 ms in de laatste 3 s voor het afschakelen
  let peak = 0;
  for (let i = 0; i + 10 <= tail.length; i += 2) {
    peak = Math.max(peak, tail.slice(i, i + 10).reduce((a, b) => a + b[1], 0) / 10);
  }
  return { run_ma: run, peak_ma: Math.round(peak), travel_ms: endMs };
}

export function learn(runs, sens = 3) {
  const p = esDefaults();
  p.sens = sens;
  for (const c of [0, 1]) {
    const rs = runs.filter((r) => (r.closing ? 1 : 0) === c).map((r) => analyseRun(r.samples, r.endMs));
    if (!rs.length) continue;
    p.run_ma[c] = median(rs.map((r) => r.run_ma));
    p.peak_ma[c] = median(rs.map((r) => r.peak_ma));
    p.travel_ds[c] = Math.round(median(rs.map((r) => r.travel_ms)) / 100);
  }
  if (p.run_ma[0] && p.run_ma[1]) p.flags = ES_CALIBRATED;
  return p;
}
