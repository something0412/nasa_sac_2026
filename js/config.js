// All game numbers live here, with where they come from.
// "REAL" = from a NASA/science source. "GAME" = tuned for fun, but in a realistic range.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  MT.CONFIG = {
    missionHours: 720, // 30 days # hello 
    crew: 4,
    // Every job (new building, repair, moon-dirt shield) gets exactly ONE astronaut. At most this many
    // astronauts work outside at the same time; the rest stay in the habitat.
    maxOutside: 2,

    // ----- Astronaut Management System (AMS): per-astronaut Health, Stress and Bone density -----
    astro: {
      names: ['Astronaut 1', 'Astronaut 2', 'Astronaut 3', 'Astronaut 4'],
      // HEALTH (HP 0-100) = radiation received over the whole session, plus injuries. Never restored.
      // REAL: NASA's career radiation limit is 600 mSv (NASA-STD-3001, 2022), so 600 mSv = the whole bar.
      // Living in the habitat (50% blocked) that takes ~880 days (~2.4 years); with the moon-dirt shield ~6 years.
      hpPerMsv: 100 / 600,
      // STRESS (0-100)
      stress: {
        outsidePerH: 1.5,     // GAME: social isolation while working alone outside
        stormOutsidePerH: 3,  // GAME: caught outside in a radiation storm (on top of the isolation)
        stormInsidePerH: 0.2, // GAME: waiting out a storm in the habitat or gym (real storms can last ~10 days)
        stormShelterPerH: 0.1, // GAME: the shelter is cramped but safe
        meteorOutsidePerH: 6, // GAME: caught outside in a meteor shower
        meteorInsidePerH: 1,
        towerRelief: 30,      // GAME: everyone's stress drops when a NEW Astronomy Tower is opened for the first time
        slowAt: 75,           // at or above this, an astronaut works at half speed
        slowFactor: 0.5,
      },
      // BONE DENSITY (% of what they had on Earth)
      // REAL: on the ISS (no gravity) astronauts lose ~1-1.5% of hip bone per MONTH and exercise ~2 h a day.
      // GAME: Moon gravity is 1/6 of Earth's; we speed bone loss up to ~1% per DAY so it matters in a 30-day mission.
      bone: {
        lossPerH: 1 / 24,
        gymGainPerH: 2,      // each hour in the Fitness Center
        visitEveryH: 22,     // an astronaut goes to train about once a day...
        visitH: 2,           // ...for 2 hours (one astronaut per Fitness Center at a time)
        injuryBelow: 85,     // below this: chance of a small injury (sprain) each hour
        injuryChancePerH: 0.03,
        injuryHp: 3,
        groundedBelow: 75,   // below this: not allowed outside (no building or repairs) until they train back up
        fragileBelow: 50,    // below this: FRAGILE BONES: fractures, injuries 2x as likely and 2x as harmful, worry adds stress
        fragileMult: 2,
        fragileStressPerH: 0.5,
        severeBelow: 25,     // below this: SEVERE BONE LOSS: injuries 3x, more stress, gym training only half as effective (gentle rehab)
        severeMult: 3,
        severeStressPerH: 1,
        severeGymFactor: 0.5,
        // At 0% an astronaut goes to the medbay for the rest of the mission.
      },
      // MEDBAY (inside the habitat): an astronaut rests there for 3 days and heals exactly healHp of
      // injuries (meteoroid hits, sprains, fractures; smallest first). Radiation damage can never be healed:
      // it sets the highest health they can ever get back to (the purple part of the health bar).
      medbay: { healH: 72, healHp: 10, uses: 2 }, // uses: total for the whole mission
    },

    // ----- weather events that can damage buildings -----
    damage: {
      canBreak: ['solar', 'o2gen', 'drill', 'greenhouse', 'gym', 'tower'],
      stormChance: 0.08,         // GAME: chance per building each time a radiation storm (or a new wave) starts: electronics glitch
      meteorChancePerH: 0.04,    // GAME: chance per building per hour of meteor shower
      brokenRate: 0.5,           // damaged buildings make things at half speed (towers and gyms can't be used at all)
      repairCost: 1,             // parts
      repairWork: 0.5,           // repair takes half the work of building it
    },
    meteor: {
      warnLead: 6,               // REAL: meteor showers are predictable (Earth and Moon cross the same comet dust every year)
      hitChancePerH: 0.3,        // GAME: chance an astronaut caught OUTSIDE is hit by a tiny meteoroid each hour
      hitHp: [6, 14],            // GAME: HP lost when hit
    },

    // The world is 80 x 56 tiles; the camera shows 20 x 14 of them. Drag to look around.
    map: { cols: 80, rows: 56, tile: 40, viewCols: 20, viewRows: 14 },
    base: { c: 39, r: 27 }, // where the habitat starts (top-left tile of its 2x2), middle of the map

    // REAL: at the lunar south pole the Sun never rises high. It circles the horizon once per
    // synodic month (29.53 days), so crater rims and hills cast shadows that come and go.
    // High ridges (e.g. Shackleton rim) are lit up to ~80-90% of the time (LRO LOLA, Mazarico et al. 2011).
    // fadeDeg: as the Sun slides behind a hill, its disk is covered bit by bit, so light fades over
    // a few degrees of Sun movement (GAME: 3° each side = about 12 game hours from full Sun to full shadow).
    sun: { degPerHour: 360 / (29.53 * 24), startAz: 90, fadeDeg: 3 },

    zones: {
      ridge: { name: 'High ridge', color: '#9a9aa2', shadowArcs: [[262, 292]], blurb: 'High crater rim. The Sun is blocked only for short times.' },
      plain: { name: 'Plain', color: '#76767e', shadowArcs: [[180, 250], [300, 320]], blurb: 'Lower ground. Hills block the Sun for days at a time.' },
      ice: { name: 'Shadowed crater (ice)', color: '#2b3448', alwaysDark: true, blurb: 'Never sees the Sun (about -230 °C). Water ice hides here.' },
    },
    // Terrain features in 0..1 map coordinates (u = left→right, v = top→bottom), so they scale with the map.
    // Ovals: centre (u, v), radius (ru, rv). The first match wins. Labels are drawn on the map.
    features: [
      { zone: 'ice', u: 0.82, v: 0.76, ru: 0.2, rv: 0.22, label: 'SHADOWED CRATER (ICE)' },
      { zone: 'ice', u: 0.12, v: 0.86, ru: 0.07, rv: 0.09, label: 'SMALL ICE CRATER' },
      { zone: 'ice', u: 0.47, v: 0.09, ru: 0.055, rv: 0.07, label: 'ICE CRATER' },
      { zone: 'ridge', corner: 0.36, u: 0.1, v: 0.06, label: 'HIGH RIDGE (crater rim)' }, // top-left triangle
      { zone: 'ridge', u: 0.9, v: 0.12, ru: 0.11, rv: 0.13, label: 'HIGH HILL' },
      { zone: 'ridge', u: 0.27, v: 0.68, ru: 0.06, rv: 0.08, label: 'SMALL HILL' },
      { zone: 'ridge', u: 0.66, v: 0.3, ru: 0.035, rv: 0.05, label: 'ROCKY KNOB' },
    ],
    zoneAt(c, r) {
      const u = (c + 0.5) / this.map.cols, v = (r + 0.5) / this.map.rows;
      const wobble = 0.025 * Math.sin(u * 23) + 0.02 * Math.sin(v * 31); // makes edges less perfect
      for (const f of this.features) {
        const inside = f.corner ? u + v + wobble < f.corner : ((u - f.u) / f.ru) ** 2 + ((v - f.v) / f.rv) ** 2 < 1 + wobble * 4;
        if (inside) return f.zone;
      }
      return 'plain';
    },

    modules: {
      hab: {
        name: 'Habitat', icon: '🏠', w: 2, h: 2, cost: 0, work: 0, priority: 0,
        power: 1.5, heatInDark: 1.0, // GAME: life systems + extra heaters when in shadow
        desc: 'Home for 4 astronauts. Needs power for air fans, computers and heaters.',
      },
      solar: {
        name: 'Solar Panel', icon: '☀️', w: 1, h: 1, cost: 2, work: 6, makes: 4, // GAME: 4 kW tall vertical panel
        desc: 'Makes 4 kW, but ONLY when sunlight reaches it. Higher ground = more sunlight.',
      },
      battery: {
        name: 'Battery', icon: '🔋', w: 1, h: 1, cost: 2, work: 4, store: 40,
        desc: 'Stores 40 kWh of energy for when the panels are in shadow.',
      },
      o2gen: {
        name: 'O₂ Generator', icon: '💨', w: 1, h: 1, cost: 3, work: 8, priority: 2,
        power: 2, o2PerH: 0.2, waterPerH: 0.225, // REAL ratio: splitting 1.125 kg water gives 1 kg O2 (electrolysis)
        desc: 'Splits water into oxygen for breathing. Uses 2 kW and water.',
      },
      drill: {
        name: 'Ice Drill', icon: '⛏️', w: 1, h: 1, cost: 3, work: 8, priority: 3, onlyZone: 'ice',
        power: 1.5, waterPerH: 0.6, // GAME
        desc: 'Mines frozen water from the shadowed crater. Must be built on the dark ice area.',
      },
      greenhouse: {
        name: 'Greenhouse', icon: '🌱', w: 1, h: 1, cost: 3, work: 10, priority: 4,
        power: 2.5, foodPerH: 0.12, waterPerH: 0.04, // GAME: LED grow lights are power hungry
        desc: 'Grows fresh food under LED lights. Uses lots of power (2.5 kW). Shuts off first when power is low.',
      },
      shelter: {
        name: 'Storm Shelter', icon: '🛡️', w: 1, h: 1, cost: 3, work: 12,
        desc: 'Small room buried under moon dirt. Blocks 95% of solar storm radiation.',
      },
      tower: {
        name: 'Astronomy Tower', icon: '🔭', w: 1, h: 1, cost: 2, work: 6, // GAME: no power use yet
        desc: "A small telescope dome. Click it to see NASA's Astronomy Picture of the Day. The first look through each NEW tower lowers everyone's stress.",
      },
      gym: {
        name: 'Fitness Center', icon: '🏋️', w: 1, h: 1, cost: 3, work: 8, priority: 5,
        power: 1, // GAME: treadmill + resistance machine; first to shut off when power is low
        desc: 'Astronauts train here about once a day to keep their bones strong in low gravity. One astronaut at a time.',
      },
    },
    buildOrder: ['solar', 'battery', 'o2gen', 'greenhouse', 'drill', 'shelter', 'tower', 'gym'],
    bermWork: 36, // crew-hours to pile regolith (moon dirt) on the habitat

    // REAL: an adult uses about 0.84 kg O2 and ~1.8 kg food (with packaging) per day (NASA BVAD, NASA/TP-2015-218570).
    use: { o2PerPersonH: 0.84 / 24, foodPerPersonH: 1.8 / 24, waterPerPersonH: 0.5 / 24 /* GAME: water lost after recycling */ },

    start: { o2: 25, food: 60, water: 150, battery: 30, parts: 20 },
    caps: { o2: 40, water: 300 },

    rad: {
      surfacePerH: 1.369 / 24, // REAL: Chang'e-4 measured 1.369 mSv/day on the lunar surface (Zhang et al. 2020)
      hab: 0.5, habBerm: 0.2, shelter: 0.05, // GAME: fraction of radiation that gets through (gym = like the habitat)
      // (The old 250 mSv whole-crew limit is gone: each astronaut now has their own Health, see astro.hpPerMsv.)
      // REAL DATA: storm radiation is the dose NASA's Lunar Reconnaissance Orbiter actually measured
      // (CRaTER instrument, via NASA's RadLab API, saved in data/radlab.js by tools/build_radlab.py).
      // To turn "extra micro-gray per hour measured in lunar orbit" into "mSv per hour for a person
      // standing on the surface" we multiply by:
      real: {
        sky: 0.75, // APPROX: LRO flies ~100 km up, where the Moon hides ~1/3 of the sky. On the ground it
        //            hides half. Particles come from the open sky, so surface ≈ 0.5 / 0.66 ≈ 0.75 x orbit.
        rbe: 1.5, //  REAL: NASA-STD-3001 counts solar-storm protons as 1.5x as harmful as the gray value
        //            (relative biological effectiveness), which gives the mGy-Eq used by the 250 limit.
      },
      // Training missions pick storm shapes from real recorded storms. Big ones (Jan 2012, Mar 2012,
      // Sep 2017) happen only a few times per 11-year solar cycle, so at most ONE per mission.
      maxBigStorms: 1,
      stormOn: 0.1, // mSv/h: above this we call it a radiation storm (about 2x the normal background)
      storm: { // Fallback only, used if data/radlab.js is missing: GAME-tuned curve, mSv per hour
        moderate: { peak: 3, tau: 8 },
        strong: { peak: 20, tau: 12 },
        rise: 2,
      },
      warnLead: 2, // hours of warning before particles arrive (forecasters see the flare first)
    },

    habTemp: { normal: 21, fail: 5, heat: 3, coolDark: 2.0, coolLit: 0.8 },
    fail: { foodGraceH: 72, waterGraceH: 48 },

    cargo: [{ h: 240 }, { h: 480 }],
    cargoAskLead: 48,
    cargoOptions: {
      food: { name: 'Food pack', icon: '🍞', text: '+60 kg food', give: { food: 60 } },
      parts: { name: 'Building parts', icon: '🔩', text: '+10 parts', give: { parts: 10 } },
      life: { name: 'Water & air', icon: '💧', text: '+60 kg water, +15 kg O₂', give: { water: 60, o2: 15 } },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
