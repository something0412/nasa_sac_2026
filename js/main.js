// Game loop: fixed simulation tick (1 game hour) separate from 60 fps drawing.
(function () {
  'use strict';
  const MT = window.MT;
  const MS_PER_HOUR = 4000; // 1x speed: 4 real seconds = 1 game hour (30 days = 48 min; ▶▶ 24 min; ▶▶▶ 12 min)

  let state = null, speed = 1, lastSpeed = 1, acc = 0, last = performance.now();
  let queue = []; // events waiting for a pop-up
  let hover = null;
  let scenario = 'training';

  const renderer = MT.Renderer(document.getElementById('map'), document.getElementById('forecast'));
  const ui = MT.UI({
    speed: setSpeed,
    berm: () => { if (state && MT.Sim.startBerm(state)) refresh(); },
    shelter: () => { if (state) { MT.Sim.setShelter(state, !state.sheltering); refresh(); } },
    setShelter: (on) => { MT.Sim.setShelter(state, on); refresh(); },
    cargo: (i, opt) => { MT.Sim.chooseCargo(state, i, opt); refresh(); },
  });

  function setSpeed(s) {
    if (s > 0) lastSpeed = s;
    speed = s;
    ui.setSpeed(s);
  }

  function refresh() { ui.update(state); renderer.drawForecast(state); }

  function start(scn) {
    scenario = scn;
    state = MT.Sim.create({ scenario: scn });
    renderer.reset();
    queue = [];
    acc = 0;
    window.__state = state; // handy for debugging in the console
    refresh();
    setSpeed(1);
  }

  function menu() {
    setSpeed(0);
    if (!state) { state = MT.Sim.create({ scenario: 'training' }); refresh(); } // map shows behind the menu
    ui.showStart((scn) => start(scn));
  }

  function showNext() {
    if (ui.isModalOpen() || !queue.length) return;
    const ev = queue.shift();
    setSpeed(0);
    ui.showEvent(ev, state, () => { refresh(); if (queue.length) showNext(); else setSpeed(lastSpeed); });
  }

  function tick() {
    const events = MT.Sim.step(state);
    for (const ev of events) {
      if (ev.end) continue;
      ui.capcom(ev);
      if (ev.pause) queue.push(ev);
    }
    refresh();
    if (state.status !== 'running') {
      setSpeed(0);
      setTimeout(() => ui.showDebrief(state, () => start(scenario), menu), 700);
      return;
    }
    showNext();
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state && speed > 0 && state.status === 'running' && !ui.isModalOpen()) {
      acc += dt * 1000 * speed;
      let n = 0;
      while (acc >= MS_PER_HOUR && n < 8 && speed > 0) { acc -= MS_PER_HOUR; tick(); n++; }
    }
    if (state) {
      // How far we are into the current game hour (0..1). Used for smooth Sun movement, the clock and countdowns.
      const frac = state.status === 'running' ? Math.min(0.999, acc / MS_PER_HOUR) : 0;
      renderer.draw(state, dt, { hover, buildType: ui.selected, frac });
      ui.live(state, frac);
    }
    requestAnimationFrame(frame);
  }

  // ----- map input -----
  const canvas = document.getElementById('map');
  canvas.addEventListener('mousemove', (e) => { hover = renderer.tileAt(e); if (state) ui.tooltip(state, hover, !ui.selected); });
  canvas.addEventListener('mouseleave', () => { hover = null; ui.tooltip(state, null, false); });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.select(null); });
  canvas.addEventListener('click', (e) => {
    if (!state || state.status !== 'running') return;
    const t = renderer.tileAt(e);
    if (ui.selected) {
      const res = MT.Sim.place(state, ui.selected, t.c, t.r);
      if (!res.ok) ui.capcom({ level: 'warn', title: "Can't build here", text: res.why });
      else if (!e.shiftKey && state.res.parts < MT.CONFIG.modules[ui.selected].cost) ui.select(null);
    } else {
      const m = MT.Sim.moduleAt(state, t.c, t.r);
      if (m && !m.built) MT.Sim.cancel(state, m.id);
      else if (m && m.type === 'tower') { openTower(m); return; }
      else if (m) MT.Sim.toggle(state, m.id);
    }
    refresh();
    ui.tooltip(state, t, !ui.selected);
  });

  window.addEventListener('keydown', (e) => {
    if (ui.isModalOpen() || !state) return;
    if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : lastSpeed); }
    else if (e.key === 'Escape') ui.select(null);
    else if (/^[1-9]$/.test(e.key) && +e.key <= MT.CONFIG.buildOrder.length) { const t = MT.CONFIG.buildOrder[+e.key - 1]; ui.select(ui.selected === t ? null : t); }
  });

  // Astronomy Tower: pause the mission while the player looks at the picture, then resume.
  // The first tower shows today's picture; every other tower keeps its own random archive picture.
  function openTower(m) {
    const resume = speed; // stays paused if the player had paused
    setSpeed(0);
    ui.tooltip(state, null, false);
    const archive = MT.Sim.firstTower(state) !== m;
    try {
      ui.showTower({ archive, key: state.seed + ':' + m.id }, () => { setSpeed(resume); showNext(); });
    } catch (err) {
      // Never leave the mission frozen. (Usually an old cached script: press Ctrl+F5.)
      console.error('Astronomy Tower failed to open:', err);
      setSpeed(resume);
      ui.capcom({ level: 'warn', title: 'Astronomy Tower error', text: 'The picture viewer could not open. Try reloading the page with Ctrl+F5.' });
    }
  }

  menu();
  requestAnimationFrame(frame);
})();
