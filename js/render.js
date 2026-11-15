// Drawing the map. Runs every frame (60 fps). Reads the sim state, never changes it.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  const POOL_SIZE = 260;

  function Renderer(canvas, forecastCanvas) {
    const C = MT.CONFIG, T = C.map.tile;
    const W = C.map.cols * T, H = C.map.rows * T;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const fctx = forecastCanvas.getContext('2d');

    let ground = null, zonePaths = null;
    const shade = { ridge: 0, plain: 0 };
    const crew = [];
    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 0, color: '' });
    let time = 0, dashOffset = 0;

    // ---------- static ground, drawn once ----------
    function buildGround(state) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const g = off.getContext('2d');
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      zonePaths = { ridge: new Path2D(), plain: new Path2D(), ice: new Path2D() };
      for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) {
        const z = MT.Sim.zoneOf(state, c, r);
        zonePaths[z].rect(c * T, r * T, T, T);
      }
      for (const z of ['plain', 'ridge', 'ice']) { g.fillStyle = C.zones[z].color; g.fill(zonePaths[z]); }
      // speckle texture
      for (let i = 0; i < 2600; i++) {
        const x = rand() * W, y = rand() * H, s = rand() * 2 + 0.5;
        g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        g.fillRect(x, y, s, s);
      }
      // craters
      for (let i = 0; i < 46; i++) {
        const x = rand() * W, y = rand() * H, r = 4 + rand() ** 2 * 26;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.13)'; g.fill();
        g.beginPath(); g.arc(x - r * 0.15, y - r * 0.15, r * 0.85, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.08)'; g.fill();
        g.beginPath(); g.arc(x, y, r, Math.PI * 0.1, Math.PI * 0.9);
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1.5; g.stroke();
      }
      // ice sparkles in the dark crater
      g.save(); g.clip(zonePaths.ice);
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `rgba(170,210,255,${0.15 + rand() * 0.35})`;
        g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
      }
      g.restore();
      // ridge edge highlight
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.stroke(zonePaths.ridge);
      // grid
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1;
      for (let c = 0; c <= C.map.cols; c++) { g.beginPath(); g.moveTo(c * T + 0.5, 0); g.lineTo(c * T + 0.5, H); g.stroke(); }
      for (let r = 0; r <= C.map.rows; r++) { g.beginPath(); g.moveTo(0, r * T + 0.5); g.lineTo(W, r * T + 0.5); g.stroke(); }
      // labels
      g.font = 'bold 12px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillText('HIGH RIDGE', 8, 18);
      g.fillStyle = 'rgba(170,210,255,0.7)';
      g.fillText('SHADOWED CRATER (ICE)', 610, 470);
      ground = off;
      for (let i = 0; i < C.crew; i++) crew.push({ x: 0, y: 0, tx: 0, ty: 0, init: false });
    }

    // ---------- particles (object pool, no new objects per frame) ----------
    function spawn(kind, x, y, vx, vy, life, color) {
      for (const p of pool) if (!p.alive) { p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = 0; p.max = life; p.color = color; return p; }
      return null;
    }

    const center = (m) => ({ x: (m.c + m.w / 2) * T, y: (m.r + m.h / 2) * T });
    const sunVec = (state) => {
      const a = (MT.Sim.sunAz(state, state.hour) * Math.PI) / 180;
      return { x: Math.cos(a), y: Math.sin(a) };
    };

    function hull(pts) {
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }

    // ---------- module sprites ----------
    function drawModule(state, m, blink) {
      const x = m.c * T, y = m.r * T, w = m.w * T, h = m.h * T, cx = x + w / 2, cy = y + h / 2;
      const on = m.built && m.on && m.powered;
      ctx.save();
      if (!m.built) ctx.globalAlpha = 0.45;
      switch (m.type) {
        case 'hab': {
          if (state.berm.built || state.berm.building) {
            const frac = state.berm.built ? 1 : state.berm.progress / C.bermWork;
            ctx.beginPath(); ctx.arc(cx, cy, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
            ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 9; ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(cx, cy, 31, 0, Math.PI * 2);
          ctx.fillStyle = '#d9dde4'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#8f96a3'; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.strokeStyle = '#aab1bd'; ctx.stroke();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + 0.3;
            ctx.fillStyle = on ? (state.habTemp < 15 ? '#7fb4ff' : '#ffd36b') : '#39404b';
            ctx.fillRect(cx + Math.cos(a) * 25 - 3, cy + Math.sin(a) * 25 - 3, 6, 6);
          }
          ctx.fillStyle = '#5b6576'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('HAB', cx, cy + 4);
          break;
        }
        case 'solar': {
          ctx.fillStyle = '#555'; ctx.fillRect(cx - 3, cy - 3, 6, 6);
          const s = sunVec(state);
          const ang = Math.atan2(s.y, s.x) + Math.PI / 2;
          ctx.translate(cx, cy); ctx.rotate(ang);
          ctx.fillStyle = m.lit ? '#2f6fd6' : '#1d2c48';
          ctx.fillRect(-16, -5, 32, 10);
          ctx.strokeStyle = m.lit ? '#9cc3ff' : '#3a4a66'; ctx.lineWidth = 1;
          for (let i = -16; i <= 16; i += 8) { ctx.beginPath(); ctx.moveTo(i, -5); ctx.lineTo(i, 5); ctx.stroke(); }
          ctx.strokeRect(-16, -5, 32, 10);
          if (m.lit && m.built && m.on) { ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.25 * Math.sin(time * 3 + m.id)})`; ctx.fillRect(-16, -5, 8, 10); }
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
          if (m.built && blink) { ctx.fillStyle = '#7fb4ff'; ctx.beginPath(); ctx.arc(x + w - 8, y + 8, 2.2, 0, Math.PI * 2); ctx.fill(); }
          break;
        }
      }
      ctx.restore();

      // status badges
      if (!m.built) {
        const work = C.modules[m.type].work;
        ctx.strokeStyle = '#ffd36b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + 4, y + h - 8, w - 8, 5);
        ctx.fillStyle = '#ffd36b'; ctx.fillRect(x + 4, y + h - 8, (w - 8) * (m.progress / work), 5);
      } else if (!m.on) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ccc'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('OFF', x + w / 2, y + h / 2 + 4);
      } else if (m.type !== 'solar' && m.type !== 'battery' && m.type !== 'shelter' && m.type !== 'tower' && !m.powered) {
        ctx.fillStyle = 'rgba(40,0,0,0.45)'; ctx.fillRect(x, y, w, h);
        if (blink) { ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('⚡', x + w - 9, y + 15); }
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      } else if (m.noWater && blink) {
        ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('💧', x + w - 9, y + 14);
        ctx.strokeStyle = '#58c4ff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
    }

    // ---------- main draw ----------
    function draw(state, dt, ui) {
      if (!ground) buildGround(state);
      time += dt;
      dashOffset -= dt * 28;
      const blink = Math.floor(time * 2.5) % 2 === 0;
      const habM = state.modules.find((m) => m.type === 'hab');
      const hc = center(habM);

      ctx.drawImage(ground, 0, 0);

      // zone shadows fade in/out smoothly
      for (const z of ['ridge', 'plain']) {
        const target = MT.Sim.zoneLitAt(state, z, state.hour) ? 0 : 0.72;
        shade[z] += (target - shade[z]) * Math.min(1, dt * 2.5);
        if (shade[z] > 0.01) { ctx.fillStyle = `rgba(5,8,20,${shade[z]})`; ctx.fill(zonePaths[z]); }
      }
      ctx.fillStyle = 'rgba(5,8,25,0.35)'; ctx.fill(zonePaths.ice);

      // long shadows from modules (the Sun is always near the horizon at the pole)
      const sv = sunVec(state);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (const m of state.modules) {
        if (!m.built || !MT.Sim.zoneLitAt(state, MT.Sim.zoneOf(state, m.c, m.r), state.hour)) continue;
        const pad = m.type === 'hab' ? 10 : 8;
        const x0 = m.c * T + pad, y0 = m.r * T + pad, x1 = (m.c + m.w) * T - pad, y1 = (m.r + m.h) * T - pad;
        const L = m.type === 'hab' ? 34 : m.type === 'solar' ? 30 : 16;
        const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const all = pts.concat(pts.map(([px, py]) => [px - sv.x * L, py - sv.y * L]));
        const hp = hull(all);
        ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
        for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
        ctx.closePath(); ctx.fill();
      }

      // power cables: yellow moving dashes = power flowing, red = no power
      ctx.lineWidth = 2;
      for (const m of state.modules) {
        if (m.type === 'hab' || !m.built) continue;
        const c = center(m);
        let color, flow = 0;
        if (m.type === 'solar') { color = m.lit && m.on ? '#ffd36b' : '#4a4f5a'; flow = m.lit && m.on ? 1 : 0; }
        else if (m.type === 'battery') {
          const charging = state.power.supply > state.power.use;
          color = state.res.battery > 0.01 || charging ? '#7de0a0' : '#4a4f5a'; flow = charging ? 1 : state.res.battery > 0.01 ? -1 : 0;
        } else if (m.type === 'shelter') { color = '#6b5b45'; }
        else { color = !m.on ? '#4a4f5a' : m.powered ? '#ffd36b' : '#ff5d5d'; flow = m.on && m.powered ? -1 : 0; }
        ctx.strokeStyle = color;
        ctx.setLineDash(flow ? [6, 6] : m.type === 'shelter' ? [2, 4] : [3, 5]);
        ctx.lineDashOffset = flow * dashOffset;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hc.x, hc.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      for (const m of state.modules) drawModule(state, m, blink);

      // astronauts
      const job = MT.Sim.currentJob(state);
      const shelter = MT.Sim.built(state, 'shelter')[0];
      const wOut = MT.Sim.workersOutside(state);
      crew.forEach((a, i) => {
        let tx = hc.x + Math.cos(i * 1.57 + 0.8) * 9, ty = hc.y + Math.sin(i * 1.57 + 0.8) * 9;
        if (state.sheltering && shelter) { const s = center(shelter); tx = s.x - 9 + i * 6; ty = s.y + 12; }
        else if (i < wOut && job) {
          const jc = job.kind === 'module' ? center(job.m) : { x: hc.x + Math.cos(time * 0.6 + i * 3) * 40, y: hc.y + Math.sin(time * 0.6 + i * 3) * 40 };
          tx = jc.x + (i ? 10 : -10) + Math.sin(time * 3 + i) * 3; ty = jc.y + 14;
        }
        if (!a.init) { a.x = tx; a.y = ty; a.init = true; }
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), sp = 90 * dt;
        if (d > sp) { a.x += (dx / d) * sp; a.y += (dy / d) * sp; } else { a.x = tx; a.y = ty; }
        const outside = !(state.sheltering && shelter) && i < wOut;
        if (!outside && !(state.sheltering && shelter) && d < 1) return; // inside the habitat: hidden
        ctx.beginPath(); ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = outside && state.stormRate > 0.3 && blink ? '#ff5d5d' : '#ffffff'; ctx.fill();
        ctx.beginPath(); ctx.arc(a.x + 1.2, a.y - 1, 2, 0, Math.PI * 2); ctx.fillStyle = '#f5a623'; ctx.fill();
      });

      // radiation storm particles stream from the Sun's direction
      if (state.stormRate > 0.3) {
        const n = Math.min(6, state.stormRate * 0.6 + 0.5);
        for (let k = 0; k < n; k++) {
          if (Math.random() > 0.5) continue;
          const perp = (Math.random() - 0.5) * 1.6 * W;
          const sx = W / 2 + sv.x * W * 0.65 - sv.y * perp, sy = H / 2 + sv.y * W * 0.65 + sv.x * perp;
          const sp = 500 + Math.random() * 300;
          spawn(0, sx, sy, -sv.x * sp, -sv.y * sp, 2.2, Math.random() < 0.5 ? 'rgba(255,90,90,0.7)' : 'rgba(255,220,120,0.7)');
        }
      }
      for (const p of pool) {
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.max) { p.alive = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 0) {
          ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
        } else {
          ctx.globalAlpha = 1 - p.life / p.max;
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 1 ? 2 : 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      if (state.stormRate > 0.3) { ctx.fillStyle = `rgba(255,40,40,${Math.min(0.14, state.stormRate * 0.01)})`; ctx.fillRect(0, 0, W, H); }

      // the Sun on the horizon
      const R = Math.min(W, H) / 2 - 16;
      const sx = W / 2 + sv.x * (W / 2 - 18), sy = H / 2 + sv.y * (H / 2 - 18);
      const grad = ctx.createRadialGradient(sx, sy, 2, sx, sy, 34);
      grad.addColorStop(0, 'rgba(255,240,180,1)'); grad.addColorStop(0.3, 'rgba(255,210,90,0.6)'); grad.addColorStop(1, 'rgba(255,200,80,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(sx, sy, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff6d0'; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,200,0.9)'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('SUN', sx - sv.x * 22, sy - sv.y * 22 + 3);
      void R;

      // hover / build ghost
      if (ui.hover) {
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
    }

    // ---------- sunlight forecast strip (redrawn once per game hour) ----------
    function drawForecast(state) {
      const cw = forecastCanvas.width, ch = forecastCanvas.height, left = 74, w = cw - left - 6, total = C.missionHours;
      fctx.clearRect(0, 0, cw, ch);
      const rows = [['ridge', 'High ridge'], ['plain', 'Plain']];
      rows.forEach(([z, label], i) => {
        const y = 4 + i * 18;
        fctx.fillStyle = '#c9d1dc'; fctx.font = '11px system-ui'; fctx.textAlign = 'left'; fctx.fillText(label, 4, y + 11);
        const L = state.light[z];
        for (let h = 0; h < total; h++) {
          fctx.fillStyle = L[h] ? (h < state.hour ? '#8a7a3a' : '#ffd36b') : (h < state.hour ? '#1b1f2a' : '#2c3445');
          fctx.fillRect(left + (h / total) * w, y, w / total + 0.6, 14);
        }
      });
      // day ticks
      fctx.fillStyle = '#8b93a1'; fctx.font = '9px system-ui'; fctx.textAlign = 'center';
      for (let d = 0; d <= 30; d += 5) { const x = left + ((d * 24) / total) * w; fctx.fillRect(x, 40, 1, 4); fctx.fillText(d ? 'Day ' + d : '', x, 53); }
      // storms already seen
      for (const s of state.storms) if (s.warned) {
        const x = left + (s.h / total) * w;
        fctx.fillStyle = '#ff5d5d'; fctx.fillRect(x - 1, 2, 2, 36);
      }
      // now marker
      const nx = left + (state.hour / total) * w;
      fctx.fillStyle = '#ffffff'; fctx.beginPath(); fctx.moveTo(nx, 38); fctx.lineTo(nx - 5, 46); fctx.lineTo(nx + 5, 46); fctx.fill();
      fctx.fillRect(nx - 0.5, 2, 1, 36);
    }

    function tileAt(evt) {
      const rect = canvas.getBoundingClientRect();
      const x = ((evt.clientX - rect.left) / rect.width) * W, y = ((evt.clientY - rect.top) / rect.height) * H;
      return { c: Math.floor(x / T), r: Math.floor(y / T), px: evt.clientX - rect.left, py: evt.clientY - rect.top };
    }

    function reset() { ground = null; crew.length = 0; shade.ridge = shade.plain = 0; for (const p of pool) p.alive = false; }

    return { draw, drawForecast, tileAt, reset };
  }

  MT.Renderer = Renderer;
})(window);
