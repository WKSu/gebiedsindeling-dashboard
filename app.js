/* Parkeersectoren -> TIR-gebiedsindeling
 *
 * Alle ruimtelijke rekenwerk zit in build_data.py. Deze laag doet niets anders dan
 * atomen optellen, sorteren en tekenen. Zie README.md voor de gegevensafspraak.
 */
(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════ 1. CONFIG ══ */

  var CFG = {
    FULL_PCT: 99.5,
    MOSTLY_PCT: 50,
    DEFAULT_THRESHOLD: 10,
    EPS: 1e-9,
    MAX_SVG_FEATURES: 400,
    MAX_SUGGEST: 10,
    LABEL_MIN_ZOOM: 13,
    CENTER: [51.9225, 4.4792],
    ZOOM: 12,
    BRT: "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png",
    ATTRIB: 'Kaart: &copy; <a href="https://www.pdok.nl">PDOK</a> / Kadaster &mdash; BRT Achtergrondkaart',
  };

  var LEVELS = {
    sbd: { width: null, label: "subbuurtdeel", plural: "subbuurtdelen", geo: "sbd" },
    sb: { width: 5, label: "subbuurt", plural: "subbuurten", geo: "sb" },
    bu: { width: 4, label: "buurt", plural: "buurten", geo: "bu" },
  };

  var GEO_SRC = {
    sbd: { global: "GD_GEO_SBD", file: "gen/geo_subbuurtdelen.js" },
    sb: { global: "GD_GEO_SB", file: "gen/geo_subbuurten.js" },
    bu: { global: "GD_GEO_BU", file: "gen/geo_buurten.js" },
  };

  var A = window.GD_ATOMS;
  var T = window.GD_TIR;
  var P = window.GD_PARKING;
  var META = window.GD_META;

  /* ═══════════════════════════════════════════════════ 2. FORMATTERS ══ */

  var nfInt = new Intl.NumberFormat("nl-NL");
  var nf1 = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var collator = new Intl.Collator("nl", { sensitivity: "base" });

  function fmtInt(n) { return nfInt.format(Math.round(n)); }
  function fmtPct(p) { return nf1.format(p); }
  function fmtHa(m2) { return nf2.format(m2 / 10000); }
  function fmtKm2(m2) { return nf2.format(m2 / 1e6); }

  function fmtArea(m2) {
    return m2 >= 1e6 ? fmtKm2(m2) + " km\u00b2" : fmtHa(m2) + " ha";
  }

  /** Komma als decimaalteken, geen duizendscheiding. Alleen voor export:
   *  Intl gebruikt U+00A0 als duizendscheider en dat maakt Excel er tekst van. */
  function rawNum(n, decimals) {
    return n.toFixed(decimals == null ? 1 : decimals).replace(".", ",");
  }

  function fold(s) {
    return String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/['`\u2019\-_.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** '99' voor '100', 'Markt' achteraan. */
  function naturalCmp(a, b) {
    var ra = String(a).match(/(\d+|\D+)/g) || [];
    var rb = String(b).match(/(\d+|\D+)/g) || [];
    for (var i = 0; i < Math.max(ra.length, rb.length); i++) {
      var pa = ra[i], pb = rb[i];
      if (pa === undefined) return -1;
      if (pb === undefined) return 1;
      var na = /^\d/.test(pa), nb = /^\d/.test(pb);
      if (na && nb) { var d = parseInt(pa, 10) - parseInt(pb, 10); if (d) return d; }
      else if (na !== nb) return na ? -1 : 1;
      else { var c = collator.compare(pa, pb); if (c) return c; }
    }
    return 0;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ═══════════════════════════════════════════════════════ 3. STATE ══ */

  var state = {
    mode: "forward",
    layer: "sectoren",
    selection: { sectoren: new Set(), zones: new Set() },
    level: "sbd",
    threshold: CFG.DEFAULT_THRESHOLD,
    showBelow: false,
    sort: { key: "pct", dir: "desc" },
    hover: null,
    stack: null,
    reverse: { level: "sbd", id: null },
    query: "",
    suggestions: [],
    active: -1,
    searchOpen: false,
    basemap: "brt",
    showAllParking: true,
    showLabels: true,
    loaded: new Set(),
    loading: new Set(),
    error: null,
    tab: "results",
  };

  var dirty = new Set();
  var frame = 0;

  function setState(patch) {
    for (var k in patch) {
      if (patch[k] !== state[k]) { state[k] = patch[k]; dirty.add(k); }
    }
    schedule();
  }

  /** Voor Sets en objecten die ter plekke gewijzigd zijn. */
  function touch() {
    for (var i = 0; i < arguments.length; i++) dirty.add(arguments[i]);
    schedule();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(flush);
  }

  var PAINTERS = [
    { fn: paintMode, deps: ["mode", "layer", "loading", "loaded"] },
    { fn: paintSuggestions, deps: ["suggestions", "active", "searchOpen", "query", "selection"] },
    { fn: paintChips, deps: ["selection", "layer", "mode", "reverse"] },
    { fn: paintControls, deps: ["level", "threshold", "showBelow", "basemap", "showAllParking", "showLabels", "mode"] },
    { fn: paintTotals, deps: ["@rows", "mode", "loading"] },
    { fn: paintNotice, deps: ["@rows", "selection", "mode", "error"] },
    { fn: paintTable, deps: ["@rows", "sort", "mode", "level"] },
    { fn: paintEmpty, deps: ["@rows", "mode", "loading", "error"] },
    { fn: paintBasemap, deps: ["basemap"] },
    { fn: paintParkingLayer, deps: ["layer", "selection", "showAllParking", "mode", "@rows"] },
    { fn: paintLabels, deps: ["layer", "showLabels", "mode", "selection"] },
    { fn: paintResultLayer, deps: ["@rows", "level", "showBelow", "loaded", "mode", "reverse"] },
    { fn: paintHoverLayer, deps: ["hover", "@rows", "loaded", "mode"] },
    { fn: paintStack, deps: ["stack"] },
    { fn: paintTabs, deps: ["tab"] },
  ];

  var lastRowsKey = null;

  function flush() {
    frame = 0;
    var view = derive();
    if (view.rowsKey !== lastRowsKey) { lastRowsKey = view.rowsKey; dirty.add("@rows"); }
    var d = dirty;
    dirty = new Set();
    for (var i = 0; i < PAINTERS.length; i++) {
      var p = PAINTERS[i];
      for (var j = 0; j < p.deps.length; j++) {
        if (d.has(p.deps[j])) { p.fn(view); break; }
      }
    }
  }

  /* ════════════════════════════════════════════════════ 4. INDEXEN ══ */

  var KEY_IX = new Map();
  var SBD_IX = new Map();
  var SBD_AREA = null;
  var GROUP = {};
  var TOTAL = {};
  var MEMBERS = {};
  var ATOMS_BY_SBD = null;
  var BUURT_NAAM = new Map();
  var GEBIED_NAAM = new Map();
  var PARK = new Map();
  var SEARCH = [];
  var PIDX = { sectoren: null, zones: null };
  var TIDX = { sbd: null, sb: null, bu: null };

  function buildIndexes() {
    A.keys.forEach(function (k, i) { KEY_IX.set(k, i); });
    A.sbd.forEach(function (c, i) { SBD_IX.set(c, i); });

    SBD_AREA = new Float64Array(A.sbd.length);
    T.sbd_code.forEach(function (c, i) {
      var ix = SBD_IX.get(c);
      if (ix !== undefined) SBD_AREA[ix] = T.sbd_area[i];
    });

    T.buurt_code.forEach(function (c, i) { BUURT_NAAM.set(c, T.buurt_naam[i]); });
    T.gebied_code.forEach(function (c, i) { GEBIED_NAAM.set(c, T.gebied_naam[i]); });

    Object.keys(LEVELS).forEach(function (lv) {
      var w = LEVELS[lv].width;
      var groups = new Array(A.sbd.length);
      var tot = new Map();
      var mem = new Map();
      for (var i = 0; i < A.sbd.length; i++) {
        var g = w === null ? A.sbd[i] : A.sbd[i].slice(0, w);
        groups[i] = g;
        tot.set(g, (tot.get(g) || 0) + SBD_AREA[i]);
        if (!mem.has(g)) mem.set(g, []);
        mem.get(g).push(i);
      }
      GROUP[lv] = groups;
      TOTAL[lv] = tot;
      MEMBERS[lv] = mem;
    });

    ATOMS_BY_SBD = new Array(A.sbd.length);
    for (var i = 0; i < A.atoms.length; i++) {
      var r = A.atoms[i];
      if (!ATOMS_BY_SBD[r[0]]) ATOMS_BY_SBD[r[0]] = [];
      ATOMS_BY_SBD[r[0]].push(r);
    }

    P.sectoren.forEach(function (s) { s.kind = "sector"; PARK.set(s.key, s); });
    P.zones.forEach(function (z) { z.kind = "zone"; PARK.set(z.key, z); });

    PIDX.sectoren = buildParkingIndex(window.GD_GEO_SECTOREN, P.sectoren);
    PIDX.zones = buildParkingIndex(window.GD_GEO_ZONES, P.zones);

    buildSearchIndex();
    state.loaded.add("sectoren");
    state.loaded.add("zones");
  }

  function buildSearchIndex() {
    P.sectoren.forEach(function (s) {
      SEARCH.push({
        kind: "sector", key: s.key, id: s.id,
        label: "Sector " + s.id,
        sub: fmtArea(s.area_m2) + " \u00b7 " + s.n_sbd + " vlakken",
        hay: s.id.toLowerCase(), hayName: fold("sector " + s.id),
        container: s.container, area: s.area_m2,
      });
    });
    P.zones.forEach(function (z) {
      SEARCH.push({
        kind: "zone", key: z.key, id: z.id,
        label: "Zone " + z.id,
        sub: "sector " + z.sector + " \u00b7 " + z.n_sbd + " vlakken",
        hay: z.id.toLowerCase(), hayName: fold("zone " + z.id),
        container: false, area: z.area_m2,
      });
    });
    var seenSb = new Set();
    A.sbd.forEach(function (code) {
      var bu = code.slice(0, 4);
      var naam = BUURT_NAAM.get(bu) || bu;
      SEARCH.push({
        kind: "sbd", key: "sbd:" + code, id: code, level: "sbd",
        label: code + " \u00b7 " + naam,
        sub: "subbuurtdeel",
        hay: code, hayName: fold(naam), container: false,
        area: TOTAL.sbd.get(code) || 0,
      });
      var sb = code.slice(0, 5);
      if (!seenSb.has(sb)) {
        seenSb.add(sb);
        SEARCH.push({
          kind: "sb", key: "sb:" + sb, id: sb, level: "sb",
          label: sb + " \u00b7 " + naam,
          sub: "subbuurt", hay: sb, hayName: fold(naam), container: false,
          area: TOTAL.sb.get(sb) || 0,
        });
      }
    });
    T.buurt_code.forEach(function (code, i) {
      SEARCH.push({
        kind: "bu", key: "bu:" + code, id: code, level: "bu",
        label: T.buurt_naam[i],
        sub: "buurt " + code, hay: code, hayName: fold(T.buurt_naam[i]),
        container: false, area: TOTAL.bu.get(code) || 0,
      });
    });
  }

  /* ═══════════════════════════════════════════════════ 5. GEOMETRIE ══ */

  function ringBbox(ring) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  function mergeBbox(a, b) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }

  function bboxHit(bb, x, y) {
    return x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3];
  }

  /** Polygon en MultiPolygon naar een vlakke lijst delen met buitenring en gaten. */
  function toParts(geom) {
    var polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    var parts = [];
    for (var i = 0; i < polys.length; i++) {
      parts.push({ outer: polys[i][0], holes: polys[i].slice(1), bbox: ringBbox(polys[i][0]) });
    }
    return parts;
  }

  function featureBbox(geom) {
    var parts = toParts(geom);
    var bb = parts[0].bbox;
    for (var i = 1; i < parts.length; i++) bb = mergeBbox(bb, parts[i].bbox);
    return bb;
  }

  /** Kruisingsgetal, halfopen in y zodat een punt op de hoogte van een hoekpunt
   *  precies eenmaal omklapt. */
  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y)) {
        var xInt = xj + ((y - yj) * (xi - xj)) / (yi - yj);
        if (x < xInt) inside = !inside;
      }
    }
    return inside;
  }

  function pointInPart(x, y, part) {
    if (!bboxHit(part.bbox, x, y)) return false;
    if (!pointInRing(x, y, part.outer)) return false;
    for (var i = 0; i < part.holes.length; i++) {
      if (pointInRing(x, y, part.holes[i])) return false;   // in een gat = erbuiten
    }
    return true;
  }

  function pointInEntry(x, y, e) {
    for (var i = 0; i < e.parts.length; i++) {
      if (pointInPart(x, y, e.parts[i])) return true;
    }
    return false;
  }

  function buildParkingIndex(geo, meta) {
    var byId = new Map();
    meta.forEach(function (m) { byId.set(m.id, m); });
    var entries = geo.features.map(function (f) {
      var m = byId.get(String(f.id)) || {};
      return {
        id: String(f.id),
        key: m.key,
        area: m.area_m2 || f.properties.area_m2 || 0,
        container: !!m.container,
        parts: toParts(f.geometry),
        bbox: featureBbox(f.geometry),
        geometry: f.geometry,
      };
    });
    entries.sort(function (a, b) { return a.area - b.area || naturalCmp(a.id, b.id); });
    return entries;
  }

  function buildTirIndex(geo) {
    var entries = geo.features.map(function (f) {
      var code = String(f.id);
      return {
        id: code, key: code,
        area: TOTAL[code.length === 6 ? "sbd" : code.length === 5 ? "sb" : "bu"].get(code) || 0,
        container: false,
        parts: toParts(f.geometry),
        bbox: featureBbox(f.geometry),
        geometry: f.geometry,
      };
    });
    entries.sort(function (a, b) { return a.area - b.area || naturalCmp(a.id, b.id); });
    return entries;
  }

  function hitTest(latlng, index) {
    if (!index) return [];
    var x = latlng.lng, y = latlng.lat, hits = [];
    for (var i = 0; i < index.length; i++) {
      var e = index[i];
      if (bboxHit(e.bbox, x, y) && pointInEntry(x, y, e)) hits.push(e);
    }
    return hits;               // al gesorteerd van klein naar groot
  }

  /** Het kleinste niet-stadsdekkende vlak; anders het kleinste stadsdekkende. */
  function pick(hits) {
    if (!hits.length) return null;
    for (var i = 0; i < hits.length; i++) if (!hits[i].container) return hits[i];
    return hits[0];
  }

  function boundsOfGeometries(geoms) {
    if (!geoms.length) return null;
    var bb = featureBbox(geoms[0]);
    for (var i = 1; i < geoms.length; i++) bb = mergeBbox(bb, featureBbox(geoms[i]));
    return L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]);
  }

  /* ══════════════════════════════════════════════════════ 6. DEKKING ══ */

  function computeCoverage(selKeys) {
    var sel = new Set();
    selKeys.forEach(function (k) {
      var i = KEY_IX.get(k);
      if (i !== undefined) sel.add(i);
    });
    var match = new Array(A.sets.length);
    for (var s = 0; s < A.sets.length; s++) {
      var set = A.sets[s], hit = false;
      for (var q = 0; q < set.length; q++) { if (sel.has(set[q])) { hit = true; break; } }
      match[s] = hit;
    }
    var cov = new Float64Array(A.sbd.length);
    for (var i = 0; i < A.atoms.length; i++) {
      var r = A.atoms[i];
      if (match[r[2]]) cov[r[0]] += r[1];
    }
    return cov;
  }

  function classify(pct, thr) {
    if (pct < thr - CFG.EPS) return "onderdrempel";
    if (pct >= CFG.FULL_PCT) return "volledig";
    if (pct >= CFG.MOSTLY_PCT) return "grotendeels";
    return "gedeeltelijk";
  }

  function aggregate(cov, level, thr) {
    var groups = GROUP[level], totals = TOTAL[level];
    var acc = new Map();
    var sbdCount = new Map();
    for (var i = 0; i < cov.length; i++) {
      if (cov[i] <= 0) continue;
      var g = groups[i];
      acc.set(g, (acc.get(g) || 0) + cov[i]);
      sbdCount.set(g, (sbdCount.get(g) || 0) + 1);
    }
    var rows = [];
    acc.forEach(function (covered, code) {
      var total = totals.get(code);
      var clipped = Math.min(covered, total);           // afronding in de atoomtabel
      var pct = total > 0 ? (clipped / total) * 100 : 0;
      var buurt = level === "bu" ? code : code.slice(0, 4);
      rows.push({
        code: code,
        naam: BUURT_NAAM.get(buurt) || "",
        buurtCode: buurt,
        gebiedCode: code.slice(0, 2),
        gebiedNaam: GEBIED_NAAM.get(code.slice(0, 2)) || "",
        covered: clipped,
        total: total,
        pct: pct,
        cls: classify(pct, thr),
        nSbd: sbdCount.get(code),
      });
    });
    return rows;
  }

  function reverseRows(level, code, thr) {
    var members = MEMBERS[level].get(code) || [];
    var total = TOTAL[level].get(code) || 0;
    var acc = new Map();
    for (var m = 0; m < members.length; m++) {
      var list = ATOMS_BY_SBD[members[m]];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var r = list[i], set = A.sets[r[2]];
        for (var q = 0; q < set.length; q++) {
          acc.set(set[q], (acc.get(set[q]) || 0) + r[1]);
        }
      }
    }
    var rows = [];
    acc.forEach(function (area, keyIx) {
      var key = A.keys[keyIx];
      var p = PARK.get(key);
      if (!p) return;
      var clipped = Math.min(area, total);
      var pct = total > 0 ? (clipped / total) * 100 : 0;
      rows.push({
        code: p.id,
        key: key,
        kind: p.kind,
        naam: (p.kind === "sector" ? "Sector " : "Zone ") + p.id,
        container: !!p.container,
        covered: clipped,
        total: total,
        pct: pct,
        pctOfParking: p.area_m2 > 0 ? Math.min(100, (area / p.area_m2) * 100) : 0,
        cls: classify(pct, thr),
      });
    });
    return rows;
  }

  function sortRows(rows, sort) {
    var k = sort.key, sign = sort.dir === "asc" ? 1 : -1;
    var cmp;
    if (k === "code") cmp = function (a, b) { return naturalCmp(a.code, b.code); };
    else if (k === "naam") cmp = function (a, b) { return collator.compare(a.naam, b.naam) || naturalCmp(a.code, b.code); };
    else if (k === "gebied") cmp = function (a, b) { return collator.compare(a.gebiedNaam || "", b.gebiedNaam || "") || naturalCmp(a.code, b.code); };
    else cmp = function (a, b) { return (a[k] - b[k]) || naturalCmp(a.code, b.code); };
    return rows.slice().sort(function (a, b) {
      var c = cmp(a, b);
      return c === 0 ? 0 : c * (k === "code" || k === "naam" || k === "gebied" ? sign : sign);
    });
  }

  var _covKey = null, _cov = null, _rowsKey = null, _rows = null, _all = null;

  function derive() {
    var sel = state.selection[state.layer];
    var selList = Array.from(sel).sort();
    var covKey = state.mode + "|" + state.layer + "|" + selList.join(",") + "|" +
      state.reverse.level + "|" + state.reverse.id;

    if (covKey !== _covKey) {
      _covKey = covKey;
      _cov = state.mode === "forward" ? computeCoverage(sel) : null;
    }

    var rowsKey = covKey + "|" + state.level + "|" + state.threshold + "|" +
      state.showBelow + "|" + state.sort.key + state.sort.dir;

    if (rowsKey !== _rowsKey) {
      _rowsKey = rowsKey;
      if (state.mode === "forward") {
        _all = sel.size ? aggregate(_cov, state.level, state.threshold) : [];
      } else {
        _all = state.reverse.id ? reverseRows(state.reverse.level, state.reverse.id, state.threshold) : [];
      }
      var keep = _all.filter(function (r) { return r.cls !== "onderdrempel"; });
      _rows = sortRows(state.showBelow ? _all : keep, state.sort);
    }

    var above = _all.filter(function (r) { return r.cls !== "onderdrempel"; });
    var totals = {
      n: above.length,
      nBelow: _all.length - above.length,
      nFull: above.filter(function (r) { return r.cls === "volledig"; }).length,
      nPartial: above.filter(function (r) { return r.cls !== "volledig"; }).length,
      area: above.reduce(function (s, r) { return s + r.covered; }, 0),
      nSbd: above.reduce(function (s, r) { return s + (r.nSbd || 0); }, 0),
    };

    return {
      rows: _rows, all: _all, above: above, rowsKey: _rowsKey, totals: totals, cov: _cov,
      simplified: state.mode === "forward" && _rows.length > CFG.MAX_SVG_FEATURES,
    };
  }

  function selectionLabel() {
    if (state.mode === "reverse") {
      if (!state.reverse.id) return "";
      var lv = LEVELS[state.reverse.level];
      var naam = BUURT_NAAM.get(state.reverse.id.slice(0, 4));
      return lv.label.charAt(0).toUpperCase() + lv.label.slice(1) + " " + state.reverse.id +
        (naam ? " (" + naam + ")" : "");
    }
    var word = state.layer === "sectoren" ? "Sector" : "Zone";
    var ids = Array.from(state.selection[state.layer])
      .map(function (k) { return PARK.get(k).id; })
      .sort(naturalCmp);
    if (!ids.length) return "";
    return (ids.length === 1 ? word : word + "en") + " " + ids.join(", ");
  }

  /* ═════════════════════════════════════════════════ 7. DATA LADEN ══ */

  var pending = {};

  function loadScript(url) {
    if (pending[url]) return pending[url];
    pending[url] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("kan " + url + " niet laden")); };
      document.head.appendChild(s);
    });
    return pending[url];
  }

  function ensureGeo(level) {
    if (state.loaded.has(level)) return Promise.resolve();
    var src = GEO_SRC[level];
    if (window[src.global]) { onGeoReady(level); return Promise.resolve(); }
    if (state.loading.has(level)) return pending[src.file];
    state.loading.add(level);
    touch("loading");
    return loadScript(src.file).then(function () {
      state.loading.delete(level);
      onGeoReady(level);
    }, function (err) {
      state.loading.delete(level);
      setState({ error: err.message });
      touch("loading");
    });
  }

  function onGeoReady(level) {
    TIDX[level] = buildTirIndex(window[GEO_SRC[level].global]);
    state.loaded.add(level);
    state.loading.delete(level);
    touch("loaded", "loading");
  }

  function geoFor(level) { return window[GEO_SRC[level].global]; }

  /* ═════════════════════════════════════════════════════════ 8. KAART ══ */

  var map, brtLayer = null;
  var rParking, rResult, rHover;
  var parkingLayer = null, resultLayer = null, hoverLayer = null, unitLayer = null;
  var labelLayer = null;
  var stackPopup = null;
  var geoIndexByLevel = {};

  function initMap() {
    map = L.map("map", {
      center: CFG.CENTER, zoom: CFG.ZOOM,
      zoomControl: false, preferCanvas: false, attributionControl: true,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);

    map.createPane("gd-parking").style.zIndex = 405;
    map.createPane("gd-result").style.zIndex = 410;
    map.createPane("gd-hover").style.zIndex = 420;
    map.createPane("gd-label").style.zIndex = 430;
    map.getPane("gd-hover").classList.add("gd-hover-pane");
    map.getPane("gd-label").style.pointerEvents = "none";

    rParking = L.canvas({ pane: "gd-parking", padding: 0.3 });
    rResult = L.svg({ pane: "gd-result", padding: 0.3 });
    rHover = L.svg({ pane: "gd-hover", padding: 0.5 });

    map.on("click", onMapClick);
    map.on("contextmenu", onMapContext);
    map.on("mousemove", onMapMove);
    map.on("mouseout", function () { if (state.hover) setState({ hover: null }); });
    map.on("zoomend", function () { touch("showLabels"); });
  }

  function activeIndex() {
    return state.mode === "forward" ? PIDX[state.layer] : TIDX[state.reverse.level];
  }

  function onMapClick(e) {
    var hits = hitTest(e.latlng, activeIndex());
    var chosen = pick(hits);
    if (!chosen) { if (state.stack) setState({ stack: null }); return; }
    if (state.mode === "forward") {
      var sel = state.selection[state.layer];
      if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
        sel.clear();
        sel.add(chosen.key);
      } else if (sel.has(chosen.key)) {
        sel.delete(chosen.key);
      } else {
        sel.add(chosen.key);
        fitTo(boundsOfGeometries([chosen.geometry]));
      }
      touch("selection");
    } else {
      state.reverse.id = chosen.id;
      touch("reverse");
    }
    setState({ stack: hits.length > 1 ? { latlng: e.latlng, hits: hits } : null });
  }

  function onMapContext(e) {
    e.originalEvent.preventDefault();
    var hits = hitTest(e.latlng, activeIndex());
    setState({ stack: hits.length ? { latlng: e.latlng, hits: hits } : null });
  }

  var moveQueued = false;
  function onMapMove(e) {
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(function () {
      moveQueued = false;
      var view = derive();
      var idx = state.mode === "forward" ? (state.loaded.has(state.level) ? TIDX[state.level] : null) : PIDX.sectoren;
      if (!idx) { if (state.hover) setState({ hover: null }); return; }
      var allowed = new Set(view.rows.map(function (r) { return state.mode === "forward" ? r.code : r.code; }));
      var hits = hitTest(e.latlng, idx).filter(function (h) { return allowed.has(h.id); });
      var id = hits.length ? hits[0].id : null;
      if ((state.hover && state.hover.id) !== id) setState({ hover: id ? { id: id, from: "map" } : null });
    });
  }

  function fitTo(bounds) {
    if (!bounds || !bounds.isValid()) return;
    var cur = map.getBounds();
    if (cur.contains(bounds)) return;
    map.flyToBounds(bounds, { padding: [40, 40], duration: 0.45, maxZoom: 16 });
  }

  function paintBasemap() {
    if (state.basemap === "brt") {
      if (!brtLayer) {
        brtLayer = L.tileLayer(CFG.BRT, {
          minZoom: 7, maxZoom: 20, maxNativeZoom: 19, attribution: CFG.ATTRIB,
        });
      }
      if (!map.hasLayer(brtLayer)) brtLayer.addTo(map);
      document.body.classList.remove("no-basemap");
    } else {
      if (brtLayer && map.hasLayer(brtLayer)) map.removeLayer(brtLayer);
      document.body.classList.add("no-basemap");
    }
  }

  function paintParkingLayer(view) {
    if (parkingLayer) { map.removeLayer(parkingLayer); parkingLayer = null; }
    if (!state.showAllParking) return;
    var geo = state.mode === "forward"
      ? (state.layer === "sectoren" ? window.GD_GEO_SECTOREN : window.GD_GEO_ZONES)
      : window.GD_GEO_SECTOREN;
    var sel = state.mode === "forward" ? state.selection[state.layer] : new Set();
    var prefix = state.mode === "forward" ? (state.layer === "sectoren" ? "S" : "Z") : "S";
    var containers = new Set();
    (state.mode === "forward" && state.layer === "zones" ? P.zones : P.sectoren).forEach(function (m) {
      if (m.container) containers.add(m.id);
    });
    var noBase = state.basemap === "none";
    parkingLayer = L.geoJSON(geo, {
      renderer: rParking,
      pane: "gd-parking",
      interactive: false,
      style: function (f) {
        var id = String(f.id);
        if (sel.has(prefix + id)) {
          return { color: "#0F62FE", weight: 3, opacity: 1, fill: true, fillColor: "#0F62FE", fillOpacity: 0.05 };
        }
        if (containers.has(id)) {
          return { color: "#6A3D9A", weight: 2, opacity: 0.85, dashArray: "10 6", fill: false };
        }
        return { color: noBase ? "#3C4650" : "#5B6570", weight: 1, opacity: noBase ? 0.75 : 0.55, fill: false };
      },
    }).addTo(map);
  }

  function paintLabels() {
    if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
    if (!state.showLabels) return;
    if (map.getZoom() < CFG.LABEL_MIN_ZOOM) return;
    var list = state.mode === "forward" && state.layer === "zones" ? P.zones : P.sectoren;
    var sel = state.mode === "forward" ? state.selection[state.layer] : new Set();
    var markers = [];
    list.forEach(function (m) {
      if (m.container) return;                     // stadsdekkend: label zou nergens kloppen
      markers.push(
        L.marker([m.center[1], m.center[0]], {
          pane: "gd-label",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "sector-label",
            html: sel.has(m.key) ? "<b>" + esc(m.id) + "</b>" : esc(m.id),
            iconSize: null,
          }),
        })
      );
    });
    labelLayer = L.layerGroup(markers).addTo(map);
  }

  function styleForRow(row, simplified) {
    if (state.mode === "reverse") {
      return {
        pane: "gd-result", color: "#3B2668", weight: 1.4, opacity: 0.95,
        fill: true, fillColor: "#5B3E9B",
        fillOpacity: simplified || row.cls !== "volledig" ? (row.cls === "volledig" ? 0.55 : row.cls === "grotendeels" ? 0.3 : 0.15) : 0.55,
        className: simplified ? "" : "cov-" + row.cls,
      };
    }
    if (row.cls === "onderdrempel") {
      return { pane: "gd-result", color: "#8A9099", weight: 1, opacity: 0.9, dashArray: "2 4", fill: false };
    }
    var base = {
      pane: "gd-result", color: "#0E5943", weight: 1, opacity: 0.95,
      fill: true, fillColor: "#1B7F5F",
      dashArray: row.cls === "gedeeltelijk" ? "4 3" : null,
    };
    if (simplified) {
      base.fillOpacity = row.cls === "volledig" ? 0.6 : row.cls === "grotendeels" ? 0.32 : 0.15;
      base.className = "";
    } else {
      base.fillOpacity = 1;
      base.className = "cov-" + row.cls;
    }
    return base;
  }

  function paintResultLayer(view) {
    if (resultLayer) { map.removeLayer(resultLayer); resultLayer = null; }
    if (unitLayer) { map.removeLayer(unitLayer); unitLayer = null; }

    if (state.mode === "reverse") {
      if (state.reverse.id) {
        ensureGeo(state.reverse.level);
        var g = geoFor(state.reverse.level);
        if (g) {
          var uf = g.features.filter(function (f) { return String(f.id) === state.reverse.id; });
          if (uf.length) {
            unitLayer = L.geoJSON({ type: "FeatureCollection", features: uf }, {
              renderer: rHover, pane: "gd-hover", interactive: false,
              style: { color: "#111", weight: 3, opacity: 0.95, fill: false },
            }).addTo(map);
          }
        }
      }
      var wantR = new Map();
      view.rows.forEach(function (r) { wantR.set(r.code, r); });
      var geoP = window.GD_GEO_SECTOREN;
      var featsR = geoP.features.filter(function (f) { return wantR.has(String(f.id)); });
      var zoneRows = view.rows.filter(function (r) { return r.kind === "zone"; });
      if (zoneRows.length) {
        var zmap = new Map();
        zoneRows.forEach(function (r) { zmap.set(r.code, r); });
        window.GD_GEO_ZONES.features.forEach(function (f) {
          if (zmap.has(String(f.id))) { featsR.push(f); wantR.set("Z" + f.id, zmap.get(String(f.id))); }
        });
      }
      if (!featsR.length) return;
      resultLayer = L.geoJSON({ type: "FeatureCollection", features: featsR }, {
        renderer: rResult, pane: "gd-result", interactive: false,
        className: "rev",
        style: function (f) {
          var r = wantR.get(String(f.id)) || wantR.get("Z" + f.id);
          return styleForRow(r || { cls: "gedeeltelijk" }, false);
        },
      }).addTo(map);
      return;
    }

    if (!view.rows.length) return;
    if (!state.loaded.has(state.level)) { ensureGeo(state.level); return; }
    var geo = geoFor(state.level);
    var want = new Map();
    view.rows.forEach(function (r) { want.set(r.code, r); });
    var feats = geo.features.filter(function (f) { return want.has(String(f.id)); });
    var simplified = view.simplified;
    resultLayer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      renderer: simplified ? rParking : rResult,
      pane: simplified ? "gd-parking" : "gd-result",
      interactive: false,
      style: function (f) { return styleForRow(want.get(String(f.id)), simplified); },
    }).addTo(map);
  }

  function paintHoverLayer(view) {
    if (hoverLayer) { map.removeLayer(hoverLayer); hoverLayer = null; }
    if (!state.hover) return;
    var geo, id = state.hover.id;
    if (state.mode === "forward") {
      if (!state.loaded.has(state.level)) return;
      geo = geoFor(state.level);
    } else {
      geo = window.GD_GEO_SECTOREN;
      if (!geo.features.some(function (f) { return String(f.id) === id; })) geo = window.GD_GEO_ZONES;
    }
    var f = geo.features.filter(function (x) { return String(x.id) === id; });
    if (!f.length) return;
    hoverLayer = L.layerGroup([
      L.geoJSON({ type: "FeatureCollection", features: f }, {
        renderer: rHover, pane: "gd-hover", interactive: false,
        style: { color: "#ffffff", weight: 7, opacity: 0.9, fill: false, lineJoin: "round" },
      }),
      L.geoJSON({ type: "FeatureCollection", features: f }, {
        renderer: rHover, pane: "gd-hover", interactive: false,
        style: { color: "#FFB000", weight: 3, opacity: 1, fill: false, lineJoin: "round" },
      }),
    ]).addTo(map);
  }

  function paintStack(view) {
    if (stackPopup) { map.closePopup(stackPopup); stackPopup = null; }
    if (!state.stack || state.stack.hits.length < 2) return;
    var wrap = document.createElement("div");
    wrap.className = "stack-popup";
    var head = document.createElement("b");
    head.textContent = state.mode === "forward" ? "Hier liggen meer vlakken" : "Ook hier";
    wrap.appendChild(head);
    state.stack.hits.forEach(function (h) {
      var b = document.createElement("button");
      b.type = "button";
      var name = state.mode === "forward"
        ? (state.layer === "sectoren" ? "Sector " : "Zone ") + h.id
        : h.id + (BUURT_NAAM.get(h.id.slice(0, 4)) ? " \u00b7 " + BUURT_NAAM.get(h.id.slice(0, 4)) : "");
      b.textContent = name + "  " + fmtArea(h.area) + (h.container ? "  (stadsdekkend)" : "");
      b.onclick = function () {
        if (state.mode === "forward") {
          var sel = state.selection[state.layer];
          if (sel.has(h.key)) sel.delete(h.key); else sel.add(h.key);
          touch("selection");
        } else {
          state.reverse.id = h.id;
          touch("reverse");
        }
        setState({ stack: null });
      };
      wrap.appendChild(b);
    });
    stackPopup = L.popup({ closeButton: true, autoPan: false })
      .setLatLng(state.stack.latlng).setContent(wrap).openOn(map);
  }

  /* ══════════════════════════════════════════════════════ 9. ZOEKEN ══ */

  function wordStart(hay, q) {
    if (hay.indexOf(q) === 0) return true;
    return hay.indexOf(" " + q) >= 0;
  }

  function subsequence(q, hay) {
    var i = 0;
    for (var j = 0; j < hay.length && i < q.length; j++) if (hay[j] === q[i]) i++;
    return i === q.length;
  }

  function rank(raw) {
    var q = fold(raw);
    if (!q) return [];
    var layerKind = state.layer === "sectoren" ? "sector" : "zone";
    var kindRank = state.mode === "reverse"
      ? { bu: 0, sb: 1, sbd: 2, sector: 3, zone: 4 }
      : (layerKind === "sector" ? { sector: 0, zone: 1, bu: 2, sb: 3, sbd: 4 } : { zone: 0, sector: 1, bu: 2, sb: 3, sbd: 4 });
    var out = [];
    for (var i = 0; i < SEARCH.length; i++) {
      var e = SEARCH[i], sc = 0;
      if (e.hay === q) sc = 1000;
      else if (e.hay.indexOf(q) === 0) sc = 900 - e.hay.length;
      else if (e.hayName && wordStart(e.hayName, q)) sc = 700;
      else if (e.hayName && e.hayName.indexOf(q) >= 0) sc = 500;
      else if (e.hay.indexOf(q) >= 0) sc = 400;
      else if (e.hayName && q.length >= 3 && subsequence(q, e.hayName)) sc = 200;
      if (sc) out.push({ e: e, sc: sc });
    }
    out.sort(function (a, b) {
      return (b.sc - a.sc) ||
        (kindRank[a.e.kind] - kindRank[b.e.kind]) ||
        ((a.e.container ? 1 : 0) - (b.e.container ? 1 : 0)) ||
        naturalCmp(a.e.id, b.e.id);
    });
    return out.slice(0, 40).map(function (o) { return o.e; });
  }

  function commit(entry, replace) {
    if (!entry) return;
    if (entry.kind === "sector" || entry.kind === "zone") {
      var layer = entry.kind === "sector" ? "sectoren" : "zones";
      if (layer !== state.layer) setState({ layer: layer });
      var sel = state.selection[layer];
      if (replace) sel.clear();
      sel.add(entry.key);
      if (state.mode !== "forward") setState({ mode: "forward" });
      touch("selection");
      var ent = (PIDX[layer] || []).filter(function (x) { return x.key === entry.key; })[0];
      if (ent) fitTo(boundsOfGeometries([ent.geometry]));
    } else {
      state.reverse.level = entry.level;
      state.reverse.id = entry.id;
      setState({ mode: "reverse" });
      touch("reverse");
      ensureGeo(entry.level).then(function () {
        var g = geoFor(entry.level);
        if (!g) return;
        var f = g.features.filter(function (x) { return String(x.id) === entry.id; });
        if (f.length) fitTo(boundsOfGeometries(f.map(function (x) { return x.geometry; })));
      });
    }
    el.search.value = "";
    setState({ query: "", suggestions: [], active: -1, searchOpen: false });
    el.search.focus();
  }

  /* ══════════════════════════════════════════════════════ 10. EXPORT ══ */

  function exportMatrix(view) {
    var header, rows = [], codeCols;
    var selLabel = selectionLabel();
    if (state.mode === "reverse") {
      header = ["Type", "Id", "Gebied", "Percentage_van_gebied", "Percentage_van_parkeervlak", "Oppervlakte_binnen_m2", "Dekking"];
      codeCols = new Set([1, 2]);
      view.rows.forEach(function (r) {
        rows.push([
          r.kind === "sector" ? "Parkeersector" : "Parkeerzone",
          r.code, state.reverse.id,
          rawNum(r.pct, 2), rawNum(r.pctOfParking, 2), rawNum(r.covered, 1),
          r.cls,
        ]);
      });
    } else {
      var lv = LEVELS[state.level];
      header = ["Code", "Niveau", "Subbuurtcode", "Buurtcode", "Buurt", "Gebiedscode", "Gebied",
        "Oppervlakte_totaal_m2", "Oppervlakte_binnen_selectie_m2", "Percentage", "Dekking", "Selectie"];
      codeCols = new Set([0, 2, 3, 5]);
      view.rows.forEach(function (r) {
        rows.push([
          r.code, lv.label,
          state.level === "sbd" ? r.code.slice(0, 5) : (state.level === "sb" ? r.code : ""),
          r.buurtCode, r.naam, r.gebiedCode, r.gebiedNaam,
          rawNum(r.total, 1), rawNum(r.covered, 1), rawNum(r.pct, 2), r.cls, selLabel,
        ]);
      });
    }
    return { header: header, rows: rows, codeCols: codeCols };
  }

  function toTSV(m) {
    return [m.header.join("\t")].concat(m.rows.map(function (r) { return r.join("\t"); })).join("\r\n");
  }

  function toCSV(m) {
    function cell(v, i) {
      var s = String(v);
      if (m.codeCols.has(i) && /^\d+$/.test(s)) return '="' + s + '"';
      return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [m.header.join(";")];
    m.rows.forEach(function (r) { lines.push(r.map(cell).join(";")); });
    return "\ufeff" + lines.join("\r\n") + "\r\n";
  }

  /** mso-number-format:'\@' dwingt Excel de cel als tekst te plakken, zodat
   *  '053560' zijn voorloopnul houdt zonder formule-truc. */
  function toHTMLTable(m) {
    var h = "<table><thead><tr>" + m.header.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
    m.rows.forEach(function (r) {
      h += "<tr>" + r.map(function (c, i) {
        return m.codeCols.has(i)
          ? "<td style=\"mso-number-format:'\\@'\">" + esc(c) + "</td>"
          : "<td>" + esc(c) + "</td>";
      }).join("") + "</tr>";
    });
    return h + "</tbody></table>";
  }

  function copyRich(m, msg) {
    var html = toHTMLTable(m), text = toTSV(m);
    function legacy() {
      var div = document.createElement("div");
      div.setAttribute("contenteditable", "true");
      div.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre";
      div.innerHTML = html;
      document.body.appendChild(div);
      var range = document.createRange();
      range.selectNodeContents(div);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      var okDone = false;
      try { okDone = document.execCommand("copy"); } catch (e) { okDone = false; }
      sel.removeAllRanges();
      div.remove();
      if (okDone) toast(msg);
      else showFallback(text);
    }
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      var item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      });
      navigator.clipboard.write([item]).then(function () { toast(msg); }, function () {
        if (navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { toast(msg); }, legacy);
        } else legacy();
      });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, legacy);
    } else legacy();
  }

  function copyPlain(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () { showFallback(text); });
    } else showFallback(text);
  }

  function showFallback(text) {
    var d = document.createElement("dialog");
    d.innerHTML = "<h2>Kopieer met Ctrl+C</h2><p>De browser mag hier niet zelf naar het klembord " +
      "schrijven. De tekst staat al geselecteerd.</p>";
    var ta = document.createElement("textarea");
    ta.style.cssText = "width:100%;height:190px;font:12px var(--mono, monospace)";
    ta.value = text;
    d.appendChild(ta);
    var f = document.createElement("form");
    f.method = "dialog";
    f.innerHTML = "<button type='submit'>Sluiten</button>";
    d.appendChild(f);
    document.body.appendChild(d);
    d.addEventListener("close", function () { d.remove(); });
    d.showModal();
    ta.select();
  }

  function downloadCSV(m) {
    var lv = state.mode === "reverse" ? "sectoren" : LEVELS[state.level].plural;
    var sel = selectionLabel().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "selectie";
    var name = lv + "_" + sel + "_drempel-" + state.threshold + "pct_" + (META.version || "") + ".csv";
    var blob = new Blob([toCSV(m)], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast(name + " gedownload");
  }

  var toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  /* ═══════════════════════════════════════════════════════ 11. DOM ══ */

  var el = {};

  function grab() {
    ["search", "search-clear", "suggest", "chips", "sel-count", "btn-clear", "levels", "threshold",
      "thr-out", "totals", "notice", "actions", "table-wrap", "table", "thead-row", "tbody", "empty",
      "show-below", "below-toggle", "btn-copy", "btn-codes", "btn-csv", "map-status", "legend",
      "toast", "help", "btn-help", "version", "show-all-parking", "show-labels", "tabbar",
      "block-layer", "block-level"].forEach(function (id) {
      el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  function columnsFor() {
    if (state.mode === "reverse") {
      return [
        { key: "code", label: "Parkeervlak", cls: "" },
        { key: "pct", label: "% van gebied", cls: "num" },
        { key: "pctOfParking", label: "% van vlak", cls: "num" },
      ];
    }
    return [
      { key: "code", label: "Code", cls: "" },
      { key: "naam", label: "Buurt / gebied", cls: "" },
      { key: "pct", label: "Dekking", cls: "num" },
      { key: "covered", label: "ha", cls: "num" },
    ];
  }

  var GLYPH = { volledig: "\u25a0", grotendeels: "\u25a8", gedeeltelijk: "\u2591", onderdrempel: "\u2508" };

  function paintTable(view) {
    var cols = columnsFor();
    el.theadRow.innerHTML = cols.map(function (c) {
      var sortAttr = state.sort.key === c.key ? ' aria-sort="' + (state.sort.dir === "asc" ? "ascending" : "descending") + '"' : "";
      return "<th class=\"" + c.cls + "\"" + sortAttr + "><button type=\"button\" data-sort=\"" + c.key + "\">" + esc(c.label) + "</button></th>";
    }).join("");

    var frag = document.createDocumentFragment();
    view.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.dataset.code = r.code;
      if (r.cls === "onderdrempel") tr.className = "below";
      var pctCell = '<span class="glyph' + (r.cls === "onderdrempel" ? " g-below" : "") + '">' + GLYPH[r.cls] +
        "</span>" + fmtPct(r.pct) + " %" +
        '<span class="bar" aria-hidden="true"><i style="width:' + Math.max(2, Math.round(r.pct)) + '%"></i></span>';
      if (state.mode === "reverse") {
        tr.innerHTML =
          "<td>" + esc(r.naam) + (r.container ? ' <span class="badge-container">stadsdekkend</span>' : "") + "</td>" +
          '<td class="num pct">' + pctCell + "</td>" +
          '<td class="num">' + fmtPct(r.pctOfParking) + " %</td>";
      } else {
        tr.innerHTML =
          '<td class="code">' + esc(r.code) + "</td>" +
          '<td class="naam">' + esc(r.naam) + '<span class="sub wide">' + esc(r.gebiedNaam) +
          (r.nSbd && state.level !== "sbd" ? " \u00b7 " + r.nSbd + " sbd" : "") + "</span></td>" +
          '<td class="num pct">' + pctCell + "</td>" +
          '<td class="num">' + fmtHa(r.covered) + "</td>";
      }
      frag.appendChild(tr);
    });
    el.tbody.innerHTML = "";
    el.tbody.appendChild(frag);
    el.tableWrap.hidden = view.rows.length === 0;
    el.actions.hidden = view.rows.length === 0;
    el.belowToggle.hidden = !(view.totals.nBelow > 0 || state.showBelow);
    if (view.totals.nBelow > 0) {
      el.belowToggle.querySelector("span").textContent =
        "Ook de " + view.totals.nBelow + " gebieden onder de drempel tonen";
    }
  }

  function paintTotals(view) {
    if (state.mode === "forward" && !state.selection[state.layer].size) { el.totals.innerHTML = ""; return; }
    if (state.mode === "reverse" && !state.reverse.id) { el.totals.innerHTML = ""; return; }
    var t = view.totals;
    if (state.mode === "reverse") {
      var nSec = view.above.filter(function (r) { return r.kind === "sector"; }).length;
      var nZon = view.above.length - nSec;
      el.totals.innerHTML =
        '<div class="t-main">' + nSec + " " + (nSec === 1 ? "sector" : "sectoren") + " \u00b7 " + nZon + " " + (nZon === 1 ? "zone" : "zones") + "</div>" +
        '<div class="t-sub">' + esc(selectionLabel()) + " \u00b7 " + fmtArea(t.area / Math.max(1, view.above.length) * 0 + (TOTAL[state.reverse.level].get(state.reverse.id) || 0)) + "</div>" +
        '<div class="t-rule">drempel \u2265 ' + state.threshold + " % van dit gebied \u00b7 sectoren overlappen, dus de percentages kunnen samen boven 100 % uitkomen</div>";
      return;
    }
    var lv = LEVELS[state.level];
    var main = fmtInt(t.n) + " " + (t.n === 1 ? lv.label : lv.plural);
    if (state.level !== "sbd") main += ' <span style="font-weight:400;color:var(--ink-3)">(uit ' + fmtInt(t.nSbd) + " subbuurtdelen)</span>";
    el.totals.innerHTML =
      '<div class="t-main">' + main + " \u00b7 " + fmtArea(t.area) + "</div>" +
      '<div class="t-sub">' + fmtInt(t.nFull) + " volledig \u00b7 " + fmtInt(t.nPartial) + " gedeeltelijk" +
      (t.nBelow ? " \u00b7 " + fmtInt(t.nBelow) + " onder de drempel niet meegeteld" : "") + "</div>" +
      '<div class="t-rule">' + esc(selectionLabel()) + " \u00b7 drempel \u2265 " + state.threshold +
      " % van de oppervlakte van " + (state.level === "sbd" ? "het subbuurtdeel" : "de " + lv.label) + "</div>";
  }

  function paintNotice(view) {
    var msgs = [];
    if (state.error) msgs.push("Kon een gegevensbestand niet laden: " + esc(state.error));
    if (state.mode === "forward") {
      state.selection[state.layer].forEach(function (k) {
        var p = PARK.get(k);
        if (!p) return;
        if (p.container) {
          msgs.push("<strong>" + (p.kind === "sector" ? "Sector " : "Zone ") + esc(p.id) +
            " is stadsdekkend</strong> (" + fmtArea(p.area_m2) + ") en levert " + p.n_sbd + " gebieden op.");
        }
        (p.flags || []).forEach(function (f) {
          msgs.push((p.kind === "sector" ? "Sector " : "Zone ") + esc(p.id) + ": " + esc(f) + ".");
        });
      });
      if (view.simplified && view.rows.length) {
        msgs.push("Kaartweergave vereenvoudigd bij " + fmtInt(view.rows.length) + " vlakken \u2014 de lijst is volledig.");
      }
    }
    el.notice.hidden = msgs.length === 0;
    el.notice.innerHTML = msgs.length === 1 ? msgs[0] : "<ul><li>" + msgs.join("</li><li>") + "</li></ul>";
  }

  function paintEmpty(view) {
    var has = state.mode === "forward" ? state.selection[state.layer].size > 0 : !!state.reverse.id;
    if (has) {
      if (view.rows.length === 0 && !state.loading.size) {
        el.empty.innerHTML = '<p class="spinner">Geen gebieden boven de drempel van ' + state.threshold +
          " %. Verlaag de drempel of kies een ander vlak.</p>";
      } else {
        el.empty.innerHTML = "";
      }
      return;
    }
    if (state.mode === "reverse") {
      el.empty.innerHTML = '<div class="empty-card"><h2>Van gebied naar parkeersector</h2>' +
        "<ol><li>Zoek een buurt of subbuurtdeel, of klik een gebied op de kaart aan.</li>" +
        "<li>Je ziet in welke parkeersectoren en zones het ligt, met percentages.</li></ol>" +
        '<p class="foot">Percentages kunnen samen boven 100 % uitkomen: sectoren liggen deels over elkaar heen.</p></div>';
      return;
    }
    el.empty.innerHTML =
      '<div class="empty-card"><h2>Van parkeersector naar TIR-gebiedsindeling</h2><ol>' +
      "<li>Typ een sectornummer \u2014 bijvoorbeeld <strong>75</strong> \u2014 of klik een sector op de kaart aan.</li>" +
      "<li>Je krijgt de subbuurtdelen die voor \u2265\u202f10\u202f% binnen die sector liggen, met percentage en oppervlakte.</li>" +
      "<li>Kopieer de lijst en plak hem in Excel.</li></ol>" +
      '<div class="cta"><button type="button" id="demo">Probeer sector 75</button>' +
      '<button type="button" class="alt" id="demo-help">Wat is een subbuurtdeel?</button></div>' +
      '<p class="foot">Meerdere sectoren mogen. Sectoren mogen elkaar overlappen \u2014 oppervlakte wordt nooit dubbel geteld.</p></div>';
    var d = document.getElementById("demo");
    if (d) d.onclick = function () {
      var e = SEARCH.filter(function (x) { return x.kind === "sector" && x.id === "75"; })[0];
      commit(e, true);
    };
    var dh = document.getElementById("demo-help");
    if (dh) dh.onclick = function () { el.help.showModal(); };
  }

  function paintMode() {
    document.querySelectorAll('input[name="mode"]').forEach(function (r) { r.checked = r.value === state.mode; });
    el.blockLayer.style.display = state.mode === "forward" ? "" : "none";
    el.blockLevel.style.display = state.mode === "forward" ? "" : "none";
    document.querySelectorAll("[data-layer]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.layer === state.layer));
    });
    el.search.placeholder = state.mode === "forward"
      ? (state.layer === "sectoren" ? "bijv. 75 of Oude Noorden" : "bijv. 750 of Oude Noorden")
      : "bijv. Oude Noorden of 053560";
    var loading = Array.from(state.loading);
    el.mapStatus.hidden = loading.length === 0;
    if (loading.length) el.mapStatus.textContent = "kaartlaag wordt geladen\u2026";
  }

  function paintControls() {
    document.querySelectorAll('input[name="level"]').forEach(function (r) { r.checked = r.value === state.level; });
    document.querySelectorAll('input[name="basemap"]').forEach(function (r) { r.checked = r.value === state.basemap; });
    el.threshold.value = state.threshold;
    el.thrOut.textContent = "\u2265 " + state.threshold + " %";
    el.showBelow.checked = state.showBelow;
    el.showAllParking.checked = state.showAllParking;
    el.showLabels.checked = state.showLabels;
    document.querySelectorAll("[data-thr]").forEach(function (b) {
      b.classList.toggle("on", Number(b.dataset.thr) === state.threshold);
    });
    paintLegend();
  }

  function paintLegend() {
    var rev = state.mode === "reverse";
    var c = rev ? "#5B3E9B" : "#1B7F5F";
    function row(sw, label) { return '<div class="row"><span class="sw" style="' + sw + '"></span>' + label + "</div>"; }
    el.legend.innerHTML = "<b>Dekking</b>" +
      row("background:" + c + ";opacity:.62", "volledig") +
      row("background:" + c + ";opacity:.34", "50\u201399 %") +
      row("background:" + c + ";opacity:.16", state.threshold + "\u201350 %") +
      row("border:1px dashed #8A9099", "onder de drempel") +
      (rev ? "" : row("border:2px dashed #6A3D9A", "stadsdekkend")) +
      (rev ? "" : row("border:2px solid #0F62FE", "geselecteerd"));
  }

  function paintChips() {
    var frag = document.createDocumentFragment();
    if (state.mode === "reverse") {
      if (state.reverse.id) {
        frag.appendChild(chip(selectionLabel(), "is-reverse", function () {
          state.reverse.id = null;
          touch("reverse");
        }));
      }
      el.selCount.textContent = "Gekozen gebied";
    } else {
      var ids = Array.from(state.selection[state.layer]).sort(function (a, b) {
        return naturalCmp(PARK.get(a).id, PARK.get(b).id);
      });
      ids.forEach(function (k) {
        var p = PARK.get(k);
        frag.appendChild(chip((p.kind === "sector" ? "Sector " : "Zone ") + p.id,
          p.container ? "is-container" : "", function () {
            state.selection[state.layer].delete(k);
            touch("selection");
          }));
      });
      el.selCount.textContent = "Geselecteerd" + (ids.length ? " (" + ids.length + ")" : "");
    }
    el.chips.innerHTML = "";
    el.chips.appendChild(frag);
  }

  function chip(label, cls, onRemove) {
    var d = document.createElement("span");
    d.className = "chip " + cls;
    d.appendChild(document.createTextNode(label));
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Verwijder " + label);
    b.textContent = "\u00d7";
    b.onclick = onRemove;
    d.appendChild(b);
    return d;
  }

  function paintSuggestions() {
    var open = state.searchOpen && state.query.length > 0;
    el.suggest.hidden = !open;
    el.search.setAttribute("aria-expanded", String(open));
    el.searchClear.hidden = state.query.length === 0;
    if (!open) { el.suggest.innerHTML = ""; return; }
    if (!state.suggestions.length) {
      el.suggest.innerHTML = '<li class="none">geen resultaten voor \u201c' + esc(state.query) + "\u201d</li>";
      return;
    }
    // Geen herordening hier: de index in data-i moet exact overeenkomen met
    // state.suggestions, anders selecteert Enter iets anders dan er staat.
    var html = "";
    state.suggestions.slice(0, CFG.MAX_SUGGEST).forEach(function (e, i) {
      var on = (e.kind === "sector" || e.kind === "zone") &&
        state.selection[e.kind === "sector" ? "sectoren" : "zones"].has(e.key);
      html += '<li role="option" id="sug-' + i + '" data-i="' + i + '" class="' +
        (i === state.active ? "active " : "") + (on ? "on" : "") +
        '" aria-selected="' + (i === state.active) + '">' +
        '<span class="s-main">' + esc(e.label) +
        (e.container ? ' <span class="badge-container">stadsdekkend</span>' : "") + "</span>" +
        '<span class="s-sub">' + esc(e.sub) + "</span></li>";
    });
    el.suggest.innerHTML = html;
    if (state.active >= 0) el.search.setAttribute("aria-activedescendant", "sug-" + state.active);
    else el.search.removeAttribute("aria-activedescendant");
  }

  function paintTabs() {
    document.body.classList.remove("tab-results", "tab-map", "tab-panel");
    document.body.classList.add("tab-" + state.tab);
    el.tabbar.querySelectorAll("[data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
    });
    if (state.tab === "map" && map) setTimeout(function () { map.invalidateSize(); }, 30);
  }

  /* ════════════════════════════════════════════════════ 12. EVENTS ══ */

  function wire() {
    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.onchange = function () {
        setState({ mode: r.value, hover: null, stack: null });
        if (r.value === "reverse") ensureGeo(state.reverse.level);
        touch("selection", "reverse");
      };
    });
    document.querySelectorAll("[data-layer]").forEach(function (b) {
      b.onclick = function () { setState({ layer: b.dataset.layer, hover: null, stack: null }); touch("selection"); };
    });
    document.querySelectorAll('input[name="level"]').forEach(function (r) {
      r.onchange = function () { setState({ level: r.value, hover: null }); ensureGeo(r.value); };
    });
    document.querySelectorAll('input[name="basemap"]').forEach(function (r) {
      r.onchange = function () { setState({ basemap: r.value }); touch("selection"); };
    });
    el.showAllParking.onchange = function () { setState({ showAllParking: el.showAllParking.checked }); };
    el.showLabels.onchange = function () { setState({ showLabels: el.showLabels.checked }); };
    el.showBelow.onchange = function () { setState({ showBelow: el.showBelow.checked }); };

    el.threshold.oninput = function () { setState({ threshold: Number(el.threshold.value) }); };
    document.querySelectorAll("[data-thr]").forEach(function (b) {
      b.onclick = function () { setState({ threshold: Number(b.dataset.thr) }); };
    });

    el.btnClear.onclick = function () {
      state.selection.sectoren.clear();
      state.selection.zones.clear();
      state.reverse.id = null;
      setState({ hover: null, stack: null });
      touch("selection", "reverse");
    };

    var debounce = 0;
    el.search.oninput = function () {
      var v = el.search.value;
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        setState({ query: v, suggestions: rank(v), active: 0, searchOpen: true });
      }, 60);
    };
    el.search.onfocus = function () { if (state.query) setState({ searchOpen: true }); };
    el.searchClear.onclick = function () {
      el.search.value = "";
      setState({ query: "", suggestions: [], active: -1, searchOpen: false });
      el.search.focus();
    };
    el.search.onkeydown = function (ev) {
      var n = Math.min(state.suggestions.length, CFG.MAX_SUGGEST);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!n) return;
        var d = ev.key === "ArrowDown" ? 1 : -1;
        setState({ active: (state.active + d + n) % n, searchOpen: true });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (state.searchOpen && state.suggestions[state.active]) {
          commit(state.suggestions[state.active], ev.ctrlKey || ev.metaKey);
        }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (state.searchOpen) setState({ searchOpen: false });
        else if (state.query) { el.search.value = ""; setState({ query: "", suggestions: [], active: -1 }); }
        else el.search.blur();
      } else if (ev.key === "Backspace" && !el.search.value) {
        var ids = Array.from(state.selection[state.layer]);
        if (ids.length) { state.selection[state.layer].delete(ids[ids.length - 1]); touch("selection"); }
      }
    };
    el.suggest.onmousedown = function (ev) {
      var li = ev.target.closest("li[data-i]");
      if (!li) return;
      ev.preventDefault();
      commit(state.suggestions[Number(li.dataset.i)], ev.ctrlKey || ev.metaKey);
    };
    document.addEventListener("click", function (ev) {
      if (state.searchOpen && !ev.target.closest(".search-block")) setState({ searchOpen: false });
    });

    el.theadRow.onclick = function (ev) {
      var b = ev.target.closest("[data-sort]");
      if (!b) return;
      var k = b.dataset.sort;
      var dir = state.sort.key === k ? (state.sort.dir === "asc" ? "desc" : "asc")
        : (k === "code" || k === "naam" ? "asc" : "desc");
      setState({ sort: { key: k, dir: dir } });
    };
    el.tbody.onmouseover = function (ev) {
      var tr = ev.target.closest("tr[data-code]");
      if (tr && (!state.hover || state.hover.id !== tr.dataset.code)) {
        setState({ hover: { id: tr.dataset.code, from: "row" } });
      }
    };
    el.tbody.onmouseleave = function () { if (state.hover && state.hover.from === "row") setState({ hover: null }); };
    el.tbody.onclick = function (ev) {
      var tr = ev.target.closest("tr[data-code]");
      if (!tr) return;
      var code = tr.dataset.code;
      if (state.mode === "reverse") {
        var geo = window.GD_GEO_SECTOREN.features.filter(function (f) { return String(f.id) === code; });
        if (!geo.length) geo = window.GD_GEO_ZONES.features.filter(function (f) { return String(f.id) === code; });
        if (geo.length) fitTo(boundsOfGeometries(geo.map(function (f) { return f.geometry; })));
      } else if (state.loaded.has(state.level)) {
        var f = geoFor(state.level).features.filter(function (x) { return String(x.id) === code; });
        if (f.length) fitTo(boundsOfGeometries(f.map(function (x) { return x.geometry; })));
      }
      if (state.tab !== "map" && window.matchMedia("(max-width:700px)").matches) setState({ tab: "map" });
    };

    el.btnCopy.onclick = function () {
      var m = exportMatrix(derive());
      copyRich(m, fmtInt(m.rows.length) + " rijen gekopieerd \u2014 plak in Excel");
    };
    el.btnCodes.onclick = function () {
      var view = derive();
      copyPlain(view.rows.map(function (r) { return r.code; }).join("\r\n"),
        fmtInt(view.rows.length) + " codes gekopieerd");
    };
    el.btnCsv.onclick = function () { downloadCSV(exportMatrix(derive())); };

    el.btnHelp.onclick = function () { el.help.showModal(); };
    el.tabbar.onclick = function (ev) {
      var b = ev.target.closest("[data-tab]");
      if (b) setState({ tab: b.dataset.tab });
    };

    document.addEventListener("keydown", function (ev) {
      if (ev.target.matches("input, textarea, select")) return;
      if (ev.key === "/") { ev.preventDefault(); el.search.focus(); }
      else if (ev.key === "?") { ev.preventDefault(); el.help.showModal(); }
      else if (ev.key === "Escape" && state.stack) setState({ stack: null });
    });
  }

  /* ═══════════════════════════════════════════════════════ 13. BOOT ══ */

  function main() {
    grab();
    if (!A || !T || !P) {
      el.empty.innerHTML = "<p><strong>De gegevensbestanden ontbreken.</strong> Draai eerst " +
        "<code>uv run build_data.py</code> om de map <code>gen/</code> te vullen.</p>";
      return;
    }
    el.version.textContent = "data " + (META && META.version ? META.version : "?");
    buildIndexes();
    initMap();
    wire();
    paintBasemap();
    paintTabs();
    touch("mode", "layer", "selection", "level", "threshold", "basemap", "@rows", "showLabels", "tab");
    // Grote kaartlaag op de achtergrond ophalen: het antwoord staat er al voordat
    // de geometrie binnen is.
    ensureGeo("sbd");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
