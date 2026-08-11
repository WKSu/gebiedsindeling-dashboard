/* Regressietest voor app.js.
 *
 * Draait de echte index.html + app.js in jsdom met een Leaflet-stub, zodat de
 * rekenlaag, de tabel en de export getest worden zonder browser.
 *
 *   cd test && npm install && node test_app.mjs
 *
 * Exitcode 1 als een controle faalt.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
let fails = 0;
const log = (s) => console.log(s);

function check(name, cond, extra) {
  if (cond) log(`  ok    ${name}`);
  else { fails++; log(`  FOUT  ${name}${extra ? "  -> " + extra : ""}`); }
}

/* ── Leaflet-stub: alleen wat app.js aanroept ───────────────────────────── */
function makeL() {
  const bounds = () => ({ isValid: () => true, contains: () => true });
  const panes = {};
  const map = {
    _layers: new Set(),
    on() {}, off() {},
    createPane(n) { return (panes[n] = { style: {}, classList: { add() {} } }); },
    getPane(n) { return panes[n] || (panes[n] = { style: {}, classList: { add() {} } }); },
    getZoom: () => 13,
    getBounds: bounds,
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); },
    removeLayer(l) { this._layers.delete(l); },
    flyToBounds() {}, fitBounds() {}, closePopup() {}, invalidateSize() {}, openPopup() {},
  };
  const L = {
    map: () => map,
    control: { zoom: () => ({ addTo() {} }) },
    canvas: () => ({}), svg: () => ({}),
    tileLayer: () => { const t = { addTo: () => (map.addLayer(t), t) }; return t; },
    geoJSON: (data, opts) => {
      const feats = (data && data.features) || [];
      // stijlfunctie meteen uitvoeren: dat vangt fouten in styleForRow op en
      // legt de opgeleverde stijlen vast zodat de test de opmaak kan nakijken
      const styles = typeof (opts && opts.style) === "function"
        ? feats.map((f) => opts.style(f))
        : feats.map(() => opts && opts.style).filter(Boolean);
      const l = {
        _kind: "geoJSON", _n: feats.length, _pane: opts && opts.pane,
        _ids: feats.map((f) => String(f.id)), _styles: styles,
      };
      l.addTo = () => (map.addLayer(l), l);
      l.remove = () => {};
      return l;
    },
    layerGroup: (arr) => {
      const l = { _kind: "layerGroup", _arr: arr || [] };
      l.addTo = () => (map.addLayer(l), l);
      l.remove = () => {};
      return l;
    },
    marker: () => ({}), divIcon: () => ({}),
    popup: () => ({ setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; } }),
    latLngBounds: () => bounds(),
    Browser: {},
  };
  return { L, map };
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<link[^>]*unpkg[^>]*>/g, "")
  .replace(/<script[^>]*unpkg[^>]*><\/script>/g, "");

// Fouten in een requestAnimationFrame-callback slikt jsdom stil op; doorsturen
// zodat een kapotte painter zichtbaar wordt in plaats van als lege DOM.
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { fails++; log("  JSDOM-FOUT " + ((e && e.stack) || e)); });
vc.on("error", (m) => log("  console.error: " + m));

const dom = new JSDOM(html, {
  runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true, virtualConsole: vc,
});
const win = dom.window;
const stub = makeL();
win.L = stub.L;
/** Alle kaartlagen in een pane, inclusief die binnen een layerGroup. */
function layersIn(pane) {
  const out = [];
  for (const l of stub.map._layers) {
    if (l._kind === "layerGroup") l._arr.forEach((c) => { if (c._pane === pane) out.push(c); });
    else if (l._pane === pane) out.push(l);
  }
  return out;
}
if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

for (const f of ["gen/meta.js", "gen/atoms.js", "gen/tir.js", "gen/parking.js",
                 "gen/geo_sectoren.js", "gen/geo_zones.js", "gen/geo_subbuurtdelen.js",
                 "gen/geo_subbuurten.js", "gen/geo_buurten.js", "app.js"]) {
  win.eval(fs.readFileSync(path.join(ROOT, f), "utf8"));
}

