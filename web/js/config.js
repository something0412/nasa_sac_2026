// =============================================================================
// config.js — the "engineering knobs" of Analog Finder.
//
// OWNER: the mechanical engineer. Everything here is a judgment call you can
// defend to a judge: what we compare, how forgiving each comparison is, and
// what to test somewhere else when Earth can't match.
//
// sigma = tolerance. A site that differs from the target by exactly one sigma
// scores 61/100 on that feature; two sigmas scores 14/100. Smaller sigma means
// stricter. For "log" features sigma is in powers of ten (0.3 = about 2x).
// =============================================================================

window.ANALOG_CONFIG = {
  // The five dimensions shown as sliders, in display order.
  dims: [
    { id: 'terrain', label: 'Terrain', blurb: 'Slope, relief and lava tubes: what wheels, landing legs and boots meet.' },
    { id: 'thermal', label: 'Thermal', blurb: 'How cold the ground gets and how hard it swings between day and night.' },
    { id: 'surface', label: 'Geology', blurb: 'Rock type and how bare the ground is.' },
    { id: 'water',   label: 'Water & ice', blurb: 'Dryness and ground ice: resources, drilling and contamination.' },
    { id: 'light',   label: 'Light', blurb: 'How high the Sun climbs. At the lunar poles it barely clears the horizon.' }
  ],

  // Every feature the scorer compares. Earth sites must have all of them;
  // a target uses only the ones it lists.
  features: {
    slope_deg:    { dim: 'terrain', label: 'Typical slope', unit: '°', sigma: 4, digits: 0 },
    relief_m:     { dim: 'terrain', label: 'Local relief (5 km)', unit: ' m', sigma: 0.3, scale: 'log', digits: 0 },
    lava_tube:    { dim: 'terrain', label: 'Lava tubes', kind: 'yesno', sigma: 0.3 },
    t_min_c:      { dim: 'thermal', label: 'Coldest surface temperature', unit: ' °C', sigma: 15, digits: 0 },
    t_swing_c:    { dim: 'thermal', label: 'Day-night surface swing', unit: ' °C', sigma: 12, digits: 0 },
    t_mean_c:     { dim: 'thermal', label: 'Mean surface temperature', unit: ' °C', sigma: 8, digits: 0 }, // for caves ≈ the cave interior
    rock:         { dim: 'surface', label: 'Rock type', kind: 'category' },
    ndvi:         { dim: 'surface', label: 'Vegetation cover (NDVI)', unit: '', sigma: 0.12, digits: 2 },
    precip_mm:    { dim: 'water', label: 'Precipitation', unit: ' mm/yr', sigma: 0.7, scale: 'log1p', digits: 0 },
    ground_ice:   { dim: 'water', label: 'Ground ice', kind: 'level', sigma: 0.35 },
    sun_elev_deg: { dim: 'light', label: 'Noon Sun height at equinox', unit: '°', sigma: 12, digits: 1, derived: 'lat' }
  },

  // Rock classes. Earth sites use one of these keys in pipeline/earth_sites.csv.
  rockLabels: {
    anorthosite: 'Anorthosite (lunar highland rock)',
    basalt: 'Basalt',
    volcaniclastic: 'Volcanic ash and cinders',
    impact: 'Impact breccia and melt',
    sedimentary: 'Sedimentary rock',
    evaporite: 'Salts and sulfates',
    granitic: 'Granitic rock',
    ice: 'Glacial ice'
  },
  // How alike two rock classes are for testing purposes (1 = same, 0 = unrelated).
  rockSimilarity: {
    anorthosite:    { anorthosite: 1, basalt: 0.35, volcaniclastic: 0.3, impact: 0.6, sedimentary: 0.1, evaporite: 0.05, granitic: 0.35, ice: 0 },
    basalt:         { anorthosite: 0.35, basalt: 1, volcaniclastic: 0.8, impact: 0.5, sedimentary: 0.2, evaporite: 0.1, granitic: 0.2, ice: 0 },
    volcaniclastic: { anorthosite: 0.3, basalt: 0.8, volcaniclastic: 1, impact: 0.45, sedimentary: 0.3, evaporite: 0.15, granitic: 0.2, ice: 0 },
    impact:         { anorthosite: 0.6, basalt: 0.5, volcaniclastic: 0.45, impact: 1, sedimentary: 0.3, evaporite: 0.15, granitic: 0.3, ice: 0 },
    sedimentary:    { anorthosite: 0.1, basalt: 0.2, volcaniclastic: 0.3, impact: 0.3, sedimentary: 1, evaporite: 0.6, granitic: 0.15, ice: 0 },
    evaporite:      { anorthosite: 0.05, basalt: 0.1, volcaniclastic: 0.15, impact: 0.15, sedimentary: 0.6, evaporite: 1, granitic: 0.05, ice: 0.05 },
    granitic:       { anorthosite: 0.35, basalt: 0.2, volcaniclastic: 0.2, impact: 0.3, sedimentary: 0.15, evaporite: 0.05, granitic: 1, ice: 0 },
    ice:            { anorthosite: 0, basalt: 0, volcaniclastic: 0, impact: 0, sedimentary: 0, evaporite: 0.05, granitic: 0, ice: 1 }
  },
  // A site's second rock type, and a target's second rock type, count a bit less.
  rockSecondaryWeight: { earth: 0.8, target: 0.85 },

  // Mission-test presets: slider positions (0-5) per dimension.
  presets: [
    { id: 'balanced', label: 'Balanced', weights: { terrain: 3, thermal: 3, surface: 3, water: 3, light: 2 } },
    { id: 'rover', label: 'Rover and lander mobility', weights: { terrain: 5, thermal: 2, surface: 3, water: 0, light: 2 } },
    { id: 'ice', label: 'Ice prospecting and drilling', weights: { terrain: 1, thermal: 4, surface: 2, water: 5, light: 1 } },
    { id: 'eva', label: 'Astronaut EVA and field geology', weights: { terrain: 4, thermal: 1, surface: 5, water: 1, light: 2 } },
    { id: 'astrobio', label: 'Astrobiology and contamination', weights: { terrain: 0, thermal: 2, surface: 4, water: 5, light: 0 } },
    { id: 'power', label: 'Power and navigation (lighting)', weights: { terrain: 3, thermal: 2, surface: 0, water: 0, light: 5 } }
  ],

  // Feature score cut-offs for the gap report.
  thresholds: { holds: 0.7, partial: 0.4 },

  // Where to test instead when no place on Earth gets close enough.
  mitigations: {
    t_min_c: 'Test cold-soak in a thermal-vacuum chamber (for example NASA Johnson\'s Chamber A).',
    t_swing_c: 'Cycle hardware in a thermal-vacuum chamber to reproduce the full day-night swing.',
    t_mean_c: 'Use a cold room or an ice cave for long-duration thermal tests.',
    sun_elev_deg: 'Use a low-angle lighting rig in a dark test bay, or work at a polar site around the equinox.',
    rock: 'Use regolith simulant: LHS-1 (lunar highlands), LMS-1 (lunar mare) or MGS-1 (Mars).',
    slope_deg: 'Build a graded slope bed in a rover test yard.',
    relief_m: 'Pick a nearby site with more relief for traverse planning.',
    ndvi: 'Pick a barer site for imaging and contamination tests.',
    precip_mm: 'Pair with a hyperarid site such as the Atacama for dryness-sensitive tests.',
    ground_ice: 'Pair with a permafrost site such as the Dry Valleys or Devon Island for drilling.',
    lava_tube: 'Pair with a lava-tube site such as Lanzarote or Lava Beds.'
  },

  // Conditions Earth can never match, shown for every site.
  bodies: {
    earth: { gravity: 9.81, radiation_msv_day: 0.0066 }, // ~2.4 mSv/yr world-average natural background
    moon: {
      label: 'Moon', gravity: 1.62, radiation_msv_day: 1.37,
      pressureText: 'near-vacuum',
      dust: 'Lunar regolith is sharp, glassy and electrostatically charged. Use LHS-1 or LMS-1 simulant.',
      vacuumTest: 'Test seals, lubricants and outgassing in a vacuum chamber.'
    },
    mars: {
      label: 'Mars', gravity: 3.71, radiation_msv_day: 0.64,
      pressureText: null,
      dust: 'Martian dust is fine and carries perchlorate salts. Use MGS-1 simulant.',
      vacuumTest: 'Test in a CO2 chamber held near 0.6-0.9 kPa.'
    }
  },
  universalTests: {
    gravity: 'Use reduced-gravity parabolic flights or an offload rig such as NASA Johnson\'s ARGOS.',
    radiation: 'Use beam tests at NASA\'s Space Radiation Laboratory (Brookhaven).'
  }
};
