// app.js - VLK Service: service- en kalibratie-app voor de Vlakkelichtkoepel besturing RevB
// IMeTech Engineering, project 5008
import { ICON } from './icons.js';
import { Chart } from './chart.js';
import { RESULT_NAMES, RESULT_TEXT, RESULT_OK, ES_CALIBRATED, Endstop, esDefaults, replay, suggestEnd, learn } from './endstop.js';
import {
  VlkDevice, DemoDevice, OP, CMD, ROLE, ROLE_NAMES, ES_SIZE, POS_NAMES, SRC_NAMES, FAULTS, FLAGS, PROFILES, EVL,
  decodeCfg, encodeCfg, decodeEs, encodeEs, decodeStatus, decodeLog, describeLog, hex, unhex,
} from './vlk.js';
import { Smp } from './smp.js';
import { initEindtest } from './eindtest.js';
import { gatewayScript, GATEWAY_SCRIPT_VERSION } from './gateway.js';

export const APP_VERSION = '0.3.9'; // gelijk houden met sw.js
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const btnHtml = (icon, text) => `${ICON[icon] || ''}<span>${text}</span>`;

let dev = null;
let info = null;
let cfg = null;
let status = null;
let duurBusy = false; // duurtest-opdracht onderweg
let esDevice = [null, null, null];   // zoals op de print
let esEdit = [null, null, null];     // in bewerking
let runs = [];
let restPos = 0;              // laatste positie in rust: bepaalt of een rit van eindstand naar eindstand ging
let run = null;
let runSeq = 1;
let sessionT0 = performance.now();
let runOffset = 0;
let eindtest = null;
let logEntries = [];
let fwImage = null;

// ------------------------------------------------------------------ algemeen
function snack(text, actionText, action, ms = 5000) {
  const s = $('snack');
  $('snack-text').textContent = text;
  const b = $('snack-btn');
  b.hidden = !actionText;
  b.textContent = actionText || '';
  b.onclick = () => { s.hidden = true; clearTimeout(snack.t); action?.(); };
  s.hidden = false;
  clearTimeout(snack.t);
  snack.t = setTimeout(() => { s.hidden = true; snack.onTimeout?.(); snack.onTimeout = null; }, ms);
}

function confirmDlg(text, yes = 'Ja') {
  return new Promise((resolve) => {
    $('dlg-text').textContent = text;
    $('dlg-yes').textContent = yes;
    const d = $('dlg');
    d.onclose = () => resolve(d.returnValue === 'yes');
    d.showModal();
  });
}

async function req(op, payload, quiet = false) {
  if (!dev) throw new Error('niet verbonden');
  try {
    return await dev.request(op, payload);
  } catch (e) {
    if (!quiet) snack(e.message);
    throw e;
  }
}

function download(name, text, type = 'text/plain') {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{6})(\d{2})(\d{4})/, '$1$2_$3').slice(2);

// ------------------------------------------------------------------ tabs
const TABS = [
  ['live', 'live', 'Live'], ['calib', 'calib', 'Kalibratie'], ['settings', 'settings', 'Instellingen'],
  ['remotes', 'remote', 'Bediening'], ['log', 'log', 'Log'], ['test', 'test', 'Eindtest'], ['update', 'upload', 'Update'],
];
function showTab(name) {
  for (const [id] of TABS) {
    $(`tab-${id}`).hidden = id !== name;
    $(`tabbtn-${id}`).classList.toggle('on', id === name);
  }
  localStorage.setItem('vlk-tab', name);
  if (name === 'live') chart.draw();
  if (name === 'calib') { renderReplayRuns(); rpChart.draw(); }
}
for (const [id, icon, label] of TABS) {
  const b = el('button', '', btnHtml(icon, label));
  b.id = `tabbtn-${id}`;
  b.onclick = () => showTab(id);
  $('tabs').append(b);
}

// ------------------------------------------------------------------ knoppen en labels
const labels = {
  'b-open': ['open', 'OPEN'], 'b-stop': ['stop', 'STOP'], 'b-close': ['close', 'DICHT'],
  'cal-save': ['save', 'Opslaan op print'], 'cal-wipe': ['trash', 'Kalibratie wissen'], 'cal-export': ['download', 'Exporteren'],
  'cal-import-lbl': ['upload', 'Importeren'], 'rp-csv-lbl': ['upload', 'CSV openen'], 'rp-go': ['play', 'Afspelen'],
  'cfg-save': ['save', 'Opslaan op print'], 'cfg-reload': ['download', 'Opnieuw laden'],
  'pin-save': ['key', 'Pincode instellen'], 'sim-apply': ['play', 'Toepassen'],
  'clear-faults': ['reset', 'Fouten wissen'], 'reboot': ['power', 'Print herstarten'],
  'forget-phones': ['bt', 'Telefoons vergeten'], 'imt-unlock': ['key', 'Ontgrendelen'], 'factory': ['reset', 'Fabrieksinstellingen'],
  'skey-show': ['key', 'Sleutel tonen'], 'skey-new': ['reset', 'Nieuwe sleutel'],
  'rem-refresh': ['reset', 'Vernieuwen'],
  'rem-gen': ['key', 'Sleutel maken (gateway)'], 'rem-pair-key': ['plus', 'Koppelen'],
  'rem-pair': ['plus', 'Koppelmodus 30 s'], 'rem-clear': ['trash', 'Alle koppelingen wissen'],
  'duur-save': ['save', 'Interval opslaan'], 'log-load': ['download', 'Laden'], 'log-export': ['download', 'CSV'],
  'log-clear': ['trash', 'Wissen'],
  'fw-pick-lbl': ['upload', 'Bestand kiezen'], 'fw-go': ['upload', 'Update starten'],
};
for (const [id, [icon, text]] of Object.entries(labels)) $(id).innerHTML = btnHtml(icon, text);

// ------------------------------------------------------------------ verbinden
function setConnected(on) {
  $('btn-connect').innerHTML = on ? btnHtml('x', 'Verbreken') : btnHtml('bt', 'Verbinden');
  $('btn-demo').hidden = on;
  $('conn-sub').textContent = on ? `${dev.name}${dev.demo ? ' (demo)' : ''}` : `Niet verbonden - app ${APP_VERSION}`;
  if (!on) { info = null; wiz.on = false; renderWiz(); applyRole(); eindtest?.reset(); }
  document.querySelectorAll('main button, main input, main select').forEach((e) => {
    if (!e.closest('#tab-calib') && e.id !== 'win') e.disabled = !on;
  });
  if (on) $('fw-go').disabled = !fwImage || dev.demo;
  $('cal-start').disabled = !on || wiz.on;
  eindtest?.refresh();
  if (typeof renderAb === 'function') renderAb();
}

// ------------------------------------------------------------------ rollen
// installateur = verbonden met de pincode van het label; IMeTech = daarna ontgrendeld met de IMeTech-code.
// De print controleert dit zelf; de app verbergt alleen wat toch geweigerd zou worden.
function applyRole() {
  const role = info?.role ?? ROLE.NONE;
  const imt = role === ROLE.IMETECH;
  document.querySelectorAll('.imt').forEach((e) => { e.hidden = !imt; });
  $('sim-panel').hidden = !(imt && info?.sim);
  $('tabbtn-test').hidden = !imt;
  if (!imt && localStorage.getItem('vlk-tab') === 'test' && !$('tab-test').hidden) showTab('live');
  $('role-name').textContent = ROLE_NAMES[role] || '-';
  $('unlock-row').hidden = imt || !dev;
  if (dev) $('conn-sub').textContent = `${dev.name}${dev.demo ? ' (demo)' : ''} - ${ROLE_NAMES[role]}`;
}
$('imt-unlock').onclick = async () => {
  const code = $('imt-code').value;
  if (code.length < 4 || code.length > 32) { snack('Code: 4 tot 32 tekens'); return; }
  $('imt-code').value = '';
  try {
    const r = await req(OP.UNLOCK, new TextEncoder().encode(code), true);
    info.role = r[0] ?? ROLE.IMETECH;
    applyRole();
    snack('IMeTech-functies ontgrendeld tot de verbinding stopt');
  } catch (e) { snack(e.message); }
};
$('factory').onclick = async () => {
  if (!(await confirmDlg('Instellingen, kalibratie en koppelingen terugzetten naar de fabriekstoestand? Tellers, foutlog en pincode blijven. Dit kun je niet ongedaan maken; exporteer eventueel eerst de kalibratie.', 'Terugzetten'))) return;
  await req(OP.FACTORY);
  await loadCfg();
  await loadEs(activeProfile());
  loadRemotes();
  snack('Fabrieksinstellingen teruggezet');
};
$('forget-phones').onclick = async () => {
  if (!(await confirmDlg('Alle gekoppelde telefoons vergeten? Daarna koppelt elke telefoon opnieuw met de pincode van het label. De verbinding wordt verbroken.', 'Vergeten'))) return;
  await req(OP.FORGET_PHONES);
  snack('Telefoons vergeten');
  dev?.disconnect();
};

