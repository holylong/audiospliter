"""Two-speaker separation service (FastAPI).

Run:  .venv/bin/python -m uvicorn app.server:app --host 127.0.0.1 --port 8010
Open: http://127.0.0.1:8010
"""
import json
import os
import shutil
import threading
import time
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(ROOT, "..", "data", "jobs")
STATIC = os.path.join(ROOT, "static")

_MIME = {"wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac", "m4a": "audio/mp4"}


def _mime(path: str) -> str:
    """Uploads keep their own container, so let the browser pick the right decoder."""
    return _MIME.get(os.path.splitext(path)[1].lower().lstrip("."), "application/octet-stream")

os.makedirs(WORK, exist_ok=True)

app = FastAPI(title="双人对话分离")

JOBS = {}
LOCK = threading.Lock()

STAGE_ORDER = ["upload", "decode", "load", "vad", "embed", "cluster", "mask", "write", "done"]
STAGE_LABEL = {
    "upload": "上传",
    "decode": "解码 / 重采样",
    "load": "加载声纹模型",
    "vad": "语音活动检测",
    "embed": "提取声纹嵌入",
    "cluster": "双人聚类",
    "mask": "生成两路掩码",
    "write": "导出分轨",
    "done": "完成",
}


def _job(job_id):
    with LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


def _run(job_id, in_path, out_dir):
    job = JOBS[job_id]

    def stage(name, progress, detail=""):
        job["stage"] = name
        job["progress"] = round(progress, 4)
        job["detail"] = detail
        job["logs"].append({
            "t": round(time.time() - job["t0"], 2),
            "stage": name,
            "label": STAGE_LABEL.get(name, name),
            "progress": round(progress, 4),
            "detail": detail,
        })

    try:
        from scripts.sep_engine import separate

        meta = separate(in_path, out_dir, on_stage=stage)
        with open(os.path.join(out_dir, "meta.json"), "w") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=1)
        job["meta"] = meta
        job["status"] = "done"
        job["progress"] = 1.0
        job["elapsed"] = round(time.time() - job["t0"], 2)
    except Exception as exc:  # surface the real reason in the UI
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"
        job["logs"].append({"t": round(time.time() - job["t0"], 2), "stage": "error",
                            "label": "失败", "progress": job["progress"], "detail": job["error"]})


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...)):
    job_id = uuid.uuid4().hex[:12]
    out_dir = os.path.join(WORK, job_id)
    os.makedirs(out_dir, exist_ok=True)
    in_path = os.path.join(out_dir, "input" + (os.path.splitext(file.filename)[1] or ".wav"))
    with open(in_path, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    job = {
        "id": job_id,
        "status": "running",
        "stage": "upload",
        "progress": 0.02,
        "detail": "已接收",
        "name": file.filename,
        "t0": time.time(),
        "logs": [],
        "meta": None,
        "error": None,
        "elapsed": None,
    }
    job["logs"].append({"t": 0.0, "stage": "upload", "label": "上传", "progress": 0.02,
                        "detail": f"{file.filename}"})
    with LOCK:
        JOBS[job_id] = job
    threading.Thread(target=_run, args=(job_id, in_path, out_dir), daemon=True).start()
    return {"id": job_id, "name": file.filename}


@app.get("/api/jobs/{job_id}")
def job_state(job_id: str):
    job = _job(job_id)
    return JSONResponse({k: v for k, v in job.items() if k not in ("t0",)})


@app.get("/api/jobs/{job_id}/audio/{name}")
def job_audio(job_id: str, name: str):
    _job(job_id)
    allowed = ("spk1.wav", "spk2.wav", "spk1_preview.wav", "spk2_preview.wav",
               "input.wav", "input.mp3", "input.flac", "input.m4a", "_mono16k.wav")
    if name not in allowed:
        raise HTTPException(status_code=400, detail="bad file")
    path = os.path.join(WORK, job_id, name)
    if not os.path.exists(path):
        for alt in ("input.wav", "input.mp3", "input.flac", "input.m4a"):
            cand = os.path.join(WORK, job_id, alt)
            if name == "input.wav" and os.path.exists(cand):
                return FileResponse(cand, media_type=_mime(cand))
        raise HTTPException(status_code=404, detail="missing")
    return FileResponse(path, media_type=_mime(path))


@app.get("/api/jobs/{job_id}/meta")
def job_meta(job_id: str):
    job = _job(job_id)
    if not job["meta"]:
        raise HTTPException(status_code=409, detail="not ready")
    return job["meta"]


@app.get("/api/sample")
def sample():
    """The bundled demo conversation, so the app is testable without uploads."""
    for rel in (("samples", "双人对话_30s.wav"), ("data", "dialog", "mix.wav")):
        path = os.path.join(ROOT, "..", *rel)
        if os.path.exists(path):
            return FileResponse(path, media_type="audio/wav")
    raise HTTPException(status_code=404, detail="sample missing")


@app.get("/api/health")
def health():
    return {"ok": True, "jobs": len(JOBS)}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
