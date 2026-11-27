#!/usr/bin/env python3
"""Build a two-speaker conversation (16 kHz) with ground-truth tracks.

Source: LibriSpeech test-clean (OpenSLR SLR12, CC BY 4.0), read from the
Hugging Face parquet mirror. Two speakers are picked by id, their shortest
utterances are cut into alternating turns, and a few turns deliberately
overlap so the mixture is not trivially separable.

Outputs (data/dialog/):
  spkA.wav / spkB.wav    ground-truth speaker tracks (only that speaker)
  mix.wav                the mixture handed to the app
  meta.json              turn timings, speaker ids, duration
"""
import io
import json
import os

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

SR = 16000
PARQUET = "data/raw/librispeech_test_clean.parquet"
OUT = "data/dialog"
SPK = (4446, 1580)          # LibriSpeech speaker ids
SENT_PER_SPK = 6
MIN_DUR, MAX_DUR = 1.6, 3.6  # seconds per sentence


def load_sentences(speakers):
    pf = pq.ParquetFile(PARQUET)
    picked = {s: [] for s in speakers}
    for i in range(pf.num_row_groups):
        tbl = pf.read_row_group(i, columns=["speaker_id", "audio", "text", "id"])
        for spk, audio, text, uid in zip(
            tbl.column("speaker_id").to_pylist(),
            tbl.column("audio").to_pylist(),
            tbl.column("text").to_pylist(),
            tbl.column("id").to_pylist(),
        ):
            if spk not in picked:
                continue
            data, sr = sf.read(io.BytesIO(audio["bytes"]), dtype="float32")
            assert sr == SR, (sr, uid)
            dur = len(data) / SR
            if MIN_DUR <= dur <= MAX_DUR:
                picked[spk].append({"id": uid, "text": text, "audio": data, "dur": dur})
    out = {}
    for s in speakers:
        items = sorted(picked[s], key=lambda x: x["dur"])[: SENT_PER_SPK * 3]
        rng = np.random.default_rng(s)
        out[s] = [items[i] for i in rng.choice(len(items), SENT_PER_SPK, replace=False)]
    return out


def fade(x, ms=12):
    n = int(SR * ms / 1000)
    w = np.ones(len(x), dtype="float32")
    ramp = np.linspace(0, 1, n, dtype="float32")
    w[:n] = ramp
    w[-n:] = ramp[::-1]
    return x * w


def main():
    os.makedirs(OUT, exist_ok=True)
    sents = load_sentences(SPK)
    a, b = SPK

    # (speaker, sentence index, gap before, overlap with previous turn)
    plan = [
        (a, 0, 0.35, 0.0),
        (b, 0, 0.40, 0.0),
        (a, 1, 0.32, 0.0),
        (b, 1, 0.25, 0.55),   # B starts while A is still talking
        (a, 2, 0.30, 0.0),
        (b, 2, 0.35, 0.0),
        (a, 3, 0.28, 0.60),   # overlap the other way round
        (b, 3, 0.30, 0.0),
        (a, 4, 0.30, 0.0),
        (b, 4, 0.35, 0.45),
        (a, 5, 0.30, 0.0),
        (b, 5, 0.45, 0.0),
    ]

    cursor = 0.0
    turns = []
    for spk, idx, gap, overlap in plan:
        clip = fade(sents[spk][idx]["audio"])
        start = max(0.0, cursor + gap - overlap)
        turns.append({
            "speaker": "A" if spk == a else "B",
            "speaker_id": spk,
            "start": round(start, 3),
            "dur": round(len(clip) / SR, 3),
            "text": sents[spk][idx]["text"].lower(),
            "utt": sents[spk][idx]["id"],
            "clip": clip,
        })
        cursor = start + len(clip) / SR

    total = cursor + 0.9
    n = int(total * SR) + 1
    tracks = {"A": np.zeros(n, dtype="float32"), "B": np.zeros(n, dtype="float32")}
    for t in turns:
        s = int(t["start"] * SR)
        e = s + len(t["clip"])
        tracks[t["speaker"]][s:e] += t["clip"]

    for k, v in tracks.items():
        v /= max(1e-9, np.abs(v).max()) / 0.52
        sf.write(f"{OUT}/spk{k}.wav", v, SR, subtype="PCM_16")

    mix = tracks["A"] + tracks["B"]
    mix *= 0.94 / max(1e-9, np.abs(mix).max())
    sf.write(f"{OUT}/mix.wav", mix, SR, subtype="PCM_16")

    # overlap ratio, useful honesty metric for the video
    act = {k: np.abs(v) > 1e-4 for k, v in tracks.items()}
    both = np.logical_and(act["A"], act["B"]).sum()
    union = np.logical_or(act["A"], act["B"]).sum()

    meta = {
        "sr": SR,
        "duration": round(len(mix) / SR, 3),
        "speakers": {
            "A": {"id": SPK[0], "label": "说话人 1"},
            "B": {"id": SPK[1], "label": "说话人 2"},
        },
        "turns": [{k: v for k, v in t.items() if k != "clip"} for t in turns],
        "speech_activity": {k: round(float(act[k].mean()), 4) for k in act},
        "overlap_ratio_of_union": round(float(both / max(1, union)), 4),
        "source": "LibriSpeech test-clean (CC BY 4.0), speakers %d / %d" % SPK,
    }
    json.dump(meta, open(f"{OUT}/meta.json", "w"), ensure_ascii=False, indent=1)
    print(
        f"mix {meta['duration']:.2f}s  A {act['A'].mean():.0%}  B {act['B'].mean():.0%}  "
        f"overlap {both / max(1, union):.1%} of union  turns={len(turns)}"
    )


if __name__ == "__main__":
    main()
