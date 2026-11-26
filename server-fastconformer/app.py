"""
خادم التعرّف على التلاوة لتطبيق «تسميع» — نموذج FastConformer-Quran
  Muno459/fastconformer-quran: FastConformer Large مع رأس CTC، مدرَّب على القرآن (رواية حفص).
  يكتب نصاً مشكّلاً، ولا «يصحّح» خطأ القارئ تلقائياً لأنه CTC بلا نموذج لغوي.
  الترخيص NPL-1.1: الاستخدام غير الربحي فقط، مع ذكر NVIDIA (النموذج الأساسي CC-BY-4.0).

الواجهة نفسها التي يستعملها التطبيق مع خادم ترتيل:
  GET  /health      → حالة الخادم
  POST /transcribe  → جسم الطلب ملف WAV (16-bit PCM)، والردّ {"text": "..."}
"""
import glob
import io
import os
import tempfile
import threading
import wave
from contextlib import asynccontextmanager

import numpy as np
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

MODEL_NAME = "Muno459/fastconformer-quran"
MODEL_DIR = os.environ.get("MODEL_DIR", "/model")
MAX_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 30
RATE = 16000
THREADS = int(os.environ.get("THREADS", "0") or 0) or (os.cpu_count() or 2)
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

_model = None
_lock = threading.Lock()
_numpy_ok = None  # هل يقبل transcribe مصفوفات numpy مباشرة؟ (يختلف بين إصدارات NeMo)


def model_path():
    files = glob.glob(os.path.join(MODEL_DIR, "**", "*.nemo"), recursive=True)
    if not files:
        raise FileNotFoundError(f"no .nemo file under {MODEL_DIR}")
    return files[0]


def get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                import torch
                from nemo.collections.asr.models import ASRModel

                torch.set_num_threads(THREADS)
                m = ASRModel.restore_from(model_path(), map_location="cpu")
                m.eval()
                # إن كان النموذج هجيناً (RNNT + CTC) نستخدم رأس CTC كما وصفه صاحبه
                if hasattr(m, "cur_decoder"):
                    try:
                        m.change_decoding_strategy(decoder_type="ctc")
                    except Exception as e:  # noqa: BLE001
                        print("ctc decoder switch failed:", e, flush=True)
                _model = m
    return _model


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError("WAV must be 16-bit PCM")
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    if rate != RATE and len(audio):
        n = int(round(len(audio) * RATE / rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio[: RATE * MAX_SECONDS]


def _text(out) -> str:
    """مخرجات transcribe تختلف بين الإصدارات: نصوص، أو كائنات Hypothesis، أو زوج (أفضل، كل الاحتمالات)"""
    if isinstance(out, tuple):
        out = out[0]
    if not out:
        return ""
    h = out[0]
    if isinstance(h, list):
        h = h[0] if h else ""
    return str(getattr(h, "text", h) or "").strip()


def transcribe(audio: np.ndarray) -> str:
    global _numpy_ok
    m = get_model()
    import torch

    with torch.inference_mode():
        if _numpy_ok is not False:
            try:
                out = m.transcribe([audio], batch_size=1, verbose=False)
                _numpy_ok = True
                return _text(out)
            except Exception:
                if _numpy_ok:
                    raise
                _numpy_ok = False
        # الإصدارات الأقدم تقبل مسارات ملفات فقط
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            with wave.open(f.name, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
                w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
            return _text(m.transcribe([f.name], batch_size=1, verbose=False))


async def health(request):
    return JSONResponse({"ok": True, "model": MODEL_NAME, "ready": _model is not None, "engine": "nemo-fastconformer"})


async def transcribe_endpoint(request):
    body = await request.body()
    if not body:
        return JSONResponse({"error": "empty body"}, status_code=400)
    if len(body) > MAX_BYTES:
        return JSONResponse({"error": "audio too large"}, status_code=413)
    try:
        audio = read_wav(body)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"bad wav: {e}"}, status_code=400)
    if len(audio) < RATE // 4:
        return JSONResponse({"text": ""})
    text = await run_in_threadpool(transcribe, audio)
    return JSONResponse({"text": text})


def warmup():
    try:
        get_model()
        transcribe(np.zeros(RATE, dtype=np.float32))  # تحمية: أول طلب حقيقي لا ينتظر التهيئة
        print("model ready:", MODEL_NAME, "threads:", THREADS, "numpy input:", _numpy_ok, flush=True)
    except Exception as e:  # noqa: BLE001
        print("model load failed:", e, flush=True)


@asynccontextmanager
async def lifespan(app):
    if os.environ.get("WARMUP", "1") == "1":
        threading.Thread(target=warmup, daemon=True).start()
    yield


app = Starlette(
    routes=[
        Route("/", health),
        Route("/health", health),
        Route("/transcribe", transcribe_endpoint, methods=["POST"]),
    ],
    middleware=[Middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])],
    lifespan=lifespan,
)