async function onConnected() {
  setConnected(true);
  dev.addEventListener('status', (e) => {
    status = e.detail;
    if (!status.dir) restPos = status.pos;
    renderStatus();
    syncSimDip();
  });
  dev.addEventListener('samples', (e) => onSamples(e.detail));
  dev.addEventListener('motor', (e) => onMotor(e.detail));
  dev.addEventListener('text', (e) => onText(e.detail));
  dev.addEventListener('disconnected', () => { snack('Verbinding verbroken'); dev = null; setConnected(false); });
  try {
    const i = await req(OP.INFO);
    const td = new TextDecoder();
    info = { fw: `${i[0]}.${i[1]}.${i[2]}`, dip: i[3], profile: i[4], cfgVer: i[5], esVer: i[6], esN: i[7], sim: !!i[8],
      hw: td.decode(i.slice(9, 17)).replace(/\0.*$/, ''), name: td.decode(i.slice(17, 33)).replace(/\0.*$/, ''),
      built: td.decode(i.slice(33, 53)).replace(/\0.*$/, ''), role: i.length > 53 ? i[53] : ROLE.INSTALLER,
      mac: i.length >= 60 ? [...i.slice(54, 60)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':') : '' };
    if (info.esN !== ES_SIZE || info.esVer !== 2) snack('Let op: andere versie eindherkenning in de firmware; update de app');
    $('fw-current').textContent = `Huidige firmware ${info.fw} (${info.built}), ${info.hw}`;
    applyRole();
    await loadCfg();
    await loadEs(info.profile);
    status = decodeStatus(await req(OP.STATUS));
    restPos = status.pos;
    renderStatus();
    await req(OP.STREAM, new Uint8Array([1]));
    loadRemotes();
    loadCounters();
  } catch (e) {
    console.error(e);
  }
}

$('btn-connect').onclick = async () => {
  if (dev) { dev.disconnect(); return; }
  if (navigator.brave) { snack('Brave blokkeert Bluetooth voor websites. Open de app in Chrome (Android of pc).', null, null, 10000); return; }
  if (!navigator.bluetooth) { snack('Web Bluetooth werkt hier niet. Gebruik Chrome op Android of op de pc.'); return; }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      snack('Bluetooth is niet beschikbaar voor de browser. Zet Bluetooth aan en geef de browser toestemming voor apparaten in de buurt (Android: ook Locatie aan).', null, null, 10000);
      return;
    }
    snack('Kies de print (VLK-...). Open eerst het servicevenster: druk de servicetoets op de print in (2 piepjes).', null, null, 8000);
    dev = await new VlkDevice().connect();
    await onConnected();
  } catch (e) {
    dev = null;
    // alleen zelf annuleren in de keuzelijst stil laten; andere fouten altijd tonen
    if (e.name === 'NotFoundError' && /cancel/i.test(e.message)) return;
    if (e.name === 'NetworkError' || /connect|gatt/i.test(e.message)) {
      snack('Print reageert niet. Staat het servicevenster open? Druk de servicetoets op de print in (2 piepjes) en tik opnieuw op Verbinden.', null, null, 10000);
    } else {
      snack(`Verbinden mislukt: ${e.name}: ${e.message}`, null, null, 10000);
    }
  }
};
$('btn-demo').onclick = async () => { dev = new DemoDevice(); await onConnected(); };

// ------------------------------------------------------------------ status
function renderStatus() {
  if (!status) return;
  const s = status;
  const cards = $('cards');
  cards.innerHTML = '';
  const add = (k, v, sub, cls = '') => { const c = el('div', `card ${cls}`); c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub || ''}</div>`; cards.append(c); };
  const moving = s.dir !== 0;
  add('Positie', POS_NAMES[s.pos] || '?', moving ? `${(s.runMs / 1000).toFixed(1)} s` : `laatst: ${SRC_NAMES[s.lastSrc] || '-'}`);
  add('Motorstroom', moving ? `${s.ma} mA` : '-', `profiel: ${PROFILES[s.profile]}`);
  add('Accu', s.accu ? `${(s.accu / 1000).toFixed(2)} V` : 'geen', s.flags & FLAGS.ACCU_LOW ? 'te laag' : '', s.flags & FLAGS.ACCU_LOW ? 'err' : '');
  add('Temperatuur', s.ntc === -32768 ? '-' : `${(s.ntc / 10).toFixed(1)} °C`, `MCU ${s.die === -128 ? '-' : s.die + ' °C'}`);
  add('Regen', s.rain === 255 ? 'geen sensor' : s.rain === 2 ? 'sensor uit' : s.rain ? 'nat' : 'droog', s.flags & FLAGS.RAIN_EP ? 'episode actief' : '');
  const f = FAULTS.filter(([b]) => s.faults & b).map(([, n]) => n);
  add('Fouten', f.length ? f.length : 'geen', f.join(', '), f.length ? 'err' : 'ok');
  const flags = [['servicevenster', FLAGS.SERVICE], ['duurtest', FLAGS.DUURTEST], ['dodemans (DIP 4)', FLAGS.DEADMAN],
    ['koppelen', FLAGS.PAIR], ['eindtest', FLAGS.SELFTEST], ['simulatie', FLAGS.SIM]]
    .map(([n, b]) => `<span class="badge ${s.flags & b ? 'on' : ''}">${n}</span>`).join('');
  const c = el('div', 'card'); c.style.gridColumn = '1 / -1';
  c.innerHTML = `<div class="k">Stand</div><div class="s">${flags}</div><div class="s">DIP ${[0, 1, 2, 3].map((i) => (s.dip >> i) & 1).join(' ')}, inschakelduur ${s.duty}%, scanprofiel P${s.scan}, ${s.nrem} afstandsbediening(en), RSSI ${s.rssi} dBm, aan ${Math.floor(s.uptime / 60)} min</div>`;
  cards.append(c);
  if (s.flags & FLAGS.DEADMAN) $('hold-mode').checked = true;
  if (!duurBusy) $('duur-on').checked = !!(s.flags & FLAGS.DUURTEST);
}

// ------------------------------------------------------------------ grafiek en opnames
const chart = new Chart($('chart'));
const rpChart = new Chart($('rp-chart'));
$('win').onchange = () => { chart.windowMs = Number($('win').value); chart.draw(); };

function nowMs() { return performance.now() - sessionT0; }

function onSamples({ t0, ma }) {
  ma.forEach((v, i) => {
    const t = t0 + i * 5;
    if (run) run.samples.push([t, v]);
    chart.push(runOffset + t, v);
    wizOnSamples(t, v);
  });
  requestAnimationFrame(() => chart.draw());
}

function onMotor({ ev, arg }) {
  if (ev === 1) {
    runOffset = nowMs();
    const closing = arg === 1;
    run = { id: runSeq++, closing, profile: status?.profile ?? 0, samples: [], start: new Date(), result: null,
      full: closing ? restPos === 1 : restPos === 2 || restPos === 3, cal: !!wiz.expect?.calibrate };
    wiz.expect = null;
    updateThresholdLines(closing);
    chart.mark(runOffset, closing ? 'DICHT' : 'OPEN', '#1f8a4c');
  } else if (ev === 2 && run) {
    run.result = RESULT_NAMES[arg] || 'loopt';
    const last = run.samples.length ? run.samples[run.samples.length - 1][0] : 0;
    chart.mark(runOffset + last, RESULT_TEXT[run.result] || run.result, '#c53030');
    runs.unshift(run);
    wizOnRun(run);
    run = null;
    renderRuns();
    chart.draw();
  }
}

function runCsv(r) {
  return `# VLK opname ${r.start.toISOString()} ${r.closing ? 'dicht' : 'open'} profiel ${r.profile} uitkomst ${r.result} vol ${r.full ? 1 : 0}\n` +
    't_ms,ma\n' + r.samples.map(([t, v]) => `${t},${v}`).join('\n') + '\n';
}

function renderRuns() {
  const box = $('runs');
  box.innerHTML = '';
  if (!runs.length) { box.append(el('div', 'empty', 'Nog geen opnames. Bedien de motor om een curve op te nemen.')); }
  for (const r of runs) {
    const it = el('div', 'item');
    const dur = r.samples.length ? (r.samples[r.samples.length - 1][0] / 1000).toFixed(1) : '0';
    const peak = r.samples.filter(([t]) => t > 1500).reduce((m, s) => Math.max(m, s[1]), 0);
    it.innerHTML = `<div class="main"><div class="t">#${r.id} ${r.closing ? 'DICHT' : 'OPEN'}: ${RESULT_TEXT[r.result] || r.result}</div>
      <div class="d">${r.start.toLocaleTimeString('nl-NL')} - ${dur} s - max ${peak} mA na aanloop${r.cal ? ' - kalibratierit' : ''}</div></div>`;
    const play = el('button', 'ghost', ICON.play); play.title = 'Afspelen in Kalibratie';
    play.onclick = () => { showTab('calib'); $('rp-run').value = String(r.id); doReplay(); };
    const dl = el('button', 'ghost', ICON.download); dl.title = 'CSV opslaan';
    dl.onclick = () => download(`vlk_${info?.name || 'print'}_${stamp()}_${r.closing ? 'dicht' : 'open'}_${r.id}.csv`, runCsv(r), 'text/csv');
    const del = el('button', 'ghost', ICON.trash); del.title = 'Verwijderen';
    del.onclick = () => {
      const idx = runs.indexOf(r);
      runs.splice(idx, 1);
      renderRuns();
      snack(`Opname #${r.id} verwijderd`, 'Ongedaan maken', () => { runs.splice(idx, 0, r); renderRuns(); });
    };
    it.append(play, dl, del);
    box.append(it);
  }
  renderReplayRuns();
}

