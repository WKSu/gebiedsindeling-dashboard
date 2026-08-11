# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "geopandas>=1.0",
#     "pyogrio>=0.10",
#     "shapely>=2.0",
#     "topojson>=1.9",
# ]
# ///
"""Bouw de statische datalaag voor het gebiedsindeling-dashboard.

Leest de TIR- en Parkeergrenzen-shapefiles en schrijft naar gen/:

    atoms.js / atoms.json        atomaire overlay: oppervlak per (subbuurtdeel, set parkeersleutels)
    tir.js / tir.json            codes, namen en oppervlakten van de TIR-hierarchie
    parking.js / parking.json    sectoren en zones met metadata en kwaliteitsvlaggen
    geo_*.js / geo_*.geojson  vereenvoudigde geometrie in EPSG:4326

De .js-varianten zetten een globale variabele (window.GD_*) zodat index.html ook
werkt als je het bestand rechtstreeks vanaf een netwerkschijf opent (file:// blokkeert
fetch() van lokale JSON). De .json/.geojson-varianten zijn er voor hergebruik.

Uitvoeren met:  uv run build_data.py
"""

from __future__ import annotations

import gzip
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import shapely
from shapely.errors import ShapelyError
from shapely.geometry import Polygon, mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import polylabel

# --------------------------------------------------------------------------- config

RD = 28992
WGS = 4326

SIMPLIFY_TOL_M = 2.0
COORD_DECIMALS = 5
ATOM_EPS_M2 = 0.01
AREA_DECIMALS = 1
CONTAINER_AREA_M2 = 5_000_000.0

#: Peildatum van deze build; komt in elk uitvoerbestand en in de kop van de site.
BUILD_DATE = datetime.now().astimezone().date().isoformat()

#: Zones waarvan ZONE_ID[:-1] geen bestaande sector is. Ruimtelijk vastgesteld:
#: zones 40/41/42 liggen 100% in 4en5, zones 50/51/60 liggen 100% in 5en6.
ZONE_PARENT_OVERRIDE = {"4": "4en5", "5": "5en6", "6": "5en6"}

ROOT = Path(__file__).parent
DATA = ROOT / "data"
OUT = ROOT / "gen"

TIR_LEVELS = ("Gemeente", "Gebieden", "Buurten", "Subbuurten", "Subbuurtdelen")

EXPECTED_COUNTS = {
    "ParkeerSectoren": 67,
    "ParkeerZones": 125,
    "Gemeente": 1,
    "Gebieden": 21,
    "Buurten": 91,
    "Subbuurten": 578,
    "Subbuurtdelen": 1370,
}

_problems: list[str] = []
_report: dict[str, Any] = {}


def fail(msg: str) -> None:
    """Registreer een harde fout; main() stopt na alle controles."""
    _problems.append(msg)
    print(f"  FOUT     {msg}")


def warn(msg: str) -> None:
    print(f"  let op   {msg}")


def ok(msg: str) -> None:
    print(f"  ok       {msg}")


def head(msg: str) -> None:
    print(f"\n{msg}\n{'-' * len(msg)}")


# ------------------------------------------------------------------------ inlezen


def read_shapefile(path: Path) -> gpd.GeoDataFrame:
    """Lees een shapefile en forceer EPSG:28992.

    De .prj van deze bestanden is ESRI-WKT zonder AUTHORITY-code, dus automatische
    CRS-detectie levert een naamloos CRS op waarmee to_crs() stil de verkeerde
    transformatie kiest. Daarom altijd expliciet overschrijven.
    """
    if not path.exists():
        msg = f"shapefile niet gevonden: {path}"
        raise FileNotFoundError(msg)
    gdf = gpd.read_file(path, engine="pyogrio")
    gdf = gdf.set_crs(RD, allow_override=True)
    if gdf.empty:
        msg = f"shapefile is leeg: {path}"
        raise ValueError(msg)
    return gdf


def load_tir(level: str) -> gpd.GeoDataFrame:
    return read_shapefile(DATA / "TIR" / level / f"{level}_vlakken.shp")


def load_parking(name: str) -> gpd.GeoDataFrame:
    # Let op: "<name>.shp" is hier een map, met daarin het echte shapefile.
    return read_shapefile(DATA / "Parkeergrenzen" / f"{name}.shp" / f"{name}.shp")


# ------------------------------------------------------------------- geometriehulp


def polygonal(geom: BaseGeometry) -> BaseGeometry:
    """Houd alleen de 2D-onderdelen over.

    shapely.intersection/difference geven op randen die elkaar raken regelmatig
    LineStrings, Points en GeometryCollections terug. Zonder deze filter komen die
    in de atoomtabel terecht en breken ze elke latere dissolve of GeoJSON-export.
    """
    if geom.is_empty:
        return geom
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [
        g for g in shapely.get_parts(geom) if g.geom_type in ("Polygon", "MultiPolygon")
    ]
    if not parts:
        return Polygon()
    return shapely.union_all(parts)


