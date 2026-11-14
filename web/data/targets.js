// =============================================================================
// targets.js — the Moon and Mars places we look for Earth stand-ins for.
//
// OWNER: the mechanical engineer (the "spec owner").
// HOW TO EDIT: change a number, save, refresh the browser. No build step.
//
// Every value uses the SAME units as the Earth data (see js/config.js):
//   slope_deg     typical slope, degrees
//   relief_m      height range within ~5 km, metres
//   lava_tube     1 = this target is a cave / lava-tube skylight
//   t_min_c       coldest typical surface temperature, °C
//   t_swing_c     typical day-night surface temperature swing, °C
//   t_mean_c      mean surface temperature, °C (used for caves: ≈ cave interior)
//   rock          list of rock classes, most important first (see config.js)
//   ndvi          vegetation index (0 = bare ground, Moon and Mars are 0)
//   precip_mm     precipitation per year (0 on Moon and Mars)
//   ground_ice    0 none, 0.5 patchy, 1 ice-rich ground
//   sun_elev_deg  "auto" = computed from latitude (noon Sun height at equinox).
//                 Only the polar Moon targets use it: elsewhere sunlight is not
//                 what makes a place hard to test for.
//
// Leave a feature OUT if it does not apply (e.g. caves have no sunlight), and
// the scorer skips it for that target.
//
// "approx" values are first-pass estimates from the cited instruments and
// papers. Day-1 job for the spec owner: confirm each one and update the note.
// =============================================================================

