// Drawing the map. Runs every frame (60 fps). Reads the sim state, never changes it.
// The world is bigger than the screen: a camera (cam.x, cam.y = top-left corner in world pixels)
// picks which part we see. Drag the map to move the camera.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  const POOL_SIZE = 420;
  const METERS_PER_TILE = 10; // for the "base is 120 m away" tag

  function Renderer(canvas, forecastCanvas) {
    const C = MT.CONFIG, T = C.map.tile;
    const W = C.map.cols * T, H = C.map.rows * T; // world size
    let VW = C.map.viewCols * T, VH = C.map.viewRows * T, DPR = 1; // what the camera shows (CSS pixels)
    // ZOOM: 1 = normal, 2 = everything twice as big. The camera then sees VW / zoom world pixels across.
    const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;
    let zoom = 1;
    const vw = () => VW / zoom, vh = () => VH / zoom; // how much of the world fits on screen
    const safe = { left: 0, right: 0, top: 0, bottom: 0 }; // screen edges covered by open panels
    const ctx = canvas.getContext('2d');
    const fctx = forecastCanvas.getContext('2d');

    let ground = null, zonePaths = null;
    let crew = {}; // astronaut id -> where their dot is drawn (world pixels), also used to click on them
    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 0, color: '' });
    let time = 0, dashOffset = 0, frac = 0;
    const cam = { x: 0, y: 0, tx: 0, ty: 0, flying: false };
    let tagRect = null; // where the "back to base" tag was drawn (canvas pixels), for clicks

    // ---------- screen size ----------
    // The canvas fills the window. We draw in CSS pixels and scale by the device pixel ratio so it stays sharp.
    function resize(cssW, cssH) {
      // keep the same spot of the Moon in the middle of the screen when the window changes size
      const midX = cam.x + vw() / 2, midY = cam.y + vh() / 2;
      VW = Math.max(200, Math.round(cssW)); VH = Math.max(200, Math.round(cssH));
      cam.x = midX - vw() / 2; cam.y = midY - vh() / 2;
      DPR = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(VW * DPR); canvas.height = Math.round(VH * DPR);
      moveTo(cam.x, cam.y);
    }
    function setSafeArea(a) { Object.assign(safe, a); }

    // ---------- camera ----------
    const clampX = (x) => (W <= vw() ? (W - vw()) / 2 : Math.max(0, Math.min(W - vw(), x))); // centre the world if the screen is bigger
    const clampY = (y) => (H <= vh() ? (H - vh()) / 2 : Math.max(0, Math.min(H - vh(), y)));
    function moveTo(x, y) { cam.x = clampX(x); cam.y = clampY(y); cam.flying = false; }
    function flyTo(x, y) { cam.tx = clampX(x); cam.ty = clampY(y); cam.flying = true; }
    // Centre a world point in the part of the screen that is NOT covered by panels.
    function centerOn(wx, wy, smooth) {
      const sx = (safe.left + VW - safe.right) / 2, sy = (safe.top + VH - safe.bottom) / 2; // screen pixels
      (smooth ? flyTo : moveTo)(wx - sx / zoom, wy - sy / zoom);
    }
    // Zoom in (factor > 1) or out (factor < 1), keeping the spot under the mouse in the same place.
    function zoomAt(evt, factor) {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
      if (next === zoom) return;
      const p = evt ? toCanvas(evt) : { x: VW / 2, y: VH / 2 };
      const wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // world point under the mouse
      zoom = next;
      moveTo(wx - p.x / zoom, wy - p.y / zoom);
    }
    /** Look at a grid point (c, r can be fractions). */
    function centerOnTile(c, r, smooth) { centerOn(c * T, r * T, smooth); }
    /** Where a grid point is on the screen right now (pixels from the map's top-left corner). */
    function screenOf(c, r) { return { x: (c * T - cam.x) * zoom, y: (r * T - cam.y) * zoom }; }
    function centerOnBase(state, smooth) {
      const hab = state.modules.find((m) => m.type === 'hab');
      centerOn((hab.c + hab.w / 2) * T, (hab.r + hab.h / 2) * T, smooth);
    }

    // Mouse position → canvas pixels (the canvas is scaled by CSS) → world tile.
    function toCanvas(evt) {
      const rect = canvas.getBoundingClientRect();
      return { x: ((evt.clientX - rect.left) / rect.width) * VW, y: ((evt.clientY - rect.top) / rect.height) * VH, px: evt.clientX - rect.left, py: evt.clientY - rect.top, scale: VW / rect.width / zoom }; // scale: mouse pixels → world pixels (for dragging)
    }
    function tileAt(evt) {
      const p = toCanvas(evt);
      return { c: Math.floor((cam.x + p.x / zoom) / T), r: Math.floor((cam.y + p.y / zoom) / T), px: p.px, py: p.py };
    }
    function hitTag(evt) {
      if (!tagRect) return false;
      const p = toCanvas(evt);
      const pad = 12; // easier to hit than the drawn tag
      return p.x >= tagRect.x - pad && p.x <= tagRect.x + tagRect.w + pad && p.y >= tagRect.y - pad && p.y <= tagRect.y + tagRect.h + pad;
    }

    // ---------- static ground, drawn once ----------
    function buildGround(state) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const g = off.getContext('2d');
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      zonePaths = { ridge: new Path2D(), plain: new Path2D(), ice: new Path2D() };
      for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) {
        zonePaths[MT.Sim.zoneOf(state, c, r)].rect(c * T, r * T, T, T);
      }
      for (const z of ['plain', 'ridge', 'ice']) { g.fillStyle = C.zones[z].color; g.fill(zonePaths[z]); }
      const area = (W * H) / (800 * 560);
      for (let i = 0; i < 2600 * area; i++) {
        const x = rand() * W, y = rand() * H, s = rand() * 2 + 0.5;
        g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        g.fillRect(x, y, s, s);
      }
      for (let i = 0; i < 46 * area; i++) {
        const x = rand() * W, y = rand() * H, r = 4 + rand() ** 2 * 30;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.13)'; g.fill();
        g.beginPath(); g.arc(x - r * 0.15, y - r * 0.15, r * 0.85, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.08)'; g.fill();
        g.beginPath(); g.arc(x, y, r, Math.PI * 0.1, Math.PI * 0.9);
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1.5; g.stroke();
      }
      g.save(); g.clip(zonePaths.ice);
      for (let i = 0; i < 260 * area; i++) {
        g.fillStyle = `rgba(170,210,255,${0.15 + rand() * 0.35})`;
        g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
      }
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.stroke(zonePaths.ridge);
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1;
      for (let c = 0; c <= C.map.cols; c++) { g.beginPath(); g.moveTo(c * T + 0.5, 0); g.lineTo(c * T + 0.5, H); g.stroke(); }
      for (let r = 0; r <= C.map.rows; r++) { g.beginPath(); g.moveTo(0, r * T + 0.5); g.lineTo(W, r * T + 0.5); g.stroke(); }
      g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'center';
      for (const f of C.features) {
        g.fillStyle = f.zone === 'ice' ? 'rgba(170,210,255,0.75)' : 'rgba(255,255,255,0.6)';
        g.fillText(f.label, f.u * W, f.v * H);
      }
      ground = off;
      crew = {};
    }

    // ---------- particles (object pool, no new objects per frame) ----------
    function spawn(kind, x, y, vx, vy, life, color) {
      for (const p of pool) if (!p.alive) { p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = 0; p.max = life; p.color = color; return p; }
      return null;
    }

    const center = (m) => ({ x: (m.c + m.w / 2) * T, y: (m.r + m.h / 2) * T });
    // Direction the sunlight comes FROM (unit vector, screen coords). Smooth between game hours.
    const sunVec = (state) => {
      const a = (MT.Sim.sunAz(state, state.hour + frac) * Math.PI) / 180;
      return { x: Math.cos(a), y: Math.sin(a) };
    };
    const lightAt = (state, m) => MT.Sim.zoneLight(state, MT.Sim.zoneOf(state, m.c, m.r), state.hour + frac);

    function hull(pts) {
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

    // ---------- module sprites ----------
    function drawModule(state, m, blink) {
      const x = m.c * T, y = m.r * T, w = m.w * T, h = m.h * T, cx = x + w / 2, cy = y + h / 2;
      const on = m.built && m.on && m.powered;
      ctx.save();
      if (!m.built) ctx.globalAlpha = 0.45;
      switch (m.type) {
        case 'hab': {
          const BM = m.berm || { built: false, building: false }; // each HAB has its own moon-dirt shield
          if (BM.built || BM.building) {
            const f = BM.built ? 1 : BM.progress / C.bermWork;
            ctx.beginPath(); ctx.arc(cx, cy, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
            ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 9; ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(cx, cy, 31, 0, Math.PI * 2);
          ctx.fillStyle = '#d9dde4'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#8f96a3'; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.strokeStyle = '#aab1bd'; ctx.stroke();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + 0.3;
            ctx.fillStyle = on ? ((m.temp != null ? m.temp : state.habTemp) < 15 ? '#7fb4ff' : '#ffd36b') : '#39404b';
            ctx.fillRect(cx + Math.cos(a) * 25 - 3, cy + Math.sin(a) * 25 - 3, 6, 6);
          }
          ctx.fillStyle = '#5b6576'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
          ctx.fillText(MT.Sim.habs(state).length > 1 && m.built ? MT.Sim.habName(state, m) : 'HAB', cx, cy + 4);
          break;
        }
        case 'solar': {
          const L = lightAt(state, m);
          ctx.fillStyle = '#555'; ctx.fillRect(cx - 3, cy - 3, 6, 6);
          const s = sunVec(state);
          ctx.translate(cx, cy); ctx.rotate(Math.atan2(s.y, s.x) + Math.PI / 2); // panel turns to face the Sun
          ctx.fillStyle = rgb(mix([29, 44, 72], [47, 111, 214], L));
          ctx.fillRect(-16, -5, 32, 10);
          ctx.strokeStyle = rgb(mix([58, 74, 102], [156, 195, 255], L)); ctx.lineWidth = 1;
          for (let i = -16; i <= 16; i += 8) { ctx.beginPath(); ctx.moveTo(i, -5); ctx.lineTo(i, 5); ctx.stroke(); }
          ctx.strokeRect(-16, -5, 32, 10);
          if (L > 0.3 && m.built && m.on) { ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.25 * Math.sin(time * 3 + m.id)) * L})`; ctx.fillRect(-16, -5, 8, 10); }
          break;
        }
        case 'battery': {
          const cap = MT.Sim.batteryCap(state) || 1;
          const f = state.res.battery / cap;
          ctx.fillStyle = '#2a2f38'; ctx.fillRect(x + 8, y + 7, 24, 28);
          ctx.fillStyle = '#596273'; ctx.fillRect(x + 15, y + 4, 10, 4);
          ctx.fillStyle = f < 0.2 ? '#ff5d5d' : f < 0.5 ? '#ffc04d' : '#5fe08a';
          if (m.built) ctx.fillRect(x + 11, y + 32 - 22 * f, 18, 22 * f);
          ctx.strokeStyle = '#8a93a3'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 8, y + 7, 24, 28);
          break;
        }
        case 'o2gen': {
          ctx.fillStyle = '#c9d3df'; ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = on && !m.noWater ? '#58c4ff' : '#59636f';
          ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('O₂', cx, cy + 4);
          if (on && !m.noWater && Math.random() < 0.15) spawn(2, cx + (Math.random() - 0.5) * 12, cy - 8, 0, -12, 1.2, '#9fe0ff');
          break;
        }
        case 'greenhouse': {
          ctx.fillStyle = on ? 'rgba(255,120,220,0.25)' : 'rgba(80,90,100,0.4)';
          ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
          ctx.strokeStyle = on ? '#ff9de8' : '#6b7480'; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            ctx.fillStyle = on ? '#4fdc6a' : '#3c6b45';
            ctx.beginPath(); ctx.arc(x + 11 + i * 9, y + 11 + j * 9, on ? 3.3 + Math.sin(time * 2 + i + j) * 0.4 : 2.4, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'drill': {
          ctx.strokeStyle = '#e0b860'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(cx, y + 6); ctx.lineTo(x + 7, y + 34); ctx.moveTo(cx, y + 6); ctx.lineTo(x + 33, y + 34); ctx.stroke();
          ctx.translate(cx, cy + 6); ctx.rotate(on ? time * 8 : 0);
          ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.stroke();
          if (on && Math.random() < 0.25) spawn(1, cx, cy + 10, (Math.random() - 0.5) * 30, -Math.random() * 15, 0.9, 'rgba(190,220,255,0.8)');
          break;
        }
        case 'shelter': {
          ctx.fillStyle = '#8a7558'; ctx.beginPath(); ctx.ellipse(cx, cy + 4, 17, 13, 0, Math.PI, 0); ctx.lineTo(cx + 17, cy + 10); ctx.lineTo(cx - 17, cy + 10); ctx.fill();
          ctx.fillStyle = '#2b2b2b'; ctx.fillRect(cx - 4, cy + 1, 8, 9);
          ctx.strokeStyle = '#b39a77'; ctx.lineWidth = 1.5; ctx.stroke();
          if (state.sheltering) { ctx.fillStyle = '#7dff9a'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('CREW', cx, y + 7); }
          break;
        }
        case 'gym': {
          // Floor mat with a dumbbell. It bounces when someone is training.
          const training = state.crew.some((a) => a.where === 'gym' && a.gymId === m.id);
          ctx.fillStyle = '#2f3a4c'; ctx.beginPath(); ctx.roundRect(x + 5, y + 7, w - 10, h - 14, 6); ctx.fill();
          ctx.strokeStyle = on && !m.damaged ? '#7fb4ff' : '#59636f'; ctx.lineWidth = 1.5; ctx.stroke();
          const lift = training ? Math.abs(Math.sin(time * 4)) * 5 : 0;
          ctx.translate(cx, cy + 2 - lift);
          ctx.fillStyle = '#c9d3df'; ctx.fillRect(-9, -1.5, 18, 3);
          ctx.fillStyle = training ? '#ffd36b' : '#8a93a3';
          ctx.fillRect(-13, -6, 4, 12); ctx.fillRect(9, -6, 4, 12);
          break;
        }
        case 'tower': {
          // Square base, white observatory dome with an open slit, and a telescope that slowly sweeps the sky.
          ctx.fillStyle = '#4b5361'; ctx.fillRect(x + 9, cy + 2, w - 18, 14);
          ctx.strokeStyle = '#6f7888'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 9, cy + 2, w - 18, 14);
          ctx.fillStyle = '#e4e8ee'; ctx.beginPath(); ctx.arc(cx, cy + 2, 12, Math.PI, 0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#9aa2af'; ctx.stroke();
          const sweep = m.built ? Math.sin(time * 0.6 + m.id) * 0.5 : 0;
          ctx.save(); ctx.translate(cx, cy - 2); ctx.rotate(sweep);
          ctx.fillStyle = '#1b2230'; ctx.fillRect(-2.5, -10, 5, 10); // slit
          ctx.fillStyle = '#ffd36b'; ctx.fillRect(-1.5, -15, 3, 7); // telescope tube
          ctx.restore();
          if (m.built && blink && !MT.Sim.towerReadyIn(state, m)) { ctx.fillStyle = '#7fb4ff'; ctx.beginPath(); ctx.arc(x + w - 8, y + 8, 2.2, 0, Math.PI * 2); ctx.fill(); } // ready to use
          break;
        }
        case 'pad': {
          // Landing Pad: round platform with an "H" and corner lights (blinking = ready for a spaceship).
          const ready = m.built && MT.Sim.landingSpots(state).some((sp) => sp.pad === m);
          ctx.fillStyle = '#5d5f66'; ctx.beginPath(); ctx.arc(cx, cy, 34, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 2; ctx.stroke();
          ctx.strokeStyle = '#d9dde4'; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 24px system-ui'; ctx.textAlign = 'center'; ctx.fillText('H', cx, cy + 8);
          for (let k = 0; k < 4; k++) {
            const a = Math.PI / 4 + (k * Math.PI) / 2;
            ctx.fillStyle = ready ? (blink ? '#5fe08a' : '#2e6b43') : '#59636f';
            ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 31, cy + Math.sin(a) * 31, 2.5, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'lab': {
          // Low lab module with a round window; a flask glows (and bubbles) while the Scientist is researching.
          const busy = state.crew.some((a) => !a.medbay && a.task && a.task.kind === 'lab' && a.task.id === m.id);
          ctx.fillStyle = '#cfd6e0'; ctx.beginPath(); ctx.roundRect(x + 6, y + 10, w - 12, h - 18, 5); ctx.fill();
          ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = '#26303f'; ctx.beginPath(); ctx.arc(x + 14, cy + 1, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = busy ? '#6fd3ff' : '#4d5868';
          ctx.beginPath(); ctx.moveTo(cx + 3, cy - 5); ctx.lineTo(cx + 7, cy - 5); ctx.lineTo(cx + 7, cy - 1); ctx.lineTo(cx + 11, cy + 7); ctx.lineTo(cx - 1, cy + 7); ctx.lineTo(cx + 3, cy - 1); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#9aa2af'; ctx.fillRect(cx - 6, y + 4, 2, 7); // antenna
          if (busy && Math.random() < 0.12) spawn(2, cx + 5 + (Math.random() - 0.5) * 6, cy - 6, 0, -14, 1, '#bdf0ff');
          break;
        }
      }
      ctx.restore();

      // Research boost: small "2x" badge on machines that get an upgrade (close enough to a Research Bay).
      if (m.built && C.research.targets.includes(m.type)) {
        const b = MT.Sim.boostOf(state, m);
        if (b > 1) {
          ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(x + 2, y + 2, 20, 11, 3); ctx.fill();
          ctx.fillStyle = '#6fd3ff'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(b + 'x', x + 12, y + 10.5);
        }
      }
      // Moondust on a solar panel (accident): brown speckles.
      if (m.built && m.type === 'solar' && m.dustLeft > 0) {
        ctx.fillStyle = 'rgba(140,110,70,0.45)'; ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
        ctx.fillStyle = 'rgba(190,160,110,0.9)';
        for (let i = 0; i < 9; i++) ctx.fillRect(x + 6 + ((i * 13 + m.id * 7) % (w - 12)), y + 6 + ((i * 7 + m.id * 3) % (h - 12)), 2, 2);
      }

      if (!m.built) {
        const work = C.modules[m.type].work;
        ctx.strokeStyle = '#ffd36b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + 4, y + h - 8, w - 8, 5);
        ctx.fillStyle = '#ffd36b'; ctx.fillRect(x + 4, y + h - 8, (w - 8) * (m.progress / work), 5);
      } else if (!m.on) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ccc'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('OFF', x + w / 2, y + h / 2 + 4);
      } else if (MT.Sim.needOf(state, m) > 0 && m.type !== 'solar' && !m.powered) {
        ctx.fillStyle = 'rgba(40,0,0,0.45)'; ctx.fillRect(x, y, w, h);
        if (blink) { ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('⚡', x + w - 9, y + 15); }
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      } else if (m.noWater && blink) {
        ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('💧', x + w - 9, y + 14);
        ctx.strokeStyle = '#58c4ff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }

      // Damage from storms or meteors: cracks + wrench. A planned repair shows its progress.
      if (m.built && m.damaged) {
        ctx.save();
        ctx.fillStyle = 'rgba(60,20,0,0.35)'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,170,90,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x + 6, y + 9); ctx.lineTo(x + 15, y + 17); ctx.lineTo(x + 12, y + 24); ctx.lineTo(x + 21, y + 31);
        ctx.moveTo(x + w - 7, y + h - 8); ctx.lineTo(x + w - 14, y + h - 15); ctx.stroke();
        ctx.font = '13px system-ui'; ctx.textAlign = 'center';
        if (!m.repair && blink) ctx.fillText('🔧', x + w - 9, y + 13);
        if (m.repair) {
          ctx.fillText('🔧', x + w - 9, y + 13);
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + 4, y + h - 8, w - 8, 5);
          ctx.fillStyle = '#ff9f45'; ctx.fillRect(x + 4, y + h - 8, (w - 8) * (m.repair.progress / m.repair.work), 5);
        }
        ctx.restore();
      }
    }

    // ---------- meteor shower animation ----------
    // Meteors streak in from one direction (a shower's "radiant"), flash where they land and kick up dust.
    function spawnMeteors(dt) {
      const want = 9 * dt; // ~9 meteors per real second across the view
      let n = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
      while (n-- > 0) {
        const sp = 380 + Math.random() * 260;
        const vx = -0.78 * sp, vy = 0.62 * sp; // from the upper right, falling down-left
        const life = 0.55 + Math.random() * 0.9;
        // land somewhere in (or just around) the view
        const lx = cam.x - 40 + Math.random() * (vw() + 80), ly = cam.y - 20 + Math.random() * (vh() + 40);
        spawn(3, lx - vx * life, ly - vy * life, vx, vy, life, Math.random() < 0.25 ? '#ffd6a0' : '#f2f6ff');
      }
    }

    // ---------- "back to base" tag on the edge of the view ----------
    function drawBaseTag(hc) {
      const sx = (hc.x - cam.x) * zoom, sy = (hc.y - cam.y) * zoom; // base position on screen
      tagRect = null;
      const L = safe.left, R = VW - safe.right, Tp = safe.top, B = VH - safe.bottom; // visible map area
      if (sx > L + 30 && sx < R - 30 && sy > Tp + 30 && sy < B - 30) return; // base is visible
      const ox = (L + R) / 2, oy = (Tp + B) / 2, dx = sx - ox, dy = sy - oy;
      const mx = Math.max(10, (R - L) / 2 - 64), my = Math.max(10, (B - Tp) / 2 - 26);
      const t = Math.min(mx / Math.max(1e-6, Math.abs(dx)), my / Math.max(1e-6, Math.abs(dy)));
      const px = ox + dx * t, py = oy + dy * t;
      const ang = Math.atan2(dy, dx);
      const dist = Math.round((Math.hypot(sx - VW / 2, sy - VH / 2) / zoom / T) * METERS_PER_TILE / 10) * 10;
      const pulse = 0.75 + 0.25 * Math.sin(time * 4);
      ctx.save();
      ctx.translate(px + Math.cos(ang) * 46, py + Math.sin(ang) * 20);
      ctx.rotate(ang);
      ctx.fillStyle = `rgba(255,211,107,${pulse})`;
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -9); ctx.lineTo(-6, 9); ctx.closePath(); ctx.fill();
      ctx.restore();
      const w = 104, h = 36, x = px - w / 2, y = py - h / 2;
      ctx.fillStyle = 'rgba(12,16,26,0.9)';
      ctx.strokeStyle = `rgba(255,211,107,${pulse})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('🏠 BASE', px, py - 2);
      ctx.fillStyle = '#c9d1dc'; ctx.font = '10px system-ui';
      ctx.fillText(`${dist} m · click`, px, py + 12);
      tagRect = { x, y, w, h };
    }

    // ---------- main draw ----------
    function draw(state, dt, ui) {
      if (!ground) { buildGround(state); centerOnBase(state, false); }
      frac = ui.frac || 0;
      time += dt;
      dashOffset -= dt * 28;
      if (cam.flying) {
        const k = Math.min(1, dt * 6);
        cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k;
        if (Math.abs(cam.tx - cam.x) < 0.5 && Math.abs(cam.ty - cam.y) < 0.5) { cam.x = cam.tx; cam.y = cam.ty; cam.flying = false; }
      }
      const blink = Math.floor(time * 2.5) % 2 === 0;
      const habM = state.modules.find((m) => m.type === 'hab');
      const hc = center(habM);
      const habCs = MT.Sim.habs(state).map(center);
      const nearestHab = (p) => habCs.reduce((b, h) => (Math.hypot(h.x - p.x, h.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? h : b), hc);


      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = '#0b0e15'; ctx.fillRect(0, 0, VW, VH);
      const S = DPR * zoom; // world pixels → device pixels
      ctx.setTransform(S, 0, 0, S, -Math.round(cam.x * S), -Math.round(cam.y * S));
      const VWz = vw(), VHz = vh(); // the part of the world on screen, in world pixels
      // only copy the part of the ground image the camera can see
      const gx = Math.max(0, Math.floor(cam.x)), gy = Math.max(0, Math.floor(cam.y));
      const gw = Math.min(W - gx, Math.ceil(VWz) + 2), gh = Math.min(H - gy, Math.ceil(VHz) + 2);
      if (gw > 0 && gh > 0) ctx.drawImage(ground, gx, gy, gw, gh, gx, gy, gw, gh);

      // Terrain shadow: each zone gets darker as the Sun slides behind the hills (smooth, follows game time).
      // Only the tiles the camera can see are drawn, so a big map stays fast.
      const c0 = Math.max(0, Math.floor(cam.x / T)), c1 = Math.min(C.map.cols - 1, Math.floor((cam.x + VWz) / T));
      const r0 = Math.max(0, Math.floor(cam.y / T)), r1 = Math.min(C.map.rows - 1, Math.floor((cam.y + VHz) / T));
      const shadeOf = {
        ridge: 0.75 * (1 - MT.Sim.zoneLight(state, 'ridge', state.hour + frac)),
        plain: 0.75 * (1 - MT.Sim.zoneLight(state, 'plain', state.hour + frac)),
        ice: 0.35,
      };
      for (const z of ['ridge', 'plain', 'ice']) {
        if (shadeOf[z] < 0.005) continue;
        ctx.fillStyle = z === 'ice' ? 'rgba(5,8,25,0.35)' : `rgba(5,8,20,${shadeOf[z].toFixed(3)})`;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (MT.Sim.zoneOf(state, c, r) === z) ctx.fillRect(c * T, r * T, T, T);
        }
      }

      // Object shadows point AWAY from the Sun. The Sun is always low at the pole, so shadows are long;
      // as the Sun sinks behind a hill they stretch and fade out.
      const sv = sunVec(state);
      for (const m of state.modules) {
        if (!m.built || m.type === 'pad') continue; // (flat pads cast no shadow)
        const L = lightAt(state, m);
        if (L < 0.02) continue;
        const pad = m.type === 'hab' ? 10 : 8;
        const x0 = m.c * T + pad, y0 = m.r * T + pad, x1 = (m.c + m.w) * T - pad, y1 = (m.r + m.h) * T - pad;
        const len = (m.type === 'hab' ? 38 : m.type === 'solar' ? 32 : 18) * (1 + (1 - L) * 1.5);
        const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const hp = hull(pts.concat(pts.map(([px, py]) => [px - sv.x * len, py - sv.y * len])));
        ctx.fillStyle = `rgba(0,0,0,${(0.28 * L).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
        for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
        ctx.closePath(); ctx.fill();
      }

      // power cables: yellow moving dashes = power flowing, red = no power
      ctx.lineWidth = 2;
      for (const m of state.modules) {
        if (!m.built || m === habM) continue; // (extra HABs get a cable to HAB 1)
        const c = center(m);
        let color, flow = 0;
        if (m.type === 'solar') { const on = m.light > 0.02 && m.on; color = on ? '#ffd36b' : '#4a4f5a'; flow = on ? 1 : 0; }
        else if (m.type === 'battery') {
          const charging = state.power.supply > state.power.use;
          color = state.res.battery > 0.01 || charging ? '#7de0a0' : '#4a4f5a'; flow = charging ? 1 : state.res.battery > 0.01 ? -1 : 0;
        } else if (m.type === 'shelter' || !MT.Sim.needOf(state, m)) { color = m.type === 'shelter' ? '#6b5b45' : '#5a6170'; } // walkways, no power cable
        else { color = !m.on ? '#4a4f5a' : m.powered ? '#ffd36b' : '#ff5d5d'; flow = m.on && m.powered ? -1 : 0; }
        ctx.strokeStyle = color;
        ctx.setLineDash(flow ? [6, 6] : (m.type === 'shelter' || !MT.Sim.needOf(state, m)) ? [2, 4] : [3, 5]);
        ctx.lineDashOffset = flow * dashOffset;
        const to = m.type === 'hab' ? hc : nearestHab(c);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      for (const m of state.modules) drawModule(state, m, blink);

      // Research Bay reach (dashed circle): while placing one, hovering one, or with the Scientist picked.
      const picked = ui.selectedCrew ? state.crew.find((a) => a.id === ui.selectedCrew && !a.medbay) : null;
      const hoverM = ui.hover && !ui.buildType ? MT.Sim.moduleAt(state, ui.hover.c, ui.hover.r) : null;
      const rings = [];
      if (ui.buildType === 'lab' && ui.hover) rings.push({ x: (ui.hover.c + 0.5) * T, y: (ui.hover.r + 0.5) * T });
      for (const l of MT.Sim.built(state, 'lab')) {
        if ((picked && picked.role === 'scientist') || hoverM === l || (hoverM && C.research.targets.includes(hoverM.type))) rings.push({ ...center(l), dead: l.damaged });
      }
      // Placing a Landing Pad: gold circles show how close to a HAB it must be.
      if (ui.buildType === 'pad') {
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5; ctx.lineWidth = 2;
        for (const H of state.modules) if (H.type === 'hab') {
          const c = center(H);
          ctx.beginPath(); ctx.arc(c.x, c.y, C.pad.radius * T, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,211,107,0.06)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,211,107,0.8)'; ctx.stroke();
        }
        // Red circles: no new pad may go inside another pad's area.
        for (const P2 of state.modules) if (P2.type === 'pad') {
          const c = center(P2);
          ctx.beginPath(); ctx.arc(c.x, c.y, C.pad.radius * T, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,93,93,0.07)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,93,93,0.8)'; ctx.stroke();
        }
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      for (const g of rings) {
        ctx.beginPath(); ctx.arc(g.x, g.y, C.research.radius * T, 0, Math.PI * 2);
        ctx.fillStyle = g.dead ? 'rgba(255,93,93,0.04)' : 'rgba(111,211,255,0.06)'; ctx.fill();
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5;
        ctx.strokeStyle = g.dead ? 'rgba(255,93,93,0.6)' : 'rgba(111,211,255,0.75)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      // The picked Engineer's job sites get a dashed outline in their role colour.
      const jobs = MT.Sim.jobList(state);
      if (picked) {
        ctx.strokeStyle = C.astro.roleInfo[picked.role].color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        for (const j of jobs) if (j.assignee === picked.id) {
          const m = j.m || habM;
          ctx.strokeRect(m.c * T - 2, m.r * T - 2, m.w * T + 4, m.h * T + 4);
        }
        ctx.setLineDash([]);
      }

      drawRover(state);

      // astronauts: each one walks to where the AMS says they are (job site, gym, lab, greenhouse, tower, shelter or their HAB)
      const shelters = MT.Sim.built(state, 'shelter');
      const danger = state.stormRate > C.rad.stormOn || !!state.meteorOn;
      for (const k in crew) crew[k].shown = false; // astronauts sent home to Earth are no longer in state.crew
      state.crew.forEach((A) => {
        const i = A.id - 1;
        const a = crew[A.id] || (crew[A.id] = { x: 0, y: 0, init: false });
        if (A.trip) { a.init = false; return; } // inside the rover (they appear at the new HAB when it arrives)
        const homeC = center(MT.Sim.homeOf(state, A));
        let tx = homeC.x + Math.cos(i * 1.57 + 0.8) * 9, ty = homeC.y + Math.sin(i * 1.57 + 0.8) * 9;
        let visible = false;
        // Shelter: the one closest to their HAB.
        const shelter = shelters.reduce((b, s) => (!b || Math.hypot(center(s).x - homeC.x, center(s).y - homeC.y) < Math.hypot(center(b).x - homeC.x, center(b).y - homeC.y) ? s : b), null);
        if (A.where === 'shelter' && shelter) { const s = center(shelter); tx = s.x - 9 + (i % 4) * 6; ty = s.y + 12; visible = true; }
        else if (A.where === 'gym') {
          const g = state.modules.find((m) => m.id === A.gymId);
          if (g) { const gc = center(g); tx = gc.x; ty = gc.y + 13; visible = true; }
        } else if (A.task && A.where === A.task.kind) { // Research Bay, greenhouse or Astronomy Tower
          const tm = state.modules.find((m) => m.id === A.task.id);
          if (tm) { const c = center(tm); tx = c.x + Math.sin(time * 1.5 + i) * 2; ty = c.y + 14; visible = true; }
        } else if (A.where === 'outside') {
          const j = jobs.find((x) => x.key === A.job);
          const bc = j && j.m ? center(j.m) : homeC; // moon-dirt shield: walk around that HAB
          const jc = j && j.m && j.kind !== 'berm' ? center(j.m) : { x: bc.x + Math.cos(time * 0.4 + i * 3) * 42, y: bc.y + Math.sin(time * 0.4 + i * 3) * 42 };
          tx = jc.x + Math.sin(time * 3 + i) * 3; ty = jc.y + 15; visible = true;
        }
        if (!a.init) { a.x = tx; a.y = ty; a.init = true; }
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), sp = 140 * dt;
        if (d > sp) { a.x += (dx / d) * sp; a.y += (dy / d) * sp; } else { a.x = tx; a.y = ty; }
        const sel = picked === A;
        a.id = A.id;
        a.shown = !A.medbay && (visible || d >= 1 || sel); // the picked astronaut is always shown, even inside
        if (!a.shown) return; // inside the habitat (or medbay): hidden
        const exposed = MT.Sim.isExposed(A);
        if (sel) { // picked: pulsing gold ring
          ctx.beginPath(); ctx.arc(a.x, a.y, 9 + Math.sin(time * 5) * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = exposed && danger && blink ? '#ff5d5d' : MT.Sim.isSlow(A) ? '#ffc04d' : '#ffffff'; ctx.fill();
        ctx.beginPath(); ctx.arc(a.x + 1.2, a.y - 1, 2, 0, Math.PI * 2); ctx.fillStyle = '#f5a623'; ctx.fill();
        // number tag (border = role colour) so you can match the astronaut to the AMS list
        ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(a.x - 6, a.y - 17, 12, 10, 3); ctx.fill();
        ctx.strokeStyle = C.astro.roleInfo[A.role].color; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(A.id), a.x, a.y - 9.5);
      });

      // radiation storm particles stream in from the Sun's direction, across what the camera sees
      if (state.stormRate > C.rad.stormOn) {
        const n = Math.min(6, state.stormRate * 0.6 + 0.5);
        const vx = cam.x + VWz / 2, vy = cam.y + VHz / 2;
        for (let k = 0; k < n; k++) {
          if (Math.random() > 0.5) continue;
          const perp = (Math.random() - 0.5) * 1.6 * VWz;
          const sx = vx + sv.x * VWz * 0.65 - sv.y * perp, sy = vy + sv.y * VWz * 0.65 + sv.x * perp;
          const sp = 500 + Math.random() * 300;
          spawn(0, sx, sy, -sv.x * sp, -sv.y * sp, 2.2, Math.random() < 0.5 ? 'rgba(255,90,90,0.7)' : 'rgba(255,220,120,0.7)');
        }
      }
      if (state.meteorOn) spawnMeteors(dt);
      for (const p of pool) {
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.max) {
          p.alive = false;
          if (p.kind === 3) { // meteor lands: flash ring + a puff of moon dust
            spawn(4, p.x, p.y, 0, 0, 0.55, p.color);
            for (let k = 0; k < 5; k++) spawn(1, p.x, p.y, (Math.random() - 0.5) * 60, -Math.random() * 40, 0.7, 'rgba(200,200,205,0.8)');
          }
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 0) {
          ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
        } else if (p.kind === 3) { // meteor: bright head with a fading tail
          const tx = p.x - p.vx * 0.12, ty = p.y - p.vy * 0.12;
          const grad = ctx.createLinearGradient(p.x, p.y, tx, ty);
          grad.addColorStop(0, p.color); grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = grad; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.lineCap = 'butt';
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 4) { // impact flash
          const t = p.life / p.max;
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = '#ffe2b0'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3 + t * 16, 0, Math.PI * 2); ctx.stroke();
          if (t < 0.25) { ctx.fillStyle = '#fff6e0'; ctx.beginPath(); ctx.arc(p.x, p.y, 5 * (1 - t * 4), 0, Math.PI * 2); ctx.fill(); }
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 1 - p.life / p.max;
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 1 ? 2 : 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // hover / build ghost
      if (ui.hover && !ui.dragging) {
        const { c, r } = ui.hover;
        if (ui.buildType) {
          const d = C.modules[ui.buildType];
          const ok = MT.Sim.canPlace(state, ui.buildType, c, r).ok;
          ctx.fillStyle = ok ? 'rgba(95,224,138,0.25)' : 'rgba(255,93,93,0.25)';
          ctx.fillRect(c * T, r * T, d.w * T, d.h * T);
          ctx.strokeStyle = ok ? '#5fe08a' : '#ff5d5d'; ctx.lineWidth = 2; ctx.strokeRect(c * T + 1, r * T + 1, d.w * T - 2, d.h * T - 2);
          ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillText(d.icon, c * T + T / 2, r * T + T / 2 + 7);
        } else {
          const m = MT.Sim.moduleAt(state, c, r);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
          if (m) ctx.strokeRect(m.c * T + 1, m.r * T + 1, m.w * T - 2, m.h * T - 2);
          else ctx.strokeRect(c * T + 1, r * T + 1, T - 2, T - 2);
        }
      }

      // screen-space overlays
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (state.stormRate > C.rad.stormOn) { ctx.fillStyle = `rgba(255,40,40,${Math.min(0.14, state.stormRate * 0.01)})`; ctx.fillRect(0, 0, VW, VH); }
      if (state.meteorOn) { ctx.fillStyle = 'rgba(40,20,70,0.12)'; ctx.fillRect(0, 0, VW, VH); }
      drawBaseTag(hc);
    }

    // ---------- the rover (TEMPORARY model: a box on 4 wheels, to be replaced with better art later) ----------
    // Parked next to its HAB; while driving it moves smoothly from one HAB to the other.
    function roverAt(state) {
      const rv = state.rover;
      if (!rv) return null;
      const parked = (id) => { const H = state.modules.find((m) => m.id === id); const c = center(H); return { x: c.x + T * 1.3, y: c.y + T * 1.2 }; };
      if (!rv.trip) return { ...parked(rv.habId), ang: 0, moving: false };
      const a = parked(rv.trip.from), b = parked(rv.trip.to);
      const t = Math.max(0, Math.min(1, (rv.trip.total - rv.trip.left + frac) / rv.trip.total)), e = t * t * (3 - 2 * t);
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, ang: Math.atan2(b.y - a.y, b.x - a.x), moving: true, riders: rv.trip.crew.length };
    }
    function drawRover(state) {
      const p = roverAt(state);
      if (!p) return;
      if (p.moving && Math.random() < 0.5) spawn(1, p.x - Math.cos(p.ang) * 9, p.y - Math.sin(p.ang) * 9, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0.6, 'rgba(200,200,205,0.7)');
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.ang);
      ctx.fillStyle = '#2b2f36';
      for (const [wx, wy] of [[-6, -6], [3, -6], [-6, 4], [3, 4]]) ctx.fillRect(wx, wy, 4, 2.5); // wheels
      ctx.fillStyle = '#e8c547'; ctx.fillRect(-7, -4, 14, 8); // body
      ctx.fillStyle = '#7fd0ff'; ctx.fillRect(2, -3, 4, 6);    // window
      ctx.strokeStyle = '#c9d1dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-5, -4); ctx.lineTo(-7, -9); ctx.stroke(); // antenna
      ctx.restore();
      if (p.riders) { ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText('👩‍🚀' + p.riders, p.x, p.y - 10); }
    }

    // ---------- sunlight forecast strip (redrawn once per game hour) ----------
    // Slim version that lives in the top bar: two 11-px rows + day labels, 40 px tall in total.
    // The game is endless, so the strip shows a 30-day window: 3 days back, the rest ahead.
    function drawForecast(state) {
      const cw = forecastCanvas.width, ch = forecastCanvas.height, left = 70, w = cw - left - 8, total = C.chunkH;
      const ws = Math.max(0, state.hour - 72), X = (h) => left + ((h - ws) / total) * w; // window start, hour → x
      fctx.clearRect(0, 0, cw, ch);
      const rows = [['ridge', 'High ground'], ['plain', 'Plain']];
      const dark = [44, 52, 69], sun = [255, 211, 107];
      const rowH = 11, top = 2, gap = 2;
      rows.forEach(([z, label], i) => {
        const y = top + i * (rowH + gap);
        fctx.fillStyle = '#c9d1dc'; fctx.font = '10px system-ui'; fctx.textAlign = 'left'; fctx.fillText(label, 2, y + 9);
        for (let h = ws; h < ws + total; h++) {
          let c = mix(dark, sun, MT.Sim.zoneLight(state, z, h + 0.5));
          if (h < state.hour) c = mix(c, [16, 20, 28], 0.5); // the past is dimmed
          fctx.fillStyle = rgb(c);
          fctx.fillRect(X(h), y, w / total + 0.6, rowH);
        }
      });
      const rowsBottom = top + 2 * rowH + gap;
      fctx.fillStyle = '#8b93a1'; fctx.font = '9px system-ui'; fctx.textAlign = 'center';
      for (let d = Math.ceil(ws / 24 / 5) * 5; d * 24 <= ws + total; d += 5) {
        const x = X(d * 24);
        fctx.fillRect(x, rowsBottom + 1, 1, 3);
        if (d) fctx.fillText('Day ' + d, Math.min(Math.max(x, left + 14), cw - 18), ch - 3);
      }
      const inWin = (h) => h >= ws && h < ws + total;
      for (const s of state.storms) if (s.warned && inWin(s.h)) {
        fctx.fillStyle = '#ff5d5d'; fctx.fillRect(X(s.h) - 1, top, 2, rowsBottom - top);
      }
      for (const s of state.meteors || []) if (s.warned && inWin(s.h)) { // meteor showers: purple band once forecast
        fctx.fillStyle = 'rgba(190,140,255,0.85)';
        fctx.fillRect(X(s.h), top, Math.max(2, (s.dur / total) * w), rowsBottom - top);
      }
      for (const s of state.ships || []) if (s.warned && inWin(s.h)) { // crew spaceship: gold marker
        fctx.fillStyle = '#ffd36b'; fctx.fillRect(X(s.h) - 1.5, top, 3, rowsBottom - top);
      }
      const nx = X(state.hour);
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(nx - 0.5, top, 1.5, rowsBottom - top);
      fctx.beginPath(); fctx.moveTo(nx, rowsBottom); fctx.lineTo(nx - 4, rowsBottom + 6); fctx.lineTo(nx + 4, rowsBottom + 6); fctx.fill();
    }

    function reset() { ground = null; tagRect = null; zoom = 1; for (const p of pool) p.alive = false; }
    /** The astronaut drawn under the mouse (id), or null. */
    function crewAt(evt) {
      const p = toCanvas(evt), wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // mouse → world pixels
      let best = null, bd = 11;
      for (const a of Object.values(crew)) {
        if (!a.shown) continue;
        const d = Math.min(Math.hypot(a.x - wx, a.y - wy), Math.hypot(a.x - wx, a.y - 12 - wy)); // the dot or its number tag
        if (d < bd) { bd = d; best = a.id; }
      }
      return best;
    }

    return {
      draw, drawForecast, tileAt, toCanvas, hitTag, crewAt, reset, centerOnBase, centerOnTile, screenOf, resize, setSafeArea, zoomAt,
      panStart: () => ({ x: cam.x, y: cam.y }),
      debug: () => ({ cam: { ...cam }, zoom, tag: tagRect, view: [VW, VH], world: [W, H] }),
      panTo: (x, y) => moveTo(x, y),
    };
  }

  MT.Renderer = Renderer;
})(window);