// ------------------------------------------------------------------ bediening
let holdTimer = null;
function motorButton(id, cmd) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => {
    if (!dev) return;
    if ($('hold-mode').checked && cmd !== CMD.STOP) {
      e.preventDefault();
      b.classList.add('active');
      b.setPointerCapture(e.pointerId);
      const send = () => req(OP.HOLD, new Uint8Array([cmd]), true).catch(() => {});
      send();
      holdTimer = setInterval(send, 250);
    }
  });
  const release = () => {
    if (holdTimer) {
      clearInterval(holdTimer); holdTimer = null; b.classList.remove('active');
      req(OP.CMD, new Uint8Array([CMD.STOP]), true).catch(() => {});
    }
  };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('click', () => { if (!$('hold-mode').checked || cmd === CMD.STOP) req(OP.CMD, new Uint8Array([cmd])).catch(() => {}); });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
motorButton('b-open', CMD.OPEN);
motorButton('b-stop', CMD.STOP);
motorButton('b-close', CMD.CLOSE);

// ------------------------------------------------------------------ kalibratie (eindherkenning)
// Idee: de installateur rijdt de koepel twee keer open en dicht, de app stelt per rit voor waar
// de eindstand was en vraagt alleen "was hij helemaal open/dicht?". Daaruit leert de app de
// loopstroom, de stijging aan het eind en de looptijd. Geen losse getallen invullen.
const activeProfile = () => status?.profile ?? info?.profile ?? 0;
const curParams = () => esEdit[activeProfile()] || esDefaults();
const isCal = (p) => !!(p.flags & ES_CALIBRATED) && p.run_ma[0] > 0 && p.run_ma[1] > 0;
const fmtS = (ds) => `${(ds / 10).toFixed(1).replace('.', ',')} s`;
const sameEs = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);

async function loadEs(profile) {
  const b = await req(OP.ES_GET, new Uint8Array([profile]));
  esDevice[profile] = decodeEs(b.slice(1));
  esEdit[profile] = structuredClone(esDevice[profile]);
  renderCal();
}

async function writeEs(profile, params) {
  const b = new Uint8Array(1 + ES_SIZE);
  b[0] = profile; b.set(encodeEs(params), 1);
  await req(OP.ES_SET, b);
  esDevice[profile] = structuredClone(params);
  esEdit[profile] = structuredClone(params);
  renderCal();
}

function renderCal() {
  const pr = activeProfile();
  const p = curParams();
  $('cal-profile-name').textContent = `Profiel: ${PROFILES[pr]} (DIP 1+2)`;
  const st = $('cal-state');
  if (isCal(p)) {
    st.className = 'calstate ok';
    st.innerHTML = `${ICON.test}<div><b>Gekalibreerd</b><div class="small-text">OPEN in ${fmtS(p.travel_ds[0])}, ${p.run_ma[0]} mA, eindstijging tot ${p.peak_ma[0]} mA<br>` +
      `DICHT in ${fmtS(p.travel_ds[1])}, ${p.run_ma[1]} mA, eindstijging tot ${p.peak_ma[1]} mA</div></div>`;
  } else {
    st.className = 'calstate warn';
    st.innerHTML = `${ICON.warn}<div><b>Nog niet gekalibreerd</b><div class="small-text">De print herkent de eindstand nu alleen aan het wegvallen van de stroom. Kalibreer na de montage, dan herkent hij ook obstakels en een te vroege stop.</div></div>`;
  }
  $('cal-start').innerHTML = btnHtml('calib', isCal(p) ? 'Opnieuw kalibreren' : 'Kalibratie starten');
  $('cal-wipe').hidden = !isCal(esDevice[pr] || esDefaults());
  $('cal-sens').value = String(p.sens || 3);
  $('cal-sens-v').textContent = String(p.sens || 3);
  $('cal-dirty').hidden = !esDevice[pr] || sameEs(esDevice[pr], p);
  $('cal-save').hidden = $('cal-dirty').hidden;
  updateThresholdLines();
}

function updateThresholdLines(closing = false) {
  const es = new Endstop(curParams(), closing);
  const lines = [
    { ma: es.offMa(), label: 'motor uit', cls: 'l-off', color: '#d68a1c' },
    { ma: es.blockMa(), label: 'blokkade', cls: 'l-block', color: '#8b1e1e' },
  ];
  chart.lines = lines;
  rpChart.lines = lines;
  $('legend').innerHTML = lines.map((l) => `<span><i class="${l.cls}"></i>${l.label} ${l.ma} mA</span>`).join('');
  chart.draw();
  rpChart.draw();
}

$('cal-sens').oninput = () => {
  const pr = activeProfile();
  esEdit[pr] = { ...curParams(), sens: Number($('cal-sens').value) };
  renderCal();
  if ($('rp-run').value) doReplay(true);
};
$('cal-save').onclick = async () => {
  const pr = activeProfile();
  const prev = structuredClone(esDevice[pr]);
  await writeEs(pr, curParams());
  snack('Opgeslagen op de print', 'Ongedaan maken', () => writeEs(pr, prev).then(() => snack('Vorige waarden teruggezet')));
};
$('cal-wipe').onclick = async () => {
  const pr = activeProfile();
  const prev = structuredClone(esDevice[pr]);
  await req(OP.ES_RESET, new Uint8Array([pr]));
  await loadEs(pr);
  snack('Kalibratie gewist', 'Ongedaan maken', () => writeEs(pr, prev).then(() => snack('Kalibratie teruggezet')));
};
$('cal-export').onclick = () => {
  download(`vlk_kalibratie_${info?.name || 'print'}_${stamp()}.json`,
    JSON.stringify({ soort: 'vlk-kalibratie', versie: 2, profile: activeProfile(), params: curParams(), device: info?.name, fw: info?.fw }, null, 1), 'application/json');
};
$('cal-import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const q = j.params;
    const okArr = (a) => Array.isArray(a) && a.length === 2 && a.every((v) => Number.isInteger(v) && v >= 0 && v <= 65535);
    if (j.soort !== 'vlk-kalibratie' || !q || !okArr(q.run_ma) || !okArr(q.peak_ma) || !okArr(q.travel_ds) || !(q.sens >= 1 && q.sens <= 5)) {
      throw new Error('geen geldig kalibratiebestand');
    }
    const pr = activeProfile();
    const prev = esEdit[pr];
    esEdit[pr] = { run_ma: q.run_ma, peak_ma: q.peak_ma, travel_ds: q.travel_ds, sens: q.sens, flags: q.flags & ES_CALIBRATED };
    renderCal();
    snack('Kalibratie ingelezen, nog niet opgeslagen', 'Ongedaan maken', () => { esEdit[pr] = prev; renderCal(); });
  } catch (err) { snack(`Inlezen mislukt: ${err.message}`); }
};

// ---- wizard
const WIZ = [
  { prep: true, closing: true, title: 'Begin dicht' },
  { closing: false, title: 'OPEN 1' }, { closing: true, title: 'DICHT 1' },
  { closing: false, title: 'OPEN 2' }, { closing: true, title: 'DICHT 2' },
];
const wiz = { on: false, step: 0, phase: 'ready', runs: [], cand: null, endMs: 0, learned: null };
const wizChart = new Chart($('wiz-chart'));
wizChart.onPick = (t) => {
  if (wiz.phase !== 'confirm' || !wiz.cand) return;
  wiz.endMs = Math.max(1600, Math.min(t, wiz.cand.samples.at(-1)?.[0] ?? t));
  drawWizRun();
};

function wizBtn(icon, text, cls, fn) {
  const b = el('button', cls, btnHtml(icon, text));
  b.onclick = fn;
  $('wiz-actions').append(b);
  return b;
}
const dirWord = (closing) => (closing ? 'dicht' : 'open');

function drawWizRun() {
  const r = wiz.cand;
  wizChart.clear();
  const end = r.samples.at(-1)?.[0] ?? 1000;
  wizChart.windowMs = Math.max(5000, Math.ceil(end / 1000) * 1000 + 1000);
  wizChart.follow = false;
  wizChart.viewEnd = wizChart.windowMs;
  r.samples.forEach(([t, v]) => wizChart.push(t, v));
  if (wiz.phase === 'confirm') wizChart.mark(wiz.endMs, `eindstand ${(wiz.endMs / 1000).toFixed(1)} s`, '#c53030');
  wizChart.draw();
}

