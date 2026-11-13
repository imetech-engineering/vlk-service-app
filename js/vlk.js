// vlk.js - verbinding met de Vlakkelichtkoepel besturing RevB via Web Bluetooth
// Protocol: docs/protocol.md in de firmware-repo. Alle getallen little-endian.
// IMeTech Engineering, project 5008

import { esDefaults, Endstop, ES_CALIBRATED } from './endstop.js';

const u = (n) => `a1b2${n.toString(16).padStart(4, '0')}-5008-4c4b-9e1d-494d65546563`;
export const UUID_SVC = u(1);
export const UUID_CTRL = u(2);
export const UUID_RESP = u(3);
export const UUID_STREAM = u(4);
export const UUID_SMP_SVC = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';

export const OP = {
  INFO: 0x01, STATUS: 0x02, CMD: 0x03, HOLD: 0x04,
  CFG_GET: 0x10, CFG_SET: 0x11, ES_GET: 0x12, ES_SET: 0x13, ES_RESET: 0x14,
  LOG_COUNT: 0x20, LOG_GET: 0x21, LOG_CLEAR: 0x22,
  REM_LIST: 0x30, REM_ADD: 0x31, REM_DEL: 0x32, REM_CLEAR: 0x33, PAIR: 0x34,
  STREAM: 0x40, DUUR: 0x41, COUNTERS: 0x42, CLEAR_FAULTS: 0x43,
  SELFTEST: 0x50, SIM: 0x60, REBOOT: 0x70, SET_PIN: 0x71, STATUS_KEY: 0x72, FORGET_PHONES: 0x73,
  UNLOCK: 0x74, FACTORY: 0x75,
};
export const ROLE = { NONE: 0, INSTALLER: 1, IMETECH: 2 };
export const ROLE_NAMES = ['geen', 'installateur', 'IMeTech'];
export const ES_SIZE = 14;
export const CMD = { OPEN: 1, CLOSE: 2, STOP: 3 };

export const POS_NAMES = ['onbekend', 'open', 'dicht', 'dicht (onbevestigd)', 'tussenstand', 'opent', 'sluit'];
export const SRC_NAMES = ['-', 'afstandsbediening', 'ingang', 'app', 'regen', 'accu', 'sluitbevestiging',
  'duurtest', 'eindtest', 'veiligheid'];
export const FAULTS = [
  [1 << 0, 'Blokkade / overstroom motor'], [1 << 1, 'Maximale looptijd'], [1 << 2, 'Stroom na STOP'],
  [1 << 3, 'Geen motorstroom'], [1 << 4, 'Accu te laag'], [1 << 5, 'Regensensor ontbreekt'],
  [1 << 6, 'Inschakelduur motor'], [1 << 7, 'Loopstroom past niet bij DIP-stand'],
  [1 << 8, 'Temperatuur te hoog'], [1 << 9, 'Nulpunt stroomsensor'], [1 << 10, 'Watchdog-herstart'],
];
export const FLAGS = { SERVICE: 1, DUURTEST: 2, DEADMAN: 4, PAIR: 8, RAIN_EP: 16, ACCU_LOW: 32, SELFTEST: 64, SIM: 128 };
export const PROFILES = ['1 motor', 'twinmotor', '3 motoren + M-COM'];
export const EVL = {
  1: 'Opstart', 2: 'Commando', 3: 'Beweging', 4: 'Stroom', 5: 'Fout', 6: 'Regen', 7: 'Accu', 8: 'Koppelen',
  9: 'Instelling', 10: 'Duurtest', 11: 'Dodemans', 12: 'Eindtest', 13: 'Toegang',
};
const STOP_REASON = ['eindherkenning', 'STOP', 'dodemans los', 'veiligheid'];
const RES = ['gestopt', 'eindstand', 'eindstand zonder stijging', 'te vroeg gestopt', 'stond al in eindstand', 'blokkade', 'max. looptijd'];

