#!/usr/bin/env python3
"""Generate a copyright-clean 40s demo song with ground-truth stems.

Produces:
  audio/src/drums.wav  audio/src/bass.wav  audio/src/other.wav  audio/src/vocals.wav
  audio/mix.wav        (the 4 stems summed -> what the user "uploads")
  audio/src_meta.json  (vocal phrase positions, tempo, key)
"""
import json
import os

import numpy as np
import scipy.signal as sg
import soundfile as sf

SR = 48000
BPM = 96.0
BEAT = 60.0 / BPM          # 0.625 s
BAR = 4 * BEAT             # 2.5 s
BARS = 16
DUR = BARS * BAR           # 40 s
TAIL = 2.5                 # reverb tail
N = int(round((DUR + TAIL) * SR))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "audio")
SRC = os.path.join(OUT, "src")
os.makedirs(SRC, exist_ok=True)

rng = np.random.default_rng(7)


def t_of(seconds):
    return np.arange(int(round(seconds * SR))) / SR


def note_hz(name):
    """Equal-tempered pitch from name like 'A2', 'C#4'."""
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
             "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch, octave = name[:-1], int(name[-1])
    midi = 12 * (octave + 1) + names[pitch]
    return 440.0 * 2 ** ((midi - 69) / 12)


def adsr(n, a=0.01, d=0.2, s=0.7, r=0.3, hold=0.6):
    """Simple ADSR over n samples; hold = fraction of n where sustain ends."""
    env = np.zeros(n)
    na, nd = max(1, int(a * SR)), max(1, int(d * SR))
    nr = max(1, int(r * SR))
    ns = max(0, int(hold * n) - na - nd)
    i = 0
    seg = min(na, n - i)
    if seg > 0:
        env[i:i + seg] = np.linspace(0, 1, seg)
        i += seg
    seg = min(nd, n - i)
    if seg > 0:
        env[i:i + seg] = np.linspace(1, s, seg)
        i += seg
    if ns > 0 and i < n:
        seg = min(ns, n - i)
        env[i:i + seg] = s
        i += seg
    if i < n:
        env[i:] = np.linspace(env[i - 1] if i else s, 0, n - i)
    return env


def saw(freq, n, phase0=0.0):
    t = np.arange(n) / SR
    ph = (freq * t + phase0) % 1.0
    return 2 * ph - 1


def lowpass(x, cutoff, order=2):
    b, a = sg.butter(order, min(cutoff, SR / 2 - 200) / (SR / 2), "low")
    return sg.lfilter(b, a, x)


def highpass(x, cutoff, order=2):
    b, a = sg.butter(order, cutoff / (SR / 2), "high")
    return sg.lfilter(b, a, x)


def bandpass(x, lo, hi, order=2):
    b, a = sg.butter(order, [lo / (SR / 2), min(hi, SR / 2 - 200) / (SR / 2)], "band")
    return sg.lfilter(b, a, x)


def make_ir(seconds=1.9, decay=3.2, seed=1):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    env = np.exp(-decay * t * 2.2)
    ir = r.normal(0, 1, (2, n)) * env
    ir = lowpass(ir, 5200, 1)
    ir[:, :int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    ir /= np.abs(ir).max()
    return ir


IR = make_ir()


def reverb(stem, wet=0.18, predelay=0.012):
    pd = int(predelay * SR)
    out = np.zeros_like(stem)
    for ch in range(2):
        w = sg.fftconvolve(stem[ch], IR[ch])[:stem.shape[1]]
        out[ch] = w
    out = np.roll(out, pd, axis=1)
    return wet * out


def delay(stem, time=BEAT / 2, fb=0.32, wet=0.16, mix_side=True):
    d = int(time * SR)
    out = np.zeros_like(stem)
    buf = stem.copy()
    g = 1.0
    for k in range(1, 5):
        g *= fb
        sh = np.zeros_like(stem)
        sh[:, d * k:] = stem[:, :-d * k] if d * k else stem
        out += g * sh
    return wet * out


def soft_clip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


class Canvas:
    def __init__(self, name):
        self.name = name
        self.buf = np.zeros((2, N))

    def add(self, sig, start_s, gain=1.0, pan=0.0):
        i = int(round(start_s * SR))
        if i >= N:
            return
        n = min(len(sig), N - i)
        if sig.ndim == 1:
            l = np.sqrt(0.5 * (1 - pan))
            r = np.sqrt(0.5 * (1 + pan))
            self.buf[0, i:i + n] += sig[:n] * gain * l * 1.4142
            self.buf[1, i:i + n] += sig[:n] * gain * r * 1.4142
        else:
            self.buf[:, i:i + n] += sig[:, :n] * gain


# ---------------------------------------------------------------- instruments
def kick(gain=1.0):
    t = t_of(0.34)
    f = 46 + 78 * np.exp(-t * 34)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7.5)
    click = bandpass(rng.normal(0, 1, len(t)), 1800, 7000) * np.exp(-t * 220) * 0.55
    sig = np.tanh((body + click) * 1.7) * 0.9
    return sig * gain


