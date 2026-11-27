#!/usr/bin/env python3
"""Build the 48 s demo soundtrack that matches the video timeline.

Everything is patched from the REAL demucs stems, so what you hear at each
moment is exactly the stem the animation is showing.
"""
import json
import os

import numpy as np
import scipy.signal as sg
import soundfile as sf

SR = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUD = os.path.join(ROOT, "audio")
SEP = os.path.join(AUD, "separated", "htdemucs")

TIMELINE = {
    "duration": 48.0,
    "scenes": [
        {"id": "hook", "t0": 0.0, "t1": 6.0},
        {"id": "upload", "t0": 6.0, "t1": 12.0},
        {"id": "stems", "t0": 12.0, "t1": 25.5},
        {"id": "together", "t0": 25.5, "t1": 30.5},
        {"id": "karaoke", "t0": 30.5, "t1": 36.5},
        {"id": "export", "t0": 36.5, "t1": 41.5},
        {"id": "outro", "t0": 41.5, "t1": 48.0},
    ],
    "stem_cues": [
        {"stem": "mix", "t0": 12.0, "t1": 13.5},
        {"stem": "drums", "t0": 13.5, "t1": 16.5},
        {"stem": "bass", "t0": 16.5, "t1": 19.5},
        {"stem": "other", "t0": 19.5, "t1": 22.5},
        {"stem": "vocals", "t0": 22.5, "t1": 25.5},
    ],
    "karaoke": {"t0": 30.5, "t1": 36.5},
    "reveal": {"t0": 13.5, "t1": 25.5},
}

# (video start, duration, source, song offset, gain)
BLOCKS = [
    (0.0, 6.0, "mix", 8.0, 0.95),
    (6.0, 6.0, "mix", 14.0, 0.95),          # ducked + low-passed while "processing"
    (12.0, 1.5, "mix", 20.0, 0.95),
    (13.5, 3.0, "drums", 8.0, 1.0),
    (16.5, 3.0, "bass", 8.0, 1.0),
    (19.5, 3.0, "other", 8.0, 1.0),
    (22.5, 3.0, "vocals", 8.0, 1.0),
    (25.5, 5.0, "mix", 8.0, 0.95),
    (30.5, 6.0, "inst", 13.0, 1.0),
    (36.5, 5.0, "mix", 19.0, 0.95),
    (41.5, 6.5, "mix", 33.0, 0.95),
]

N = int(TIMELINE["duration"] * SR)


