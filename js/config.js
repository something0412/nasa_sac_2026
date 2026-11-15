// All game numbers live here, with where they come from.
// "REAL" = from a NASA/science source. "GAME" = tuned for fun, but in a realistic range.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  MT.CONFIG = {
    missionHours: 720, // 30 days
    crew: 4,
    workers: 2, // astronauts who go outside to build (EVA)

    map: { cols: 20, rows: 14, tile: 40 },

    // REAL: at the lunar south pole the Sun never rises high. It circles the horizon once per
    // synodic month (29.53 days), so crater rims and hills cast shadows that come and go.
    // High ridges (e.g. Shackleton rim) are lit up to ~80-90% of the time (LRO LOLA, Mazarico et al. 2011).
    sun: { degPerHour: 360 / (29.53 * 24), startAz: 90 },

    zones: {
      ridge: { name: 'High ridge', color: '#9a9aa2', shadowArcs: [[262, 292]], blurb: 'High crater rim. The Sun is blocked only for short times.' },
      plain: { name: 'Plain', color: '#76767e', shadowArcs: [[180, 250], [300, 320]], blurb: 'Lower ground. Hills block the Sun for days at a time.' },
      ice: { name: 'Shadowed crater (ice)', color: '#2b3448', alwaysDark: true, blurb: 'Never sees the Sun (about -230 °C). Water ice hides here.' },
    },
    zoneAt(c, r) {
      if (((c - 16.5) / 4.2) ** 2 + ((r - 10.5) / 3.3) ** 2 < 1) return 'ice';
      if (r + 0.7 * c < 5) return 'ridge';
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
        desc: "A small telescope dome. Click it when it's built to see NASA's Astronomy Picture of the Day.",
      },
    },
    buildOrder: ['solar', 'battery', 'o2gen', 'greenhouse', 'drill', 'shelter', 'tower'],
    bermWork: 36, // crew-hours to pile regolith (moon dirt) on the habitat

    // REAL: an adult uses about 0.84 kg O2 and ~1.8 kg food (with packaging) per day (NASA BVAD, NASA/TP-2015-218570).
    use: { o2PerPersonH: 0.84 / 24, foodPerPersonH: 1.8 / 24, waterPerPersonH: 0.5 / 24 /* GAME: water lost after recycling */ },

    start: { o2: 25, food: 60, water: 150, battery: 30, parts: 20 },
    caps: { o2: 40, water: 300 },

    rad: {
      surfacePerH: 1.369 / 24, // REAL: Chang'e-4 measured 1.369 mSv/day on the lunar surface (Zhang et al. 2020)
      hab: 0.5, habBerm: 0.2, shelter: 0.05, // GAME: fraction of radiation that gets through
      limit: 250, // REAL: NASA 30-day crew limit for blood-forming organs, 250 mGy-Eq (NASA-STD-3001)
      warn: 150,
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
