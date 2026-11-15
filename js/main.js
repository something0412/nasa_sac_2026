// Game loop: fixed simulation tick (1 game hour) separate from 60 fps drawing.
(function () {
  'use strict';
  const MT = window.MT;
  // 1x speed: 1 game hour = 2 real seconds (30 days = 24 min; ▶▶ 12 min; ▶▶▶ 6 min).
  const MS_PER_HOUR = 2000;

  let state = null, speed = 1, lastSpeed = 1, acc = 0, last = performance.now();
  let hover = null;
  let scenario = 'training';

  // Top-down or isometric (2.5D) map: js/view.js picks which renderer draws. V or the 🧊 button switches.
  const renderer = MT.ViewSwitch(document.getElementById('map'), document.getElementById('forecast'));
  const viewBtn = document.getElementById('viewBtn');
  viewBtn.addEventListener('click', () => renderer.toggleView());
  renderer.onViewChange((v) => { viewBtn.textContent = v === 'iso' ? '🗺️ Top view' : '🧊 2.5D view'; });
  /** The astronaut the player picked (always first: then what to build or use). */
  const picked = () => (state && ui.selectedCrew ? MT.Sim.crewById(state, ui.selectedCrew) : null);
  const warn = (title, text) => ui.capcom({ level: 'warn', title, text });
  const ui = MT.UI({
    speed: setSpeed,
    berm: () => {
      if (!state || state.status !== 'running') return;
      const a = picked();
      if (!a || a.role !== 'engineer') { ui.nudge('Pick an Engineer first, then press the shield button (it goes on their HAB).'); return; }
      const r = MT.Sim.startBerm(state, a.id);
      if (!r.ok) warn("Can't start the shield", r.why);
      refresh();
    },
    shelter: () => {
      if (!state) return;
      const going = !state.sheltering;
      if (!MT.Sim.setShelter(state, going)) return;
      // Research and greenhouse work wait for the player to send the astronaut back.
      const held = state.crew.filter((a) => !a.medbay && a.paused);
      const what = (a) => `${a.name} (${a.paused.kind === 'lab' ? 'research' : 'greenhouse'}, ${a.paused.left} h left)`;
      if (held.length) ui.capcom({ level: 'info', title: going ? '⏸ Work on hold while the crew shelters' : '⏸ Still on hold', text: `${held.map(what).join(', ')}. After the storm, pick them and click the ${held.length > 1 ? 'Research Bay / greenhouse' : held[0].paused.kind === 'lab' ? 'Research Bay' : 'greenhouse'} to continue.` });
      refresh();
    },
    cargo: (i, opt) => { MT.Sim.chooseCargo(state, i, opt); refresh(); },
    // Rover: the first press buys it; after that it opens fast travel (the game waits while the dialog is open).
    rover: () => {
      if (!state || state.status !== 'running') return;
      if (!state.rover) {
        const r = MT.Sim.buyRover(state);
        r.ok ? ui.capcom({ level: 'good', title: '🚙 Rover ready!', text: 'It is parked at HAB 1. Press the rover button to drive up to 4 astronauts to another HAB.' }) : warn("Can't build the rover", r.why);
        refresh(); return;
      }
      if (MT.Sim.habs(state).length < 2) { warn('Nowhere to drive yet', 'The rover drives between HABs. Build a second HAB first (15 parts).'); return; }
      ui.tooltip(state, null, false);
      ui.showRover(state, (to, ids) => {
        const r = MT.Sim.startTrip(state, to, ids);
        r.ok ? ui.capcom({ level: 'info', title: '🚙 The rover is on its way', text: `${ids.length} astronaut${ids.length > 1 ? 's' : ''} aboard · about ${r.hours} h.` }) : warn("Can't drive", r.why);
        refresh();
      });
    },
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
    popups.length = 0;
    state = MT.Sim.create({ scenario: scn });
    renderer.reset();
    ui.clearBanners();
    acc = 0;
    window.__state = state; // handy for debugging in the console
    window.__renderer = renderer;
    refresh();
    // Every game opens with the crew's spaceship touching down at the base (just the animation:
    // no new astronauts or HAB to place). The clock starts when it has landed.
    busy = true;
    setSpeed(0);
    ui.playLanding(() => { busy = false; setSpeed(1); }, '🚀 Your crew has landed at Zain Base!');
  }

  function menu() {
    setSpeed(0);
    if (!state) { state = MT.Sim.create({ scenario: 'training' }); refresh(); } // map shows behind the menu
    ui.showStart((scn) => start(scn));
  }

  // Pop-ups that must be seen, one after another. The game waits while one is open:
  //  - an astronaut sent home to Earth
  //  - the crew spaceship: it lands on a Landing Pad → pick the new astronauts' jobs and their HAB
  const popups = [];
  let busy = false; // the landing animation is playing
  function nextPopup() {
    if (busy || !popups.length || ui.isModalOpen() || state.status !== 'running') return;
    const ev = popups.shift();
    if (ev.popup === 'home') {
      ev.left = MT.Sim.activeCrew(state).length; // count now (two can leave in the same hour)
      ui.showSentHome(ev, nextPopup);
    } else if (ev.ship) {
      busy = true;
      const resume = speed;
      setSpeed(0);
      ui.tooltip(state, null, false);
      // Look at the Landing Pad, then the spaceship touches down right on it. The new astronauts live in the
      // HAB closest to that pad. With more than one ready pad, the player picks where it lands first.
      const land = (padId) => {
        const pad = state.modules.find((m) => m.id === padId);
        let at = null;
        if (pad) { renderer.centerOnTile(pad.c + pad.w / 2, pad.r + pad.h / 2, false); at = renderer.screenOf(pad.c + pad.w / 2, pad.r + pad.h / 2); }
        ui.playLanding(() => {
          busy = false;
          ui.showNewCrew(state, padId, (roles) => {
            const added = MT.Sim.joinCrew(state, roles, padId);
            setSpeed(resume || 1);
            const home = added.length && MT.Sim.homeOf(state, added[0]);
            ui.capcom({ level: 'good', title: `👋 Welcome, ${added.map((a) => a.name).join(' and ')}!`, text: home ? `They live in ${MT.Sim.habName(state, home)}, the HAB closest to their Landing Pad. Only a rover trip can move them to another HAB.` : '' });
            refresh();
            nextPopup();
          });
        }, '🚀 The crew spaceship has landed!', at);
      };
      const pads = ev.pads && ev.pads.length ? ev.pads : [ev.padId];
      if (pads.length > 1) ui.showPickPad(state, pads, land); else land(pads[0]);
    }
  }

  function tick() {
    const events = MT.Sim.step(state);
    for (const ev of events) {
      if (ev.end) continue;
      ui.capcom(ev);
      if (ev.banner) ui.banner(ev); // drop-down on the map; the game keeps running
      if (ev.popup === 'home' || ev.ship) popups.push(ev);
    }
    nextPopup(); // (if the mission just ended, the debrief explains it instead)
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
    if (state && speed > 0 && state.status === 'running' && !ui.isModalOpen() && !busy) {
      acc += dt * 1000 * speed;
      let n = 0;
      while (acc >= MS_PER_HOUR && n < 8 && speed > 0 && !ui.isModalOpen() && !busy) { acc -= MS_PER_HOUR; tick(); n++; }
    }
    if (state) {
      // How far we are into the current game hour (0..1). Used for smooth Sun movement, the clock and countdowns.
      const frac = state.status === 'running' ? Math.min(0.999, acc / MS_PER_HOUR) : 0;
      renderer.draw(state, dt, { hover, buildType: ui.selected, selectedCrew: ui.selectedCrew, frac, dragging: !!(press && press.dragging), paused: speed === 0 || ui.isModalOpen() });
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
  // Right click: cancel the building choice first, then un-pick the astronaut.
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (ui.selected) ui.select(null); else ui.selectCrew(null); });
  // Scroll wheel = zoom in/out around the mouse (both views). Each wheel notch is about 15%.
  canvas.addEventListener('wheel', (e) => {
    if (!renderer.canZoom()) return;
    e.preventDefault();
    renderer.zoomAt(e, Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.0015));
    hover = renderer.tileAt(e);
  }, { passive: false });

  // Every click that sends an astronaut somewhere needs a picked astronaut, so the player controls who goes where.
  function onMapClick(e) {
    if (!state) return;
    if (renderer.hitTag(e)) { renderer.centerOnBase(state, true); return; }
    if (state.status !== 'running') return;
    const t = renderer.tileAt(e);
    const C = MT.CONFIG, a = picked();
    const info = (title, text) => ui.capcom({ level: 'info', title, text });
    if (ui.selected) {
      if (!a || a.role !== 'engineer') { ui.select(null); ui.nudge('First pick an Engineer, then choose what to build.'); return; }
      const res = MT.Sim.place(state, ui.selected, t.c, t.r, a.id);
      if (!res.ok) warn("Can't build here", res.why);
      else if (!e.shiftKey && state.res.parts < C.modules[ui.selected].cost) ui.select(null);
    } else {
      // Clicking an astronaut on the map picks them.
      const who = renderer.crewAt(e);
      if (who) { ui.selectCrew(ui.selectedCrew === who ? null : who); refresh(); return; }
      const m = MT.Sim.moduleAt(state, t.c, t.r);
      const name = m && C.modules[m.type].name;
      if (!m) { /* empty ground */ }
      else if (!m.built) { // building site: picked Engineer takes over the job; nobody picked = cancel (parts back)
        if (!a) MT.Sim.cancel(state, m.id);
        else { const r = MT.Sim.assignWorker(state, m.id, a.id); r.ok ? info(`👷 ${a.name} will build the ${name}`, 'Each job has exactly one Engineer.') : warn("Can't give this job", r.why); }
      }
      else if (m.type === 'hab') {
        if (a && m.berm.building && !m.berm.built) { const r = MT.Sim.assignWorker(state, MT.Sim.bermKey(state, m), a.id); r.ok ? info(`⛰️ ${a.name} will pile the moon dirt`, '') : warn("Can't give this job", r.why); }
      }
      else if (m.damaged && (!a || a.role === 'engineer')) { // damaged by a storm or meteors: repair
        if (!a) ui.nudge(`Pick an Engineer, then click the damaged ${name} to repair it.`);
        else if (m.repair) { const r = MT.Sim.assignWorker(state, m.id, a.id); r.ok ? info(`🔧 ${a.name} will repair the ${name}`, '') : warn("Can't give this job", r.why); }
        else {
          const r = MT.Sim.orderRepair(state, m.id, a.id);
          r.ok ? info(`🔧 Repair ordered: ${name}`, `${a.name} will go outside to fix it (${C.damage.repairCost} part).`) : warn("Can't repair yet", r.why);
        }
      }
      else if (m.type === 'tower') {
        if (!a) ui.nudge('Pick an astronaut, then click the Astronomy Tower: their stress goes down.');
        else { openTower(m, a); return; }
      }
      else if (m.type === 'lab') {
        if (!a || a.role !== 'scientist') ui.nudge(a ? `Only Scientists can use the Research Bay. ${a.name} is the ${C.astro.roleInfo[a.role].name}.` : 'Pick a Scientist, then click the Research Bay.');
        else if (a.paused && a.paused.kind === 'lab') { // continue the research that the shelter put on hold
          const r = MT.Sim.resumeTask(state, m.id, a.id);
          r.ok ? info(`🔬 ${a.name} is back in the Research Bay`, `Researching faster ${C.modules[a.task.target].name}s: ${r.left} h left (no extra parts).`) : warn("Can't continue the research", r.why);
        }
        else { openResearch(m, a); return; }
      }
      else if (m.type === 'greenhouse' && a) {
        if (a.role !== 'botanist') warn('Only Botanists can work in the greenhouse', `Pick a Botanist. To turn the greenhouse on or off, press Esc so nobody is picked, then click it.`);
        else {
          const r = MT.Sim.tendGreenhouse(state, m.id, a.id);
          r.ok ? info(`🌱 ${a.name} is ${r.resumed ? 'back in' : 'tending'} the greenhouse`, `${C.botany.mult}x food for ${r.resumed ? `the ${r.left} hours that were left` : '1 day'}.`) : warn("Can't use the greenhouse", r.why);
        }
      }
      else if (m.type === 'gym' && a) { const r = MT.Sim.sendToGym(state, m.id, a.id); r.ok ? info(`🏋️ ${a.name} is going to train`, `${C.astro.bone.visitH} hours in the Fitness Center.`) : warn("Can't use the Fitness Center", r.why); }
      else MT.Sim.toggle(state, m.id);
    }
    refresh();
    ui.tooltip(state, t, !ui.selected);
  }

  window.addEventListener('keydown', (e) => {
    if (ui.isModalOpen() || !state) return;
    const crewKey = e.shiftKey && /^Digit[1-9]$/.test(e.code) ? +e.code.slice(5) : 0;
    if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : lastSpeed); }
    else if (e.key === 'Escape') { if (ui.selected) ui.select(null); else ui.selectCrew(null); }
    else if (crewKey) ui.selectCrew(ui.selectedCrew === crewKey ? null : crewKey); // Shift+1..9 = pick astronaut 1..9


    else if (e.key === 'h' || e.key === 'H') renderer.centerOnBase(state, true);
    else if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey) { renderer.toggleView(); hover = null; }
    else if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey) renderer.zoomAt(null, e.key === '-' || e.key === '_' ? 1 / 1.25 : 1.25);
    else if (/^[1-9]$/.test(e.key) && +e.key <= MT.CONFIG.buildOrder.length) ui.pickBuild(MT.CONFIG.buildOrder[+e.key - 1]);
    else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const panel = { s: 'supplies', b: 'build', a: 'ams', w: 'why', c: 'capcom', l: 'log' }[e.key.toLowerCase()];
      if (panel) ui.togglePanel(panel);
    }
  });

  // Astronomy Tower: one picked astronaut visits (only THEIR stress goes down). The mission pauses while
  // the player looks at the picture. Visit 1 of the mission shows today's NASA picture; every later visit
  // (any tower) shows a different random picture from the archive.
  function openTower(m, a) {
    const r = MT.Sim.useTower(state, m.id, a.id);
    if (!r.ok) { warn("Can't use the Astronomy Tower", r.why); refresh(); return; }
    const calm = Math.round(r.relief) < 1;
    ui.capcom({ level: 'good', title: `🔭 ${a.name} visits the Astronomy Tower` + (calm ? '' : `: stress -${Math.round(r.relief)}`),
      text: (calm ? `${a.name} wasn't stressed, but enjoyed the view.` : `Only ${a.name}'s stress goes down.`) + ` This tower can be used again in ${MT.CONFIG.astro.stress.towerCooldownH} hours.` });
    refresh();
    const resume = speed; // stays paused if the player had paused
    setSpeed(0);
    ui.tooltip(state, null, false);
    try {
      ui.showTower({ archive: r.visit > 1, key: state.seed + ':visit' + r.visit }, () => setSpeed(resume));
    } catch (err) {
      // Never leave the mission frozen. (Usually an old cached script: press Ctrl+F5.)
      console.error('Astronomy Tower failed to open:', err);
      setSpeed(resume);
      ui.capcom({ level: 'warn', title: 'Astronomy Tower error', text: 'The picture viewer could not open. Try reloading the page with Ctrl+F5.' });
    }
  }

  // Research Bay: the picked Scientist chooses an upgrade (the mission waits while the choice is open).
  function openResearch(m, a) {
    const resume = speed;
    setSpeed(0);
    ui.tooltip(state, null, false);
    ui.showResearch(state, a, (target) => {
      setSpeed(resume);
      if (!target) return;
      const r = MT.Sim.startResearch(state, m.id, a.id, target);
      if (r.ok) ui.capcom({ level: 'info', title: `🔬 ${a.name} is researching faster ${MT.CONFIG.modules[target].name}s`, text: `${r.cost} parts, 1 day of work. Sending the crew to the shelter puts it on hold.` });

      else warn("Can't start research", r.why);
      refresh();
    });
  }


  menu();
  requestAnimationFrame(frame);
})();
