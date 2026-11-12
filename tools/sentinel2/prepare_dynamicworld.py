"""Add Dynamic World land-cover predictions for the same Sentinel-2 image.

Run once, offline, after prepare_scene.py. Nothing here runs on the website.

    python tools/sentinel2/prepare_dynamicworld.py [--project EE_PROJECT]

Requires: earthengine-api (authenticated), numpy.
Data source: Dynamic World V1 (Brown et al. 2022, Scientific Data 9, 251,
doi:10.1038/s41597-022-01307-4), Earth Engine collection GOOGLE/DYNAMICWORLD/V1.
Dynamic World is a model prediction made from the Sentinel-2 L1C version of
the same acquisition. It is not a measurement and is shown as a prediction.

What it writes to assets/s2/:
  dw.bin.gz   gzip of uint8, band-sequential, 432 x 216 each:
              10 planes: label, then the probability of each of the 9 classes
              in DW_CLASSES order, stored as round(p * 250) (step 0.004).
              255 in every plane marks a pixel Dynamic World left empty.
  scene.json  gains a "dynamic_world" block (image id, classes, colours,
              per-class pixel counts, quantisation, citation).

The request uses the scene's 10 m grid (EPSG:32632, origin on a 10 m
multiple), which coincides with the Dynamic World grid, so no resampling
takes place.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
from pathlib import Path

import ee
import numpy as np

DW_IMAGE = "GOOGLE/DYNAMICWORLD/V1/20240828T102021_20240828T102019_T32UPB"
# Class order, names and colours as published with the dataset.
DW_CLASSES = [
    ("water", "Water", "#419bdf"),
    ("trees", "Trees", "#397d49"),
    ("grass", "Grass", "#88b053"),
    ("flooded_vegetation", "Flooded vegetation", "#7a87c6"),
    ("crops", "Crops", "#e49635"),
    ("shrub_and_scrub", "Shrub and scrub", "#dfc35a"),
    ("built", "Built area", "#c4281b"),
    ("bare", "Bare ground", "#a59b8f"),
    ("snow_and_ice", "Snow and ice", "#b39fe1"),
]
SCALE = 250

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "s2"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="ee-yaronogen1")
    args = ap.parse_args()
    ee.Initialize(project=args.project)

    meta = json.loads((OUT / "scene.json").read_text(encoding="utf-8"))
    x0, y0, x1, y1 = meta["bounds"]
    w, h = meta["size"]["10"]
    assert meta["item_id"].split("_")[2] == DW_IMAGE.rsplit("/", 1)[1].split("_")[0], "different acquisition"
    assert meta["mgrs_tile"] in DW_IMAGE

    img = ee.Image(DW_IMAGE)
    names = [c[0] for c in DW_CLASSES]
    raw = ee.data.computePixels({
        "expression": img.select(["label"] + names),
        "fileFormat": "NPY",
        "grid": {
            "dimensions": {"width": w, "height": h},
            "crsCode": meta["crs"],
            "affineTransform": {"scaleX": 10, "shearX": 0, "translateX": x0,
                                "shearY": 0, "scaleY": -10, "translateY": y1},
        },
    })
    arr = np.load(io.BytesIO(raw), allow_pickle=False) if isinstance(raw, (bytes, bytearray)) else raw
    assert arr.shape == (h, w), arr.shape

    label = np.asarray(arr["label"]).astype(np.int16)
    probs = np.stack([np.asarray(arr[n], dtype=np.float64) for n in names])
    # Masked pixels come back as 0 in every band; treat "all probabilities zero" as empty.
    empty = probs.sum(axis=0) < 1e-6
    argmax = probs.argmax(axis=0)
    agree = (argmax == label) | empty
    print("label == argmax(prob):", round(float(agree.mean()), 5))

    planes = np.empty((1 + len(names), h, w), np.uint8)
    planes[0] = np.clip(label, 0, 254)
    planes[1:] = np.clip(np.rint(probs * SCALE), 0, SCALE)
    planes[:, empty] = 255
    (OUT / "dw.bin.gz").write_bytes(gzip.compress(planes.tobytes(), compresslevel=9, mtime=0))

    valid = ~empty
    counts = {names[i]: int(((label == i) & valid).sum()) for i in range(len(names))}
    top = probs.max(axis=0)[valid]
    meta["dynamic_world"] = {
        "image_id": DW_IMAGE,
        "source_product": "Sentinel-2 L1C of the same acquisition (2024-08-28, tile 32UPB)",
        "file": "dw.bin.gz",
        "layout": "gzip, uint8, band-sequential [label, " + ", ".join(names) + "], 10 m grid of the scene",
        "probability_scale": SCALE,
        "empty_value": 255,
        "classes": [{"id": i, "key": k, "name": n, "color": c} for i, (k, n, c) in enumerate(DW_CLASSES)],
        "pixel_counts": counts,
        "empty_pixels": int(empty.sum()),
        "top_probability_quartiles": [round(float(q), 3) for q in np.percentile(top, [25, 50, 75])],
        "label_rule": "label is the class with the highest probability",
        "citation": "Brown, C.F., Brumby, S.P., Guzder-Williams, B. et al. Dynamic World, Near real-time global "
                    "10 m land use land cover mapping. Sci Data 9, 251 (2022). doi:10.1038/s41597-022-01307-4",
        "license": "CC BY 4.0. Produced by Google and World Resources Institute.",
    }
    (OUT / "scene.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(json.dumps({k: meta["dynamic_world"][k] for k in ("pixel_counts", "empty_pixels",
                                                            "top_probability_quartiles")}, indent=1))
    print("bytes:", (OUT / "dw.bin.gz").stat().st_size)


if __name__ == "__main__":
    main()
