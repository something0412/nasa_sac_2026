// Simulation: the rules of the outpost. No drawing, no DOM. One step() = one game hour.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});
  const cfg = () => MT.CONFIG;

  // ---------- helpers ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const day = (h) => Math.floor(h / 24) + 1;
  const fmtDay = (h) => `Day ${day(h)}`;
  const round1 = (v) => Math.round(v * 10) / 10;

  function sunAz(state, h) {
    return (((state.sunStartAz + cfg().sun.degPerHour * h) % 360) + 360) % 360;
  }
  // How much sunlight reaches a zone, 0 (full shadow) .. 1 (full Sun).
  // Near the edge of a shadow arc the Sun is partly behind the hill, so light fades smoothly.
  const angDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  function zoneLight(state, zone, h) {
    const z = cfg().zones[zone];
    if (z.alwaysDark) return 0;
    const az = sunAz(state, h), F = cfg().sun.fadeDeg;
    let light = 1;
    for (const [a, b] of z.shadowArcs) {
      const inside = az >= a && az < b;
      const d = inside ? Math.min(az - a, b - az) : -Math.min(angDist(az, a), angDist(az, b)); // + inside, - outside
      light = Math.min(light, clamp(0.5 - d / (2 * F), 0, 1));
    }
    return light;
  }
  const zoneLitAt = (state, zone, h) => zoneLight(state, zone, h) > 0.5;

  // ---------- scenarios ----------
  // Real radiation measured by NASA's LRO (data/radlab.js), or null if that file is missing.
  const radlab = () => (root.RADLAB && root.RADLAB.storms && root.RADLAB.storms.length ? root.RADLAB : null);

  /** LRO orbit "extra uGy/h" -> mSv/h for a person on the surface (see rad.real in config.js). */
  function crewRate(extraMicroGyPerH) {
    const k = cfg().rad.real;
    return (extraMicroGyPerH / 1000) * k.sky * k.rbe;
  }

  function buildSpaceWeather(kind, rand) {
    const R = cfg().rad.storm;
    if (kind === 'history' && root.MAY2024) {
      const d = root.MAY2024;
      const lab = radlab();
      return {
        flares: d.flares.filter((f) => f.h < cfg().missionHours).map((f) => ({ h: f.h, cls: f.cls, date: f.t })),
        // DONKI storm times drive the warnings; the dose itself comes hour by hour from LRO (radCurve).
        storms: d.sepStorms.map((s) => ({ h: s.h, strong: s.strong, date: s.t, ...(s.strong ? R.strong : R.moderate) })),
        geomag: d.geomagStorms.filter((g) => g.h < cfg().missionHours),
        radCurve: lab && lab.may2024 ? lab.may2024.extra : null,
      };
    }
    // Random training mission: flares every 1-3 days. Bigger flares are more likely to send particles.
    const flares = [], storms = [];
    let h = 20 + rand() * 30;
    while (h < cfg().missionHours - 30) {
      const big = rand();
      const cls = big < 0.6 ? 'M' + (1 + rand() * 8.9).toFixed(1) : 'X' + (1 + rand() * (big > 0.93 ? 8 : 3)).toFixed(1);
      flares.push({ h: round1(h), cls });
      const mag = cls[0] === 'X' ? parseFloat(cls.slice(1)) * 10 : parseFloat(cls.slice(1));
      const chance = mag >= 50 ? 0.8 : mag >= 10 ? 0.25 : 0.05;
      if (rand() < chance) {
        const strong = mag >= 40 && rand() < 0.8;
        storms.push({ h: round1(h + 1 + rand() * 3), strong, ...(strong ? R.strong : R.moderate) });
      }
      h += 24 + rand() * 48;
    }
    // Make sure every mission has at least one strong storm (so the shelter matters).
    if (!storms.some((s) => s.strong)) {
      const f = flares[Math.floor(flares.length * (0.35 + rand() * 0.3))];
      f.cls = 'X' + (5 + rand() * 4).toFixed(1);
      storms.push({ h: round1(f.h + 2), strong: true, ...R.strong });
    }
    storms.sort((a, b) => a.h - b.h);
    giveRealShapes(storms, rand);
    return { flares, storms, geomag: [], radCurve: null };
  }

  /**
   * Training missions: every storm becomes a copy of a real storm LRO measured. "Strong" storms
   * use one of the big ones (Jan 2012, Mar 2012, Sep 2017); later strong storms in the same
   * mission are downgraded, because storms that big are rare (rad.maxBigStorms).
   */
  function giveRealShapes(storms, rand) {
    const lab = radlab();
    if (!lab) return;
    let big = 0;
    const pick = (size) => {
      const list = lab.storms.filter((s) => s.size === size);
      return list.length ? list[Math.floor(rand() * list.length)] : null;
    };
    for (const st of storms) {
      if (st.strong && big >= cfg().rad.maxBigStorms) st.strong = false;
      const real = pick(st.strong ? 'strong' : 'moderate');
      if (!real) continue;
      if (st.strong) big++;
      st.profile = real.extra;
      st.realName = real.name;
      st.realStart = real.start;
    }
  }

  // ---------- create ----------
  function create(opts) {
    const C = cfg();
    const scenario = (opts && opts.scenario) || 'training';
    const seed = (opts && opts.seed) || Math.floor(Math.random() * 1e9);
    const rand = rng(seed);
    const state = {
      seed, scenario, hour: 0, status: 'running', failure: null,
      sunStartAz: scenario === 'history' ? C.sun.startAz : C.sun.startAz + Math.floor(rand() * 40) - 10,
      tiles: [], modules: [], nextId: 1,
      res: { ...C.start },
      dose: 0, doseFrom: { background: 0, storm: 0, outside: 0 },
      habTemp: C.habTemp.normal, sheltering: false, berm: { built: false, progress: 0, building: false },
      foodOutH: 0, waterOutH: 0,
      cargo: C.cargo.map((c) => ({ h: c.h, choice: null, asked: false, arrived: false })),
      since: {}, log: [], warned: {},
      stats: { foodMade: 0, foodEaten: 0, o2Made: 0, waterMined: 0, unpoweredH: {}, darkH: 0, solarKwh: 0 },
      history: { o2: [], food: [], water: [], battery: [], dose: [], solar: [], use: [] },
      power: { supply: 0, use: 0, cap: 0 },
      stormRate: 0,
    };
    for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) state.tiles.push(C.zoneAt(c, r));

    const sw = buildSpaceWeather(scenario, rand);
    state.flares = sw.flares;
    state.storms = sw.storms;
    state.geomag = sw.geomag;
    state.radCurve = sw.radCurve; // real hour-by-hour LRO storm dose (history mission only)

    // Light forecast for every zone, every hour of the mission (shown as the sunlight strip).
    state.light = {};
    for (const z of Object.keys(C.zones)) {
      state.light[z] = [];
      for (let h = 0; h < C.missionHours; h++) state.light[z].push(zoneLitAt(state, z, h + 0.5));
    }

    // Starting base (already built).
    const B = C.base;
    addModule(state, 'hab', B.c, B.r, true);
    addModule(state, 'solar', B.c - 2, B.r, true);
    addModule(state, 'solar', B.c - 2, B.r + 1, true);
    addModule(state, 'battery', B.c + 3, B.r, true);
    addModule(state, 'o2gen', B.c + 3, B.r + 1, true);
    addModule(state, 'greenhouse', B.c, B.r + 3, true);
    state.res.battery = Math.min(state.res.battery, batteryCap(state));
    updatePower(state, 0, true);
    return state;
  }

  function addModule(state, type, c, r, built) {
    const d = cfg().modules[type];
    const m = { id: state.nextId++, type, c, r, w: d.w, h: d.h, on: true, built: !!built, progress: built ? d.work : 0, powered: false, lit: false, noWater: false };
    state.modules.push(m);
    return m;
  }

  // ---------- queries ----------
  const zoneOf = (state, c, r) => state.tiles[r * cfg().map.cols + c];
  const built = (state, type) => state.modules.filter((m) => m.built && (!type || m.type === type));
  const hab = (state) => state.modules.find((m) => m.type === 'hab');
  const hasShelter = (state) => built(state, 'shelter').length > 0;
  /** The first Astronomy Tower finished (it shows today's picture; later towers show the archive).
   *  The crew builds in the order things were placed, so that is the lowest id. */
  const firstTower = (state) => built(state, 'tower').reduce((a, m) => (!a || m.id < a.id ? m : a), null);
  const batteryCap = (state) => built(state, 'battery').length * cfg().modules.battery.store;
  const currentJob = (state) => {
    const m = state.modules.find((x) => !x.built);
    if (m) return { kind: 'module', m };
    if (state.berm.building && !state.berm.built) return { kind: 'berm' };
    return null;
  };
  const workersOutside = (state) => (state.status === 'running' && !state.sheltering && currentJob(state) ? cfg().workers : 0);

  function moduleAt(state, c, r) {
    return state.modules.find((m) => c >= m.c && c < m.c + m.w && r >= m.r && r < m.r + m.h);
  }

  function canPlace(state, type, c, r) {
    const C = cfg(), d = C.modules[type];
    if (!d || type === 'hab') return { ok: false, why: 'Not buildable' };
    if (c < 0 || r < 0 || c + d.w > C.map.cols || r + d.h > C.map.rows) return { ok: false, why: 'Outside the map' };
    if (moduleAt(state, c, r)) return { ok: false, why: 'Something is already here' };
    if (state.res.parts < d.cost) return { ok: false, why: `Needs ${d.cost} parts (you have ${state.res.parts})` };
    const z = zoneOf(state, c, r);
    if (d.onlyZone && z !== d.onlyZone) return { ok: false, why: 'Ice Drill must go on the dark ice area' };
    return { ok: true, zone: z };
  }

  function place(state, type, c, r) {
    const chk = canPlace(state, type, c, r);
    if (!chk.ok) return chk;
    state.res.parts -= cfg().modules[type].cost;
    const m = addModule(state, type, c, r, false);
    return { ok: true, m };
  }

  function cancel(state, id) {
    const m = state.modules.find((x) => x.id === id);
    if (!m || m.built) return false;
    state.res.parts += cfg().modules[m.type].cost;
    state.modules = state.modules.filter((x) => x !== m);
    return true;
  }

  function toggle(state, id) {
    const m = state.modules.find((x) => x.id === id);
    if (!m || m.type === 'hab' || !m.built || !needOf(state, m)) return false;
    m.on = !m.on;
    log(state, 'info', `${m.on ? 'Turned ON' : 'Turned OFF'}: ${cfg().modules[m.type].name}`);
    return true;
  }

  function startBerm(state) {
    if (state.berm.built || state.berm.building) return false;
    state.berm.building = true;
    log(state, 'info', 'Crew starts piling moon dirt on the habitat.');
    return true;
  }

  function setShelter(state, on) {
    if (on && !hasShelter(state)) return false;
    if (state.sheltering === on) return true;
    state.sheltering = on;
    log(state, on ? 'warn' : 'info', on ? 'Crew moved into the storm shelter.' : 'Crew left the shelter and went back to work.');
    return true;
  }

  function chooseCargo(state, index, option) {
    const k = state.cargo[index];
    if (!k || k.arrived || !cfg().cargoOptions[option]) return false;
    k.choice = option;
    log(state, 'info', `Cargo #${index + 1} will carry: ${cfg().cargoOptions[option].name}.`);
    return true;
  }

  function needOf(state, m) {
    const d = cfg().modules[m.type];
    if (m.type === 'hab') return d.power + (zoneLitAt(state, zoneOf(state, m.c, m.r), state.hour + 0.5) ? 0 : d.heatInDark);
    return d.power || 0;
  }

  /** Extra radiation from solar storms at hour h, in mSv/h for an unshielded person on the surface. */
  function stormRateAt(state, h) {
    if (state.radCurve) return crewRate(state.radCurve[Math.floor(h)] || 0);
    const rise = cfg().rad.storm.rise;
    let s = 0;
    for (const st of state.storms) {
      const t = h - st.h;
      if (t < 0) continue;
      if (st.profile) { s += crewRate(st.profile[Math.floor(t)] || 0); continue; }
      if (t > 120) continue;
      s += t < rise ? (st.peak * t) / rise : st.peak * Math.exp(-(t - rise) / st.tau);
    }
    return s;
  }

  // ---------- power ----------
  function updatePower(state, h, dryRun) {
    const C = cfg();
    let supply = 0;
    for (const m of built(state, 'solar')) {
      m.light = zoneLight(state, zoneOf(state, m.c, m.r), h + 0.5);
      m.lit = m.light > 0.5;
      m.powered = m.light > 0.02;
      if (m.on) supply += C.modules.solar.makes * m.light; // half-covered Sun = half power
    }
    for (const m of built(state, 'battery')) m.powered = true;
    const consumers = built(state).filter((m) => needOf(state, m) > 0).sort((a, b) => (C.modules[a.type].priority - C.modules[b.type].priority) || a.id - b.id);
    const avail = supply + state.res.battery;
    let use = 0;
    for (const m of consumers) {
      const need = needOf(state, m);
      if (!m.on) { m.powered = false; continue; }
      if (avail - use >= need - 1e-9) { use += need; m.powered = true; } else m.powered = false;
    }
    const cap = batteryCap(state);
    if (!dryRun) state.res.battery = clamp(state.res.battery + supply - use, 0, cap);
    state.power = { supply, use, cap };
  }

  // ---------- logging & "since" tracking ----------
  function log(state, level, text) {
    state.log.push({ h: state.hour, level, text });
    if (state.log.length > 400) state.log.shift();
  }
  function track(state, key, cond, startText, endText, events, level) {
    if (cond && state.since[key] == null) {
      state.since[key] = state.hour;
      if (startText) { log(state, level || 'warn', startText); events && events.push({ level: level || 'warn', text: startText }); }
      state.firstSeen = state.firstSeen || {};
      if (state.firstSeen[key] == null) state.firstSeen[key] = state.hour;
    } else if (!cond && state.since[key] != null) {
      if (endText) log(state, 'good', endText);
      state.lastEnded = state.lastEnded || {};
      state.lastEnded[key] = { from: state.since[key], to: state.hour };
      state.since[key] = null;
    }
  }

  // ---------- one hour ----------
  function step(state) {
    if (state.status !== 'running') return [];
    const C = cfg(), h = state.hour, ev = [];
    const say = (level, title, text, extra) => { log(state, level, title + (text ? ' — ' + text : '')); ev.push({ level, title, text, ...extra }); };

    if (h === 0) say('info', 'CAPCOM: Welcome to Shackleton Base', 'Keep 4 astronauts alive for 30 days. Watch the sunlight forecast under the map: the Sun circles the horizon here, so shadows move.');

    // Darkness forecast for zones where we have solar panels.
    for (const z of ['plain', 'ridge']) {
      const panels = built(state, 'solar').filter((m) => zoneOf(state, m.c, m.r) === z).length;
      const L = state.light[z];
      if (!panels || !L[h]) continue;
      // Find the next shadow that starts within 24 hours. Warn once per shadow (keyed by its start hour).
      let start = -1;
      for (let k = h + 1; k <= h + 24 && k < L.length; k++) if (!L[k]) { start = k; break; }
      const key = 'dark' + z + start;
      if (start < 0 || state.warned[key]) continue;
      state.warned[key] = true;
      let len = 0; while (start + len < L.length && !L[start + len]) len++;
      const inH = start - h;
      say('warn', `Forecast: shadow coming to the ${C.zones[z].name.toLowerCase()}`,
        `In ${inH} hours the Sun goes behind the hills for about ${round1(len / 24)} days. ${panels} of your panels will stop making power. Charge batteries, save power, or build panels where the Sun still shines.`, { banner: true });
    }

    // Space weather.
    for (const f of state.flares) if (f.h >= h && f.h < h + 1) {
      const big = f.cls[0] === 'X';
      say(big ? 'warn' : 'info', `Solar flare: class ${f.cls}${f.date ? ' (' + f.date.slice(0, 10) + ', real event)' : ''}`,
        big ? 'A big flash on the Sun. Forecasters are watching for particles.' : 'Small flare. Most flares do not send dangerous particles to the Moon.');
    }
    for (const g of state.geomag) if (g.h >= h && g.h < h + 1) {
      say('info', `Earth news: geomagnetic storm (Kp ${g.kpMax})`, g.kpMax >= 8 ? 'Huge auroras on Earth tonight! Earth\'s magnetic field protects people there. The Moon has no magnetic field.' : 'Auroras on Earth. The Moon has no magnetic field to protect you.');
    }
    for (const s of state.storms) {
      if (!s.warned && h + 1 >= s.h - C.rad.warnLead) { // +1: the clock shows hour h+1 right after this step
        s.warned = true;
        say('bad', s.strong ? '☢️ STRONG radiation storm incoming!' : '☢️ Radiation storm incoming',
          (hasShelter(state) ? 'Particles arrive in about 2 hours.' : 'Particles arrive in about 2 hours. You have NO storm shelter.') +
          (s.date ? ` (Real event: ${s.date.slice(0, 16).replace('T', ' ')} UTC)` : '') +
          (s.realName ? ` This storm copies the real ${s.realName}, measured by NASA's Lunar Reconnaissance Orbiter.` : ''));
        // No pop-up and no pause on purpose: players must notice the countdown bar / CAPCOM themselves.
      }
    }
    const S = stormRateAt(state, h + 0.5);
    state.stormRate = S;
    const stormWasOn = state.since.storm != null;
    track(state, 'storm', S > C.rad.stormOn, null, 'All clear: the radiation storm is over.', ev);
    // REAL: big storms come in waves over several days (the Sun keeps erupting from the same spot),
    // and forecasters send a new alert every time radiation climbs past the threshold again.
    const justWarned = state.storms.some((s) => s.warned && h - (s.h - C.rad.warnLead) < 6);
    if (!stormWasOn && S > C.rad.stormOn && !justWarned && !state.sheltering) {
      say('bad', '☢️ Radiation is rising again!',
        hasShelter(state) ? 'Another wave of solar particles is arriving.'
          : 'Another wave of solar particles is arriving. Stop work outside; the habitat blocks half of it.'); // CAPCOM only, no pop-up
    }

    // Construction.
    const job = currentJob(state);
    const wOut = workersOutside(state);
    if (job && wOut) {
      if (job.kind === 'module') {
        job.m.progress += wOut;
        if (job.m.progress >= C.modules[job.m.type].work) { job.m.built = true; say('good', `Built: ${C.modules[job.m.type].name}`, ''); }
      } else {
        state.berm.progress += wOut;
        if (state.berm.progress >= C.bermWork) { state.berm.built = true; state.berm.building = false; say('good', 'Habitat shielding finished', 'Moon dirt on the roof now blocks most radiation.'); }
      }
    }

    // Power.
    updatePower(state, h, false);
    const solars = built(state, 'solar');
    const dark = solars.filter((m) => !m.lit).length;
    state.stats.solarKwh += state.power.supply;
    track(state, 'darkPanels', solars.length > 0 && dark === solars.length, 'All solar panels are in shadow', 'Sunlight is back on the solar panels.', ev);
    // "Empty" = too little left to run something that is switched on (a small leftover can't power the heaters).
    const starved = built(state).some((m) => m.on && !m.powered && needOf(state, m) > 0 && m.type !== 'solar');
    track(state, 'batteryEmpty', state.res.battery < 3 && starved, 'Battery is EMPTY', 'Battery is charging again.', ev, 'bad');
    for (const t of ['hab', 'o2gen', 'greenhouse', 'drill']) {
      const ms = built(state, t);
      const off = ms.filter((m) => !m.powered && m.on).length;
      if (off) state.stats.unpoweredH[t] = (state.stats.unpoweredH[t] || 0) + 1;
      const name = C.modules[t].name;
      track(state, 'nopower_' + t, ms.length > 0 && off === ms.length, t === 'hab' ? 'Habitat has NO POWER: heaters and fans stopped!' : `${name} shut down: not enough power`, `${name} has power again.`, ev, t === 'hab' ? 'bad' : 'warn');
    }
    if (!state.warned.batLow && state.power.cap && state.res.battery < state.power.cap * 0.25 && state.power.supply < state.power.use) {
      state.warned.batLow = true;
      say('warn', 'Battery below 25%', 'Turn off things you do not need (click a module). Greenhouse lights use the most power.');
    }
    if (state.res.battery > state.power.cap * 0.6) state.warned.batLow = false;

    // Production & consumption.
    const U = C.use, n = C.crew;
    for (const m of built(state, 'o2gen')) {
      const d = C.modules.o2gen;
      m.noWater = m.powered && state.res.water < d.waterPerH;
      if (m.powered && !m.noWater) { state.res.water -= d.waterPerH; state.res.o2 += d.o2PerH; state.stats.o2Made += d.o2PerH; }
    }
    for (const m of built(state, 'drill')) if (m.powered) { state.res.water += C.modules.drill.waterPerH; state.stats.waterMined += C.modules.drill.waterPerH; }
    for (const m of built(state, 'greenhouse')) {
      const d = C.modules.greenhouse;
      m.noWater = m.powered && state.res.water < d.waterPerH;
      if (m.powered && !m.noWater) {
        const f = d.foodPerH * (state.sheltering ? 0.5 : 1);
        state.res.water -= d.waterPerH; state.res.food += f; state.stats.foodMade += f;
      }
    }
    state.res.o2 -= U.o2PerPersonH * n;
    const eat = Math.min(state.res.food, U.foodPerPersonH * n);
    state.res.food -= eat; state.stats.foodEaten += eat;
    state.res.water -= U.waterPerPersonH * n;
    state.res.o2 = clamp(state.res.o2, 0, C.caps.o2);
    state.res.water = clamp(state.res.water, 0, C.caps.water);
    state.res.food = Math.max(0, state.res.food);
    track(state, 'noO2Make', built(state, 'o2gen').every((m) => !m.powered || m.noWater || !m.on), 'No oxygen is being made right now', 'Oxygen generator is running again.', ev);
    track(state, 'waterEmpty', state.res.water <= 0.01, 'Water tank is EMPTY', 'Water is back.', ev, 'bad');
    track(state, 'foodEmpty', state.res.food <= 0.01, 'Food is GONE. The crew is going hungry.', 'Crew has food again.', ev, 'bad');
    state.foodOutH = state.res.food <= 0.01 ? state.foodOutH + 1 : 0;
    state.waterOutH = state.res.water <= 0.01 ? state.waterOutH + 1 : 0;

    const days = (v, perH) => v / perH / 24;
    const lowCheck = (key, v, perH, title, tip) => {
      const d = days(v, perH);
      if (d < 2 && !state.warned[key]) { state.warned[key] = true; say('warn', title, tip); }
      if (d > 4) state.warned[key] = false;
    };
    lowCheck('lowO2', state.res.o2, U.o2PerPersonH * n, 'Oxygen: less than 2 days left', 'Make sure the O₂ Generator has power AND water.');
    lowCheck('lowFood', state.res.food, U.foodPerPersonH * n, 'Food: less than 2 days left', 'Greenhouses need power. A cargo of food can help too.');

    // Habitat temperature.
    const H = hab(state), T = C.habTemp;
    const habDark = !zoneLitAt(state, zoneOf(state, H.c, H.r), h + 0.5);
    if (H.powered) state.habTemp = Math.min(T.normal, state.habTemp + T.heat);
    else state.habTemp -= habDark ? T.coolDark : T.coolLit;

    // Radiation dose (average per astronaut).
    const bg = C.rad.surfacePerH;
    const inF = state.sheltering && hasShelter(state) ? C.rad.shelter : state.berm.built ? C.rad.habBerm : C.rad.hab;
    const w = wOut;
    const add = { background: ((n - w) * inF * bg) / n, storm: ((n - w) * inF * S) / n, outside: (w * (bg + S)) / n };
    for (const k in add) { state.doseFrom[k] += add[k]; state.dose += add[k]; }
    if (S > C.rad.stormOn && w > 0 && !state.warned['eva' + Math.floor(h / 6)]) {
      state.warned['eva' + Math.floor(h / 6)] = true;
      say('bad', 'Astronauts are OUTSIDE during a radiation storm!', 'They are building right now and getting the full dose. Pause building or use the shelter.');
    }
    if (state.dose >= C.rad.warn && !state.warned.dose) { state.warned.dose = true; say('bad', `Crew radiation dose passed ${C.rad.warn} mSv`, `The safety limit is ${C.rad.limit} mSv. Avoid working outside during storms.`); }

    // Cargo.
    state.cargo.forEach((k, i) => {
      if (!k.asked && h >= k.h - C.cargoAskLead) {
        k.asked = true;
        say('info', `Cargo lander #${i + 1} launches soon`, 'It lands in 2 days. What should it carry?', { banner: true, decision: 'cargo', cargoIndex: i });
      }
      if (!k.arrived && h >= k.h) {
        k.arrived = true;
        const opt = C.cargoOptions[k.choice || 'food'];
        for (const r in opt.give) state.res[r] += opt.give[r];
        state.res.o2 = Math.min(state.res.o2, C.caps.o2);
        say('good', `Cargo landed: ${opt.name}`, opt.text + (k.choice ? '' : ' (Mission Control picked for you)'));
      }
    });

    // History (for the debrief charts).
    const Hs = state.history;
    Hs.o2.push(state.res.o2); Hs.food.push(state.res.food); Hs.water.push(state.res.water);
    Hs.battery.push(state.res.battery); Hs.dose.push(state.dose); Hs.solar.push(state.power.supply); Hs.use.push(state.power.use);

    state.hour++;

    // Fail / win checks.
    const fail = (cause) => { state.status = 'lost'; state.failure = { cause, h: state.hour }; log(state, 'bad', 'MISSION FAILED: ' + cause); ev.push({ level: 'bad', title: 'Mission failed', end: true }); };
    if (state.res.o2 <= 0) fail('o2');
    else if (state.habTemp < T.fail) fail('cold');
    else if (state.dose >= C.rad.limit) fail('radiation');
    else if (state.foodOutH >= C.fail.foodGraceH) fail('food');
    else if (state.waterOutH >= C.fail.waterGraceH) fail('water');
    else if (state.hour >= C.missionHours) { state.status = 'won'; log(state, 'good', 'MISSION COMPLETE'); ev.push({ level: 'good', title: 'Mission complete', end: true }); }
    return ev;
  }

  // ---------- "Why is this happening?" live cause chains ----------
  function causeChains(state) {
    const C = cfg(), chains = [];
    const solars = built(state, 'solar');
    const shaded = solars.filter((m) => !m.lit);
    const P = state.power;
    const off = (t) => built(state, t).filter((m) => m.on && !m.powered);
    const consequences = [];
    if (off('hab').length) consequences.push({ icon: '🥶', text: `Habitat heaters OFF: ${round1(state.habTemp)} °C and dropping`, level: 'bad' });
    if (off('o2gen').length) consequences.push({ icon: '💨', text: 'O₂ Generator OFF: no new oxygen', level: 'bad' });
    if (off('drill').length) consequences.push({ icon: '⛏️', text: 'Ice Drill OFF: no new water', level: 'warn' });
    if (off('greenhouse').length) consequences.push({ icon: '🌱', text: `${off('greenhouse').length} Greenhouse OFF → no new food`, level: 'warn' });
    const draining = P.use > P.supply + 0.01;
    if (shaded.length || draining || consequences.length) {
      const c = [];
      if (shaded.length) c.push({ icon: '🌑', text: `Sun is behind the hills: ${shaded.length} of ${solars.length} panels in shadow`, level: shaded.length === solars.length ? 'bad' : 'warn' });
      c.push({ icon: '⚡', text: `Solar makes ${round1(P.supply)} kW, base uses ${round1(P.use)} kW`, level: draining ? 'warn' : 'ok' });
      if (draining) {
        const hrs = (P.use - P.supply) > 0 ? state.res.battery / (P.use - P.supply) : Infinity;
        c.push({ icon: '🔋', text: state.res.battery <= 0.01 ? 'Battery EMPTY → machines shut down (greenhouse first)' : `Battery draining: ~${Math.floor(hrs)} h left`, level: state.res.battery <= 0.01 ? 'bad' : 'warn' });
      }
      chains.push(c.concat(consequences));
    }
    if (state.stormRate > cfg().rad.stormOn) {
      const shelter = state.sheltering && hasShelter(state);
      const w = workersOutside(state);
      chains.push([
        { icon: '☀️', text: 'Solar flare threw out fast particles', level: 'warn' },
        { icon: '☢️', text: `Radiation storm: ${round1(state.stormRate)} mSv/h outside`, level: 'bad' },
        shelter ? { icon: '🛡️', text: 'Crew in shelter: 95% blocked', level: 'ok' }
          : w ? { icon: '👩‍🚀', text: `${w} astronauts OUTSIDE building: full dose!`, level: 'bad' }
            : { icon: '🏠', text: `Crew in habitat: ${state.berm.built ? '80' : '50'}% blocked`, level: 'warn' },
        { icon: '📈', text: `Crew dose ${Math.round(state.dose)} / ${C.rad.limit} mSv`, level: state.dose > C.rad.warn ? 'bad' : 'warn' },
      ]);
    }
    const o2days = state.res.o2 / (C.use.o2PerPersonH * C.crew) / 24;
    if (state.res.water < 30 && !built(state, 'drill').some((m) => m.powered)) {
      chains.push([
        { icon: '💧', text: `Water low: ${Math.round(state.res.water)} kg`, level: 'warn' },
        { icon: '💨', text: 'O₂ Generator needs water to make oxygen', level: 'warn' },
        { icon: '🫁', text: `Oxygen left: ${round1(o2days)} days`, level: o2days < 2 ? 'bad' : 'warn' },
      ]);
    }
    return chains;
  }

  // ---------- debrief ----------
  function debrief(state) {
    const C = cfg(), s = state.since, first = state.firstSeen || {}, ended = state.lastEnded || {};
    const startOf = (k) => (s[k] != null ? s[k] : ended[k] ? ended[k].from : first[k]);
    const won = state.status === 'won';
    const out = { won, chain: [], tips: [], fact: '', stats: {} };
    const t = state.failure && state.failure.h;
    const add = (h, text) => out.chain.push({ when: h != null ? fmtDay(h) : '', text });
    const powerStory = () => {
      if (startOf('darkPanels') != null) add(startOf('darkPanels'), 'The Sun went behind the hills. All solar panels were in shadow.');
      else if (startOf('batteryEmpty') != null) add(null, 'The base used more power than the solar panels made.');
      if (startOf('batteryEmpty') != null) add(startOf('batteryEmpty'), 'The battery ran empty.');
    };
    const ridgePanels = built(state, 'solar').filter((m) => zoneOf(state, m.c, m.r) === 'ridge').length;

    if (!won) {
      const cause = state.failure.cause;
      if (cause === 'cold') {
        out.title = 'The habitat got too cold';
        powerStory();
        add(startOf('nopower_hab'), 'With no power left, the heaters stopped.');
        add(t, `The habitat cooled below ${C.habTemp.fail} °C. The crew had to leave.`);
        if (!ridgePanels) out.tips.push('Build solar panels on HIGH GROUND (the light gray hills and ridges). It stays sunny much longer. Drag the map to find them.');
        out.tips.push('Check the sunlight forecast under the map. Before a long shadow, fill the batteries and build more of them.');
        out.tips.push('Turn off greenhouses during the dark. The crew can eat stored food for a few days.');
        out.fact = 'NASA picked the lunar south pole partly because some ridges there are sunlit most of the time. Engineers study light maps from the Lunar Reconnaissance Orbiter to choose where to put solar panels.';
      } else if (cause === 'o2') {
        out.title = 'The crew ran out of oxygen';
        if (startOf('waterEmpty') != null) add(startOf('waterEmpty'), 'The water tank ran dry, so the O₂ Generator had nothing to split.');
        else powerStory();
        add(startOf('noO2Make'), 'The O₂ Generator stopped making oxygen.');
        add(t, 'The oxygen tank reached zero.');
        out.tips.push('The O₂ Generator needs BOTH power and water. Watch both bars.');
        if (!built(state, 'drill').length) out.tips.push('Build an Ice Drill in a dark ice crater (drag the map to find one). Ice → water → oxygen.');
        out.tips.push('Choose "Water & air" cargo if oxygen is getting low.');
        out.fact = 'On the ISS, the Oxygen Generation System makes oxygen by splitting water with electricity, the same idea as in this game. A Moon base could get that water from ice in permanently shadowed craters.';
      } else if (cause === 'radiation') {
        out.title = 'The crew got too much radiation';
        const f = state.doseFrom;
        add(null, `Radiation the crew got: ${Math.round(f.storm)} mSv from solar storms inside, ${Math.round(f.outside)} mSv while working outside, ${Math.round(f.background)} mSv everyday background.`);
        add(t, `The crew passed NASA's ${C.rad.limit} mSv safety limit and had to go home.`);
        if (!hasShelter(state)) out.tips.push('Build a Storm Shelter early. It blocks 95% of storm radiation.');
        out.tips.push('When a radiation storm warning comes, stop building outside and move the crew into the shelter.');
        if (!state.berm.built) out.tips.push('Pile moon dirt on the habitat ("Shield habitat" button). It blocks radiation every day.');
        const big = state.storms.find((s) => s.strong && s.profile);
        out.fact = big
          ? `The ${big.realName} really happened. NASA's Lunar Reconnaissance Orbiter measured it from Moon orbit: an astronaut standing on the Moon with no shelter would have got about ${Math.round(big.profile.reduce((a, v) => a + crewRate(v), 0) / 10) * 10} mSv, many times NASA's ${C.rad.limit} mSv limit. That is why a storm shelter is a must for a Moon base.`
          : 'The Moon has no magnetic field and almost no air, so solar particles hit the surface directly. Artemis astronauts in the Orion spacecraft have a plan to build a shelter out of supply bags during a solar storm.';
      } else if (cause === 'food') {
        out.title = 'The crew ran out of food';
        if (state.stats.unpoweredH.greenhouse) add(null, `The greenhouses had no power for ${state.stats.unpoweredH.greenhouse} hours.`);
        add(null, `Greenhouses grew ${Math.round(state.stats.foodMade)} kg of food; the crew ate ${Math.round(state.stats.foodEaten)} kg.`);
        add(startOf('foodEmpty'), 'Food storage reached zero.');
        add(t, 'After 3 days without food, the mission had to end.');
        out.tips.push('Each greenhouse grows ~2.9 kg of food per day. 4 astronauts eat ~7.2 kg per day.');
        out.tips.push('Greenhouses need lots of power. More solar panels and batteries keep them running.');
        out.tips.push('Pick "Food pack" in a cargo lander when food is low.');
        out.fact = 'Astronauts on the ISS grow lettuce and other plants in the Veggie system under LED lights. A Moon base would need much bigger greenhouses to feed a crew.';
      } else if (cause === 'water') {
        out.title = 'The crew ran out of water';
        const drills = built(state, 'drill');
        if (!drills.length) add(null, 'There was no Ice Drill, so no new water came in.');
        else if (state.stats.unpoweredH.drill) add(null, `The Ice Drill had no power for ${state.stats.unpoweredH.drill} hours.`);
        add(null, `The O₂ Generator used ${Math.round(state.stats.o2Made * C.modules.o2gen.waterPerH / C.modules.o2gen.o2PerH)} kg of water to make air. The crew and greenhouses used more.`);
        add(startOf('waterEmpty'), 'The water tank ran dry.');
        add(t, 'After 2 days without water, the mission had to end.');
        out.tips.push('Build an Ice Drill in a dark ice crater (drag the map to find one) and give it power.');
        out.fact = 'NASA\'s LCROSS mission crashed into a dark crater near the lunar south pole in 2009 and found water ice in the debris cloud.';
      }
    } else {
      out.title = 'Mission complete! The crew is safe.';
      out.fact = 'NASA\'s Artemis program plans to land astronauts near the lunar south pole and to learn how to live there for longer and longer missions.';
    }
    const C2 = C.rad;
    out.stars = won ? 1 + (state.dose < C2.warn ? 1 : 0) + (state.stats.foodMade >= state.stats.foodEaten * 0.5 ? 1 : 0) : 0;
    if (won) {
      out.tips.push(state.dose < C2.warn ? '⭐ Crew radiation dose stayed below the warning level.' : `Radiation got high (${Math.round(state.dose)} mSv). Try the shelter and habitat shielding.`);
      out.tips.push(state.stats.foodMade >= state.stats.foodEaten * 0.5 ? '⭐ Greenhouses grew at least half of the food.' : 'Try to grow at least half of your food in greenhouses.');
    }
    out.stats = {
      days: round1(state.hour / 24), dose: Math.round(state.dose), foodMade: Math.round(state.stats.foodMade), foodEaten: Math.round(state.stats.foodEaten),
      o2Made: Math.round(state.stats.o2Made), waterMined: Math.round(state.stats.waterMined), solarKwh: Math.round(state.stats.solarKwh),
    };
    out.chain = out.chain.filter((c) => c.text);
    return out;
  }

  // ---------- countdowns for the status bar ----------
  // now = state.hour + fraction of the current hour. Returns what is coming, soonest first.
  function upcoming(state, now) {
    const C = cfg(), out = [];
    // Radiation storms: only known after the warning (forecasters see the flare first).
    for (const s of state.storms) {
      if (s.warned && now < s.h) {
        out.push({ kind: 'storm', icon: '☢️', level: 'bad', left: s.h - now, total: C.rad.warnLead,
          label: `${s.strong ? 'STRONG radiation storm' : 'Radiation storm'} arrives in` });
      }
    }
    if (state.stormRate > cfg().rad.stormOn) {
      // Look ahead to when all storms fade below the "active" level.
      let end = Math.floor(now);
      while (end < now + 120 && stormRateAt(state, end + 0.5) > cfg().rad.stormOn) end++;
      const started = Math.min(...state.storms.filter((s) => s.h <= now && stormRateAt(state, now) > 0).map((s) => s.h));
      out.push({ kind: 'stormActive', icon: '☢️', level: 'bad', left: Math.max(0, end - now), total: Math.max(1, end - started),
        label: state.sheltering ? 'Storm active (crew sheltered) · ends in about' : 'Storm active · ends in about' });
    }
    // Next cargo lander.
    const i = state.cargo.findIndex((k) => !k.arrived);
    if (i >= 0) {
      const k = state.cargo[i];
      const prev = i > 0 ? state.cargo[i - 1].h : 0;
      const what = k.choice ? C.cargoOptions[k.choice].name : k.asked ? 'contents not chosen yet!' : 'you choose 2 days before';
      out.push({ kind: 'cargo', icon: '🚀', level: k.asked && !k.choice ? 'warn' : 'info', left: k.h - now, total: k.h - prev,
        label: `Cargo #${i + 1} (${what}) lands in` });
    }
    return out.sort((a, b) => a.left - b.left);
  }

  MT.Sim = {
    upcoming, stormRateAt,
    create, step, canPlace, place, cancel, toggle, setShelter, startBerm, chooseCargo,
    causeChains, debrief, moduleAt, zoneOf, sunAz, zoneLight, zoneLitAt, currentJob, workersOutside, hasShelter, firstTower, batteryCap, needOf, built, fmtDay, day,
  };
})(typeof window !== 'undefined' ? window : globalThis);
