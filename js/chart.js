// chart.js - eenvoudige stroomgrafiek op een canvas (geen externe bibliotheken, werkt offline)
// IMeTech Engineering, project 5008

export class Chart {
  constructor(canvas) {
    this.c = canvas;
    this.series = [];      // [{t, ma}]
    this.markers = [];     // [{t, label, color}]
    this.lines = [];       // horizontale drempels [{ma, label, color}]
    this.windowMs = 30000;
    this.follow = true;
    this.maxMa = 1000;
    this.onPick = null;    // (t_ms) => void, tikken in de grafiek
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('click', (e) => {
      if (!this.onPick || !this.geo) return;
      const r = canvas.getBoundingClientRect();
      const { L, pw, t0 } = this.geo;
      const f = (e.clientX - r.left - L) / pw;
      if (f >= 0 && f <= 1) this.onPick(Math.round(t0 + f * this.windowMs));
    });
  }

  clear() { this.series = []; this.markers = []; this.draw(); }

  push(t, ma) {
    this.series.push({ t, ma });
    if (this.series.length > 200 * 600) this.series.splice(0, 20000); // max ca. 10 min
  }

  mark(t, label, color) { this.markers.push({ t, label, color }); }

  draw() {
    const c = this.c;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim() || '#222';
    const grid = css.getPropertyValue('--grid').trim() || '#ddd';
    const accent = css.getPropertyValue('--accent').trim() || '#0a5bd8';
    g.clearRect(0, 0, w, h);
    const L = 44, B = 22, T = 8, Rm = 8;
    const pw = w - L - Rm, ph = h - T - B;

    const last = this.series.length ? this.series[this.series.length - 1].t : 0;
    const t1 = this.follow ? Math.max(this.windowMs, last) : (this.viewEnd ?? Math.max(this.windowMs, last));
    const t0 = t1 - this.windowMs;
    let mx = 100;
    for (const p of this.series) if (p.t >= t0 && p.ma > mx) mx = p.ma;
    for (const l of this.lines) if (l.ma > mx && l.ma < mx * 3) mx = l.ma;
    const step = mx > 2000 ? 500 : mx > 800 ? 200 : 100;
    this.maxMa = Math.ceil((mx * 1.1) / step) * step;
    this.geo = { L, pw, t0 };
    const X = (t) => L + ((t - t0) / this.windowMs) * pw;
    const Y = (ma) => T + ph - (ma / this.maxMa) * ph;

    // raster
    g.strokeStyle = grid; g.fillStyle = fg; g.lineWidth = 1; g.font = '11px system-ui';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = 0; v <= this.maxMa; v += step) {
      g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke();
      g.fillText(v >= 1000 ? (v / 1000).toFixed(1) + ' A' : v + '', L - 4, Y(v));
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const ts = this.windowMs > 60000 ? 10000 : this.windowMs > 20000 ? 5000 : 1000;
    for (let t = Math.ceil(t0 / ts) * ts; t <= t1; t += ts) {
      g.beginPath(); g.moveTo(X(t), T); g.lineTo(X(t), T + ph); g.stroke();
      g.fillText((t / 1000).toFixed(0) + ' s', X(t), T + ph + 4);
    }

    // drempels
    g.setLineDash([4, 4]);
    for (const l of this.lines) {
      if (l.ma > this.maxMa) continue;
      g.strokeStyle = l.color; g.beginPath(); g.moveTo(L, Y(l.ma)); g.lineTo(L + pw, Y(l.ma)); g.stroke();
      g.fillStyle = l.color; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(l.label, L + 4, Y(l.ma) - 1);
    }
    g.setLineDash([]);

    // curve
    g.strokeStyle = accent; g.lineWidth = 1.5; g.beginPath();
    let started = false;
    for (const p of this.series) {
      if (p.t < t0) continue;
      if (!started) { g.moveTo(X(p.t), Y(p.ma)); started = true; } else g.lineTo(X(p.t), Y(p.ma));
    }
    g.stroke();

    // markeringen
    g.lineWidth = 1.5; g.textAlign = 'left'; g.textBaseline = 'top';
    let k = 0;
    for (const m of this.markers) {
      if (m.t < t0 || m.t > t1) continue;
      g.strokeStyle = m.color; g.fillStyle = m.color;
      g.beginPath(); g.moveTo(X(m.t), T); g.lineTo(X(m.t), T + ph); g.stroke();
      // labels om en om op een andere hoogte, zodat ze elkaar niet overlappen
      const x = X(m.t) + 3;
      const w = g.measureText(m.label).width;
      g.textAlign = x + w > L + pw ? 'right' : 'left';
      g.fillText(m.label, g.textAlign === 'right' ? X(m.t) - 3 : x, T + 2 + (k++ % 3) * 13);
    }
  }
}
