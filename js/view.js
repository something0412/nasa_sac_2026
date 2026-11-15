// Map view switch: top-down (render.js) or isometric 2.5D (render_iso.js).
// Gives main.js ONE renderer object with the usual functions (draw, tileAt, ...) and sends each call to
// whichever view is showing. Press V (or the 🧊 button) to switch. The player's choice is remembered.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const DEFAULT_VIEW = 'top'; // change to 'iso' to make the 2.5D view the default for new players
  const STORE_KEY = 'lunar-world.view';
  // Settings used to be stored as 'mt.view' (old name of the game); move them over once.
  try { if (localStorage.getItem(STORE_KEY) === null && localStorage.getItem('mt.view') !== null) { localStorage.setItem(STORE_KEY, localStorage.getItem('mt.view')); localStorage.removeItem('mt.view'); } } catch (e) { /* storage blocked: fine */ }

  function ViewSwitch(canvas, forecastCanvas) {
    // One shared set of astronaut positions for both views, moved every frame (whichever view is showing).
    const motion = LW.CrewMotion();
    const views = { top: LW.Renderer(canvas, forecastCanvas, motion), iso: LW.IsoRenderer(canvas, motion) };
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
      const run = () => { for (const k in views) if (k !== name) views[k].prepare(lastState); };
      if (root.requestIdleCallback) root.requestIdleCallback(run, { timeout: 3000 }); else setTimeout(run, 500);
    }

    function set(next) {
      if (!views[next] || next === name) return;
      name = next;
      try { root.localStorage.setItem(STORE_KEY, name); } catch (e) { /* not saved: fine */ }
      if (lastState) cur().centerOnBase(lastState, false); // open the new view looking at the base
      listeners.forEach((fn) => fn(name));
    }

    return {
      draw: (state, dt, ui) => { lastState = state; motion.update(state, dt, ui && ui.paused); cur().draw(state, dt, ui); prepareOther(); },
      drawForecast: (state) => views.top.drawForecast(state), // the sunlight strip is the same in both views
      tileAt: (e) => cur().tileAt(e),
      toCanvas: (e) => cur().toCanvas(e),
      hitTag: (e) => cur().hitTag(e),
      crewAt: (e) => (cur().crewAt ? cur().crewAt(e) : null), // the astronaut under the mouse (click to pick them)
      centerOnBase: (state, smooth) => cur().centerOnBase(state, smooth),
      centerOnTile: (c, r, smooth) => cur().centerOnTile(c, r, smooth),
      screenOf: (c, r) => cur().screenOf(c, r), // grid point → pixels on the map (for the landing animation)
      panStart: () => cur().panStart(),
      panTo: (x, y) => cur().panTo(x, y),
      zoomAt: (e, factor) => { if (cur().zoomAt) cur().zoomAt(e, factor); },
      canZoom: () => !!cur().zoomAt,
      debug: () => ({ view: name, ...cur().debug() }),
      reset: (...a) => { motion.reset(); both('reset')(...a); },
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
