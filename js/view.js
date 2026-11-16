// Written with help from Claude Code (AI); reviewed and tested by the team.
// Map view switch: top-down (render.js) or isometric 2.5D (render_iso.js).
// Gives main.js ONE renderer object with the usual functions (draw, tileAt, ...) and sends each call to
// whichever view is showing. Press V (or the 🧊 button) to switch. The player's choice is remembered.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const DEFAULT_VIEW = 'iso'; // the 2.5D view is the default; 'top' would make the top-down view the default
  // The player's choice is remembered under STORE_KEY. The 2.5D view became the default when this key was
  // introduced, so choices saved under the older keys are dropped once and everybody starts in 2.5D.
  const STORE_KEY = 'lunar-world.view2';
  try { for (const old of ['lunar-world.view', 'mt.view']) localStorage.removeItem(old); } catch (e) { /* storage blocked: fine */ }

  function ViewSwitch(canvas, forecastCanvas) {
    // One shared set of astronaut positions for both views, moved every frame (whichever view is showing).
    const motion = LW.CrewMotion();
    const views = { top: LW.Renderer(canvas, forecastCanvas, motion), iso: LW.IsoRenderer(canvas, motion) };
    // The crew spaceship landing: one clock for both views, so it keeps going through a view switch.
    // Each frame, the view on screen gets ui.ship and draws the ship on its Landing Pad (in map coordinates,
    // so it lands on the pad wherever the camera is).
    const landing = LW.ShipLanding();
    let name = DEFAULT_VIEW;
    try { const saved = root.localStorage.getItem(STORE_KEY); if (views[saved]) name = saved; } catch (e) { /* storage blocked: use default */ }
    let lastState = null;
    const listeners = [];
    const cur = () => views[name];
    const both = (fn) => (...args) => { views.top[fn](...args); views.iso[fn](...args); };

    // Paint the hidden view's ground picture once, when the browser is not busy, so the first switch is instant.
    let prepared = false;
    function prepareOther() {
      if (prepared || !lastState) return;
      prepared = true;
      // A few milliseconds per slice, so the game never freezes (the 2.5D terraces take ~0.4 s in total).
      const later = (fn) => (root.requestIdleCallback ? root.requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 50));
      const run = (deadline) => {
        const budget = deadline && deadline.timeRemaining ? Math.max(4, Math.min(12, deadline.timeRemaining())) : 8;
        let done = true;
        for (const k in views) {
          if (k === name) continue; // the view on screen already has its ground
          const v = views[k];
          done = (v.prepareStep ? v.prepareStep(lastState, budget) : (v.prepare(lastState), true)) && done;
        }
        if (!done) later(run);
      };
      later(run);
    }

    function set(next) {
      if (!views[next] || next === name) return;
      name = next;
      try { root.localStorage.setItem(STORE_KEY, name); } catch (e) { /* not saved: fine */ }
      if (lastState) cur().centerOnBase(lastState, false); // open the new view looking at the base
      listeners.forEach((fn) => fn(name));
    }

    return {
      draw: (state, dt, ui) => {
        ui = ui || {};
        lastState = state;
        motion.update(state, dt, ui.paused, ui.frac);
        ui.ship = landing.update(dt);
        cur().draw(state, dt, ui);
        prepareOther();
      },
      /** The crew spaceship touches down on Landing Pad `pad`; onDone runs once it has landed. */
      playLanding: (pad, text, onDone) => landing.play(pad, text, onDone),
      prepare: (state) => cur().prepare(state), // paint the ground of the view on screen now (start-up)
      drawForecast: (state) => views.top.drawForecast(state), // the sunlight strip is the same in both views
      tileAt: (e) => cur().tileAt(e),
      toCanvas: (e) => cur().toCanvas(e),
      hitTag: (e) => cur().hitTag(e),
      crewAt: (e) => (cur().crewAt ? cur().crewAt(e) : null), // the astronaut under the mouse (click to pick them)
      centerOnBase: (state, smooth) => cur().centerOnBase(state, smooth),
      centerOnTile: (c, r, smooth) => cur().centerOnTile(c, r, smooth),
      screenOf: (c, r) => cur().screenOf(c, r), // grid point → pixels on the map
      panStart: () => cur().panStart(),
      panTo: (x, y) => cur().panTo(x, y),
      zoomAt: (e, factor) => { if (cur().zoomAt) cur().zoomAt(e, factor); },
      canZoom: () => !!cur().zoomAt,
      debug: () => ({ view: name, ...cur().debug() }),
      reset: (...a) => { motion.reset(); landing.clear(); both('reset')(...a); },
      resize: both('resize'),
      setSafeArea: both('setSafeArea'),
      view: () => name,
      crewPos: (id) => motion.get(id), // where an astronaut is on the map (grid squares), for debugging
      setView: set,
      toggleView: () => set(name === 'top' ? 'iso' : 'top'),
      onViewChange: (fn) => { listeners.push(fn); fn(name); },
    };
  }

  LW.ViewSwitch = ViewSwitch;
})(window);