def label_anchor(geom: BaseGeometry) -> tuple[float, float]:
    """Ankerpunt voor een label: pool van ontoegankelijkheid van het grootste deel.

    Het zwaartepunt van een MultiPolygon ligt bij door de Maas gesplitste sectoren
    midden in het water.
    """
    parts = [g for g in shapely.get_parts(geom) if g.geom_type == "Polygon"]
    if not parts:
        pt = geom.representative_point()
        return (pt.x, pt.y)
    biggest = max(parts, key=lambda g: g.area)
    try:
        pt = polylabel(biggest, tolerance=10.0)
    except (ValueError, ShapelyError):
        pt = biggest.representative_point()
    return (pt.x, pt.y)


def natural_key(value: str) -> tuple[Any, ...]:
    """Sorteersleutel waarin '99' voor '100' komt en 'Markt' achteraan."""
    parts = re.split(r"(\d+)", value)
    return tuple(
        (0, int(p)) if p.isdigit() else (1, p.lower()) for p in parts if p != ""
    )


def round_coords(obj: Any, decimals: int) -> Any:
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(c), decimals) for c in obj]
        return [round_coords(o, decimals) for o in obj]
    return obj


# ------------------------------------------------------------------- structuurcheck


def check_geometry(gdf: gpd.GeoDataFrame, label: str) -> dict[str, Any]:
    types = gdf.geom_type.value_counts().to_dict()
    n_invalid = int((~gdf.geometry.is_valid).sum())
    rings = int(sum(len(g.interiors) for g in gdf.geometry.explode(index_parts=False)))
    info = {
        "n": len(gdf),
        "types": types,
        "invalid": n_invalid,
        "interior_rings": rings,
        "area_km2": round(float(gdf.area.sum()) / 1e6, 5),
    }
    expected = EXPECTED_COUNTS.get(label)
    suffix = (
        "" if expected is None or expected == len(gdf) else f"  (verwacht {expected}!)"
    )
    if expected is not None and expected != len(gdf):
        warn(
            f"{label}: {len(gdf)} objecten, verwacht {expected} - controleer de bronbestanden"
        )
    if n_invalid:
        fail(f"{label}: {n_invalid} ongeldige geometrieen")
    print(
        f"  {label:16s} {len(gdf):5d} obj  {info['area_km2']:>10.4f} km²  "
        f"{types}  gaten={rings}  ongeldig={n_invalid}{suffix}"
    )
    return info


def tir_code(row: Any, level: str) -> str:
    """Herbouw TEKST uit de numerieke velden: gebied(2) buurt(2) subbuurt(1) deel(1)."""
    code = f"{int(row.GEBIED):02d}"
    if level in ("Buurten", "Subbuurten", "Subbuurtdelen"):
        code += f"{int(row.BUURT):02d}"
    if level in ("Subbuurten", "Subbuurtdelen"):
        code += f"{int(row.SUBBUURT):d}"
    if level == "Subbuurtdelen":
        code += f"{int(row.SBTDEEL):d}"
    return code


def verify_tir_codes(tir: dict[str, gpd.GeoDataFrame]) -> None:
    for level in ("Gebieden", "Buurten", "Subbuurten", "Subbuurtdelen"):
        gdf = tir[level]
        rebuilt = [tir_code(r, level) for r in gdf.itertuples()]
        mismatch = sum(1 for a, b in zip(rebuilt, gdf.TEKST, strict=True) if a != b)
        if mismatch:
            fail(f"{level}: TEKST wijkt af van de numerieke velden in {mismatch} rijen")
        else:
            ok(
                f"{level}: TEKST == gebied(2)+buurt(2)+subbuurt(1)+deel(1) voor alle {len(gdf)} rijen"
            )

    sbd = set(tir["Subbuurtdelen"].TEKST)
    for level, width in (("Subbuurten", 5), ("Buurten", 4), ("Gebieden", 2)):
        parents = set(tir[level].TEKST)
        derived = {c[:width] for c in sbd}
        if derived != parents:
            fail(
                f"{level}: prefix-nesting klopt niet - "
                f"{len(derived - parents)} onbekende ouders, {len(parents - derived)} zonder kinderen"
            )
        else:
            ok(
                f"{level}: subbuurtdeel[:{width}] dekt precies alle {len(parents)} objecten"
            )


