"""Prepare the Sentinel-2 L2A scene used by the homepage spectral visualization.

Run once, offline, before publishing. Nothing here runs on the website.

    python tools/sentinel2/prepare_scene.py

Requires: pystac-client, rasterio, numpy, requests, Pillow.
Data source: Microsoft Planetary Computer, collection "sentinel-2-l2a"
(Copernicus Sentinel-2 Level-2A, processed by ESA).

What it writes to assets/s2/:
  scene.json        scene metadata, band table, offsets, example pixels
  b10m.bin          uint16 LE, band-sequential: B02 B03 B04 B08     (10 m)
  b20m.bin          uint16 LE, band-sequential: B05 B06 B07 B8A B11 B12 (20 m)
  b60m.bin          uint16 LE, band-sequential: B01 B09            (60 m)
  scl20.bin         uint8, Scene Classification Layer (20 m)
  truecolor.webp    B04/B03/B02 at 10 m, display stretch only
  context.webp      ESA true-colour image (TCI) of the surrounding area

Values are stored exactly as delivered (digital numbers). The browser converts
them with   reflectance = (DN + BOA_ADD_OFFSET) / QUANTIFICATION_VALUE
using the offsets read from this product's own metadata. Each band is kept at
its native resolution; nothing is resampled, smoothed or gap-filled. B10 is not
part of Level-2A and is not used.
"""
from __future__ import annotations

import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from pystac_client import Client
from rasterio.windows import from_bounds

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

ITEM_ID = "S2A_MSIL2A_20240828T102021_R065_T32UPB_20240828T150452"
# Crop window in the tile's CRS (EPSG:32632). Aligned to the 60 m grid
# (tile origin E 600000, N 5700000) so 10, 20 and 60 m pixels nest exactly.
X0, Y1 = 698_400, 5_687_520          # upper-left corner
WIDTH_M, HEIGHT_M = 4_320, 2_160     # 432 x 216 pixels at 10 m
CONTEXT_PAD_M = 3_000                # surrounding area for the zoom-in

# Sentinel-2A MSI central wavelength and bandwidth (nm), from ESA's
# Sentinel-2 spectral response functions (S2-SRF, Sentinel-2A).
BANDS = {
    "B01": (442.7, 21, 60, "Coastal aerosol"),
    "B02": (492.7, 66, 10, "Blue"),
    "B03": (559.8, 36, 10, "Green"),
    "B04": (664.6, 31, 10, "Red"),
    "B05": (704.1, 15, 20, "Red edge 1"),
    "B06": (740.5, 15, 20, "Red edge 2"),
    "B07": (782.8, 20, 20, "Red edge 3"),
    "B08": (832.8, 106, 10, "NIR"),
    "B8A": (864.7, 21, 20, "Narrow NIR"),
    "B09": (945.1, 20, 60, "Water vapour"),
    "B11": (1613.7, 91, 20, "SWIR 1"),
    "B12": (2202.4, 175, 20, "SWIR 2"),
}
GROUPS = {10: ["B02", "B03", "B04", "B08"],
          20: ["B05", "B06", "B07", "B8A", "B11", "B12"],
          60: ["B01", "B09"]}
SCL_NAMES = {0: "No data", 1: "Saturated or defective", 2: "Dark area pixels",
             3: "Cloud shadows", 4: "Vegetation", 5: "Not vegetated", 6: "Water",
             7: "Unclassified", 8: "Cloud, medium probability",
             9: "Cloud, high probability", 10: "Thin cirrus", 11: "Snow or ice"}
SCL_INVALID = {0, 1, 3, 8, 9, 10, 11}

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "s2"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a"


def signed(href: str, token: str) -> str:
    return f"{href}?{token}"


def read_window(href: str, res: int, bounds) -> np.ndarray:
    with rasterio.open(href) as ds:
        assert ds.res == (res, res), (href, ds.res)
        win = from_bounds(*bounds, ds.transform)
        assert abs(win.col_off - round(win.col_off)) < 1e-6 and abs(win.row_off - round(win.row_off)) < 1e-6
        win = win.round_offsets().round_lengths()
        return ds.read(1, window=win)


