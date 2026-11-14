"""Vegetation cover (NDVI) from NASA MODIS via the ORNL DAAC web service (no key).

NDVI is about 0 for bare rock, sand and ice (like the Moon and Mars) and 0.6-0.9
for forests and crops. We take a high percentile over the local summer so a
brief green-up still counts.

The service allows at most 10 MODIS dates per request; MOD13Q1 has a new
16-day composite every 16 days, so 10 dates cover about 5 months.

Docs: https://modis.ornl.gov/data/modis_webservice.html
Try it: python pipeline/fetch_modis.py 38.41 -110.79
"""
import sys

import numpy as np

from common import get

URL = "https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset"
YEAR = 2024


def peak_ndvi(lat, lon, year=YEAR):
    # 10 composites of the local growing season: late May-Oct (north) or Jan-May (south).
    start, end = (f"A{year}145", f"A{year}289") if lat >= 0 else (f"A{year}001", f"A{year}145")
    data = get(URL, {
        "latitude": round(lat, 4), "longitude": round(lon, 4),
        "band": "250m_16_days_NDVI", "startDate": start, "endDate": end,
        "kmAboveBelow": 0, "kmLeftRight": 0,
    })
    values = []
    for composite in data.get("subset", []):
        for v in composite.get("data", []):
            if v is not None and -2000 <= v <= 10000:  # -3000 is the fill value
                values.append(v * 0.0001)                # stored as integers x 10,000
    if not values:
        raise ValueError("MODIS returned no valid NDVI values")
    return {"ndvi": round(max(0.0, float(np.percentile(values, 90))), 2)}


if __name__ == "__main__":
    print(peak_ndvi(float(sys.argv[1]), float(sys.argv[2])))