/* ── helpers ────────────────────────────────────────────────────────────── */
const doc = win.document;
const rows = () => Array.from(doc.querySelectorAll("#tbody tr"));
const cells = (tr) => Array.from(tr.children).map((td) => td.textContent.trim());
const totals = () => doc.getElementById("totals").textContent.replace(/\s+/g, " ").trim();
const notice = () => doc.getElementById("notice").textContent;
const chips = () => doc.querySelectorAll("#chips .chip").length;
const el = (id) => doc.getElementById(id);

async function waitFor(fn, label, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) {
      if (label) { fails++; log(`  FOUT  time-out: ${label}`); }
      return false;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

function fire(node, type) { node.dispatchEvent(new win.Event(type, { bubbles: true })); }
function setRadio(name, value) {
  const r = doc.querySelector(`input[name="${name}"][value="${value}"]`);
  r.checked = true;
  fire(r, "change");
}
async function typeAndEnter(text, ctrl) {
  const s = el("search");
  s.value = text;
  fire(s, "input");
  await waitFor(() => doc.querySelector("#suggest li[data-i]"), `suggestie voor "${text}"`);
  s.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: !!ctrl, bubbles: true }));
}
async function pickSector75() {
  await waitFor(() => el("demo"), "begintoestand");
  el("demo").click();
  await waitFor(() => rows().length === 11, "11 rijen voor sector 75");
}
async function clearAll() {
  el("btn-clear").click();
  await waitFor(() => rows().length === 0, "leeggemaakt");
}

/* ── 1. opstarten ───────────────────────────────────────────────────────── */
log("\n1. Opstarten");
await waitFor(() => el("demo"), "begintoestand verschijnt");
check("versie in de header", /^data \d{4}-\d{2}-\d{2}$/.test(el("version").textContent), el("version").textContent);
check("begintoestand met 'Probeer sector 75'", !!el("demo"));
check("geen tabel voordat er iets gekozen is", rows().length === 0);

/* ── 2. het gouden geval ────────────────────────────────────────────────── */
log("\n2. Sector 75 (het gouden geval)");
await pickSector75();
const r75 = rows();
const codes = r75.map((tr) => cells(tr)[0]);
const expect = ["053590", "053560", "053530", "053510", "053550", "053520", "053580", "053541", "053540", "053501", "051500"];
check("11 rijen", r75.length === 11, `${r75.length}`);
check("juiste codes, hoogste dekking eerst", JSON.stringify(codes) === JSON.stringify(expect), codes.join(","));
check("voorloopnul blijft staan in de code", codes.every((c) => c.length === 6 && c[0] === "0"));
const pct = r75.map((tr) => cells(tr)[2]);
check("percentages in nl-notatie", pct[0].includes("100,0") && pct[9].includes("66,9"), pct[0] + " / " + pct[9]);
check("laatste rij is Agniesebuurt op 19,0 %", pct[10].includes("19,0") && cells(r75[10])[1].startsWith("Agniesebuurt"), pct[10]);
check("buurt- en gebiedsnaam gevuld", cells(r75[0])[1].startsWith("Oude Noorden") && cells(r75[0])[1].includes("Noord"), cells(r75[0])[1]);
check("totalen: 11 subbuurtdelen", /\b11 subbuurtdelen/.test(totals()), totals());
check("totalen: 8 volledig", /8 volledig/.test(totals()), totals());
check("totalen: 12 onder de drempel benoemd", /12 onder de drempel/.test(totals()), totals());
check("totalen: de telregel staat erbij", /drempel ≥ 10 % van de oppervlakte/.test(totals()), totals());
check("chip 'Sector 75'", doc.querySelector("#chips .chip").textContent.startsWith("Sector 75"));

/* ── 3. drempel ─────────────────────────────────────────────────────────── */
log("\n3. Drempel verschuiven");
async function setThreshold(v, expectN) {
  el("threshold").value = String(v);
  fire(el("threshold"), "input");
  await waitFor(() => rows().length === expectN, `${expectN} rijen bij ${v} %`);
  return rows().length;
}
check("bij 50 % blijven 10 rijen", (await setThreshold(50, 10)) === 10, `${rows().length}`);
check("bij 0 % alle 23 geraakte vlakken", (await setThreshold(0, 23)) === 23, `${rows().length}`);
check("terug naar 11 bij 10 %", (await setThreshold(10, 11)) === 11, `${rows().length}`);