def snare(gain=1.0):
    t = t_of(0.26)
    noise = bandpass(rng.normal(0, 1, len(t)), 1400, 9000) * np.exp(-t * 19)
    tone = np.sin(2 * np.pi * 186 * t) * np.exp(-t * 28) * 0.5
    tone2 = np.sin(2 * np.pi * 330 * t) * np.exp(-t * 45) * 0.22
    return np.tanh((noise * 0.9 + tone + tone2) * 1.4) * 0.62 * gain


def clap(gain=1.0):
    t = t_of(0.22)
    n = bandpass(rng.normal(0, 1, len(t)), 900, 5200)
    env = np.zeros(len(t))
    for k, off in enumerate([0.0, 0.008, 0.017]):
        i = int(off * SR)
        seg = np.exp(-(t[:len(t) - i]) * 55) * (0.9 if k == 0 else 0.6)
        env[i:] += seg
    return n * env * 0.34 * gain


def hat(open_=False, gain=1.0):
    t = t_of(0.30 if open_ else 0.07)
    n = highpass(rng.normal(0, 1, len(t)), 7600, 3)
    env = np.exp(-t * (11 if open_ else 90))
    return n * env * (0.20 if open_ else 0.26) * gain


def shaker(gain=1.0):
    t = t_of(0.09)
    n = bandpass(rng.normal(0, 1, len(t)), 5200, 13000)
    env = np.exp(-t * 48) * (1 - np.exp(-t * 900))
    return n * env * 0.16 * gain


