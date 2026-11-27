#!/usr/bin/env python3
"""Build the soundtrack for the recorded demo and mux the final MP4.

The browser recording has no audio track, so the sound is rebuilt from the real
files the app produced, placed on the exact frames where the UI pressed play.
Alignment comes from the white flash frame the recorder injects: its wall-clock
mark is known, so the picture offset of the recording start is measured instead
of assumed.

    .venv/bin/python scripts/make_video.py [--preview]
"""
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

OUT_SR = 48000
VID = "build/video"
FINAL = "out/demo-双人对话分离.mp4"
MIX = "data/dialog/mix.wav"
SPK = ["data/dialog/separated/spk1.wav", "data/dialog/separated/spk2.wav"]


def latest_meta():
    """The newest job's meta + folder, so the bed uses the very files the UI played."""
    import glob

    files = glob.glob("data/jobs/*/meta.json")
    if not files:
        return None, None
    path = max(files, key=os.path.getmtime)
    return json.load(open(path)), os.path.dirname(path)


def sh(cmd, **kw):
    bad = [(i, repr(c)) for i, c in enumerate(cmd) if not isinstance(c, (str, bytes, os.PathLike))]
    if bad:
        print("non-str argv:", bad, file=sys.stderr)
    return subprocess.run([str(c) for c in cmd], check=True, capture_output=True, text=True, **kw)


def video_info(path):
    r = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "json", path])
    d = json.loads(r.stdout)
    dur = float(d["format"]["duration"])
    st = d["streams"][0]
    return dur, st["width"], st["height"], st["r_frame_rate"]


def flash_time(path, fps=10, n_warm=6):
    """Return the timestamp of the brightest frame in the first seconds."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-t", "4",
         "-vf", f"fps={fps},scale=96:54,format=gray", "-f", "rawvideo", "-"],
        check=True, capture_output=True)
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    frames = buf.reshape(-1, 54, 96).astype(np.float32)
    lum = frames.mean(axis=(1, 2))
    idx = int(np.argmax(lum[n_warm:]) + n_warm)
    return idx / fps, float(lum[idx]), float(np.median(lum))


def load(path, sr=OUT_SR):
    x, src = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if src != sr:
        from math import gcd
        from scipy.signal import resample_poly

        g = gcd(sr, int(src))
        x = resample_poly(x, sr // g, int(src) // g).astype("float32")
    return x


def place(bed, clip, at, gain=1.0, fade=0.06):
    i0 = int(at * OUT_SR)
    if i0 < 0:
        clip = clip[-i0:]
        i0 = 0
    n = min(len(clip), len(bed) - i0)
    if n <= 0:
        return
    seg = clip[:n] * gain
    f = min(int(fade * OUT_SR), n // 2)
    if f > 0:
        ramp = np.linspace(0, 1, f, dtype="float32")
        seg[:f] *= ramp
        seg[-f:] *= ramp[::-1]
    bed[i0:i0 + n] += seg


def main():
    ev = json.load(open(f"{VID}/events.json"))
    video = ev["video"]
    dur, w, h, fps = video_info(video)
    t_flash, lum_peak, lum_med = flash_time(video)
    off = t_flash - ev["events"]["flash"] / 1000.0
    print(f"video {w}x{h} {fps} {dur:.2f}s | flash at {t_flash:.2f}s "
          f"(lum {lum_peak:.0f} vs {lum_med:.0f}) -> start offset {off:+.2f}s")

    T = {k: v / 1000.0 + off for k, v in ev["events"].items()}
    for k in ("upload", "ready", "play0", "play1", "download", "outro"):
        print(f"  {k:9s} {T[k]:6.2f}s")

    meta, job_dir = latest_meta()
    sources = list(SPK)
    if meta:
        sources = [os.path.join(job_dir, t.get("preview") or t["file"]) for t in meta["tracks"]]
        print(f"  sources: {sources}")

    bed = np.zeros(int(dur * OUT_SR) + OUT_SR, dtype="float32")
    mix = load(MIX)
    speak = [load(p) for p in sources]

    # the conversation plays while the pipeline runs
    span = max(1.0, T["ready"] - T["upload"])
    place(bed, mix[: int(span * OUT_SR)], T["upload"], gain=0.85, fade=0.25)
    # each 试听 excerpt plays exactly while its row is highlighted in the UI
    for i in (0, 1):
        place(bed, speak[i], T[f"play{i}"], gain=1.0)

    # gentle fade at both ends, normalise to -1.5 dBFS
    f = int(0.35 * OUT_SR)
    bed[:f] *= np.linspace(0, 1, f, dtype="float32")
    bed[-f:] *= np.linspace(1, 0, f, dtype="float32")
    peak = float(np.abs(bed).max()) or 1.0
    bed *= 0.845 / peak
    bed = bed[: int(dur * OUT_SR)]

    os.makedirs(os.path.dirname(FINAL), exist_ok=True)
    wav = f"{VID}/bed.wav"
    sf.write(wav, bed, OUT_SR, subtype="PCM_16")

    sh(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", wav,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-r", "25", "-bf", "2",
        "-c:a", "aac", "-b:a", "192k", "-ar", OUT_SR, "-ac", "2",
        "-movflags", "+faststart", "-shortest", FINAL])
    d2, w2, h2, fps2 = video_info(FINAL)
    size = os.path.getsize(FINAL) / 1e6
    print(f"wrote {FINAL}  {w2}x{h2} {fps2} {d2:.2f}s  {size:.1f} MB")


if __name__ == "__main__":
    main()