def boa_offsets(xml_text: str) -> tuple[dict[str, int], float, str]:
    """Read BOA_ADD_OFFSET per band and the quantification value from MTD_MSIL2A.xml."""
    root = ET.fromstring(xml_text)
    names = {}
    for el in root.iter():
        if el.tag.endswith("Spectral_Information") and "bandId" in el.attrib:
            names[el.attrib["bandId"]] = el.attrib.get("physicalBand")
    offsets = {}
    for el in root.iter():
        if el.tag.endswith("BOA_ADD_OFFSET"):
            offsets[names[el.attrib["band_id"]]] = int(el.text)
    quant = next(float(el.text) for el in root.iter() if el.tag.endswith("BOA_QUANTIFICATION_VALUE"))
    baseline = next(el.text for el in root.iter() if el.tag.endswith("PROCESSING_BASELINE"))
    offsets = {("B8A" if k == "B8A" else f"B{int(k[1:]):02d}" if k[1:].isdigit() else k): v for k, v in offsets.items()}
    return offsets, quant, baseline


def stretch(rgb: np.ndarray) -> np.ndarray:
    """Display-only stretch of reflectance to 8-bit (not used for any value shown)."""
    out = np.clip(rgb / 0.28, 0, 1) ** (1 / 1.6)
    return (out * 255 + 0.5).astype(np.uint8)