window.TARGETS = [
  // ---------------------------------------------------------------- MOON ----
  {
    id: 'moon-connecting-ridge', body: 'moon', group: 'Moon, south pole',
    name: 'Shackleton Connecting Ridge',
    lat: -89.45, lon: -130.3, coordNote: 'approx. high-illumination point on the ridge',
    why: "Target of NASA's first Moon Base cargo landing (Blue Moon Mk1, no earlier than fall 2026). Near-continuous sunlight beside permanently shadowed, possibly icy craters.",
    features: { slope_deg: 6, relief_m: 1200, t_min_c: -190, t_swing_c: 130, rock: ['anorthosite', 'impact'], ndvi: 0, precip_mm: 0, ground_ice: 1, sun_elev_deg: 'auto' },
    env: { pressure_kpa: 0 },
    valueNote: 'Temperatures approx. from LRO Diviner polar maps; slope and relief approx. from LRO LOLA.',
    refs: [
      { label: 'Moon Base announcement (May 2026)', url: 'https://www.skyatnightmagazine.com/news/nasa-moon-base-announcement-may-2026' },
      { label: 'LRO Diviner temperature data', url: 'https://www.diviner.ucla.edu' },
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/' }
    ]
  },
  {
    id: 'moon-mons-mouton', body: 'moon', group: 'Moon, south pole',
    name: 'Mons Mouton Plateau',
    lat: -84.3, lon: 30.6, coordNote: 'LROC mosaic centre of the Artemis III region',
    why: 'Artemis III candidate region: a flat-topped mountain about 6 km tall, between Nobile and Malapert craters.',
    features: { slope_deg: 3, relief_m: 400, t_min_c: -180, t_swing_c: 150, rock: ['anorthosite', 'impact'], ndvi: 0, precip_mm: 0, ground_ice: 1, sun_elev_deg: 'auto' },
    env: { pressure_kpa: 0 },
    valueNote: 'Temperatures approx. from LRO Diviner; plateau slope approx. from LRO LOLA.',
    refs: [
      { label: 'Artemis III: nine candidate regions (NASA)', url: 'https://ntrs.nasa.gov/citations/20250011660' },
      { label: 'Mons Mouton (NASA SVS)', url: 'https://svs.gsfc.nasa.gov/5074' },
      { label: 'LROC mosaic of the region', url: 'https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_ROI_MOUTNPLTLO1' }
    ]
  },
  {
    id: 'moon-malapert', body: 'moon', group: 'Moon, south pole',
    name: 'Malapert Massif',
    lat: -86.0, lon: 0.0, coordNote: 'approx.',
    why: 'Artemis III candidate region: a tall massif with long sunlit periods and good line of sight to Earth.',
    features: { slope_deg: 10, relief_m: 1500, t_min_c: -180, t_swing_c: 150, rock: ['anorthosite', 'impact'], ndvi: 0, precip_mm: 0, ground_ice: 1, sun_elev_deg: 'auto' },
    env: { pressure_kpa: 0 },
    valueNote: 'All values approx.: verify with LOLA slope maps and Diviner.',
    refs: [
      { label: 'Artemis III: nine candidate regions (NASA)', url: 'https://ntrs.nasa.gov/citations/20250011660' },
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/' }
    ]
  },
  {
    id: 'moon-haworth', body: 'moon', group: 'Moon, south pole',
    name: 'Haworth',
    lat: -87.4, lon: -5.0, coordNote: 'approx.',
    why: 'Artemis III candidate region on the rim of Haworth crater, whose floor holds some of the coldest ground on the Moon.',
    features: { slope_deg: 8, relief_m: 1500, t_min_c: -200, t_swing_c: 130, rock: ['anorthosite', 'impact'], ndvi: 0, precip_mm: 0, ground_ice: 1, sun_elev_deg: 'auto' },
    env: { pressure_kpa: 0 },
    valueNote: 'All values approx.: verify with LOLA slope maps and Diviner.',
    refs: [
      { label: 'Artemis III: nine candidate regions (NASA)', url: 'https://ntrs.nasa.gov/citations/20250011660' },
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/' }
    ]
  },
  {
    id: 'moon-tranquillitatis', body: 'moon', group: 'Moon, mare and caves',
    name: 'Mare Tranquillitatis (Apollo 11)',
    lat: 0.674, lon: 23.473, coordNote: 'Apollo 11 landing site',
    why: 'Classic equatorial mare: smooth basalt plains with the full lunar day-night temperature swing.',
    features: { slope_deg: 2, relief_m: 60, t_min_c: -173, t_swing_c: 300, rock: ['basalt', 'impact'], ndvi: 0, precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0 },
    valueNote: 'Surface about 127 °C by day and -173 °C at night (LRO Diviner).',
    refs: [
      { label: 'LRO Diviner temperature data', url: 'https://www.diviner.ucla.edu' },
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/' }
    ]
  },
  {
    id: 'moon-tranq-pit', body: 'moon', group: 'Moon, mare and caves',
    name: 'Mare Tranquillitatis pit (lava-tube skylight)',
    lat: 8.335, lon: 33.222, coordNote: 'approx.',
    why: 'A 100 m deep pit that may open into a lava tube. Its shaded floor stays near 17 °C: a natural shelter.',
    features: { lava_tube: 1, t_mean_c: 17, rock: ['basalt'], precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0, sheltered: true },
    valueNote: 'Shaded pit temperature from Horvath et al. 2022 (LRO Diviner).',
    refs: [
      { label: 'Lunar pits hold ~17 °C (NASA/GSFC)', url: 'https://www.eurekalert.org/news-releases/959966' },
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/' }
    ]
  },

  // ---------------------------------------------------------------- MARS ----
  {
    id: 'mars-jezero', body: 'mars', group: 'Mars, rover and landing sites',
    name: 'Jezero Crater (Perseverance)',
    lat: 18.44, lon: 77.45, coordNote: 'Perseverance landing site',
    why: 'Ancient lake and river delta where Perseverance is collecting samples for possible return to Earth.',
    features: { slope_deg: 4, relief_m: 150, t_min_c: -90, t_swing_c: 80, t_mean_c: -50, rock: ['sedimentary', 'basalt'], ndvi: 0, precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0.72 },
    valueNote: 'Ground temperatures approx. from MEDA; pressure 718 Pa in MEDA\'s first report.',
    refs: [
      { label: 'MEDA weather at Jezero (Nature Geoscience)', url: 'https://link.springer.com/article/10.1038/s41561-022-01084-0' },
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  },
  {
    id: 'mars-gale', body: 'mars', group: 'Mars, rover and landing sites',
    name: 'Gale Crater (Curiosity)',
    lat: -4.59, lon: 137.44, coordNote: 'Curiosity landing site',
    why: 'Layered lake mudstones and sulfate-bearing rocks at the foot of Mount Sharp.',
    features: { slope_deg: 6, relief_m: 300, t_min_c: -90, t_swing_c: 90, t_mean_c: -45, rock: ['sedimentary', 'evaporite'], ndvi: 0, precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0.8 },
    valueNote: 'Values approx. from REMS ground temperature and pressure records.',
    refs: [
      { label: 'Surface radiation at Gale (Hassler et al. 2014)', url: 'https://doi.org/10.1126/science.1244797' },
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  },
  {
    id: 'mars-arcadia', body: 'mars', group: 'Mars, rover and landing sites',
    name: 'Arcadia Planitia (shallow ice)',
    lat: 40.0, lon: -165.0, coordNote: 'approx. centre of the ice-rich plains',
    why: 'Flat northern plains with water ice likely within a metre of the surface: a leading candidate for human landings.',
    features: { slope_deg: 2, relief_m: 60, t_min_c: -120, t_swing_c: 70, t_mean_c: -60, rock: ['basalt', 'ice'], ndvi: 0, precip_mm: 0, ground_ice: 1 },
    env: { pressure_kpa: 0.8 },
    valueNote: 'All values approx.: verify with the Mars Climate Database and SWIM ice maps.',
    refs: [
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  },
  {
    id: 'mars-utopia', body: 'mars', group: 'Mars, rover and landing sites',
    name: 'Utopia Planitia (Zhurong)',
    lat: 25.07, lon: 109.93, coordNote: 'Zhurong landing site',
    why: "Vast lowland plain explored by China's Zhurong rover.",
    features: { slope_deg: 2, relief_m: 60, t_min_c: -100, t_swing_c: 80, t_mean_c: -55, rock: ['basalt', 'sedimentary'], ndvi: 0, precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0.75 },
    valueNote: 'All values approx.: verify with the Mars Climate Database.',
    refs: [
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  },
  {
    id: 'mars-meridiani', body: 'mars', group: 'Mars, rover and landing sites',
    name: 'Meridiani Planum (Opportunity)',
    lat: -1.95, lon: -5.53, coordNote: 'Opportunity landing site',
    why: 'Sulfate sandstones and hematite "blueberries" that record ancient acidic water.',
    features: { slope_deg: 1, relief_m: 30, t_min_c: -95, t_swing_c: 95, t_mean_c: -45, rock: ['evaporite', 'basalt'], ndvi: 0, precip_mm: 0, ground_ice: 0 },
    env: { pressure_kpa: 0.6 },
    valueNote: 'All values approx.: verify with Mini-TES records and the Mars Climate Database.',
    refs: [
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  },
  {
    id: 'mars-arsia-caves', body: 'mars', group: 'Mars, caves',
    name: 'Arsia Mons skylights (cave candidates)',
    lat: -6.0, lon: -120.5, coordNote: 'approx. centre of the pit cluster',
    why: 'Pit openings on the flank of a giant volcano that may lead into lava tubes: shelter from radiation and dust.',
    features: { lava_tube: 1, t_mean_c: -60, rock: ['basalt'], precip_mm: 0, ground_ice: 0.5 },
    env: { pressure_kpa: 0.3, sheltered: true },
    valueNote: 'All values approx.; the cave interior temperature is assumed close to the mean surface temperature.',
    refs: [
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/' }
    ]
  }
];
