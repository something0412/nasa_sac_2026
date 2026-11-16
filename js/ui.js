// Side panel, pop-ups and the debrief. DOM text is updated once per game hour, not every frame.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;

  function UI(handlers) {
    const C = LW.CONFIG;
    let selected = null;      // building type picked in the build menu
    let selectedCrew = null;  // astronaut id: the player always picks WHO first, then what to build or use
    let cur = null;           // the latest state (for clicks between game hours)
    const RI = C.astro.roleInfo;
    const selCrew = () => (cur && selectedCrew ? cur.crew.find((a) => a.id === selectedCrew && !a.medbay) || null : null);

    // ----- build menu -----
    const menu = $('buildMenu');
    C.buildOrder.forEach((type, i) => {
      const d = C.modules[type];
      const b = document.createElement('button');
      b.className = 'buildBtn';
      b.dataset.type = type;
      b.title = d.desc;
      b.innerHTML = `<span class="ico">${d.icon}</span><span class="nm">${esc(d.name)}</span><span class="meta">${d.cost} parts${d.power ? ' · ' + d.power + ' kW' : d.makes ? ' · +' + d.makes + ' kW' : d.store ? ' · ' + d.store + ' kWh' : ''}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}`;
      b.addEventListener('click', () => pickBuild(type));
      menu.appendChild(b);
    });
    function select(type) {
      selected = type;
      $('map').classList.toggle('building', !!type);
      for (const b of menu.children) b.classList.toggle('sel', b.dataset.type === type);
      updateHint();
    }
    /** Build buttons: dimmed unless an Engineer is picked. Called right away whenever the pick changes. */
    function syncBuildMenu() {
      const a = selCrew(), eng = !!a && a.role === 'engineer';
      for (const b of menu.children) {
        const d = C.modules[b.dataset.type];
        b.disabled = !cur || cur.res.parts < d.cost || cur.status !== 'running';
        b.classList.toggle('locked', !eng);
        b.title = (eng ? '' : 'Pick an Engineer first. ') + d.desc;
      }
    }
    /** Build menu / number keys: only after an Engineer is picked. */
    function pickBuild(type) {
      if (!type || selected === type) { select(null); return; }
      const a = selCrew();
      if (!a || a.role !== 'engineer') {
        nudge(a ? `${a.name} is the ${RI[a.role].name}. Only Engineers can build.` : 'First pick an Engineer, then choose what to build.');
        return;
      }
      select(type);
    }
    function selectCrew(id) {
      selectedCrew = id || null;
      const a = selCrew();
      if (!a) selectedCrew = null;
      if (selected && (!a || a.role !== 'engineer')) select(null);
      syncBuildMenu();
      if (cur) { renderCrewPick(cur); renderAms(cur); renderActions(cur); }
      updateHint();
    }
    // The hint above the supplies says what the picked astronaut can do.
    function updateHint() {
      const hint = $('buildHint'), a = selCrew();
      let t = '';
      if (selected) t = `${a ? a.name + ' will build' : 'Build'}: ${C.modules[selected].name}. Click the map. ${C.modules[selected].desc}  (Esc to cancel)`;
      else if (a) {
        const can = {
          engineer: 'choose something to build, click a damaged building to repair it, or click a building site to give them that job',
          scientist: a.paused && a.paused.kind === 'lab' ? `click a Research Bay to continue the research on hold (${a.paused.left} h left)` : 'click a Research Bay to research an upgrade (1 day)',
          botanist: a.paused && a.paused.kind === 'greenhouse' ? `click a Greenhouse to continue the work on hold (${a.paused.left} h left)` : 'click a Greenhouse to tend it for 1 day (2x food)',
        }[a.role];
        t = `${RI[a.role].icon} ${a.name} (${RI[a.role].name}) picked: ${can}. Anyone can visit an Astronomy Tower or Fitness Center.  (Esc = nobody)`;
      }
      hint.hidden = !t;
      hint.textContent = t;
    }
    /** "Pick an astronaut first": CAPCOM message + the astronaut buttons wiggle. */
    function nudge(text) {
      capcom({ level: 'warn', title: '👩‍🚀 Pick an astronaut first', text });
      const p = $('crewPick');
      p.classList.remove('nudge'); void p.offsetWidth; p.classList.add('nudge');
      if (!open.build) togglePanel('build');
    }
    // ----- floating panels: collapse to just their title bar, or expand (remembered in this browser) -----
    const PANELS = ['supplies', 'build', 'ams', 'why', 'capcom', 'log'];
    const STORE_KEY = 'lunar-world.panels';
    // Settings used to be stored as 'mt.panels.v3' (old name of the game); move them over once.
    try { if (localStorage.getItem(STORE_KEY) === null && localStorage.getItem('mt.panels.v3') !== null) { localStorage.setItem(STORE_KEY, localStorage.getItem('mt.panels.v3')); localStorage.removeItem('mt.panels.v3'); } } catch (e) { /* storage blocked: fine */ }
    let open = {};
    try { open = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { open = {}; }
    const small = window.innerWidth < 980;
    for (const p of PANELS) if (typeof open[p] !== 'boolean') open[p] = p === 'supplies' || ((p === 'build' || p === 'ams') && !small);
    function applyPanels() {
      for (const p of PANELS) {
        const el = document.querySelector(`.panel[data-panel="${p}"]`);
        if (!el) continue;
        el.classList.toggle('collapsed', !open[p]);
        if (open[p]) el.classList.remove('unread');
        const head = el.querySelector(':scope > header');
        head.setAttribute('aria-expanded', open[p]);
        const btn = head.querySelector('.pClose');
        btn.textContent = open[p] ? '–' : '+';
        btn.title = open[p] ? 'Collapse' : 'Expand';
      }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(open)); } catch (e) { /* private mode: fine */ }
      if (handlers.panels) handlers.panels();
    }
    function togglePanel(p) { if (!(p in open)) return; open[p] = !open[p]; if (p === 'build' && !open[p]) select(null); applyPanels(); }
    // Click anywhere on a panel's title bar to collapse/expand it.
    document.querySelectorAll('.panel > header[data-toggle]').forEach((h) => {
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      h.addEventListener('click', () => togglePanel(h.dataset.toggle));
      h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePanel(h.dataset.toggle); } });
    });
    applyPanels();

    $('bermBtn').addEventListener('click', handlers.berm);
    // (HABs and Landing Pads are in the build menu like everything else.)
    $('roverBtn').addEventListener('click', handlers.rover);
    // AMS: "🏥 Heal" buttons, and click a card to pick that astronaut (redrawn every game hour, so listen on the container).
    $('ams').addEventListener('click', (e) => {
      const b = e.target.closest('[data-heal]');
      if (b) { if (handlers.heal) handlers.heal(+b.dataset.heal); return; }
      const row = e.target.closest('[data-crew]');
      if (row) selectCrew(selectedCrew === +row.dataset.crew ? null : +row.dataset.crew);
    });
    $('crewPick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-crew]');
      if (b && !b.disabled) selectCrew(selectedCrew === +b.dataset.crew ? null : +b.dataset.crew);
    });
    $('shelterBtn').addEventListener('click', handlers.shelter);
    document.querySelectorAll('.speed button').forEach((b) => b.addEventListener('click', () => handlers.speed(+b.dataset.speed)));

    // ----- bars -----
    const barDefs = [
      // Only astronauts who are not in the medbay eat and breathe.
      { key: 'o2', label: '🫁 Oxygen', unit: 'kg', max: () => C.caps.o2, perH: (s) => C.use.o2PerPersonH * Math.max(1, LW.Sim.activeCrew(s).length) },
      { key: 'food', label: '🍞 Food', unit: 'kg', max: () => 150, perH: (s) => C.use.foodPerPersonH * Math.max(1, LW.Sim.activeCrew(s).length) },
      { key: 'water', label: '💧 Water', unit: 'kg', max: () => C.caps.water, perH: null },
      { key: 'battery', label: '🔋 Battery', unit: 'kWh', max: (s) => Math.max(1, s.power.cap), perH: null },
      { key: 'crew', label: '❤️ Crew', unit: 'HP', max: () => 100 },
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
      cur = state;
      if (selectedCrew && !selCrew()) selectCrew(null); // sent home to Earth, or in the medbay for good
      const h = state.hour;
      $('clockDay').textContent = `Day ${Math.floor(h / 24) + 1}`;
      $('clockHour').textContent = String(h % 24).padStart(2, '0') + ':00';
      $('scenarioTag').textContent = state.scenario === 'history' ? (h < C.chunkH ? 'REAL DATA: May 2024' : 'After May 2024: random') : 'Training mission';
      $('scenarioTag').className = 'tag' + (state.scenario === 'history' ? ' real' : '');

      for (const b of barDefs) {
        let v, frac, level = 'ok', text;
        if (b.key === 'crew') {
          const cs = LW.Sim.crewSummary(state);
          frac = cs.avgHp / 100; level = cs.active < cs.total || cs.avgHp < 40 ? 'bad' : cs.avgHp < 70 ? 'warn' : 'ok';
          text = `${cs.active}/${cs.total} · ${Math.round(cs.avgHp)} HP`;
        } else if (b.key === 'temp') { v = state.habTemp; frac = Math.max(0, (v - 0) / 21); level = v < 12 ? 'bad' : v < 19 ? 'warn' : 'ok'; text = `${r1(v)} °C`; }
        else {
          v = state.res[b.key]; frac = v / b.max(state);
          text = `${Math.round(v)} ${b.unit}`;
          if (b.perH) { const d = v / b.perH(state) / 24; text += ` · ${r1(d)} d`; level = d < 2 ? 'bad' : d < 4 ? 'warn' : 'ok'; }
          else level = frac < 0.15 ? 'bad' : frac < 0.35 ? 'warn' : 'ok';
        }
        b.val.textContent = text;
        b.fill.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
        b.el.dataset.level = level;
      }

      const P = state.power;
      $('powerLine').textContent = `${r1(P.supply)} / ${r1(P.use)} kW`;
      $('powerLine').title = `Solar is making ${r1(P.supply)} kW, the base is using ${r1(P.use)} kW`;
      const maxP = Math.max(P.supply, P.use, 1);
      $('powerBar').querySelector('.make').style.width = (P.supply / maxP) * 100 + '%';
      $('powerBar').querySelector('.use').style.width = (P.use / maxP) * 100 + '%';
      $('powerBar').dataset.level = P.use > P.supply + 0.01 ? (state.res.battery > 0.01 ? 'warn' : 'bad') : 'ok';

      syncBanners(state);
      $('parts').textContent = state.res.parts;
      syncBuildMenu();
      if (selected && state.res.parts < C.modules[selected].cost) select(null);
      renderCrewPick(state);
      renderActions(state);
      const sb = $('shelterBtn');
      const hasS = LW.Sim.hasShelter(state);
      sb.disabled = !hasS || state.status !== 'running';
      sb.classList.toggle('active', state.sheltering);
      sb.innerHTML = !hasS ? '🛡️ Send crew to shelter <small>(build a Storm Shelter first)</small>'
        : state.sheltering ? '👩‍🚀 Crew is in the shelter: click to go back to work' : '🛡️ Send crew to shelter';

      // Work queue: each job has the one Engineer the player picked.
      const jobs = LW.Sim.jobList(state);
      const jobName = (j) => j.kind === 'berm' ? `${LW.Sim.habName(state, j.m)} shielding` : (j.kind === 'repair' ? 'Repair ' : '') + C.modules[j.m.type].name;
      const why = (a) => a.heal ? ' (resting in the medbay)' : LW.Sim.isGrounded(a) ? ' (grounded: weak bones)' : a.where === 'gym' ? ' (training first)' : '';
      let jl = '';
      if (jobs.length) {
        if (state.sheltering) jl = `⏸ ${jobs.length} job${jobs.length > 1 ? 's' : ''} paused: crew is in the shelter.`;
        else {
          jl = jobs.map((j) => j.active ? `🔧 ${j.worker.name}: ${jobName(j)} (~${Math.ceil((j.total - j.done) / (LW.Sim.isSlow(j.worker) ? C.astro.stress.slowFactor : 1))} h left)`
            : j.worker ? `⏳ ${j.worker.name} next: ${jobName(j)}${why(j.worker)}`
              : `❔ ${jobName(j)}: no Engineer! Pick one, then click it${j.kind === 'berm' ? ' (the habitat)' : ''}.`).join('\n');
        }
      }
      $('jobLine').textContent = jl;
      // Research upgrades (they only work near a Research Bay).
      const R = C.research;
      $('researchLine').textContent = LW.Sim.built(state, 'lab').length || R.targets.some((t) => state.research[t])
        ? `🔬 Upgrades near a Research Bay: ${R.targets.map((t) => `${C.modules[t].icon} ${1 + state.research[t] * R.levelBoost}x`).join(' · ')} · next costs ${LW.Sim.researchCost(state)} parts`
        : '';
      renderAms(state);

      // cause chains
      const chains = LW.Sim.causeChains(state);
      $('chains').innerHTML = chains.length
        ? chains.map((ch) => '<div class="chain">' + ch.map((it) => `<div class="link ${it.level}"><span>${it.icon}</span>${esc(it.text)}</div>`).join('<div class="arrow">↓</div>') + '</div>').join('')
        : '<div class="link ok"><span>✅</span>All systems OK. Power, air, food and water are balanced.</div>';

      // log
      const items = state.log.slice(-9).reverse();
      $('log').innerHTML = items.map((l) => `<li class="${l.level}"><b>D${Math.floor(l.h / 24) + 1} ${String(l.h % 24).padStart(2, '0')}h</b> ${esc(l.text)}</li>`).join('');
    }

    // ----- Build panel buttons: rover, moon-dirt shield (they depend on who is picked) -----
    function renderActions(state) {
      const running = state.status === 'running';
      const rb = $('roverBtn'), rv = state.rover, n = LW.Sim.habs(state).length;
      if (!rv) {
        rb.disabled = !running || state.res.parts < C.rover.cost;
        rb.innerHTML = `🚙 Build a rover <small>(${C.rover.cost} parts · fast travel between HABs)</small>`;
      } else {
        const at = state.modules.find((m) => m.id === rv.habId);
        rb.disabled = !running || !!rv.trip;
        rb.innerHTML = rv.trip ? '🚙 Rover is driving…' : `🚙 Rover at ${LW.Sim.habName(state, at)}: fast travel <small>(${n > 1 ? `up to ${C.rover.seats} astronauts` : 'needs a 2nd HAB'})</small>`;
      }
      // The shield goes on the picked astronaut's HAB (or HAB 1).
      const a = selCrew(), H = a ? LW.Sim.homeOf(state, a) : LW.Sim.habs(state)[0], B = H.berm;
      const name = n > 1 ? LW.Sim.habName(state, H) : 'habitat';
      const bb = $('bermBtn');
      bb.disabled = B.built || B.building || !running;
      bb.innerHTML = B.built ? `⛰️ ${n > 1 ? name : 'Habitat'} shielded ✓ <small>(blocks 80% of radiation)</small>`
        : B.building ? `⛰️ Piling moon dirt on ${name}… ${Math.round((B.progress / C.bermWork) * 100)}%`
          : `⛰️ Shield ${name} with moon dirt <small>(0 parts, 36 crew-hours, pick an Engineer first)</small>`;
    }

    // ----- astronaut picker at the top of the Build panel -----
    let lastPick = '';
    function statusOf(a, jobs, state) {
      if (a.medbay) return 'in the medbay';
      if (a.trip) return 'in the rover';
      if (a.heal) return `healing ${Math.ceil(a.heal.left)} h`;
      if (a.task) return { lab: 'researching', greenhouse: 'in greenhouse', tower: 'at the tower' }[a.task.kind] + (a.task.kind === 'tower' ? '' : ` ${a.task.left} h`);
      if (a.where === 'shelter') return 'in the shelter';
      if (a.paused) return `${a.paused.kind === 'lab' ? 'research' : 'greenhouse'} on hold`;
      if (a.where === 'gym') return 'training';
      if (a.where === 'outside') return LW.Sim.walkLeft(a, state.hour - 1) > 0 ? 'walking to a job' : 'working outside';
      const queued = jobs.filter((j) => j.assignee === a.id).length;
      return queued ? `${queued} job${queued > 1 ? 's' : ''} waiting` : 'free';
    }
    function renderCrewPick(state) {
      const jobs = LW.Sim.jobList(state);
      const html = state.crew.map((a) => {
        const r = RI[a.role];
        return `<button class="crewBtn${selectedCrew === a.id ? ' sel' : ''}" data-crew="${a.id}"${a.medbay ? ' disabled' : ''} style="--rc:${r.color}" title="${esc(a.name)}: ${r.name}, ${r.does}. (Shift+${a.id})">` +
          `<span class="amsId">${a.id}</span><span class="cr">${r.icon} ${r.name}</span><small>${esc(statusOf(a, jobs, state))}</small></button>`;
      }).join('');
      if (html !== lastPick) { $('crewPick').innerHTML = html; lastPick = html; }
    }

    // ----- Astronaut Management System: one compact card per astronaut (the list scrolls when it is long) -----
    let lastAms = '';
    function renderAms(state) {
      const A = C.astro, jobs = LW.Sim.jobList(state);
      const M = A.medbay, usesLeft = M.uses - state.medbayUses;
      const manyHabs = LW.Sim.habs(state).length > 1;
      const place = (a) => {
        if (a.medbay) return '🏥 In the medbay for good (bones too weak)';
        if (a.trip) { const t = state.rover && state.rover.trip, to = t && state.modules.find((m) => m.id === t.to); return `🚙 Riding the rover${to ? ' to ' + LW.Sim.habName(state, to) : ''}`; }
        if (a.heal) return `🏥 Healing in the medbay (+${Math.round(a.heal.amount)} HP) · ${Math.ceil(a.heal.left)} h left`;
        if (a.task && a.task.kind === 'lab') return `🔬 Researching faster ${C.modules[a.task.target].name}s · ${a.task.left} h left`;
        if (a.task && a.task.kind === 'greenhouse') return `🌱 Tending the greenhouse (${C.botany.mult}x food) · ${a.task.left} h left`;
        if (a.task && a.task.kind === 'tower') return '🔭 Looking through the Astronomy Tower';
        const held = a.paused ? ` · ⏸ ${a.paused.kind === 'lab' ? 'research' : 'greenhouse work'} on hold (${a.paused.left} h left)` : '';
        if (a.where === 'shelter') return '🛡️ In the storm shelter' + held;
        if (a.paused) return `⏸ ${a.paused.kind === 'lab' ? `Research on faster ${C.modules[a.paused.target].name}s` : 'Greenhouse work'} on hold (${a.paused.left} h left): pick them and click the ${a.paused.kind === 'lab' ? 'Research Bay' : 'greenhouse'} to continue`;
        if (a.where === 'gym') return '🏋️ Training in the Fitness Center';
        if (a.where === 'outside') {
          const j = jobs.find((x) => x.key === a.job);
          const what = !j ? 'working' : j.kind === 'berm' ? 'piling moon dirt' : (j.kind === 'repair' ? 'repairing ' : 'building ') + C.modules[j.m.type].name;
          const w = LW.Sim.walkLeft(a, state.hour - 1);
          if (j && w > 0) return `🚶 On the way: ${what} · ${w < 1 ? '<1' : '~' + Math.ceil(w)} h`;
          return '🔧 Outside: ' + what;
        }
        const queued = jobs.filter((j) => j.assignee === a.id).length;
        return `🏠 In ${manyHabs ? LW.Sim.habName(state, LW.Sim.homeOf(state, a)) : 'the habitat'}` + (queued ? ` · ${queued} job${queued > 1 ? 's' : ''} waiting` : '');
      };
      const pct = (v) => Math.max(0, Math.min(100, v)).toFixed(1);
      const bar = (label, v, lvl, title) => `<div class="amsStat" data-level="${lvl}" title="${esc(title)}"><span>${label}</span><div class="track"><div class="fill" style="width:${pct(v)}%"></div></div><b>${Math.round(v)}</b></div>`;
      // Health bar: colour = health now; PURPLE from the right = radiation damage (can never be healed);
      // the empty part in between = injuries the medbay could heal.
      const hpBar = (a, lvl) => {
        const cap = LW.Sim.maxHp(a);
        const title = `Health ${Math.round(a.hp)} HP. Radiation so far: ${Math.round(a.dose)} mSv (600 mSv = all health). ` +
          `PURPLE = radiation damage, it never heals: the most this astronaut can ever get back to is ${Math.round(cap)} HP. ` +
          (a.wounds.length ? `Injuries: ${a.wounds.map((w) => `${w.what} -${Math.round(w.hp)}`).join(', ')}. The medbay heals ${A.medbay.healHp} HP per treatment.` : 'No injuries.');
        return `<div class="amsStat" data-level="${lvl}" title="${esc(title)}"><span>❤️</span><div class="track hpTrack"><div class="fill" style="width:${pct(a.hp)}%"></div><div class="radCap" style="width:${pct(100 - cap)}%"></div></div><b>${Math.round(a.hp)}</b></div>`;
      };
      const home = state.sentHome || [];
      const html = `<div class="amsTop" title="The medbay can give ${M.uses} treatments, and every crew spaceship restocks it. Each takes ${M.healH / 24} days and heals ${M.healHp} HP of injuries (never past the purple radiation limit).">🏥 Medbay: <b>${usesLeft}/${M.uses}</b> · 👩‍🚀 Crew: <b>${LW.Sim.activeCrew(state).length}</b>` +
        (home.length ? ` · <span title="Medically retired (health ran out): ${home.map((a) => esc(a.name)).join(', ')}">🚀 Sent home: <b>${home.length}</b></span>` : '') + '</div>' + state.crew.map((a) => {
        // Flags are just icons (hover for the full text) to keep each card small.
        const flags = [];
        const B = A.bone, flag = (lvl, icon, title) => flags.push(`<span class="flag ${lvl}" title="${esc(title)}">${icon}</span>`);
        if (!a.medbay && LW.Sim.isSlow(a)) flag('warn', '😰', 'Slow: stress is high, works at half speed');
        if (!a.medbay && a.bone < B.severeBelow) flag('bad', '🦴', `Severe bone loss (below ${B.severeBelow}%): injuries ${B.severeMult}x, extra stress, training half as effective. At 0% they go to the medbay for good.`);
        else if (!a.medbay && a.bone < B.fragileBelow) flag('bad', '🦴', `Fragile bones (below ${B.fragileBelow}%): fractures ${B.fragileMult}x as likely and as harmful, extra stress, not allowed outside`);
        else if (!a.medbay && LW.Sim.isGrounded(a)) flag('bad', '🦴', `Grounded: bone density below ${B.groundedBelow}%, not allowed outside`);
        else if (!a.medbay && a.bone < B.injuryBelow) flag('warn', '🦴', `Weak bones: below ${B.injuryBelow}%, can get small injuries`);
        if (!a.medbay && a.sinceGym >= B.visitEveryH && a.where !== 'gym') flag('warn', '🏋️', `Needs training: no exercise for ${Math.floor(a.sinceGym)} hours. Pick them and click a Fitness Center (2 h).`);
        let healBtn = '';
        if (!a.medbay && !a.heal && a.wounds.length) {
          const amt = LW.Sim.healAmount(a);
          const capped = amt < M.healHp ? ` Only ${Math.round(amt)} HP here: health can't go past the purple radiation limit.` : '';
          healBtn = usesLeft > 0
            ? `<button class="healBtn" data-heal="${a.id}" title="Rest ${M.healH / 24} days in the medbay to heal ${M.healHp} HP of injuries.${capped} Uses 1 of ${usesLeft} treatments left.">🏥 +${Math.round(amt)}</button>`
            : '<span class="muted small" title="Medbay supplies used up until the next crew spaceship">🏥 0</span>';
        }
        const hpL = a.hp < 25 ? 'bad' : a.hp < 50 ? 'warn' : 'ok';
        const stL = a.stress >= A.stress.slowAt ? 'bad' : a.stress >= 50 ? 'warn' : 'ok';
        const boL = a.bone < A.bone.groundedBelow ? 'bad' : a.bone < A.bone.injuryBelow ? 'warn' : 'ok';
        const r = RI[a.role], where = place(a);
        return `<div class="amsRow${a.medbay ? ' gone' : ''}${selectedCrew === a.id ? ' sel' : ''}"${a.medbay ? '' : ` data-crew="${a.id}" title="Click to pick ${esc(a.name)}"`}>
          <div class="amsHead"><span class="amsId" style="--rc:${r.color}" title="${r.name}: ${r.does}">${a.id}</span><span class="rIco" title="${r.name}">${r.icon}</span><b>${esc(a.name)}</b>${flags.join('')}${healBtn}</div>
          <div class="amsWhere" title="${esc(where)}">${where}</div>
          ${a.medbay ? '' : '<div class="amsBars">' + hpBar(a, hpL)
            + bar('😰', a.stress, stL, `Stress ${Math.round(a.stress)}. Goes up when working alone outside and when caught in storms or meteor showers. At ${A.stress.slowAt}+ they work at half speed. A visit to an Astronomy Tower lowers it by ${A.stress.towerRelief}; training in a Fitness Center lowers it by ${A.stress.gymReliefPerH} per hour.`)
            + bar('🦴', a.bone, boL, `Bone density ${Math.round(a.bone)}%. Drops in Moon gravity; the Fitness Center builds it back. Below ${A.bone.injuryBelow}%: injuries. ${A.bone.groundedBelow}%: grounded. ${A.bone.fragileBelow}%: fragile (fractures). ${A.bone.severeBelow}%: severe. 0%: medbay for good.`) + '</div>'}
        </div>`;
      }).join('');
      if (html !== lastAms) { $('ams').innerHTML = html; lastAms = html; }
    }

    function capcom(ev) {
      $('capcomText').textContent = (ev.title || '') + (ev.text ? (ev.title ? ' — ' : '') + ev.text : '');
      const el = $('capcom');
      el.dataset.level = ev.level;
      if (el.classList.contains('collapsed')) el.classList.add('unread'); // show a dot on the CAPCOM button
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }

    function setSpeed(s) { document.querySelectorAll('.speed button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === s)); }

    // ----- tooltip -----
    function tooltip(state, tile, show) {
      const tip = $('tooltip');
      if (!show || !tile || tile.c < 0 || tile.r < 0 || tile.c >= C.map.cols || tile.r >= C.map.rows) { tip.hidden = true; return; }
      const m = LW.Sim.moduleAt(state, tile.c, tile.r);
      let html;
      if (m) {
        const d = C.modules[m.type];
        const lines = [];
        const R = C.research, nameOf = (id) => { const a = state.crew.find((x) => x.id === id); return a ? esc(a.name) : 'nobody'; };
        const there = (kind) => state.crew.find((a) => !a.medbay && a.task && a.task.kind === kind && a.task.id === m.id);
        if (!m.built) {
          const w = m.worker && state.crew.find((a) => a.id === m.worker && !a.medbay);
          lines.push(`Being built: ${Math.round((m.progress / d.work) * 100)}%`, w ? `👷 ${esc(w.name)}'s job` : '❔ No Engineer yet',
            '<i>Pick an Engineer and click to give them this job. Click with nobody picked to cancel (parts back).</i>');
        } else {
          if (m.type === 'solar') {
            const L = m.light || 0, kw = r1(LW.Sim.solarKw(state, m));
            lines.push(L > 0.98 ? `☀️ Full sunlight: making ${kw} kW` : L > 0.02 ? `🌗 Sun going behind a hill (${Math.round(L * 100)}%): making ${kw} kW` : '🌑 In shadow: making 0 kW');
            if (m.dustLeft > 0) lines.push(`🟫 Covered in moondust: half power for ${m.dustLeft} h`);
          }
          else if (m.type === 'battery') lines.push(`Base battery: ${Math.round(state.res.battery)} / ${state.power.cap} kWh`);
          else if (m.type === 'shelter') lines.push(state.sheltering ? 'Crew is inside' : 'Empty. Use it during radiation storms.');
          else if (m.type === 'tower') {
            const wait = LW.Sim.towerReadyIn(state, m), v = there('tower');
            if (v) lines.push(`🔭 ${esc(v.name)} is looking at the sky`);
            if (!m.damaged) lines.push(wait ? `⏳ Can be used again in ${wait} h` : `✅ Ready. Next picture: ${state.towerVisits ? "from NASA's archive (since 1995)" : "today's Astronomy Picture of the Day"}`,
              `<i>Pick an astronaut, then click: THEIR stress -${C.astro.stress.towerRelief}. Each tower works every ${C.astro.stress.towerCooldownH} h.</i>`);
          } else if (m.type === 'lab') {
            const s = there('lab');
            lines.push(`Upgrades: ${R.targets.map((t) => `${C.modules[t].icon} ${1 + state.research[t] * R.levelBoost}x`).join(' · ')}`);
            const held = state.crew.find((a) => !a.medbay && a.paused && a.paused.kind === 'lab');
            lines.push(s ? `🔬 ${esc(s.name)} is researching faster ${C.modules[s.task.target].name}s: ${s.task.left} h left`
              : held ? `⏸ Research on hold (${held.paused.left} h left): pick ${esc(held.name)} and click to continue` : '💤 Nobody researching');
            if (!m.damaged) lines.push(`Boosts machines within ${R.radius} tiles (dashed circle).`, `<i>Pick the Scientist, then click to research (next upgrade: ${LW.Sim.researchCost(state)} parts, 1 day).</i>`);
          } else if (m.type === 'pad') {
            const ok = LW.Sim.landingSpots(state).some((sp) => sp.pad === m);
            lines.push(ok ? '✅ Ready: a finished HAB is close enough. Crew spaceships can land here.' : `⚠️ No finished HAB within ${C.pad.radius} squares: spaceships can't land here yet.`);
            const next = (state.ships || []).find((sh) => !sh.arrived);
            if (next) lines.push(`Next crew spaceship: day ${Math.floor(next.h / 24) + 1}`);
          } else lines.push(!m.on ? 'Turned OFF by you' : m.powered ? `✅ Running (uses ${r1(LW.Sim.needOf(state, m))} kW)` : '⚡ NO POWER');
          if (R.targets.includes(m.type) && state.research[m.type]) {
            const x = 1 + state.research[m.type] * R.levelBoost;
            lines.push(LW.Sim.inLabRange(state, m) ? `🔬 Research boost: ${x}x` : `🔬 Too far from a working Research Bay for the ${x}x upgrade`);
          }
          if (m.type === 'greenhouse') {
            const b = there('greenhouse');
            const held = state.crew.find((a) => !a.medbay && a.paused && a.paused.kind === 'greenhouse');
            lines.push(b ? `🌱 ${esc(b.name)} is tending it: ${C.botany.mult}x food (${b.task.left} h left)`
              : held ? `⏸ ${esc(held.name)}'s greenhouse work is on hold (${held.paused.left} h left): pick them and click to continue`
                : `<i>Pick the Botanist and click: ${C.botany.mult}x food for 1 day.</i>`);

          }
          if (m.type === 'gym') {
            const who = state.crew.find((a) => a.where === 'gym' && a.gymId === m.id);
            lines.push(who ? `🏋️ ${esc(who.name)} is training` : 'Empty right now', '<i>Pick an astronaut and click to send them to train now.</i>');
          }
          if (m.noWater) lines.push('💧 No water!');
          if (m.damaged) {
            lines.push(['gym', 'tower', 'lab'].includes(m.type) ? '🔧 DAMAGED: cannot be used' : '🔧 DAMAGED: works at half speed');
            lines.push(m.repair ? `Repair (${nameOf(m.repair.worker)}): ${Math.round((m.repair.progress / m.repair.work) * 100)}%` : `<i>Pick an Engineer, then click to repair (${C.damage.repairCost} part).</i>`);
          } else if (!['hab', 'battery', 'shelter', 'tower', 'lab', 'pad'].includes(m.type)) lines.push(`<i>Click${['greenhouse', 'gym'].includes(m.type) ? ' with nobody picked' : ''} to turn ${m.on ? 'OFF' : 'ON'}</i>`);
          if (m.type === 'hab') {
            const who = state.crew.filter((a) => LW.Sim.homeOf(state, a) === m);
            lines.unshift(`<b>${LW.Sim.habName(state, m)}</b> · ${r1(m.temp)} °C${m.temp < C.habTemp.fail ? ' 🥶 TOO COLD: crew inside lose health!' : ''} · ${m.berm.built ? '⛰️ shielded' : 'not shielded'}`,
              `Lives here: ${who.length ? who.map((a) => esc(a.name)).join(', ') : 'nobody'}`);
            if (state.rover && state.rover.habId === m.id && !state.rover.trip) lines.push('🚙 The rover is parked here');
          }
          if (m.type === 'hab' && m.berm.building && !m.berm.built) lines.push(`⛰️ Shield: ${nameOf(m.berm.worker)}'s job. <i>Pick an Engineer and click to give it to them.</i>`);
        }
        html = `<b>${d.icon} ${esc(d.name)}</b><br>${esc(d.desc)}<br>${lines.join('<br>')}`;
      } else {
        const z = LW.Sim.zoneOf(state, tile.c, tile.r), Z = C.zones[z];
        const lit = LW.Sim.zoneLitAt(state, z, state.hour);
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

    // saves (optional): { list: Promise of saves on this device, onLoad(slot), onImport(), onLoadList() }
    function showStart(onChoose, saves) {
      modal(`
        <h1>Lunar World</h1>
        <p class="lead">You are the commander of Zain Base, a Moon base near the lunar south pole, where NASA's Artemis astronauts plan to go. Keep the base running for <b>as many days as you can</b>. It only closes when no astronaut is left on the Moon.</p>
        <div class="saveRow" hidden></div>
        <div class="howto">
          <div>☀️ <b>Power</b>: the Sun circles the horizon here. Hills block it, so shadows move. Panels in shadow make nothing.</div>
          <div>🫁 <b>Air</b>: the O₂ Generator turns water into oxygen. It needs power AND water.</div>
          <div>🍞 <b>Food</b>: greenhouses grow food but need lots of power.</div>
          <div>☢️ <b>Radiation</b>: solar flares can send radiation storms. Hide the crew in a shelter.</div>
          <div>👩‍🚀 <b>Crew</b>: always <b>pick an astronaut first</b>, then what to build or use. Engineers (1, 2) build and repair, the Scientist (3) researches upgrades, the Botanist (4) tends the greenhouse.</div>
          <div>🚀 <b>Every 30 days</b> a crew spaceship brings 2 new astronauts, but it can only land on a <b>Landing Pad</b> next to a HAB (your base starts with one). Build more HABs for more room, and a <b>rover</b> to drive astronauts between them.</div>
          <div>☄️ <b>Meteor showers</b> and <b>accidents</b> (leaks, plant disease, moondust) cost buildings and supplies. A Research Bay makes nearby machines faster.</div>
        </div>
        <div class="choices">
          <button class="choice" data-s="training"><span class="big">🎓</span><b>Training mission</b><span>Random space weather. Every radiation storm is a copy of a real one NASA measured at the Moon.</span></button>
          <button class="choice real" data-s="history"><span class="big">📡</span><b>Real history: May 2024</b><span>Replay the real solar storms of May 2024 (biggest in 20 years): NASA DONKI alerts and the radiation NASA's LRO measured at the Moon, hour by hour.</span></button>
        </div>`);
      $('modalBody').querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => { closeModal(); onChoose(b.dataset.s); }));
      if (saves) fillSaveRow($('modalBody').querySelector('.saveRow'), saves);
    }

    // ----- saves -----
    const SLOT_NAMES = { manual: '💾 Your save', 'auto-0': '🔄 Autosave', 'auto-1': '🔄 Autosave', exit: '🚪 Saved when you left' };
    function ago(iso) {
      const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
      if (!isFinite(s)) return '';
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      const d = Math.floor(s / 86400);
      return d === 1 ? 'yesterday' : `${d} days ago`;
    }
    const saveLine = (e) => `${esc(e.name)} <span class="muted small">· ${e.summary ? `${e.summary.crew} astronaut${e.summary.crew === 1 ? '' : 's'} · ` : ''}${SLOT_NAMES[e.slot] || ''} · saved ${ago(e.savedAt)}</span>`;

    // Start menu: "Continue" (newest save), "Other saves", "Load from file". Filled in when the list arrives.
    function fillSaveRow(row, saves) {
      const body = $('modalBody').firstElementChild;
      const show = (list) => {
        if (!row.isConnected || $('modalBody').firstElementChild !== body) return; // the menu was closed meanwhile
        row.innerHTML = (list.length ? `<button class="primary cont" data-a="cont">▶ Continue: ${saveLine(list[0])}</button>` : '') +
          `<div class="row tight">${list.length > 1 ? `<button data-a="list">📂 Other saves (${list.length - 1})</button>` : ''}<button data-a="import">📥 Load from a file</button></div>`;
        row.hidden = false;
        const on = (a, fn) => { const b = row.querySelector(`[data-a=${a}]`); if (b) b.addEventListener('click', fn); };
        on('cont', () => saves.onLoad(list[0].slot));
        on('list', () => saves.onLoadList());
        on('import', () => saves.onImport());
      };
      saves.list.then(show, () => show([]));
    }

    /**
     * The 💾 menu during a game (the game waits while it is open).
     * h: { save, exportFile, loadList, importFile, mainMenu, close }. Returns { say(text, level) }.
     */
    function showGameMenu(state, h) {
      modal(`
        <h2>💾 Game menu</h2>
        <p class="lead">Day ${LW.Sim.day(state.hour)} · the game is paused. Saves stay in this browser on this device. To play on another computer, save to a file and load it there.</p>
        <div class="choices">
          <button class="choice" data-a="save"><span class="big">💾</span><b>Save now</b><span>Replaces "Your save". (The game also saves by itself every ${C.save.autoEveryH / 24} days.)</span></button>
          <button class="choice" data-a="export"><span class="big">📤</span><b>Save to a file</b><span>Download a .json file you can take to another computer.</span></button>
          <button class="choice" data-a="load"><span class="big">📂</span><b>Load a save</b><span>Go back to a saved game on this device.</span></button>
          <button class="choice" data-a="import"><span class="big">📥</span><b>Load from a file</b><span>Open a .json save file.</span></button>
        </div>
        <p class="saveMsg" aria-live="polite"></p>
        <div class="row"><button class="primary" data-a="close">▶ Back to the game</button><button data-a="menu">Main menu</button></div>`);
      const say = (text, level) => { const p = $('modalBody').querySelector('.saveMsg'); if (p) { p.textContent = text; p.className = 'saveMsg ' + (level || ''); } };
      const on = (a, fn) => $('modalBody').querySelector(`[data-a=${a}]`).addEventListener('click', fn);
      on('save', () => h.save());
      on('export', () => h.exportFile());
      on('load', () => h.loadList());
      on('import', () => h.importFile());
      on('close', () => { closeModal(); h.close(); });
      on('menu', () => { closeModal(); h.mainMenu(); });
      return { say };
    }

    /** Every save on this device. onPick(slot); onBack() returns to the menu that opened this. */
    function showLoad(list, onPick, onBack) {
      modal(`
        <h2>📂 Saved games on this device</h2>
        ${list.length ? `<div class="saveList">${list.map((e) => `<button class="saveItem" data-slot="${esc(e.slot)}">${saveLine(e)}</button>`).join('')}</div>`
          : '<p class="muted">No saved games yet. The game saves by itself every ' + C.save.autoEveryH / 24 + ' days, or use 💾 Save now.</p>'}
        <p class="saveMsg" aria-live="polite"></p>
        <div class="row"><button data-a="back">← Back</button></div>`);
      $('modalBody').querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.slot)));
      $('modalBody').querySelector('[data-a=back]').addEventListener('click', () => onBack());
      return { say: (text, level) => { const p = $('modalBody').querySelector('.saveMsg'); if (p) { p.textContent = text; p.className = 'saveMsg ' + (level || ''); } } };
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
      const view = LW.APOD.show($('modalBody').querySelector('.apod'), opts);
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

    // ----- an astronaut's health ran out: medically retired, sent home to Earth (the game waits) -----
    function showSentHome(ev, onClose) {
      const dose = Math.round(ev.dose), inj = Math.round(ev.injury || 0);
      modal(`
        <h2>🚀 ${esc(ev.who)} is going home to Earth</h2>
        <p class="lead">${esc(ev.who)}'s health bar is empty: <b>${dose} mSv</b> of radiation${inj ? ` plus ${inj} HP of injuries` : ''}. NASA's limit for a whole astronaut career is 600 mSv.</p>
        <p>${esc(ev.who)} is <b>medically retired</b> from Moon missions. A lander is taking them back to Earth, where doctors will look after them. They are no longer part of the crew.</p>
        <p class="muted">${ev.left ? `${ev.left} astronaut${ev.left > 1 ? 's' : ''} left at the base. If every astronaut is sent home, the mission ends.` : 'Nobody is left at the base.'}</p>
        <div class="row"><button class="primary" data-a="ok">OK</button></div>`);
      $('modalBody').querySelector('[data-a=ok]').addEventListener('click', () => { closeModal(); onClose(); });
    }

    // ----- crew spaceship landing: a cartoon spaceship touches down on the map (plays over both views) -----
    // TEMPORARY art: plain shapes, meant to be replaced with better models later.
    // at = {x, y}: where on the map (stage pixels) it touches down; default = the middle of the screen.
    function playLanding(onDone, text, at) {
      const el = document.createElement('div');
      el.className = 'landing';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `
        <div class="lShip">
          <svg viewBox="0 0 120 170" width="120" height="170">
            <path d="M60 4 C82 26 88 62 86 104 L34 104 C32 62 38 26 60 4Z" fill="#eef2f7" stroke="#8f96a3" stroke-width="3"/>
            <path d="M60 4 C70 14 76 26 79 40 L41 40 C44 26 50 14 60 4Z" fill="#ff6b5d"/>
            <circle cx="60" cy="64" r="12" fill="#7fd0ff" stroke="#5b6576" stroke-width="3"/>
            <path d="M34 80 L12 116 L14 128 L36 108Z M86 80 L108 116 L106 128 L84 108Z" fill="#ff6b5d" stroke="#b5463c" stroke-width="2"/>
            <rect x="44" y="104" width="32" height="10" rx="3" fill="#5b6576"/>
            <path d="M40 114 L28 150 M80 114 L92 150" stroke="#9aa2af" stroke-width="4" stroke-linecap="round"/>
            <path d="M22 150 L34 150 M86 150 L98 150" stroke="#9aa2af" stroke-width="4" stroke-linecap="round"/>
            <path class="lFlame" d="M48 116 Q60 168 72 116Z" fill="#ffb347"/>
          </svg>
        </div>
        <div class="lDust"></div>
        <div class="lText">${esc(text || '🚀 The crew spaceship has landed!')}</div>`;
      if (at) { el.style.setProperty('--lx', Math.round(at.x) + 'px'); el.style.setProperty('--ly', Math.round(at.y) + 'px'); }
      $('stage').appendChild(el);
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => { el.remove(); onDone(); }, reduce ? 900 : 3600);
    }

    // ----- new crew: the player picks the job of each new astronaut (the game waits) -----
    // ----- crew spaceship: which Landing Pad should it land on? (only asked when more than one is ready) -----
    function showPickPad(state, padIds, onPick) {
      const pads = padIds.map((id) => state.modules.find((m) => m.id === id)).filter(Boolean);
      const who = (H) => state.crew.filter((a) => LW.Sim.homeOf(state, a) === H).length;
      modal(`
        <h2>🛬 Where should the spaceship land?</h2>
        <p class="lead">${pads.length} Landing Pads are ready. The new astronauts will live in the HAB closest to the pad you pick.</p>
        <div class="choices">${pads.map((p) => {
          const H = LW.Sim.homeForPad(state, p.id);
          return `<button class="choice" data-pad="${p.id}"><span class="big">🛬</span><b>Pad next to ${LW.Sim.habName(state, H)}</b><span>${who(H)} astronaut${who(H) === 1 ? '' : 's'} live there now.</span></button>`;
        }).join('')}</div>`);
      $('modalBody').querySelectorAll('[data-pad]').forEach((b) => b.addEventListener('click', () => { closeModal(); onPick(+b.dataset.pad); }));
    }

    function showNewCrew(state, padId, onDone) {
      const n = state.pendingCrew, first = state.nextCrewId;
      // Their home is always the HAB closest to the Landing Pad they landed on.
      const home = LW.Sim.homeForPad(state, padId);
      const defaults = ['engineer', 'scientist', 'botanist'];
      const rows = Array.from({ length: n }, (_, i) => `
        <div class="newCrew"><b>Astronaut ${first + i}</b>
          <div class="roleChoice" role="radiogroup" aria-label="Job for Astronaut ${first + i}">
            ${Object.keys(RI).map((k) => `<button data-i="${i}" data-role="${k}" class="${k === defaults[i % 3] ? 'on' : ''}" style="--rc:${RI[k].color}" title="${RI[k].does}">${RI[k].icon} ${RI[k].name}</button>`).join('')}
          </div></div>`).join('');
      modal(`
        <h2>🚀 New crew has arrived!</h2>
        <p class="lead">The spaceship landed with <b>${n} new astronauts</b> and restocked the medbay (${C.astro.medbay.uses}/${C.astro.medbay.uses} treatments). Choose a job for each new astronaut:</p>
        ${rows}
        <p class="muted small">🔧 Engineers build and repair · 🔬 Scientists research upgrades · 🌱 Botanists tend greenhouses.</p>
        <p>🏠 They will live in <b>${LW.Sim.habName(state, home)}</b>, the HAB closest to the Landing Pad. Only a rover trip can move them to another HAB.</p>
        <div class="row"><button class="primary" data-a="ok">Welcome them</button></div>`);
      const roles = Array.from({ length: n }, (_, i) => defaults[i % 3]);
      $('modalBody').querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
        roles[+b.dataset.i] = b.dataset.role;
        $('modalBody').querySelectorAll(`[data-i="${b.dataset.i}"]`).forEach((x) => x.classList.toggle('on', x === b));
      }));
      $('modalBody').querySelector('[data-a=ok]').addEventListener('click', () => { closeModal(); onDone(roles); });
    }

    // ----- rover: pick up to 4 astronauts at the rover's HAB and where to drive (the game waits) -----
    function showRover(state, onGo) {
      const rv = state.rover, habs = LW.Sim.habs(state), at = habs.find((m) => m.id === rv.habId);
      const riders = LW.Sim.roverRiders(state), dests = habs.filter((m) => m !== at), seats = C.rover.seats;
      modal(`
        <h2>🚙 Rover at ${LW.Sim.habName(state, at)}</h2>
        <p class="lead">Pick up to <b>${seats}</b> astronauts who live at ${LW.Sim.habName(state, at)}, then where to drive. The rover stays at the HAB it drives to.</p>
        <div class="roverCrew">${riders.length ? riders.map((a) => `<label><input type="checkbox" value="${a.id}"> <span class="amsId" style="--rc:${RI[a.role].color}">${a.id}</span> ${esc(a.name)} <small class="muted">${RI[a.role].icon} ${RI[a.role].name}</small></label>`).join('') : '<p class="muted">Nobody at this HAB is free right now (busy, healing or on a 1-day task).</p>'}</div>
        <h3>Drive to</h3>
        <div class="roverDest">${dests.map((m, i) => `<label><input type="radio" name="dest" value="${m.id}"${i === 0 ? ' checked' : ''}> 🏠 ${LW.Sim.habName(state, m)}</label>`).join('')}</div>
        <p class="rWhy muted small"></p>
        <div class="row"><button class="primary" data-a="go">Drive</button><button data-a="close">Cancel</button></div>`);
      const body = $('modalBody'), why = body.querySelector('.rWhy');
      body.querySelectorAll('.roverCrew input').forEach((c) => c.addEventListener('change', () => {
        const on = body.querySelectorAll('.roverCrew input:checked');
        if (on.length > seats) { c.checked = false; why.textContent = `The rover has ${seats} seats.`; } else why.textContent = '';
      }));
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
      function done() { document.removeEventListener('keydown', onKey, true); closeModal(); }
      document.addEventListener('keydown', onKey, true);
      body.querySelector('[data-a=close]').addEventListener('click', done);
      body.querySelector('[data-a=go]').addEventListener('click', () => {
        const ids = [...body.querySelectorAll('.roverCrew input:checked')].map((c) => +c.value);
        const dest = body.querySelector('.roverDest input:checked');
        if (!ids.length) { why.textContent = 'Pick at least one astronaut.'; return; }
        done(); onGo(+dest.value, ids);
      });
    }

    // ----- Research Bay: choose what the Scientist researches (the game waits while this is open) -----
    function showResearch(state, who, onPick) {
      const R = C.research, cost = LW.Sim.researchCost(state);
      const rows = R.targets.map((t) => {
        const d = C.modules[t], lv = LW.Sim.plannedLevel(state, t), max = lv >= R.maxLevel;
        const all = LW.Sim.built(state, t), near = all.filter((m) => LW.Sim.inLabRange(state, m)).length;
        const now = 1 + lv * R.levelBoost, next = 1 + (lv + 1) * R.levelBoost;
        return `<button class="choice" data-t="${t}"${max || state.res.parts < cost ? ' disabled' : ''}><span class="big">${d.icon}</span>` +
          `<b>${esc(d.name)}s: ${max ? `${now}x (max)` : `${now}x → ${next}x`}</b>` +
          `<span>${max ? 'Fully upgraded.' : `${near} of ${all.length} are close enough to a Research Bay.`}${t === 'o2gen' ? ' Faster O₂ also uses water faster.' : ''}</span></button>`;
      }).join('');
      modal(`
        <h2>🔬 Research Bay</h2>
        <p class="lead">What should ${esc(who.name)} research? This upgrade costs <b>${cost} parts</b> (you have ${state.res.parts}). Each upgrade costs ${R.costStep} more than the one before.</p>
        <div class="choices three">${rows}</div>
        <p class="muted small">⚠️ ${esc(who.name)} works in the Research Bay for ${R.hours / 24} day (radiation like in the habitat). Sending the crew to the shelter puts the research on hold; pick ${esc(who.name)} and click the Research Bay again to finish it. Now and then an experiment causes a micro-explosion (-${R.accidentHp} HP). Only machines within ${R.radius} tiles of a working Research Bay get faster.</p>
        <div class="row"><button data-a="close">Cancel</button></div>`);
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
      function done(t) { document.removeEventListener('keydown', onKey, true); closeModal(); onPick(t); }
      document.addEventListener('keydown', onKey, true);
      $('modalBody').querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => done(b.dataset.t)));
      $('modalBody').querySelector('[data-a=close]').addEventListener('click', () => done(null));
    }

    // ----- drop-down banners on the map (the game keeps running; no "OK" needed) -----
    const BANNER_MS = 10000; // plain warnings slide away after 10 real seconds
    const MAX_BANNERS = 3;
    function closeBanner(el) {
      if (!el || el.classList.contains('closing')) return;
      el.classList.add('closing');
      setTimeout(() => el.remove(), 300);
    }
    function banner(ev) {
      const box = $('banners');
      const el = document.createElement('div');
      el.className = `banner ${ev.level}`;
      let html = `<button class="bClose" aria-label="Close">✕</button><b>${esc(ev.title)}</b><div class="bText">${esc(ev.text || '')}</div>`;
      if (ev.decision === 'cargo') {
        el.dataset.cargo = ev.cargoIndex;
        const C2 = C.cargoOptions;
        html += '<div class="bChoices">' + Object.keys(C2).map((k) => `<button data-c="${k}">${C2[k].icon} ${esc(C2[k].name)}<small>${esc(C2[k].text)}</small></button>`).join('') + '</div>' +
          '<div class="bNote">If you don\'t choose, Mission Control sends food.</div>';
      } else {
        html += '<div class="bTimer"></div>';
        el.style.setProperty('--ms', BANNER_MS + 'ms');
        setTimeout(() => closeBanner(el), BANNER_MS);
      }
      el.innerHTML = html;
      el.querySelector('.bClose').addEventListener('click', () => closeBanner(el));
      el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { handlers.cargo(ev.cargoIndex, b.dataset.c); closeBanner(el); }));
      box.prepend(el);
      const open = [...box.querySelectorAll('.banner:not(.closing)')];
      if (open.length > MAX_BANNERS) closeBanner(open.reverse().find((b) => !b.dataset.cargo) || open[0]);
    }
    // Cargo banners go away by themselves once the cargo is chosen or has landed.
    function syncBanners(state) {
      document.querySelectorAll('#banners .banner[data-cargo]').forEach((el) => {
        const k = state.cargo[+el.dataset.cargo];
        if (!k || k.choice || k.arrived) closeBanner(el);
      });
    }
    function clearBanners() { $('banners').innerHTML = ''; }

    function showDebrief(state, onRestart, onMenu) {
      const d = LW.Sim.debrief(state);
      const stars = d.won ? '⭐'.repeat(d.stars) + '☆'.repeat(3 - d.stars) : '';
      // Best run in this browser, per scenario.
      const days = Math.floor(state.hour / 24), bestKey = 'mt.best.' + state.scenario;
      let best = 0;
      try { best = +localStorage.getItem(bestKey) || 0; if (days > best) localStorage.setItem(bestKey, String(days)); } catch (e) { /* private mode */ }
      const record = days > best ? '🏆 New record!' : `Best so far: ${best} days`;
      const chain = d.chain.length ? '<h3>What happened (cause → effect)</h3><div class="timeline">' + d.chain.map((c) => `<div class="tl"><span class="when">${esc(c.when)}</span><span>${esc(c.text)}</span></div>`).join('<div class="arrow">↓</div>') + '</div>' : '';
      modal(`
        <h1 class="${d.won ? 'good' : 'bad'}">${d.won ? '🎉' : '🚨'} ${esc(d.title)}</h1>
        <p class="lead"><b>🌙 ${esc(d.subtitle)}</b> <span class="muted">${record}</span></p>
        ${stars ? `<div class="stars">${stars}</div>` : ''}
        ${chain}
        <h3>Mission charts</h3>
        <canvas id="debriefChart" width="640" height="170"></canvas>
        <div class="legend"><span style="--c:#58c4ff">Oxygen</span><span style="--c:#ffb86b">Food</span><span style="--c:#7fa8ff">Water</span><span style="--c:#5fe08a">Battery</span><span style="--c:#ff5d5d">Crew health (avg)</span></div>
        <div class="statGrid">
          <div><b>${d.stats.days}</b>days</div><div><b>${state.crewTotal}</b>astronauts in total</div><div><b>${d.stats.dose}</b>mSv per astronaut (avg)</div><div><b>${d.stats.foodMade}</b>kg food grown</div>
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
      const g = cv.getContext('2d'), W = cv.width, H = cv.height, Hs = state.history, n = Math.max(24, Hs.o2.length);
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
      line(Hs.battery, Math.max(1, ...Hs.battery), '#5fe08a'); line(Hs.hp || [], 100, '#ff5d5d');
      g.fillStyle = '#8b93a1'; g.font = '10px system-ui';
      const step = Math.max(1, Math.ceil(n / 24 / 6 / 5)) * 5; // about 6 day labels, whatever the length
      for (let d = step; d * 24 < n; d += step) { const x = ((d * 24) / n) * W; g.fillStyle = '#8b93a1'; g.fillRect(x, H - 4, 1, 4); g.fillText('Day ' + d, x + 3, H - 3); }
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
      setText($('clockDay'), `Day ${Math.floor(state.hour / 24) + 1}`);
      setText($('clockHour'), String(state.hour % 24).padStart(2, '0') + ':' + String(mins).padStart(2, '0'));
      const items = state.status === 'running' ? LW.Sim.upcoming(state, now) : [];
      const html = items.length
        ? items.map((it) => {
          const pct = Math.max(0, Math.min(100, (1 - it.left / it.total) * 100));
          return `<div class="cd ${it.level}"><span class="cdIco">${it.icon}</span><span class="cdText">${esc(it.label)} <b>${fmtLeft(it.left)}</b></span><span class="cdTrack"><span style="width:${pct.toFixed(1)}%"></span></span></div>`;
        }).join('')
        : '<div class="cd info"><span class="cdIco">✅</span><span class="cdText">Nothing incoming right now.</span></div>';
      if (html !== lastBar) { $('countdowns').innerHTML = html; lastBar = html; }
    }

    return {
      togglePanel, live, update, capcom, setSpeed, tooltip, showStart, showGameMenu, showLoad, closeModal, banner, clearBanners, showDebrief, showTower, showResearch, showSentHome, isModalOpen,
      playLanding, showNewCrew, showPickPad, showRover,


      select, pickBuild, selectCrew, nudge,
      get selected() { return selected; }, get selectedCrew() { return selectedCrew; },
    };

  }

  LW.UI = UI;
})(window);
