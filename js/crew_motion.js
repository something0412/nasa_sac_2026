// Written with help from Claude Code (AI); reviewed and tested by the team.
// Where each astronaut is walking on the map, shared by BOTH views (top-down and 2.5D).
// Positions are in grid squares (c, r). js/view.js updates this once per frame, whichever view is
// showing, so switching views never makes an astronaut start walking again from an old spot.
// This is only animation: the game rules (sim.js) decide WHERE an astronaut is ("outside", "gym", ...),
// this file only moves their picture there smoothly.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const SPEED = 3.5; // grid squares per second (= 140 px/s on the top-down map)
  const BUILD_STAND = 0.2; // a builder stands this far out from the building's right-hand wall (grid squares)
  const AT_SPOT = 0.075;   // closer than this to their spot = arrived (starts the mallet swing)

  function CrewMotion() {
    let pos = {}; // astronaut id -> { c, r, dir, face, walk, dist, visible, active, init }
    let time = 0;
    let workTime = 0; // mallet swing clock: runs only while the game runs (frozen when paused)

    const mid = (m) => ({ c: m.c + m.w / 2, r: m.r + m.h / 2 });

    /** Where astronaut A should stand right now, in grid squares. visible = they are outside a building. */
    function target(state, A, jobs, shelters) {
      const i = A.id - 1; // keyed by id, so someone leaving never moves the others' spots
      const home = mid(LW.Sim.homeOf(state, A)); // their own HAB
      let c = home.c + Math.cos(i * 1.57 + 0.8) * 0.22, r = home.r + Math.sin(i * 1.57 + 0.8) * 0.22;
      let visible = false, job = null;
      const dist = (s) => Math.hypot(mid(s).c - home.c, mid(s).r - home.r);
      const shelter = shelters.reduce((b, s) => (!b || dist(s) < dist(b) ? s : b), null); // the shelter closest to their HAB
      if (A.where === 'shelter' && shelter) {
        const s = mid(shelter); c = s.c - 0.2 + (i % 4) * 0.15; r = s.r + 0.4; visible = true;
      } else if (A.where === 'gym') {
        const g = state.modules.find((m) => m.id === A.gymId);
        if (g) { const gc = mid(g); c = gc.c + 0.3; r = gc.r + 0.3; visible = true; }
      } else if (A.task && A.where === A.task.kind) { // Research Bay, greenhouse or Astronomy Tower
        const tm = state.modules.find((m) => m.id === A.task.id);
        if (tm) { const g = mid(tm); c = g.c + 0.38 + Math.sin(time * 1.5 + i) * 0.04; r = g.r + 0.38; visible = true; }
      } else if (A.where === 'outside') {
        const j = jobs.find((x) => x.key === A.job);
        const bc = j && j.m ? mid(j.m) : home; // moon-dirt shield: walk around that HAB
        const jc = j && j.m && j.kind !== 'berm' ? mid(j.m)
          : { c: bc.c + Math.cos(time * 0.4 + i * 3) * 1.05, r: bc.r + Math.sin(time * 0.4 + i * 3) * 1.05 };
        c = jc.c + 0.38 + Math.sin(time * 3 + i) * 0.07; r = jc.r + 0.38; visible = true;
        // New building: stand at its right-hand wall, middle of the side, to hammer on it (Gerardo's mallet).
        if (j && j.kind === 'module') { c = j.m.c + j.m.w + BUILD_STAND; r = j.m.r + j.m.h / 2; job = j; }
      }
      return { c, r, visible, job };
    }

    /** Move everyone one frame toward where they should be. Call once per frame.
     *  frac = how far into the current game hour the clock is (for Engineers walking to a job, see below). */
    function update(state, dt, paused, frac) {
      time += dt;
      if (!paused && state.status === 'running') workTime += dt;
      const jobs = LW.Sim.jobList(state), shelters = LW.Sim.built(state, 'shelter');
      for (const k in pos) pos[k].active = false; // astronauts sent home to Earth are no longer in state.crew
      for (const A of state.crew) {
        const p = pos[A.id] || (pos[A.id] = { c: 0, r: 0, dir: -Math.PI / 2, face: -1, walk: 0, dist: 0, visible: false, init: false });
        p.active = true;
        if (A.trip) { p.init = false; p.visible = false; p.dist = 0; p.building = null; continue; } // inside the rover: appear at the new HAB
        const t = target(state, A, jobs, shelters);
        // An Engineer on the way to a job: the game rules time the walk (sim.js: the work only starts once they
        // get there), so draw them exactly where the rules say, at any game speed, ending at their work spot.
        // (Without the game clock, frac is undefined: then they just walk there at the normal speed.)
        const wp = frac != null && A.where === 'outside' && LW.Sim.walkPoint ? LW.Sim.walkPoint(state, A, frac) : null;
        if (wp) {
          const key = A.walk.key + '@' + A.walk.startH; // a new walk: it starts from where they are drawn (no jump)
          if (p.walkKey !== key) { p.walkKey = key; p.walkFrom = p.init ? { c: p.c, r: p.r } : { c: wp.from.c, r: wp.from.r }; }
          const f0 = p.walkFrom, mc = t.c - f0.c, mr = t.r - f0.r;
          p.c = f0.c + mc * wp.p; p.r = f0.r + mr * wp.p; p.init = true;
          p.dir = Math.atan2(mr, mc);
          if (Math.abs(mc - mr) > Math.hypot(mc, mr) * 0.1) p.face = mc - mr > 0 ? 1 : -1;
          p.walk = Math.min(1, p.walk + dt * 6); p.dist = Math.hypot(t.c - p.c, t.r - p.r); p.visible = true; p.building = null;
          continue;
        }
        if (!p.init) { p.c = t.c; p.r = t.r; p.init = true; }
        const dc = t.c - p.c, dr = t.r - p.r, d = Math.hypot(dc, dr), step = SPEED * dt;
        const moving = d > step;
        if (moving) {
          p.c += (dc / d) * step; p.r += (dr / d) * step;
          p.dir = Math.atan2(dr, dc); // top-down: the way the visor faces
          if (Math.abs(dc - dr) > d * 0.1) p.face = dc - dr > 0 ? 1 : -1; // 2.5D: on screen x grows with c - r
        } else { p.c = t.c; p.r = t.r; }
        p.walk = Math.max(0, Math.min(1, p.walk + (moving ? dt : -dt) * 6)); // 0..1: eases the 2.5D hop in and out
        p.dist = moving ? d : 0;
        p.visible = t.visible;
        // Hammering: arrived at the wall of a building site that is being worked on this hour.
        const left = Math.hypot(t.c - p.c, t.r - p.r);
        p.building = state.status === 'running' && t.job && t.job.active && left < AT_SPOT ? t.job.m.id : null;
      }
    }

    return {
      update,
      get: (id) => (pos[id] && pos[id].active && pos[id].init ? pos[id] : null),
      reset: () => { pos = {}; workTime = 0; },
      workTime: () => workTime,
    };
  }

  LW.CrewMotion = CrewMotion;
})(typeof window !== 'undefined' ? window : globalThis);