def epiano(freq, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    mod = 1.5 * np.exp(-t * 5.5) * np.sin(2 * np.pi * freq * 2.0 * t)
    car = np.sin(2 * np.pi * freq * t + mod)
    car2 = np.sin(2 * np.pi * freq * 1.003 * t + mod * 0.7) * 0.5
    body = np.sin(2 * np.pi * freq * 0.5 * t) * np.exp(-t * 6) * 0.25
    env = np.exp(-t * 2.1) * adsr(n, 0.004, 0.15, 0.55, 0.35, 0.55)
    return (car + car2 + body) * env * 0.5 * gain


def pad(freqs, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for f in freqs:
        for det in (-0.003, 0.0, 0.0035):
            sig += saw(f * (1 + det), n, rng.random()) * 0.33
    sig = lowpass(sig, 1500, 2)
    env = adsr(n, 0.55, 0.6, 0.75, 1.0, 0.55) * (0.85 + 0.15 * np.sin(2 * np.pi * 0.4 * t))
    return sig * env * 0.115 * gain


def bassnote(freq, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sawv = saw(freq, n) * 0.55 + saw(freq * 1.004, n) * 0.35
    sub = np.sin(2 * np.pi * freq * t) * 0.75
    sig = lowpass(sawv + sub, 420, 2)
    env = adsr(n, 0.006, 0.22, 0.62, 0.14, 0.55)
    return np.tanh(sig * env * 1.4) * 0.72 * gain


def pluck(freq, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) * 0.7 + np.sin(2 * np.pi * freq * 2 * t) * 0.22
    sig += np.sin(2 * np.pi * freq * 3.01 * t) * 0.1
    env = np.exp(-t * 6.0) * adsr(n, 0.004, 0.1, 0.6, 0.4, 0.5)
    return sig * env * 0.3 * gain


# ------------------------------------------------------------------ arrangement
# chords: (bass root, chord tones) per bar
PROG = [
    ("A2", ["A3", "C4", "E4", "G4"]),
    ("F2", ["F3", "A3", "C4", "E4"]),
    ("C3", ["C4", "E4", "G4", "B4"]),
    ("G2", ["G3", "B3", "D4", "F4"]),
    ("A2", ["A3", "C4", "E4", "G4"]),
    ("F2", ["F3", "A3", "C4", "E4"]),
    ("C3", ["C4", "E4", "G4", "B4"]),
    ("G2", ["G3", "B3", "D4", "F4"]),
    ("A2", ["A3", "C4", "E4", "G4"]),
    ("F2", ["F3", "A3", "C4", "E4"]),
    ("C3", ["C4", "E4", "G4", "B4"]),
    ("G2", ["G3", "B3", "D4", "F4"]),
    ("F2", ["F3", "A3", "C4", "E4"]),
    ("G2", ["G3", "B3", "D4", "F4"]),
    ("A2", ["A3", "C4", "E4", "A4"]),
    ("A2", ["A3", "C4", "E4", "A4"]),
]

drums, bass, other = Canvas("drums"), Canvas("bass"), Canvas("other")
lead_canvas = Canvas("lead")
perc_canvas = Canvas("perc")

INTRO_BARS = 2
for bar in range(BARS):
    t0 = bar * BAR
    root, tones = PROG[bar]
    rf = note_hz(root)
    section_b = bar >= BARS - 4

    # ---- drums
    if bar >= INTRO_BARS:
        kicks = [0.0, 1.5, 2.5] if bar % 2 == 0 else [0.0, 1.25, 2.5, 3.25]
        for b in kicks:
            drums.add(kick(0.95 if b == 0.0 else 0.82), t0 + b * BEAT)
        for b in (1.0, 3.0):
            drums.add(snare(0.95), t0 + b * BEAT)
            drums.add(clap(0.9), t0 + b * BEAT)
        for s16 in range(16):
            tt = t0 + s16 * BEAT / 4
            if s16 % 2 == 0:
                drums.add(hat(False, 0.9 if s16 % 4 == 2 else 0.62), tt, pan=0.28)
            elif section_b and s16 in (3, 11):
                drums.add(hat(True, 0.8), tt, pan=0.22)
            elif s16 % 2 == 1 and bar % 2 == 1:
                drums.add(hat(False, 0.35), tt, pan=-0.24)
        if section_b:
            drums.add(hat(True, 0.9), t0 + 3.5 * BEAT, pan=0.18)
        if bar >= BARS - 2:
            for s16 in range(4):
                drums.add(snare(0.45 + 0.15 * s16), t0 + 3 * BEAT + s16 * BEAT / 4)

    # ---- bass
    if bar >= INTRO_BARS:
        pattern = [0.0, 0.75, 1.5, 2.0, 3.0]
        if section_b:
            pattern = [0.0, 0.5, 0.75, 1.5, 2.0, 2.75, 3.5]
        for idx, b in enumerate(pattern):
            f = rf * (2.0 if idx == len(pattern) - 1 and bar % 2 else 1.0)
            dur = BEAT * (0.42 if idx % 2 == 0 else 0.3)
            bass.add(bassnote(f, dur, 1.0 if b % 1 == 0 else 0.8), t0 + b * BEAT)

    # ---- keys (e-piano chord stabs)
    if bar >= 1:
        stabs = [0.5, 1.5, 2.5] if bar % 2 == 0 else [0.0, 1.5, 2.75]
        for b in stabs:
            for k, tone in enumerate(tones):
                other.add(epiano(note_hz(tone), BEAT * 0.9, 0.40 / (1 + 0.25 * k)),
                          t0 + b * BEAT, pan=(-0.3 + 0.2 * k))

    # ---- pad
    if bar >= INTRO_BARS:
        pf = [note_hz(x) for x in tones[1:]]
        p = pad(pf, BAR * 1.05, 1.0 if not section_b else 1.15)
        other.add(p, t0, pan=0.0)

    # ---- lead pluck melody (A minor pentatonic)
    if bar >= 6:
        mel = {
            6: [(0.0, "E5"), (1.0, "G5"), (2.0, "A5")],
            7: [(0.5, "G5"), (1.5, "E5"), (2.5, "D5")],
            8: [(0.0, "C5"), (1.0, "E5"), (2.0, "G5"), (3.0, "A5")],
            9: [(0.0, "A5"), (1.5, "G5"), (2.5, "E5")],
            10: [(0.5, "G5"), (1.5, "C6"), (2.5, "B5")],
            11: [(0.0, "G5"), (1.0, "E5"), (2.0, "D5"), (3.0, "B4")],
            12: [(0.0, "C5"), (1.0, "E5"), (2.0, "A5")],
            13: [(0.0, "B4"), (1.0, "D5"), (2.0, "G5")],
            14: [(0.0, "A5"), (2.0, "E5")],
        }.get(bar, [])
        for b, nm in mel:
            lead_canvas.add(pluck(note_hz(nm), BEAT * 0.8, 0.95), t0 + b * BEAT,
                            pan=0.18)

    # ---- percussion sparkle
    if bar >= INTRO_BARS:
        for s16 in range(0, 16, 2):
            if s16 % 4 == 2:
                perc_canvas.add(shaker(0.9), t0 + s16 * BEAT / 4, pan=-0.35)

# ------------------------------------------------------------------- vocal
voc, vsr = sf.read(os.path.join(os.path.dirname(ROOT), "2_english.wav"))
if voc.ndim == 2:
    voc = voc.mean(axis=1)
voc = np.asarray(voc, dtype=np.float64)
if vsr != SR:
    import math
    voc = sg.resample_poly(voc, SR, vsr)
voc = voc / (np.abs(voc).max() + 1e-9)
# de-ess / soften top end a touch, sounds more like a sung take in the mix
voc = lowpass(voc, 12000, 2)

# find phrases by energy
frame = int(0.02 * SR)
env = np.sqrt(np.convolve(voc ** 2, np.ones(frame) / frame, mode="same"))
thr = max(0.008, env.max() * 0.06)
active = env > thr
segments = []
i = 0
while i < len(active):
    if active[i]:
        j = i
        gap = 0
        while j < len(active):
            if active[j]:
                gap = 0
            else:
                gap += 1
                if gap > int(0.32 * SR):
                    break
            j += 1
        s, e = i, j - gap + int(0.05 * SR)
        if e - s > int(0.25 * SR):
            segments.append((s, e))
        i = j
    else:
        i += 1

vocal_canvas = Canvas("vocals")
starts = [3.0, 8.0, 13.0, 18.0, 23.0, 28.0, 33.0]
phrases = []
si = 0
for k, st in enumerate(starts):
    if si >= len(segments):
        si = 0
    s, e = segments[si]
    si += 1
    seg = voc[s:e].copy()
    seg *= np.linspace(0, 1, min(int(0.015 * SR), len(seg))) if False else 1.0
    seg = seg * adsr(len(seg), 0.008, 0.02, 0.95, 0.06, 0.9)
    vocal_canvas.add(seg, st, gain=0.85, pan=-0.05)
    phrases.append([round(st, 3), round(st + len(seg) / SR, 3)])

# ------------------------------------------------------- bus processing / mix
dr = drums.buf + 0.55 * perc_canvas.buf
bs = bass.buf
oth = other.buf
ld = lead_canvas.buf
ot = oth + ld * 0.9

# gentle glue
dr = np.array([lowpass(dr[c], 16000, 2) for c in range(2)])
bs = np.array([lowpass(bs[c], 900, 2) for c in range(2)])

# reverb sends
ot = ot + reverb(ot, 0.20)
ld_wet = delay(ld, BEAT / 2, 0.3, 0.22)
ot = ot + reverb(ld, 0.28) + ld_wet

vo = vocal_canvas.buf
vo = vo + reverb(vo, 0.16)

# duck the music slightly under the vocals (side-chain feel)
ducker = np.ones(N)
vweight = np.abs(vo).max(axis=0)
vweight = np.convolve(vweight, np.ones(int(0.08 * SR)) / int(0.08 * SR), mode="same")
ducker = 1.0 - 0.18 * np.clip(vweight / (np.abs(vweight).max() + 1e-9), 0, 1)
dr *= ducker
bs *= ducker
ot *= ducker

# gain staging: keep the bass and the vocal forward, the pad polite
GAIN = {"drums": 0.72, "bass": 1.00, "other": 0.52, "vocals": 0.86}
buses = {"drums": dr, "bass": bs, "other": ot, "vocals": vo}
for name, stem in buses.items():
    stem = np.tanh(stem * GAIN[name] * 0.85) * 0.95
    stem = stem[:, :N]
    stem = stem / max(1e-9, np.abs(stem).max()) * 0.9
    sf.write(os.path.join(SRC, f"{name}.wav"), stem.T.astype(np.float32), SR)

mix = dr * GAIN["drums"] + bs * GAIN["bass"] + ot * GAIN["other"] + vo * GAIN["vocals"]
mix = mix[:, :N]
mix = np.tanh(mix * 1.1) * 0.85
mix = mix / np.abs(mix).max() * 0.89
rms = np.sqrt((mix ** 2).mean())
print("mix rms %.2f dBFS  peak %.2f dBFS" % (20 * np.log10(rms), 20 * np.log10(np.abs(mix).max())))
sf.write(os.path.join(OUT, "mix.wav"), mix.T.astype(np.float32), SR)

meta = {
    "sr": SR, "bpm": BPM, "bars": BARS, "duration": N / SR, "song_duration": DUR,
    "key": "A minor", "phrases": phrases,
    "stems": ["vocals", "drums", "bass", "other"],
    "source": "../2_english.wav (project-own TTS take) + procedurally synthesised backing band",
}
with open(os.path.join(OUT, "src_meta.json"), "w") as f:
    json.dump(meta, f, indent=2)

print("wrote mix %.2fs, phrases=%s" % (N / SR, phrases))
