// Game loop: fixed simulation tick (1 game hour) separate from 60 fps drawing.
(function () {
  'use strict';
  const MT = window.MT;
  const MS_PER_HOUR = 4000; // 1x speed: 4 real seconds = 1 game hour (30 days = 48 min; ▶▶ 24 min; ▶▶▶ 12 min)

  let state = null, speed = 1, lastSpeed = 1, acc = 0, last = performance.now();
  let hover = null;
  let scenario = 'training';

  // Top-down or isometric (2.5D) map: js/view.js picks which renderer draws. V or the 🧊 button switches.
  const renderer = MT.ViewSwitch(document.getElementById('map'), document.getElementById('forecast'));
  const viewBtn = document.getElementById('viewBtn');
  viewBtn.addEventListener('click', () => renderer.toggleView());
  renderer.onViewChange((v) => { viewBtn.textContent = v === 'iso' ? '🗺️ Top view' : '🧊 2.5D view'; });
  const ui = MT.UI({
    speed: setSpeed,
    berm: () => { if (state && MT.Sim.startBerm(state)) refresh(); },
    shelter: () => { if (state) { MT.Sim.setShelter(state, !state.sheltering); refresh(); } },
    cargo: (i, opt) => { MT.Sim.chooseCargo(state, i, opt); refresh(); },
    heal: (id) => {
      if (!state || state.status !== 'running') return;
      const r = MT.Sim.startHeal(state, id);
      const a = state.crew.find((x) => x.id === id);
      ui.capcom(r.ok
        ? { level: 'info', title: `🏥 ${a.name} is resting in the medbay`, text: `Healing +${Math.round(r.amount)} HP over ${MT.CONFIG.astro.medbay.healH / 24} days. Radiation damage (purple) can't be healed.` }
        : { level: 'warn', title: "Can't use the medbay", text: r.why });
      refresh();
    },
    panels: () => updateSafeArea(),
  });

  // The map fills the stage. Re-measure when the window changes size.
  const stage = document.getElementById('stage');
  function fit() { const r = stage.getBoundingClientRect(); renderer.resize(r.width, r.height); updateSafeArea(); }
  new ResizeObserver(fit).observe(stage);
  fit();

  // Tell the renderer which screen edges are covered by open panels (so the BASE tag stays visible).
  function updateSafeArea() {
    const st = document.getElementById('stage').getBoundingClientRect(); // (looked up here: this can run before `stage` exists)
    const covered = (sel) => [...document.querySelectorAll(sel + ' .panel:not([hidden])')].map((p) => p.getBoundingClientRect());
    const left = covered('.dock.left'), right = covered('.dock.right');
    const bottomDock = document.querySelector('.dock.bottom').getBoundingClientRect();
    const topBox = document.querySelector('.topCenter').getBoundingClientRect();
    renderer.setSafeArea({
      left: left.length ? Math.max(...left.map((r) => r.right)) - st.left + 8 : 0,
      right: right.length ? st.right - Math.min(...right.map((r) => r.left)) + 8 : 0,
      top: topBox.height ? topBox.bottom - st.top + 6 : 0,
      bottom: st.bottom - bottomDock.top + 6,
    });
  }

  function setSpeed(s) {
    if (s > 0) lastSpeed = s;
    speed = s;
    ui.setSpeed(s);
  }

  function refresh() { ui.update(state); renderer.drawForecast(state); updateSafeArea(); }

  function start(scn) {
    scenario = scn;
    state = MT.Sim.create({ scenario: scn });
    renderer.reset();
    ui.clearBanners();
    acc = 0;
    window.__state = state; // handy for debugging in the console
    window.__renderer = renderer;
    refresh();
    setSpeed(1);
  }

  function menu() {
    setSpeed(0);
    if (!state) { state = MT.Sim.create({ scenario: 'training' }); refresh(); } // map shows behind the menu
    ui.showStart((scn) => start(scn));
  }

  function tick() {
    const events = MT.Sim.step(state);
    for (const ev of events) {
      if (ev.end) continue;
      ui.capcom(ev);
      if (ev.banner) ui.banner(ev); // drop-down on the map; the game keeps running
    }
    refresh();
    if (state.status !== 'running') {
      setSpeed(0);
      ui.clearBanners();
      setTimeout(() => ui.showDebrief(state, () => start(scenario), menu), 700);
      return;
    }
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
      renderer.draw(state, dt, { hover, buildType: ui.selected, frac, dragging: !!(press && press.dragging) });
      ui.live(state, frac);
    }
    requestAnimationFrame(frame);
  }

  // ----- map input -----
  // Press + move more than a few pixels = drag the map. Press + release in place = click.
  const canvas = document.getElementById('map');
  const DRAG_PX = 6;
  let press = null; // { x, y, camX, camY, dragging }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const cam = renderer.panStart();
    press = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, dragging: false, id: e.pointerId };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (press && press.id === e.pointerId) {
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) > DRAG_PX) {
        press.dragging = true;
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('dragging');
        ui.tooltip(state, null, false);
      }
      if (press.dragging) {
        const s = renderer.toCanvas(e).scale; // CSS pixels → canvas pixels
        renderer.panTo(press.camX - dx * s, press.camY - dy * s);
        return;
      }
    }
    hover = renderer.tileAt(e);
    if (state) ui.tooltip(state, hover, !ui.selected);
    canvas.classList.toggle('overTag', renderer.hitTag(e));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const wasDrag = press.dragging;
    press = null;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!wasDrag) onMapClick(e);
  });
  canvas.addEventListener('pointercancel', () => { press = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('pointerleave', () => { if (!press) { hover = null; ui.tooltip(state, null, false); } });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.select(null); });
  // Scroll wheel = zoom in/out around the mouse (both views). Each wheel notch is about 15%.
  canvas.addEventListener('wheel', (e) => {
    if (!renderer.canZoom()) return;
    e.preventDefault();
    renderer.zoomAt(e, Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.0015));
    hover = renderer.tileAt(e);
  }, { passive: false });

  function onMapClick(e) {
    if (!state) return;
    if (renderer.hitTag(e)) { renderer.centerOnBase(state, true); return; }
    if (state.status !== 'running') return;
    const t = renderer.tileAt(e);
    if (ui.selected) {
      const res = MT.Sim.place(state, ui.selected, t.c, t.r);
      if (!res.ok) ui.capcom({ level: 'warn', title: "Can't build here", text: res.why });
      else if (!e.shiftKey && state.res.parts < MT.CONFIG.modules[ui.selected].cost) ui.select(null);
    } else {
      const m = MT.Sim.moduleAt(state, t.c, t.r);
      if (m && !m.built) MT.Sim.cancel(state, m.id);
      else if (m && m.damaged) { // damaged by a storm or meteors: order a repair
        const r = MT.Sim.orderRepair(state, m.id);
        ui.capcom(r.ok ? { level: 'info', title: `Repair ordered: ${MT.CONFIG.modules[m.type].name}`, text: 'One astronaut will go outside to fix it when someone is free.' }
          : { level: 'warn', title: "Can't repair yet", text: r.why });
      }
      else if (m && m.type === 'tower') { openTower(m); return; }
      else if (m) MT.Sim.toggle(state, m.id);
    }
    refresh();
    ui.tooltip(state, t, !ui.selected);
  }

  window.addEventListener('keydown', (e) => {
    if (ui.isModalOpen() || !state) return;
    if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : lastSpeed); }
    else if (e.key === 'Escape') ui.select(null);
    else if (e.key === 'h' || e.key === 'H') renderer.centerOnBase(state, true);
    else if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey) { renderer.toggleView(); hover = null; }
    else if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey) renderer.zoomAt(null, e.key === '-' || e.key === '_' ? 1 / 1.25 : 1.25);
    else if (/^[1-9]$/.test(e.key) && +e.key <= MT.CONFIG.buildOrder.length) { const t = MT.CONFIG.buildOrder[+e.key - 1]; ui.select(ui.selected === t ? null : t); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const panel = { s: 'supplies', b: 'build', a: 'ams', w: 'why', c: 'capcom', l: 'log' }[e.key.toLowerCase()];
      if (panel) ui.togglePanel(panel);
    }
  });

  // Astronomy Tower: pause the mission while the player looks at the picture, then resume.
  // The first tower shows today's picture; every other tower keeps its own random archive picture.
  function openTower(m) {
    const entry = MT.Sim.enterTower(state, m.id);
    if (!entry.ok) { ui.capcom({ level: 'warn', title: "Can't use the Astronomy Tower", text: entry.why }); return; }
    if (entry.relief) {
      const ev = { level: 'good', title: '🔭 New Astronomy Tower: stress goes down!', text: `The whole crew gathered for the first look through the new telescope. Everyone's stress dropped by ${MT.CONFIG.astro.stress.towerRelief}. (Each NEW tower does this once.)` };
      ui.capcom(ev); ui.banner(ev);
    }
    refresh();
    const resume = speed; // stays paused if the player had paused
    setSpeed(0);
    ui.tooltip(state, null, false);
    const archive = MT.Sim.firstTower(state) !== m;
    try {
      ui.showTower({ archive, key: state.seed + ':' + m.id }, () => setSpeed(resume));
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