/* ── 4. snippers ────────────────────────────────────────────────────────── */
log("\n4. Gebieden onder de drempel");
el("show-below").checked = true;
fire(el("show-below"), "change");
await waitFor(() => rows().length === 23, "23 rijen met snippers");
check("23 rijen met de snippers erbij", rows().length === 23, `${rows().length}`);
check("12 snipperrijen zijn gemarkeerd", rows().filter((tr) => tr.className === "below").length === 12,
  String(rows().filter((tr) => tr.className === "below").length));
el("show-below").checked = false;
fire(el("show-below"), "change");
await waitFor(() => rows().length === 11, "terug naar 11");

/* ── 5. overlappende sectoren ───────────────────────────────────────────── */
log("\n5. Overlappende sectoren nooit dubbeltellen");
const s = el("search");
s.value = "99";
fire(s, "input");
await waitFor(() => doc.querySelector("#suggest li[data-i]"), "suggestielijst voor 99");
const first = doc.querySelector("#suggest li[data-i]");
check("eerste suggestie is Sector 99 (exacte match wint van demotie)",
  /^Sector 99\b/.test(first.textContent.trim()), first.textContent.trim().slice(0, 50));
check("stadsdekkend krijgt een badge in de lijst", /stadsdekkend/.test(first.textContent));
s.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await waitFor(() => rows().length > 400, "veel rijen na sector 99");
const pcts = rows().map((tr) => parseFloat(cells(tr)[2].replace(/[^\d,]/g, "").replace(",", ".")));
check("selectie bevat nu 2 sectoren", chips() === 2, String(chips()));
check("geen enkel percentage boven 100", pcts.every((p) => p <= 100.001), "max " + Math.max(...pcts));
check("stadsdekkende sector levert >400 rijen", rows().length > 400, String(rows().length));
check("waarschuwing dat de sector stadsdekkend is", /stadsdekkend/i.test(notice()));
check("melding dat de kaart vereenvoudigd is", /vereenvoudigd/i.test(notice()));

/* ── 6. uitvoerniveau ───────────────────────────────────────────────────── */
log("\n6. Uitvoerniveau");
await clearAll();
await pickSector75();
for (const [lvl, len] of [["sb", 5], ["bu", 4]]) {
  setRadio("level", lvl);
  await waitFor(() => rows().length > 0 && cells(rows()[0])[0].length === len, `niveau ${lvl}`);
  const cs = rows().map((tr) => cells(tr)[0]);
  check(`niveau ${lvl}: ${cs.length} rijen, codes van ${len} tekens`,
    cs.length > 0 && cs.length <= 11 && cs.every((c) => c.length === len), cs.join(","));
  check(`niveau ${lvl}: totalen noemen "uit N subbuurtdelen"`, /uit \d+ subbuurtdelen/.test(totals()), totals());
  check(`niveau ${lvl}: nooit boven 100 %`,
    rows().every((tr) => parseFloat(cells(tr)[2].replace(/[^\d,]/g, "").replace(",", ".")) <= 100.001));
}
setRadio("level", "sbd");
await waitFor(() => rows().length === 11, "terug naar subbuurtdeel");

/* ── 7. sorteren ────────────────────────────────────────────────────────── */
log("\n7. Sorteren");
doc.querySelector('#thead-row [data-sort="code"]').click();
await waitFor(() => cells(rows()[0])[0] === "051500", "op code oplopend");
const sorted = rows().map((tr) => cells(tr)[0]);
check("op code oplopend", JSON.stringify(sorted) === JSON.stringify([...sorted].sort()), sorted.join(","));
doc.querySelector('#thead-row [data-sort="code"]').click();
await waitFor(() => cells(rows()[0])[0] === "053590", "op code aflopend");
check("nogmaals klikken keert de richting om", cells(rows()[0])[0] === "053590", cells(rows()[0])[0]);
doc.querySelector('#thead-row [data-sort="pct"]').click();
await waitFor(() => cells(rows()[0])[2].includes("100,0"), "terug op dekking");

