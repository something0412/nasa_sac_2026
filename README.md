# Junior Astronaut Mission Trainer: Shackleton Base

A 2D browser game for NASA Space Apps 2026. You run a Moon base at the lunar south pole and keep
4 astronauts alive for 30 days by balancing **power, oxygen, water, food and radiation**.

## Play it

```bash
python -m http.server 8137
```

Open http://localhost:8137. (Double-clicking `index.html` also works: no build step, no internet.)

Controls: **always pick an astronaut first** (buttons at the top of Build, an AMS card, the astronaut on the
map, or Shift+1-4), then pick what they do:
- Engineers (Astronaut 1, 2): pick a build button (or keys 1-9) and click the map; click a damaged module
  (cracks + 🔧) to repair it (1 part); click a building site (or the habitat, for the shield) to give them that job.
- Scientist (Astronaut 3): click a Research Bay to research an upgrade (1 day in the lab).
- Botanist (Astronaut 4): click a greenhouse to tend it for 1 day (2x food).
- Sending the crew to the shelter puts research / greenhouse work on hold. Afterwards, pick the Scientist or
  Botanist and click the Research Bay / greenhouse again: the hours that were left carry on.
  (Inside the lab and greenhouse the radiation is the same as in the habitat.)
- Anyone: click an Astronomy Tower (their stress -30; each tower every 12 h) or a Fitness Center (2 h of
  training). Nobody trains by themselves: send each astronaut about once a day ("🏋️ Needs training" in the AMS).


With nobody picked, click a module to turn it ON/OFF, or a building site to cancel it (parts back).
Space = pause. Esc / right-click = stop building, then un-pick the astronaut.
V (or the 🧊 button) = switch between the top-down and the 2.5D isometric view; scroll wheel or +/- = zoom.

Drag the map to look around (the world is 80 x 56 tiles, the view shows 20 x 14). If the base is off-screen,
a 🏠 BASE tag on the edge points the way; click it or press H to fly back.
The map fills the whole window. The top bar has the speed buttons, the sunlight forecast and the day.
On the map: CAPCOM, Why? and Mission log are small buttons on the left (click to expand; CAPCOM shows a dot
when a new message arrives), Build is on the right, Supplies at the bottom.
Click a panel's title bar (or keys S = Supplies, B = Build, A = AMS, W = Why?, C = CAPCOM, L = Log) to collapse/expand it.
The choice is remembered per browser.

## What makes it different

- **You see and build the base** on a map, not just a dashboard.
- **Real south pole sunlight:** the Sun circles the horizon once every 29.5 days, so shadows slowly turn and
  light fades gradually (over ~12 game hours) as the Sun slides behind hills. Solar power follows the light level. The high ridge is sunny most
  of the time; the plain gets multi-day shadows. A sunlight forecast strip lets players plan.
- **Visible cause chains:** "Why is this happening?" shows, live: shadow → solar 0 kW → battery draining →
  greenhouse off → no new food. Power cables on the map turn red when a module has no power.
- **Real data mode:** replays the real **May 2024 solar storms** (the strongest in 20 years) from NASA DONKI:
  real flare classes and times, real solar particle (radiation) storms, and the Kp 9 geomagnetic storm.
- **Kid-friendly debrief:** a cause → effect timeline of WHY the mission failed, charts, tips, and a real
  NASA connection.

## Files

```
index.html          page layout
css/style.css       look and feel
js/config.js        ALL game numbers, with sources (REAL vs GAME-tuned)
js/sim.js           the rules (no drawing): one step() = one game hour
js/render.js        map drawing at 60 fps (offscreen ground, particle pool)
js/ui.js            side panel, pop-ups, debrief
js/apod.js          Astronomy Tower: NASA picture of the day under a fishbowl lens (needs internet)
js/main.js          game loop: fixed 1-hour sim tick, separate from drawing
data/may2024.js     GENERATED from NASA DONKI by tools/build_may2024.py
data/radlab.js      GENERATED from NASA RadLab (LRO CRaTER radiation) by tools/build_radlab.py
tests/sim.test.js   plays whole missions with bots to check balance
```

Tests: `node --test tests/sim.test.js` (from the project root).
Refresh the data: `python tools/build_may2024.py [YOUR_API_KEY]` and `python tools/build_radlab.py` (no key needed).

## Data and sources

- NASA DONKI space weather (api.nasa.gov): flare notifications, SEP and GST events, May 2024.
- Lunar surface radiation 1.369 mSv/day: Chang'e-4 LND (Zhang et al. 2020, Science Advances).
- Astronaut health: 100 HP = NASA's 600 mSv career radiation limit (NASA-STD-3001, 2022). In the habitat that lasts ~2.4 years.
  When an astronaut's health bar runs out they are medically retired and sent home to Earth (a pop-up tells you, and
  they leave the roster). If every astronaut is sent home, the mission fails. (0% bone density = medbay on the Moon.)

- Bone loss: ISS crews lose ~1-1.5% hip bone per month and exercise ~2 h/day; the game speeds this up to ~1%/day (GAME).
- Meteor showers: the May 2024 mission has the real Eta Aquariids (~5 May 2024). Damage chances and stress rates are GAME-tuned.
- Accidents (about one every 3-4 days): Ice Drill water leak, greenhouse plant disease, O₂ valve leak, moondust on
  a solar panel (moondust is electrically charged and sticks, as Apollo crews found). Amounts are GAME-tuned.
- Research Bay: +50% per upgrade, max 2x, only within 10 tiles of a working Research Bay; costs 2, 4, 6, ... parts (GAME).

- O₂ 0.84 kg and food ~1.8 kg per person per day: NASA BVAD (NASA/TP-2015-218570).
- Polar illumination idea: LRO LOLA illumination studies (Mazarico et al. 2011).
- Storm radiation: real hourly dose measured at the Moon by NASA's Lunar Reconnaissance Orbiter (CRaTER),
  from the [NASA OSDR RadLab API](https://visualization.osdr.nasa.gov/radlab/gui/data-api/). The May 2024 mission
  replays every hour of May 2024; training missions copy real storms (Jan 2012, Mar 2012, Sep 2017, May 2024, Oct 2021).
  Orbit-to-surface conversion: ×0.75 for the sky the Moon blocks (approximate) and ×1.5 for protons (NASA-STD-3001 RBE).
- Astronomy Tower pictures: NASA Astronomy Picture of the Day, live from the APOD Basic JSON feed
  (`science.nasa.gov/wp-json/wp/v2/apod-basic`, no key). The newest image post is shown; video days are skipped.
  This is the only feature that needs internet; it falls back to the last picture received.
- Shielding fractions, module power and production rates are game-tuned (marked GAME in `js/config.js`).
