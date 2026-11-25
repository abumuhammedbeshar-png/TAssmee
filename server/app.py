"""
خادم التعرّف على التلاوة لتطبيق «تسميع»
يشغّل نموذج ترتيل المفتوح tarteel-ai/whisper-base-ar-quran بمكتبة faster-whisper (CTranslate2، int8)،
وهي أسرع بعدة مرات من transformers على المعالج نفسه. يستقبل مقاطع WAV من التطبيق.

  GET  /health      → حالة الخادم
  POST /transcribe  → جسم الطلب ملف WAV (16-bit PCM)، والردّ {"text": "..."}

التشغيل محلياً (انظر README.md):
  python convert.py tarteel-ai/whisper-base-ar-quran ./model
  MODEL_DIR=./model uvicorn app:app --port 7860
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
MODEL_DIR = os.environ.get("MODEL_DIR", "/model")   # النموذج بعد تحويله بـ convert.py
THREADS = int(os.environ.get("THREADS", "0") or 0) or (os.cpu_count() or 2)
MAX_BYTES = 4 * 1024 * 1024          # ~2 دقيقة بصيغة 16 ك.هرتز
MAX_SECONDS = 30                      # Whisper يعالج 30 ثانية كحدّ أقصى
RATE = 16000
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

_model = None
_lock = threading.Lock()
_mode = None  # "lang" إن قبل النموذج تحديد العربية صراحةً، و"plain" إن لم يقبل

# فكّ ترميز جشع واحد دون إعادة محاولات ولا تقطيع زمني: أسرع ما يمكن، ومطابق لما كان يفعله الخادم سابقاً
DECODE = dict(
    task="transcribe",
    beam_size=1,
    temperature=0.0,
    without_timestamps=True,
    condition_on_previous_text=False,
    vad_filter=False,                 # التطبيق يقطّع الصوت عند الوقفات بنفسه
    compression_ratio_threshold=None,
    log_prob_threshold=None,
    no_speech_threshold=None,         # لا نُسقط مقطعاً لأن النموذج «ظنّه» صمتاً
    max_new_tokens=220,
)


def get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from faster_whisper import WhisperModel

                _model = WhisperModel(MODEL_DIR, device="auto", compute_type="default", cpu_threads=THREADS, num_workers=1)
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


def _run(audio: np.ndarray, **kw) -> str:
    segments, _info = get_model().transcribe(audio, **DECODE, **kw)
    return " ".join(s.text.strip() for s in segments).strip()


def transcribe(audio: np.ndarray) -> str:
    global _mode
    if _mode != "plain":
        try:
            text = _run(audio, language="ar")
            _mode = "lang"
            return text
        except Exception:
            if _mode == "lang":
                raise
            _mode = "plain"
    return _run(audio)


async def health(request):
    return JSONResponse({"ok": True, "model": MODEL_ID, "ready": _model is not None, "engine": "faster-whisper"})


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
        print("model ready:", MODEL_ID, "threads:", THREADS, flush=True)
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
