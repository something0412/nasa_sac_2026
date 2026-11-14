"""Climate from NASA POWER (no API key needed).

POWER serves 20-year monthly climatologies for any point on Earth. We use the
surface ("skin") temperature, which is the same physical quantity that LRO
Diviner measures on the Moon and rover ground sensors measure on Mars.

Docs: https://power.larc.nasa.gov/docs/services/api/temporal/climatology/
Try it: python pipeline/fetch_power.py 75.38 -89.67
"""
import sys

from common import get

URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

# First choice: Earth skin temperature. Fallback: air temperature at 2 m.
ATTEMPTS = [
    ("skin", ["TS", "TS_MAX", "TS_MIN"]),
    ("air", ["T2M", "T2M_MAX", "T2M_MIN"]),
]


def climate(lat, lon):
    """Return t_min_c, t_swing_c, t_mean_c, precip_mm, ground_ice for a point."""
    last_error = None
    for kind, (t_mean, t_max, t_min) in ATTEMPTS:
        params = {
            "parameters": ",".join([t_mean, t_max, t_min, "PRECTOTCORR"]),
            "community": "RE",
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "format": "JSON",
        }
        try:
            p = get(URL, params)["properties"]["parameter"]
            mins = [p[t_min][m] for m in MONTHS]
            maxs = [p[t_max][m] for m in MONTHS]
            if any(v is None or v <= -998 for v in mins + maxs):
                raise ValueError("POWER returned fill values (-999)")
            mean = p[t_mean]["ANN"]
            out = {
                "t_min_c": round(min(mins), 1),                                   # coldest month's mean daily minimum
                "t_swing_c": round(sum(a - b for a, b in zip(maxs, mins)) / 12, 1),  # mean day-night swing
                "t_mean_c": round(mean, 1),
                "precip_mm": round(p["PRECTOTCORR"]["ANN"] * 365.25),           # POWER gives mm/day
                # Permafrost rule of thumb: mean annual ground temperature below 0 °C.
                "ground_ice": 1.0 if mean <= -2 else 0.5 if mean <= 1 else 0.0,
            }
            out["_kind"] = kind
            return out
        except Exception as e:  # try the next parameter set
            last_error = e
    raise RuntimeError(f"NASA POWER failed: {last_error}")


if __name__ == "__main__":
    lat, lon = float(sys.argv[1]), float(sys.argv[2])
    print(climate(lat, lon))