def verify_tir_areas(tir: dict[str, gpd.GeoDataFrame]) -> None:
    sbd = tir["Subbuurtdelen"]
    areas = dict(zip(sbd.TEKST, sbd.area, strict=True))
    for level, width in (("Subbuurten", 5), ("Buurten", 4), ("Gebieden", 2)):
        summed: dict[str, float] = {}
        for code, area in areas.items():
            summed[code[:width]] = summed.get(code[:width], 0.0) + area
        parent = tir[level]
        worst = 0.0
        for code, area in zip(parent.TEKST, parent.area, strict=True):
            worst = max(worst, abs(summed[code] - area))
        if worst > 1.0:
            fail(
                f"{level}: oppervlaktesom wijkt tot {worst:.3f} m² af van het moedervlak"
            )
        else:
            ok(f"{level}: oppervlaktesom komt overeen (max afwijking {worst:.6f} m²)")
    total = sum(areas.values())
    gem = float(tir["Gemeente"].area.sum())
    ok(f"totaal {total / 1e6:.5f} km² (gemeentevlak {gem / 1e6:.5f} km²)")


def zone_parent(zone_id: str) -> str:
    stem = zone_id[:-1] if len(zone_id) > 1 else zone_id
    return ZONE_PARENT_OVERRIDE.get(stem, stem)


def verify_zone_parents(
    sec: gpd.GeoDataFrame, zon: gpd.GeoDataFrame
) -> tuple[dict[str, str], dict[str, dict[str, float]]]:
    parents = {z: zone_parent(z) for z in zon.SECTOR_KEY_SRC}
    known = set(sec.SECTOR_ID)
    unmapped = sorted({p for p in parents.values() if p not in known}, key=natural_key)
    if unmapped:
        fail(f"zones zonder bestaande sector: {unmapped}")
    else:
        overridden = [z for z, p in parents.items() if z[:-1] != p]
        ok(
            f"alle {len(parents)} zones toegewezen aan een sector "
            f"({len(overridden)} via de overridetabel: {', '.join(sorted(overridden, key=natural_key))})"
        )

    sec_geom = dict(zip(sec.SECTOR_ID, sec.geometry, strict=True))
    zon_geom = dict(zip(zon.SECTOR_KEY_SRC, zon.geometry, strict=True))
    stats: dict[str, dict[str, float]] = {}
    by_parent: dict[str, list[str]] = {}
    for zid, pid in parents.items():
        by_parent.setdefault(pid, []).append(zid)
    for pid, zids in by_parent.items():
        if pid not in sec_geom:
            continue
        union = shapely.union_all([zon_geom[z] for z in zids])
        s = sec_geom[pid]
        outside = polygonal(shapely.difference(union, s)).area
        uncovered = polygonal(shapely.difference(s, union)).area
        stats[pid] = {
            "zones_outside_sector_pct": round(100.0 * outside / union.area, 2)
            if union.area
            else 0.0,
            "sector_not_covered_by_zones_pct": round(100.0 * uncovered / s.area, 2)
            if s.area
            else 0.0,
        }
    for pid, st in sorted(
        stats.items(), key=lambda kv: -kv[1]["zones_outside_sector_pct"]
    ):
        if st["zones_outside_sector_pct"] > 1.0:
            warn(
                f"sector {pid}: {st['zones_outside_sector_pct']:.1f}% van de zone-oppervlakte "
                f"ligt buiten de sector zelf"
            )
    low = [
        (p, s["sector_not_covered_by_zones_pct"])
        for p, s in stats.items()
        if s["sector_not_covered_by_zones_pct"] > 5.0
    ]
    if low:
        warn(
            "sectoren die niet door hun zones gedekt worden: "
            + ", ".join(
                f"{p} ({v:.1f}%)" for p, v in sorted(low, key=lambda kv: -kv[1])
            )
        )
        warn("een sector selecteren is dus niet hetzelfde als al zijn zones selecteren")
    no_zones = sorted(set(sec.SECTOR_ID) - set(by_parent), key=natural_key)
    if no_zones:
        ok(f"{len(no_zones)} sectoren zonder zones: {', '.join(no_zones)}")
    return parents, stats


