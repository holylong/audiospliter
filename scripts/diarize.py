#!/usr/bin/env python3
"""Speaker diarization for two-speaker conversations (CPU, 16 kHz).

Pipeline: energy VAD -> ECAPA-TDNN voiceprint per speech segment -> 2-means
clustering on cosine similarity. The result is a labelled segment list, which
the separation engine turns into per-speaker audio.

Why not just run SepFormer on the whole file? It is trained on WSJ0-2mix, where
both talkers are active almost all the time. On a real conversation (long
single-speaker stretches) it collapses both talkers into one output. See
docs/separation-notes.md for the measurements behind that decision.
"""
import os
import shutil

import numpy as np
import soundfile as sf

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

SR = 16000
SPK_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
SPK_DIR = "pretrained_models/spkrec-ecapa-voxceleb"

_CLF = None


def load_encoder():
    global _CLF
    if _CLF is None:
        from speechbrain.inference.speaker import EncoderClassifier

        _CLF = EncoderClassifier.from_hparams(
            source=SPK_MODEL, savedir=SPK_DIR, run_opts={"device": "cpu"}
        )
    return _CLF


def vad(x, sr=SR, win=0.02, rel_db=-34.0, min_speech=0.28, max_gap=0.38):
    """Energy VAD relative to the file's loud speech, robust to quiet mics."""
    hop = int(sr * win)
    n = len(x) // hop
    frames = x[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    loud = np.percentile(db, 92)
    thr = loud + rel_db
    on = db > thr
    segs, i = [], 0
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            segs.append([i, j])
            i = j
        else:
            i += 1
    merged = []
    for s, e in segs:
        if merged and s - merged[-1][1] <= max_gap / win:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    merged = [m for m in merged if (m[1] - m[0]) * win >= min_speech]
    return [(s * hop, e * hop) for s, e in merged]


def embed(x, clf, sr=SR):
    import torch

    wav = torch.tensor(np.asarray(x, dtype="float32")).unsqueeze(0)
    with torch.no_grad():
        emb = clf.encode_batch(wav).squeeze().cpu().numpy()
    return emb / (np.linalg.norm(emb) + 1e-9)


def two_means(E, iters=60, restarts=8, seed=0):
    """Cosine 2-means; restarts seeded by the most dissimilar pairs."""
    n = len(E)
    rng = np.random.default_rng(seed)
    S = E @ E.T
    best = None
    seeds = [tuple(np.unravel_index(np.argmin(S), S.shape))]
    seeds += [tuple(rng.integers(0, n, 2)) for _ in range(restarts)]
    for pair in seeds:
        if pair[0] == pair[1]:
            continue
        C = np.stack([E[pair[0]], E[pair[1]]])
        for _ in range(iters):
            lab = np.argmax(E @ C.T, axis=1)
            if len(set(lab.tolist())) < 2:
                break
            newC = np.stack([
                E[lab == k].mean(axis=0) if np.any(lab == k) else C[k] for k in (0, 1)
            ])
            newC /= np.linalg.norm(newC, axis=1, keepdims=True) + 1e-9
            if np.allclose(newC, C, atol=1e-6):
                C = newC
                break
            C = newC
        lab = np.argmax(E @ C.T, axis=1)
        # objective: mean cosine to own centroid minus cross-centroid
        sims = E @ C.T
        score = float(np.mean(sims[np.arange(n), lab] - sims[np.arange(n), 1 - lab]))
        if best is None or score > best[0]:
            best = (score, lab, C)
    return best[1], best[2], best[0]


def diarize(path, on_stage=None):
    say = on_stage or (lambda *a, **k: None)
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != SR:
        from math import gcd
        from scipy.signal import resample_poly

        g = gcd(SR, int(sr))
        x = resample_poly(x, SR // g, int(sr) // g).astype("float32")

    say("vad", 0.42, "语音活动检测")
    segs = vad(x)
    say("vad", 0.50, f"{len(segs)} 段语音")

    say("embed", 0.54, "提取声纹")
    clf = load_encoder()
    embs, keep = [], []
    for s, e in segs:
        clip = x[s:e]
        if len(clip) < int(0.25 * SR):          # too short to embed reliably
            clip = np.pad(clip, (0, int(0.25 * SR) - len(clip)))
        embs.append(embed(clip[: int(6 * SR)], clf))
        keep.append((s, e))
    E = np.stack(embs)
    say("embed", 0.66, f"{len(E)} 条声纹")

    say("cluster", 0.70, "二分类聚类")
    lab, C, margin = two_means(E)
    order = np.argsort([np.mean(1 - E[lab == k] @ C[k]) for k in (0, 1)])
    remap = {int(order[0]): 0, int(order[1]): 1}
    lab = np.array([remap[int(l)] for l in lab])

    # first speaker to talk becomes 说话人 1
    if lab[0] == 1:
        lab = 1 - lab

    segs_out = [{"start": round(s / SR, 2), "end": round(e / SR, 2), "speaker": int(l),
                 "dur": round((e - s) / SR, 2)} for (s, e), l in zip(keep, lab)]
    return {
        "duration": round(len(x) / SR, 2),
        "sr": SR,
        "segments": segs_out,
        "cluster_margin": round(float(margin), 3),
        "speakers": [
            {"id": 0, "label": "说话人 1",
             "speech_seconds": round(sum(s["dur"] for s in segs_out if s["speaker"] == 0), 2)},
            {"id": 1, "label": "说话人 2",
             "speech_seconds": round(sum(s["dur"] for s in segs_out if s["speaker"] == 1), 2)},
        ],
        "signal": x,
    }


if __name__ == "__main__":
    import json
    import sys

    p = sys.argv[1] if len(sys.argv) > 1 else "data/dialog/mix.wav"
    d = diarize(p, lambda st, pr, dt: print(f"{st:8s} {pr:5.0%} {dt}", flush=True))
    d.pop("signal")
    print(json.dumps(d, ensure_ascii=False, indent=1))