// ---- struct vlk_cfg (32 bytes, firmware/src/config.h) ----
export const CFG_FIELDS = [
  // [naam, offset, type, label, eenheid]
  ['version', 0, 'u8'], ['accu_type', 1, 'u8'], ['accu_block_mv', 2, 'u16'], ['accu_release_mv', 4, 'u16'],
  ['rain_present', 6, 'u8'], ['aux12_in_use', 7, 'u8'], ['aux24_in_use', 8, 'u8'], ['autoclose_deadman', 9, 'u8'],
  ['deadman_timeout_ms', 10, 'u16'], ['confirm_retry_s', 12, 'u16'], ['rain_heat_s', 14, 'u16'],
  ['duty_window_s', 16, 'u16'], ['duty_max_s', 18, 'u16'], ['reverse_pause_ms', 20, 'u16'],
  ['idle_scan_profile', 22, 'u8'], ['duurtest', 23, 'u8'], ['duurtest_interval_s', 24, 'u16'],
  ['temp_max_c', 26, 'u16'], ['service_pin', 28, 'u32'],
];
export const CFG_SIZE = 32;

function rd(dv, off, t) {
  return t === 'u8' ? dv.getUint8(off) : t === 'u16' ? dv.getUint16(off, true) : dv.getUint32(off, true);
}
function wr(dv, off, t, v) {
  if (t === 'u8') dv.setUint8(off, v); else if (t === 'u16') dv.setUint16(off, v, true); else dv.setUint32(off, v, true);
}
export function decodeCfg(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = {};
  for (const [k, off, t] of CFG_FIELDS) c[k] = rd(dv, off, t);
  return c;
}
export function encodeCfg(c) {
  const b = new Uint8Array(CFG_SIZE);
  const dv = new DataView(b.buffer);
  for (const [k, off, t] of CFG_FIELDS) wr(dv, off, t, c[k] >>> 0);
  return b;
}
// struct es_params (14 bytes, firmware/src/endstop.h)
export function decodeEs(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    run_ma: [dv.getUint16(0, true), dv.getUint16(2, true)],
    peak_ma: [dv.getUint16(4, true), dv.getUint16(6, true)],
    travel_ds: [dv.getUint16(8, true), dv.getUint16(10, true)],
    sens: dv.getUint8(12), flags: dv.getUint8(13),
  };
}
export function encodeEs(p) {
  const b = new Uint8Array(ES_SIZE);
  const dv = new DataView(b.buffer);
  [p.run_ma[0], p.run_ma[1], p.peak_ma[0], p.peak_ma[1], p.travel_ds[0], p.travel_ds[1]]
    .forEach((v, i) => dv.setUint16(i * 2, v, true));
  dv.setUint8(12, p.sens); dv.setUint8(13, p.flags);
  return b;
}
export function decodeStatus(b, o = 0) {
  const dv = new DataView(b.buffer, b.byteOffset + o);
  return {
    pos: dv.getUint8(0), dir: dv.getInt8(1), ma: dv.getUint16(2, true), accu: dv.getUint16(4, true),
    ntc: dv.getInt16(6, true), die: dv.getInt8(8), rain: dv.getUint8(9), faults: dv.getUint32(10, true),
    flags: dv.getUint8(14), duty: dv.getUint8(15), scan: dv.getUint8(16), nrem: dv.getUint8(17),
    rssi: dv.getInt8(18), dip: dv.getUint8(19), profile: dv.getUint8(20), lastSrc: dv.getUint8(21),
    lastRes: dv.getUint8(22), uptime: dv.getUint32(23, true), runMs: dv.getUint32(27, true),
  };
}
export function encodeStatus(s) {
  const b = new Uint8Array(31);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, s.pos); dv.setInt8(1, s.dir); dv.setUint16(2, s.ma, true); dv.setUint16(4, s.accu, true);
  dv.setInt16(6, s.ntc, true); dv.setInt8(8, s.die); dv.setUint8(9, s.rain); dv.setUint32(10, s.faults, true);
  dv.setUint8(14, s.flags); dv.setUint8(15, s.duty); dv.setUint8(16, s.scan); dv.setUint8(17, s.nrem);
  dv.setInt8(18, s.rssi); dv.setUint8(19, s.dip); dv.setUint8(20, s.profile); dv.setUint8(21, s.lastSrc);
  dv.setUint8(22, s.lastRes); dv.setUint32(23, s.uptime, true); dv.setUint32(27, s.runMs, true);
  return b;
}
export function decodeLog(b) {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 0; o + 16 <= b.byteLength; o += 16) {
    out.push({ boot: dv.getUint16(o, true), type: dv.getUint8(o + 2), a: dv.getUint8(o + 3),
      t: dv.getUint32(o + 4, true), b: dv.getUint16(o + 8, true), c: dv.getUint32(o + 12, true) });
  }
  return out;
}
export function describeLog(e) {
  const cmd = ['-', 'OPEN', 'DICHT', 'STOP'][e.a] || e.a;
  switch (e.type) {
    case 1: return `firmware ${e.c >> 16}.${(e.c >> 8) & 255}.${e.c & 255}, reset 0x${e.a.toString(16)}`;
    case 2: return `${cmd} van ${SRC_NAMES[e.b] || e.b}`;
    case 3: return `${e.b & 1 ? 'DICHT' : 'OPEN'} ${(e.c / 1000).toFixed(1)} s, ${RES[e.a] || e.a}, ${STOP_REASON[e.b >> 1] || ''}`;
    case 4: return `piek ${e.b} mA, gem ${e.c >>> 16} mA, na stop ${e.c & 0xffff} mA`;
    case 5: return FAULTS.filter(([bit]) => e.c & bit).map(([, n]) => n).join(', ') || `0x${e.c.toString(16)}`;
    case 6: return e.a ? 'nat' : 'droog';
    case 7: return `${e.a ? 'te laag' : 'hersteld'}, ${(e.c / 1000).toFixed(2)} V`;
    case 8: return `afstandsbediening ${e.a} gekoppeld${e.b ? ' (versleuteld)' : ''}`;
    case 9: return ['instellingen', `kalibratie profiel ${e.b}`, 'pincode', 'nieuwe gateway-statussleutel', 'telefoons vergeten', 'fabrieksinstellingen'][e.a] || `soort ${e.a}`;
    case 10: return e.a ? 'aan' : 'uit';
    case 11: return e.a ? 'time-out (geen signaal)' : 'losgelaten';
    case 12: return e.a ? 'geslaagd' : `niet geslaagd (0x${e.c.toString(16)})`;
    case 13: return ['telefoon koppelen mislukt', 'telefoon gekoppeld', 'IMeTech ontgrendeld', 'verkeerde IMeTech-code'][e.a] + (e.c ? ` (${e.c}x)` : '');
    default: return `a=${e.a} b=${e.b} c=${e.c}`;
  }
}