def analyse_overlaps(
    gdf: gpd.GeoDataFrame, id_col: str, label: str, min_m2: float = 50.0
) -> dict[str, Any]:
    ids = list(gdf[id_col])
    geoms = list(gdf.geometry)
    areas = [g.area for g in geoms]
    sindex = gdf.sindex
    overlaps: dict[str, list[str]] = {i: [] for i in ids}
    identical: list[tuple[str, str]] = []
    contains: dict[str, list[str]] = {i: [] for i in ids}
    n_pairs = 0
    total_overlap = 0.0
    for a in range(len(ids)):
        for b in sindex.query(geoms[a], predicate="intersects"):
            b = int(b)
            if b <= a:
                continue
            inter = polygonal(shapely.intersection(geoms[a], geoms[b])).area
            if inter <= min_m2:
                continue
            n_pairs += 1
            total_overlap += inter
            overlaps[ids[a]].append(ids[b])
            overlaps[ids[b]].append(ids[a])
            if (
                abs(areas[a] - areas[b]) < 1.0
                and polygonal(shapely.symmetric_difference(geoms[a], geoms[b])).area
                < 1.0
            ):
                identical.append((ids[a], ids[b]))
            if inter >= 0.99 * areas[a]:
                contains[ids[b]].append(ids[a])
            if inter >= 0.99 * areas[b]:
                contains[ids[a]].append(ids[b])
    union = float(shapely.union_all(geoms).area)
    print(
        f"  {label}: som {sum(areas) / 1e6:.3f} km² vs vereniging {union / 1e6:.3f} km² "
        f"({sum(areas) / union:.1f}x) - {n_pairs} overlappende paren > {min_m2:.0f} m²"
    )
    for a, b in identical:
        warn(f"{label} {a} en {b} hebben identieke geometrie")
    return {
        "overlaps": {k: sorted(v, key=natural_key) for k, v in overlaps.items() if v},
        "contains": {k: sorted(v, key=natural_key) for k, v in contains.items() if v},
        "identical": identical,
        "union_km2": round(union / 1e6, 6),
        "sum_km2": round(sum(areas) / 1e6, 6),
        "n_pairs": n_pairs,
    }


# ------------------------------------------------------------------ atomaire overlay


def split_unit(
    geom: BaseGeometry,
    cutters: list[tuple[int, BaseGeometry]],
    eps: float,
) -> list[tuple[float, frozenset[int]]]:
    """Splits een vlak in stukken met een unieke set overlappende parkeersleutels.

    Retourneert (oppervlak, sleutelset). De set is leeg voor het deel dat in geen
    enkele sector of zone ligt; dat deel is nodig om de som te kunnen controleren.
    """
    parts: list[tuple[BaseGeometry, frozenset[int]]] = [(geom, frozenset())]
    for key_ix, cutter in cutters:
        nxt: list[tuple[BaseGeometry, frozenset[int]]] = []
        for part, keys in parts:
            if not shapely.intersects(part, cutter):
                nxt.append((part, keys))
                continue
            inside = polygonal(shapely.intersection(part, cutter))
            if inside.area > eps:
                nxt.append((inside, keys | {key_ix}))
            outside = polygonal(shapely.difference(part, cutter))
            if outside.area > eps:
                nxt.append((outside, keys))
        parts = nxt
    return [(p.area, k) for p, k in parts]


def build_atoms(
    units: gpd.GeoDataFrame,
    cutters: gpd.GeoDataFrame,
    eps: float,
) -> tuple[list[tuple[str, float, frozenset[int]]], dict[str, Any]]:
    cutter_geoms = list(cutters.geometry)
    sindex = cutters.sindex
    atoms: list[tuple[str, float, frozenset[int]]] = []
    max_parts = 0
    max_cutters = 0
    worst_recon = 0.0
    worst_code = ""
    max_fraction = 0.0
    for i, row in enumerate(units.itertuples()):
        cand = [int(j) for j in sindex.query(row.geometry, predicate="intersects")]
        max_cutters = max(max_cutters, len(cand))
        if not cand:
            continue
        pieces = split_unit(row.geometry, [(j, cutter_geoms[j]) for j in cand], eps)
        max_parts = max(max_parts, len(pieces))
        covered = 0.0
        for area, keys in pieces:
            if keys:
                atoms.append((row.TEKST, area, keys))
                covered += area
        total = sum(area for area, _ in pieces)
        recon = abs(total - row.geometry.area)
        if recon > worst_recon:
            worst_recon, worst_code = recon, row.TEKST
        if row.geometry.area > 0:
            max_fraction = max(max_fraction, covered / row.geometry.area)
        if (i + 1) % 300 == 0:
            print(f"    {i + 1}/{len(units)} vlakken, {len(atoms)} atomen")
    stats = {
        "n_atoms": len(atoms),
        "max_parts": max_parts,
        "max_cutters_per_unit": max_cutters,
        "worst_reconciliation_m2": round(worst_recon, 6),
        "worst_reconciliation_code": worst_code,
        "max_coverage_fraction": max_fraction,
        "units_touched": len({a[0] for a in atoms}),
        "total_atom_area_km2": round(sum(a[1] for a in atoms) / 1e6, 6),
    }
    return atoms, stats


def encode_atoms(
    atoms: list[tuple[str, float, frozenset[int]]],
    sbd_codes: list[str],
    keys: list[str],
) -> dict[str, Any]:
    sbd_ix = {c: i for i, c in enumerate(sbd_codes)}
    set_ix: dict[tuple[int, ...], int] = {}
    sets: list[list[int]] = []
    rows: list[list[Any]] = []
    for code, area, key_set in atoms:
        sig = tuple(sorted(key_set))
        if sig not in set_ix:
            set_ix[sig] = len(sets)
            sets.append(list(sig))
        rows.append([sbd_ix[code], round(area, AREA_DECIMALS), set_ix[sig]])
    rows.sort(key=lambda r: (r[0], r[2]))
    return {"keys": keys, "sbd": sbd_codes, "sets": sets, "atoms": rows}


