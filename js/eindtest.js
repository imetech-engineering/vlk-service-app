// eindtest.js - eindtest stap voor stap: de app stuurt de print aan (OP_TEST), de tester bevestigt
// wat hij ziet, hoort of meet. Automatische stappen keuren zelf goed.
// IMeTech Engineering, project 5008
import { ICON } from './icons.js';
import { OP, FLAGS, CMD } from './vlk.js';

const T = { MODE: 0, BUZ: 1, LED1: 2, EXTLED: 3, AUX12: 4, AUX24: 5, RAIN: 6, BOOST: 7, PULSE: 8, READ: 9, RELAY_INFL: 10 };
const OK = 'ok', FAIL = 'fout', SKIP = 'n.v.t.';

export function decodeTestRead(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    vdd: dv.getUint16(0, true), mcu: dv.getInt8(2), accu: dv.getUint16(3, true), ntc: dv.getInt16(5, true),
    rainMv: dv.getInt16(7, true), wet: !!dv.getUint8(9), inputs: dv.getUint8(10), dip: dv.getUint8(11),
    remCnt: dv.getUint8(12), remLast: dv.getUint8(13), ma: dv.getInt16(14, true), zeroOk: !!dv.getUint8(16),
  };
}

const NTC_NONE = -32768;

export function initEindtest(ctx) {
  // ctx: { $, el, req, snack, download, stamp, getInfo, getStatus, getCfg, connected }
  const { $, el } = ctx;
  const root = $('wz-root');
  let steps = [];
  let idx = -1;
  let results = {};
  let supply = null;      // 'lab' of 'accu'
  let timers = [];
  let busy = false;
  let started = 0;

  const send = (what, val = 0) => {
    const b = new Uint8Array(3);
    b[0] = what; b[1] = val & 0xff; b[2] = val >> 8;
    return ctx.req(OP.TEST, b, true);
  };
  const read = async () => decodeTestRead(await send(T.READ));
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.push(() => clearInterval(t)); };
  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(() => clearTimeout(t)); };
  const stopTimers = () => { timers.forEach((f) => f()); timers = []; };

  // live meten met één lopende vraag tegelijk
  function poll(ms, fn) {
    let alive = true;
    timers.push(() => { alive = false; });
    const tick = async () => {
      if (!alive) return;
      try { await fn(await read()); } catch { /* volgende keer */ }
      if (alive) later(ms, tick);
    };
    tick();
  }
  // knipperen/piepen zolang de stap open is
  function blink(what, onMs, offMs) {
    let on = false, alive = true;
    const step = () => {
      if (!alive) return;
      on = !on;
      send(what, on ? 1 : 0).catch(() => {});
      later(on ? onMs : offMs, step);
    };
    timers.push(() => { alive = false; send(what, 0).catch(() => {}); });
    step();
  }
  // geschakelde uitgang die bij het verlaten van de stap weer uit gaat
  function hold(what) {
    send(what, 1).catch(() => {});
    timers.push(() => send(what, 0).catch(() => {}));
  }

  const v = (mv) => `${(mv / 1000).toFixed(2).replace('.', ',')} V`;
  const cell = (k, val, cls = '') => `<div class="card ${cls}"><div class="k">${k}</div><div class="v">${val}</div></div>`;

  // ---------------------------------------------------------------- stappen
  // kind: 'ask' (ja/nee), 'auto' (keurt zelf goed), 'live' (wacht op een handeling), 'info'
  function buildSteps() {
    const cfg = ctx.getCfg();
    const block = cfg?.accu_block_mv || 11900, release = cfg?.accu_release_mv || 12400;
    const s = [];

    s.push({ id: 'voeding', title: 'Voorbereiding', kind: 'choice',
      text: `<p>Leg klaar:</p><ul>
        <li>de print op voeding: <b>labvoeding 12,8 V</b> (stroombegrenzing ca. 3 A) of een <b>accu</b></li>
        <li>een kettingmotor of testlast op <b>M1</b></li>
        <li>regensensor RS12 en NTC aangesloten (als ze erbij horen)</li>
        <li>multimeter, een draadje voor de ingangen (CN6)</li></ul>
        <p>Waar hangt de print aan?</p>`,
      choices: [['lab', 'Labvoeding'], ['accu', 'Accu']],
      onChoice: (c) => { supply = c; } });

    s.push({ id: 'basis', title: 'Voeding en processor', kind: 'auto',
      text: 'De print meet zijn eigen voedingen. Dit gaat vanzelf.',
      run: async (done) => {
        const r = await read();
        const vddOk = r.vdd > 1700 && r.vdd < 3600, mcuOk = r.mcu > -20 && r.mcu < 70;
        show(cell('VDD (3,3 V)', v(r.vdd), vddOk ? 'ok' : 'err') + cell('Processor', `${r.mcu} °C`, mcuOk ? 'ok' : 'err'));
        done(vddOk && mcuOk ? OK : FAIL, `VDD ${r.vdd} mV, MCU ${r.mcu} °C`);
      } });

    s.push({ id: 'accu', title: 'Accuspanning', kind: 'ask',
      text: 'Meet de spanning op de accu-aansluiting met de multimeter (of lees de labvoeding af).',
      q: 'Komt de waarde hieronder overeen (±0,3 V)?',
      live: (r) => cell('Accu volgens print', v(r.accu)) });

    s.push({ id: 'ntc', title: 'Accutemperatuur (NTC)', kind: 'ask',
      text: 'Pak de NTC even vast: de temperatuur hoort te stijgen.',
      q: 'Klopt de temperatuur en stijgt hij als je de NTC vastpakt?',
      skip: 'Geen NTC aangesloten',
      live: (r) => cell('NTC', r.ntc === NTC_NONE ? 'niet aangesloten' : `${(r.ntc / 10).toFixed(1).replace('.', ',')} °C`, r.ntc === NTC_NONE ? 'err' : '') });

    s.push({ id: 'led1', title: 'Status-led op de print', kind: 'ask', icon: 'warn',
      text: 'De print laat LED1 nu knipperen.', q: 'Knippert LED1?',
      enter: () => blink(T.LED1, 300, 300) });

    s.push({ id: 'extled', title: 'Externe led', kind: 'ask',
      text: 'De print laat de externe led (12 V) nu knipperen.', q: 'Knippert de externe led?',
      skip: 'Geen externe led aangesloten', enter: () => blink(T.EXTLED, 300, 300) });

    s.push({ id: 'buzzer', title: 'Buzzer', kind: 'ask',
      text: 'De buzzer piept nu elke seconde kort.', q: 'Hoor je de buzzer?',
      enter: () => blink(T.BUZ, 150, 850) });

    s.push({ id: 'aux12on', title: '12 V-uitgang aan', kind: 'ask',
      text: 'De 12 V-uitgang staat nu aan. Meet op <b>CN2</b>.', q: 'Meet je ongeveer de accuspanning (ca. 12 V)?',
      enter: () => hold(T.AUX12) });
    s.push({ id: 'aux12off', title: '12 V-uitgang uit', kind: 'ask',
      text: 'De 12 V-uitgang staat nu uit. Meet weer op <b>CN2</b>.', q: 'Meet je nu 0 V?' });

    s.push({ id: 'aux24on', title: '24 V-uitgang aan', kind: 'ask',
      text: 'De 24 V-uitgang staat nu aan. Meet op <b>CN1</b>.', q: 'Meet je ongeveer 24 V?',
      enter: () => hold(T.AUX24) });
    s.push({ id: 'aux24off', title: '24 V-uitgang uit', kind: 'ask',
      text: 'De 24 V-uitgang staat nu uit. Meet weer op <b>CN1</b>.', q: 'Meet je nu 0 V?' });

    s.push({ id: 'regendroog', title: 'Regensensor droog', kind: 'live',
      text: 'De regensensor krijgt nu spanning. Zorg dat hij droog is; na een paar seconden keurt de app hem goed.',
      skip: 'Geen regensensor aangesloten',
      enter: () => hold(T.RAIN),
      watch: (r, st) => { st.n = !r.wet && r.rainMv > 1000 ? (st.n || 0) + 1 : 0; return st.n >= 6; },
      live: (r) => cell('Regensensor', r.wet ? 'nat' : 'droog', r.wet ? 'err' : 'ok') + cell('Spanning', `${r.rainMv} mV`) });
    s.push({ id: 'regennat', title: 'Regensensor nat', kind: 'live',
      text: 'Maak de sensor nat: een natte vinger op het sensorvlak is genoeg. De rode led op de sensor gaat aan.',
      skip: 'Geen regensensor aangesloten',
      enter: () => hold(T.RAIN),
      watch: (r, st) => { st.n = r.wet ? (st.n || 0) + 1 : 0; return st.n >= 3; },
      live: (r) => cell('Regensensor', r.wet ? 'nat' : 'droog', r.wet ? 'ok' : '') + cell('Spanning', `${r.rainMv} mV`) });

    const ins = [['OPEN', 1], ['DICHT', 2], ['STOP', 3], ['reserve', 4]];
    ins.forEach(([name, pin], i) => s.push({ id: `in${pin}`, title: `Ingang ${pin} (${name})`, kind: 'live',
      text: `Verbind op <b>CN6 pin ${pin}</b> (${name}) met <b>pin 5</b> (COM), bijvoorbeeld met een draadje.`,
      watch: (r, st) => {
        if (r.inputs & ~(1 << i) & 0x0f) st.other = true;   // andere ingang ook actief: sluiting?
        return !!(r.inputs & (1 << i));
      },
      note: (st) => (st.other ? 'Let op: er was ook een andere ingang actief (sluiting of verkeerde pin?).' : ''),
      live: (r) => [1, 2, 3, 4].map((p, j) => cell(`IN${p}`, r.inputs & (1 << j) ? 'actief' : '-', r.inputs & (1 << j) ? (j === i ? 'ok' : 'err') : '')).join('') }));

    s.push({ id: 'servicetoets', title: 'Servicetoets', kind: 'live',
      text: 'Druk de servicetoets op de print in.',
      watch: (r) => !!(r.inputs & 0x10),
      live: (r) => cell('Servicetoets', r.inputs & 0x10 ? 'ingedrukt' : '-', r.inputs & 0x10 ? 'ok' : '') });

    s.push({ id: 'dip', title: 'DIP-switches', kind: 'live',
      text: 'Zet elke DIP-switch (1 t/m 4) een keer om. Een vinkje betekent: beide standen gezien.',
      watch: (r, st) => {
        st.seen0 = (st.seen0 || 0) | (~r.dip & 0x0f);
        st.seen1 = (st.seen1 || 0) | (r.dip & 0x0f);
        return (st.seen0 & st.seen1) === 0x0f;
      },
      live: (r, st) => [0, 1, 2, 3].map((j) => {
        const done = ((st.seen0 || 0) & (st.seen1 || 0)) & (1 << j);
        return cell(`DIP ${j + 1}`, `${r.dip & (1 << j) ? 'aan' : 'uit'}${done ? ' ✓' : ''}`, done ? 'ok' : '');
      }).join('') });
    s.push({ id: 'dipterug', title: 'DIP-switches terugzetten', kind: 'ask',
      text: 'Zet de DIP-switches in de stand voor deze klant (motorprofiel, 12 V-uitgang, dodemans).',
      q: 'Staan ze goed?', live: (r) => [0, 1, 2, 3].map((j) => cell(`DIP ${j + 1}`, r.dip & (1 << j) ? 'aan' : 'uit')).join('') });

    s.push({ id: 'nulpunt', title: 'Stroomsensor', kind: 'auto',
      text: 'Motorvoeding en stroomsensor gaan kort aan zonder dat de motor draait.',
      run: async (done) => {
        await send(T.BOOST, 1);
        await new Promise((r) => setTimeout(r, 150));
        const r = await read();
        await send(T.BOOST, 0);
        const ok = r.zeroOk && Math.abs(r.ma) < 50;
        show(cell('Nulpunt', r.zeroOk ? 'OK' : 'buiten bereik', r.zeroOk ? 'ok' : 'err') + cell('Rust', `${r.ma} mA`, Math.abs(r.ma) < 50 ? 'ok' : 'err'));
        done(ok ? OK : FAIL, `nulpunt ${r.zeroOk ? 'ok' : 'fout'}, rust ${r.ma} mA`);
      } });

    // Relaisinvloed op de stroomsensor (schijnstroom U9 RevB0). Firmware 0.3.6 meet alleen; 0.3.7+
    // slaat de offset op als compensatie (stap fout als dat niet lukt). Oudere firmware: n.v.t.
    s.push({ id: 'relais', title: 'Relaisinvloed stroomsensor', kind: 'auto',
      text: 'Haal de motor of testlast los van M1. De relais gaan kort aan (uit, K1, K2, beide); de app meet wat de stroomsensor ziet en vergelijkt met VDD, de ACCU-pin en de NTC-pin. Vanaf firmware 0.3.7 slaat de print dit op als compensatie. Sluit daarna de motor of testlast aan voor de motorpulsen.',
      run: async (done) => {
        let b;
        try { b = await send(T.RELAY_INFL); } catch (e) { done(SKIP, 'niet in deze firmware'); return; }
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const names = ['uit', 'K1', 'K2', 'K1+K2', 'uit'];
        const r = names.map((n, k) => ({ n, cs: dv.getInt16(k * 10, true), d: dv.getInt16(k * 10 + 2, true),
          vdd: dv.getInt16(k * 10 + 4, true), acc: dv.getInt16(k * 10 + 6, true), ntc: dv.getInt16(k * 10 + 8, true) }));
        const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
        show(r.map((x) => cell(x.n, `${sgn(x.d)} mV (${sgn(x.d * 5)} mA)`, '')).join(''));
        const k = r.slice(1, 4);
        const maxCs = Math.max(...k.map((x) => Math.abs(x.d)));
        // Oordeel op VDD en NTC-pin: die horen niet te bewegen. De ACCU-pin meet de echte ingangsspanning,
        // die met beide relais aan kan zakken door de voeding en meetsnoeren (25-11: -68 mV); alleen tonen.
        const maxOther = Math.max(...k.map((x) => Math.max(Math.abs(x.vdd), Math.abs(x.ntc))));
        const maxAcc = Math.max(...k.map((x) => Math.abs(x.acc)));
        const why = maxCs < 5 ? 'geen invloed' : maxOther < maxCs / 4 ? 'alleen stroomsensor (magnetisch)' : 'andere kanalen schuiven mee (massa/meting)';
        // firmware 0.3.7+: byte 50 = compensatie opgeslagen (1) of niet (0)
        const stored = b.byteLength > 50 ? (dv.getUint8(50) ? ', compensatie opgeslagen' : ', compensatie NIET opgeslagen (M1 los?)') : '';
        done(b.byteLength > 50 && !dv.getUint8(50) ? FAIL : OK,
          `K1 ${sgn(r[1].d)} mV, K2 ${sgn(r[2].d)} mV, beide ${sgn(r[3].d)} mV, terug ${sgn(r[4].d)} mV; VDD/NTC max ${maxOther} mV, ACCU-pin max ${maxAcc} mV: ${why}${stored}`);
      } });

    const pulse = (dir, name) => ({ id: `motor${dir}`, title: `Motor ${name}`, kind: 'ask',
      text: `Tik op <b>Start</b>: de motor op M1 draait 0,3 s ${name.toLowerCase()}.`,
      q: `Bewoog de motor (of reageerde de testlast) richting ${name}?`,
      action: ['play', 'Start', async (st) => {
        const b = await send(T.PULSE, dir);
        const dv = new DataView(b.buffer, b.byteOffset);
        st.avg = dv.getUint16(0, true); st.pk = dv.getUint16(2, true); st.after = dv.getUint16(4, true);
        show(cell('Gemiddeld', `${st.avg} mA`, st.avg > 30 ? 'ok' : 'err') + cell('Piek', `${st.pk} mA`) + cell('Na stop', `${st.after} mA`, st.after < 50 ? 'ok' : 'err'));
      }],
      judge: (st, answer) => (answer === OK && st.avg > 30 && st.after < 50 ? OK : FAIL),
      detail: (st) => (st.avg !== undefined ? `gem ${st.avg} mA, piek ${st.pk} mA, na stop ${st.after} mA` : 'niet gestart') });
    s.push(pulse(1, 'OPEN'));
    s.push(pulse(2, 'DICHT'));

    const keys = [['OPEN', 1], ['DICHT', 2], ['STOP', 3], ['reserve', 4]];
    keys.forEach(([name, k]) => s.push({ id: `ab${k}`, title: `Afstandsbediening knop ${k}`, kind: 'live',
      text: `Druk op de afstandsbediening <b>knop ${k}</b> (${name}). De koepel beweegt niet tijdens de eindtest.`,
      skip: 'Geen afstandsbediening gekoppeld',
      start: (r, st) => { st.cnt0 = r.remCnt; },
      watch: (r, st) => r.remCnt !== st.cnt0 && r.remLast === k,
      note: () => (ctx.getStatus()?.nrem ? '' : 'Er is nog geen afstandsbediening gekoppeld (tab Bediening).'),
      live: (r) => cell('Laatste knop', r.remLast ? `knop ${r.remLast}` : '-', r.remLast === k ? 'ok' : '') }));

    s.push({ id: 'accuLaag', title: 'Lage accu', kind: 'live', lab: true,
      text: `Zet de labvoeding langzaam lager tot onder <b>${v(block)}</b> (bijv. 11,5 V). De print meldt dan "accu laag". Dit kan tot een minuut duren.`,
      skip: 'Kan niet (print hangt aan een accu)',
      watch: () => !!(ctx.getStatus()?.flags & FLAGS.ACCU_LOW),
      live: (r) => cell('Accu', v(r.accu)) + cell('Accu laag', ctx.getStatus()?.flags & FLAGS.ACCU_LOW ? 'ja' : 'nee', ctx.getStatus()?.flags & FLAGS.ACCU_LOW ? 'ok' : '') });
    s.push({ id: 'accuTerug', title: 'Accu weer goed', kind: 'live', lab: true,
      text: `Zet de labvoeding terug op <b>12,8 V</b> (vrij vanaf ${v(release)}). "Accu laag" moet verdwijnen.`,
      skip: 'Kan niet (print hangt aan een accu)',
      watch: () => !(ctx.getStatus()?.flags & FLAGS.ACCU_LOW),
      live: (r) => cell('Accu', v(r.accu)) + cell('Accu laag', ctx.getStatus()?.flags & FLAGS.ACCU_LOW ? 'ja' : 'nee', ctx.getStatus()?.flags & FLAGS.ACCU_LOW ? '' : 'ok') });

    return s;
  }

  // ---------------------------------------------------------------- weergave
  function show(html) { const b = $('wz-live'); if (b) b.innerHTML = html; }

  function render() {
    root.innerHTML = '';
    if (idx < 0) {
      const p = el('div', 'wz-intro');
      p.innerHTML = `<p>De app neemt je stap voor stap door de hele print: leds, buzzer, uitgangen, regensensor,
        ingangen, DIP-switches, motor, afstandsbediening en accubewaking. Bij elke stap zegt de app wat je moet doen;
        jij bevestigt wat je ziet, hoort of meet. Tijdens de test doet de print zelf niets automatisch.</p>`;
      const b = el('button', 'primary big', `${ICON.play}<span>Eindtest starten</span>`);
      b.onclick = start;
      b.disabled = !ctx.connected();
      p.append(b);
      root.append(p);
      return;
    }
    if (idx >= steps.length) { renderSummary(); return; }
    const st = steps[idx];
    const n = steps.length;
    const head = el('div', 'wz-head');
    head.innerHTML = `<div class="wz-prog"><div></div></div>
      <div class="muted small-text">Stap ${idx + 1} van ${n}</div><h3>${st.title}</h3>`;
    head.querySelector('.wz-prog div').style.width = `${Math.round((idx / n) * 100)}%`; // CSP: geen inline style
    root.append(head);
    root.append(el('div', 'wz-text', st.text));
    root.append(el('div', 'cards small wz-live', ''));
    root.lastChild.id = 'wz-live';
    const note = el('div', 'wz-note muted small-text', '');
    note.id = 'wz-note';
    root.append(note);
    if (st.q) root.append(el('p', 'wz-q', `<b>${st.q}</b>`));

    const row = el('div', 'row wrap wz-btns');
    const mk = (cls, icon, text, fn) => { const b = el('button', cls, `${ICON[icon] || ''}<span>${text}</span>`); b.onclick = fn; row.append(b); return b; };
    const state = st._state;

    if (st.kind === 'choice') {
      st.choices.forEach(([k, t]) => mk('primary big', 'power', t, () => { st.onChoice(k); finish(OK, t); }));
    }
    if (st.action) {
      const [icon, text, fn] = st.action;
      const arow = el('div', 'row wrap wz-btns');
      const b = el('button', 'primary big', `${ICON[icon] || ''}<span>${text}</span>`);
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fn(state); state.done = true; renderAnswerButtons();
          b.innerHTML = `${ICON.reset}<span>Nog een keer</span>`; b.className = 'ghost big';
        } catch (e) { ctx.snack(`Mislukt: ${e.message}`); }
        b.disabled = false;
      };
      arow.append(b);
      root.insertBefore(arow, root.querySelector('.wz-q') || null);
    }
    function renderAnswerButtons() {
      row.querySelectorAll('.ans').forEach((b) => { b.disabled = st.action && !state.done; });
    }
    if (st.kind === 'ask') {
      mk('primary big ans', 'check', 'Ja', () => finish(st.judge ? st.judge(state, OK) : OK, st.detail?.(state) || ''));
      mk('ghost big danger ans', 'x', 'Nee', () => finish(FAIL, st.detail?.(state) || ''));
      renderAnswerButtons();
    }
    if (st.kind === 'live') {
      mk('ghost danger', 'x', 'Lukt niet', () => finish(FAIL, 'niet gezien'));
    }
    if (st.skip) mk('ghost', 'stop', st.skip, () => finish(SKIP, st.skip));
    root.append(row);

    const nav = el('div', 'row space wz-nav');
    const back = el('button', 'ghost small', `${ICON.back}<span>Vorige stap</span>`);
    back.disabled = idx === 0;
    back.onclick = () => go(idx - 1);
    const stop = el('button', 'ghost small danger', `${ICON.x}<span>Test afbreken</span>`);
    stop.onclick = abort;
    nav.append(back, stop);
    root.append(nav);
  }

  function renderSummary() {
    const list = steps.map((s) => ({ s, r: results[s.id] || { res: SKIP, detail: 'overgeslagen' } }));
    const failed = list.filter((x) => x.r.res === FAIL);
    const verdict = failed.length ? 'NIET GESLAAGD' : 'GESLAAGD';
    const box = el('div', `wz-result ${failed.length ? 'bad' : 'good'}`, `<h3>${verdict}</h3>
      <p class="muted">${list.filter((x) => x.r.res === OK).length} goed, ${failed.length} fout, ${list.filter((x) => x.r.res === SKIP).length} n.v.t.</p>`);
    root.innerHTML = '';
    root.append(box);
    const tbl = el('div', 'list');
    for (const { s, r } of list) {
      const row = el('div', `item wz-res ${r.res === FAIL ? 'err' : r.res === OK ? 'ok' : ''}`,
        `<span>${s.title}</span><span class="muted small-text">${r.detail || ''}</span><b>${r.res}</b>`);
      row.onclick = () => go(steps.indexOf(s));
      tbl.append(row);
    }
    root.append(tbl);
    const row = el('div', 'row wrap wz-btns');
    const save = el('button', 'primary big', `${ICON.save}<span>Rapport opslaan</span>`);
    save.onclick = () => saveReport(list, verdict);
    const again = el('button', 'ghost', `${ICON.reset}<span>Opnieuw</span>`);
    again.onclick = () => { results = {}; idx = -1; render(); };
    row.append(save, again);
    root.append(row);
    root.append(el('p', 'muted small-text', 'Tik op een regel om die stap opnieuw te doen.'));
  }

  function saveReport(list, verdict) {
    const i = ctx.getInfo() || {};
    const pad = (t, n) => (t + ' '.repeat(n)).slice(0, n);
    const lines = [
      'Eindtest Vlakkelichtkoepel besturing (IMeTech Engineering)',
      `Print: ${i.name || '-'}   Hardware: ${i.hw || '-'}   Firmware: ${i.fw || '-'} (${i.built || '-'})   App: ${ctx.appVersion || '-'}`,
      `Datum: ${new Date().toLocaleString('nl-NL')}   Voeding: ${supply === 'lab' ? 'labvoeding' : supply === 'accu' ? 'accu' : '-'}   Duur: ${Math.round((Date.now() - started) / 60000)} min`,
      `Uitslag: ${verdict}`, '',
      ...list.map(({ s, r }) => `${pad(s.title, 34)} ${pad(r.res, 7)} ${r.detail || ''}`), '',
    ];
    ctx.download(`eindtest_${i.name || 'print'}_${ctx.stamp()}.txt`, lines.join('\n'));
    try { localStorage.setItem(`vlk-eindtest-${i.name}`, lines.join('\n')); } catch { /* geen opslag */ }
  }

  // ---------------------------------------------------------------- verloop
  function enterStep() {
    stopTimers();
    if (idx >= 0 && idx < steps.length) steps[idx]._state = {};
    render();
    if (idx < 0 || idx >= steps.length) return;
    const st = steps[idx];
    const state = st._state;
    if (st.lab && supply === 'accu') { finish(SKIP, 'print aan accu'); return; }
    st.enter?.();
    if (st.kind === 'auto') {
      busy = true;
      st.run((res, detail) => { busy = false; finishLater(res, detail); }).catch((e) => { busy = false; finishLater(FAIL, e.message); });
    }
    if (st.live || st.watch) {
      let first = true;
      poll(300, (r) => {
        if (first) { st.start?.(r, state); first = false; }
        if (st.live) show(st.live(r, state));
        const n = st.note?.(state);
        if ($('wz-note')) $('wz-note').textContent = n || '';
        if (st.watch && st.watch(r, state) && !state.passed) {
          state.passed = true;
          finishLater(OK, st.note?.(state) ? 'goed, met opmerking' : 'gezien');
        }
      });
    }
  }
  function finishLater(res, detail) {
    // even laten zien dat het gelukt is, dan door
    const box = $('wz-note');
    if (box) box.innerHTML = res === OK ? '<b class="ok-text">Goed</b>' : `<b class="err-text">Fout: ${detail}</b>`;
    setTimeout(() => finish(res, detail), res === OK ? 700 : 1500);
  }
  function finish(res, detail) {
    if (idx < 0 || idx >= steps.length) return;
    results[steps[idx].id] = { res, detail };
    go(nextOpen(idx + 1));
  }
  function nextOpen(from) {
    // na het opnieuw doen van één stap vanuit het overzicht: terug naar het overzicht
    if (steps.every((s, j) => j < from || results[s.id])) return steps.length;
    return from;
  }
  function go(i) {
    idx = Math.max(0, Math.min(i, steps.length));
    // eindtest-stand aan zolang er een stap open is, uit bij het overzicht
    send(T.MODE, idx < steps.length ? 1 : 0).catch(() => {});
    enterStep();
  }

  async function start() {
    if (!ctx.connected()) return;
    try {
      await send(T.MODE, 1);
    } catch (e) {
      // print bezig (motor loopt, bijv. een DICHT van de regensensor): eerst STOP, dan nog een keer
      if (!/fout 16|bezig/i.test(e.message)) { ctx.snack(`Eindtest kan niet starten: ${e.message}`); return; }
      try {
        ctx.snack('Print is bezig, ik stop de motor en probeer het opnieuw');
        await ctx.req(OP.CMD, new Uint8Array([CMD.STOP]), true);
        await new Promise((r) => setTimeout(r, 1500));
        await send(T.MODE, 1);
      } catch (e2) {
        ctx.snack(`Eindtest kan niet starten: ${e2.message}`);
        return;
      }
    }
    steps = buildSteps();
    results = {};
    started = Date.now();
    go(0);
  }
  async function abort() {
    stopTimers();
    idx = -1;
    render();
    try { await send(T.MODE, 0); } catch { /* verbinding al weg */ }
  }

  render();
  return {
    // bij verbreken of wegnavigeren: print terug naar normaal
    reset() { stopTimers(); if (idx >= 0) send(T.MODE, 0).catch(() => {}); idx = -1; render(); },
    refresh() { if (idx < 0) render(); },
    get active() { return idx >= 0 && idx < steps.length; },
    get busy() { return busy; },
  };
}