def pick_examples(refl10, refl20, scl20, ndvi):
    """Choose one representative pixel per surface type with fixed, stated rules.

    Rules (all must hold):
      * the 20 m Scene Classification pixel is valid (not cloud, shadow, cirrus...)
      * the SCL class matches the surface type (vegetation 4, not vegetated 5, water 6)
      * NDVI is in the stated range for that type
      * the surrounding 5x5 block of 10 m pixels is spectrally uniform, so the
        20 m bands describe the same surface (lowest summed std of the 10 m bands)
    Built-up and bare soil are both SCL 5; they are separated here by the
    SWIR-1/NIR ratio and blue reflectance, which is a heuristic and is stated
    as such in scene.json.
    """
    h, w = ndvi.shape
    scl10 = np.repeat(np.repeat(scl20, 2, 0), 2, 1)
    b02, b03, b04, b08 = refl10
    b11 = np.repeat(np.repeat(refl20[4], 2, 0), 2, 1)
    rules = {
        "vegetation": (scl10 == 4) & (ndvi > 0.70),
        "water": (scl10 == 6) & (ndvi < 0.0),
        "bare_soil": (scl10 == 5) & (ndvi > 0.10) & (ndvi < 0.25) & (b11 > b08 * 1.15) & (b02 < 0.10),
        "built_up": (scl10 == 5) & (ndvi < 0.20) & (b02 > 0.10) & (b11 < b08 * 1.45),
    }
    stack = np.stack(refl10)
    examples = {}
    for name, mask in rules.items():
        best, best_score = None, np.inf
        ys, xs = np.nonzero(mask[2:h - 2, 2:w - 2])
        for y, x in zip(ys + 2, xs + 2):
            block = mask[y - 2:y + 3, x - 2:x + 3]
            if not block.all():
                continue
            score = float(stack[:, y - 2:y + 3, x - 2:x + 3].std(axis=(1, 2)).sum())
            if score < best_score:
                best, best_score = (int(x), int(y)), score
        if best is None:
            raise SystemExit(f"no pixel satisfies the rule for {name}")
        examples[name] = {"x": best[0], "y": best[1], "uniformity_std_sum": round(best_score, 4)}
    return examples, {k: int(v.sum()) for k, v in rules.items()}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    item = Client.open(STAC).get_collection("sentinel-2-l2a").get_item(ITEM_ID)
    token = requests.get(TOKEN, timeout=30).json()["token"]
    offsets, quant, baseline = boa_offsets(
        requests.get(signed(item.assets["product-metadata"].href, token), timeout=60).text)

    bounds = (X0, Y1 - HEIGHT_M, X0 + WIDTH_M, Y1)
    dn = {}
    for res, bands in GROUPS.items():
        for b in bands:
            dn[b] = read_window(signed(item.assets[b].href, token), res, bounds)
            assert dn[b].shape == (HEIGHT_M // res, WIDTH_M // res), (b, dn[b].shape)
            assert (dn[b] > 0).all(), f"{b} contains no-data pixels in the window"
    scl = read_window(signed(item.assets["SCL"].href, token), 20, bounds)

    for res, bands in GROUPS.items():
        np.stack([dn[b] for b in bands]).astype("<u2").tofile(OUT / f"b{res}m.bin")
    scl.astype(np.uint8).tofile(OUT / "scl20.bin")

    def refl(b):
        return (dn[b].astype(np.float64) + offsets[b]) / quant

    r10 = [refl(b) for b in GROUPS[10]]
    r20 = [refl(b) for b in GROUPS[20]]
    ndvi = (r10[3] - r10[2]) / (r10[3] + r10[2])
    examples, candidates = pick_examples(r10, r20, scl, ndvi)
    for ex in examples.values():
        x, y = ex["x"], ex["y"]
        ex["reflectance"] = {b: round(float((dn[b][y * 10 // BANDS[b][2], x * 10 // BANDS[b][2]] + offsets[b]) / quant), 4)
                             for b in BANDS}
        ex["scl"] = int(scl[y // 2, x // 2])

    rgb = stretch(np.stack([r10[2], r10[1], r10[0]], axis=-1))
    Image.fromarray(rgb).save(OUT / "truecolor.webp", "WEBP", quality=92, method=6)

    cb = (X0 - CONTEXT_PAD_M, Y1 - HEIGHT_M - CONTEXT_PAD_M * HEIGHT_M // WIDTH_M,
          X0 + WIDTH_M + CONTEXT_PAD_M, Y1 + CONTEXT_PAD_M * HEIGHT_M // WIDTH_M)
    with rasterio.open(signed(item.assets["visual"].href, token)) as ds:
        win = from_bounds(*cb, ds.transform).round_offsets().round_lengths()
        tci = ds.read(window=win)
        ctx_bounds = list(rasterio.windows.bounds(win, ds.transform))
    Image.fromarray(np.moveaxis(tci, 0, -1)).save(OUT / "context.webp", "WEBP", quality=86, method=6)

    scl_counts = {SCL_NAMES[int(k)]: int(v) for k, v in zip(*np.unique(scl, return_counts=True))}
    p = item.properties
    meta = {
        "item_id": ITEM_ID,
        "platform": p["platform"],
        "datetime": p["datetime"],
        "mgrs_tile": p["s2:mgrs_tile"],
        "processing_baseline": baseline,
        "crs": "EPSG:32632",
        "bounds": list(bounds),
        "context_bounds": ctx_bounds,
        "size": {"10": [WIDTH_M // 10, HEIGHT_M // 10], "20": [WIDTH_M // 20, HEIGHT_M // 20],
                 "60": [WIDTH_M // 60, HEIGHT_M // 60]},
        "files": {"10": "b10m.bin", "20": "b20m.bin", "60": "b60m.bin", "scl": "scl20.bin"},
        "band_order": {str(k): v for k, v in GROUPS.items()},
        "bands": {b: {"center_nm": c, "width_nm": wd, "res_m": r, "name": n, "boa_add_offset": offsets[b]}
                  for b, (c, wd, r, n) in BANDS.items()},
        "quantification_value": quant,
        "reflectance_formula": "(DN + BOA_ADD_OFFSET) / QUANTIFICATION_VALUE",
        "scl_counts_20m": scl_counts,
        "scl_invalid_classes": sorted(SCL_INVALID),
        "examples": examples,
        "example_candidates": candidates,
        "example_rules": pick_examples.__doc__.strip(),
        "place": "South shore of the Geiseltalsee at Braunsbedra, Saxony-Anhalt, Germany",
        "attribution": f"Contains modified Copernicus Sentinel data {p['datetime'][:4]}, processed by ESA. "
                       "Accessed via Microsoft Planetary Computer.",
    }
    (OUT / "scene.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(json.dumps({k: meta[k] for k in ("platform", "datetime", "processing_baseline", "scl_counts_20m",
                                           "example_candidates")}, indent=1))
    for k, v in examples.items():
        print(k, v["x"], v["y"], v["scl"], v["reflectance"])
    print({b: offsets[b] for b in BANDS}, quant)


if __name__ == "__main__":
    main()
