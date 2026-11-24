"""
خادم التعرّف على التلاوة لتطبيق «تسميع»
يشغّل نموذج ترتيل المفتوح tarteel-ai/whisper-base-ar-quran ويستقبل مقاطع WAV من التطبيق.

  GET  /health      → حالة الخادم
  POST /transcribe  → جسم الطلب ملف WAV (16-bit PCM)، والردّ {"text": "..."}

التشغيل محلياً:  pip install -r requirements.txt && uvicorn app:app --port 7860
"""
import io
import os
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

MODEL_ID = os.environ.get("MODEL_ID", "tarteel-ai/whisper-base-ar-quran")
MAX_BYTES = 4 * 1024 * 1024          # ~2 دقيقة بصيغة 16 ك.هرتز
MAX_SECONDS = 30                      # Whisper يعالج 30 ثانية كحدّ أقصى
RATE = 16000
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

_pipe = None
_lock = threading.Lock()
_mode = None  # "lang" إن قبل النموذج تحديد العربية صراحةً، و"plain" إن لم يقبل


def get_pipe():
    global _pipe
    if _pipe is None:
        with _lock:
            if _pipe is None:
                import torch
                from transformers import pipeline

                _pipe = pipeline(
                    "automatic-speech-recognition",
                    model=MODEL_ID,
                    device=0 if torch.cuda.is_available() else -1,
                )
    return _pipe


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


def transcribe(audio: np.ndarray) -> str:
    global _mode
    pipe = get_pipe()
    inp = {"raw": audio, "sampling_rate": RATE}
    if _mode != "plain":
        try:
            out = pipe(inp, generate_kwargs={"language": "arabic", "task": "transcribe", "max_new_tokens": 220})
            _mode = "lang"
            return out["text"].strip()
        except Exception:
            if _mode == "lang":
                raise
            _mode = "plain"
    out = pipe(inp, generate_kwargs={"max_new_tokens": 220})
    return out["text"].strip()


async def health(request):
    return JSONResponse({"ok": True, "model": MODEL_ID, "ready": _pipe is not None})


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
        get_pipe()
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
