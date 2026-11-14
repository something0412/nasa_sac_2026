// =============================================================================
// map.js — draws the world and the Earth sites.
//
// Two renderers with the same small interface:
//   1. MapLibre GL (3D globe or flat map, smooth zoom, optional NASA imagery).
//   2. A plain SVG world map (Equal Earth projection) used when MapLibre can't
//      load: no internet, no WebGL, or a strict page sandbox. The demo never
//      shows a blank map.
// The basemap (land + borders) ships in data/basemap.js, so neither renderer
// needs a tile server.
//
// Interface:  AnalogMap.create(el, { onSelect(id), onHover(id|null, x, y) })
//   .then(view => view.setSites(features)  // [{id,lon,lat,score,rank,status,selected,muted}]
//                 view.focus(lon, lat, close) // fly to a site (close = zoom in)
//                 view.setGlobe(bool)      // MapLibre only
//                 view.setSatellite(bool)  // MapLibre only, needs internet
//                 view.refreshTheme())
// =============================================================================
(function () {
  'use strict';

  var MAPLIBRE_LOCAL = 'vendor/maplibre-gl.js';
  var MAPLIBRE_CDN = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  // NASA GIBS Blue Marble (shaded relief + bathymetry), Web Mercator tiles, zoom 0-8.
  var GIBS_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

  // ---- colours come from CSS variables so light/dark themes stay in one place
  var probe;
  function cssColor(name) {
    if (!probe) {
      probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
    }
    probe.style.color = 'var(' + name + ')';
    return getComputedStyle(probe).color;
  }
  function theme() {
    var ramp = [];
    for (var i = 0; i < 6; i++) ramp.push(cssColor('--s' + i));
    return {
      ocean: cssColor('--map-ocean'), land: cssColor('--map-land'), border: cssColor('--map-border'),
      grat: cssColor('--map-grat'), ink: cssColor('--ink'), paper: cssColor('--paper'),
      muted: cssColor('--muted'), ramp: ramp
    };
  }
  /** Score 0-100 -> one of six colour steps (same bins as the legend). */
  function level(score) {
    return score >= 80 ? 5 : score >= 70 ? 4 : score >= 60 ? 3 : score >= 50 ? 2 : score >= 40 ? 1 : 0;
  }

  function graticule(step) {
    var lines = [];
    for (var lon = -180; lon <= 180; lon += step) {
      var c = [];
      for (var lat = -85; lat <= 85; lat += 5) c.push([lon, lat]);
      lines.push(c);
    }
    for (var la = -60; la <= 60; la += step) {
      var r = [];
      for (var lo = -180; lo <= 180; lo += 5) r.push([lo, la]);
      lines.push(r);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
  }

  // ---------------------------------------------------------------------------
  // Loading MapLibre: local copy first (works offline), then the CDN.
  function loadScript(src, ms) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('timeout ' + src)); }, ms);
      s.src = src;
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); s.remove(); reject(new Error('failed ' + src)); };
      document.head.appendChild(s);
    });
  }
  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (!webglAvailable()) return Promise.reject(new Error('no WebGL'));
    var check = function () { if (!window.maplibregl) throw new Error('MapLibre missing'); };
    return loadScript(MAPLIBRE_LOCAL, 4000).then(check)
      .catch(function () { return loadScript(MAPLIBRE_CDN, 8000).then(check); });
  }

  // ---------------------------------------------------------------------------
  // Renderer 1: MapLibre GL
  function MapLibreView(el, handlers) {
    var c = theme();
    var empty = { type: 'FeatureCollection', features: [] };
    var map = new window.maplibregl.Map({
      container: el,
      attributionControl: false,
      center: [10, 22], zoom: Math.log2(Math.max(200, Math.min(el.clientWidth, el.clientHeight)) / 165), minZoom: -2, maxZoom: 9,
      dragRotate: false, pitchWithRotate: false, renderWorldCopies: false,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          land: { type: 'geojson', data: window.BASEMAP.land },
          borders: { type: 'geojson', data: window.BASEMAP.borders },
          grat: { type: 'geojson', data: graticule(30) },
          sites: { type: 'geojson', data: empty }
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': c.ocean } },
          { id: 'grat', type: 'line', source: 'grat', paint: { 'line-color': c.grat, 'line-width': 0.6 } },
          { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': c.land } },
          { id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': c.border, 'line-width': 0.6 } },
          { id: 'sel', type: 'circle', source: 'sites', filter: ['==', ['get', 'selected'], true],
            paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2.5, 'circle-stroke-color': c.ink } },
          { id: 'sites', type: 'circle', source: 'sites',
            paint: {
              'circle-radius': ['case', ['==', ['get', 'muted'], true], 4, ['interpolate', ['linear'], ['get', 'score'], 0, 4.5, 100, 9]],
              'circle-color': ['get', 'color'],
              'circle-stroke-width': 1.5, 'circle-stroke-color': c.paper,
              'circle-opacity': ['case', ['==', ['get', 'muted'], true], 0.55, 1]
            } },
          { id: 'ranks', type: 'symbol', source: 'sites', filter: ['all', ['has', 'rank'], ['<=', ['get', 'rank'], 10]],
            layout: { 'icon-image': ['concat', 'rank-', ['to-string', ['get', 'rank']]], 'icon-allow-overlap': true,
              'icon-ignore-placement': true, 'icon-anchor': 'bottom', 'icon-offset': [0, -9] } }
        ]
      }
    });

    function rankIcons(col) {
      for (var n = 1; n <= 10; n++) {
        var ratio = 2, w = 22 * ratio, h = 18 * ratio;
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var g = cv.getContext('2d');
        g.fillStyle = col.paper; g.strokeStyle = col.ink; g.lineWidth = 1.5 * ratio;
        var r = 5 * ratio;
        g.beginPath();
        g.moveTo(r, 1); g.lineTo(w - r, 1); g.quadraticCurveTo(w - 1, 1, w - 1, r);
        g.lineTo(w - 1, h - r); g.quadraticCurveTo(w - 1, h - 1, w - r, h - 1);
        g.lineTo(r, h - 1); g.quadraticCurveTo(1, h - 1, 1, h - r); g.lineTo(1, r); g.quadraticCurveTo(1, 1, r, 1);
        g.fill(); g.stroke();
        g.fillStyle = col.ink;
        g.font = '600 ' + (11 * ratio) + 'px "Public Sans", system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(n), w / 2, h / 2 + ratio);
        var img = g.getImageData(0, 0, w, h);
        if (map.hasImage('rank-' + n)) map.updateImage('rank-' + n, img);
        else map.addImage('rank-' + n, img, { pixelRatio: ratio });
      }
    }

    // If the map hasn't finished loading in 8 s (blocked worker, broken GPU),
    // give up and let the caller fall back to the SVG map.
    var ready = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { try { map.remove(); } catch (e) { /* ignore */ } reject(new Error('map load timeout')); }, 8000);
      map.on('load', function () { clearTimeout(timer); rankIcons(c); resolve(); });
    });
    map.on('click', 'sites', function (e) { if (e.features && e.features[0]) handlers.onSelect(e.features[0].properties.id); });
    map.on('mousemove', 'sites', function (e) {
      map.getCanvas().style.cursor = 'pointer';
      if (e.features && e.features[0]) handlers.onHover(e.features[0].properties.id, e.originalEvent.clientX, e.originalEvent.clientY);
    });
    map.on('mouseleave', 'sites', function () { map.getCanvas().style.cursor = ''; handlers.onHover(null); });
    map.on('error', function (e) {
      if (e && e.sourceId === 'sat' && handlers.onSatelliteError) handlers.onSatelliteError();
    });

    var lastFeatures = [];
    var isGlobe = true;
    // Zoom at which the whole globe nearly fills the map box (measured: at zoom 0
    // the globe is about 135 px across).
    function wideZoom() { return Math.log2(Math.max(200, Math.min(el.clientWidth, el.clientHeight)) / 165); }
    function toGeoJSON(features, col) {
      return {
        type: 'FeatureCollection',
        features: features.map(function (f) {
          var p = { id: f.id, score: f.score, selected: !!f.selected, muted: !!f.muted, color: f.muted ? col.muted : col.ramp[level(f.score)] };
          if (f.rank) p.rank = f.rank;
          return { type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } };
        })
      };
    }

    return ready.then(function () {
      window.AnalogMap.map = map; // handy in the browser console: AnalogMap.map.getZoom()
      return {
        kind: 'maplibre',
        setSites: function (features) {
          lastFeatures = features;
          map.getSource('sites').setData(toGeoJSON(features, c));
        },
        // close=false: swing the globe toward the site but keep the wide view.
        // On the globe MapLibre scales zoom with latitude (to match Mercator),
        // so we subtract log2(1/cos(lat)) to keep the globe the same size.
        focus: function (lon, lat, close) {
          var cLat = Math.max(close ? -80 : -60, Math.min(close ? 80 : 60, lat));
          var adjust = isGlobe ? Math.log2(Math.max(0.05, Math.cos(cLat * Math.PI / 180))) : 0;
          map.flyTo({ center: [lon, cLat], zoom: (close ? 2.6 : wideZoom()) + adjust, speed: 1.4, essential: true });
        },
        setGlobe: function (on) { isGlobe = on; map.setProjection({ type: on ? 'globe' : 'mercator' }); },
        setSatellite: function (on) {
          if (on && !map.getSource('sat')) {
            map.addSource('sat', { type: 'raster', tiles: [GIBS_TILES], tileSize: 256, maxzoom: 8 });
            map.addLayer({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 0.95 } }, 'borders');
          } else if (!on && map.getSource('sat')) {
            map.removeLayer('sat');
            map.removeSource('sat');
          }
        },
        refreshTheme: function () {
          c = theme();
          map.setPaintProperty('ocean', 'background-color', c.ocean);
          map.setPaintProperty('grat', 'line-color', c.grat);
          map.setPaintProperty('land', 'fill-color', c.land);
          map.setPaintProperty('borders', 'line-color', c.border);
          map.setPaintProperty('sel', 'circle-stroke-color', c.ink);
          map.setPaintProperty('sites', 'circle-stroke-color', c.paper);
          rankIcons(c);
          map.getSource('sites').setData(toGeoJSON(lastFeatures, c));
        },
        resize: function () { map.resize(); }
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Renderer 2: SVG world map, Equal Earth projection (Šavrič et al. 2018).
  function equalEarth(lon, lat) {
    var A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
    var l = lon * Math.PI / 180, p = lat * Math.PI / 180;
    var t = Math.asin(M * Math.sin(p)), t2 = t * t, t6 = t2 * t2 * t2;
    var x = l * Math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
    var y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
    return [x, y];
  }

  function SvgView(el, handlers) {
    var NS = 'http://www.w3.org/2000/svg';
    el.innerHTML = '';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'svgmap');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'World map of Earth analog sites, coloured by match score');
    el.appendChild(svg);
    var features = [];
    var X = equalEarth(180, 0)[0], Y = equalEarth(0, 90)[1];

    function ringsOf(geom) {
      if (geom.type === 'Polygon') return geom.coordinates;
      if (geom.type === 'MultiPolygon') return [].concat.apply([], geom.coordinates);
      if (geom.type === 'LineString') return [geom.coordinates];
      if (geom.type === 'MultiLineString') return geom.coordinates;
      return [];
    }
    function pathOf(fc, proj, close) {
      var d = '';
      fc.features.forEach(function (f) {
        ringsOf(f.geometry).forEach(function (ring) {
          ring.forEach(function (pt, i) {
            var q = proj(pt[0], pt[1]);
            d += (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
          });
          if (close) d += 'Z';
        });
      });
      return d;
    }

    function draw() {
      var W = el.clientWidth || 600, H = el.clientHeight || 360, pad = 12;
      var k = Math.min((W - 2 * pad) / (2 * X), (H - 2 * pad) / (2 * Y));
      var cx = W / 2, cy = H / 2;
      var proj = function (lon, lat) { var q = equalEarth(lon, lat); return [cx + q[0] * k, cy - q[1] * k]; };
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      var outline = [];
      for (var la = -90; la <= 90; la += 5) outline.push(proj(-180, la));
      for (var lb = 90; lb >= -90; lb -= 5) outline.push(proj(180, lb));
      var html = '<path class="sm-ocean" d="M' + outline.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('L') + 'Z"/>';
      html += '<path class="sm-land" d="' + pathOf(window.BASEMAP.land, proj, true) + '"/>';
      html += '<path class="sm-border" d="' + pathOf(window.BASEMAP.borders, proj, false) + '"/>';
      var sorted = features.slice().sort(function (a, b) { return (a.selected - b.selected) || (a.score - b.score); });
      sorted.forEach(function (f) {
        var p = proj(f.lon, f.lat);
        var r = f.muted ? 4 : 4.5 + f.score / 100 * 4.5;
        if (f.selected) html += '<circle class="sm-sel" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="13"/>';
        html += '<circle class="sm-site ' + (f.muted ? 'sm-muted' : 'sm-l' + level(f.score)) + '" data-id="' + f.id + '" cx="' +
          p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r.toFixed(1) + '"/>';
      });
      sorted.filter(function (f) { return f.rank && f.rank <= 10; }).forEach(function (f) {
        var p = proj(f.lon, f.lat);
        html += '<g class="sm-rank" transform="translate(' + p[0].toFixed(1) + ' ' + (p[1] - 18).toFixed(1) + ')"><rect x="-11" y="-9" width="22" height="17" rx="5"/><text y="4">' + f.rank + '</text></g>';
      });
      svg.innerHTML = html;
    }

    svg.addEventListener('click', function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-id');
      if (id) handlers.onSelect(id);
    });
    svg.addEventListener('mousemove', function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-id');
      handlers.onHover(id || null, e.clientX, e.clientY);
    });
    svg.addEventListener('mouseleave', function () { handlers.onHover(null); });
    if (window.ResizeObserver) new ResizeObserver(draw).observe(el);

    return Promise.resolve({
      kind: 'svg',
      setSites: function (f) { features = f; draw(); },
      focus: function () {},
      setGlobe: function () {},
      setSatellite: function () {},
      refreshTheme: draw,
      resize: draw
    });
  }

  window.AnalogMap = {
    level: level,
    create: function (el, handlers, opts) {
      opts = opts || {};
      if (opts.forceSvg) return SvgView(el, handlers);
      return loadMapLibre()
        .then(function () { return MapLibreView(el, handlers); })
        .catch(function (err) {
          if (window.console) console.info('Analog Finder: using the offline SVG map (' + err.message + ').');
          return SvgView(el, handlers);
        });
    }
  };
})();