function renderWiz() {
  $('wiz').hidden = !wiz.on;
  $('cal-start').disabled = wiz.on || !dev;
  if (!wiz.on) return;
  const s = WIZ[wiz.step];
  $('wiz-steps').innerHTML = WIZ.map((w, i) => `<li class="${i < wiz.step ? 'done' : i === wiz.step ? 'cur' : ''}">${w.title}</li>`).join('') +
    `<li class="${wiz.phase === 'done' ? 'cur' : ''}">Opslaan</li>`;
  $('wiz-actions').innerHTML = '';
  const showChart = ['running', 'confirm'].includes(wiz.phase);
  $('wiz-chart').hidden = !showChart;
  $('wiz-hint').hidden = wiz.phase !== 'confirm';
  const t = $('wiz-text');
  const cmd = s?.closing ? CMD.CLOSE : CMD.OPEN;
  switch (wiz.phase) {
    case 'ready':
      if (s.prep) {
        t.innerHTML = 'Zet de koepel eerst <b>helemaal dicht</b> met de knop hieronder. Staat hij al dicht, tik dan op <b>Staat dicht</b>.';
        wizBtn('close', 'DICHT', 'primary', () => wizRun(CMD.CLOSE, false));
        wizBtn('test', 'Staat dicht', 'ghost', () => { wiz.step++; renderWiz(); });
      } else {
        t.innerHTML = `Tik op <b>${s.closing ? 'DICHT' : 'OPEN'}</b> en laat de motor helemaal uitlopen tot hij zelf stopt. Blijf bij de koepel; bij gevaar tik je op STOP.`;
        wizBtn(s.closing ? 'close' : 'open', s.closing ? 'DICHT' : 'OPEN', 'primary', () => wizRun(cmd, true));
      }
      break;
    case 'running':
      t.innerHTML = 'Motor loopt. Wachten tot hij zelf stopt...';
      wizBtn('stop', 'STOP', 'danger', () => req(OP.CMD, new Uint8Array([CMD.STOP])).catch(() => {}));
      break;
    case 'confirm': {
      const r = wiz.cand;
      const warn = ['blokkade', 'max_tijd'].includes(r.result) ? `<br><span class="bad">De print meldde: ${RESULT_TEXT[r.result]}.</span>` : '';
      t.innerHTML = `Is de koepel nu <b>helemaal ${dirWord(r.closing)}</b>?${warn}`;
      wizBtn('test', `Ja, helemaal ${dirWord(r.closing)}`, 'primary', () => {
        wiz.runs.push({ closing: r.closing, samples: r.samples, endMs: wiz.endMs });
        wiz.cand = null;
        wiz.step++;
        wiz.phase = wiz.step >= WIZ.length ? 'done' : 'ready';
        if (wiz.phase === 'done') wizLearn();
        renderWiz();
      });
      wizBtn('x', 'Nee', 'ghost', () => { wiz.cand = null; wiz.phase = 'redo'; renderWiz(); });
      drawWizRun();
      break;
    }
    case 'redo':
      t.innerHTML = `Deze rit telt niet mee. Zet de koepel met de knoppen hieronder weer <b>helemaal ${dirWord(!s.closing)}</b> en tik dan op <b>Opnieuw</b>. ` +
        'Stopt de motor steeds te vroeg, kijk dan of er iets klemt.';
      wizBtn('open', 'OPEN', 'ghost', () => req(OP.CMD, new Uint8Array([CMD.OPEN])).catch(() => {}));
      wizBtn('close', 'DICHT', 'ghost', () => req(OP.CMD, new Uint8Array([CMD.CLOSE])).catch(() => {}));
      wizBtn('reset', 'Opnieuw', 'primary', () => { wiz.phase = 'ready'; renderWiz(); });
      break;
    case 'done': {
      const p = wiz.learned;
      const checks = wiz.runs.map((r) => replay(r.samples, p, r.closing, { full: true }).result);
      const good = checks.filter((c) => RESULT_OK.includes(c)).length;
      const ok = good === checks.length;
      t.innerHTML = `<b>Geleerd</b><br>OPEN: ${fmtS(p.travel_ds[0])}, loopstroom ${p.run_ma[0]} mA, eindstijging tot ${p.peak_ma[0]} mA<br>` +
        `DICHT: ${fmtS(p.travel_ds[1])}, loopstroom ${p.run_ma[1]} mA, eindstijging tot ${p.peak_ma[1]} mA<br>` +
        `<span class="${ok ? 'ok' : 'bad'}">Controle: ${good} van ${checks.length} ritten herkend als eindstand${ok ? '' : '. Zet de gevoeligheid lager of kalibreer opnieuw.'}</span>`;
      wizBtn('save', 'Opslaan op print', 'primary', async () => {
        const pr = activeProfile();
        const prev = structuredClone(esDevice[pr] || esDefaults());
        await writeEs(pr, p);
        wiz.on = false;
        renderWiz();
        snack('Kalibratie opgeslagen', 'Ongedaan maken', () => writeEs(pr, prev).then(() => snack('Vorige kalibratie teruggezet')), 8000);
      });
      wizBtn('reset', 'Opnieuw', 'ghost', () => wizStart());
      break;
    }
    default: break;
  }
}

function wizLearn() {
  wiz.learned = learn(wiz.runs, curParams().sens || 3);
}

async function wizRun(cmd, calibrate) {
  wiz.expect = { calibrate };
  wiz.phase = 'running';
  wizChart.clear();
  wizChart.follow = true;
  wizChart.windowMs = 30000;
  renderWiz();
  try {
    await req(OP.CMD, new Uint8Array([cmd, calibrate ? 1 : 0]));
  } catch { wiz.phase = 'ready'; renderWiz(); }
}

function wizOnSamples(t, v) { if (wiz.on && wiz.phase === 'running') wizChart.push(t, v); }

function wizOnRun(r) {
  if (!wiz.on || wiz.phase !== 'running') return;
  const s = WIZ[wiz.step];
  if (s.prep) {
    // voorbereiding: alleen dicht zetten, de rit telt niet mee
    wiz.phase = 'ready';
    if (RESULT_OK.includes(r.result) || r.result === 'eind_zonder_piek' || r.result === 'al_in_eindstand') wiz.step++;
    else snack(`Niet in de eindstand gekomen (${RESULT_TEXT[r.result] || r.result}). Probeer opnieuw.`);
    renderWiz();
    return;
  }
  if (r.closing !== s.closing || !r.cal) { wiz.phase = 'ready'; renderWiz(); return; }
  wiz.cand = r;
  wiz.endMs = suggestEnd(r.samples);
  wiz.phase = 'confirm';
  renderWiz();
}

function wizStart() {
  Object.assign(wiz, { on: true, step: status?.pos === 2 ? 1 : 0, phase: 'ready', runs: [], cand: null, learned: null });
  renderWiz();
  $('wiz').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('cal-start').onclick = () => wizStart();
$('wiz-cancel').innerHTML = btnHtml('x', 'Stoppen');
$('wiz-cancel').onclick = () => { wiz.on = false; renderWiz(); snack('Kalibratie gestopt; er is niets gewijzigd'); };

// ---- afspelen
const imported = [];
function renderReplayRuns() {
  const sel = $('rp-run');
  const v = sel.value;
  sel.innerHTML = '<option value="">Kies een opname</option>';
  for (const r of [...imported, ...runs]) {
    const o = el('option');
    o.value = String(r.id);
    o.textContent = `#${r.id} ${r.closing ? 'DICHT' : 'OPEN'} ${r.name ? `(${r.name})` : r.start.toLocaleTimeString('nl-NL')} - ${RESULT_TEXT[r.result] || r.result || '?'}`;
    sel.append(o);
  }
  sel.value = v;
}
$('rp-csv').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 20e6) { snack('Bestand is te groot'); return; }
  const txt = await f.text();
  const samples = txt.split('\n').map((l) => l.split(',').map(Number)).filter((r) => r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  const head = txt.split('\n')[0];
  const closing = /dicht/i.test(head) || /dicht/i.test(f.name);
  const m = head.match(/uitkomst (\w+)/);
  const r = { id: `csv${imported.length + 1}`, name: f.name, closing, full: !/vol 0/.test(head), samples, start: new Date(), result: m ? m[1] : null };
  imported.unshift(r);
  renderReplayRuns();
  $('rp-run').value = String(r.id);
  doReplay();
};
$('rp-go').onclick = () => doReplay();

