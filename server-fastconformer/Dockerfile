FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/tmp/hf MODEL_DIR=/model HOME=/tmp NUMBA_CACHE_DIR=/tmp/numba MPLCONFIGDIR=/tmp/mpl
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ffmpeg libsndfile1 git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# PyTorch للمعالج فقط (نسخة GPU أكبر بعدة غيغابايتات ولا فائدة منها هنا)
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
COPY requirements.txt .
RUN pip install -r requirements.txt

# تنزيل النموذج أثناء البناء (المستودع مقيَّد: يحتاج السر HF_TOKEN في إعدادات الـSpace)
COPY download.py .
RUN --mount=type=secret,id=HF_TOKEN,mode=0444,required=true python download.py /model && chmod -R 755 /model

COPY app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
