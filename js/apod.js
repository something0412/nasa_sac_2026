// Astronomy Tower: shows NASA's Astronomy Picture of the Day (APOD) under a "fishbowl" lens
// that follows the cursor.
//
// Data: NASA APOD Basic JSON feed (no API key needed, allows browser requests):
//   https://science.nasa.gov/wp-json/wp/v2/apod-basic?per_page=10
// We take the newest post whose media_type is "image" (video days are skipped) and ask the
// NASA image service for a 1400 px version instead of the multi-megabyte original.
//
// This is the only part of the game that uses the internet. If the feed can't be reached, we
// show the last picture we received (saved in localStorage), or a "no signal" message.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  const FEED = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic?per_page=10';
  const STORE_KEY = 'mt-apod-last';
  const FRESH_MS = 30 * 60 * 1000; // re-check the feed at most every 30 minutes

  // ---------------------------------------------------------------- data ----
  /** The feed's text fields contain HTML (<a>, <strong>). Turn them into plain text safely:
   *  DOMParser never runs scripts or loads images, and we only ever insert the result as text. */
  function textOf(html) {
    if (!html) return '';
    let text;
    if (typeof DOMParser !== 'undefined') {
      const body = new DOMParser().parseFromString(String(html), 'text/html').body;
      // Tags sit right against each other in the feed ("landed<a>at</a>", "</p><p>"), so put a
      // space after every element before reading the text.
      for (const el of Array.from(body.querySelectorAll('*'))) el.after(' ');
      text = body.textContent || '';
    } else text = String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/&quot;/g, '"'); // tests (Node)
    return text.replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').trim();
  }

  /** Ask NASA's image service for a smaller copy (it keeps the proportions with fit=clip). */
  function sizedImage(u) {
    try {
      const url = new URL(u);
      if (url.protocol !== 'https:') return null;
      if (url.hostname === 'assets.science.nasa.gov') {
        url.searchParams.set('w', '1400');
        url.searchParams.set('h', '1400');
        url.searchParams.set('fit', 'clip');
        url.searchParams.delete('crop');
      }
      return url.href;
    } catch (e) { return null; }
  }

  /** One feed post -> picture, or null for videos, iframes and posts without a real image.
   *  Some old (1990s) posts point at a generic NASA placeholder thumbnail instead of the picture. */
  function toPicture(it) {
    if (!it || it.media_type !== 'image' || !it.hdurl || /\/misc\/news-thumbnail\./.test(it.hdurl)) return null;
    const image = sizedImage(it.hdurl);
    if (!image) return null;
    const link = /^https:\/\/science\.nasa\.gov\//.test(it.permalink || '') ? it.permalink : 'https://apod.nasa.gov/apod/';
    return {
      date: String(it.date || '').slice(0, 10),
      title: textOf(it.title) || 'Astronomy Picture of the Day',
      alt: textOf(it.alt) || textOf(it.title),
      credit: textOf(it.credit || it.copyright).replace(/^(Image\s+)?Credits?(\s*(&|and)\s*Copyright)?\s*:\s*/i, ''), // we add our own "Credit:"
      text: textOf(it.explanation).replace(/^Explanation:\s*/i, '').replace(/\s*Tomorrow'?s picture:.*$/i, ''),
      image, link,
    };
  }
  /** The newest usable picture in a list (the feed lists newest first). */
  function pick(list) {
    if (!Array.isArray(list)) return null;
    for (const it of list) { const p = toPicture(it); if (p) return p; }
    return null;
  }

  function loadSaved() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return v && v.image ? v : null; } catch (e) { return null; }
  }
  function save(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* private mode etc. */ } }

  let cached = null, cachedAt = 0, pending = null;
  /** Resolves to a picture {date, title, alt, credit, text, image, link, saved?}. */
  function latest() {
    if (cached && Date.now() - cachedAt < FRESH_MS) return Promise.resolve(cached);
    if (pending) return pending;
    pending = fetch(FEED, { credentials: 'omit' })
      .then((r) => { if (!r.ok) throw new Error('APOD feed HTTP ' + r.status); return r.json(); })
      .then((list) => {
        const p = pick(list);
        if (!p) throw new Error('no image in the latest APOD posts');
        cached = p; cachedAt = Date.now(); save(p);
        return p;
      })
      .catch((err) => {
        const old = loadSaved();
        if (old) return Object.assign({}, old, { saved: true });
        throw err;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  // ------------------------------------------------------------- archive ----
  // Extra towers show a random picture from the whole APOD archive: from the very first APOD
  // (16 June 1995) up to the day before the current one. We ask the feed for a random week
  // (it skipped a few days in 1995, and some days are videos) and pick one picture from it.
  const FIRST_APOD = Date.UTC(1995, 5, 16);
  const DAY = 86400000;
  const yymmdd = (t) => { const d = new Date(t); return String(d.getUTCFullYear() % 100).padStart(2, '0') + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
  const usedDates = new Set(); // no two towers show the same picture

  function archivePicture(rand) {
    rand = rand || Math.random;
    return latest().then((now) => {
      const nowT = Date.parse(now.date + 'T00:00:00Z');
      const lastT = (isNaN(nowT) ? Date.now() : nowT) - DAY; // the day before the current APOD
      usedDates.add(now.date);
      let tries = 0;
      const attempt = () => {
        const days = Math.max(0, Math.floor((lastT - FIRST_APOD) / DAY));
        const endT = FIRST_APOD + Math.floor(rand() * (days + 1)) * DAY;
        const startT = Math.max(FIRST_APOD, endT - 6 * DAY);
        const url = FEED.replace(/per_page=\d+/, 'per_page=25') + '&date_from=' + yymmdd(startT) + '&date_to=' + yymmdd(endT);
        return fetch(url, { credentials: 'omit' })
          .then((r) => { if (!r.ok) throw new Error('APOD archive HTTP ' + r.status); return r.json(); })
          .then((list) => {
            const good = (Array.isArray(list) ? list : []).map(toPicture).filter((p) => p && !usedDates.has(p.date));
            if (!good.length) {
              if (++tries < 5) return attempt(); // a week of videos or placeholders: try another week
              throw new Error('no archive image found');
            }
            const p = Object.assign(good[Math.floor(rand() * good.length)], { archive: true });
            usedDates.add(p.date);
            return p;
          });
      };
      return attempt();
    });
  }

  // Pictures by key. main.js uses one key per tower VISIT, so every visit after the first gets a new
  // archive picture (usedDates keeps them all different, and never today's picture).
  const towerPictures = new Map(); // key -> Promise<picture>
  function pictureFor(key, archive) {
    if (!archive) return latest();
    if (!towerPictures.has(key)) {
      const p = archivePicture().catch((err) => { towerPictures.delete(key); throw err; }); // retry next click
      towerPictures.set(key, p);
    }
    return towerPictures.get(key);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // NASA's image server allows this, so we can read pixels for the lens
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  // ------------------------------------------------------------- fishbowl ----
  // A round glass bowl over the photo. Inside the bowl, a pixel at distance r from the centre
  // (r = 0 centre, 1 rim) shows the photo from distance f(r) = r(1 - A) + A r^2. That magnifies
  // the middle by 1/(1 - A) and squeezes the edge, like looking through a water-filled bowl.
  // Red and blue are bent slightly differently near the rim (colour fringing), and we paint a
  // rim, an inner shadow and a highlight on top so it reads as glass.
  const A = 0.55;          // bulge strength (centre magnification = 1 / (1 - A) ≈ 2.2x)
  const FRINGE = 0.03;     // colour fringe at the rim
  const reduceMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function Fishbowl(canvas, img) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); // we read and write pixels every frame
    const IW = img.naturalWidth, IH = img.naturalHeight;
    let src = null; // original photo pixels
    try {
      const c = document.createElement('canvas');
      c.width = IW; c.height = IH;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      src = g.getImageData(0, 0, IW, IH).data;
    } catch (e) { src = null; } // server dropped CORS: fall back to a plain magnifier

    let W = 0, H = 0, dpr = 1, k = 1, R = 60, base = null, lens = null;
    let px = 0, py = 0, tx = 0, ty = 0, raf = 0, placed = false;

    function layout() {
      const box = canvas.parentElement;
      const maxW = box.clientWidth || 600;
      const maxH = Math.max(200, root.innerHeight * 0.56);
      const aspect = IH / IW;
      let cssW = maxW, cssH = maxW * aspect;
      if (cssH > maxH) { cssH = maxH; cssW = cssH / aspect; }
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      dpr = Math.min(2, root.devicePixelRatio || 1);
      W = canvas.width = Math.max(1, Math.round(cssW * dpr));
      H = canvas.height = Math.max(1, Math.round(cssH * dpr));
      k = IW / W; // photo pixels per canvas pixel
      R = Math.round(Math.min(115 * dpr, Math.min(W, H) * 0.3));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, W, H);
      base = ctx.getImageData(0, 0, W, H);
      lens = ctx.createImageData(2 * R, 2 * R);
      if (!placed) { px = tx = W / 2; py = ty = H / 2; }
      draw();
    }

    function sample(x, y, ch) {
      const sx = Math.max(0, Math.min(IW - 1, x | 0)), sy = Math.max(0, Math.min(IH - 1, y | 0));
      return src[(sy * IW + sx) * 4 + ch];
    }

    function draw() {
      raf = 0;
      // Ease toward the cursor so the bowl glides instead of jumping.
      const ease = reduceMotion ? 1 : 0.35;
      px += (tx - px) * ease; py += (ty - py) * ease;
      if (Math.abs(tx - px) > 0.3 || Math.abs(ty - py) > 0.3) raf = requestAnimationFrame(draw);

      ctx.putImageData(base, 0, 0);
      const cx = Math.round(px), cy = Math.round(py);

      if (src) {
        const out = lens.data, b = base.data, size = 2 * R;
        for (let j = 0; j < size; j++) {
          const dy = j - R, yy = cy + dy;
          for (let i = 0; i < size; i++) {
            const dx = i - R, xx = cx + dx, o = (j * size + i) * 4;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d >= R) { // outside the bowl: copy the normal photo
              if (xx >= 0 && yy >= 0 && xx < W && yy < H) {
                const q = (yy * W + xx) * 4;
                out[o] = b[q]; out[o + 1] = b[q + 1]; out[o + 2] = b[q + 2]; out[o + 3] = 255;
              } else out[o + 3] = 0;
              continue;
            }
            const r = d / R;
            const m = (1 - A) + A * r;              // f(r) / r
            const f = FRINGE * r * r * r;
            const shade = 1 - 0.38 * Math.pow(r, 6); // darker towards the glass edge
            const gx = (cx + dx * m) * k, gy = (cy + dy * m) * k;
            out[o] = sample(cx * k + dx * m * (1 + f) * k, cy * k + dy * m * (1 + f) * k, 0) * shade;
            out[o + 1] = sample(gx, gy, 1) * shade;
            out[o + 2] = Math.min(255, sample(cx * k + dx * m * (1 - f) * k, cy * k + dy * m * (1 - f) * k, 2) * shade + 6);
            out[o + 3] = 255;
          }
        }
        ctx.putImageData(lens, cx - R, cy - R);
      } else {
        // Fallback magnifier (no pixel access): clip a circle and draw the photo enlarged.
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        const z = 1 / (1 - A);
        ctx.drawImage(img, cx - cx * z, cy - cy * z, W * z, H * z);
        ctx.restore();
      }

      // Glass: soft outer shadow, rim, inner edge glow and a highlight.
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18 * dpr; ctx.shadowOffsetY = 4 * dpr;
      ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = 'rgba(220,240,255,0.75)'; ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      const edge = ctx.createRadialGradient(cx, cy, R * 0.72, cx, cy, R);
      edge.addColorStop(0, 'rgba(160,210,255,0)'); edge.addColorStop(1, 'rgba(160,210,255,0.28)');
      ctx.fillStyle = edge; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      const hl = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, 0, cx - R * 0.38, cy - R * 0.42, R * 0.55);
      hl.addColorStop(0, 'rgba(255,255,255,0.42)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      ctx.beginPath(); ctx.ellipse(cx + R * 0.32, cy + R * 0.5, R * 0.28, R * 0.08, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
      ctx.restore();
    }

    function request() { if (!raf) raf = requestAnimationFrame(draw); }
    function moveTo(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      tx = Math.max(0, Math.min(W, (clientX - r.left) * dpr));
      ty = Math.max(0, Math.min(H, (clientY - r.top) * dpr));
      placed = true;
      request();
    }
    const onMove = (e) => moveTo(e.clientX, e.clientY);
    const onDown = (e) => { moveTo(e.clientX, e.clientY); canvas.focus({ preventScroll: true }); };
    const onKey = (e) => {
      const step = (e.shiftKey ? 60 : 20) * dpr;
      if (e.key === 'ArrowLeft') tx -= step; else if (e.key === 'ArrowRight') tx += step;
      else if (e.key === 'ArrowUp') ty -= step; else if (e.key === 'ArrowDown') ty += step;
      else return;
      e.preventDefault();
      tx = Math.max(0, Math.min(W, tx)); ty = Math.max(0, Math.min(H, ty)); placed = true;
      request();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('keydown', onKey);
    let resizeTimer = 0;
    const ro = root.ResizeObserver ? new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120); }) : null;
    if (ro) ro.observe(canvas.parentElement);
    layout();

    return {
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        clearTimeout(resizeTimer);
        if (ro) ro.disconnect();
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('keydown', onKey);
      },
    };
  }

  // ---------------------------------------------------------------- view ----
  /**
   * Fill the tower pop-up (root element with the .apod* parts). Returns {destroy}.
   * opts.archive = false: today's picture (the first tower visit of the mission). true: a random
   * archive picture, remembered under opts.key (one per visit).

   */
  function show(el, opts) {
    opts = opts || {};
    const q = (s) => el.querySelector(s);
    const status = q('.apodStatus'), stage = q('.apodStage'), canvas = q('.apodCanvas'), info = q('.apodInfo');
    let lensView = null, gone = false;
    const say = (t) => { status.textContent = t; status.hidden = !t; };
    say(opts.archive ? '📡 Searching NASA\'s picture archive (back to 1995)…' : '📡 Receiving today\'s picture from Earth…');

    pictureFor(opts.key, !!opts.archive)
      .then((p) => {
        if (gone) return null;
        q('.apodTitle').textContent = p.title;
        q('.apodMeta').textContent = [p.date && 'NASA Astronomy Picture of the Day, ' + p.date + (p.archive ? ' (from the archive)' : ''), p.credit && 'Credit: ' + p.credit].filter(Boolean).join(' · ');
        q('.apodText').textContent = p.text;
        const a = q('.apodLink'); a.href = p.link;
        info.hidden = false;
        canvas.setAttribute('aria-label', (p.alt || p.title) + '. Move the mouse or use the arrow keys to move the fishbowl lens.');
        return loadImage(p.image).then((img) => {
          if (gone) return;
          stage.hidden = false;
          say(p.saved ? 'No new signal from Earth: showing the last picture the tower received.' : '');
          lensView = Fishbowl(canvas, img);
        });
      })
      .catch(() => {
        if (gone) return;
        say(location.protocol === 'file:'
          ? '📡 No signal. Start the game with "python -m http.server 8137" and open http://localhost:8137 so the tower can reach NASA.'
          : '📡 No signal from Earth right now (are you online?). Try the tower again later.');
      });

    return { destroy() { gone = true; if (lensView) lensView.destroy(); } };
  }

  MT.APOD = { latest, show, _pick: pick, _archivePicture: archivePicture, _yymmdd: yymmdd };
})(typeof window !== 'undefined' ? window : globalThis);
