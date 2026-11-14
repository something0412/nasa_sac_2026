"""Pipeline tests with fake downloads (no internet needed).

Run:  python -m unittest discover -s tests
"""
import io
import json
import math
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

import build_dataset  # noqa: E402
import fetch_geology  # noqa: E402
import fetch_modis  # noqa: E402
import fetch_power  # noqa: E402
import fetch_terrain  # noqa: E402


def terrarium_png(elev):
    """Encode an elevation array (m) as a Terrarium PNG."""
    v = elev + 32768
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.round((v - r * 256 - g) * 256)
    img = Image.fromarray(np.dstack([r, g, b]).clip(0, 255).astype(np.uint8), "RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class Terrain(unittest.TestCase):
    def test_decode_round_trip(self):
        elev = np.array([[0.0, 100.5], [-86.0, 4207.25]])
        np.testing.assert_allclose(fetch_terrain.decode_terrarium(terrarium_png(elev)), elev, atol=0.01)

    def test_tile_maths(self):
        x, y = fetch_terrain.lonlat_to_tile(0, 0, 1)
        self.assertAlmostEqual(x, 1.0)
        self.assertAlmostEqual(y, 1.0)

    def test_tilted_plane_gives_its_slope(self):
        lat, z = 30.0, fetch_terrain.ZOOM
        res = 156543.03392 * math.cos(math.radians(lat)) / 2 ** z
        xx = np.arange(768)[None, :].repeat(768, 0)
        grid = xx * res * math.tan(math.radians(10))  # a 10 degree ramp toward the east
        out = fetch_terrain.terrain_from_grid(grid, 384, 384, lat)
        self.assertAlmostEqual(out["slope_deg"], 10.0, delta=0.2)
        self.assertGreater(out["relief_m"], 1000)

    def test_full_fetch_with_fake_tiles(self):
        flat = terrarium_png(np.full((256, 256), 1234.0))
        out = fetch_terrain.terrain(40.0, -105.0, fetch=lambda url: flat)
        self.assertEqual(out, {"slope_deg": 0.0, "relief_m": 0, "elevation_m": 1234})

    def test_poles_are_refused(self):
        with self.assertRaises(ValueError):
            fetch_terrain.terrain(-89.9, 0)


def power_payload(t_mean, t_max, t_min, prec, names=("TS", "TS_MAX", "TS_MIN")):
    months = fetch_power.MONTHS
    block = {}
    for name, vals in zip(names, (t_mean, t_max, t_min)):
        block[name] = dict(zip(months, vals))
        block[name]["ANN"] = sum(vals) / 12
    block["PRECTOTCORR"] = {m: prec for m in months}
    block["PRECTOTCORR"]["ANN"] = prec
    return {"properties": {"parameter": block}}


class Power(unittest.TestCase):
    def test_climate_numbers(self):
        mins = [-40 + i for i in range(12)]
        maxs = [m + 10 for m in mins]
        means = [m + 5 for m in mins]
        with mock.patch.object(fetch_power, "get", return_value=power_payload(means, maxs, mins, 0.5)):
            out = fetch_power.climate(75, -90)
        self.assertEqual(out["t_min_c"], -40)
        self.assertEqual(out["t_swing_c"], 10)
        self.assertEqual(out["precip_mm"], round(0.5 * 365.25))
        self.assertEqual(out["ground_ice"], 1.0)
        self.assertEqual(out["_kind"], "skin")

    def test_falls_back_to_air_temperature(self):
        air = power_payload([20] * 12, [30] * 12, [10] * 12, 0.1, names=("T2M", "T2M_MAX", "T2M_MIN"))
        with mock.patch.object(fetch_power, "get", side_effect=[KeyError("TS"), air]):
            out = fetch_power.climate(0, 0)
        self.assertEqual(out["_kind"], "air")
        self.assertEqual(out["t_swing_c"], 20)
        self.assertEqual(out["ground_ice"], 0.0)


class ModisAndGeology(unittest.TestCase):
    def test_ndvi_scaling_and_fill_values(self):
        fake = {"subset": [{"data": [-3000]}, {"data": [1200]}, {"data": [2500]}, {"data": [1800]}]}
        with mock.patch.object(fetch_modis, "get", return_value=fake):
            out = fetch_modis.peak_ndvi(38, -110)
        self.assertTrue(0.2 < out["ndvi"] <= 0.25)

    def test_rock_keywords_use_whole_words(self):
        self.assertEqual(fetch_geology.classify("Basalt flows"), ["basalt"])  # not "salt"
        self.assertEqual(fetch_geology.classify("Gypsum and salt; halite beds"), ["evaporite"])
        self.assertEqual(fetch_geology.classify("anorthosite, gabbro"), ["anorthosite", "basalt"])
        self.assertEqual(fetch_geology.classify("basalt lava, basalt dikes, cinder cones"), ["basalt", "volcaniclastic"])
        self.assertEqual(fetch_geology.classify("unknown stuff"), [])


def load_js_array(path, name):
    text = pathlib.Path(path).read_text(encoding="utf-8")
    start = text.index(f"window.{name} = ") + len(f"window.{name} = ")
    end = text.index(";\n", start)
    return json.loads(text[start:end])


class Scan(unittest.TestCase):
    def test_scan_writes_cells_and_skips_failures(self):
        import scan_region
        clim = {"t_min_c": 2.0, "t_swing_c": 30.0, "t_mean_c": 24.0, "precip_mm": 10, "ground_ice": 0.0, "_kind": "skin"}

        def terr(lat, lon):
            if lat > 19:
                raise RuntimeError("no tile")
            return {"slope_deg": 3.0, "relief_m": 120, "elevation_m": 600}
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / "scan.js"
            cells = scan_region.scan("test", 10, 18, 12, 20, 1.0, out, fetch_climate=lambda a, b: clim, fetch_terrain=terr)
            text = out.read_text()
        self.assertEqual(len(cells), 2)  # 4 cells, the 2 northern ones fail
        self.assertTrue(text.startswith("// Generated by pipeline/scan_region.py"))
        self.assertEqual(cells[0]["status"], "scan")


class Build(unittest.TestCase):
    def test_offline_build_writes_loadable_js(self):
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / "sites.js"
            build_dataset.main(["--offline", "--out", str(out)])
            sites = load_js_array(out, "EARTH_SITES")
            meta = load_js_array(out, "EARTH_SITES_META")
        self.assertGreaterEqual(len(sites), 40)
        self.assertEqual(meta["mode"], "seed estimates")
        self.assertIsInstance(sites[0]["known_for"], list)
        self.assertTrue(all(v == "seed estimate" for v in sites[0]["src"].values()))

    def test_live_build_uses_downloads_and_keeps_seeds_on_failure(self):
        fake_climate = {"t_min_c": -33.0, "t_swing_c": 7.0, "t_mean_c": -15.0, "precip_mm": 120,
                        "ground_ice": 1.0, "_kind": "skin"}
        with tempfile.TemporaryDirectory() as d, \
                mock.patch("fetch_power.climate", return_value=fake_climate), \
                mock.patch("fetch_terrain.terrain", side_effect=RuntimeError("offline")):
            out = pathlib.Path(d) / "sites.js"
            build_dataset.main(["--only", "haughton", "--out", str(out), "--report", str(pathlib.Path(d) / "r.md")])
            site = next(s for s in load_js_array(out, "EARTH_SITES") if s["id"] == "haughton")
        self.assertEqual(site["t_min_c"], -33.0)
        self.assertEqual(site["src"]["t_min_c"], "NASA POWER climatology")
        self.assertEqual(site["src"]["slope_deg"], "seed estimate")  # terrain failed, seed kept


if __name__ == "__main__":
    unittest.main()
