# Parkeersectoren → TIR-gebiedsindeling

Statisch hulpmiddel dat de vraag *"ik wil sector 75 geteld hebben"* omzet in de juiste
**subbuurtdelen**. Kies op de kaart (of via het zoekveld) een of meer parkeersectoren of
parkeerzones en je krijgt de TIR-gebieden die daarbinnen liggen, met dekkingspercentage en
oppervlakte, klaar om in Excel te plakken.

**→ [Open het hulpmiddel](https://wksu.github.io/gebiedsindeling-dashboard/)**

## Waarom dit nodig is

Parkeersectoren en de Territoriale Indeling Rotterdam zijn twee losse indelingen die geen
gemeenschappelijke sleutel hebben en wier grenzen niet samenvallen. Elke sector levert dus
een set volledig omsloten subbuurtdelen op, plus een aantal die er maar gedeeltelijk in
liggen, plus een staart van randsnippers die je juist *niet* wilt meetellen. Dat handmatig
in GIS uitzoeken is werk per aanvraag en foutgevoelig.

Voorbeeld — sector 75 raakt 23 subbuurtdelen, maar het antwoord is er 11:

| Code | Buurt | Dekking |
|---|---|---|
| 053590, 053530, 053560 | Oude Noorden | 100,00 % |
| 053510 | Oude Noorden | 99,87 % |
| 053550 | Oude Noorden | 99,79 % |
| 053520 | Oude Noorden | 99,73 % |
| 053580 | Oude Noorden | 99,62 % |
| 053541 | Oude Noorden | 99,58 % |
| 053540 | Oude Noorden | 98,98 % |
| 053501 | Oude Noorden | 66,92 % |
| 051500 | Agniesebuurt | 18,98 % |
| *— drempel 10 % —* | | |
| 051530 | Agniesebuurt | 9,33 % |
| 053570, 051510, 053430, 083614, … | Liskwartier, Crooswijk, Bergpolder | < 6 % |

## De telregel

Een gebied telt mee als **minstens 10 %** van zijn *eigen* oppervlakte binnen de selectie
ligt. De drempel is met een schuif aan te passen (0–100 %); wat eronder valt blijft
opvraagbaar onder de tabel en wordt altijd in de totaalregel genoemd, zodat het antwoord zijn
eigen aannames niet verbergt.

Percentages zijn altijd `oppervlak binnen de selectie ÷ totale oppervlakte van het gebied`,
berekend in RD New (EPSG:28992). Nooit gedeeld door de som van de snijstukken — dat zou een
snipper op 100 % zetten.

## Overlappende sectoren

Sector 99 (51,5 km²), 100 (47,3 km²) en 97 (8,4 km²) zijn stadsdekkende vlakken die over de
overige sectoren heen liggen; 338 sectorparen overlappen elkaar. Twee gevolgen:

- **Op de kaart** kiest een klik altijd het *kleinste* vlak onder de cursor. Met de
  rechtermuisknop zie je wat er nog onder ligt en kun je dat alsnog kiezen.
- **In de berekening** wordt oppervlakte nooit dubbel geteld. Selecteer je 75, 99 en 100 samen,
  dan blijft de dekking netjes op 100 % staan waar naïef optellen op **300 %** zou uitkomen.

Dat laatste werkt via een *atomaire overlay*: bij het bouwen wordt elk subbuurtdeel opgedeeld
in stukjes met een unieke set overlappende parkeervlakken. De dekking van een selectie is dan
de som van de stukjes waarvan de set de selectie raakt — per definitie geen dubbeltelling.

## Let op bij zones

Een sector selecteren is **niet** hetzelfde als al zijn zones selecteren. Bij sector 58 is de
zone-oppervlakte zelfs 31,6 % groter dan de sector zelf, en bij tien sectoren dekken de zones
minder dan 95 % van de sector (67: 64,9 % ongedekt, 5en6: 37,2 %, 68: 35,1 %). Waar dit
speelt, meldt het hulpmiddel dat bij de selectie. Sectoren 67 en 68 hebben identieke
geometrie.

## Zelf bouwen

```bash
uv run build_data.py      # shapefiles -> gen/, met alle controles
```

Duurt ongeveer een halve minuut en heeft geen installatie nodig behalve
[uv](https://docs.astral.sh/uv/). Het script eindigt met een controleblok en stopt met
exitcode 1 als een van de controles faalt — onder andere op record­aantallen, de exacte
TIR-hiërarchie, de zone→sector-toewijzing, oppervlakte­reconciliatie per subbuurtdeel, de
garantie dat dekking nooit boven 100 % komt, en het gouden geval sector 75.

Site lokaal bekijken:

```bash
python -m http.server 8123     # of: npx serve .
```

`index.html` werkt ook rechtstreeks vanaf een netwerkschijf: de datalagen worden als
`window.GD_*`-scripts geladen in plaats van via `fetch()`, dat onder `file://` geblokkeerd is.
Leaflet en de achtergrondkaart komen wel van internet.

Regressietest van de rekenlaag en de export (jsdom, geen browser nodig):

```bash
npm install jsdom && node test/test_app.mjs
```

## Bestanden

| | |
|---|---|
| `build_data.py` | bouwt de datalaag uit de shapefiles en controleert die |
| `index.html`, `app.js`, `app.css` | het hulpmiddel zelf; geen framework, geen bundler |
| `gen/*.js` | wat de site laadt (`window.GD_*`) |
| `gen/*.json`, `gen/*.geojson` | dezelfde data los, voor hergebruik in QGIS of scripts |
| `data/` | de bronshapefiles (RD New) |
| `test/test_app.mjs` | regressietest, inclusief het gouden geval sector 75 |

De datalaag is samen ongeveer 1,9 MB, gzipped ±425 KB. `gen/atoms.js` — het hart van de
berekening — is maar 44 KB: 1678 stukjes en 311 unieke sleutelsets.

### Gegevensafspraak

`gen/atoms.js` bevat vier parallelle lijsten, waarmee de hele berekening in de browser
neerkomt op één doorloop:

```js
{ keys:  ["S1", …, "Z9990"],           // 192 sleutels, "S"=sector, "Z"=zone
  sbd:   ["011010", …],                // 1370 subbuurtdeelcodes
  sets:  [[3], [3,41], …],             // 311 unieke sets van key-indexen
  atoms: [[sbdIx, oppervlak_m2, setIx], …] }   // 1678 stukjes
```

Subbuurt, buurt en gebied volgen uit de code: `053560` → subbuurt `05356` → buurt `0535` →
gebied `05`. Die nesting is exact — de oppervlaktesom van de subbuurtdelen komt op 0,0 m² met
het moedervlak overeen — dus één tabel op subbuurtdeelniveau volstaat voor alle niveaus.

## Bekende beperkingen

- Parkeersectoren dekken niet de hele stad; buiten het betaald-parkerengebied is er niets op
  te halen.
- De sectorvlakken lopen samen 4.666 m² buiten het TIR-gemeentevlak, dus een sector is nooit
  op de vierkante meter volledig te verantwoorden.
- Geometrie op de kaart is topologie-behoudend vereenvoudigd op 2 m. Oppervlakten en
  percentages komen altijd uit de **onvereenvoudigde** bron.
- Subbuurten en subbuurtdelen hebben in de bron geen naam; ze worden aangeduid met hun code
  plus de naam van de buurt waarin ze liggen.

## Bron

Territoriale Indeling Rotterdam en Parkeergrenzen, gemeente Rotterdam. Peildatum staat in de
kop van het hulpmiddel en in `gen/meta.json`. Achtergrondkaart: BRT Achtergrondkaart via
PDOK / Kadaster.
