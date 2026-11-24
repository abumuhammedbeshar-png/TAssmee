FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 HF_HOME=/app/.hf PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# تنزيل النموذج أثناء البناء ليبدأ الخادم بسرعة
RUN mkdir -p /app/.hf && python -c "from transformers import pipeline; pipeline('automatic-speech-recognition', model='tarteel-ai/whisper-base-ar-quran')" && chmod -R 777 /app/.hf

COPY app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
