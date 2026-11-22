#!/usr/bin/env python3
"""Score camera replay pairs. Requires numpy, scikit-image, and flip-evaluator."""

import argparse
import json
from pathlib import Path

import flip_evaluator
import numpy as np
from skimage.color import deltaE_ciede2000, rgb2lab

TILE = 32
SHARPNESS_MIN = 0.85
SHARPNESS_MAX = 1.2


def read_rgba(path, width, height):
    rgba = np.fromfile(path, dtype=np.uint8).reshape(height, width, 4)
    return rgba.astype(np.float32) / np.float32(255)


def over(rgba, background):
    alpha = rgba[:, :, 3:4]
    return np.ascontiguousarray(rgba[:, :, :3] * alpha + background * (1 - alpha))


def energy(rgb):
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    padded = np.pad(luma, 1, mode="edge")
    return np.abs(
        4 * luma - padded[:-2, 1:-1] - padded[2:, 1:-1]
        - padded[1:-1, :-2] - padded[1:-1, 2:]
    )


def compare(reference, shown, ppd):
    exact = over(reference, 0.5)
    current = over(shown, 0.5)
    # A transparent replacement can hide against one matte. Check both extremes for content.
    difference = np.maximum(
        deltaE_ciede2000(rgb2lab(over(reference, 0)), rgb2lab(over(shown, 0))),
        deltaE_ciede2000(rgb2lab(over(reference, 1)), rgb2lab(over(shown, 1))),
    )
    flip, mean_flip, _ = flip_evaluator.evaluate(
        exact, current, "LDR", applyMagma=False, parameters={"ppd": ppd}
    )
    high_exact = energy(exact)
    high_shown = energy(current)
    height, width = difference.shape
    content = []
    tile_flip = []
    sharpness = []
    for y in range(0, height, TILE):
        for x in range(0, width, TILE):
            tile = np.s_[y:y + TILE, x:x + TILE]
            content.append(float(np.mean(difference[tile] > 10)))
            tile_flip.append(float(np.mean(flip[tile])))
            baseline = float(np.mean(high_exact[tile]))
            # Discard nearly flat tiles, where faint quantization differences dominate the ratio.
            sharpness.append(float(np.mean(high_shown[tile])) / baseline if baseline >= 0.01 else None)
    ratios = [ratio for ratio in sharpness if ratio is not None]
    return {
        "structureWorstTile": max(content),
        "sharpnessMin": min(ratios, default=1.0),
        "sharpnessMax": max(ratios, default=1.0),
        "sharpnessTiles": len(ratios),
        "flipMean": float(mean_flip),
        "flipTileP99": float(np.quantile(tile_flip, 0.99)),
    }, sharpness


def score(directory, ppd):
    manifest = json.loads((directory / "manifest.json").read_text())
    results = []
    previous = None
    previous_step = None
    for entry in manifest["entries"]:
        step = entry["step"]
        size = entry["width"], entry["height"]
        shown = read_rgba(directory / f"{step}-shown.rgba", *size)
        exact = read_rgba(directory / f"{step}-exact.rgba", *size)
        metrics, sharpness = compare(exact, shown, ppd)
        drift = None
        if previous is not None and step == previous_step + 1:
            changes = [abs(a - b) for a, b in zip(previous, sharpness, strict=True)
                       if a is not None and b is not None]
            drift = max(changes, default=0.0)
        previous = sharpness
        previous_step = step
        results.append({
            "step": step,
            "dpr": entry["dpr"],
            "camera": entry["camera"],
            **metrics,
            "sharpnessDrift": drift,
            "pass": (
                metrics["structureWorstTile"] <= 0.005
                and metrics["sharpnessMin"] >= SHARPNESS_MIN
                and metrics["sharpnessMax"] <= SHARPNESS_MAX
                and metrics["flipMean"] <= 0.02
                and metrics["flipTileP99"] <= 0.08
                and (drift is None or drift <= 0.1)
            ),
        })
    settle = next((row for row in results if row["step"] == manifest["lastStep"]), None)
    return {
        "ppd": ppd,
        "frames": results,
        "settle": settle,
        "pass": bool(settle) and all(row["pass"] for row in results),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--ppd", type=float, required=True)
    args = parser.parse_args()
    if not 0 < args.ppd < float("inf"):
        parser.error("--ppd must be positive and finite")
    print(json.dumps(score(args.directory, args.ppd), allow_nan=False))


if __name__ == "__main__":
    main()
