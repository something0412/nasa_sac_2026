"""Rock type suggestion from the Macrostrat geologic map API (open data, CC-BY 4.0).

Macrostrat returns the mapped geologic units at a point, with a plain-text
lithology. We turn that text into one of our rock classes with keywords.
Keyword matching is crude, so build_dataset.py only REPORTS these suggestions
unless you pass --overwrite-rock: a person should check them.

Docs: https://macrostrat.org/api/v2/geologic_units/map
Try it: python pipeline/fetch_geology.py 43.42 -113.52
"""
import re
import sys

from common import get

URL = "https://macrostrat.org/api/v2/geologic_units/map"

# Checked in this order; the first two matches become rock and rock2.
KEYWORDS = [
    ("anorthosite", ["anorthosite"]),
    ("ice", ["glacier", "ice sheet", "ice cap"]),
    ("evaporite", ["evaporite", "gypsum", "halite", "anhydrite", "playa", "salt", "sulfate"]),
    ("impact", ["impact", "breccia", "suevite", "impactite"]),
    ("volcaniclastic", ["tuff", "ash", "pyroclastic", "cinder", "tephra", "scoria", "pumice", "volcaniclastic"]),
    ("basalt", ["basalt", "mafic", "gabbro", "dolerite", "diabase", "norite", "lava", "volcanic"]),
    ("granitic", ["granite", "granitic", "gneiss", "granodiorite", "felsic", "rhyolite", "tonalite"]),
    ("sedimentary", ["sandstone", "shale", "mudstone", "siltstone", "limestone", "dolomite", "conglomerate",
                     "sediment", "alluvium", "sand", "clay", "chert", "carbonate", "loess", "marl", "till"]),
]


def classify(text):
    """Rock classes mentioned in the text, most-mentioned first (ties: list order).

    Whole words only, so "basalt" does not count as "salt" and "wash" not as "ash".
    """
    text = text.lower()
    hits = []
    for order, (cls, words) in enumerate(KEYWORDS):
        count = sum(len(re.findall(r"\b" + re.escape(w) + r"(?:s|es)?\b", text)) for w in words)
        if count:
            hits.append((-count, order, cls))
    return [cls for _, _, cls in sorted(hits)][:2]


def rock(lat, lon):
    data = get(URL, {"lat": round(lat, 4), "lng": round(lon, 4), "scale": "small"})
    units = data.get("success", {}).get("data", [])
    text = " ".join(" ".join(str(u.get(k) or "") for k in ("lith", "name", "descrip")) for u in units)
    classes = classify(text)
    if not classes:
        raise ValueError("no lithology keywords found")
    return {"rock": classes[0], "rock2": classes[1] if len(classes) > 1 else "", "_text": text[:160]}


if __name__ == "__main__":
    print(rock(float(sys.argv[1]), float(sys.argv[2])))