function doReplay(quiet) {
  const id = $('rp-run').value;
  const r = [...imported, ...runs].find((x) => String(x.id) === id);
  if (!r) { if (!quiet) snack('Kies eerst een opname'); return; }
  const params = curParams();
  const res = replay(r.samples, params, r.closing, { full: r.full !== false });
  updateThresholdLines(r.closing);
  rpChart.clear();
  const end = r.samples.length ? r.samples.at(-1)[0] : 30000;
  rpChart.windowMs = Math.max(5000, Math.ceil(end / 1000) * 1000 + 1000);
  rpChart.follow = false;
  rpChart.viewEnd = rpChart.windowMs;
  r.samples.forEach(([t, v]) => rpChart.push(t, v));
  rpChart.mark(1500, 'aanloop', '#888');
  const c = r.closing ? 1 : 0;
  if (isCal(params)) rpChart.mark(params.travel_ds[c] * 100, 'verwacht eind', '#1f8a4c');
  if (res.t_ms) rpChart.mark(res.t_ms, RESULT_TEXT[res.result], '#c53030');
  rpChart.draw();
  const same = !r.result || r.result === res.result;
  const out = $('rp-result');
  out.textContent = '';
  out.append('Met deze kalibratie: ');
  const b = el('b', RESULT_OK.includes(res.result) ? 'ok' : 'bad');
  b.textContent = RESULT_TEXT[res.result];
  out.append(b, `${res.t_ms ? ` na ${(res.t_ms / 1000).toFixed(1)} s` : ''}, loopstroom ${res.run_ma} mA, stijging aan het eind tot ${res.end_peak_ma} mA.`);
  if (r.result) {
    out.append(` De print deed: ${RESULT_TEXT[r.result] || r.result}`);
    if (!same) { const d = el('b', 'bad'); d.textContent = ' (anders)'; out.append(d); }
    out.append('.');
  }
}

// ------------------------------------------------------------------ instellingen
const CFG_UI = [
  ['accu_type', 'Accutype', 'select', [[0, 'Loodaccu (AGM/gel)'], [1, 'LiFePO4']], 'Wijzigen vult de voorgestelde drempels in.'],
  ['accu_block_mv', 'Accu: DICHT en OPEN blokkeren onder (mV)', 'number', null, 'In rust gemeten, min. 30 s na een beweging.'],
  ['accu_release_mv', 'Accu: OPEN weer vrij vanaf (mV)', 'number'],
  ['rain_present', 'Regensensor aanwezig', 'select', [[1, 'ja'], [0, 'nee']]],
  ['aux24_in_use', '24 V-uitgang in gebruik', 'select', [[0, 'nee'], [1, 'ja']], 'DIP 3 bepaalt de 12 V-uitgang.'],
  ['autoclose_deadman', 'Automatisch sluiten met DIP 4 (dodemans)', 'select', [[0, 'uit'], [1, 'aan, 5 s waarschuwing']], 'Open punt Heruvent.'],
  ['deadman_timeout_ms', 'Dodemans: stop na (ms) zonder signaal', 'number', null, '500 tot 3000; knop zendt elke 250 ms.'],
  ['confirm_retry_s', 'Onbevestigd dicht: nogmaals DICHT na (s)', 'number', null, '0 = uit.'],
  ['rain_heat_s', 'Regensensor: verwarmen na openen bij nat (s)', 'number', null, 'Nog nat daarna = bewust open bij regen: sensor uit. 0 = sensor blijft aan.'],
  ['rain_recheck_min', 'Regensensor: daarna opnieuw kijken elke (min)', 'number', null, '0 = pas bij de volgende OPEN. Zuinig: sensor is tussendoor uit.'],
  ['rain_check_s', 'Regensensor: per controle max. verwarmen (s)', 'number', null, 'Droog = weer bewaken, nog nat = weer uit.'],
  ['rain_dry_interval_s', 'Regensensor: bij droog meten elke (s)', 'number', null, 'Sensor kort aan (ca. 5 s), daartussen uit. 0 = continu aan (direct sluiten, ca. 0,9 mA).'],
  ['duty_max_s', 'Inschakelduur: max. aan (s)', 'number', null, 'KSA S12: 180 s per 600 s.'],
  ['duty_window_s', 'Inschakelduur: venster (s)', 'number'],
  ['reverse_pause_ms', 'Pauze bij omkeren (ms)', 'number'],
  ['idle_scan_profile', 'Luisteren in rust', 'select', [[0, 'P0 100% (ca. 0,9 mA)'], [1, 'P1 50%'], [2, 'P2 25%'], [3, 'P3 10% (ca. 0,09 mA)'], [4, 'P4 5%']]],
  ['temp_max_c', 'MCU-temperatuur: geen motoractie boven (°C)', 'number'],
];
const ACCU_PRESET = { 0: [11900, 12400], 1: [12600, 13000] };

function renderCfg() {
  const f = $('cfg-form');
  f.innerHTML = '';
  if (!cfg) return;
  for (const [k, label, type, opts, help] of CFG_UI) {
    const l = el('label', '', `${label}${help ? `<small>${help}</small>` : ''}`);
    let inp;
    if (type === 'select') {
      inp = el('select');
      for (const [v, t] of opts) { const o = el('option'); o.value = v; o.textContent = t; inp.append(o); }
    } else { inp = el('input'); inp.type = 'number'; inp.min = 0; }
    inp.value = cfg[k];
    inp.dataset.key = k;
    if (k === 'accu_type') {
      inp.onchange = () => {
        const [a, b] = ACCU_PRESET[inp.value];
        f.querySelector('[data-key=accu_block_mv]').value = a;
        f.querySelector('[data-key=accu_release_mv]').value = b;
      };
    }
    l.append(inp);
    f.append(l);
  }
  $('duur-int').value = cfg.duurtest_interval_s;
}

async function loadCfg() { cfg = decodeCfg(await req(OP.CFG_GET)); renderCfg(); }
$('cfg-reload').onclick = () => loadCfg().then(() => snack('Instellingen geladen'));
$('cfg-save').onclick = async () => {
  const c = { ...cfg };
  $('cfg-form').querySelectorAll('[data-key]').forEach((i) => { c[i.dataset.key] = Number(i.value); });
  if (c.accu_release_mv <= c.accu_block_mv) { snack('Vrijgeven moet hoger zijn dan blokkeren'); return; }
  if (c.deadman_timeout_ms < 500 || c.deadman_timeout_ms > 3000) { snack('Dodemans-tijd moet tussen 500 en 3000 ms liggen'); return; }
  const prev = cfg;
  await req(OP.CFG_SET, encodeCfg(c));
  cfg = c;
  snack('Instellingen opgeslagen', 'Ongedaan maken', async () => { await req(OP.CFG_SET, encodeCfg(prev)); cfg = prev; renderCfg(); snack('Vorige instellingen teruggezet'); });
};
$('pin-save').onclick = async () => {
  const v = $('pin').value.trim();
  if (v && !/^[1-9]\d{5}$/.test(v)) { snack('Pincode: 6 cijfers, niet met 0 beginnen'); return; }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v ? Number(v) : 0, true);
  await req(OP.SET_PIN, b);
  $('pin').value = '';
  snack(v ? 'Pincode ingesteld; geldt bij de volgende koppeling' : 'Pincode van het label hersteld');
};
$('sim-apply').onclick = async () => {
  const send = (what, v) => { const b = new Uint8Array(3); b[0] = what; new DataView(b.buffer).setUint16(1, v, true); return req(OP.SIM, b); };
  await send(1, Number($('sim-rain').value));
  await send(2, Number($('sim-accu').value));
  // positie alleen als hij is ingevuld: anders zet elke Toepassen de gesimuleerde koepel op 0 %
  // terwijl de besturing denkt dat hij open is (dicht rijden geeft dan 'geen motorstroom')
  if ($('sim-pos').value !== '') { await send(3, Number($('sim-pos').value)); $('sim-pos').value = ''; }
  await send(4, Number($('sim-block').value));
  if (simDipDirty) {
    const dip = [1, 2, 3, 4].reduce((a, n, i) => a | ($(`sim-dip${n}`).checked ? 1 << i : 0), 0);
    await send(5, dip);
    simDipDirty = false;
  }
  snack('Simulatie bijgewerkt');
};
let simDipDirty = false;
[1, 2, 3, 4].forEach((n) => { $(`sim-dip${n}`).onchange = () => { simDipDirty = true; }; });
function syncSimDip() {
  if (simDipDirty || !status) return;
  [1, 2, 3, 4].forEach((n, i) => { $(`sim-dip${n}`).checked = !!(status.dip & (1 << i)); });
}
$('clear-faults').onclick = async () => { await req(OP.CLEAR_FAULTS); snack('Fouten gewist'); };
$('reboot').onclick = async () => { if (await confirmDlg('Print herstarten?', 'Herstarten')) req(OP.REBOOT).catch(() => {}); };

