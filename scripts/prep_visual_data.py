#!/usr/bin/env python3
"""Extract visual data (waveform peaks, spectrogram, per-stem bands) for the demo page."""
import json
import os

import numpy as np
import scipy.signal as sg
import soundfile as sf

SR_OUT = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUD = os.path.join(ROOT, "audio")
SEP = os.path.join(AUD, "separated", "htdemucs")
WEB = os.path.join(ROOT, "web")
os.makedirs(WEB, exist_ok=True)

PPS = 100          # waveform peak points per second of song
FPS = 40           # visualisation columns per second
NB_MIX = 56        # spectrogram bands for the mixture
NB_STEM = 22       # bands per stem lane


def load(path):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(axis=1) if x.shape[1] == 1 else x.mean(axis=1)
    if sr != SR_OUT:
        from math import gcd
        g = gcd(SR_OUT, sr)
        x = sg.resample_poly(x, SR_OUT // g, sr // g)
    return x.astype(np.float64)


mix = load(os.path.join(AUD, "mix.wav"))
stems = {k: load(os.path.join(SEP, f"{k}.wav")) for k in ("vocals", "drums", "bass", "other")}
L = min([len(mix)] + [len(v) for v in stems.values()])
mix = mix[:L]
stems = {k: v[:L] for k, v in stems.items()}
song_dur = L / SR_OUT


def peaks(x, pps=PPS):
    hop = SR_OUT // pps
    n = len(x) // hop
    out = np.zeros(n, dtype=np.float32)
    for i in range(n):
        seg = x[i * hop:(i + 1) * hop]
        out[i] = np.abs(seg).max()
    # normalise per source against the mixture peak so relative levels are honest
    return out


allp = {k: peaks(v) for k, v in stems.items()}
allp["mix"] = peaks(mix)
ref = np.percentile(np.concatenate([allp["mix"], allp["vocals"]]), 99.5) + 1e-9
for k in allp:
    allp[k] = np.clip(allp[k] / ref, 0, 1)


def stft_bands(x, nb, fps=FPS, fmin=38.0, fmax=16000.0):
    hop = SR_OUT // fps
    n_fft = 4096
    win = np.hanning(n_fft)
    freqs = np.fft.rfftfreq(n_fft, 1 / SR_OUT)
    edges = np.geomspace(fmin, fmax, nb + 1)
    idx = [np.where((freqs >= edges[i]) & (freqs < edges[i + 1]))[0] for i in range(nb)]
    frames = (len(x) - n_fft) // hop + 1
    out = np.zeros((nb, frames), dtype=np.float32)
    for fi in range(frames):
        seg = x[fi * hop:fi * hop + n_fft] * win
        mag = np.abs(np.fft.rfft(seg))
        for b in range(nb):
            ii = idx[b]
            if len(ii):
                out[b, fi] = np.sqrt((mag[ii] ** 2).mean())
    db = 20 * np.log10(out + 1e-7)
    lo, hi = np.percentile(db, 5), np.percentile(db, 99.7)
    v = np.clip((db - lo) / max(hi - lo, 1e-6), 0, 1)
    return v


# reconstruction check: how well do the four stems add back up to the mix?
recon = sum(stems.values())
recon_db = 20 * np.log10(np.sqrt(((recon - mix) ** 2).mean()) / np.sqrt((mix ** 2).mean()))
print("reconstruction relative error: %.2f dB" % recon_db)

spec_mix = stft_bands(mix, NB_MIX)
stem_bands = {k: stft_bands(v, NB_STEM) for k, v in stems.items()}


def b64(arr):
    import base64
    u8 = np.clip(np.round(arr * 255), 0, 255).astype(np.uint8)
    return {
        "b64": base64.b64encode(u8.tobytes()).decode("ascii"),
        "shape": list(u8.shape),
    }


data = {
    "meta": {
        "duration": 48.0,
        "song_duration": song_dur,
        "sr": SR_OUT,
        "bpm": 96,
        "pps": PPS,
        "fps": FPS,
        "stems": [
            {"id": "vocals", "label": "人声", "en": "VOCALS", "color": "#FF6FB5"},
            {"id": "drums", "label": "鼓", "en": "DRUMS", "color": "#FFAE5C"},
            {"id": "bass", "label": "贝斯", "en": "BASS", "color": "#6E9BFF"},
            {"id": "other", "label": "其他乐器", "en": "OTHER", "color": "#4FE3C1"},
        ],
    },
    "stats": {"recon_db": float(recon_db)},
    "peaks": {k: b64(v) for k, v in allp.items()},
    "spec_mix": {"bands": NB_MIX, "fps": FPS, **b64(spec_mix)},
    "stem_bands": {"bands": NB_STEM, "fps": FPS, **{k: b64(v) for k, v in stem_bands.items()}},
}

tl = json.load(open(os.path.join(AUD, "timeline.json")))
data["timeline"] = tl

with open(os.path.join(WEB, "data.js"), "w") as f:
    f.write("window.DEMO = ")
    json.dump(data, f, separators=(",", ":"))
    f.write(";\n")

print("data.js %.1f KB, song %.2fs, frames %d" % (
    os.path.getsize(os.path.join(WEB, "data.js")) / 1024, song_dur, spec_mix.shape[1]))
