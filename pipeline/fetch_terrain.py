"""Slope, local relief and elevation from AWS Terrain Tiles (no API key needed).

The tiles are PNG images where each pixel's colour encodes elevation (the
"Terrarium" format), built mostly from NASA's SRTM radar mission:
    elevation_m = (red * 256 + green + blue / 256) - 32768
We download the 3 x 3 block of tiles around a point at zoom 10 (about 150 m
per pixel at the equator), then measure:
    slope_deg   median slope within 2 km of the point
    relief_m    95th minus 5th percentile elevation within 5 km
    elevation_m elevation at the point

Docs: https://registry.opendata.aws/terrain-tiles/
Try it: python pipeline/fetch_terrain.py 75.38 -89.67
"""
import io
import math
import sys

import numpy as np
from PIL import Image

from common import get

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 10
SLOPE_RADIUS_M = 2000
RELIEF_RADIUS_M = 5000


def lonlat_to_tile(lon, lat, z):
    """Fractional Web Mercator tile coordinates (x to the east, y to the south)."""
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def decode_terrarium(png_bytes):
    rgb = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB")).astype(np.float64)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def mosaic(lon, lat, z=ZOOM, fetch=None):
    """Elevation grid (768 x 768 m) around the point, plus the point's pixel position."""
    fetch = fetch or (lambda url: get(url, kind="bytes"))
    fx, fy = lonlat_to_tile(lon, lat, z)
    tx, ty, n = int(fx), int(fy), 2 ** z
    grid = np.zeros((768, 768))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            x, y = (tx + dx) % n, min(max(ty + dy, 0), n - 1)
            tile = decode_terrarium(fetch(TILE_URL.format(z=z, x=x, y=y)))
            grid[(dy + 1) * 256:(dy + 2) * 256, (dx + 1) * 256:(dx + 2) * 256] = tile
    px, py = (fx - tx + 1) * 256, (fy - ty + 1) * 256
    return grid, px, py


def terrain_from_grid(grid, px, py, lat, z=ZOOM):
    res = 156543.03392 * math.cos(math.radians(lat)) / 2 ** z  # metres per pixel
    g = grid
    # Horn's method: the standard 3 x 3 slope estimate used by GIS tools.
    dzdx = ((g[:-2, 2:] + 2 * g[1:-1, 2:] + g[2:, 2:]) - (g[:-2, :-2] + 2 * g[1:-1, :-2] + g[2:, :-2])) / (8 * res)
    dzdy = ((g[2:, :-2] + 2 * g[2:, 1:-1] + g[2:, 2:]) - (g[:-2, :-2] + 2 * g[:-2, 1:-1] + g[:-2, 2:])) / (8 * res)
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))

    yy, xx = np.mgrid[0:g.shape[0], 0:g.shape[1]]
    dist = np.hypot((xx + 0.5 - px) * res, (yy + 0.5 - py) * res)
    near_slope = dist[1:-1, 1:-1] <= SLOPE_RADIUS_M
    near_relief = dist <= RELIEF_RADIUS_M
    elevation = g[min(int(py), g.shape[0] - 1), min(int(px), g.shape[1] - 1)]
    p5, p95 = np.percentile(g[near_relief], [5, 95])
    return {
        "slope_deg": round(float(np.median(slope[near_slope])), 1),
        "relief_m": round(float(p95 - p5)),
        "elevation_m": round(float(elevation)),
    }


def terrain(lat, lon, fetch=None):
    if abs(lat) > 85.0:
        raise ValueError("Web Mercator tiles stop at 85 degrees latitude")
    grid, px, py = mosaic(lon, lat, fetch=fetch)
    return terrain_from_grid(grid, px, py, lat)


if __name__ == "__main__":
    print(terrain(float(sys.argv[1]), float(sys.argv[2])))
