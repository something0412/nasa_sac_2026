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
  // Random numbers that live in the state (so a mission with the same seed always plays the same).
  function rnd(state) {
    state.rngA = (state.rngA + 0x6d2b79f5) | 0;
    let t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

  /**
   * Space weather for the first 30 days. The game is endless: extendWorld() adds random 30-day chunks
   * (randomWeather) after that, in both scenarios.
   */
  function buildSpaceWeather(kind, rand) {
    const R = cfg().rad.storm, CH = cfg().chunkH;
    if (kind === 'history' && root.MAY2024) {
      const d = root.MAY2024;
      const lab = radlab();
      const curve = !!(lab && lab.may2024);
      return {
        flares: d.flares.filter((f) => f.h < CH).map((f) => ({ h: f.h, cls: f.cls, date: f.t })),
        // DONKI storm times drive the warnings; the dose itself comes hour by hour from LRO (radCurve).
        storms: d.sepStorms.map((s) => ({ h: s.h, strong: s.strong, date: s.t, curve, ...(s.strong ? R.strong : R.moderate) })),
        geomag: d.geomagStorms.filter((g) => g.h < CH),
        radCurve: curve ? lab.may2024.extra : null,
        // REAL: the Eta Aquariid meteor shower (dust from Halley's Comet) peaked around 5 May 2024.
        // The Moon travels with Earth, so it crosses the same dust (NASA watches for impact flashes on the Moon).
        meteors: [{ h: 96, dur: 6, name: 'Eta Aquariids', date: '2024-05-05' }],
      };
    }
    return { ...randomWeather(rand, 0, CH), geomag: [], radCurve: null };
  }

  /** Random space weather for the hours h0 .. h0 + len (a 30-day chunk). */
  function randomWeather(rand, h0, len) {
    const R = cfg().rad.storm;
    // Flares every 1-3 days. Bigger flares are more likely to send particles.
    const flares = [], storms = [];
    let h = h0 + 20 + rand() * 30;
    while (h < h0 + len - 30) {
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
    // Make sure every 30 days have at least one strong storm (so the shelter matters).
    if (!storms.some((s) => s.strong)) {
      const f = flares[Math.floor(flares.length * (0.35 + rand() * 0.3))];
      f.cls = 'X' + (5 + rand() * 4).toFixed(1);
      storms.push({ h: round1(f.h + 2), strong: true, ...R.strong });
    }
    storms.sort((a, b) => a.h - b.h);
    giveRealShapes(storms, rand);
    // Meteor showers: 1 or 2 per training mission, named after real yearly showers.
    const SHOWERS = ['Perseids', 'Geminids', 'Quadrantids', 'Lyrids', 'Orionids', 'Leonids'];
    const meteors = [];
    const nMet = 1 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < nMet; i++) {
      meteors.push({ h: h0 + Math.round(60 + rand() * (len - 130)), dur: 4 + Math.floor(rand() * 3), name: SHOWERS[Math.floor(rand() * SHOWERS.length)] });
    }
    meteors.sort((a, b) => a.h - b.h);
    return { flares, storms, meteors };
  }

  /**
   * The game never ends by itself, so the world is made ahead of time, a bit at a time: the sunlight
   * forecast, space weather (30 days per chunk), cargo landers every 10 days and crew ships every 30 days.
   * Always covers at least one forecast window (30 days) past the current hour.
   */
  function extendWorld(state) {
    const C = cfg(), CH = C.chunkH, E = C.endless, need = state.hour + CH + 48;
    for (const z of Object.keys(C.zones)) {
      const L = state.light[z];
      while (L.length < need) L.push(zoneLitAt(state, z, L.length + 0.5));
    }
    while (state.wxUntil < need) {
      const k = state.wxUntil / CH;
      const wx = randomWeather(rng((state.seed ^ Math.imul(k, 0x9e3779b1)) >>> 0), state.wxUntil, CH);
      state.flares.push(...wx.flares); state.storms.push(...wx.storms); state.meteors.push(...wx.meteors);
      state.wxUntil += CH;
    }
    let last = state.cargo.length ? state.cargo[state.cargo.length - 1].h : 0;
    while (last + C.cargoEveryH < need) { last += C.cargoEveryH; state.cargo.push({ h: last, choice: null, asked: false, arrived: false }); }
    let ship = state.ships.length ? state.ships[state.ships.length - 1].h : 0;
    while (ship + E.shipEveryH < need) { ship += E.shipEveryH; state.ships.push({ h: ship, warned: false, arrived: false }); }
  }

  /** A new astronaut (the first 4 at the start; 2 more with every crew spaceship). */
  function newAstronaut(id, name, role, homeId, sinceGym) {
    return {
      id, name, role, homeId, hp: 100, dose: 0, injury: 0, stress: 0, bone: 100,
      task: null, // a 1-day job inside a building, or a tower visit: { kind: 'lab'|'greenhouse'|'tower', id, left, total, target? }
      paused: null, // research / greenhouse work put on hold by the shelter (resumes when the player sends them back)
      trip: false, // riding the rover to another HAB
      accidents: 0, // injuries from lab micro-explosions or farming tools
      where: 'hab', job: null, gymLeft: 0, gymId: null, sinceGym: sinceGym || 0,
      medbay: false, medbayAt: null, medbayWhy: null, hits: 0, injuries: 0, warnedHp: 0,
      wounds: [], // each injury separately: { hp, what, h } (the medbay heals the smallest one)
      heal: null, // while resting in the medbay: { left, total, amount }
      boneTier: 0, // 0 ok, 1 fragile (<50%), 2 severe (<25%): for one-time warnings
    };
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
      habTemp: C.habTemp.normal, // the COLDEST habitat (each HAB has its own .temp)
      sheltering: false, berm: null, // berm = the first HAB's moon-dirt shield (each HAB has its own .berm)
      foodOutH: 0, waterOutH: 0,
      cargo: [], ships: [], wxUntil: C.chunkH, // filled ahead of time by extendWorld()
      pendingCrew: 0, // new astronauts from a crew spaceship, waiting for the player to pick their jobs and HAB
      rover: null, // { habId, trip: null | { from, to, crew, left, total } }
      since: {}, log: [], warned: {},
      stats: { foodMade: 0, foodEaten: 0, o2Made: 0, waterMined: 0, unpoweredH: {}, darkH: 0, solarKwh: 0, accidents: [], harm: {}, firstHarm: null },
      history: { o2: [], food: [], water: [], battery: [], dose: [], solar: [], use: [], hp: [], crew: [] },
      power: { supply: 0, use: 0, cap: 0 },
      stormRate: 0,
      rngA: (seed ^ 0x5bd1e995) | 0,
      crewTotal: C.crew, // everyone who ever joined (the roster can shrink: sent home)
      nextCrewId: C.crew + 1,
      sentHome: [], // astronauts medically retired to Earth (no longer in state.crew, the roster)
      jobSeq: 0, // order in which jobs (build, repair, shield) were asked for
      medbayUses: 0, // healing treatments used (max C.astro.medbay.uses per mission)
      meteorOn: null, // the meteor shower happening right now, if any
      research: { solar: 0, o2gen: 0, drill: 0 }, // upgrade level per building type (0..C.research.maxLevel)
      researchCount: 0, // upgrades started so far (each one costs more parts)
      towerVisits: 0,   // Astronomy Tower visits this mission (the 1st shows today's picture, the rest the archive)
      lastAccident: null,
      // AMS: each astronaut (their home HAB is set once the first HAB exists, below).
      crew: C.astro.names.slice(0, C.crew).map((name, i) => newAstronaut(i + 1, name, C.astro.roles[i] || 'engineer', null, i * 5)),
    };
    for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) state.tiles.push(C.zoneAt(c, r));

    const sw = buildSpaceWeather(scenario, rand);
    state.flares = sw.flares;
    state.storms = sw.storms;
    state.geomag = sw.geomag;
    state.radCurve = sw.radCurve; // real hour-by-hour LRO storm dose (history mission only)
    state.meteors = sw.meteors || [];

    // Light forecast for every zone, every hour (shown as the sunlight strip). extendWorld() keeps it ahead.
    state.light = {};
    for (const z of Object.keys(C.zones)) state.light[z] = [];
    extendWorld(state);

    // Starting base (already built).
    const B = C.base;
    const home = addModule(state, 'hab', B.c, B.r, true);
    state.berm = home.berm;
    for (const a of state.crew) a.homeId = home.id;
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
    const m = { id: state.nextId++, type, c, r, w: d.w, h: d.h, on: true, built: !!built, progress: built ? d.work : 0, powered: false, lit: false, noWater: false,
      seq: ++state.jobSeq, damaged: false, repair: null,
      worker: null,  // (while being built) id of the Engineer the player picked
      usedAt: null,  // (Astronomy Tower) hour of the last visit
      dustLeft: 0 }; // (Solar Panel) hours left of moondust (half power)
    if (type === 'hab') { m.temp = cfg().habTemp.normal; m.berm = { built: false, progress: 0, building: false, worker: null }; }
    state.modules.push(m);
    return m;
  }

  // ---------- queries ----------
  const zoneOf = (state, c, r) => state.tiles[r * cfg().map.cols + c];
  const built = (state, type) => state.modules.filter((m) => m.built && (!type || m.type === type));
  const hab = (state) => state.modules.find((m) => m.type === 'hab'); // the first HAB (the base)
  /** Every HAB, oldest first ("HAB 1", "HAB 2", ...). */
  const habs = (state) => built(state, 'hab').sort((a, b) => a.id - b.id);
  const habName = (state, m) => 'HAB ' + (habs(state).indexOf(m) + 1);
  /** The HAB an astronaut lives in (the rover moves people between HABs). */
  const homeOf = (state, a) => state.modules.find((m) => m.id === a.homeId && m.type === 'hab') || hab(state);
  /** Job key for a HAB's moon-dirt shield ('berm' for the first HAB, so older code keeps working). */
  const bermKey = (state, H) => (H === hab(state) ? 'berm' : 'berm' + H.id);
  const habOfBermKey = (state, key) => (key === 'berm' ? hab(state) : state.modules.find((m) => m.type === 'hab' && 'berm' + m.id === key));
  const hasShelter = (state) => built(state, 'shelter').length > 0;
  const batteryCap = (state) => built(state, 'battery').length * cfg().modules.battery.store;
  // ----- crew & jobs -----
  const activeCrew = (state) => state.crew.filter((a) => !a.medbay);
  const crewById = (state, id) => state.crew.find((a) => a.id === id) || null;
  const roleName = (role) => cfg().astro.roleInfo[role].name;
  /** Every job waiting or in progress, oldest first: new buildings, repairs, the moon-dirt shield.
   *  Each job is done by exactly ONE astronaut: the Engineer the player picked (assignee). */
  function jobList(state) {
    const C = cfg(), list = [];
    for (const m of state.modules) {
      if (!m.built) list.push({ key: 'b' + m.id, kind: 'module', m, seq: m.seq, done: m.progress, total: C.modules[m.type].work, assignee: m.worker });
      else if (m.repair) list.push({ key: 'r' + m.id, kind: 'repair', m, seq: m.repair.seq, done: m.repair.progress, total: m.repair.work, assignee: m.repair.worker });
    }
    for (const H of state.modules) {
      const B = H.type === 'hab' && H.berm;
      if (B && B.building && !B.built) list.push({ key: bermKey(state, H), kind: 'berm', m: H, seq: B.seq || 0, done: B.progress, total: C.bermWork, assignee: B.worker });
    }
    list.forEach((j) => {
      j.worker = state.crew.find((a) => a.id === j.assignee && !a.medbay) || null; // null = nobody (or they left for the medbay)
      j.active = !!(j.worker && j.worker.job === j.key && j.worker.where === 'outside'); // being worked on this hour
    });
    return list.sort((a, b) => a.seq - b.seq);
  }
  /** Only working OUTSIDE is unprotected (full radiation). Every building (Research Bay, greenhouse, tower,
   *  gym, medbay) counts as the habitat; the shelter blocks the most. */
  const isExposed = (a) => a.where === 'outside';
  /** Why this astronaut can't be sent somewhere right now (or null if they can). */
  function roleWhy(a, role, what) {
    if (!a) return 'That astronaut is no longer at the base.';
    if (a.medbay) return `${a.name} is in the medbay for good.`;
    if (role && a.role !== role) return `Only ${roleName(role)}s can ${what}. ${a.name} is a ${roleName(a.role)}.`;
    return null;
  }
  const TASK_TEXT = { lab: 'researching in the Research Bay', greenhouse: 'working in the greenhouse', tower: 'at the Astronomy Tower' };
  function busyWhy(state, a) {
    if (a.heal) return `${a.name} is resting in the medbay.`;
    if (a.trip) return `${a.name} is riding the rover.`;
    if (a.task) return `${a.name} is ${TASK_TEXT[a.task.kind]} for ${a.task.left} more hour${a.task.left === 1 ? '' : 's'}.`;
    if (state.sheltering && hasShelter(state)) return 'The crew is in the storm shelter. Send them back to work first.';
    return null;
  }
  /** For code that doesn't say who (tests, old saves): the active Engineer with the fewest jobs. */
  function pickEngineer(state) {
    const jobs = jobList(state), count = (a) => jobs.filter((j) => j.assignee === a.id).length;
    return activeCrew(state).filter((a) => a.role === 'engineer').sort((x, y) => count(x) - count(y) || x.id - y.id)[0] || null;
  }
  function resolveEngineer(state, workerId) {
    if (workerId == null) return { a: pickEngineer(state) };
    const a = crewById(state, workerId);
    const why = roleWhy(a, 'engineer', 'build and repair');
    return why ? { why } : { a };
  }
  /** Give a job (building site or planned repair) to another Engineer. */
  function assignWorker(state, id, workerId) {
    if (typeof id === 'string' && id.startsWith('berm')) { // the moon-dirt shield on a HAB
      const H = habOfBermKey(state, id);
      if (!H || !H.berm.building || H.berm.built) return { ok: false, why: 'There is no job here.' };
      const w = resolveEngineer(state, workerId);
      if (w.why || !w.a) return { ok: false, why: w.why || 'No Engineer is available.' };
      H.berm.worker = w.a.id;
      return { ok: true, worker: w.a };
    }
    const m = state.modules.find((x) => x.id === id);
    if (!m || (m.built && !m.repair)) return { ok: false, why: 'There is no job here.' };
    const w = resolveEngineer(state, workerId);
    if (w.why || !w.a) return { ok: false, why: w.why || 'No Engineer is available.' };
    if (!m.built) m.worker = w.a.id; else m.repair.worker = w.a.id;
    return { ok: true, worker: w.a };
  }

  // ----- Research Bay -----
  const researchCost = (state) => cfg().research.costBase + cfg().research.costStep * state.researchCount;
  /** Is this building within reach of a working (not damaged) Research Bay? */
  function inLabRange(state, m) {
    const R = cfg().research.radius, cx = m.c + m.w / 2, cy = m.r + m.h / 2;
    return built(state, 'lab').some((l) => !l.damaged && Math.hypot(l.c + l.w / 2 - cx, l.r + l.h / 2 - cy) <= R);
  }
  /** Production multiplier from research (1 = no boost, 2 = fully upgraded and near a Research Bay). */
  function boostOf(state, m) {
    const lv = state.research[m.type] || 0;
    return lv && inLabRange(state, m) ? 1 + lv * cfg().research.levelBoost : 1;
  }
  const plannedLevel = (state, t) => state.research[t] + state.crew.filter((a) => [a.task, a.paused].some((k) => k && k.kind === 'lab' && k.target === t)).length;
  /** The Scientist spends 1 day in the Research Bay to research one upgrade. (Going to the shelter pauses it.) */
  function startResearch(state, labId, crewId, target) {
    const C = cfg(), R = C.research, m = state.modules.find((x) => x.id === labId);
    if (!m || m.type !== 'lab' || !m.built) return { ok: false, why: 'Not ready yet' };
    if (m.damaged) return { ok: false, why: 'This Research Bay is damaged. Pick an Engineer and click it to repair it.' };
    const a = crewById(state, crewId);
    const why = roleWhy(a, 'scientist', 'do research') || busyWhy(state, a);
    if (why) return { ok: false, why };
    if (a.paused && a.paused.kind === 'lab') return { ok: false, why: `${a.name} has paused research. Click a Research Bay to continue it first.` };
    if (!R.targets.includes(target)) return { ok: false, why: 'Unknown research' };
    if (plannedLevel(state, target) >= R.maxLevel) return { ok: false, why: `${C.modules[target].name}s are already fully upgraded (${1 + R.maxLevel * R.levelBoost}x).` };
    const cost = researchCost(state);
    if (state.res.parts < cost) return { ok: false, why: `This upgrade needs ${cost} parts (you have ${state.res.parts}).` };
    state.res.parts -= cost;
    state.researchCount++;
    a.task = { kind: 'lab', id: m.id, left: R.hours, total: R.hours, target };
    a.where = 'lab'; // start walking there now (the next game hour counts as the first hour)
    a.job = null; a.gymLeft = 0; a.gymId = null;
    log(state, 'info', `${a.name} started researching faster ${C.modules[target].name}s (${cost} parts, ${R.hours} h in the Research Bay).`);
    return { ok: true, cost, who: a };
  }
  /** The Botanist spends 1 day in a greenhouse: it grows 2x food meanwhile. */
  function tendGreenhouse(state, id, crewId) {
    const C = cfg(), m = state.modules.find((x) => x.id === id);
    if (!m || m.type !== 'greenhouse' || !m.built) return { ok: false, why: 'Not ready yet' };
    const a = crewById(state, crewId);
    const why = roleWhy(a, 'botanist', 'work in the greenhouse') || busyWhy(state, a);
    if (why) return { ok: false, why };
    if (a.paused && a.paused.kind === 'greenhouse') return resumeTask(state, id, crewId); // finish the paused day first
    a.task = { kind: 'greenhouse', id: m.id, left: C.botany.hours, total: C.botany.hours };
    a.where = 'greenhouse';
    a.job = null; a.gymLeft = 0; a.gymId = null;
    log(state, 'info', `${a.name} is tending the greenhouse for ${C.botany.hours / 24} day: ${C.botany.mult}x food.`);
    return { ok: true, who: a };
  }
  /**
   * A Scientist or Botanist whose task was paused (they went to the shelter) goes back to work: the player
   * picks them and clicks a Research Bay / greenhouse. The hours that were left carry on (no extra parts).
   */
  function resumeTask(state, id, crewId) {
    const C = cfg(), m = state.modules.find((x) => x.id === id), a = crewById(state, crewId);
    if (!a || !a.paused) return { ok: false, why: 'There is nothing paused to continue.' };
    const P = a.paused, type = P.kind === 'lab' ? 'lab' : 'greenhouse';
    if (!m || !m.built || m.type !== type) return { ok: false, why: `Click a ${C.modules[type].name} to continue.` };
    if (type === 'lab' && m.damaged) return { ok: false, why: 'This Research Bay is damaged. Pick an Engineer and click it to repair it.' };
    const why = roleWhy(a) || busyWhy(state, a);
    if (why) return { ok: false, why };
    a.task = { ...P, id: m.id };
    a.paused = null;
    a.where = type; a.job = null; a.gymLeft = 0; a.gymId = null;
    log(state, 'info', `${a.name} went back to ${type === 'lab' ? 'the research' : 'the greenhouse'}: ${a.task.left} h left.`);
    return { ok: true, who: a, resumed: true, left: a.task.left };
  }
  /** The player sends one astronaut to train in a Fitness Center (2 hours). Nobody goes by themselves. */
  function sendToGym(state, id, crewId) {
    const B = cfg().astro.bone, m = state.modules.find((x) => x.id === id);
    if (!m || m.type !== 'gym' || !m.built) return { ok: false, why: 'Not ready yet' };
    if (m.damaged) return { ok: false, why: 'This Fitness Center is damaged. Pick an Engineer and click it to repair it.' };
    if (!m.on || !m.powered) return { ok: false, why: 'This Fitness Center has no power (or is turned off).' };
    const a = crewById(state, crewId);
    const why = roleWhy(a) || busyWhy(state, a);
    if (why) return { ok: false, why };
    if (a.gymLeft > 0 && a.gymId === m.id) return { ok: false, why: `${a.name} is already training here.` };
    if (state.crew.some((x) => x !== a && !x.medbay && x.gymLeft > 0 && x.gymId === m.id)) return { ok: false, why: 'Someone is already training here (one astronaut at a time).' };
    a.gymId = m.id; a.gymLeft = B.visitH; a.where = 'gym';
    return { ok: true, who: a };
  }
  const isSlow = (a) => a.stress >= cfg().astro.stress.slowAt;
  const isGrounded = (a) => a.bone < cfg().astro.bone.groundedBelow;
  /** Radiation never heals, so it sets the highest health an astronaut can ever get back to. */
  const maxHp = (a) => clamp(100 - a.dose * cfg().astro.hpPerMsv, 0, 100);
  function addWound(state, a, hp, what) {
    a.wounds.push({ hp, what, h: state.hour });
    a.injury = a.wounds.reduce((s, w) => s + w.hp, 0);
  }
  /** Permanently out on the Moon: bones reached 0%. They stay in the medbay (and on the roster). */
  function sendToMedbay(state, a, why, say) {
    a.medbay = true; a.medbayAt = state.hour; a.medbayWhy = why; a.job = null; a.where = 'medbay'; a.gymLeft = 0; a.gymId = null; a.heal = null; a.task = null; a.paused = null;
    say('bad', `🏥 ${a.name} was taken to the medbay`,
      `${a.name}'s bones got too weak to stand safely (0% bone density), so the crew carried them to the medbay inside the habitat to rest. They are safe, but they won't be back for this mission.`);
  }
  /**
   * Health bar empty: the astronaut is MEDICALLY RETIRED and flies home to Earth. They leave the roster
   * (state.crew) for good; state.sentHome remembers them for the debrief. The game shows a pop-up.
   */
  function sendHome(state, a, say) {
    Object.assign(a, { home: true, homeAt: state.hour, job: null, where: 'earth', gymLeft: 0, gymId: null, heal: null, task: null, paused: null, trip: false });
    state.crew = state.crew.filter((x) => x !== a);
    state.sentHome.push(a);
    const left = activeCrew(state).length;
    say('bad', `🚀 ${a.name} has been sent home to Earth`,
      `Their health bar is empty (${Math.round(a.dose)} mSv of radiation; NASA's career limit is 600 mSv). They are medically retired from Moon missions. ` +
      (left ? `${left} astronaut${left > 1 ? 's' : ''} left at the base.` : 'Nobody is left to run the base.'),
      { popup: 'home', who: a.name, id: a.id, dose: a.dose, injury: a.injury, left });
  }
  /**
   * Running out of air, heat, food or water no longer ends the game by itself: it hurts the astronauts
   * every hour (an "injury" the medbay can heal) until they are sent home. Same-kind harm adds up in one wound.
   */
  function harm(state, a, cause, what, hp) {
    const w = a.wounds.find((x) => x.what === what);
    if (w) w.hp += hp; else a.wounds.push({ hp, what, h: state.hour });
    a.injury = a.wounds.reduce((s, x) => s + x.hp, 0);
    state.stats.harm[cause] = (state.stats.harm[cause] || 0) + hp;
    if (!state.stats.firstHarm) state.stats.firstHarm = cause;
  }

  // ----- crew spaceship (every 30 days) and Landing Pads -----
  const mid = (m) => ({ c: m.c + m.w / 2, r: m.r + m.h / 2 });
  const gap = (a, b) => Math.hypot(mid(a).c - mid(b).c, mid(a).r - mid(b).r);
  /** Is a Landing Pad at (c, r) close enough to a HAB? (finishedOnly: count only HABs that are built) */
  function padNearHab(state, c, r, finishedOnly) {
    const d = cfg().modules.pad, spot = { c, r, w: d.w, h: d.h };
    return state.modules.some((m) => m.type === 'hab' && (m.built || !finishedOnly) && gap(spot, m) <= cfg().pad.radius);
  }
  /** Where a crew spaceship can land now: finished Landing Pads within reach of a finished HAB. */
  function landingSpots(state) {
    return built(state, 'pad').map((p) => ({ pad: p, habs: habs(state).filter((H) => gap(p, H) <= cfg().pad.radius) })).filter((s) => s.habs.length);
  }
  /**
   * The new astronauts from a spaceship join: the player picked their jobs and the HAB they live in
   * (their "home"; only a rover trip can change it later).
   */
  /** The HAB closest to a Landing Pad: where astronauts who land on that pad live. */
  function homeForPad(state, padId) {
    const p = state.modules.find((m) => m.id === padId && m.type === 'pad');
    const list = habs(state);
    return p ? list.reduce((b, H) => (gap(p, H) < gap(p, b) ? H : b), list[0]) : hab(state);
  }
  /**
   * The new astronauts from a spaceship join. The player picked their jobs and the Landing Pad the ship
   * landed on; they live in the HAB closest to that pad (only a rover trip can move them later).
   */
  function joinCrew(state, roles, padId) {
    const C = cfg(), n = Math.min(state.pendingCrew, roles.length), added = [];
    const home = homeForPad(state, padId != null ? padId : state.landedPadId);
    for (let i = 0; i < n; i++) {
      const id = state.nextCrewId++;
      const a = newAstronaut(id, `Astronaut ${id}`, C.astro.roleInfo[roles[i]] ? roles[i] : 'engineer', home.id, 0);
      state.crew.push(a); added.push(a);
    }
    state.pendingCrew -= n; state.crewTotal += n;
    if (n) log(state, 'good', `New crew: ${added.map((a) => `${a.name} (${roleName(a.role)})`).join(', ')}, living in ${habName(state, home)}.`);
    return added;
  }

  // ----- rover: fast travel between HABs -----
  /** Buy the rover (once). It starts parked at the first HAB. */
  function buyRover(state) {
    const C = cfg();
    if (state.rover) return { ok: false, why: 'You already have a rover.' };
    if (state.res.parts < C.rover.cost) return { ok: false, why: `The rover needs ${C.rover.cost} parts (you have ${state.res.parts}).` };
    state.res.parts -= C.rover.cost;
    state.rover = { habId: hab(state).id, trip: null };
    log(state, 'good', `Rover built! It is parked at ${habName(state, hab(state))}.`);
    return { ok: true };
  }
  /** Who can get in: astronauts living at the rover's HAB who aren't busy. */
  function roverRiders(state) {
    const rv = state.rover;
    if (!rv) return [];
    return activeCrew(state).filter((a) => homeOf(state, a).id === rv.habId && !a.heal && !a.task && !a.trip);
  }
  /** Drive up to 4 astronauts from the rover's HAB to another HAB. The rover stays there afterwards. */
  function startTrip(state, toId, ids) {
    const C = cfg(), rv = state.rover;
    if (!rv) return { ok: false, why: 'Build a rover first.' };
    if (rv.trip) return { ok: false, why: 'The rover is already driving.' };
    if (state.sheltering && hasShelter(state)) return { ok: false, why: 'The crew is in the storm shelter.' };
    const from = state.modules.find((m) => m.id === rv.habId), to = state.modules.find((m) => m.id === toId && m.type === 'hab' && m.built);
    if (!to || to === from) return { ok: false, why: 'Pick another HAB to drive to.' };
    const want = [...new Set(ids)];
    if (want.length > C.rover.seats) return { ok: false, why: `The rover has ${C.rover.seats} seats.` };
    const ok = roverRiders(state).map((a) => a.id);
    const crew = want.filter((id) => ok.includes(id));
    if (!crew.length) return { ok: false, why: 'Pick at least one astronaut who is at this HAB.' };
    const dist = Math.hypot(to.c - from.c, to.r - from.r);
    const hours = Math.max(1, Math.ceil(dist / C.rover.tilesPerH));
    rv.trip = { from: from.id, to: to.id, crew, left: hours, total: hours };
    for (const a of state.crew) if (crew.includes(a.id)) Object.assign(a, { trip: true, job: null, gymLeft: 0, gymId: null, where: 'rover' });
    log(state, 'info', `Rover: ${crew.length} astronaut${crew.length > 1 ? 's' : ''} driving from ${habName(state, from)} to ${habName(state, to)} (${hours} h).`);
    return { ok: true, hours };
  }

  /** Everyone who started the mission: on the roster, plus the ones sent home. */
  const allCrew = (state) => state.crew.concat(state.sentHome || []).sort((x, y) => x.id - y.id);

  /** Heal `amount` HP of injuries, smallest injury first. Healed injuries disappear. */
  function healWounds(a, amount) {
    let left = amount;
    for (const w of a.wounds.slice().sort((x, y) => x.hp - y.hp)) {
      if (left <= 0) break;
      const take = Math.min(w.hp, left);
      w.hp -= take; left -= take;
    }
    a.wounds = a.wounds.filter((w) => w.hp > 1e-9);
    a.injury = a.wounds.reduce((s, w) => s + w.hp, 0);
  }
  /** How much one treatment would heal: always healHp, but never above the radiation limit (maxHp). */
  const healAmount = (a) => Math.min(cfg().astro.medbay.healHp, a.injury);

  /**
   * Send an astronaut to rest in the medbay for 3 days. It heals exactly healHp (10) of injuries, but never
   * above their radiation limit (maxHp). The medbay can do this C.astro.medbay.uses times per mission.
   */
  function startHeal(state, id) {
    const M = cfg().astro.medbay, a = state.crew.find((x) => x.id === id);
    if (!a || a.medbay) return { ok: false, why: 'This astronaut cannot be treated.' };
    if (a.heal) return { ok: false, why: `${a.name} is already resting in the medbay.` };
    if (a.task) return { ok: false, why: `${a.name} is ${TASK_TEXT[a.task.kind]} for ${a.task.left} more hours. Try again after.` };
    if (state.medbayUses >= M.uses) return { ok: false, why: `The medbay's supplies are used up (${M.uses} treatments per mission).` };
    if (!a.wounds.length) return { ok: false, why: `${a.name} has no injuries to heal. Radiation damage can never be healed.` };
    const amount = healAmount(a);
    state.medbayUses++;
    a.heal = { left: M.healH, total: M.healH, amount };
    a.job = null; a.gymLeft = 0; a.gymId = null; a.where = 'medbay';
    log(state, 'info', `${a.name} went to the medbay (+${Math.round(amount)} HP over ${M.healH / 24} days). Treatments left: ${M.uses - state.medbayUses}.`);
    return { ok: true, amount };
  }
  const crewSummary = (state) => {
    const act = activeCrew(state);
    return { active: act.length, total: state.crewTotal, avgHp: act.length ? act.reduce((s, a) => s + a.hp, 0) / act.length : 0 };
  };

  /** Pick an Engineer, click a damaged building: costs parts, then that Engineer goes out to fix it. */
  function orderRepair(state, id, workerId) {
    const C = cfg(), m = state.modules.find((x) => x.id === id);
    if (!m || !m.built || !m.damaged) return { ok: false, why: 'Nothing to repair' };
    if (m.repair) return { ok: false, why: 'A repair is already planned for this building' };
    if (state.res.parts < C.damage.repairCost) return { ok: false, why: `Repairs need ${C.damage.repairCost} part (you have ${state.res.parts})` };
    const w = resolveEngineer(state, workerId);
    if (w.why) return { ok: false, why: w.why };
    state.res.parts -= C.damage.repairCost;
    m.repair = { progress: 0, work: Math.max(2, Math.ceil(C.modules[m.type].work * C.damage.repairWork)), seq: ++state.jobSeq, worker: w.a ? w.a.id : null };
    log(state, 'info', `Repair ordered: ${C.modules[m.type].name}` + (w.a ? ` (${w.a.name})` : ''));
    return { ok: true, worker: w.a };
  }

  /** Hours until this Astronomy Tower can be used again (0 = ready). */
  const towerReadyIn = (state, m) => (m.usedAt == null ? 0 : Math.max(0, m.usedAt + cfg().astro.stress.towerCooldownH - state.hour));
  /** One astronaut visits an Astronomy Tower: only THEIR stress goes down. Each tower works every 12 hours. */
  function useTower(state, id, crewId) {
    const C = cfg(), m = state.modules.find((x) => x.id === id);
    if (!m || m.type !== 'tower' || !m.built) return { ok: false, why: 'Not ready yet' };
    if (m.damaged) return { ok: false, why: 'This tower is damaged and cannot be used. Pick an Engineer and click it to repair it.' };
    const wait = towerReadyIn(state, m);
    if (wait > 0) return { ok: false, why: `Someone used this tower recently. It can be used again in ${wait} hour${wait === 1 ? '' : 's'}.` };
    const a = crewById(state, crewId);
    const why = roleWhy(a) || busyWhy(state, a);
    if (why) return { ok: false, why };
    const before = a.stress;
    a.stress = Math.max(0, a.stress - C.astro.stress.towerRelief);
    m.usedAt = state.hour;
    state.towerVisits++;
    a.task = { kind: 'tower', id: m.id, left: 1, total: 1 }; // they spend this hour at the tower
    a.where = 'tower';
    log(state, 'good', `${a.name} looked through the Astronomy Tower: stress -${Math.round(before - a.stress)}.`);
    return { ok: true, relief: before - a.stress, visit: state.towerVisits, who: a };
  }

  function moduleAt(state, c, r) {
    return state.modules.find((m) => c >= m.c && c < m.c + m.w && r >= m.r && r < m.r + m.h);
  }

  function canPlace(state, type, c, r) {
    const C = cfg(), d = C.modules[type];
    if (!d) return { ok: false, why: 'Not buildable' };
    // (HABs are built like everything else: 15 parts, one Engineer.)
    if (c < 0 || r < 0 || c + d.w > C.map.cols || r + d.h > C.map.rows) return { ok: false, why: 'Outside the map' };
    for (let dc = 0; dc < d.w; dc++) for (let dr = 0; dr < d.h; dr++) if (moduleAt(state, c + dc, r + dr)) return { ok: false, why: 'Something is already here' };
    if (state.res.parts < d.cost) return { ok: false, why: `Needs ${d.cost} parts (you have ${state.res.parts})` };
    const z = zoneOf(state, c, r);
    if (d.onlyZone && z !== d.onlyZone) return { ok: false, why: 'Ice Drill must go on the dark ice area' };
    if (type === 'pad' && !padNearHab(state, c, r, false)) return { ok: false, why: `A Landing Pad must be within ${C.pad.radius} squares of a HAB (gold circles).` };
    // Each pad has its own area: no other Landing Pad (built or planned) within the same radius.
    if (type === 'pad') {
      const spot = { c, r, w: d.w, h: d.h };
      if (state.modules.some((m) => m.type === 'pad' && gap(spot, m) <= C.pad.radius)) return { ok: false, why: `Too close to another Landing Pad: pads must be more than ${C.pad.radius} squares apart (red circles).` };
    }
    return { ok: true, zone: z };
  }

  /** Build something. workerId = the Engineer the player picked (if left out: the least busy Engineer). */
  function place(state, type, c, r, workerId) {
    const chk = canPlace(state, type, c, r);
    if (!chk.ok) return chk;
    const w = resolveEngineer(state, workerId);
    if (w.why) return { ok: false, why: w.why };
    state.res.parts -= cfg().modules[type].cost;
    const m = addModule(state, type, c, r, false);
    m.worker = w.a ? w.a.id : null;
    return { ok: true, m, worker: w.a };
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

  /** Pile moon dirt on a HAB (default: the Engineer's own HAB). */
  function startBerm(state, workerId, habId) {
    const w = resolveEngineer(state, workerId);
    if (w.why) return { ok: false, why: w.why };
    const H = (habId && state.modules.find((m) => m.id === habId && m.type === 'hab')) || (w.a ? homeOf(state, w.a) : hab(state));
    if (H.berm.built || H.berm.building) return { ok: false, why: `${habName(state, H)}'s shield is already ${H.berm.built ? 'finished' : 'being built'}.` };
    H.berm.building = true;
    H.berm.seq = ++state.jobSeq;
    H.berm.worker = w.a ? w.a.id : null;
    log(state, 'info', `${w.a ? w.a.name : 'The crew'} starts piling moon dirt on ${habName(state, H)}.`);
    return { ok: true, worker: w.a, hab: H };
  }

  function setShelter(state, on) {
    if (on && !hasShelter(state)) return false;
    if (state.sheltering === on) return true;
    state.sheltering = on;
    if (on) {
      // Everyone goes: research and greenhouse work are put on hold (the player sends them back later),
      // tower visits and Fitness Center sessions end.
      for (const a of activeCrew(state)) {
        if (a.task && (a.task.kind === 'lab' || a.task.kind === 'greenhouse')) a.paused = a.task;
        a.task = null; a.gymLeft = 0; a.gymId = null;
      }
    }
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
    const rise = cfg().rad.storm.rise;
    // May 2024: the real hour-by-hour LRO measurement for its first 30 days (those storms have .curve).
    let s = state.radCurve && h < state.radCurve.length ? crewRate(state.radCurve[Math.floor(h)] || 0) : 0;
    for (const st of state.storms) {
      const t = h - st.h;
      if (t < 0 || st.curve) continue;
      if (st.profile) { s += crewRate(st.profile[Math.floor(t)] || 0); continue; }
      if (t > 120) continue;
      s += t < rise ? (st.peak * t) / rise : st.peak * Math.exp(-(t - rise) / st.tau);
    }
    return s;
  }

  // ---------- weather damage ----------
  function damageRoll(state, chance, cause, say) {
    const C = cfg(), hit = [];
    for (const m of built(state)) {
      if (m.damaged || !C.damage.canBreak.includes(m.type)) continue;
      if (rnd(state) < chance) { m.damaged = true; hit.push(C.modules[m.type].name); }
    }
    if (hit.length) {
      say('warn', `🔧 Damaged by ${cause}: ${hit.join(', ')}`,
        'Damaged buildings work at half speed (Fitness Centers, Astronomy Towers and Research Bays can\'t be used). Pick an Engineer, then click a damaged building to repair it (1 part).');
    }
  }

  // ---------- accidents with machines (cost supplies) ----------
  function accidentRoll(state, say) {
    const C = cfg(), X = C.accidents, R = state.res;
    if (state.hour < X.startH || rnd(state) >= X.chancePerH) return;
    const list = built(state).filter((m) => X[m.type] && m.on && !m.damaged);
    if (!list.length) return;
    const m = list[Math.floor(rnd(state) * list.length)];
    const A = X[m.type];
    let lost, unit, title, text;
    if (m.type === 'drill') {
      lost = Math.min(R.water, A.water); R.water -= lost; unit = 'kg water';
      title = '⛏️ Ice Drill accident: a pipe froze and cracked'; text = `${Math.round(lost)} kg of water leaked out before the crew could shut it off.`;
    } else if (m.type === 'greenhouse') {
      lost = Math.min(R.food, A.food); R.food -= lost; unit = 'kg food';
      title = '🌱 Greenhouse accident: plant disease'; text = `Mold spread through the plants. ${Math.round(lost)} kg of food had to be thrown away.`;
    } else if (m.type === 'o2gen') {
      lost = Math.min(R.o2, A.o2); R.o2 -= lost; unit = 'kg O₂';
      title = '💨 O₂ Generator accident: a valve leaked'; text = `${Math.round(lost)} kg of stored oxygen escaped into space.`;
    } else {
      lost = Math.min(R.battery, A.battery); R.battery -= lost; unit = 'kWh'; m.dustLeft = A.dustH;
      title = '☀️ Moondust covered a Solar Panel'; text = `Moondust is electrically charged, so it sticks. The panel makes half power for ${A.dustH / 24} day, and shaking it clean used ${Math.round(lost)} kWh of battery.`;
    }
    const acc = { h: state.hour, type: m.type, id: m.id, lost, unit, title };
    state.stats.accidents.push(acc);
    state.lastAccident = acc;
    say('warn', title, text + ' More (or upgraded) machines refill supplies faster.');
  }

  // ---------- crew: where everyone goes this hour ----------
  // Order of importance: medbay rest → shelter (if the player sent the crew there) → 1-day tasks the player
  // gave (Research Bay, greenhouse, tower visit) → Fitness Center (only when the player sent them) →
  // Engineers work on the oldest job the player gave them → habitat.
  function assignCrew(state, say) {
    for (const a of activeCrew(state)) if (a.heal) { a.where = 'medbay'; a.job = null; } // resting: not available for anything else
    for (const a of activeCrew(state)) if (a.trip) { a.where = 'rover'; a.job = null; } // riding the rover
    const C = cfg(), B = C.astro.bone, act = activeCrew(state).filter((a) => !a.heal && !a.trip);
    const jobs = jobList(state);
    for (const a of act) a.job = null;
    if (state.sheltering && hasShelter(state)) { for (const a of act) a.where = 'shelter'; return; } // jobs wait
    for (const a of act) if (a.task) a.where = a.task.kind;
    const free = act.filter((a) => !a.task);
    // Weak bones: Engineers are not allowed outside (fracture risk) until they train back up.
    for (const a of free) {
      if (a.role !== 'engineer') continue;
      if (isGrounded(a)) {
        if (!a.groundedWarned) { a.groundedWarned = true; say('warn', `🦴 ${a.name} is grounded`, `Bone density is below ${B.groundedBelow}%, so it is not safe to work outside. They need to train in a Fitness Center.`); }
      } else a.groundedWarned = false;
    }
    // Fitness Center: only astronauts the player sent there (sendToGym). The session ends early if the
    // gym breaks, loses power or is switched off.
    const gyms = built(state, 'gym').filter((m) => m.on && m.powered && !m.damaged);
    const busy = new Set();
    for (const a of free) {
      if (a.gymLeft > 0 && gyms.some((g) => g.id === a.gymId) && !busy.has(a.gymId)) busy.add(a.gymId);
      else { a.gymLeft = 0; a.gymId = null; }
    }
    // Each Engineer works on the oldest job the player gave them (one astronaut per job, never two).
    for (const a of free) {
      if (a.gymLeft > 0 || a.role !== 'engineer' || isGrounded(a)) continue;
      const j = jobs.find((x) => x.assignee === a.id);
      if (j) a.job = j.key;
    }
    for (const a of free) a.where = a.job ? 'outside' : a.gymLeft > 0 ? 'gym' : 'hab';
  }

  /** A 1-day task (or tower visit) is over. */
  function finishTask(state, a, t, say) {
    const C = cfg(), R = C.research;
    if (t.kind === 'lab') {
      state.research[t.target]++;
      const name = C.modules[t.target].name, x = 1 + state.research[t.target] * R.levelBoost;
      say('good', `🔬 Research done: ${name}s now work ${x}x as fast`, `${a.name} finished the experiment. Only ${name}s within ${R.radius} tiles of a Research Bay get the boost.` +
        (t.target === 'o2gen' ? ' (Faster O₂ Generators also split water faster.)' : ''));
    } else if (t.kind === 'greenhouse') {
      say('good', `🌱 ${a.name} finished a day in the greenhouse`, `The plants grew ${C.botany.mult}x as fast while they were looked after.`);
    }
  }

  // ---------- crew: one hour of radiation, stress, bones and accidents for each astronaut ----------
  function updateCrew(state, S, shower, say) {
    const C = cfg(), A = C.astro, bg = C.rad.surfacePerH, Hm = C.endless.harm;
    const shelterOk = hasShelter(state);
    const stormOn = S > C.rad.stormOn;
    const per = 1 / state.crewTotal; // doseFrom = crew average, for the debrief
    for (const a of activeCrew(state)) {
      // Radiation. Outside = everything; inside any building (habitat, Research Bay, greenhouse, tower, gym,
      // medbay, rover) = like their HAB (less with its moon-dirt shield); shelter = 95% blocked.
      const home = homeOf(state, a);
      const inside = home.berm.built ? C.rad.habBerm : C.rad.hab;
      const exposed = isExposed(a);
      const inRover = a.where === 'rover'; // fully shielded: no radiation, no storm or meteor worries
      const f = inRover ? C.rad.rover : exposed ? 1 : a.where === 'shelter' ? (shelterOk ? C.rad.shelter : inside) : inside;
      const dBg = f * bg, dStorm = f * S;
      a.dose += dBg + dStorm;
      if (exposed) state.doseFrom.outside += (dBg + dStorm) * per;
      else { state.doseFrom.background += dBg * per; state.doseFrom.storm += dStorm * per; }

      // Stress: isolation outside, plus being caught (unprotected) in a storm or a meteor shower.
      const St = A.stress;
      let ds = 0;
      if (a.where === 'outside') ds += St.outsidePerH;
      if (a.where === 'gym') ds -= St.gymReliefPerH; // exercise helps the mind too
      if (stormOn && !inRover) ds += exposed ? St.stormOutsidePerH : a.where === 'shelter' ? St.stormShelterPerH : St.stormInsidePerH;
      if (shower && !inRover) ds += a.where === 'outside' ? St.meteorOutsidePerH : St.meteorInsidePerH;
      const wasSlow = isSlow(a);
      a.stress = clamp(a.stress + ds, 0, 100);
      if (!wasSlow && isSlow(a)) say('warn', `😰 ${a.name} is very stressed`, `Stress ${Math.round(a.stress)}: they now work at half speed. Pick them and click an Astronomy Tower or a Fitness Center to lower their stress.`);

      // Bones: always weakening in Moon gravity; training in the Fitness Center builds them back.
      const Bo = A.bone;
      if (a.where === 'gym') {
        a.bone = Math.min(100, a.bone + Bo.gymGainPerH * (a.bone < Bo.severeBelow ? Bo.severeGymFactor : 1));
        a.gymLeft--;
        if (a.gymLeft <= 0) { a.sinceGym = 0; a.gymId = null; }
      } else a.sinceGym++;
      a.bone = Math.max(0, a.bone - Bo.lossPerH);
      // Weaker bones = more and worse injuries, and worry adds stress.
      const tier = a.bone < Bo.severeBelow ? 2 : a.bone < Bo.fragileBelow ? 1 : 0;
      if (tier > a.boneTier) {
        if (tier === 1) say('warn', `🦴 ${a.name} has FRAGILE bones (${Math.round(a.bone)}%)`, `Below ${Bo.fragileBelow}%: fractures happen ${Bo.fragileMult}x as often and hurt ${Bo.fragileMult}x as much, and they are worried (stress). Get them to a Fitness Center!`);
        else say('bad', `🦴 ${a.name} has SEVERE bone loss (${Math.round(a.bone)}%)`, `Below ${Bo.severeBelow}%: injuries ${Bo.severeMult}x, more stress, and training only works half as well. At 0% they must go to the medbay for good.`);
      }
      a.boneTier = tier;
      if (tier) a.stress = clamp(a.stress + (tier === 2 ? Bo.severeStressPerH : Bo.fragileStressPerH), 0, 100);
      const mult = tier === 2 ? Bo.severeMult : tier === 1 ? Bo.fragileMult : 1;
      if (a.bone < Bo.injuryBelow && rnd(state) < Bo.injuryChancePerH * mult) {
        const hurt = Bo.injuryHp * mult, what = tier ? 'bone fracture' : 'sprain';
        addWound(state, a, hurt, what); a.injuries++;
        log(state, 'warn', `${a.name} got a ${what} (weak bones): -${hurt} HP.`);
      }

      // Meteor hits (only when outside).
      if (shower && a.where === 'outside' && rnd(state) < C.meteor.hitChancePerH) {
        const [lo, hi] = C.meteor.hitHp;
        const dmg = Math.round(lo + rnd(state) * (hi - lo));
        addWound(state, a, dmg, 'meteoroid hit'); a.hits++;
        say('bad', `☄️ ${a.name} was hit by a tiny meteoroid!`, `-${dmg} HP. Their suit held, but they should come inside.`);
      }
      // Work accidents (rare): micro-explosions during experiments, slips with farming tools.
      if (a.where === 'lab' && rnd(state) < C.research.accidentChancePerH) {
        const hp = C.research.accidentHp;
        addWound(state, a, hp, 'lab micro-explosion'); a.accidents++;
        say('bad', '💥 Micro-explosion in the Research Bay!', `${a.name} was hurt by a tiny explosion during an experiment: -${hp} HP. The research goes on.`);
      } else if (a.where === 'greenhouse' && rnd(state) < C.botany.accidentChancePerH) {
        const hp = C.botany.accidentHp;
        addWound(state, a, hp, 'farming tool accident'); a.accidents++;
        say('bad', '🌱 Greenhouse tool accident!', `${a.name} slipped with a sharp farming tool: -${hp} HP.`);
      }

      // Medbay rest: injuries heal a little every hour for 3 days (exactly healHp in total, smallest first).
      if (a.heal) {
        const H = a.heal;
        healWounds(a, H.amount / H.total);
        H.left--;
        if (H.left <= 0) {
          a.heal = null;
          say('good', `🏥 ${a.name} has healed`, `+${Math.round(H.amount)} HP. Radiation damage stays: they can never go above ${Math.round(maxHp(a))} HP.`);
        }
      }
      // 1-day tasks count down (Research Bay, greenhouse, tower visit).
      if (a.task) {
        a.task.left--;
        if (a.task.left <= 0) { const t = a.task; a.task = null; finishTask(state, a, t, say); }
      }

      // No air, too cold, no food or no water: health drops every hour (see harm()).
      if (state.res.o2 <= 0.01) harm(state, a, 'o2', 'no oxygen', Hm.noO2PerH);
      if ((a.where === 'hab' || a.where === 'medbay') && home.temp < C.habTemp.fail) harm(state, a, 'cold', 'cold', Hm.coldPerH);
      if (state.foodOutH >= C.fail.foodGraceH) harm(state, a, 'food', 'hunger', Hm.hungerPerH);
      if (state.waterOutH >= C.fail.waterGraceH) harm(state, a, 'water', 'thirst', Hm.thirstPerH);

      // Health: radiation over the whole session (can never heal: maxHp) minus injuries (the medbay can heal those).
      a.hp = clamp(maxHp(a) - a.injury, 0, 100);
      if (a.hp < 50 && a.warnedHp < 1) { a.warnedHp = 1; say('warn', `❤️ ${a.name} is down to ${Math.round(a.hp)} HP`, 'Radiation damage never heals. Injuries can be healed in the medbay (button in the AMS).'); }
      if (a.hp < 25 && a.warnedHp < 2) { a.warnedHp = 2; say('bad', `❤️ ${a.name} is down to ${Math.round(a.hp)} HP!`, 'If their health runs out they will be medically retired and sent home to Earth.'); }
      if (a.hp <= 0) sendHome(state, a, say);
      else if (a.bone <= 0) sendToMedbay(state, a, 'bones', say);
    }
    // Crew average dose (charts and score).
    state.dose = allCrew(state).reduce((s, a) => s + a.dose, 0) / state.crewTotal;
  }

  // ---------- power ----------
  /** kW one panel makes now: sunlight (half-covered Sun = half power) x damage x moondust x research boost. */
  function solarKw(state, m) {
    const C = cfg();
    if (!m.built || !m.on) return 0;
    return C.modules.solar.makes * (m.light || 0) * (m.damaged ? C.damage.brokenRate : 1) *
      (m.dustLeft > 0 ? C.accidents.solar.dustFactor : 1) * boostOf(state, m);
  }
  function updatePower(state, h, dryRun) {
    const C = cfg();
    let supply = 0;
    for (const m of built(state, 'solar')) {
      m.light = zoneLight(state, zoneOf(state, m.c, m.r), h + 0.5);
      m.lit = m.light > 0.5;
      m.powered = m.light > 0.02;
      supply += solarKw(state, m);
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
      if (startText) { log(state, level || 'warn', startText); events && events.push({ level: level || 'warn', title: startText }); }
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

    extendWorld(state);
    if (h === 0) say('info', 'CAPCOM: Welcome to Zain Base', `Keep the base running as long as you can. A crew spaceship brings a new HAB and ${C.endless.newCrew} astronauts every ${C.endless.shipEveryH / 24} days. Watch the sunlight forecast: the Sun circles the horizon here, so shadows move.`);

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
    // Each time a storm (or a new wave) starts, fast particles can glitch electronics.
    if (!stormWasOn && S > C.rad.stormOn) damageRoll(state, C.damage.stormChance, 'the radiation storm', say);

    // Meteor showers: forecast, start/end, building damage. (Hits on astronauts happen in the crew update below.)
    for (const s of state.meteors) {
      if (!s.warned && h + 1 >= s.h - C.meteor.warnLead) {
        s.warned = true;
        say('warn', `☄️ Meteor shower coming: the ${s.name}`,
          `It starts in about ${C.meteor.warnLead} hours and lasts ${s.dur} hours. Astronauts outside can be hit and buildings can be damaged. Keep the crew inside!` +
          (s.date ? ` (Real event: around ${s.date})` : ''), { banner: true });
      }
    }
    const shower = state.meteors.find((s) => h >= s.h && h < s.h + s.dur) || null;
    if (shower && state.meteorOn !== shower) say('bad', `☄️ The ${shower.name} meteor shower has started!`, 'Tiny space rocks are hitting the ground around the base.');
    if (!shower && state.meteorOn) log(state, 'good', 'The meteor shower is over.');
    state.meteorOn = shower;
    if (shower) damageRoll(state, C.damage.meteorChancePerH, 'meteors', say);
    // Random accidents with machines (water leak, plant disease, oxygen leak, moondust on a panel).
    accidentRoll(state, say);

    // Crew: who is where this hour (shelter, Fitness Center, outside on a job, or in the habitat).
    assignCrew(state, say);
    // Construction and repairs: each job has exactly one Engineer. Stressed astronauts work at half speed.
    const jobs = jobList(state);
    for (const a of activeCrew(state)) {
      if (a.where !== 'outside') continue;
      const j = jobs.find((x) => x.key === a.job);
      if (!j) continue;
      const work = isSlow(a) ? C.astro.stress.slowFactor : 1;
      if (j.kind === 'module') {
        j.m.progress += work;
        if (j.m.progress >= j.total) { j.m.built = true; a.job = null; say('good', `Built: ${C.modules[j.m.type].name}`, `${a.name} finished it.`); }
      } else if (j.kind === 'repair') {
        j.m.repair.progress += work;
        if (j.m.repair.progress >= j.total) { j.m.damaged = false; j.m.repair = null; a.job = null; say('good', `Repaired: ${C.modules[j.m.type].name}`, `${a.name} fixed it. It works at full speed again.`); }
      } else {
        const B = j.m.berm;
        B.progress += work;
        if (B.progress >= C.bermWork) { B.built = true; B.building = false; a.job = null; say('good', `${habName(state, j.m)} shielding finished`, `${a.name} finished piling moon dirt on the roof. It now blocks most radiation.`); }
      }
    }

    // Power.
    updatePower(state, h, false);
    for (const m of built(state, 'solar')) if (m.dustLeft > 0) m.dustLeft--;
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

    // Production & consumption. Damaged buildings work at half speed; research upgrades (near a Research Bay)
    // make them faster. Astronauts in the medbay use nothing.
    const U = C.use, n = activeCrew(state).length;
    const rate = (m) => (m.damaged ? C.damage.brokenRate : 1) * boostOf(state, m);
    for (const m of built(state, 'o2gen')) {
      const d = C.modules.o2gen, k = rate(m);
      m.noWater = m.powered && state.res.water < d.waterPerH * k;
      if (m.powered && !m.noWater) { state.res.water -= d.waterPerH * k; state.res.o2 += d.o2PerH * k; state.stats.o2Made += d.o2PerH * k; }
    }
    for (const m of built(state, 'drill')) if (m.powered) { const w = C.modules.drill.waterPerH * rate(m); state.res.water += w; state.stats.waterMined += w; }
    for (const m of built(state, 'greenhouse')) {
      const d = C.modules.greenhouse, k = rate(m);
      m.noWater = m.powered && state.res.water < d.waterPerH * k;
      if (m.powered && !m.noWater) {
        // The Botanist tending this greenhouse doubles its food. Nobody tending + crew in the shelter = half.
        const tended = state.crew.some((a) => !a.medbay && a.where === 'greenhouse' && a.task && a.task.id === m.id);
        const f = d.foodPerH * k * (tended ? C.botany.mult : state.sheltering ? 0.5 : 1);
        state.res.water -= d.waterPerH * k; state.res.food += f; state.stats.foodMade += f;
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

    // Habitat temperature: each HAB warms up with power and cools down without it (faster in the dark).
    const T = C.habTemp;
    for (const H of habs(state)) {
      const habDark = !zoneLitAt(state, zoneOf(state, H.c, H.r), h + 0.5);
      if (H.powered) H.temp = Math.min(T.normal, H.temp + T.heat);
      else H.temp = Math.max(-60, H.temp - (habDark ? T.coolDark : T.coolLit));
    }
    state.habTemp = Math.min(...habs(state).map((H) => H.temp));

    // Each astronaut: radiation → Health, Stress, Bone density, injuries, meteor hits, harm, medbay.
    updateCrew(state, S, shower, say);
    track(state, 'o2Empty', state.res.o2 <= 0.01, '😮‍💨 OXYGEN IS GONE! The crew is breathing from emergency suit tanks and losing health fast.', 'Oxygen is back.', ev, 'bad');
    track(state, 'habCold', state.habTemp < T.fail, `🥶 A habitat is below ${T.fail} °C: the astronauts inside are losing health. Give it power!`, 'The habitats are warm again.', ev, 'bad');
    track(state, 'starving', state.foodOutH >= C.fail.foodGraceH, '🍞 No food for 3 days: the crew is losing health.', null, ev, 'bad');
    track(state, 'thirsty', state.waterOutH >= C.fail.waterGraceH, '💧 No water for 2 days: the crew is losing health.', null, ev, 'bad');

    // Rover trip: one hour closer. On arrival the riders live at the new HAB, and the rover stays there.
    const rv = state.rover;
    if (rv && rv.trip && --rv.trip.left <= 0) {
      const to = state.modules.find((m) => m.id === rv.trip.to);
      const riders = state.crew.filter((a) => a.trip);
      for (const a of riders) { a.trip = false; a.homeId = to.id; a.where = 'hab'; }
      rv.habId = to.id; rv.trip = null;
      say('good', `🚙 The rover arrived at ${habName(state, to)}`, riders.length ? `${riders.map((a) => a.name).join(', ')} now live${riders.length > 1 ? '' : 's'} there.` : '');
    }

    // Crew spaceship (every 30 days): warning 5 days before. It can only land on a finished Landing Pad next to
    // a finished HAB; if there is none when it arrives, it turns back and the next one comes 30 days later.
    const E = C.endless;
    for (const sh of state.ships) {
      if (!sh.warned && h + 1 >= sh.h - E.shipWarnH) {
        sh.warned = true;
        const ready = landingSpots(state).length > 0;
        say(ready ? 'info' : 'warn', '🚀 A crew spaceship is on the way!',
          `It lands in ${E.shipWarnH / 24} days with ${E.newCrew} new astronauts (you choose their jobs and their HAB) and restocks the medbay.` +
          (ready ? '' : ` ⚠️ It needs a Landing Pad within ${C.pad.radius} squares of a finished HAB, or it can't land. Build one now!`), { banner: true });
      }
      if (!sh.arrived && h + 1 >= sh.h) {
        sh.arrived = true;
        const spots = landingSpots(state);
        if (!spots.length) {
          sh.missed = true;
          say('bad', '🚀 The crew spaceship could not land!', `There was no Landing Pad within ${C.pad.radius} squares of a finished HAB, so it flew back to Earth. The next one comes in ${E.shipEveryH / 24} days.`, { banner: true });
        } else {
          const spot = spots[0]; // the player can pick another pad (ev.pads) before it touches down
          sh.padId = spot.pad.id; state.landedPadId = spot.pad.id;
          state.pendingCrew += E.newCrew;
          state.medbayUses = 0; // medical supplies restocked
          say('good', '🚀 The crew spaceship has landed!', `${E.newCrew} new astronauts are here, and the medbay is fully restocked.`, { ship: true, padId: spot.pad.id, pads: spots.map((x) => x.pad.id) });
        }
      }
    }
    const out = activeCrew(state).filter(isExposed);
    if (S > C.rad.stormOn && out.length && !state.warned['eva' + Math.floor(h / 6)]) {
      state.warned['eva' + Math.floor(h / 6)] = true;
      // (only astronauts working outside get the full dose)
      say('bad', `${out.map((a) => a.name).join(' and ')} ${out.length > 1 ? 'are' : 'is'} OUTSIDE during a radiation storm!`,
        'They get the full dose while they work. Use the shelter, or wait to build.');
    }

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
    Hs.hp.push(crewSummary(state).avgHp); Hs.crew.push(activeCrew(state).length);

    state.hour++;

    // The game is endless. It only ends when no astronaut is left on the Moon to run the base.
    // reason = what started hurting the crew first (cold, o2, food, water), or 'crew' (radiation / bones).
    if (!activeCrew(state).length) {
      state.status = 'lost';
      state.failure = { cause: 'crew', reason: state.stats.firstHarm || 'crew', h: state.hour };
      log(state, 'bad', `THE BASE HAS CLOSED after ${round1(state.hour / 24)} days.`);
      ev.push({ level: 'bad', title: 'The base has closed', end: true });
    }
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
    if (off('hab').length) consequences.push({ icon: '🥶', text: `Habitat heaters OFF: ${round1(state.habTemp)} °C and dropping${state.habTemp < cfg().habTemp.fail ? ': astronauts losing health!' : ''}`, level: 'bad' });
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
    const act = activeCrew(state);
    const weakest = act.slice().sort((a, b) => a.hp - b.hp)[0];
    if (state.stormRate > cfg().rad.stormOn) {
      const shelter = state.sheltering && hasShelter(state);
      const out = act.filter(isExposed);
      chains.push([
        { icon: '☀️', text: 'Solar flare threw out fast particles', level: 'warn' },
        { icon: '☢️', text: `Radiation storm: ${round1(state.stormRate)} mSv/h outside`, level: 'bad' },
        out.length ? { icon: '👩‍🚀', text: `${out.map((a) => a.name).join(', ')} OUTSIDE: full dose + stress!`, level: 'bad' } : null,
        shelter ? { icon: '🛡️', text: 'Crew in shelter: 95% blocked', level: 'ok' }
          : !out.length ? { icon: '🏠', text: `Crew in habitat: ${state.berm.built ? '80' : '50'}% blocked`, level: 'warn' } : null,
        weakest ? { icon: '❤️', text: `Lowest health: ${weakest.name} ${Math.round(weakest.hp)} HP (never comes back)`, level: weakest.hp < 50 ? 'bad' : 'warn' } : null,
      ].filter(Boolean));
    }
    if (state.meteorOn) {
      const out = act.filter((a) => a.where === 'outside');
      chains.push([
        { icon: '☄️', text: `${state.meteorOn.name} meteor shower`, level: 'bad' },
        out.length ? { icon: '👩‍🚀', text: `${out.map((a) => a.name).join(', ')} outside: can be hit (HP) + stress`, level: 'bad' } : { icon: '🏠', text: 'Crew inside: safe from hits', level: 'ok' },
        { icon: '🔧', text: 'Buildings can be damaged → half speed until repaired', level: 'warn' },
      ]);
    }
    const broken = built(state).filter((m) => m.damaged);
    if (broken.length) {
      chains.push([
        { icon: '🔧', text: `${broken.length} damaged: ${broken.map((m) => C.modules[m.type].name).join(', ')}`, level: 'warn' },
        { icon: '🐢', text: 'Works at half speed (gyms and towers closed)', level: 'warn' },
        { icon: '👆', text: broken.some((m) => !m.repair) ? 'Pick an Engineer, then click a damaged building to repair it (1 part)' : 'Repairs are in the work queue', level: broken.some((m) => !m.repair) ? 'warn' : 'ok' },
      ]);
    }
    const acc = state.lastAccident;
    if (acc && state.hour - acc.h < 8) {
      chains.push([
        { icon: '⚠️', text: acc.title, level: 'warn' },
        { icon: '📉', text: `Lost ${Math.round(acc.lost)} ${acc.unit}`, level: 'warn' },
        { icon: '🔬', text: 'Extra or upgraded machines (Research Bay) refill supplies faster', level: 'ok' },
      ]);
    }
    const weakBones = act.filter((a) => a.bone < C.astro.bone.injuryBelow);
    if (weakBones.length) {
      const gym = built(state, 'gym').some((m) => m.on && m.powered && !m.damaged);
      chains.push([
        { icon: '🌙', text: 'Moon gravity is 1/6 of Earth\'s: bones get weaker', level: 'warn' },
        { icon: '🦴', text: `Weak bones: ${weakBones.map((a) => `${a.name} ${Math.round(a.bone)}%`).join(', ')}`, level: weakBones.some(isGrounded) ? 'bad' : 'warn' },
        gym ? { icon: '🏋️', text: 'Pick each astronaut and click the Fitness Center to train (2 h, about once a day)', level: 'warn' }
          : { icon: '🏋️', text: 'No working Fitness Center! Build one (or fix/power it)', level: 'bad' },
        { icon: '⚠️', text: `Below ${C.astro.bone.injuryBelow}%: injuries · ${C.astro.bone.groundedBelow}%: can't go outside · ${C.astro.bone.fragileBelow}%: fractures · ${C.astro.bone.severeBelow}%: severe · 0%: medbay for good`, level: 'warn' },
      ]);
    }
    const o2days = state.res.o2 / (C.use.o2PerPersonH * Math.max(1, act.length)) / 24;
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
    const won = false; // endless: the only ending is "no astronauts left"
    const out = { won, chain: [], tips: [], fact: '', stats: {} };
    const t = state.failure && state.failure.h;
    const add = (h, text) => out.chain.push({ when: h != null ? fmtDay(h) : '', text });
    const powerStory = () => {
      if (startOf('darkPanels') != null) add(startOf('darkPanels'), 'The Sun went behind the hills. All solar panels were in shadow.');
      else if (startOf('batteryEmpty') != null) add(null, 'The base used more power than the solar panels made.');
      if (startOf('batteryEmpty') != null) add(startOf('batteryEmpty'), 'The battery ran empty.');
    };
    const ridgePanels = built(state, 'solar').filter((m) => zoneOf(state, m.c, m.r) === 'ridge').length;
    const accidentLoss = (type) => Math.round(state.stats.accidents.filter((x) => x.type === type).reduce((s, x) => s + x.lost, 0));

    // Who left, when and why (shown for every ending).
    const crewStory = () => {
      const outAt = (a) => (a.home ? a.homeAt : a.medbayAt) || 0;
      for (const a of allCrew(state).filter((x) => x.home || x.medbay).sort((x, y) => outAt(x) - outAt(y))) {
        const why = [`${Math.round(a.dose)} mSv of radiation`];
        if (a.hits) why.push(`${a.hits} meteoroid hit${a.hits > 1 ? 's' : ''}`);
        if (a.injuries) why.push(`${a.injuries} injur${a.injuries > 1 ? 'ies' : 'y'} from weak bones`);
        if (a.accidents) why.push(`${a.accidents} work accident${a.accidents > 1 ? 's' : ''}`);
        for (const w of a.wounds) if (['no oxygen', 'cold', 'hunger', 'thirst'].includes(w.what)) why.push(`${Math.round(w.hp)} HP from ${w.what}`);
        if (a.medbayWhy === 'bones') why.push('bone density reached 0%');
        add(outAt(a), a.home ? `${a.name}'s health ran out: medically retired and sent home to Earth (${why.join(', ')}).` : `${a.name} went to the medbay (${why.join(', ')}).`);
      }
      add(t, `With no astronauts left on the Moon, the base had to close after ${round1(t / 24)} days.`);
    };

    if (!won) {
      const cause = state.failure.reason || state.failure.cause;
      if (cause === 'cold') {
        out.title = 'The habitat got too cold';
        powerStory();
        add(startOf('nopower_hab'), 'With no power left, the heaters stopped.');
        add(startOf('habCold'), `The habitat cooled below ${C.habTemp.fail} °C, and the cold made the crew sick.`);
        crewStory();
        if (!ridgePanels) out.tips.push('Build solar panels on HIGH GROUND (the light gray hills and ridges). It stays sunny much longer. Drag the map to find them.');
        out.tips.push('Check the sunlight forecast under the map. Before a long shadow, fill the batteries and build more of them.');
        out.tips.push('Turn off greenhouses during the dark. The crew can eat stored food for a few days.');
        out.fact = 'NASA picked the lunar south pole partly because some ridges there are sunlit most of the time. Engineers study light maps from the Lunar Reconnaissance Orbiter to choose where to put solar panels.';
      } else if (cause === 'o2') {
        out.title = 'The crew ran out of oxygen';
        if (startOf('waterEmpty') != null) add(startOf('waterEmpty'), 'The water tank ran dry, so the O₂ Generator had nothing to split.');
        else powerStory();
        add(startOf('noO2Make'), 'The O₂ Generator stopped making oxygen.');
        add(null, accidentLoss('o2gen') ? `O₂ Generator leaks lost ${accidentLoss('o2gen')} kg of oxygen.` : '');
        add(startOf('o2Empty'), 'The oxygen tank reached zero. The crew breathed from emergency tanks and got sick.');
        crewStory();
        out.tips.push('The O₂ Generator needs BOTH power and water. Watch both bars.');
        if (!built(state, 'drill').length) out.tips.push('Build an Ice Drill in a dark ice crater (drag the map to find one). Ice → water → oxygen.');
        out.tips.push('Choose "Water & air" cargo if oxygen is getting low.');
        out.fact = 'On the ISS, the Oxygen Generation System makes oxygen by splitting water with electricity, the same idea as in this game. A Moon base could get that water from ice in permanently shadowed craters.';
      } else if (cause === 'crew') {
        out.title = state.sentHome.length === state.crewTotal ? 'Every astronaut was sent home to Earth' : 'No astronauts are left to run the base';
        const f = state.doseFrom;
        add(null, `Average radiation per astronaut: ${Math.round(f.storm)} mSv from solar storms inside, ${Math.round(f.outside)} mSv while working outside, ${Math.round(f.background)} mSv everyday background.`);
        crewStory();
        if (!hasShelter(state)) out.tips.push('Build a Storm Shelter early. It blocks 95% of storm radiation.');
        out.tips.push('When a storm or meteor shower warning comes, stop building outside and keep the crew inside.');
        if (habs(state).some((H) => !H.berm.built)) out.tips.push('Pile moon dirt on each habitat ("Shield habitat" button). It blocks radiation every day.');
        if (allCrew(state).some((a) => a.injuries) && !built(state, 'gym').length) out.tips.push('Build a Fitness Center so bones stay strong and astronauts don\'t get hurt.');
        const big = state.storms.find((s) => s.strong && s.profile);
        out.fact = big
          ? `The ${big.realName} really happened. NASA's Lunar Reconnaissance Orbiter measured it from Moon orbit: an astronaut standing on the Moon with no shelter would have got about ${Math.round(big.profile.reduce((a, v) => a + crewRate(v), 0) / 10) * 10} mSv. NASA's limit for a whole astronaut CAREER is 600 mSv. That is why a storm shelter is a must for a Moon base.`
          : 'NASA limits each astronaut to 600 mSv of radiation over their whole career. The Moon has no magnetic field and almost no air, so solar particles hit the surface directly.';
      } else if (cause === 'food') {
        out.title = 'The crew ran out of food';
        if (state.stats.unpoweredH.greenhouse) add(null, `The greenhouses had no power for ${state.stats.unpoweredH.greenhouse} hours.`);
        add(null, `Greenhouses grew ${Math.round(state.stats.foodMade)} kg of food; the crew ate ${Math.round(state.stats.foodEaten)} kg.`);
        add(null, accidentLoss('greenhouse') ? `Greenhouse accidents threw away ${accidentLoss('greenhouse')} kg of food.` : '');
        add(startOf('foodEmpty'), 'Food storage reached zero.');
        add(startOf('starving'), 'After 3 days without food, the crew started losing health.');
        crewStory();
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
        add(null, accidentLoss('drill') ? `Ice Drill accidents leaked ${accidentLoss('drill')} kg of water.` : '');
        add(startOf('waterEmpty'), 'The water tank ran dry.');
        add(startOf('thirsty'), 'After 2 days without water, the crew started losing health.');
        crewStory();
        out.tips.push('Build an Ice Drill in a dark ice crater (drag the map to find one) and give it power.');
        out.fact = 'NASA\'s LCROSS mission crashed into a dark crater near the lunar south pole in 2009 and found water ice in the debris cloud.';
      }
    } else {
      out.title = 'Mission complete! The crew is safe.';
      out.fact = 'NASA\'s Artemis program plans to land astronauts near the lunar south pole and to learn how to live there for longer and longer missions.';
    }
    const lost = allCrew(state).filter((a) => a.medbay || a.home);
    out.stars = won ? 1 + (lost.length === 0 ? 1 : 0) + (state.stats.foodMade >= state.stats.foodEaten * 0.5 ? 1 : 0) : 0;
    if (won) {
      out.tips.push(lost.length === 0 ? '⭐ All 4 astronauts stayed healthy.' : `${lost.map((a) => a.name + (a.home ? ' (sent home)' : ' (medbay)')).join(', ')} didn't finish the mission. Use the shelter and stay inside during storms and meteor showers.`);
      out.tips.push(state.stats.foodMade >= state.stats.foodEaten * 0.5 ? '⭐ Greenhouses grew at least half of the food.' : 'Try to grow at least half of your food in greenhouses.');
    }
    out.subtitle = `Your base lasted ${Math.floor(state.hour / 24)} days with ${state.crewTotal} astronauts in total.`;
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
    // Meteor showers: countdown after the forecast, then "active".
    for (const s of state.meteors) {
      if (s.warned && now < s.h) out.push({ kind: 'meteor', icon: '☄️', level: 'warn', left: s.h - now, total: C.meteor.warnLead, label: `${s.name} meteor shower starts in` });
      else if (now >= s.h && now < s.h + s.dur) out.push({ kind: 'meteorActive', icon: '☄️', level: 'bad', left: s.h + s.dur - now, total: s.dur, label: 'Meteor shower · ends in' });
    }
    // Next cargo lander.
    const i = state.cargo.findIndex((k) => !k.arrived);
    if (i >= 0) {
      const k = state.cargo[i];
      const prev = i > 0 ? state.cargo[i - 1].h : 0;
      const what = k.choice ? C.cargoOptions[k.choice].name : k.asked ? 'contents not chosen yet!' : 'you choose 2 days before';
      out.push({ kind: 'cargo', icon: '📦', level: k.asked && !k.choice ? 'warn' : 'info', left: k.h - now, total: k.h - prev,
        label: `Cargo #${i + 1} (${what}) lands in` });
    }
    // Crew spaceship: only after its 5-day warning.
    const ship = state.ships.find((s) => s.warned && !s.arrived);
    if (ship) {
      const ready = landingSpots(state).length > 0;
      out.push({ kind: 'ship', icon: '🚀', level: ready ? 'info' : 'warn', left: ship.h - now, total: C.endless.shipWarnH,
        label: ready ? `Crew spaceship (${C.endless.newCrew} astronauts) lands in` : 'Crew spaceship needs a Landing Pad next to a HAB! Arrives in' });
    }
    // Rover on the way.
    const rv = state.rover;
    if (rv && rv.trip) {
      const to = state.modules.find((m) => m.id === rv.trip.to);
      out.push({ kind: 'rover', icon: '🚙', level: 'info', left: Math.max(0, rv.trip.left - (now - state.hour)), total: rv.trip.total, label: `Rover arrives at ${to ? habName(state, to) : 'the HAB'} in` });
    }
    return out.sort((a, b) => a.left - b.left);
  }

  MT.Sim = {
    upcoming, stormRateAt,
    create, step, canPlace, place, cancel, toggle, setShelter, startBerm, chooseCargo, orderRepair, startHeal, healAmount, maxHp,
    useTower, towerReadyIn, startResearch, resumeTask, researchCost, plannedLevel, tendGreenhouse, sendToGym, assignWorker, boostOf, inLabRange, solarKw,
    causeChains, debrief, moduleAt, zoneOf, sunAz, zoneLight, zoneLitAt, jobList, activeCrew, allCrew, crewById, crewSummary, isSlow, isGrounded, isExposed,
    hasShelter, batteryCap, needOf, built, fmtDay, day,
    habs, habName, homeOf, bermKey, joinCrew, landingSpots, padNearHab, homeForPad, buyRover, roverRiders, startTrip, extendWorld,



  };
})(typeof window !== 'undefined' ? window : globalThis);
