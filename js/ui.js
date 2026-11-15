// Side panel, pop-ups and the debrief. DOM text is updated once per game hour, not every frame.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;

  function UI(handlers) {
    const C = MT.CONFIG;
    let selected = null;

    // ----- build menu -----
    const menu = $('buildMenu');
    C.buildOrder.forEach((type, i) => {
      const d = C.modules[type];
      const b = document.createElement('button');
      b.className = 'buildBtn';
      b.dataset.type = type;
      b.title = d.desc;
      b.innerHTML = `<span class="ico">${d.icon}</span><span class="nm">${esc(d.name)}</span><span class="meta">${d.cost} parts${d.power ? ' · ' + d.power + ' kW' : d.makes ? ' · +' + d.makes + ' kW' : d.store ? ' · ' + d.store + ' kWh' : ''}</span><kbd>${i + 1}</kbd>`;
      b.addEventListener('click', () => select(selected === type ? null : type));
      menu.appendChild(b);
    });
    function select(type) {
      selected = type;
      for (const b of menu.children) b.classList.toggle('sel', b.dataset.type === type);
      const hint = $('buildHint');
      if (type) { hint.hidden = false; hint.textContent = `Click the map to build: ${C.modules[type].name}. ${C.modules[type].desc}  (Esc to cancel)`; }
      else hint.hidden = true;
    }
    $('bermBtn').addEventListener('click', handlers.berm);
    $('shelterBtn').addEventListener('click', handlers.shelter);
    document.querySelectorAll('.speed button').forEach((b) => b.addEventListener('click', () => handlers.speed(+b.dataset.speed)));

    // ----- bars -----
    const barDefs = [
      { key: 'o2', label: '🫁 Oxygen', unit: 'kg', max: () => C.caps.o2, perH: () => C.use.o2PerPersonH * C.crew },
      { key: 'food', label: '🍞 Food', unit: 'kg', max: () => 150, perH: () => C.use.foodPerPersonH * C.crew },
      { key: 'water', label: '💧 Water', unit: 'kg', max: () => C.caps.water, perH: null },
      { key: 'battery', label: '🔋 Battery', unit: 'kWh', max: (s) => Math.max(1, s.power.cap), perH: null },
      { key: 'dose', label: '☢️ Crew radiation', unit: 'mSv', max: () => C.rad.limit, bad: true },
      { key: 'temp', label: '🌡️ Habitat', unit: '°C', max: () => C.habTemp.normal },
    ];
    const bars = $('bars');
    for (const b of barDefs) {
      const el = document.createElement('div');
      el.className = 'bar';
      el.innerHTML = `<div class="barTop"><span>${b.label}</span><span class="val"></span></div><div class="track"><div class="fill"></div></div>`;
      bars.appendChild(el);
      b.el = el; b.val = el.querySelector('.val'); b.fill = el.querySelector('.fill');
    }

    function update(state) {
      const h = state.hour;
      $('clockDay').textContent = `Day ${Math.min(30, Math.floor(h / 24) + 1)} / 30`;
      $('clockHour').textContent = String(h % 24).padStart(2, '0') + ':00';
      $('scenarioTag').textContent = state.scenario === 'history' ? 'REAL DATA: May 2024' : 'Training mission';
      $('scenarioTag').className = 'tag' + (state.scenario === 'history' ? ' real' : '');

      for (const b of barDefs) {
        let v, frac, level = 'ok', text;
        if (b.key === 'dose') { v = state.dose; frac = v / b.max(); level = v >= C.rad.warn ? 'bad' : v >= 75 ? 'warn' : 'ok'; text = `${Math.round(v)} / ${C.rad.limit} mSv`; }
        else if (b.key === 'temp') { v = state.habTemp; frac = Math.max(0, (v - 0) / 21); level = v < 12 ? 'bad' : v < 19 ? 'warn' : 'ok'; text = `${r1(v)} °C`; }
        else {
          v = state.res[b.key]; frac = v / b.max(state);
          text = `${Math.round(v)} ${b.unit}`;
          if (b.perH) { const d = v / b.perH() / 24; text += ` · ${r1(d)} days`; level = d < 2 ? 'bad' : d < 4 ? 'warn' : 'ok'; }
          else level = frac < 0.15 ? 'bad' : frac < 0.35 ? 'warn' : 'ok';
        }
        b.val.textContent = text;
        b.fill.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
        b.el.dataset.level = level;
      }

      const P = state.power;
      $('powerLine').textContent = `making ${r1(P.supply)} kW · using ${r1(P.use)} kW`;
      const maxP = Math.max(P.supply, P.use, 1);
      $('powerBar').querySelector('.make').style.width = (P.supply / maxP) * 100 + '%';
      $('powerBar').querySelector('.use').style.width = (P.use / maxP) * 100 + '%';
      $('powerBar').dataset.level = P.use > P.supply + 0.01 ? (state.res.battery > 0.01 ? 'warn' : 'bad') : 'ok';

      $('parts').textContent = state.res.parts;
      for (const b of menu.children) b.disabled = state.res.parts < C.modules[b.dataset.type].cost || state.status !== 'running';
      if (selected && state.res.parts < C.modules[selected].cost) select(null);

      const bb = $('bermBtn');
      bb.disabled = state.berm.built || state.berm.building || state.status !== 'running';
      bb.innerHTML = state.berm.built ? '⛰️ Habitat shielded ✓ <small>(blocks 80% of radiation)</small>'
        : state.berm.building ? `⛰️ Piling moon dirt… ${Math.round((state.berm.progress / C.bermWork) * 100)}%`
          : '⛰️ Shield habitat with moon dirt <small>(0 parts, 36 crew-hours)</small>';
      const sb = $('shelterBtn');
      const hasS = MT.Sim.hasShelter(state);
      sb.disabled = !hasS || state.status !== 'running';
      sb.classList.toggle('active', state.sheltering);
      sb.innerHTML = !hasS ? '🛡️ Send crew to shelter <small>(build a Storm Shelter first)</small>'
        : state.sheltering ? '👩‍🚀 Crew is in the shelter: click to go back to work' : '🛡️ Send crew to shelter';

      const job = MT.Sim.currentJob(state);
      let jl = '';
      if (job) {
        const name = job.kind === 'module' ? C.modules[job.m.type].name : 'Habitat shielding';
        const left = job.kind === 'module' ? C.modules[job.m.type].work - job.m.progress : C.bermWork - state.berm.progress;
        const queued = state.modules.filter((m) => !m.built).length - (job.kind === 'module' ? 1 : 0);
        jl = state.sheltering ? `⏸ Building paused: crew is in the shelter.` : `🔧 2 astronauts outside building: ${name} (~${Math.ceil(left / C.workers)} h left)${queued > 0 ? ` · ${queued} more waiting` : ''}`;
      }
      $('jobLine').textContent = jl;

      // cause chains
      const chains = MT.Sim.causeChains(state);
      $('chains').innerHTML = chains.length
        ? chains.map((ch) => '<div class="chain">' + ch.map((it) => `<div class="link ${it.level}"><span>${it.icon}</span>${esc(it.text)}</div>`).join('<div class="arrow">↓</div>') + '</div>').join('')
        : '<div class="link ok"><span>✅</span>All systems OK. Power, air, food and water are balanced.</div>';

      // log
      const items = state.log.slice(-9).reverse();
      $('log').innerHTML = items.map((l) => `<li class="${l.level}"><b>D${Math.floor(l.h / 24) + 1} ${String(l.h % 24).padStart(2, '0')}h</b> ${esc(l.text)}</li>`).join('');
    }

    function capcom(ev) {
      $('capcomText').textContent = ev.title + (ev.text ? ' — ' + ev.text : '');
      const el = $('capcom');
      el.dataset.level = ev.level;
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }

    function setSpeed(s) { document.querySelectorAll('.speed button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === s)); }

    // ----- tooltip -----
    function tooltip(state, tile, show) {
      const tip = $('tooltip');
      if (!show || !tile || tile.c < 0 || tile.r < 0 || tile.c >= C.map.cols || tile.r >= C.map.rows) { tip.hidden = true; return; }
      const m = MT.Sim.moduleAt(state, tile.c, tile.r);
      let html;
      if (m) {
        const d = C.modules[m.type];
        const lines = [];
        if (!m.built) lines.push(`Being built: ${Math.round((m.progress / d.work) * 100)}%`, '<i>Click to cancel (get parts back)</i>');
        else {
          if (m.type === 'solar') lines.push(m.lit ? `☀️ In sunlight: making ${d.makes} kW` : '🌑 In shadow: making 0 kW');
          else if (m.type === 'battery') lines.push(`Base battery: ${Math.round(state.res.battery)} / ${state.power.cap} kWh`);
          else if (m.type === 'shelter') lines.push(state.sheltering ? 'Crew is inside' : 'Empty. Use it during radiation storms.');
          else if (m.type === 'tower') lines.push(MT.Sim.firstTower(state) === m ? "<i>Click to see today's picture from NASA</i>" : "<i>Click to see a picture from NASA's archive (since 1995)</i>");
          else lines.push(!m.on ? 'Turned OFF by you' : m.powered ? `✅ Running (uses ${r1(MT.Sim.needOf(state, m))} kW)` : '⚡ NO POWER');
          if (m.noWater) lines.push('💧 No water!');
          if (m.type !== 'hab' && m.type !== 'battery' && m.type !== 'shelter' && m.type !== 'tower') lines.push(`<i>Click to turn ${m.on ? 'OFF' : 'ON'}</i>`);
        }
        html = `<b>${d.icon} ${esc(d.name)}</b><br>${esc(d.desc)}<br>${lines.join('<br>')}`;
      } else {
        const z = MT.Sim.zoneOf(state, tile.c, tile.r), Z = C.zones[z];
        const lit = MT.Sim.zoneLitAt(state, z, state.hour);
        html = `<b>${esc(Z.name)}</b> — ${lit ? '☀️ sunny now' : '🌑 in shadow now'}<br>${esc(Z.blurb)}`;
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const wrap = tip.parentElement.getBoundingClientRect();
      const x = Math.min(tile.px + 14, wrap.width - 250), y = Math.min(tile.py + 14, wrap.height - 110);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }

    // ----- modals -----
    function modal(html) {
      $('modalBody').innerHTML = html;
      $('modal').hidden = false;
      const first = $('modalBody').querySelector('button');
      if (first) first.focus();
    }
    function closeModal() { $('modal').hidden = true; }
    const isModalOpen = () => !$('modal').hidden;

    function showStart(onChoose) {
      modal(`
        <h1>🌙 Shackleton Base</h1>
        <p class="lead">You are the commander of a Moon base near the lunar south pole, where NASA's Artemis astronauts plan to go. Keep <b>4 astronauts</b> alive for <b>30 days</b>.</p>
        <div class="howto">
          <div>☀️ <b>Power</b>: the Sun circles the horizon here. Hills block it, so shadows move. Panels in shadow make nothing.</div>
          <div>🫁 <b>Air</b>: the O₂ Generator turns water into oxygen. It needs power AND water.</div>
          <div>🍞 <b>Food</b>: greenhouses grow food but need lots of power.</div>
          <div>☢️ <b>Radiation</b>: solar flares can send radiation storms. Hide the crew in a shelter.</div>
        </div>
        <div class="choices">
          <button class="choice" data-s="training"><span class="big">🎓</span><b>Training mission</b><span>Random space weather. Every radiation storm is a copy of a real one NASA measured at the Moon.</span></button>
          <button class="choice real" data-s="history"><span class="big">📡</span><b>Real history: May 2024</b><span>Replay the real solar storms of May 2024 (biggest in 20 years): NASA DONKI alerts and the radiation NASA's LRO measured at the Moon, hour by hour.</span></button>
        </div>`);
      $('modalBody').querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => { closeModal(); onChoose(b.dataset.s); }));
    }

    // ----- Astronomy Tower: NASA picture of the day under a fishbowl lens (js/apod.js) -----
    function showTower(opts, onClose) {
      modal(`
        <div class="apod">
          <div class="apodHead"><h2>🔭 Astronomy Tower</h2><button class="apodX" data-a="close" aria-label="Close">✕</button></div>
          <p class="apodStatus muted"></p>
          <div class="apodStage" hidden><canvas class="apodCanvas" tabindex="0"></canvas></div>
          <p class="apodHint muted small">Move your mouse over the picture to look through the fishbowl. (Arrow keys work too.)</p>
          <div class="apodInfo" hidden>
            <h3 class="apodTitle"></h3>
            <p class="apodMeta muted small"></p>
            <p class="apodText"></p>
            <a class="apodLink" href="https://apod.nasa.gov/apod/" target="_blank" rel="noopener noreferrer">See it on NASA's website ↗</a>
          </div>
          <div class="row"><button class="primary" data-a="close">Back to the base</button></div>
        </div>`);
      const box = $('modal').querySelector('.modalBox');
      box.classList.add('wide');
      const view = MT.APOD.show($('modalBody').querySelector('.apod'), opts);
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
      function close() {
        view.destroy();
        document.removeEventListener('keydown', onKey, true);
        box.classList.remove('wide');
        closeModal();
        onClose();
      }
      document.addEventListener('keydown', onKey, true);
      $('modalBody').querySelectorAll('[data-a=close]').forEach((b) => b.addEventListener('click', close));
    }

    function showEvent(ev, state, onClose) {
      const C2 = C.cargoOptions;
      let body = `<h2 class="${ev.level}">${esc(ev.title)}</h2><p>${esc(ev.text || '')}</p>`;
      if (ev.decision === 'cargo') {
        body += '<div class="choices three">' + Object.keys(C2).map((k) => `<button class="choice" data-c="${k}"><span class="big">${C2[k].icon}</span><b>${esc(C2[k].name)}</b><span>${esc(C2[k].text)}</span></button>`).join('') + '</div>';
      } else if (ev.decision === 'shelter') {
        body += '<div class="row"><button class="primary" data-a="shelter">🛡️ Go to the shelter</button><button data-a="stay">Keep working</button></div>';
      } else body += '<div class="row"><button class="primary" data-a="ok">OK</button></div>';
      modal(body);
      $('modalBody').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.c) handlers.cargo(ev.cargoIndex, b.dataset.c);
        if (b.dataset.a === 'shelter') handlers.setShelter(true);
        closeModal(); onClose();
      }));
    }

    function showDebrief(state, onRestart, onMenu) {
      const d = MT.Sim.debrief(state);
      const stars = d.won ? '⭐'.repeat(d.stars) + '☆'.repeat(3 - d.stars) : '';
      const chain = d.chain.length ? '<h3>What happened (cause → effect)</h3><div class="timeline">' + d.chain.map((c) => `<div class="tl"><span class="when">${esc(c.when)}</span><span>${esc(c.text)}</span></div>`).join('<div class="arrow">↓</div>') + '</div>' : '';
      modal(`
        <h1 class="${d.won ? 'good' : 'bad'}">${d.won ? '🎉' : '🚨'} ${esc(d.title)}</h1>
        ${stars ? `<div class="stars">${stars}</div>` : ''}
        ${chain}
        <h3>Mission charts</h3>
        <canvas id="debriefChart" width="640" height="170"></canvas>
        <div class="legend"><span style="--c:#58c4ff">Oxygen</span><span style="--c:#ffb86b">Food</span><span style="--c:#7fa8ff">Water</span><span style="--c:#5fe08a">Battery</span><span style="--c:#ff5d5d">Radiation dose</span></div>
        <div class="statGrid">
          <div><b>${d.stats.days}</b>days</div><div><b>${d.stats.dose}</b>mSv dose</div><div><b>${d.stats.foodMade}</b>kg food grown</div>
          <div><b>${d.stats.o2Made}</b>kg O₂ made</div><div><b>${d.stats.waterMined}</b>kg ice mined</div><div><b>${d.stats.solarKwh}</b>kWh solar</div>
        </div>
        ${d.tips.length ? '<h3>' + (d.won ? 'Score' : 'Try this next time') + '</h3><ul class="tips">' + d.tips.map((t) => `<li>${esc(t)}</li>`).join('') + '</ul>' : ''}
        <div class="fact">🚀 <b>Real NASA connection:</b> ${esc(d.fact)}</div>
        <div class="row"><button class="primary" data-a="again">Try again</button><button data-a="menu">Main menu</button></div>`);
      drawChart($('debriefChart'), state);
      $('modalBody').querySelector('[data-a=again]').addEventListener('click', () => { closeModal(); onRestart(); });
      $('modalBody').querySelector('[data-a=menu]').addEventListener('click', () => { closeModal(); onMenu(); });
    }

    function drawChart(cv, state) {
      const g = cv.getContext('2d'), W = cv.width, H = cv.height, Hs = state.history, n = C.missionHours;
      g.fillStyle = '#121722'; g.fillRect(0, 0, W, H);
      // darkness bands for the plain (where the habitat is)
      for (let h = 0; h < n; h++) if (!state.light.plain[h]) { g.fillStyle = 'rgba(80,90,130,0.25)'; g.fillRect((h / n) * W, 0, W / n + 0.5, H); }
      for (const s of state.storms) if (s.h < Hs.o2.length) { g.fillStyle = 'rgba(255,93,93,0.5)'; g.fillRect((s.h / n) * W - 1, 0, 2, H); }
      const line = (arr, max, color) => {
        g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
        arr.forEach((v, i) => { const x = (i / n) * W, y = H - 6 - Math.min(1, v / max) * (H - 12); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
      };
      line(Hs.o2, C.caps.o2, '#58c4ff'); line(Hs.food, 150, '#ffb86b'); line(Hs.water, C.caps.water, '#7fa8ff');
      line(Hs.battery, Math.max(1, ...Hs.battery), '#5fe08a'); line(Hs.dose, C.rad.limit, '#ff5d5d');
      g.fillStyle = '#8b93a1'; g.font = '10px system-ui';
      for (let d = 5; d < 30; d += 5) { const x = ((d * 24) / n) * W; g.fillStyle = '#8b93a1'; g.fillRect(x, H - 4, 1, 4); g.fillText('Day ' + d, x + 3, H - 3); }
      g.fillStyle = 'rgba(18,23,34,0.85)'; g.fillRect(0, 0, 300, 16); g.fillStyle = '#c9d1dc'; g.fillText('blue band = plain in shadow · red line = radiation storm', 6, 11);
    }

    // ----- every frame: clock + countdown bar (only touches the DOM when the text really changes) -----
    const fmtLeft = (hrs) => {
      const mins = Math.max(0, Math.ceil((hrs * 60) / 5) * 5); // 5-minute steps
      const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
      if (d) return `${d} d ${h} h`;
      if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
      return `${m} min`;
    };
    const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    let lastBar = '';
    function live(state, frac) {
      const now = state.hour + frac;
      const mins = Math.floor((frac * 60) / 10) * 10;
      setText($('clockDay'), `Day ${Math.min(30, Math.floor(state.hour / 24) + 1)} / 30`);
      setText($('clockHour'), String(state.hour % 24).padStart(2, '0') + ':' + String(mins).padStart(2, '0'));
      const items = state.status === 'running' ? MT.Sim.upcoming(state, now) : [];
      const html = items.length
        ? items.map((it) => {
          const pct = Math.max(0, Math.min(100, (1 - it.left / it.total) * 100));
          return `<div class="cd ${it.level}"><span class="cdIco">${it.icon}</span><span class="cdText">${esc(it.label)} <b>${fmtLeft(it.left)}</b></span><span class="cdTrack"><span style="width:${pct.toFixed(1)}%"></span></span></div>`;
        }).join('')
        : '<div class="cd info"><span class="cdIco">✅</span><span class="cdText">Nothing incoming right now.</span></div>';
      if (html !== lastBar) { $('countdowns').innerHTML = html; lastBar = html; }
    }

    return { live, update, capcom, setSpeed, tooltip, showStart, showEvent, showDebrief, showTower, isModalOpen, select, get selected() { return selected; } };
  }

  MT.UI = UI;
})(window);
