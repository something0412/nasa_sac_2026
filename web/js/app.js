// =============================================================================
// app.js — wires the page together. Reads the data files, asks scoring.js for
// rankings, and draws every panel. Nothing here does maths you need to defend;
// that all lives in scoring.js and config.js.
//
// Flow:  user changes something -> update `state` -> recompute() -> render*()
// =============================================================================
(function () {
  'use strict';

  var cfg = window.ANALOG_CONFIG, S = window.AnalogScoring;
  var TARGETS = window.TARGETS || [];
  var SITES = (window.EARTH_SITES || []).concat(window.SCAN_CELLS || []); // SCAN_CELLS: optional level-up
  var META = window.EARTH_SITES_META || {};
  var ENV = S.earthEnvelope(SITES, cfg); // Earth's reachable range per feature (fixed)

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var pct = function (x) { return Math.round((x || 0) * 100); };
  var dimLabel = {};
  cfg.dims.forEach(function (d) { dimLabel[d.id] = d.label; });

  var state = {
    targetId: TARGETS.length ? TARGETS[0].id : null,
    presetId: 'balanced',
    weights: Object.assign({}, cfg.presets[0].weights),
    selectedId: null,
    filter: 'all',
    showControls: false,
    globe: true,
    satellite: false
  };
  var ranking = null, mapView = null, lastTargetId = null;

  function target() { return TARGETS.find(function (t) { return t.id === state.targetId; }) || TARGETS[0]; }
  function resultFor(id) { return ranking.results.find(function (r) { return r.site.id === id; }); }

  // ---------------------------------------------------------------- setup ----
  function initControls() {
    var groups = {};
    TARGETS.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    $('targetSelect').innerHTML = Object.keys(groups).map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    $('presetSelect').innerHTML = cfg.presets.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.label) + '</option>';
    }).join('') + '<option value="custom" disabled>Custom weights</option>';
    $('sliders').innerHTML = cfg.dims.map(function (d) {
      return '<label class="slider" id="sl-' + d.id + '" title="' + esc(d.blurb) + '">' +
        '<span class="lab"><span>' + esc(d.label) + '</span><b id="sv-' + d.id + '"></b></span>' +
        '<input type="range" min="0" max="5" step="1" data-dim="' + d.id + '" aria-label="' + esc(d.label) + ' weight">' +
        '<span class="note" id="sn-' + d.id + '"></span></label>';
    }).join('');

    $('targetSelect').addEventListener('change', function (e) { setTarget(e.target.value); });
    $('presetSelect').addEventListener('change', function (e) {
      var p = cfg.presets.find(function (x) { return x.id === e.target.value; });
      if (!p) return;
      state.presetId = p.id;
      state.weights = Object.assign({}, p.weights);
      recompute();
    });
    $('sliders').addEventListener('input', function (e) {
      var dim = e.target.getAttribute('data-dim');
      if (!dim) return;
      state.weights[dim] = Number(e.target.value);
      state.presetId = 'custom';
      recompute();
    });
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); renderList(); renderMap(); });
    });
    $('showControls').addEventListener('change', function (e) { state.showControls = e.target.checked; renderList(); renderMap(); });
    $('rankList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]');
      if (b) select(b.getAttribute('data-id'), true);
    });
    $('globeBtn').addEventListener('click', function () {
      state.globe = !state.globe;
      this.setAttribute('aria-pressed', String(state.globe));
      if (mapView) mapView.setGlobe(state.globe);
    });
    $('satBtn').addEventListener('click', function () {
      state.satellite = !state.satellite;
      this.setAttribute('aria-pressed', String(state.satellite));
      if (mapView) mapView.setSatellite(state.satellite);
      $('attrib').textContent = state.satellite ? 'Basemap: Natural Earth. Imagery: NASA GIBS Blue Marble.' : 'Basemap: Natural Earth.';
    });
    $('copyBtn').addEventListener('click', copyProfile);
    window.addEventListener('hashchange', function () {
      var id = location.hash.slice(1);
      if (id && id !== state.targetId && TARGETS.some(function (t) { return t.id === id; })) setTarget(id, true);
    });
  }

  function setTarget(id, fromHash) {
    state.targetId = id;
    state.selectedId = null;
    if (!fromHash) {
      try { history.replaceState(null, '', '#' + id); } catch (e) { /* sandboxed viewers may refuse */ }
    }
    recompute();
  }

  function select(id, fly) {
    state.selectedId = id;
    renderList();
    renderMap();
    renderDetail();
    var r = resultFor(id);
    if (fly && mapView && r) mapView.focus(r.site.lon, r.site.lat, true);
  }

  // -------------------------------------------------------------- compute ----
  function recompute() {
    var t = target();
    ranking = S.rankSites(SITES, t, state.weights, cfg, { env: ENV });
    var targetChanged = lastTargetId !== t.id;
    lastTargetId = t.id;
    if (!state.selectedId || !resultFor(state.selectedId)) {
      state.selectedId = ranking.results.find(function (r) { return r.rank === 1; }).site.id;
    }
    renderTarget();
    renderControls();
    renderList();
    renderMap();
    renderDetail();
    renderCampaign();
    renderProof();
    if (targetChanged && mapView) {
      var top = resultFor(state.selectedId);
      if (top) mapView.focus(top.site.lon, top.site.lat);
    }
  }

  // --------------------------------------------------------------- render ----
  var SHORT = { slope_deg: 'Slope', relief_m: 'Relief (5 km)', lava_tube: 'Lava tube', t_min_c: 'Coldest',
    t_swing_c: 'Day-night swing', t_mean_c: 'Mean temperature', rock: 'Rock', ground_ice: 'Ground ice', sun_elev_deg: 'Noon Sun' };

  function fmtLat(v) { return Math.abs(v).toFixed(2) + '° ' + (v >= 0 ? 'N' : 'S'); }
  function fmtLon(v) { return Math.abs(v).toFixed(2) + '° ' + (v >= 0 ? 'E' : 'W'); }

  function renderTarget() {
    var t = target();
    $('targetSelect').value = t.id;
    $('band').setAttribute('data-body', t.body);
    $('targetName').textContent = t.name;
    $('targetWhy').textContent = t.why;
    $('trekLink').href = 'https://trek.nasa.gov/' + t.body + '/';
    $('trekLink').textContent = 'Open in NASA ' + (t.body === 'moon' ? 'Moon' : 'Mars') + ' Trek';
    $('targetSpec').innerHTML = Object.keys(SHORT).filter(function (k) { return S.targetValue(t, k, cfg) !== null; }).map(function (k) {
      var v = S.targetValue(t, k, cfg);
      var text = k === 'rock' ? v.map(function (r) { return cfg.rockLabels[r].replace(/ \(.*\)/, ''); }).join(', ') : S.formatValue(cfg, k, v);
      return '<div><dt>' + SHORT[k] + '</dt><dd>' + esc(text) + '</dd></div>';
    }).join('');
    var body = cfg.bodies[t.body];
    $('targetCoord').textContent = body.label + ', ' + fmtLat(t.lat) + ', ' + fmtLon(t.lon) + (t.coordNote ? ' (' + t.coordNote + ')' : '') + '. ' + (t.valueNote || '');
    document.title = 'Analog Finder: ' + t.name;
  }

  function renderControls() {
    $('presetSelect').value = state.presetId;
    cfg.dims.forEach(function (d) {
      var active = ranking.dims.indexOf(d.id) >= 0;
      var input = document.querySelector('input[data-dim="' + d.id + '"]');
      input.value = state.weights[d.id];
      input.disabled = !active;
      $('sv-' + d.id).textContent = active ? state.weights[d.id] : '';
      $('sl-' + d.id).classList.toggle('off', !active);
      $('sn-' + d.id).textContent = active ? '' : 'Not used for this target';
    });
  }

  function badge(site) {
    if (site.status === 'established') return '<span class="badge">Established</span>';
    if (site.status === 'less-studied') return '<span class="badge new">Less studied</span>';
    if (site.status === 'control') return '<span class="badge ctl">Ordinary place</span>';
    return '<span class="badge new">Scan cell</span>';
  }

  function visibleResults() {
    return ranking.results.filter(function (r) {
      if (r.site.status === 'control') return state.showControls;
      return state.filter === 'all' || r.site.status === state.filter;
    });
  }

  function renderList() {
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === state.filter));
    });
    var t = target();
    $('rankTitle').textContent = 'Best Earth stand-ins for ' + t.name.replace(/ \(.*\)$/, '');
    $('rankList').innerHTML = visibleResults().map(function (r) {
      var s = pct(r.total);
      return '<li><button type="button" class="row" data-id="' + esc(r.site.id) + '" aria-pressed="' + (r.site.id === state.selectedId) + '">' +
        '<span class="rk">' + (r.rank || '') + '</span>' +
        '<span class="nm"><b>' + esc(r.site.name) + '</b><small>' + esc(r.site.country) + ' ' + badge(r.site) + '</small></span>' +
        '<span class="sc"><b>' + s + '</b><span class="meter" aria-hidden="true"><i style="width:' + s + '%"></i></span></span>' +
        '</button></li>';
    }).join('');
  }

  function renderMap() {
    if (!mapView) return;
    var shown = visibleResults();
    mapView.setSites(shown.map(function (r) {
      return { id: r.site.id, lon: r.site.lon, lat: r.site.lat, score: pct(r.total), rank: r.rank,
        selected: r.site.id === state.selectedId, muted: r.site.status === 'control' };
    }));
  }

  // Short names for provenance chips.
  function srcChip(site, key) {
    if (key === 'sun_elev_deg') return '<span class="chip">from latitude</span>';
    var src = (site.src || {})[key] || 'seed estimate';
    if (src === 'seed estimate') {
      return (key === 'rock' || key === 'lava_tube') ? '<span class="chip est">curated</span>' : '<span class="chip est">estimate</span>';
    }
    var short = /POWER/.test(src) ? 'NASA POWER' : /SRTM/.test(src) ? 'SRTM' : /MODIS/.test(src) ? 'MODIS' : /Macrostrat/.test(src) ? 'Macrostrat' : src;
    return '<span class="chip" title="' + esc(src) + '">' + esc(short) + '</span>';
  }

  function renderDetail() {
    var r = resultFor(state.selectedId);
    if (!r) return;
    var t = target(), site = r.site;
    var active = ranking.dims.filter(function (d) { return r.dims[d].score !== null; });
    var weighted = active.filter(function (d) { return state.weights[d] > 0; });
    var best = weighted.slice().sort(function (a, b) { return r.dims[b].score - r.dims[a].score; });
    $('matchTitle').textContent = site.name + ' matches ' + pct(r.total) + ' of 100';
    $('matchSub').textContent = best.length ?
      'Strongest on ' + dimLabel[best[0]].toLowerCase() + ' (' + pct(r.dims[best[0]].score) + '), weakest on ' +
      dimLabel[best[best.length - 1]].toLowerCase() + ' (' + pct(r.dims[best[best.length - 1]].score) + '). ' + (site.note || '') :
      'All dimensions are weighted zero. Move a slider to score this site.';

    $('dimBars').innerHTML = active.map(function (d) {
      var D = r.dims[d], s = pct(D.score), off = state.weights[d] === 0;
      var feats = D.features.map(function (f) {
        var here = f.key === 'rock' ? S.formatValue(cfg, 'rock', [site.rock, site.rock2]) : S.formatValue(cfg, f.key, f.earth);
        var there = S.formatValue(cfg, f.key, f.target);
        var cls = function (txt) { return txt.length > 18 ? 'v wrap' : 'v'; }; // long rock names may wrap
        return '<li><span class="fl">' + esc(cfg.features[f.key].label) + '</span><span class="' + cls(here) + '">' + esc(here) +
          ' here</span><span class="' + cls(there) + '">' + esc(there) + ' target</span>' + srcChip(site, f.key) + '</li>';
      }).join('');
      return '<div class="dim' + (off ? ' off' : '') + '"><div class="dimhead"><span>' + esc(dimLabel[d]) + '</span>' +
        '<span class="meter" aria-hidden="true"><i style="width:' + s + '%"></i></span><b>' + s + '</b></div>' +
        '<ul class="feat">' + feats + '</ul>' + (off ? '<p class="sub">Weighted zero, so not in the total.</p>' : '') + '</div>';
    }).join('');

    var w = 0.5;
    $('worldviewLink').href = 'https://worldview.earthdata.nasa.gov/?v=' + [site.lon - w, site.lat - w, site.lon + w, site.lat + w].map(function (v) { return v.toFixed(2); }).join(',');
    renderGaps(r);
  }

  var ICON = {
    holds: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    partial: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 11.5c2-3 4-3 6.5 0s4.5 3 6.5 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    breaks: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  var STATUS_WORD = { holds: 'Holds', partial: 'Partly holds', breaks: 'Breaks down' };

  function renderGaps(r) {
    var g = S.gapReport(r, ranking, cfg);
    var t = target();
    $('gapSub').textContent = g.counts.breaks + ' of ' + g.items.length + ' features break down, ' + g.counts.partial +
      ' partly hold and ' + g.counts.holds + ' hold for ' + t.name + '.';
    $('gapList').innerHTML = g.items.map(function (i) {
      var vals = i.earthText + ' here, ' + i.targetText + ' at the target.';
      if (i.beyond) vals += ' The closest any place on Earth gets is ' + i.reachText + '.';
      var fix = i.mitigation ? '<p class="fix">' + esc(i.mitigation) + '</p>' :
        i.betterSite ? '<p class="fix">Closer on Earth: <a href="#" data-pick="' + esc(i.betterSite.id) + '">' + esc(i.betterSite.name) + '</a>.</p>' : '';
      return '<li class="' + i.status + '"><span class="ic">' + ICON[i.status] + '</span><div>' +
        '<p class="t"><b>' + esc(i.label) + '</b><span class="st">' + STATUS_WORD[i.status] + '</span></p>' +
        '<p class="vals">' + esc(vals) + '</p>' + fix + '</div></li>';
    }).join('');
    $('uniList').innerHTML = g.universal.map(function (u) {
      return '<li><span class="ic">' + ICON.info + '</span><div><p><b>' + esc(u.label) + '.</b> ' + esc(u.text) + '</p>' +
        (u.test ? '<p class="fix">' + esc(u.test) + '</p>' : '') + '</div></li>';
    }).join('');
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-pick]');
    if (a) { e.preventDefault(); select(a.getAttribute('data-pick'), true); }
  });

  function renderCampaign() {
    var P = S.portfolio(ranking, state.weights, cfg, { k: 3, minKm: 300 });
    var t = target();
    if (!P.picks.length || !P.dims.length) {
      $('campTitle').textContent = 'Best 3-site test campaign';
      $('campSub').textContent = 'Give at least one dimension some weight to plan a campaign.';
      $('campTable').innerHTML = '';
      return;
    }
    var cov = pct(P.coverage), single = pct(P.bestSingle);
    $('campTitle').textContent = 'A 3-site test campaign covers ' + (cov >= 100 ? 'nearly all' : cov + '%') + ' of what ' + t.name.replace(/ \(.*\)$/, '') + ' demands';
    $('campSub').textContent = 'The best single site covers ' + single + '%. No place on Earth is the ' + cfg.bodies[t.body].label +
      ', so test each subsystem where its conditions hold best. Outlined cells show which site carries each dimension. Picks are at least 300 km apart.';
    var head = '<thead><tr><th>Dimension</th>' + P.picks.map(function (p, i) {
      return '<th>' + (i + 1) + '. ' + esc(p.site.name) + '<small>' + esc(p.site.country) + '</small></th>';
    }).join('') + '</tr></thead>';
    var body = '<tbody>' + P.dims.map(function (d) {
      return '<tr><th scope="row">' + esc(dimLabel[d]) + '</th>' + P.picks.map(function (p) {
        var s = pct(p.dims[d].score);
        return '<td class="lv' + window.AnalogMap.level(s) + (P.owners[d] === p ? ' own' : '') + '">' + s + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    var foot = '<tfoot><tr><th scope="row">Campaign coverage</th><td colspan="' + P.picks.length + '">' + cov + '% (best single site ' + single + '%)</td></tr></tfoot>';
    $('campTable').innerHTML = head + body + foot;
  }

  // Validation dot plot: one row per group, x = best score across the body's targets.
  var proofData = null;
  function renderProof() {
    var t = target(), body = cfg.bodies[t.body].label;
    var v = S.validate(SITES, TARGETS, t.body, state.weights, cfg, ENV);
    proofData = v;
    if (v.auc === null) {
      $('proofTitle').textContent = 'Does the model work?';
      $('proofSub').textContent = 'Add established analogs and control places to the data to test the model.';
      return;
    }
    $('proofTitle').textContent = 'Established ' + body + ' analogs beat ordinary places in ' + pct(v.auc) + '% of head-to-head comparisons';
    $('proofSub').textContent = 'Each dot is a place’s best score across all ' + body + ' targets. If the model works, the analogs mission teams already use should sit to the right of ordinary farmland and forest. AUC ' +
      v.auc.toFixed(2) + ' from ' + v.pairs + ' pairs (0.5 would be a coin flip).' + (META.mode === 'seed estimates' ? ' Seed estimates: re-run after the data pipeline.' : '');
    $('proofFind').innerHTML = v.discoveries.length ?
      '<b>New candidates:</b> these less-studied places score at least as well as the typical established ' + body + ' analog: ' +
      v.discoveries.slice(0, 6).map(function (d) { return '<a href="#" data-pick="' + esc(d.site.id) + '">' + esc(d.site.name) + '</a> (' + pct(d.score) + ')'; }).join(', ') + '.' :
      'No less-studied place scores as well as the typical established analog with these weights.';
    drawProof();
  }

  function drawProof() {
    var fig = $('proofFig'), v = proofData;
    if (!v || v.auc === null) { fig.innerHTML = ''; return; }
    var W = fig.clientWidth || 700, H = fig.clientHeight || 220;
    var narrow = W < 520, left = narrow ? 8 : 190, right = 16, top = 14;
    var rows = [
      { key: 'known', label: 'Established analogs', list: v.known, cls: 'dp-known' },
      { key: 'less', label: 'Less-studied places', list: v.lessStudied, cls: 'dp-less' },
      { key: 'ctl', label: 'Ordinary places', list: v.controls, cls: 'dp-ctl' }
    ];
    var rowH = (H - top - 34) / rows.length;
    var x = function (s) { return left + s * (W - left - right); };
    var html = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (tk) {
      html += '<line class="dp-axis" x1="' + x(tk) + '" x2="' + x(tk) + '" y1="' + top + '" y2="' + (H - 26) + '"/>' +
        '<text class="dp-tick" x="' + x(tk) + '" y="' + (H - 8) + '">' + Math.round(tk * 100) + '</text>';
    });
    rows.forEach(function (row, i) {
      var cy = top + rowH * (i + 0.5);
      html += narrow ? '<text class="dp-row" x="' + left + '" y="' + (cy - rowH * 0.32) + '">' + row.label + ' (' + row.list.length + ')</text>' :
        '<text class="dp-row" x="0" y="' + (cy + 4) + '">' + row.label + ' (' + row.list.length + ')</text>';
      row.list.forEach(function (d, j) {
        var jitter = ((j * 37) % 7 - 3) * Math.min(4, rowH / 10);
        html += '<circle class="dp-dot ' + row.cls + '" data-tip="' + esc(d.site.name + ': ' + pct(d.score) + ' (best for ' + d.bestTarget.name + ')') +
          '" cx="' + x(d.score).toFixed(1) + '" cy="' + (cy + jitter + (narrow ? 6 : 0)).toFixed(1) + '" r="6"/>';
      });
    });
    if (v.median !== null) {
      html += '<line class="dp-med" x1="' + x(v.median) + '" x2="' + x(v.median) + '" y1="' + (top - 6) + '" y2="' + (H - 26) + '"/>' +
        '<text class="dp-medlab" x="' + (x(v.median) + (x(v.median) > W * 0.6 ? -6 : 6)) + '" y="' + (top + 2) + '" text-anchor="' + (x(v.median) > W * 0.6 ? 'end' : 'start') + '">' + (narrow ? 'Typical analog (' : 'Typical established analog (') + pct(v.median) + ')</text>';
    }
    fig.innerHTML = '<svg role="img" aria-label="Dot plot of best scores for established analogs, less-studied places and ordinary places">' + html + '</svg>';
  }

  // ---------------------------------------------------------------- extras ----
  function copyProfile() {
    var r = resultFor(state.selectedId), t = target();
    if (!r) return;
    var g = S.gapReport(r, ranking, cfg);
    var profile = {
      site: { id: r.site.id, name: r.site.name, country: r.site.country, lat: r.site.lat, lon: r.site.lon, status: r.site.status, program: r.site.program },
      target: { id: t.id, name: t.name, body: t.body },
      weights: state.weights,
      match: pct(r.total),
      dimensions: ranking.dims.reduce(function (o, d) { o[d] = r.dims[d].score === null ? null : pct(r.dims[d].score); return o; }, {}),
      features: g.items.map(function (i) { return { feature: i.label, here: i.earthText, target: i.targetText, status: i.status, testInstead: i.mitigation }; }),
      sources: r.site.src,
      generated: META.generated
    };
    var btn = $('copyBtn'), text = JSON.stringify(profile, null, 2);
    var done = function (msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = 'Copy site profile (JSON)'; }, 2200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { done('Copy blocked by the browser'); });
    } else done('Copy not supported here');
  }

  function renderStatus() {
    var live = META.mode && META.mode !== 'seed estimates';
    $('dataStatus').textContent = live ? 'Live NASA data, built ' + META.generated : 'Seed estimates. Run the data pipeline for live NASA values.';
    $('dataStatus').classList.toggle('live', !!live);
    var counts = META.valueSources || {};
    $('footData').textContent = 'Data: ' + (META.sites || SITES.length) + ' Earth places, ' + TARGETS.length + ' Moon and Mars targets. Values by source: ' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; }).join(', ') + '. Built ' + (META.generated || 'unknown') + '.';
  }

  var tip = $('tip');
  function showTip(text, x, y) {
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, x + 14) + 'px';
    tip.style.top = Math.max(8, y - h - 10) + 'px';
  }
  $('proofFig').addEventListener('mousemove', function (e) { showTip(e.target.getAttribute && e.target.getAttribute('data-tip'), e.clientX, e.clientY); });
  $('proofFig').addEventListener('mouseleave', function () { showTip(null); });

  function onThemeChange() { if (mapView) mapView.refreshTheme(); }

  // ----------------------------------------------------------------- start ----
  function start() {
    if (!TARGETS.length || !SITES.length) {
      $('targetName').textContent = 'No data loaded';
      $('targetWhy').textContent = 'Check that data/targets.js and data/earth_sites.js exist (run: python pipeline/build_dataset.py --offline).';
      return;
    }
    var fromHash = location.hash.slice(1);
    if (TARGETS.some(function (t) { return t.id === fromHash; })) state.targetId = fromHash;
    initControls();
    renderStatus();
    recompute();
    if (window.ResizeObserver) new ResizeObserver(drawProof).observe($('proofFig'));
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onThemeChange);
    new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    var useSvg = /[?&]map=svg/.test(location.search);
    window.AnalogMap.create($('map'), {
      onSelect: function (id) { select(id, false); },
      onHover: function (id, x, y) {
        var r = id && resultFor(id);
        showTip(r ? r.site.name + ': ' + pct(r.total) + (r.rank ? ' (#' + r.rank + ')' : '') : null, x, y);
      },
      onSatelliteError: function () {
        $('attrib').textContent = 'NASA imagery could not load (offline or blocked). The map still works.';
      }
    }, { forceSvg: useSvg }).then(function (view) {
      mapView = view;
      if (view.kind !== 'maplibre') {
        $('globeBtn').disabled = true;
        $('satBtn').disabled = true;
        $('attrib').textContent = 'Basemap: Natural Earth (offline map).';
      }
      renderMap();
      var top = resultFor(state.selectedId);
      if (top) view.focus(top.site.lon, top.site.lat);
    });
  }
  start();
})();
