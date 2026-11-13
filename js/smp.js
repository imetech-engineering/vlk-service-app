// smp.js - firmware-update via MCUmgr (SMP) over Web Bluetooth
// Upload van zephyr.signed.bin naar slot 1, markeren als test, herstarten. De nieuwe firmware
// bevestigt zichzelf na een geslaagde start; anders zet MCUboot de oude versie terug.
// IMeTech Engineering, project 5008

export const SMP_SVC = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHR = 'da2e7828-fbce-4e01-ae9e-261174997c48';

// ---------------- minimale CBOR (alleen wat SMP nodig heeft) ----------------
function encHead(major, n, out) {
  if (n < 24) out.push((major << 5) | n);
  else if (n < 256) out.push((major << 5) | 24, n);
  else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
  else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
export function cborEncode(v, out = []) {
  if (typeof v === 'number') encHead(0, v, out);
  else if (typeof v === 'boolean') out.push(v ? 0xf5 : 0xf4);
  else if (typeof v === 'string') { const b = new TextEncoder().encode(v); encHead(3, b.length, out); out.push(...b); }
  else if (v instanceof Uint8Array) { encHead(2, v.length, out); for (const x of v) out.push(x); }
  else if (Array.isArray(v)) { encHead(4, v.length, out); v.forEach((x) => cborEncode(x, out)); }
  else { const k = Object.keys(v); encHead(5, k.length, out); k.forEach((key) => { cborEncode(key, out); cborEncode(v[key], out); }); }
  return out;
}
export function cborDecode(b) {
  let i = 0;
  const len = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return b[i++];
    if (ai === 25) { const v = (b[i] << 8) | b[i + 1]; i += 2; return v; }
    if (ai === 26) { const v = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; i += 4; return v; }
    if (ai === 27) { let v = 0; for (let k = 0; k < 8; k++) v = v * 256 + b[i++]; return v; }
    if (ai === 31) return -1;
    throw new Error('CBOR: onbekende lengte');
  };
  const item = () => {
    const ib = b[i++];
    const mt = ib >> 5, ai = ib & 31;
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; throw new Error('CBOR: simple'); }
    const n = len(ai);
    switch (mt) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = b.slice(i, i + n); i += n; return v; }
      case 3: { const v = new TextDecoder().decode(b.slice(i, i + n)); i += n; return v; }
      case 4: { const a = []; if (n < 0) { while (b[i] !== 0xff) a.push(item()); i++; } else for (let k = 0; k < n; k++) a.push(item()); return a; }
      case 5: { const o = {}; const read = () => { const k = item(); o[k] = item(); };
        if (n < 0) { while (b[i] !== 0xff) read(); i++; } else for (let k = 0; k < n; k++) read(); return o; }
      default: throw new Error('CBOR: type ' + mt);
    }
  };
  return item();
}

// ------------------------------------- SMP -------------------------------------
export class Smp {
  constructor(server) { this.server = server; this.seq = 0; this.rx = []; this.waiting = null; this.chunk = 240; }

  async open() {
    const svc = await this.server.getPrimaryService(SMP_SVC);
    this.chr = await svc.getCharacteristic(SMP_CHR);
    await this.chr.startNotifications();
    this.chr.addEventListener('characteristicvaluechanged', (e) => this.onData(new Uint8Array(e.target.value.buffer)));
  }

  onData(d) {
    this.rx.push(...d);
    if (this.rx.length < 8) return;
    const need = 8 + ((this.rx[2] << 8) | this.rx[3]);
    if (this.rx.length < need) return;
    const pkt = new Uint8Array(this.rx.slice(0, need));
    this.rx = this.rx.slice(need);
    const w = this.waiting;
    this.waiting = null;
    if (w) { clearTimeout(w.timer); w.resolve(cborDecode(pkt.slice(8))); }
  }

  async send(op, group, id, body) {
    const payload = cborEncode(body);
    const seq = (this.seq = (this.seq + 1) & 255);
    const pkt = new Uint8Array([(1 << 3) | op, 0, payload.length >> 8, payload.length & 255, group >> 8, group & 255, seq, id, ...payload]);
    const reply = new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, timer: setTimeout(() => { this.waiting = null; reject(new Error('SMP: geen antwoord')); }, 8000) };
    });
    // in stukken schrijven; de firmware zet ze weer in elkaar (MCUMGR_TRANSPORT_BT_REASSEMBLY)
    for (let o = 0; o < pkt.length; o += this.chunk) {
      try {
        await this.chr.writeValueWithoutResponse(pkt.slice(o, o + this.chunk));
      } catch (e) {
        if (this.chunk > 20) { this.chunk = 20; o -= this.chunk; continue; }
        throw e;
      }
    }
    const r = await reply;
    if (r.rc) throw new Error(`SMP-fout ${r.rc}`);
    if (r.err && r.err.rc) throw new Error(`SMP-fout groep ${r.err.group} rc ${r.err.rc}`);
    return r;
  }

  async imageState() { return this.send(0, 1, 0, {}); }

  async upload(image, onProgress) {
    let off = 0;
    const size = 128;
    while (off < image.length) {
      const data = image.slice(off, off + size);
      const body = off === 0 ? { image: 0, len: image.length, off: 0, data } : { off, data };
      const r = await this.send(2, 1, 1, body);
      off = typeof r.off === 'number' ? r.off : off + data.length;
      onProgress?.(off / image.length);
    }
  }

  async testAndReset() {
    const st = await this.imageState();
    const s1 = (st.images || []).find((i) => i.slot === 1);
    if (!s1) throw new Error('nieuwe image niet gevonden in slot 1');
    await this.send(2, 1, 0, { hash: s1.hash, confirm: false });
    try { await this.send(2, 0, 5, {}); } catch { /* verbinding valt weg bij herstart */ }
    return s1.version;
  }
}