/* ── 8. omgekeerd opzoeken ──────────────────────────────────────────────── */
log("\n8. Omgekeerd opzoeken");
setRadio("mode", "reverse");
await waitFor(() => el("thead-row").textContent.includes("% van gebied"), "omgekeerde kolommen");
await typeAndEnter("051500");
await waitFor(() => rows().length > 0, "parkeervlakken voor 051500");
const revRows = rows().map(cells);
const s75row = revRows.find((c) => c[0].startsWith("Sector 75"));
check("051500 levert parkeervlakken op", revRows.length > 0, String(revRows.length));
check("sector 75 staat erbij op 19,0 %", !!s75row && s75row[1].includes("19,0"), JSON.stringify(s75row));
check("kolom '% van gebied' aanwezig", el("thead-row").textContent.includes("% van gebied"));
check("kolom '% van vlak' aanwezig", el("thead-row").textContent.includes("% van vlak"));
check("melding dat percentages samen boven 100 % kunnen komen", /boven 100 %/.test(totals()), totals());

/* ── 9. leesbaarheid van de grenzen ─────────────────────────────────────── */
log("\n9. Grens van de selectie");
setRadio("mode", "forward");
await clearAll();
await pickSector75();
await waitFor(() => layersIn("gd-outline").length > 0, "contourlaag getekend");

const outline = layersIn("gd-outline");
check("selectiegrens zit in een eigen pane boven de dekkingsvlakken", outline.length === 2,
  `${outline.length} lagen`);
const casing = outline[0] && outline[0]._styles[0];
const accent = outline[1] && outline[1]._styles[0];
check("grens is dubbel getekend: witte omranding onder de lijn",
  casing && casing.color === "#ffffff" && casing.weight > (accent ? accent.weight : 99),
  JSON.stringify(casing));
check("de lijn zelf is dik en volledig dekkend",
  accent && accent.weight >= 3 && accent.opacity === 1 && accent.fill === false, JSON.stringify(accent));
check("contourlaag bevat alleen de gekozen sector", outline[1]._ids.join(",") === "75", outline[1]._ids.join(","));

const ctx = layersIn("gd-parking")[0];
check("overige parkeervlakken staan in de contextlaag", !!ctx && ctx._n > 50, ctx ? String(ctx._n) : "geen");
check("de gekozen sector zit NIET dubbel in de contextlaag", ctx && ctx._ids.indexOf("75") === -1);
check("stadsdekkende sectoren worden niet als ruis meegetekend",
  ctx && ["97", "99", "100"].every((id) => ctx._ids.indexOf(id) === -1), (ctx ? ctx._ids : []).join(",").slice(0, 40));
check("contextlijnen wijken terug zodra er een selectie is",
  ctx && ctx._styles[0].opacity < 0.3 && ctx._styles[0].weight < 1, JSON.stringify(ctx && ctx._styles[0]));

const res = layersIn("gd-result")[0];
check("dekkingsvlakken hebben dunne, halftransparante binnengrenzen",
  res && res._styles[0].weight < 1 && res._styles[0].opacity < 0.7, JSON.stringify(res && res._styles[0]));
check("binnengrens is duidelijk zwakker dan de selectiegrens",
  res && accent && res._styles[0].weight * res._styles[0].opacity < accent.weight * accent.opacity / 3);

// gemengde selectie: alleen de stadsdekkende sector krijgt streepjes
await typeAndEnter("99");
await waitFor(() => layersIn("gd-outline").length === 2 && layersIn("gd-outline")[1]._ids.length === 2,
  "contour om beide sectoren");
const mixed = layersIn("gd-outline")[1];
const dashBy = {};
mixed._ids.forEach((id, i) => { dashBy[id] = mixed._styles[i].dashArray; });
check("stadsdekkende sector 99 krijgt een streepjeslijn", !!dashBy["99"], JSON.stringify(dashBy));
check("gewone sector 75 houdt een doorlopende lijn", !dashBy["75"], JSON.stringify(dashBy));

// zonder selectie mogen de contourlijnen weer normaal aanzetten
await clearAll();
await waitFor(() => layersIn("gd-outline").length === 0, "contourlaag weg na wissen");
const ctx0 = layersIn("gd-parking")[0];
check("zonder selectie geen selectiegrens meer", layersIn("gd-outline").length === 0);
check("zonder selectie zijn de contourlijnen weer normaal zichtbaar",
  ctx0 && ctx0._styles[0].opacity > 0.5, JSON.stringify(ctx0 && ctx0._styles[0]));

