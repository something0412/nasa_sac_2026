# Written with help from Claude Code (AI); reviewed and tested by the team.
"""Download real Moon radiation measurements from NASA's RadLab API and save them for the game.

Usage:
    python tools/build_radlab.py

Source: NASA OSDR RadLab data API (no key needed)
    https://visualization.osdr.nasa.gov/radlab/gui/data-api/
Instrument: CRaTER on NASA's Lunar Reconnaissance Orbiter (LRO), detector pair D1D2,
hourly absorbed dose rate in micro-gray per hour (uGy/h), measured in lunar orbit.

Writes data/radlab.js with:
  may2024   the real dose rate for every hour of May 2024 (the "Real history" mission)
  storms    real recorded solar particle storms, used as storm shapes in training missions

We store the EXTRA dose rate above the quiet background (galactic cosmic rays), because the
game already models that background from the Chang'e-4 surface measurement. js/config.js turns
these orbit numbers into crew dose on the surface. The game reads the file, so it never needs
the internet.
"""
import csv
import io
import json
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://visualization.osdr.nasa.gov/radlab/api/"
OUT = Path(__file__).resolve().parent.parent / "data" / "radlab.js"

# Real solar particle storms seen by LRO/CRaTER. Windows include some calm days so we can
# measure the quiet background.
STORMS = [
    # id, name shown in game, window start, window end, size class
    ("jan2012", "January 2012 storm", "2012-01-19", "2012-02-02", "strong"),
    ("mar2012", "March 2012 storm", "2012-03-03", "2012-03-18", "strong"),
    ("sep2017", "September 2017 storm", "2017-09-06", "2017-09-19", "strong"),
    ("may2024", "May 2024 storms", "2024-05-06", "2024-05-20", "moderate"),
    ("oct2021", "October 2021 storm", "2021-10-25", "2021-11-05", "moderate"),
]


def quiet_level(values):
    """Quiet background = the 5th-percentile hour of the window. Robust even when an earlier
    storm is still fading at the start of the window (as on 6 Sep 2017)."""
    return sorted(values)[len(values) // 20]


def fetch(start, end):
    """Hourly CRaTER dose rate as {datetime_of_hour_start: uGy/h}."""
    # The API puts comparison operators inside the key (timestamp>=...), so build the query by hand.
    q = "celestial_body=Moon&instrument=CRaTER&timestamp>={}&timestamp<{}&absorbed_dose_rate&format=csv".format(start, end)
    url = API + "?" + urllib.parse.quote(q, safe="=&<>:-")
    with urllib.request.urlopen(url, timeout=300) as r:
        text = r.read().decode("utf-8")
    hours = {}
    for row in csv.DictReader(io.StringIO(text)):
        if not row.get("absorbed_dose_rate"):
            continue
        t = datetime.fromisoformat(row["timestamp"])
        # Stamps mark the END of each hourly average (e.g. 00:59:59 or 02:00:00), so step back a bit.
        hour = (t - timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
        hours[hour] = float(row["absorbed_dose_rate"])
    if not hours:
        raise SystemExit(f"RadLab returned no CRaTER data for {start} to {end}")
    return hours


def series(hours, start, n):
    """n hourly values from start; gaps filled from the previous hour."""
    out, last = [], None
    for i in range(n):
        v = hours.get(start + timedelta(hours=i), last)
        out.append(v if v is not None else 0.0)
        last = out[-1]
    return out


def storm_profile(values, quiet):
    """Extra dose above quiet, trimmed to the storm: 2 h before it starts until it fades."""
    extra = [max(0.0, v - quiet) for v in values]
    start = next((i for i, x in enumerate(extra) if x > 2 * quiet), None)
    if start is None:
        raise SystemExit("no storm found in window")
    start = max(0, start - 2)
    end = len(extra)
    peak = max(range(len(extra)), key=extra.__getitem__)
    for i in range(peak, len(extra) - 12):
        if all(x < 0.5 * quiet for x in extra[i:i + 12]):
            end = i
            break
    return [round(x, 1) for x in extra[start:end]], start


def main():
    # 1. Every hour of May 2024 (mission hour 0 = 2024-05-01 00:00 UTC).
    t0 = datetime(2024, 5, 1)
    may = series(fetch("2024-05-01", "2024-06-01"), t0, 744)
    quiet_may = statistics.median(may[:192])  # May 1-8, the calm week before the storms
    may_extra = [round(max(0.0, v - quiet_may), 1) for v in may]

    # 2. Library of real storm shapes.
    storms = []
    for sid, name, a, b, size in STORMS:
        start = datetime.fromisoformat(a)
        n = int((datetime.fromisoformat(b) - start).total_seconds() // 3600)
        values = series(fetch(a, b), start, n)
        quiet = quiet_level(values)
        prof, i0 = storm_profile(values, quiet)
        storms.append({
            "id": sid, "name": name, "size": size,
            "start": (start + timedelta(hours=i0)).strftime("%Y-%m-%dT%H:00Z"),
            "quiet": round(quiet, 2), "peak": round(max(prof)), "total_mGy": round(sum(prof) / 1000, 1),
            "extra": prof,
        })
        print(f"{name}: quiet {quiet:.1f} uGy/h, peak +{max(prof):.0f} uGy/h, {sum(prof) / 1000:.1f} mGy extra over {len(prof)} h")

    data = {
        "source": "NASA OSDR RadLab API, LRO CRaTER D1D2 (lunar orbit), hourly absorbed dose rate",
        "api": "https://visualization.osdr.nasa.gov/radlab/gui/data-api/",
        "units": "extra = uGy/h above the quiet background (silicon, lunar orbit)",
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "may2024": {"start": "2024-05-01T00:00Z", "quiet": round(quiet_may, 2), "extra": may_extra},
        "storms": storms,
    }
    OUT.write_text(
        "// GENERATED by tools/build_radlab.py from NASA's RadLab API. Do not hand-edit.\n"
        "// The values are real NASA data. Only the script that downloads and formats them was written with help from Claude Code (AI), reviewed by the team.\n"
        "// Real radiation measured by the CRaTER instrument on NASA's Lunar Reconnaissance Orbiter.\n"
        "window.RADLAB = " + json.dumps(data, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f"May 2024: quiet {quiet_may:.2f} uGy/h, {sum(may_extra) / 1000:.1f} mGy extra -> {OUT}")


if __name__ == "__main__":
    main()
