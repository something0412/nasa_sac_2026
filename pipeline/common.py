"""Shared helpers for the pipeline: polite HTTP requests with retries and a disk cache.

Every download is cached in pipeline/.cache/, so re-running a script is instant
and you never hit an API twice for the same thing. Delete the folder to refetch.
"""
import hashlib
import json
import pathlib
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / ".cache"

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "AnalogFinder/1.0 (NASA Space Apps 2026 student project)"


def get(url, params=None, kind="json", timeout=60, retries=3, pause=0.4):
    """GET a URL and return parsed JSON (kind="json") or raw bytes (kind="bytes").

    Retries on rate limits and server errors, waits `pause` seconds after each
    real download to be polite, and caches results on disk.
    """
    key = hashlib.sha1((url + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()
    path = CACHE / (key + (".json" if kind == "json" else ".bin"))
    if path.exists():
        return json.loads(path.read_text()) if kind == "json" else path.read_bytes()

    CACHE.mkdir(parents=True, exist_ok=True)
    headers = {"Accept": "application/json"} if kind == "json" else {}
    last_error = None
    for attempt in range(retries):
        try:
            r = SESSION.get(url, params=params, timeout=timeout, headers=headers)
        except requests.RequestException as e:  # network trouble: wait and retry
            last_error = e
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 200:
            if kind == "json":
                data = r.json()
                path.write_text(json.dumps(data))
            else:
                data = r.content
                path.write_bytes(data)
            time.sleep(pause)
            return data
        if r.status_code in (429, 500, 502, 503, 504):
            last_error = RuntimeError(f"HTTP {r.status_code} from {r.url}")
            time.sleep(3 * (attempt + 1))
            continue
        raise RuntimeError(f"HTTP {r.status_code} from {r.url}: {r.text[:200]}")
    raise RuntimeError(f"Gave up after {retries} tries: {last_error}")
