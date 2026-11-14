// =============================================================================
// scoring.js — the brain of Analog Finder. Pure functions, no web page code,
// so the same file runs in the browser AND in Node tests (tests/scoring.test.js).
//
// The idea in one paragraph:
//   For each feature (slope, coldest temperature, ...) we compare an Earth
//   site's value with the target's value. The closer they are, the higher the
//   score, using a bell curve whose width is the tolerance "sigma" set in
//   config.js. If the target is outside anything Earth can reach (the Moon's
//   -190 °C nights), we score against the closest Earth CAN get instead and
//   flag the gap, so the ranking stays meaningful and the gap is reported
//   honestly. Feature scores average into five dimension scores; the sliders
//   weight the dimensions into one 0-100 match.
// =============================================================================
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnalogScoring = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- small helpers ------------------------------------------------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** Noon Sun height at equinox, in degrees: 90 minus the absolute latitude. */
  function sunElevation(lat) { return 90 - Math.abs(lat); }

  /** Rough air pressure at an elevation (scale-height model), in kPa. */
  function pressureKpa(elevationM) {
    return 101.325 * Math.exp(-(isNum(elevationM) ? elevationM : 0) / 8434);
  }

  /** Great-circle distance between two {lat, lon} points, in km. */
  function haversineKm(a, b) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Features measured on log scales are compared after this transform.
  function transform(f, v) {
    if (f.scale === 'log') return Math.log10(Math.max(v, 1));
    if (f.scale === 'log1p') return Math.log10(Math.max(v, 0) + 1);
    return v;
  }
  function untransform(f, t) {
    if (f.scale === 'log') return Math.pow(10, t);
    if (f.scale === 'log1p') return Math.pow(10, t) - 1;
    return t;
  }

  // ---------- reading values -----------------------------------------------
  function earthValue(site, key, cfg) {
    var f = cfg.features[key];
    if (f.derived === 'lat') return sunElevation(site.lat);
    var v = site[key];
    return isNum(v) ? v : null;
  }

  function targetValue(target, key, cfg) {
    var v = target.features ? target.features[key] : undefined;
    if (v === undefined || v === null) return null;
    if (v === 'auto' && cfg.features[key].derived === 'lat') return sunElevation(target.lat);
    return v;
  }

  /** Dimensions that have at least one feature defined for this target. */
  function activeDims(target, cfg) {
    return cfg.dims.filter(function (d) {
      return Object.keys(cfg.features).some(function (k) {
        return cfg.features[k].dim === d.id && targetValue(target, k, cfg) !== null;
      });
    }).map(function (d) { return d.id; });
  }

  /** Earth's reachable range for every numeric feature, in transformed units. */
  function earthEnvelope(sites, cfg) {
    var env = {};
    Object.keys(cfg.features).forEach(function (k) {
      var f = cfg.features[k];
      if (f.kind === 'category') return;
      var lo = Infinity, hi = -Infinity;
      sites.forEach(function (s) {
        var v = earthValue(s, k, cfg);
        if (v === null) return;
        var t = transform(f, v);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      });
      env[k] = lo <= hi ? [lo, hi] : [-Infinity, Infinity];
    });
    return env;
  }

  // ---------- scoring ------------------------------------------------------
  /**
   * Score one numeric feature. Returns score in 0..1 plus diagnostics:
   *   beyond  - true if even the best place on Earth can't get within one sigma
   *   reach   - the closest value Earth can reach (raw units)
   */
  function featureScore(f, earthVal, targetVal, envelope) {
    if (earthVal === null) return { score: 0.5, missing: true, beyond: false, reach: null };
    var te = transform(f, targetVal), ee = transform(f, earthVal);
    var lo = envelope ? envelope[0] : -Infinity, hi = envelope ? envelope[1] : Infinity;
    var tEff = clamp(te, lo, hi);
    var z = (ee - tEff) / f.sigma;
    return {
      score: Math.exp(-0.5 * z * z),
      z: z,
      beyond: Math.abs(te - tEff) > f.sigma,
      reach: untransform(f, tEff)
    };
  }

  /** Rock-type similarity: best pairing of the site's rocks with the target's. */
  function rockScore(site, targetRocks, cfg) {
    if (!site.rock) return { score: 0.5, pair: null, missing: true }; // unknown rock: neutral
    var sim = cfg.rockSimilarity, w = cfg.rockSecondaryWeight;
    var earthRocks = [[site.rock, 1], [site.rock2, w.earth]].filter(function (r) { return r[0]; });
    var best = 0, pair = null;
    (targetRocks || []).forEach(function (tr, i) {
      var wt = i === 0 ? 1 : w.target;
      earthRocks.forEach(function (er) {
        var s = ((sim[er[0]] || {})[tr] || 0) * er[1] * wt;
        if (s > best) { best = s; pair = [er[0], tr]; }
      });
    });
    return { score: best, pair: pair };
  }

  /** Score one Earth site against one target. */
  function scoreSite(site, target, weights, cfg, env) {
    var dims = {};
    cfg.dims.forEach(function (d) { dims[d.id] = { sum: 0, n: 0, features: [], score: null }; });

    Object.keys(cfg.features).forEach(function (k) {
      var f = cfg.features[k];
      var t = targetValue(target, k, cfg);
      if (t === null) return;
      var r;
      if (f.kind === 'category') {
        var rs = rockScore(site, t, cfg);
        r = { key: k, score: rs.score, earth: site.rock, earth2: site.rock2 || null, target: t, pair: rs.pair, beyond: false, missing: !!rs.missing };
      } else {
        var e = earthValue(site, k, cfg);
        var fs = featureScore(f, e, t, env[k]);
        r = { key: k, score: fs.score, earth: e, target: t, beyond: fs.beyond, reach: fs.reach, missing: !!fs.missing };
      }
      dims[f.dim].features.push(r);
      dims[f.dim].sum += r.score;
      dims[f.dim].n += 1;
    });

    var num = 0, den = 0;
    cfg.dims.forEach(function (d) {
      var D = dims[d.id];
      D.score = D.n ? D.sum / D.n : null;
      var w = weights[d.id] || 0;
      if (D.score !== null && w > 0) { num += w * D.score; den += w; }
    });
    return { site: site, total: den ? num / den : 0, dims: dims };
  }

  /**
   * Rank every Earth site for a target. Control sites get scores (for
   * validation) but no rank number.
   */
  function rankSites(sites, target, weights, cfg, opts) {
    opts = opts || {};
    var env = opts.env || earthEnvelope(sites, cfg);
    var results = sites.map(function (s) { return scoreSite(s, target, weights, cfg, env); });
    results.sort(function (a, b) { return b.total - a.total || a.site.name.localeCompare(b.site.name); });
    var rank = 0;
    results.forEach(function (r) { r.rank = r.site.status === 'control' ? null : ++rank; });

    // The best non-control site for each feature, used by the gap report.
    var bestByFeature = {};
    results.forEach(function (r) {
      if (r.site.status === 'control') return;
      Object.keys(r.dims).forEach(function (d) {
        r.dims[d].features.forEach(function (fr) {
          var b = bestByFeature[fr.key];
          if (!b || fr.score > b.score) bestByFeature[fr.key] = { site: r.site, score: fr.score };
        });
      });
    });
    return { target: target, results: results, env: env, bestByFeature: bestByFeature, dims: activeDims(target, cfg) };
  }

  // ---------- words ----------------------------------------------------------
  function fmtNum(v, digits) {
    if (!isNum(v)) return '-';
    var d = digits === undefined ? 0 : digits;
    var s = Math.abs(v) >= 1000 && d === 0 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d);
    return s.replace('-', '−');
  }

  /** Human-readable value for any feature, e.g. "-38 °C", "ice-rich", "Basalt". */
  function formatValue(cfg, key, v) {
    var f = cfg.features[key];
    if (v === null || v === undefined) return 'no data';
    if (f.kind === 'category') {
      var list = (Array.isArray(v) ? v : [v]).filter(Boolean);
      return list.length ? list.map(function (r) { return (cfg.rockLabels[r] || r); }).join(' + ') : 'no data';
    }
    if (f.kind === 'yesno') return v >= 0.5 ? 'yes' : 'no';
    if (f.kind === 'level') return v >= 0.75 ? 'ice-rich' : v >= 0.25 ? 'patchy' : 'none';
    return fmtNum(v, f.digits) + (f.unit || '');
  }

  function status(score, cfg) {
    return score >= cfg.thresholds.holds ? 'holds' : score >= cfg.thresholds.partial ? 'partial' : 'breaks';
  }

  /**
   * "Where the analogy breaks down" for one site and target: every compared
   * feature with Earth vs target values, plus the conditions Earth can never match.
   */
  function gapReport(result, ranking, cfg) {
    var target = ranking.target, site = result.site;
    var items = [];
    cfg.dims.forEach(function (d) {
      result.dims[d.id].features.forEach(function (fr) {
        var f = cfg.features[fr.key];
        var st = status(fr.score, cfg);
        var best = ranking.bestByFeature[fr.key];
        var item = {
          key: fr.key, dim: d.id, label: f.label, status: st, score: fr.score,
          earthText: fr.key === 'rock' ? formatValue(cfg, 'rock', [site.rock, site.rock2]) : formatValue(cfg, fr.key, fr.earth),
          targetText: formatValue(cfg, fr.key, fr.target),
          beyond: !!fr.beyond, missing: !!fr.missing,
          reachText: fr.beyond ? formatValue(cfg, fr.key, fr.reach) : null,
          mitigation: null, betterSite: null
        };
        if (fr.beyond) item.mitigation = cfg.mitigations[fr.key] || null;
        else if (st !== 'holds') {
          if (best && best.site.id !== site.id && best.score >= fr.score + 0.15) item.betterSite = best.site;
          else item.mitigation = cfg.mitigations[fr.key] || null;
        }
        items.push(item);
      });
    });
    var order = { breaks: 0, partial: 1, holds: 2 };
    items.sort(function (a, b) { return order[a.status] - order[b.status] || a.score - b.score; });

    var body = cfg.bodies[target.body], earth = cfg.bodies.earth;
    var pHere = pressureKpa(site.elevation_m);
    var pThere = target.env ? target.env.pressure_kpa : null;
    var pressureText;
    if (target.body === 'moon' || !pThere) pressureText = fmtNum(pHere, 0) + ' kPa here vs ' + (body.pressureText || 'near-vacuum') + ' on the ' + body.label + '.';
    else pressureText = fmtNum(pHere, 0) + ' kPa here vs ' + fmtNum(pThere, 1) + ' kPa at the target, about ' + fmtNum(pHere / pThere, 0) + ' times thinner.';
    var radRatio = body.radiation_msv_day / earth.radiation_msv_day;
    var universal = [
      { key: 'gravity', label: 'Gravity', text: body.label + ' gravity is ' + fmtNum(body.gravity / earth.gravity * 100, 0) + '% of Earth\'s.', test: cfg.universalTests.gravity },
      { key: 'pressure', label: 'Air pressure', text: pressureText, test: body.vacuumTest },
      { key: 'radiation', label: 'Radiation', text: 'Surface dose is about ' + fmtNum(radRatio, 0) + ' times Earth\'s' + (target.env && target.env.sheltered ? '; a cave roof would block much of it.' : '.'), test: cfg.universalTests.radiation },
      { key: 'dust', label: 'Dust', text: body.dust, test: null }
    ];
    var counts = { holds: 0, partial: 0, breaks: 0 };
    items.forEach(function (i) { counts[i.status]++; });
    return { items: items, universal: universal, counts: counts };
  }

  /**
   * Best k-site test campaign. Greedy max-coverage: each pick adds the most
   * weighted "best score so far" across dimensions. Picks must be at least
   * minKm apart so the campaign doesn't spend two slots on one region.
   * (Without the distance rule, greedy is guaranteed at least 63% of the best
   * possible campaign, a known result for coverage objectives like this one;
   * tests/scoring.test.js also checks it against brute force.)
   */
  function portfolio(ranking, weights, cfg, opts) {
    opts = opts || {};
    var k = opts.k || 3, minKm = opts.minKm === undefined ? 300 : opts.minKm;
    var dims = ranking.dims.filter(function (d) { return (weights[d] || 0) > 0; });
    var pool = ranking.results.filter(function (r) { return r.site.status !== 'control'; });
    var W = dims.reduce(function (a, d) { return a + weights[d]; }, 0);
    var cover = {};
    dims.forEach(function (d) { cover[d] = 0; });
    var picks = [];
    for (var i = 0; i < k; i++) {
      var best = null, bestVal = -1;
      pool.forEach(function (r) {
        if (picks.indexOf(r) >= 0) return;
        if (picks.some(function (p) { return haversineKm(p.site, r.site) < minKm; })) return;
        var v = 0;
        dims.forEach(function (d) { v += weights[d] * Math.max(cover[d], r.dims[d].score || 0); });
        if (v > bestVal + 1e-12) { bestVal = v; best = r; }
      });
      if (!best) break;
      picks.push(best);
      dims.forEach(function (d) { cover[d] = Math.max(cover[d], best.dims[d].score || 0); });
    }
    var owners = {};
    dims.forEach(function (d) {
      picks.forEach(function (p) { if (!owners[d] || (p.dims[d].score || 0) > (owners[d].dims[d].score || 0)) owners[d] = p; });
    });
    var coverage = W ? dims.reduce(function (a, d) { return a + weights[d] * cover[d]; }, 0) / W : 0;
    return { picks: picks, cover: cover, owners: owners, dims: dims, coverage: coverage, bestSingle: pool.length ? pool[0].total : 0 };
  }

  /**
   * Does the model work? Each established analog was picked by a mission team
   * for SOME environment on its body, so it should score well against at
   * least one target there. We take every site's best score across the body's
   * targets and check that established analogs beat ordinary control places.
   * AUC = share of (analog, control) pairs the analog wins: 0.5 is a coin
   * flip, 1.0 is perfect. Less-studied places that score as high as the
   * typical established analog are the discovery candidates.
   */
  function validate(sites, targets, body, weights, cfg, env) {
    env = env || earthEnvelope(sites, cfg);
    var bodyTargets = targets.filter(function (t) { return t.body === body; });
    var rows = sites.map(function (s) {
      var best = null;
      bodyTargets.forEach(function (t) {
        var total = scoreSite(s, t, weights, cfg, env).total;
        if (!best || total > best.score) best = { score: total, target: t };
      });
      return { site: s, score: best ? best.score : 0, bestTarget: best ? best.target : null };
    });
    var known = rows.filter(function (r) { return r.site.status === 'established' && (r.site.known_for || []).indexOf(body) >= 0; });
    var controls = rows.filter(function (r) { return r.site.status === 'control'; });
    var lessStudied = rows.filter(function (r) { return r.site.status === 'less-studied'; });
    var wins = 0, n = 0;
    known.forEach(function (a) {
      controls.forEach(function (c) { n++; wins += a.score > c.score ? 1 : a.score === c.score ? 0.5 : 0; });
    });
    var ks = known.map(function (r) { return r.score; }).sort(function (a, b) { return a - b; });
    var median = ks.length ? (ks.length % 2 ? ks[(ks.length - 1) / 2] : (ks[ks.length / 2 - 1] + ks[ks.length / 2]) / 2) : null;
    var discoveries = median === null ? [] : lessStudied.filter(function (r) { return r.score >= median; })
      .sort(function (a, b) { return b.score - a.score; });
    return { body: body, auc: n ? wins / n : null, pairs: n, known: known, controls: controls, lessStudied: lessStudied, median: median, discoveries: discoveries };
  }

  /** How many established analogs for the target's body sit in this ranking's top 10. */
  function knownInTop(ranking, k) {
    var body = ranking.target.body;
    return ranking.results.filter(function (r) { return r.rank !== null && r.rank <= (k || 10); })
      .filter(function (r) { return r.site.status === 'established' && (r.site.known_for || []).indexOf(body) >= 0; }).length;
  }

  /** For one Earth site: which targets it serves best (for the site profile). */
  function bestTargetsForSite(site, targets, sites, weights, cfg, env) {
    env = env || earthEnvelope(sites, cfg);
    return targets.map(function (t) {
      return { target: t, total: scoreSite(site, t, weights, cfg, env).total };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  return {
    sunElevation: sunElevation, pressureKpa: pressureKpa, haversineKm: haversineKm,
    transform: transform, earthValue: earthValue, targetValue: targetValue,
    activeDims: activeDims, earthEnvelope: earthEnvelope, featureScore: featureScore,
    rockScore: rockScore, scoreSite: scoreSite, rankSites: rankSites,
    formatValue: formatValue, fmtNum: fmtNum, status: status, gapReport: gapReport,
    portfolio: portfolio, validate: validate, knownInTop: knownInTop, bestTargetsForSite: bestTargetsForSite
  };
});