// ------------------------------------------------------------------ afstandsbedieningen
let pendingDelete = null;
async function loadRemotes() {
  const b = await req(OP.REM_LIST);
  const list = [];
  for (let o = 0; o + 9 <= b.length; o += 9) {
    list.push({ idx: b[o], mac: [...b.slice(o + 2, o + 8)].reverse().map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':'), key: !!b[o + 8] });
  }
  renderRemotes(list);
  return list;
}
function renderRemotes(list) {
  const box = $('rem-list');
  box.innerHTML = '';
  const shown = list.filter((r) => !(pendingDelete && pendingDelete.idx === r.idx));
  if (!shown.length) box.append(el('div', 'empty', 'Geen afstandsbedieningen gekoppeld.'));
  for (const r of shown) {
    const it = el('div', 'item');
    it.innerHTML = `${ICON.remote}<div class="main"><div class="t">${r.mac}</div><div class="d">plaats ${r.idx}, ${r.key ? 'versleuteld' : 'onversleuteld'}</div></div>`;
    const del = el('button', 'ghost', ICON.trash);
    del.title = 'Ontkoppelen';
    del.onclick = () => {
      if (pendingDelete) commitDelete();
      pendingDelete = r;
      renderRemotes(list);
      snack.onTimeout = commitDelete;
      snack(`${r.mac} ontkoppeld`, 'Ongedaan maken', () => { pendingDelete = null; snack.onTimeout = null; renderRemotes(list); });
    };
    it.append(del);
    box.append(it);
  }
}
async function commitDelete() {
  const r = pendingDelete;
  pendingDelete = null;
  if (r) { await req(OP.REM_DEL, new Uint8Array([r.idx])).catch(() => {}); loadRemotes(); }
}
$('rem-refresh').onclick = () => loadRemotes();
$('rem-pair').onclick = async () => { await req(OP.PAIR, new Uint8Array([30])); snack('Koppelmodus 30 s: druk een knop op de afstandsbediening'); };
$('rem-clear').onclick = async () => {
  if (await confirmDlg('Alle afstandsbedieningen en de gateway ontkoppelen?', 'Alles wissen')) {
    await req(OP.REM_CLEAR); loadRemotes(); snack('Alle koppelingen gewist');
  }
};
$('rem-gen').onclick = () => {
  const k = hex(crypto.getRandomValues(new Uint8Array(16)));
  $('rem-key').value = k;
  const line = $('gw-line');
  line.hidden = false;
  line.textContent = `let KEY = "${k}";`;
  navigator.clipboard?.writeText(`let KEY = "${k}";`).then(() => snack('Regel voor het gatewayscript gekopieerd'));
};
async function pairWithKey(keyHex) {
  const key = unhex(keyHex);
  if (key.length !== 16) throw new Error('sleutel moet 16 bytes (32 hex-tekens) zijn');
  const b = new Uint8Array(17);
  b[0] = 60; b.set(key, 1);
  await req(OP.PAIR, b);
  snack('Koppelmodus 60 s: druk nu een knop op de afstandsbediening (of de virtuele knop in de Shelly-app)', null, null, 10000);
  setTimeout(() => loadRemotes(), 8000);
}
async function showStatusKey(fresh) {
  if (fresh && !(await confirmDlg('Nieuwe statussleutel maken? De gateway kan de status pas weer lezen als hij de nieuwe sleutel heeft.', 'Nieuwe sleutel'))) return;
  const k = await req(OP.STATUS_KEY, new Uint8Array([fresh ? 1 : 0]));
  if (k.length !== 16) { snack('Deze print heeft geen statussleutel'); return; }
  const key = hex(k);
  $('skey-line').hidden = false;
  $('skey-line').textContent = key;
  navigator.clipboard?.writeText(key).then(() => snack('Sleutel gekopieerd')).catch(() => {});
}
$('skey-show').onclick = () => showStatusKey(false);
$('skey-new').onclick = () => showStatusKey(true);
$('rem-pair-key').onclick = () => pairWithKey($('rem-key').value).catch((e) => snack(e.message));

const SHELLY_SVC = 'de8a5aac-a99b-c315-0c80-60d4cbb51225';
const SHELLY_KEY = 'eb0fb41b-af4b-4724-a6f9-974f55aba81a';
const SHELLY_PASSKEY = '0ffb7104-860c-49ae-8989-1f946d5f6c03';

// Afstandsbediening koppelen in 3 stappen, zonder Shelly-app: de app zet zelf de versleuteling
// op de knop (nieuwe pincode, Shelly BLE-documentatie: Passkey-karakteristiek), leest de sleutel
// en zet de print 60 s in koppelmodus met die sleutel. De tester drukt daarna één knop.
const ab = { step: 0, msg: '', pin: '', err: '' };
async function abReadKey() {
  if (dev?.demo) { await new Promise((r) => setTimeout(r, 1200)); ab.pin = '123456'; return crypto.getRandomValues(new Uint8Array(16)); }
  const btn = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'SBBT' }], optionalServices: [SHELLY_SVC] });
  try {
    abMsg('Verbinden met de knop...');
    let srv = await btn.gatt.connect();
    let svc = await srv.getPrimaryService(SHELLY_SVC);
    // nieuwe pincode = nieuwe sleutel (zet versleuteling aan, ook als hij al aan stond)
    const pin = 100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
    const p = new Uint8Array(4);
    new DataView(p.buffer).setUint32(0, pin, true);
    abMsg('Versleuteling instellen... Vraagt je telefoon om te koppelen? Tik dan op Koppelen.');
    await (await svc.getCharacteristic(SHELLY_PASSKEY)).writeValueWithResponse(p);
    ab.pin = String(pin);
    await new Promise((r) => setTimeout(r, 1500));   // knop maakt de nieuwe sleutel
    abMsg('Sleutel ophalen...');
    let key;
    for (let i = 0; i < 3 && !key; i++) {
      try {
        if (!btn.gatt.connected) { srv = await btn.gatt.connect(); svc = await srv.getPrimaryService(SHELLY_SVC); }
        key = new Uint8Array((await (await svc.getCharacteristic(SHELLY_KEY)).readValue()).buffer);
      } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    return key;
  } finally {
    btn.gatt.disconnect();
  }
}
function abMsg(t) { ab.msg = t; renderAb(); }
function renderAb() {
  const root = $('ab-root');
  if (!root) return;
  root.innerHTML = '';
  const steps = ['Knop in koppelmodus', 'Knop beveiligen', 'Eén keer drukken'];
  const head = el('div', 'ab-steps');
  steps.forEach((t, i) => head.append(el('div', `ab-step ${ab.step === i + 1 ? 'on' : ab.step > i + 1 ? 'done' : ''}`, `<b>${i + 1}</b><span>${t}</span>`)));
  if (ab.step > 0 && ab.step < 4) root.append(head);
  const body = el('div', 'wz-text');
  const row = el('div', 'row wrap wz-btns');
  const mk = (cls, icon, text, fn) => { const b = el('button', cls, `${ICON[icon] || ''}<span>${text}</span>`); b.onclick = fn; b.disabled = !dev; row.append(b); return b; };
  if (ab.step === 0) {
    body.innerHTML = `<p>Koppel een Shelly BLU RC Button 4 (ZB) in drie stappen met deze app.</p>
      <p class="muted small-text">Zonder app (firmware 0.3.5 of nieuwer): druk op de servicetoets, druk dan 4x kort op de knop (blauw knipperen) en houd hem bij de print. De print piept 1x lang: druk dan 1x op een knop. 2 piepjes = gekoppeld, 3 korte = mislukt.</p>`;
    mk('primary big', 'plus', 'Koppelen starten', () => { ab.step = 1; ab.err = ''; renderAb(); });
  } else if (ab.step === 1) {
    body.innerHTML = '<p>Druk <b>4x kort</b> op een knop van de afstandsbediening.</p><p>Het lampje gaat <b>blauw knipperen</b> (1 minuut).</p><p class="muted small-text">Oudere RC Button 4 (zonder ZB): een knop 10 s vasthouden.</p>';
    mk('primary big', 'check', 'Hij knippert blauw', () => { ab.step = 2; ab.msg = ''; renderAb(); });
  } else if (ab.step === 2) {
    body.innerHTML = `<p>Tik op <b>Knop zoeken</b> en kies de knop in de lijst (naam begint met <b>SBBT</b>).</p>
      <p class="muted small-text">De knop krijgt een nieuwe sleutel. Zat hij ook in de Shelly-app of aan een gateway, koppel hem daar daarna opnieuw.</p>
      ${ab.msg ? `<p><b>${ab.msg}</b></p>` : ''}${ab.err ? `<p class="err-text">${ab.err}</p>` : ''}`;
    const b = mk('primary big', 'bt', 'Knop zoeken', async () => {
      b.disabled = true; ab.err = '';
      try {
        const key = await abReadKey();
        if (!key || key.length !== 16) throw new Error('geen geldige sleutel ontvangen');
        abMsg('Print in koppelmodus zetten...');
        const before = (await loadRemotes()).length;
        const p = new Uint8Array(17); p[0] = 60; p.set(key, 1);
        await req(OP.PAIR, p);
        ab.before = before; ab.until = Date.now() + 60000; ab.step = 3; ab.msg = '';
        renderAb();
        abWait();
      } catch (e) {
        ab.msg = '';
        ab.err = e.name === 'NotFoundError' ? (/cancel/i.test(e.message) ? '' : 'Geen knop gevonden. Knippert hij nog blauw? Anders weer 4x drukken.')
          : `Niet gelukt: ${e.message}. Druk de knop weer 4x en probeer opnieuw.`;
        renderAb();
      }
    });
    mk('ghost', 'back', 'Terug', () => { ab.step = 1; renderAb(); });
  } else if (ab.step === 3) {
    const left = Math.max(0, Math.round((ab.until - Date.now()) / 1000));
    body.innerHTML = `<p>Druk nu <b>één keer</b> op een knop van de afstandsbediening.</p>
      <p class="muted">De print piept 2x als hij gekoppeld is. Nog ${left} s.</p>`;
    mk('ghost', 'x', 'Stoppen', () => { ab.step = 0; renderAb(); });
  } else if (ab.step === 4) {
    body.innerHTML = `<div class="wz-result good"><h3>Gekoppeld</h3><p class="muted">Knop 1 OPEN, 2 DICHT, 3 STOP, 4 reserve.</p></div>
      <p class="muted small-text">Pincode van deze knop: <b>${ab.pin}</b> (alleen nodig als je hem ook in de Shelly-app wilt gebruiken).</p>`;
    mk('primary', 'plus', 'Nog een koppelen', () => { ab.step = 1; ab.err = ''; renderAb(); });
    mk('ghost', 'check', 'Klaar', () => { ab.step = 0; renderAb(); });
  } else if (ab.step === 5) {
    body.innerHTML = '<div class="wz-result bad"><h3>Niet gekoppeld</h3><p class="muted">Binnen 60 s kwam er geen knopdruk binnen.</p></div>';
    mk('primary', 'reset', 'Opnieuw', () => { ab.step = 1; renderAb(); });
  }
  root.append(body, row);
}
async function abWait() {
  while (ab.step === 3) {
    await new Promise((r) => setTimeout(r, 1000));
    if (ab.step !== 3) return;
    if (dev?.demo && Date.now() > ab.until - 55000) { ab.step = 4; renderAb(); return; }
    try {
      const list = await loadRemotes();
      if (list.length > ab.before) { ab.step = 4; renderAb(); return; }
    } catch { /* volgende keer */ }
    if (Date.now() > ab.until) { ab.step = 5; renderAb(); return; }
    renderAb();
  }
}
renderAb();