def coverage(
    encoded: dict[str, Any], selection: set[str], width: int | None = None
) -> dict[str, float]:
    """Referentie-implementatie van de client-berekening, voor de controles."""
    sel = {i for i, k in enumerate(encoded["keys"]) if k in selection}
    match = [any(k in sel for k in s) for s in encoded["sets"]]
    out: dict[str, float] = {}
    for sbd_ix, area, set_ix in encoded["atoms"]:
        if not match[set_ix]:
            continue
        code = encoded["sbd"][sbd_ix]
        key = code if width is None else code[:width]
        out[key] = out.get(key, 0.0) + area
    return out


# ----------------------------------------------------------------------- emissie


def simplify_topology(
    gdf: gpd.GeoDataFrame, id_col: str, tol_m: float
) -> gpd.GeoDataFrame:
    """Vereenvoudig met behoud van gedeelde randen.

    Per vlak simplify() scheurt gedeelde grenzen los, en omdat de TIR-lagen een
    exacte mozaiek vormen zie je dat direct als gaten tussen buren.
    """
    import topojson  # zware import, alleen hier nodig

    slim = gdf[[id_col, "geometry"]].copy()
    topo = topojson.Topology(
        slim, prequantize=False, toposimplify=tol_m, shared_coords=False
    )
    out = topo.to_gdf()
    out = out.set_crs(RD, allow_override=True)
    if len(out) != len(gdf):
        fail(
            f"vereenvoudiging veranderde het aantal objecten: {len(gdf)} -> {len(out)}"
        )
    n_invalid = int((~out.geometry.is_valid).sum())
    if n_invalid:
        out["geometry"] = out.geometry.make_valid()
        warn(f"{n_invalid} objecten hersteld na vereenvoudiging")
    return out


def to_geojson(
    gdf: gpd.GeoDataFrame, id_col: str, props: dict[str, str] | None = None
) -> dict:
    wgs = gdf.to_crs(WGS)
    feats = []
    for row in wgs.itertuples():
        geom = mapping(row.geometry)
        geom["coordinates"] = round_coords(geom["coordinates"], COORD_DECIMALS)
        properties = (
            {}
            if props is None
            else {out: getattr(row, src) for out, src in props.items()}
        )
        feats.append(
            {
                "type": "Feature",
                "id": getattr(row, id_col),
                "properties": properties,
                "geometry": geom,
            }
        )
    return {"type": "FeatureCollection", "features": feats}