// foutcodes van de print (errno)
export const ERRNO = {
  1: 'Alleen met IMeTech-code', 13: 'Geen toegang (verkeerde code of te vaak geprobeerd)',
  22: 'Ongeldige waarde', 134: 'Niet ondersteund door deze firmware', 12: 'Geen plaats meer', 2: 'Niet gevonden',
};

export function hex(bytes) { return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join(''); }
export function unhex(s) {
  const t = s.replace(/[^0-9a-f]/gi, '');
  if (t.length % 2) throw new Error('oneven aantal hex-tekens');
  return new Uint8Array(t.match(/../g).map((h) => parseInt(h, 16)));
}

// ------------------------------------------------------------------------------------
// Echte print via Web Bluetooth
// ------------------------------------------------------------------------------------
export class VlkDevice extends EventTarget {
  constructor() {
    super();
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.demo = false;
  }

  async connect() {
    this.dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'VLK-' }, { services: [UUID_SVC] }],
      optionalServices: [UUID_SVC, UUID_SMP_SVC],
    });
    this.dev.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new Event('disconnected')));
    this.server = await this.dev.gatt.connect();
    const svc = await this.server.getPrimaryService(UUID_SVC);
    this.ctrl = await svc.getCharacteristic(UUID_CTRL);
    this.resp = await svc.getCharacteristic(UUID_RESP);
    this.stream = await svc.getCharacteristic(UUID_STREAM);
    // Inschrijven vraagt een beveiligde verbinding: Android toont hier de pincode-vraag
    await this.resp.startNotifications();
    this.resp.addEventListener('characteristicvaluechanged', (e) => this.onResp(new Uint8Array(e.target.value.buffer)));
    await this.stream.startNotifications();
    this.stream.addEventListener('characteristicvaluechanged', (e) => this.onStream(new Uint8Array(e.target.value.buffer)));
    this.name = this.dev.name;
    return this;
  }

  disconnect() { if (this.dev?.gatt.connected) this.dev.gatt.disconnect(); }

  get connected() { return !!this.dev?.gatt.connected; }

  onResp(b) {
    if (b[0] >= 0xe0) {
      if (b[0] === 0xe0) this.dispatchEvent(new CustomEvent('status', { detail: decodeStatus(b, 1) }));
      else if (b[0] === 0xe1) this.dispatchEvent(new CustomEvent('motor', { detail: { ev: b[1], arg: b[2] } }));
      else if (b[0] === 0xe2) this.dispatchEvent(new CustomEvent('text', { detail: new TextDecoder().decode(b.slice(1)) }));
      return;
    }
    const p = this.pending.get(b[1]);
    if (!p) return;
    this.pending.delete(b[1]);
    clearTimeout(p.timer);
    if (b[2]) p.reject(new Error(ERRNO[b[2]] || `print weigert (fout ${b[2]})`));
    else p.resolve(b.slice(3));
  }

  onStream(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = b[1];
    const t0 = dv.getUint32(2, true);
    const ma = [];
    for (let i = 0; i < n; i++) ma.push(dv.getUint16(6 + 2 * i, true));
    this.dispatchEvent(new CustomEvent('samples', { detail: { t0, ma } }));
  }

  // Aanvragen na elkaar (de print verwerkt ze in volgorde)
  request(op, payload = new Uint8Array(0)) {
    const run = () => new Promise((resolve, reject) => {
      const seq = (this.seq = (this.seq + 1) & 0xff);
      const msg = new Uint8Array(2 + payload.length);
      msg[0] = op; msg[1] = seq; msg.set(payload, 2);
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error('geen antwoord van de print')); }, 4000);
      this.pending.set(seq, { resolve, reject, timer });
      this.ctrl.writeValueWithResponse(msg).catch((e) => { clearTimeout(timer); this.pending.delete(seq); reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

// ------------------------------------------------------------------------------------
// Demo: dezelfde interface zonder print, met het motormodel van de DK-simulatie
// ------------------------------------------------------------------------------------
export class DemoDevice extends EventTarget {
  constructor() {
    super();
    this.demo = true;
    this.name = 'VLK-DEMO01';
    this.cfg = { version: 1, accu_type: 0, accu_block_mv: 11900, accu_release_mv: 12400, rain_present: 1,
      aux12_in_use: 0, aux24_in_use: 0, autoclose_deadman: 0, deadman_timeout_ms: 1000, confirm_retry_s: 300,
      rain_heat_s: 300, duty_window_s: 600, duty_max_s: 180, reverse_pause_ms: 500, idle_scan_profile: 3,
      duurtest: 0, duurtest_interval_s: 300, temp_max_c: 85, service_pin: 0 };
    this.es = [esDefaults(), esDefaults(), esDefaults()];
    this.role = 1;
    this.remotes = [{ idx: 0, type: 0, addr: '4C:45:53:05:07:BD', key: true }];
    this.log = [{ boot: 12, type: 1, a: 1, t: 0, b: 0, c: 0x000100 }];
    this.st = { pos: 2, dir: 0, ma: 0, accu: 12850, ntc: 185, die: 24, rain: 0, faults: 0, flags: 1 | 128,
      duty: 0, scan: 3, nrem: 1, rssi: -61, dip: 0, profile: 0, lastSrc: 0, lastRes: 0, uptime: 0, runMs: 0 };
    this.posMs = 0; this.travel = 20000; this.streamOn = false; this.counters = [41, 40, 0, 0, 12];
    this.timer = setInterval(() => this.tick(), 50);
    this.statusTimer = setInterval(() => {
      this.st.uptime++;
      this.dispatchEvent(new CustomEvent('status', { detail: { ...this.st } }));
    }, 1000);
  }

  get connected() { return true; }
  disconnect() { clearInterval(this.timer); clearInterval(this.statusTimer); this.dispatchEvent(new Event('disconnected')); }

  noise(a) { return Math.round((Math.random() * 2 - 1) * a); }

  // zelfde model als de DK-simulatie: loopstroom, stijging aan het eind, daarna afschakelen
  current(t) {
    const d = this.st.dir;
    if (t < 400) return 900 - t + this.noise(30);
    if ((d < 0 && this.posMs > 0) || (d > 0 && this.posMs < this.travel)) { this.endSince = 0; return 300 + this.noise(25); }
    this.endSince ||= t;
    const te = t - this.endSince;
    return te < 1500 ? 300 + Math.floor((210 * te) / 1500) + this.noise(10) : Math.max(0, this.noise(5));
  }

  async start(dir, cal = false) {
    if (this.st.dir) return;
    const full = dir > 0 ? this.st.pos === 2 || this.st.pos === 3 : this.st.pos === 1;
    this.st.dir = dir; this.st.pos = dir > 0 ? 5 : 6; this.runStart = performance.now(); this.endSince = 0;
    this.es1 = new Endstop(this.es[this.st.profile], dir < 0, cal, full);
    this.win = 0; this.winN = 0;
    this.dispatchEvent(new CustomEvent('motor', { detail: { ev: 1, arg: dir < 0 ? 1 : 0 } }));
  }

  stop(res) {
    if (!this.st.dir) return;
    const closing = this.st.dir < 0;
    this.st.lastRes = res;
    this.st.pos = [1, 2, 4].includes(res) ? (closing ? (res === 1 ? 2 : 3) : 1) : 4;
    this.log.push({ boot: 12, type: 3, a: res, t: this.st.uptime, b: closing ? 1 : 2, c: Math.round(this.st.runMs) });
    this.st.dir = 0; this.st.ma = 0; this.st.runMs = 0;
    this.dispatchEvent(new CustomEvent('motor', { detail: { ev: 2, arg: res } }));
  }

  tick() {
    if (!this.st.dir) return;
    const t = performance.now() - this.runStart;
    const prev = this.st.runMs;
    this.posMs = Math.max(0, Math.min(this.travel, this.posMs + this.st.dir * (t - prev)));
    const ma = [];
    let res = 0;
    for (let k = 0; k < 10; k++) {
      const v = Math.max(0, this.current(prev + (k + 1) * 5));
      ma.push(v);
      this.win += v;
      if (++this.winN >= 10) {
        res = this.es1.feed(prev + (k + 1) * 5, Math.floor(this.win / 10));
        this.win = 0; this.winN = 0;
        if (res !== 0) break;
      }
    }
    this.st.runMs = t; this.st.ma = ma[ma.length - 1];
    // net als de firmware: eerst de metingen, dan de stopmarkering
    if (this.streamOn) this.dispatchEvent(new CustomEvent('samples', { detail: { t0: prev + 5, ma } }));
    if (res !== 0) { this.stop(res); return; }
    if (this.holdUntil && performance.now() > this.holdUntil) { this.holdUntil = 0; this.stop(0); }
  }

  async request(op, p = new Uint8Array(0)) {
    await new Promise((r) => setTimeout(r, 40));
    switch (op) {
      case OP.INFO: {
                const out = new Uint8Array(54);
        out.set([0, 1, 0, this.st.dip, this.st.profile, 1, 2, ES_SIZE, 1]);
        out.set(new TextEncoder().encode('RevB0'), 9); out.set(new TextEncoder().encode(this.name), 17);
        out.set(new TextEncoder().encode('demo'), 33);
        out[53] = this.role;
        return out;
      }
      case OP.STATUS: return encodeStatus(this.st);
      case OP.CMD:
        if (p[0] === CMD.STOP) this.stop(0); else this.start(p[0] === CMD.OPEN ? 1 : -1, p[1] === 1);
        return new Uint8Array(0);
      case OP.HOLD:
        if (!this.st.dir) this.start(p[0] === CMD.OPEN ? 1 : -1);
        this.holdUntil = performance.now() + this.cfg.deadman_timeout_ms;
        return new Uint8Array(0);
      case OP.CFG_GET: return encodeCfg(this.cfg);
      case OP.CFG_SET: this.cfg = decodeCfg(p); return new Uint8Array(0);
      case OP.ES_GET: { const b = new Uint8Array(1 + ES_SIZE); b[0] = p[0]; b.set(encodeEs(this.es[p[0]]), 1); return b; }
      case OP.ES_SET: this.es[p[0]] = decodeEs(p.slice(1)); return new Uint8Array(0);
      case OP.ES_RESET: this.es[p[0]] = esDefaults(); return new Uint8Array(0);
      case OP.UNLOCK:
        if (new TextDecoder().decode(p) !== 'imetech-dk') { await new Promise((r) => setTimeout(r, 500)); throw new Error(ERRNO[13]); }
        this.role = 2; return new Uint8Array([2]);
      case OP.FACTORY: this.es = [esDefaults(), esDefaults(), esDefaults()]; this.remotes = []; return new Uint8Array(0);
      case OP.STATUS_KEY: this.skey ||= crypto.getRandomValues(new Uint8Array(16)); if (p[0] === 1) this.skey = crypto.getRandomValues(new Uint8Array(16)); return this.skey;
      case OP.FORGET_PHONES: return new Uint8Array(0);
      case OP.LOG_COUNT: return new Uint8Array([this.log.length & 255, this.log.length >> 8]);
      case OP.LOG_GET: {
        const start = p[0] | (p[1] << 8);
        const items = this.log.slice(start, start + Math.min(p[2], 14));
        const b = new Uint8Array(items.length * 16);
        const dv = new DataView(b.buffer);
        items.forEach((e, i) => {
          const o = i * 16;
          dv.setUint16(o, e.boot, true); dv.setUint8(o + 2, e.type); dv.setUint8(o + 3, e.a);
          dv.setUint32(o + 4, e.t, true); dv.setUint16(o + 8, e.b, true); dv.setUint32(o + 12, e.c, true);
        });
        return b;
      }
      case OP.LOG_CLEAR: if (this.role < 2) throw new Error(ERRNO[1]); this.log = []; return new Uint8Array(0);
      case OP.REM_LIST: {
        const b = new Uint8Array(this.remotes.length * 9);
        this.remotes.forEach((r, i) => {
          b[i * 9] = r.idx; b[i * 9 + 1] = 0;
          r.addr.split(':').reverse().forEach((h, k) => { b[i * 9 + 2 + k] = parseInt(h, 16); });
          b[i * 9 + 8] = r.key ? 1 : 0;
        });
        return b;
      }
      case OP.REM_DEL: this.remotes = this.remotes.filter((r) => r.idx !== p[0]); return new Uint8Array(0);
      case OP.REM_CLEAR: this.remotes = []; return new Uint8Array(0);
      case OP.PAIR:
        setTimeout(() => {
          const idx = this.remotes.length ? Math.max(...this.remotes.map((r) => r.idx)) + 1 : 0;
          this.remotes.push({ idx, addr: 'B8:1F:3F:5F:63:56', key: p.length > 1 });
          this.dispatchEvent(new CustomEvent('text', { detail: `Afstandsbediening ${idx} gekoppeld (demo)` }));
        }, 3000);
        return new Uint8Array(0);
      case OP.STREAM: this.streamOn = !!p[0]; return new Uint8Array(0);
      case OP.DUUR: this.cfg.duurtest = p[0]; this.st.flags = p[0] ? this.st.flags | 2 : this.st.flags & ~2; return new Uint8Array(0);
      case OP.COUNTERS: { const b = new Uint8Array(20); const dv = new DataView(b.buffer); this.counters.forEach((v, i) => dv.setUint32(i * 4, v, true)); return b; }
      case OP.CLEAR_FAULTS: this.st.faults = 0; return new Uint8Array(0);
      case OP.SELFTEST:
        if (this.role < 2) throw new Error(ERRNO[1]);
        ['EINDTEST start (demo)', 'VDD 3300 mV OK', 'Accu 12850 mV OK', 'NTC 18.5 C OK', 'Nulpunt stroomsensor OK',
          'Motor OPEN 300 ms: gem 310 mA OK', 'Motor DICHT 300 ms: gem 305 mA OK', 'EINDTEST klaar: GESLAAGD (foutbits 0x000)']
          .forEach((t, i) => setTimeout(() => this.dispatchEvent(new CustomEvent('text', { detail: t })), 400 * (i + 1)));
        return new Uint8Array(0);
      case OP.SIM: {
        if (this.role < 2) throw new Error(ERRNO[1]);
        const v = p[1] | (p[2] << 8);
        if (p[0] === 1) this.st.rain = v ? 1 : 0;
        if (p[0] === 2) this.st.accu = v;
        if (p[0] === 3) this.posMs = (v / 100) * this.travel;
        return new Uint8Array(0);
      }
      case OP.SET_PIN: if (this.role < 2) throw new Error(ERRNO[1]); return new Uint8Array([0x40, 0xe2, 0x01, 0]);
      case OP.REBOOT: case OP.REM_ADD: return new Uint8Array([0]);
      default: throw new Error('onbekend commando (demo)');
    }
  }
}
