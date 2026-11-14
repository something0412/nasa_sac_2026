# Junior Astronaut Mission Trainer: Shackleton Base

A 2D browser game for NASA Space Apps 2026. You run a Moon base at the lunar south pole and keep
4 astronauts alive for 30 days by balancing **power, oxygen, water, food and radiation**.

## Play it

```bash
python -m http.server 8137
```

Open http://localhost:8137. (Double-clicking `index.html` also works: no build step, no internet.)

Controls: click a build button (or keys 1-6), then click the map. Click a module to turn it ON/OFF.
Click a module that is still being built to cancel it. Space = pause. Esc / right-click = stop building.

## What makes it different

- **You see and build the base** on a map, not just a dashboard.
- **Real south pole sunlight:** the Sun circles the horizon, so shadows move. The high ridge is sunny most
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
js/main.js          game loop: fixed 1-hour sim tick, separate from drawing
data/may2024.js     GENERATED from NASA DONKI by tools/build_may2024.py
tests/sim.test.js   plays whole missions with bots to check balance
```

Tests: `node --test tests/sim.test.js` (from the project root).
Refresh the data: `python tools/build_may2024.py [YOUR_API_KEY]`.

## Data and sources

- NASA DONKI space weather (api.nasa.gov): flare notifications, SEP and GST events, May 2024.
- Lunar surface radiation 1.369 mSv/day: Chang'e-4 LND (Zhang et al. 2020, Science Advances).
- 30-day crew limit 250 mGy-Eq: NASA-STD-3001.
- O₂ 0.84 kg and food ~1.8 kg per person per day: NASA BVAD (NASA/TP-2015-218570).
- Polar illumination idea: LRO LOLA illumination studies (Mazarico et al. 2011).
- Storm doses, module power and production rates are game-tuned (marked GAME in `js/config.js`).