def write_json(path: Path, obj: Any, global_name: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(payload, encoding="utf-8")
    raw = len(payload.encode("utf-8"))
    gz = len(gzip.compress(payload.encode("utf-8")))
    _report.setdefault("payload", []).append(
        {"file": path.name, "raw": raw, "gzip": gz}
    )
    print(f"  {path.name:28s} {raw / 1024:9.1f} KB  {gz / 1024:8.1f} KB gz")
    if global_name:
        js = (
            path.with_suffix(".js")
            if path.suffix == ".json"
            else path.with_name(path.stem + ".js")
        )
        js.write_text(f"window.{global_name}={payload};\n", encoding="utf-8")


# --------------------------------------------------------------------------- main


def main() -> None:
    head("1. Bronbestanden inlezen")
    tir = {level: load_tir(level) for level in TIR_LEVELS}
    sec = load_parking("ParkeerSectoren")
    zon = load_parking("ParkeerZones")
    zon["SECTOR_KEY_SRC"] = zon["ZONE_ID"]
    prj = (DATA / "TIR" / "Gemeente" / "Gemeente_vlakken.prj").read_text(
        encoding="utf-8"
    )
    print(f"  .prj begint met: {prj[:58]}...")
    ok(f"CRS geforceerd naar EPSG:{RD} voor alle {len(tir) + 2} lagen")

    head("2. Geometriecontrole")
    geom_info = {"ParkeerSectoren": check_geometry(sec, "ParkeerSectoren")}
    geom_info["ParkeerZones"] = check_geometry(zon, "ParkeerZones")
    for level in TIR_LEVELS:
        geom_info[level] = check_geometry(tir[level], level)
    _report["geometry"] = geom_info

    head("3. TIR-hierarchie")
    verify_tir_codes(tir)
    verify_tir_areas(tir)

    head("4. Zones en hun sectoren")
    zone_parents, zone_stats = verify_zone_parents(sec, zon)

    head("5. Overlap tussen parkeervlakken")
    sec_ov = analyse_overlaps(sec, "SECTOR_ID", "sectoren")
    zon_ov = analyse_overlaps(zon, "ZONE_ID", "zones", min_m2=1.0)
    containers = sorted(
        (
            s
            for s, a in zip(sec.SECTOR_ID, sec.area, strict=True)
            if a >= CONTAINER_AREA_M2
        ),
        key=natural_key,
    )
    ok(
        f"stadsdekkende sectoren (>= {CONTAINER_AREA_M2 / 1e6:.0f} km²): {', '.join(containers)}"
    )
    gem_union = shapely.union_all(list(tir["Gemeente"].geometry))
    spill = polygonal(
        shapely.difference(shapely.union_all(list(sec.geometry)), gem_union)
    ).area
    ok(
        f"sectoren buiten het gemeentevlak: {spill:,.0f} m² (dus nooit exact 100% te verantwoorden)"
    )

    head("6. Atomaire overlay bouwen")
    cutters = gpd.GeoDataFrame(
        {
            "key": ["S" + s for s in sec.SECTOR_ID] + ["Z" + z for z in zon.ZONE_ID],
            "geometry": list(sec.geometry) + list(zon.geometry),
        },
        crs=RD,
    )
    keys = list(cutters.key)
    sbd = tir["Subbuurtdelen"]
    atoms, astats = build_atoms(sbd, cutters, ATOM_EPS_M2)
    sbd_codes = sorted(sbd.TEKST, key=natural_key)
    encoded = encode_atoms(atoms, sbd_codes, keys)
    print(
        f"  {astats['n_atoms']} atomen | {len(encoded['sets'])} unieke sleutelsets | "
        f"{astats['units_touched']} van {len(sbd)} subbuurtdelen geraakt"
    )
    print(
        f"  max stukken per vlak {astats['max_parts']} | max snijders per vlak "
        f"{astats['max_cutters_per_unit']} | totaal atoomoppervlak "
        f"{astats['total_atom_area_km2']:.6f} km²"
    )
    if astats["worst_reconciliation_m2"] > 0.1:
        fail(
            f"oppervlaktesom van de stukken wijkt {astats['worst_reconciliation_m2']:.4f} m² af "
            f"bij subbuurtdeel {astats['worst_reconciliation_code']}"
        )
    else:
        ok(
            f"som van de stukken == vlakoppervlak (max afwijking "
            f"{astats['worst_reconciliation_m2']:.6f} m²)"
        )
    if astats["max_coverage_fraction"] > 1.0 + 1e-9:
        fail(f"dekking boven 100%: {astats['max_coverage_fraction']:.8f}")
    else:
        ok(f"maximale dekking {astats['max_coverage_fraction']:.8f} - nooit boven 100%")
    _report["atoms"] = astats

    head("7. Controle: geen dubbeltelling")
    naive_cases = [
        {"S99", "S100", "S75"},
        {"S4en5", "S5en6"},
        {"S67", "S68"},
        {"S33", "S33 P"},
    ]
    sbd_area = dict(zip(sbd.TEKST, sbd.area, strict=True))
    for sel in naive_cases:
        exact = coverage(encoded, sel)
        naive: dict[str, float] = {}
        for code, area, key_set in atoms:
            for k in key_set:
                if keys[k] in sel:
                    naive[code] = naive.get(code, 0.0) + area
        worst_naive = max((v / sbd_area[c] for c, v in naive.items()), default=0.0)
        worst_exact = max((v / sbd_area[c] for c, v in exact.items()), default=0.0)
        # De atoomtabel rondt oppervlakten af op AREA_DECIMALS, dus een volledig
        # gedekt vlak kan een fractie boven 1.0 uitkomen. Toets daarom op absolute
        # overschrijding in m² in plaats van op de breuk.
        overshoot = max((v - sbd_area[c] for c, v in exact.items()), default=0.0)
        inflation = (
            (sum(naive.values()) / sum(exact.values()) - 1.0) * 100 if exact else 0.0
        )
        label = "{" + ",".join(sorted(sel, key=natural_key)) + "}"
        print(
            f"  {label:24s} naief tot {worst_naive * 100:6.1f}%  ->  atomair "
            f"{worst_exact * 100:6.2f}%   (naief telt {inflation:+.1f}% te veel oppervlak)"
        )
        if overshoot > 1.0:
            fail(f"{label} geeft atomair {overshoot:.3f} m² meer dan het vlakoppervlak")

    head("8. Controle: niveaus onderling consistent")
    for sel in (
        {"S75"},
        {"S4en5", "S5en6"},
        {"Z750", "Z751"},
        {"S99"},
        {"S28", "Z650", "Z651"},
    ):
        union = shapely.union_all([cutters.geometry[keys.index(k)] for k in sel])
        label = "{" + ",".join(sorted(sel, key=natural_key)) + "}"
        line = []
        for name, width, layer in (
            ("sbd", None, "Subbuurtdelen"),
            ("sb", 5, "Subbuurten"),
            ("bu", 4, "Buurten"),
        ):
            agg = coverage(encoded, sel, width)
            direct: dict[str, float] = {}
            gdf = tir[layer]
            for code, geom in zip(gdf.TEKST, gdf.geometry, strict=True):
                area = polygonal(shapely.intersection(geom, union)).area
                if area > ATOM_EPS_M2:
                    direct[code] = area
            worst = max(
                (
                    abs(agg.get(c, 0.0) - direct.get(c, 0.0))
                    for c in set(agg) | set(direct)
                ),
                default=0.0,
            )
            line.append(f"{name} {len(agg)}={len(direct)} (max {worst:.2f} m²)")
            if set(agg) != set(direct) or worst > 10.0:
                fail(f"{label} niveau {name}: aggregatie wijkt af van directe overlay")
        print(f"  {label:24s} {' | '.join(line)}")

    head("9. Gouden geval: sector 75")
    cov75 = coverage(encoded, {"S75"})
    buurt_naam = dict(zip(tir["Buurten"].TEKST, tir["Buurten"].BUURTNAAM, strict=True))
    rows = sorted(
        ((c, a, a / sbd_area[c]) for c, a in cov75.items()), key=lambda r: -r[2]
    )
    sector75_area = float(sec.loc[sec.SECTOR_ID == "75", "geometry"].area.sum())
    print(
        f"  sector 75: {sector75_area:,.1f} m², {len(rows)} subbuurtdelen geraakt, "
        f"{sum(1 for r in rows if r[2] >= 0.99)} op >= 99%, "
        f"{sum(1 for r in rows if r[2] >= 0.10)} op >= 10%"
    )
    for code, area, frac in rows:
        marker = "" if frac >= 0.10 else "   (onder de drempel)"
        print(
            f"    {code}  {buurt_naam[code[:4]]:18s} {frac * 100:6.2f}%  {area:9,.0f} m²{marker}"
        )
    above = [c for c, _, f in rows if f >= 0.10]
    if len(above) != 11:
        fail(f"sector 75 geeft {len(above)} subbuurtdelen op >= 10%, verwacht 11")
    else:
        ok("sector 75 levert 11 subbuurtdelen op de >= 10%-regel")

    head("10. Bestanden schrijven")
    OUT.mkdir(parents=True, exist_ok=True)
    write_json(OUT / "atoms.json", encoded, "GD_ATOMS")

    sbd_area_r = {c: round(sbd_area[c], AREA_DECIMALS) for c in sbd_codes}
    gebied_naam = dict(
        zip(tir["Gebieden"].TEKST, tir["Gebieden"].GEBDNAAM, strict=True)
    )
    tir_out = {
        "version": BUILD_DATE,
        "sbd_code": sbd_codes,
        "sbd_area": [sbd_area_r[c] for c in sbd_codes],
        "subbuurt_code": sorted({c[:5] for c in sbd_codes}, key=natural_key),
        "buurt_code": sorted(buurt_naam, key=natural_key),
        "buurt_naam": [buurt_naam[c] for c in sorted(buurt_naam, key=natural_key)],
        "gebied_code": sorted(gebied_naam, key=natural_key),
        "gebied_naam": [gebied_naam[c] for c in sorted(gebied_naam, key=natural_key)],
    }
    write_json(OUT / "tir.json", tir_out, "GD_TIR")

    anchors_rd = [label_anchor(g) for g in list(sec.geometry) + list(zon.geometry)]
    anchors = (
        gpd.GeoSeries(
            gpd.points_from_xy([p[0] for p in anchors_rd], [p[1] for p in anchors_rd]),
            crs=RD,
        )
        .to_crs(WGS)
        .tolist()
    )
    zones_by_sector: dict[str, list[str]] = {}
    for zid, pid in zone_parents.items():
        zones_by_sector.setdefault(pid, []).append(zid)

    def n_units(key: str) -> tuple[int, int]:
        """(aantal op de >=10%-regel, aantal geraakt) voor de zoeklijst-hint."""
        cov = coverage(encoded, {key})
        return sum(1 for c, a in cov.items() if a / sbd_area[c] >= 0.10), len(cov)

    sectoren = []
    for i, (sid, geom) in enumerate(zip(sec.SECTOR_ID, sec.geometry, strict=True)):
        n_main, n_all = n_units("S" + sid)
        flags = []
        st = zone_stats.get(sid, {})
        if st.get("zones_outside_sector_pct", 0) > 1.0:
            flags.append(
                f"zones vallen {st['zones_outside_sector_pct']:.0f}% buiten deze sector"
            )
        if st.get("sector_not_covered_by_zones_pct", 0) > 5.0:
            flags.append(
                f"{st['sector_not_covered_by_zones_pct']:.0f}% van de sector heeft geen zone"
            )
        for a, b in sec_ov["identical"]:
            if sid in (a, b):
                flags.append(f"identieke geometrie als sector {b if sid == a else a}")
        sectoren.append(
            {
                "id": sid,
                "key": "S" + sid,
                "area_m2": round(float(geom.area), AREA_DECIMALS),
                "n_sbd": n_main,
                "n_touch": n_all,
                "container": float(geom.area) >= CONTAINER_AREA_M2,
                "center": [round(anchors[i].x, 5), round(anchors[i].y, 5)],
                "zones": sorted(zones_by_sector.get(sid, []), key=natural_key),
                "overlaps": sec_ov["overlaps"].get(sid, []),
                "flags": flags,
            }
        )
    zones = []
    for j, (zid, geom) in enumerate(zip(zon.ZONE_ID, zon.geometry, strict=True)):
        z_main, z_all = n_units("Z" + zid)
        zones.append(
            {
                "id": zid,
                "key": "Z" + zid,
                "sector": zone_parents[zid],
                "area_m2": round(float(geom.area), AREA_DECIMALS),
                "n_sbd": z_main,
                "n_touch": z_all,
                "container": False,
                "center": [
                    round(anchors[len(sec) + j].x, 5),
                    round(anchors[len(sec) + j].y, 5),
                ],
                "overlaps": zon_ov["overlaps"].get(zid, []),
                "flags": [],
            }
        )
    write_json(
        OUT / "parking.json",
        {
            "version": BUILD_DATE,
            "sectoren": sorted(sectoren, key=lambda d: natural_key(d["id"])),
            "zones": sorted(zones, key=lambda d: natural_key(d["id"])),
        },
        "GD_PARKING",
    )

    print("  geometrie vereenvoudigen (topologie-behoudend)...")
    sec_s = simplify_topology(sec, "SECTOR_ID", SIMPLIFY_TOL_M)
    zon_s = simplify_topology(zon, "ZONE_ID", SIMPLIFY_TOL_M)
    sbd_s = simplify_topology(sbd, "TEKST", SIMPLIFY_TOL_M)
    sec_s["area_m2"] = [round(float(a), AREA_DECIMALS) for a in sec.area]
    zon_s["area_m2"] = [round(float(a), AREA_DECIMALS) for a in zon.area]
    write_json(
        OUT / "geo_sectoren.geojson",
        to_geojson(sec_s, "SECTOR_ID", {"area_m2": "area_m2"}),
        "GD_GEO_SECTOREN",
    )
    write_json(
        OUT / "geo_zones.geojson",
        to_geojson(zon_s, "ZONE_ID", {"area_m2": "area_m2"}),
        "GD_GEO_ZONES",
    )
    write_json(
        OUT / "geo_subbuurtdelen.geojson", to_geojson(sbd_s, "TEKST"), "GD_GEO_SBD"
    )
    for name, width, global_name in (
        ("geo_subbuurten", 5, "GD_GEO_SB"),
        ("geo_buurten", 4, "GD_GEO_BU"),
    ):
        merged = sbd_s.copy()
        merged["code"] = [c[:width] for c in merged.TEKST]
        merged = merged.dissolve(by="code", as_index=False)[["code", "geometry"]]
        write_json(OUT / f"{name}.geojson", to_geojson(merged, "code"), global_name)

    total_raw = sum(p["raw"] for p in _report["payload"])
    total_gz = sum(p["gzip"] for p in _report["payload"])
    print(f"  {'TOTAAL':28s} {total_raw / 1024:9.1f} KB  {total_gz / 1024:8.1f} KB gz")

    write_json(
        OUT / "meta.json",
        {
            "version": BUILD_DATE,
            "crs_source": f"EPSG:{RD} (geforceerd; .prj mist een AUTHORITY-code)",
            "simplify_tol_m": SIMPLIFY_TOL_M,
            "atom_eps_m2": ATOM_EPS_M2,
            "counts": {k: v["n"] for k, v in geom_info.items()},
            "atoms": astats,
            "sector_overlap": {
                k: sec_ov[k] for k in ("sum_km2", "union_km2", "n_pairs", "identical")
            },
            "zone_overlap": {k: zon_ov[k] for k in ("sum_km2", "union_km2", "n_pairs")},
            "containers": containers,
            "sector_outside_gemeente_m2": round(spill, 1),
            "payload": _report["payload"],
        },
        "GD_META",
    )

    head("Klaar")
    if _problems:
        print(f"  {len(_problems)} controle(s) mislukt:")
        for p in _problems:
            print(f"    - {p}")
        sys.exit(1)
    ok("alle controles geslaagd")


if __name__ == "__main__":
    main()