// ------------------------------------------------------------------ Shelly-gateway instellen
// Stap voor stap: gateway klaarzetten, status (BTHome met adres en statussleutel), virtuele
// knoppen, script met sleutel kopieren, koppelen. De sleutel blijft alleen in deze wizard.
const gw = { step: 0, key: '', skey: '', msg: '' };
function copyText(text, what) {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(() => snack(`${what} gekopieerd`)).catch(() => snack('Kopiëren lukt niet; selecteer de tekst'));
}
function codeRow(label, text, what) {
  const r = el('div', 'gw-copy');
  r.innerHTML = `<div class="k small-text muted">${label}</div><div class="code">${text || '-'}</div>`;
  const b = el('button', 'ghost small', `${ICON.copy || ''}<span>Kopiëren</span>`);
  b.onclick = () => copyText(text, what);
  b.disabled = !text;
  r.append(b);
  return r;
}
function renderGw() {
  const root = $('gw-root');
  if (!root) return;
  root.innerHTML = '';
  const steps = ['Gateway', 'Status', 'Knoppen', 'Script', 'Koppelen'];
  if (gw.step > 0 && gw.step < 6) {
    const head = el('div', 'ab-steps');
    steps.forEach((t, i) => head.append(el('div', `ab-step ${gw.step === i + 1 ? 'on' : gw.step > i + 1 ? 'done' : ''}`, `<b>${i + 1}</b><span>${t}</span>`)));
    root.append(head);
  }
  const body = el('div', 'wz-text');
  const row = el('div', 'row wrap wz-btns');
  const mk = (cls, icon, text, fn) => { const b = el('button', cls, `${ICON[icon] || ''}<span>${text}</span>`); b.onclick = fn; b.disabled = !dev; row.append(b); return b; };
  const next = () => { gw.step++; renderGw(); };
  const back = () => { gw.step--; renderGw(); };
  if (gw.step === 0) {
    body.innerHTML = `<p>Status en bediening via een Shelly BLU Gateway Gen3, in vijf stappen.</p>
      <p class="muted small-text">Je hebt de <b>webinterface van de gateway</b> nodig: een browser op hetzelfde wifi-netwerk, met het IP-adres van de gateway (Shelly-app of router). "Add device" in de Shelly-app vindt de print niet.</p>`;
    mk('primary big', 'plus', 'Starten', async () => {
      gw.key = hex(crypto.getRandomValues(new Uint8Array(16)));
      gw.skey = '';
      try { const k = await req(OP.STATUS_KEY, new Uint8Array([0])); gw.skey = k.length === 16 ? hex(k) : ''; } catch { /* melding via req */ }
      gw.step = 1; renderGw();
    });
  } else if (gw.step === 1) {
    body.innerHTML = `<p>In de <b>Shelly-app</b>: gateway toevoegen en wifi instellen, firmware bijwerken.</p>
      <p>In de <b>webinterface</b> van de gateway:</p>
      <ul><li>Settings: een <b>wachtwoord</b> instellen (wie bij de gateway kan, kan de koepel bedienen)</li>
      <li>Settings, Bluetooth: <b>Enable Bluetooth</b> en <b>Enable Bluetooth gateway</b> aan</li></ul>`;
    mk('primary', 'check', 'Gedaan', next);
    mk('ghost', 'x', 'Stoppen', () => { gw.step = 0; renderGw(); });
  } else if (gw.step === 2) {
    body.innerHTML = `<p>Webinterface: <b>Components</b>, Bluetooth (BTHome) devices, <b>+</b>, <b>Add a device by MAC address</b>. Plak het adres en kies <b>Add</b> (geen model nodig).</p>
      <p>Open het nieuwe apparaat (tandwiel) en plak de statussleutel bij <b>Decryption key</b>. Save.</p>
      <p class="muted small-text">Binnen een minuut verschijnen Temperature, Voltage, Opening en Moisture_status. Zet ze met <b>Create new group</b> in een groep, bijv. "Vlakkelichtkoepel".${info?.mac ? '' : ' Deze firmware geeft het adres nog niet door: het staat in het opstartlog als "Identity".'}</p>`;
    body.append(codeRow('Bluetooth-adres van de print', info?.mac || '', 'Adres'));
    body.append(codeRow('Statussleutel (Decryption key)', gw.skey, 'Statussleutel'));
    mk('primary', 'check', 'Gedaan', next);
    mk('ghost', 'back', 'Terug', back);
  } else if (gw.step === 3) {
    body.innerHTML = `<p>Webinterface: <b>Components</b>, User-defined components, <b>Create new</b>, <b>Button</b>. Maak er drie, in deze volgorde: <b>Open</b>, <b>Dicht</b>, <b>Stop</b> (groep Vlakkelichtkoepel).</p>
      <p class="muted small-text">Controleer dat de ID's <b>button:200</b>, <b>button:201</b> en <b>button:202</b> zijn. Anders klopt de regel MAP in het script niet.</p>`;
    mk('primary', 'check', 'Gedaan', next);
    mk('ghost', 'back', 'Terug', back);
  } else if (gw.step === 4) {
    body.innerHTML = `<p>Webinterface: <b>Scripts</b>, <b>Create script</b>, naam <b>vlk_gateway</b>. Plak het hele script (de sleutel staat er al in), dan <b>Save</b> en <b>Start</b>. Zet in de scriptlijst <b>Run on startup</b> aan.</p>
      <p class="muted small-text">In de scriptlog moet "VLK gateway gestart" staan. Script versie ${GATEWAY_SCRIPT_VERSION}. De sleutel is geheim: deel het script niet.</p>`;
    mk('primary', 'copy', 'Script kopiëren', () => copyText(gatewayScript(gw.key), 'Script'));
    mk('ghost', 'check', 'Script draait', next);
    mk('ghost', 'back', 'Terug', back);
  } else if (gw.step === 5) {
    const left = gw.until ? Math.max(0, Math.round((gw.until - Date.now()) / 1000)) : 0;
    body.innerHTML = gw.until && left > 0
      ? `<p>Druk nu in de webinterface op de virtuele knop <b>Open</b>.</p><p class="muted">De print piept 2x als de gateway gekoppeld is. Nog ${left} s.</p>`
      : `<p>Tik op <b>Koppelen</b> en druk binnen 60 s in de webinterface op <b>Open</b>.</p>`;
    if (!(gw.until && left > 0)) {
      mk('primary big', 'plus', 'Koppelen', async () => {
        try {
          gw.before = (await loadRemotes()).length;
          await pairWithKey(gw.key);
          gw.until = Date.now() + 60000;
          renderGw();
          gwWait();
        } catch (e) { snack(e.message); }
      });
      mk('ghost', 'back', 'Terug', back);
    }
  } else if (gw.step === 6) {
    body.innerHTML = `<div class="wz-result good"><h3>Gateway gekoppeld</h3></div>
      <p><b>Koppel de app nu los</b>: zolang de app verbonden is, komen opdrachten van de gateway niet aan. Test daarna Open, Dicht en Stop in de webinterface of de Shelly-app.</p>`;
    mk('ghost', 'check', 'Klaar', () => { gw.step = 0; gw.key = ''; gw.until = 0; renderGw(); });
  } else if (gw.step === 7) {
    body.innerHTML = '<div class="wz-result bad"><h3>Niet gekoppeld</h3><p class="muted">Binnen 60 s kwam er geen bericht van de gateway. Draait het script (scriptlog) en staat de sleutel erin?</p></div>';
    mk('primary', 'reset', 'Opnieuw', () => { gw.step = 5; gw.until = 0; renderGw(); });
  }
  root.append(body, row);
}
async function gwWait() {
  while (gw.step === 5 && gw.until) {
    await new Promise((r) => setTimeout(r, 1000));
    if (gw.step !== 5) return;
    try {
      const list = await loadRemotes();
      if (list.length > gw.before) { gw.step = 6; gw.until = 0; renderGw(); return; }
    } catch { /* volgende keer */ }
    if (Date.now() > gw.until) { gw.step = 7; gw.until = 0; renderGw(); return; }
    renderGw();
  }
}
renderGw();