def load(path):
    x, sr = sf.read(path, always_2d=True)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    if sr != SR:
        from math import gcd
        g = gcd(SR, sr)
        x = sg.resample_poly(x, SR // g, sr // g, axis=0)
    return x.T.astype(np.float64)


mix = load(os.path.join(AUD, "mix.wav"))
stems = {k: load(os.path.join(SEP, f"{k}.wav")) for k in ("vocals", "drums", "bass", "other")}
# stems from demucs are slightly shorter/longer than the mix; keep a common length
L = min([mix.shape[1]] + [v.shape[1] for v in stems.values()])
mix = mix[:, :L]
stems = {k: v[:, :L] for k, v in stems.items()}
SRC = dict(stems)
SRC["mix"] = mix
SRC["inst"] = stems["drums"] + stems["bass"] + stems["other"]


def lp(x, cutoff, order=2):
    b, a = sg.butter(order, cutoff / (SR / 2), "low")
    return np.stack([sg.lfilter(b, a, x[c]) for c in range(x.shape[0])]) if x.ndim == 2 else sg.lfilter(b, a, x)


def block(src, song_off, dur):
    i = int(round(song_off * SR))
    n = int(round(dur * SR))
    out = np.zeros((2, n))
    avail = max(0, min(n, src.shape[1] - i))
    if avail > 0:
        out[:, :avail] = src[:, i:i + avail]
    return out


# ---------------------------------------------------------------- assembly
out = np.zeros((2, N))
for (v0, dur, name, soff, gain) in BLOCKS:
    seg = block(SRC[name], soff, dur) * gain
    if name == "mix" and abs(v0 - 6.0) < 1e-6:
        # processing: band-limit then open back up
        wet = lp(seg, 650, 2)
        ramp = np.ones(seg.shape[1])
        open_from = int(5.0 * SR)
        open_len = int(0.9 * SR)
        ramp[open_from:open_from + open_len] = np.linspace(0, 1, open_len)
        ramp[open_from + open_len:] = 1.0
        seg = wet * (1 - ramp) * 0.55 + seg * ramp
    i = int(round(v0 * SR))
    n = min(seg.shape[1], N - i)
    out[:, i:i + n] += seg[:, :n]

# level automation: soft fade in, dip under UI moments, fade out
t = np.arange(N) / SR
auto = np.ones(N)
auto[:int(0.25 * SR)] = np.linspace(0, 1, int(0.25 * SR))
fade_start, fade_end = 43.0, 46.2
m = (t >= fade_start) & (t < fade_end)
auto[m] *= np.linspace(1, 0, m.sum()) ** 0.65
auto[t >= fade_end] = 0.0
for (c, dip) in ((25.5, 0.35), (30.5, 0.25), (36.5, 0.2), (41.5, 0.4)):
    m = (t >= c) & (t < c + 0.12)
    auto[m] *= np.linspace(dip, 1.0, m.sum())
out *= auto

# ---------------------------------------------------------------- UI sfx
rng = np.random.default_rng(3)


def ui_tick(dur=0.09, freq=2400, gain=0.1):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    env = np.exp(-tt * 60) * (1 - np.exp(-tt * 900))
    s = np.sin(2 * np.pi * freq * tt) * 0.6 + rng.normal(0, 1, n) * 0.4
    return s * env * gain


def whoosh(dur=0.5, gain=0.09, up=True):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    b, a = sg.butter(2, [300 / (SR / 2), 6000 / (SR / 2)], "band")
    noise = sg.lfilter(b, a, noise)
    env = np.sin(np.linspace(0, np.pi, n)) ** 1.6
    return noise * env * gain


def boom(gain=0.14, dur=0.55):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = 44 + 40 * np.exp(-tt * 18)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 5.2) * gain


def ping(gain=0.11, dur=0.7):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    s = np.sin(2 * np.pi * 1568 * tt) * 0.5 + np.sin(2 * np.pi * 2352 * tt) * 0.3
    return s * np.exp(-tt * 7) * gain


def add_sfx(sig, at, pan=0.0):
    i = int(round(at * SR))
    n = min(len(sig), N - i)
    if n <= 0:
        return
    l = np.sqrt(0.5 * (1 - pan))
    r = np.sqrt(0.5 * (1 + pan))
    out[0, i:i + n] += sig[:n] * l * 1.4142
    out[1, i:i + n] += sig[:n] * r * 1.4142


add_sfx(boom(0.16), 0.18)
add_sfx(ping(0.09), 0.45)
add_sfx(whoosh(0.55, 0.10, True), 5.9, -0.2)
for k, tm in enumerate((6.55, 7.05, 7.55, 8.05)):
    add_sfx(ui_tick(0.07, 2100 + 260 * k, 0.07), tm, 0.15)
add_sfx(ping(0.13), 11.95)
add_sfx(whoosh(0.7, 0.10), 13.3, 0.25)
for k, tm in enumerate((16.4, 19.4, 22.4)):
    add_sfx(ui_tick(0.1, 1500, 0.07), tm, -0.25)
add_sfx(whoosh(0.6, 0.09), 25.4, -0.15)
add_sfx(whoosh(0.6, 0.09), 30.4, 0.2)
add_sfx(ping(0.1), 30.45)
add_sfx(whoosh(0.6, 0.09), 36.4, -0.1)
add_sfx(boom(0.10), 41.4)

# ------------------------------------------------------------------ master
out = np.tanh(out * 0.92 * 1.05) * 0.94
out = out / np.abs(out).max() * 0.95
sf.write(os.path.join(AUD, "soundtrack.wav"), out.T.astype(np.float32), SR)

TIMELINE["audio_blocks"] = [
    {"t0": b[0], "dur": b[1], "src": b[2], "song_off": b[3], "gain": b[4]} for b in BLOCKS
]
with open(os.path.join(AUD, "timeline.json"), "w") as f:
    json.dump(TIMELINE, f, indent=2)
print("soundtrack %.2fs" % (N / SR))