// omgekeerde modus: het gekozen gebied krijgt dezelfde nadruk
setRadio("mode", "reverse");
await typeAndEnter("051500");
await waitFor(() => layersIn("gd-outline").length === 2, "contour om het gekozen gebied");
const revOutline = layersIn("gd-outline");
check("ook het gekozen gebied krijgt een dubbele grens", revOutline.length === 2);
check("contour ligt om subbuurtdeel 051500", revOutline[1]._ids.join(",") === "051500", revOutline[1]._ids.join(","));
check("in omgekeerde modus is de lijn donker in plaats van blauw",
  revOutline[1]._styles[0].color === "#111827", revOutline[1]._styles[0].color);

check("legenda benoemt de gekozen grens",
  /Grenzen/.test(el("legend").textContent) && /gekozen gebied/.test(el("legend").textContent),
  el("legend").textContent.replace(/\s+/g, " "));
setRadio("mode", "forward");
await clearAll();
await pickSector75();
check("legenda benoemt in voorwaartse modus de gekozen sector",
  /gekozen sector/.test(el("legend").textContent), el("legend").textContent.replace(/\s+/g, " "));

/* ── 10. export ─────────────────────────────────────────────────────────── */
log("\n10. Export naar Excel");

let copiedText = null, copiedFlavours = null;
class FakeBlob { constructor(parts) { this._t = parts.join(""); } text() { return Promise.resolve(this._t); } }
win.Blob = FakeBlob;
win.ClipboardItem = class { constructor(m) { this.map = m; } };
win.navigator.clipboard = {
  write: async (items) => { copiedFlavours = items[0].map; },
  writeText: async (t) => { copiedText = t; },
};

el("btn-codes").click();
await waitFor(() => copiedText !== null, "codes gekopieerd");
check("codes: 11 regels", copiedText && copiedText.split("\r\n").length === 11, String(copiedText && copiedText.split("\r\n").length));
check("codes: voorloopnul intact", copiedText && copiedText.startsWith("053590"), (copiedText || "").slice(0, 10));

el("btn-copy").click();
await waitFor(() => copiedFlavours !== null, "tabel gekopieerd");
const htmlFlavour = copiedFlavours["text/html"]._t;
const tsv = copiedFlavours["text/plain"]._t;
check("klembord bevat een text/html-variant", !!htmlFlavour);
check("codecellen dragen mso-number-format (Excel houdt de voorloopnul)",
  htmlFlavour.includes("mso-number-format") && htmlFlavour.includes(">053590<"));
check("TSV: kopregel + 11 rijen", tsv.split("\r\n")[0].split("\t")[0] === "Code" && tsv.split("\r\n").length === 12,
  tsv.split("\r\n").length + " regels");
check("TSV: komma als decimaalteken", /\t66,92\t/.test(tsv));
check("TSV: geen U+00A0 (die maakt Excel er tekst van)", tsv.indexOf(" ") === -1);
check("TSV: selectiekolom benoemt zichzelf", tsv.includes("Sector 75"));

let csvText = null, csvName = null;
win.URL.createObjectURL = (b) => { csvText = b._t; return "blob:x"; };
win.URL.revokeObjectURL = () => {};
const realCreate = doc.createElement.bind(doc);
doc.createElement = (tag) => {
  const e = realCreate(tag);
  if (tag === "a") e.click = () => { csvName = e.getAttribute("download"); };
  return e;
};
el("btn-csv").click();
await waitFor(() => csvText !== null, "CSV gemaakt");
doc.createElement = realCreate;
check("CSV begint met een UTF-8 BOM", csvText.charCodeAt(0) === 0xfeff);
check("CSV gebruikt puntkomma (want komma is decimaalteken)", csvText.split("\r\n")[0].includes(";"));
check('CSV beschermt codes met ="053590"', csvText.includes('="053590"'));
check("CSV-naam noemt niveau, selectie, drempel en peildatum",
  /^subbuurtdelen_sector-75_drempel-10pct_\d{4}-\d{2}-\d{2}\.csv$/.test(csvName || ""), String(csvName));

log(`\n${fails === 0 ? "Alle controles geslaagd." : fails + " controle(s) mislukt."}`);
process.exit(fails ? 1 : 0);
