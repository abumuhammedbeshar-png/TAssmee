# ---- المرحلة ١: تحويل نموذج ترتيل إلى صيغة CTranslate2 (int8). تُحذف هذه المرحلة من الصورة النهائية ----
FROM python:3.11-slim AS convert
ENV PIP_NO_CACHE_DIR=1 HF_HOME=/tmp/hf
ARG MODEL_ID=tarteel-ai/whisper-base-ar-quran
COPY requirements-convert.txt convert.py ./
RUN pip install -r requirements-convert.txt
RUN python convert.py "$MODEL_ID" /model

# ---- المرحلة ٢: الخادم (faster-whisper فقط، دون torch، فالصورة أصغر والتشغيل أسرع) ----
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MODEL_DIR=/model
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY --from=convert /model /model
COPY app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
