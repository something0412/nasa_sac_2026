"""Build web/data/earth_sites.js from pipeline/earth_sites.csv.

The CSV is the master list: one row per Earth site with hand-entered seed
estimates. This script refreshes those values from open NASA data and writes
the JavaScript file the web app loads. Anything a download can't fill keeps its
seed value, and every value records where it came from.

Usage (run from the project folder):
    python pipeline/build_dataset.py --offline              # CSV only, no internet
    python pipeline/build_dataset.py                        # + NASA POWER climate + SRTM terrain
    python pipeline/build_dataset.py --with-modis           # + MODIS vegetation (slower)
    python pipeline/build_dataset.py --with-geology         # + rock-type suggestions (report only)
    python pipeline/build_dataset.py --only haughton,atacama
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

NUMERIC = ["lat", "lon", "elevation_m", "slope_deg", "relief_m", "lava_tube", "t_min_c", "t_swing_c",
           "t_mean_c", "ndvi", "precip_mm", "ground_ice"]
SEED = "seed estimate"
SOURCES = {
    "climate": "NASA POWER climatology",
    "terrain": "SRTM via AWS Terrain Tiles",
    "modis": "MODIS MOD13Q1 (ORNL DAAC)",
    "geology": "Macrostrat geologic map",
}


def read_sites(csv_path):
    sites = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            site = dict(row)
            for k in NUMERIC:
                site[k] = float(row[k]) if row.get(k, "").strip() != "" else None
            site["known_for"] = [b for b in row.get("known_for", "").split(";") if b]
            site["src"] = {k: SEED for k in NUMERIC[2:] + ["rock"]}
            sites.append(site)
    return sites


def refresh(site, args, report):
    """Replace seed values with downloaded ones where the download works."""
    lat, lon = site["lat"], site["lon"]
    steps = [("climate", True), ("terrain", True), ("modis", args.with_modis), ("geology", args.with_geology)]
    for name, enabled in steps:
        if not enabled:
            continue
        try:
            if name == "climate":
                from fetch_power import climate
                got = climate(lat, lon)
                for k in ("t_min_c", "t_swing_c", "t_mean_c", "precip_mm"):
                    report.append((site["id"], k, site[k], got[k], SOURCES[name]))
                    site[k], site["src"][k] = got[k], SOURCES[name] + (" (air temp.)" if got["_kind"] == "air" and k.startswith("t_") else "")
                # Ground ice: keep a curated "ice present" note if it is higher than the rule of thumb.
                if got["ground_ice"] >= (site["ground_ice"] or 0):
                    report.append((site["id"], "ground_ice", site["ground_ice"], got["ground_ice"], SOURCES[name]))
                    site["ground_ice"], site["src"]["ground_ice"] = got["ground_ice"], SOURCES[name] + " (permafrost rule)"
            elif name == "terrain":
                from fetch_terrain import terrain
                got = terrain(lat, lon)
                for k in ("slope_deg", "relief_m", "elevation_m"):
                    report.append((site["id"], k, site[k], got[k], SOURCES[name]))
                    site[k], site["src"][k] = got[k], SOURCES[name]
            elif name == "modis":
                from fetch_modis import peak_ndvi
                got = peak_ndvi(lat, lon)
                report.append((site["id"], "ndvi", site["ndvi"], got["ndvi"], SOURCES[name]))
                site["ndvi"], site["src"]["ndvi"] = got["ndvi"], SOURCES[name]
            elif name == "geology":
                from fetch_geology import rock
                got = rock(lat, lon)
                report.append((site["id"], "rock (suggested)", f'{site["rock"]}/{site["rock2"]}',
                               f'{got["rock"]}/{got["rock2"]}', SOURCES[name]))
                if args.overwrite_rock:
                    site["rock"], site["rock2"], site["src"]["rock"] = got["rock"], got["rock2"], SOURCES[name]
            print(f"  ok    {name:8s} {site['id']}")
        except Exception as e:  # keep the seed value and say why
            print(f"  kept seed for {name:8s} {site['id']}: {e}")
            report.append((site["id"], name, "", "FAILED", str(e)[:120]))


def write_js(sites, out_path, mode):
    keep = ["id", "name", "country", "lat", "lon", "status", "known_for", "program", "note", "elevation_m",
            "slope_deg", "relief_m", "lava_tube", "t_min_c", "t_swing_c", "t_mean_c", "rock", "rock2",
            "ndvi", "precip_mm", "ground_ice", "src"]
    clean = [{k: s[k] for k in keep} for s in sites]
    counts = {}
    for s in sites:
        for src in s["src"].values():
            counts[src] = counts.get(src, 0) + 1
    meta = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "mode": mode, "sites": len(sites), "valueSources": counts}
    text = ("// Generated by pipeline/build_dataset.py. Do not edit by hand:\n"
            "// edit pipeline/earth_sites.csv and run the pipeline again.\n"
            f"window.EARTH_SITES_META = {json.dumps(meta)};\n"
            "window.EARTH_SITES = [\n" + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in clean) + "\n];\n")
    out_path.write_text(text, encoding="utf-8")


def write_report(report, path):
    lines = ["# Pipeline report", "", "Seed estimate vs downloaded value for every refreshed field.", "",
             "| Site | Field | Seed | Downloaded | Source |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in report]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=str(ROOT / "pipeline" / "earth_sites.csv"))
    ap.add_argument("--out", default=str(ROOT / "web" / "data" / "earth_sites.js"))
    ap.add_argument("--report", default=str(ROOT / "pipeline" / "build_report.md"))
    ap.add_argument("--offline", action="store_true", help="no downloads: convert the CSV seed values only")
    ap.add_argument("--only", default="", help="comma-separated site ids to refresh (others keep seeds)")
    ap.add_argument("--with-modis", action="store_true", help="also fetch MODIS vegetation (slower)")
    ap.add_argument("--with-geology", action="store_true", help="also suggest rock types from Macrostrat")
    ap.add_argument("--overwrite-rock", action="store_true", help="replace CSV rock types with Macrostrat's")
    args = ap.parse_args(argv)

    sites = read_sites(args.csv)
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    report = []
    if not args.offline:
        for i, site in enumerate(sites, 1):
            if only and site["id"] not in only:
                continue
            print(f"[{i}/{len(sites)}] {site['name']}")
            refresh(site, args, report)
    mode = "seed estimates" if args.offline else "live NASA data where available"
    write_js(sites, pathlib.Path(args.out), mode)
    if report:
        write_report(report, pathlib.Path(args.report))
    print(f"Wrote {args.out} ({len(sites)} sites, {mode}).")
    return sites


if __name__ == "__main__":
    main()
