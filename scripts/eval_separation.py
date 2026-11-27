#!/usr/bin/env python3
"""Score separated tracks against the ground-truth speaker tracks.

Reports SI-SDR (best permutation), plus the energy leakage matrix, so the demo
video quotes numbers that are actually measured instead of assumed.
"""
import itertools
import json
import sys

import numpy as np
import soundfile as sf

from sep_engine import si_sdr


def load(path, n):
    x, sr = sf.read(path, dtype="float64")
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x[:n]


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "data/dialog"
    sep = sys.argv[2] if len(sys.argv) > 2 else "data/dialog/separated"
    gt = {k: sf.read(f"{base}/spk{k}.wav", dtype="float64")[0] for k in "AB"}
    n = min(len(v) for v in gt.values())
    est = {k: load(f"{sep}/{k}.wav", n) for k in ("spk1", "spk2")}
    gt = {k: v[:n] for k, v in gt.items()}

    # permutation that maximises the mean SI-SDR
    best = None
    for order in itertools.permutations(["spk1", "spk2"]):
        pairs = list(zip(order, ["A", "B"]))
        s = np.mean([si_sdr(est[e], gt[g]) for e, g in pairs])
        if best is None or s > best[0]:
            best = (s, pairs)
    score, pairs = best

    rows = []
    for e, g in pairs:
        x, y = est[e], gt[g]
        denom = np.sqrt((y ** 2).sum() + 1e-12)
        leakage = np.sqrt(((x - y) ** 2).sum()) / denom
        rows.append({
            "est": e,
            "gt": g,
            "si_sdr": round(float(si_sdr(x, y)), 2),
            "leakage_ratio": round(float(leakage), 3),
            "corr": round(float(np.corrcoef(x, y)[0, 1]), 3),
        })

    out = {
        "mean_si_sdr": round(float(score), 2),
        "pairs": rows,
        "model": "speechbrain/sepformer-whamr16k",
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
    json.dump(out, open(f"{sep}/eval.json", "w"), indent=1)


if __name__ == "__main__":
    main()