// ------------------------------------------------------------------ log en tellers
async function loadCounters() {
  const b = await req(OP.COUNTERS);
  const dv = new DataView(b.buffer, b.byteOffset);
  const v = [0, 1, 2, 3, 4].map((i) => dv.getUint32(i * 4, true));
  const box = $('counters');
  box.innerHTML = '';
  [['OPEN', v[0]], ['DICHT', v[1]], ['Duurtest open', v[2]], ['Duurtest dicht', v[3]], ['Opstarts', v[4]]]
    .forEach(([k, n]) => { const c = el('div', 'card'); c.innerHTML = `<div class="k">${k}</div><div class="v">${n}</div>`; box.append(c); });
}
// Duurtest: het vinkje werkt direct; statusupdates zetten het niet terug zolang de opdracht loopt.
async function setDuurtest(on) {
  duurBusy = true;
  $('duur-on').checked = on;
  try {
    await req(OP.DUUR, new Uint8Array([on ? 1 : 0]));
    if (cfg) cfg.duurtest = on ? 1 : 0;
    if (status) status.flags = on ? status.flags | FLAGS.DUURTEST : status.flags & ~FLAGS.DUURTEST;
    snack(on ? `Duurtest aan, eerste beweging over 30 s` : 'Duurtest uit', 'Ongedaan maken', () => setDuurtest(!on));
    loadCounters();
  } catch (e) {
    $('duur-on').checked = !on;
  } finally {
    duurBusy = false;
  }
}
$('duur-on').onchange = () => setDuurtest($('duur-on').checked);
$('duur-save').onclick = async () => {
  const iv = Math.max(30, Number($('duur-int').value) || 300);
  $('duur-int').value = iv;
  if (!cfg || cfg.duurtest_interval_s === iv) { snack(`Interval is al ${iv} s`); return; }
  const c = { ...cfg, duurtest_interval_s: iv };
  await req(OP.CFG_SET, encodeCfg(c));
  cfg = c;
  snack(`Interval ${iv} s opgeslagen`);
};
$('log-load').onclick = async () => {
  const cb = await req(OP.LOG_COUNT);
  const n = cb[0] | (cb[1] << 8);
  logEntries = [];
  for (let s = 0; s < n; s += 14) {
    logEntries.push(...decodeLog(await req(OP.LOG_GET, new Uint8Array([s & 255, s >> 8, 14]))));
  }
  renderLog();
  loadCounters();
};
function renderLog() {
  const box = $('log-list');
  box.innerHTML = '';
  if (!logEntries.length) box.append(el('div', 'empty', 'Log is leeg.'));
  for (const e of [...logEntries].reverse()) {
    const it = el('div', 'item');
    it.innerHTML = `<div class="main"><div class="t">${EVL[e.type] || e.type}: ${describeLog(e)}</div><div class="d">opstart ${e.boot}, ${Math.floor(e.t / 3600)}u ${Math.floor((e.t % 3600) / 60)}m ${e.t % 60}s na opstarten</div></div>`;
    box.append(it);
  }
}
$('log-export').onclick = () => {
  if (!logEntries.length) { snack('Laad eerst het log'); return; }
  download(`vlk_log_${info?.name || 'print'}_${stamp()}.csv`,
    'opstart;seconden;soort;omschrijving\n' + logEntries.map((e) => `${e.boot};${e.t};${EVL[e.type] || e.type};${describeLog(e)}`).join('\n') + '\n', 'text/csv');
};
$('log-clear').onclick = async () => {
  if (await confirmDlg('Foutlog op de print wissen? Exporteer het eerst als je het wilt bewaren.', 'Wissen')) {
    await req(OP.LOG_CLEAR); logEntries = []; renderLog();
  }
};

// ------------------------------------------------------------------ eindtest (stap voor stap, js/eindtest.js)
function onText(t) {
  if (!/EINDTEST|VDD|Accu|NTC|Motor|Nulpunt|uitgang|Buzzer|BLE|Regen|DIP|Ingangen|MCU|Stroom/.test(t)) snack(t);
}
eindtest = initEindtest({
  $, el, req, snack, download, stamp,
  getInfo: () => info, getStatus: () => status, getCfg: () => cfg, connected: () => !!dev, appVersion: APP_VERSION,
});

// ------------------------------------------------------------------ update
$('fw-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  fwImage = new Uint8Array(await f.arrayBuffer());
  const dv = new DataView(fwImage.buffer);
  let ver = 'onbekend';
  if (fwImage.length > 32 && dv.getUint32(0, true) === 0x96f3b83d) {
    ver = `${fwImage[20]}.${fwImage[21]}.${dv.getUint16(22, true)}+${dv.getUint32(24, true)}`;
  } else {
    snack('Dit is geen ondertekende MCUboot-image (zephyr.signed.bin)');
  }
  $('fw-name').textContent = `${f.name}, ${(fwImage.length / 1024).toFixed(0)} kB, versie ${ver}`;
  $('fw-go').disabled = !dev || dev.demo;
  e.target.value = '';
};
$('fw-go').onclick = async () => {
  if (!fwImage || !dev || dev.demo) return;
  if (!(await confirmDlg('Firmware-update starten? De print herstart daarna. Niet de motor bedienen tijdens de update.', 'Starten'))) return;
  const prog = $('fw-prog');
  prog.hidden = false;
  $('fw-go').disabled = true;
  try {
    await req(OP.STREAM, new Uint8Array([0]), true).catch(() => {});
    const smp = new Smp(dev.server);
    await smp.open();
    const t0 = performance.now();
    await smp.upload(fwImage, (f) => { prog.value = f; });
    const want = `${fwImage[20]}.${fwImage[21]}.${new DataView(fwImage.buffer).getUint16(22, true)}`;
    const btDev = dev.dev;
    await smp.testAndReset();
    snack(`Upload klaar in ${((performance.now() - t0) / 1000).toFixed(0)} s. De print herstart; opnieuw verbinden...`, null, null, 60000);
    await afterUpdate(btDev, want);
  } catch (e) {
    snack(`Update mislukt: ${e.message}`);
  } finally {
    $('fw-go').disabled = false;
  }
};

// Na de upload: wachten tot de print herstart, zelf opnieuw verbinden (firmware 0.3.10+ opent dan
// 2 min een servicevenster voor gekoppelde telefoons) en controleren dat de nieuwe versie draait
// en bevestigd is. Oudere firmware: geen venster, dan blijft het bij de melding.
async function afterUpdate(btDev, want) {
  const t0 = Date.now();
  while (dev && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 500));
  if (dev) { dev.disconnect(); dev = null; setConnected(false); }
  await new Promise((r) => setTimeout(r, 4000)); // MCUboot verplaatst de image (ca. 2 s) en start
  const t1 = Date.now();
  while (!dev && Date.now() - t1 < 120000) {
    try {
      dev = await new VlkDevice().open(btDev);
      await onConnected();
    } catch {
      dev = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!dev) {
    snack('Print herstart, maar opnieuw verbinden lukte niet. Druk de servicetoets in, verbind en controleer de versie onder Update.', null, null, 15000);
    return;
  }
  let confirmed = null;
  try {
    const smp = new Smp(dev.server);
    await smp.open();
    const st = await smp.imageState();
    const s0 = (st.images || []).find((x) => x.slot === 0);
    confirmed = s0 ? !!s0.confirmed : null;
  } catch { /* oudere firmware of geen SMP: alleen de versie */ }
  const fw = info?.fw || '?';
  if (fw === want && confirmed !== false) {
    snack(`Update geslaagd: firmware ${fw} draait en is bevestigd.`, null, null, 15000);
  } else if (fw === want) {
    snack(`Firmware ${fw} draait maar is NIET bevestigd: bij de volgende herstart gaat de print terug. Zie de UART-log.`, null, null, 20000);
  } else {
    snack(`Update niet gelukt: de print draait ${fw} in plaats van ${want} (image geweigerd of teruggezet).`, null, null, 20000);
  }
}

// ------------------------------------------------------------------ start
$('app-ver').textContent = `App-versie ${APP_VERSION}`;
$('conn-sub').textContent = `Niet verbonden - app ${APP_VERSION}`;
setConnected(false);
renderRuns();
renderCal();
renderWiz();
applyRole();
showTab(localStorage.getItem('vlk-tab') || 'live');
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
