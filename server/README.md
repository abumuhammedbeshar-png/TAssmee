---
title: Tasmee ASR
emoji: 📖
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# خادم التعرّف على التلاوة لتطبيق «تسميع»

يشغّل نموذج ترتيل المفتوح [tarteel-ai/whisper-base-ar-quran](https://huggingface.co/tarteel-ai/whisper-base-ar-quran) (ترخيص Apache-2.0)، ويستقبل مقاطع الصوت من التطبيق ويعيد النص.

يعمل النموذج بمكتبة **faster-whisper** (CTranslate2، بدقة int8)، وهي أسرع بعدة مرات من مكتبة transformers على المعالج نفسه، وبالدقة نفسها تقريباً. يُحوَّل النموذج إلى صيغتها تلقائياً أثناء بناء الـSpace (`convert.py`).

## النشر المجاني على Hugging Face Spaces

1. أنشئ حساباً على huggingface.co، ثم اضغط **New Space**.
2. اختر اسماً (مثلاً `tasmee-asr`)، واختر **Docker** ثم **Blank**، والعتاد **CPU basic (free)**.
3. ارفع ملفات هذا المجلد الستة إلى الـSpace: `README.md` و`Dockerfile` و`requirements.txt` و`requirements-convert.txt` و`app.py` و`convert.py` (من تبويب Files ← Add file ← Upload files).
4. انتظر حتى تظهر الحالة **Running** (البناء الأول يستغرق نحو ١٠ دقائق لأنه يحوّل النموذج).

**إن كان عندك Space قديم:** ارفع الملفات الستة نفسها فوق القديمة، فيُعاد البناء تلقائياً. يمكنك التأكد من التحديث بفتح `https://رابط-خادمك/health`: يجب أن يظهر فيه `"engine": "faster-whisper"`.
5. رابط خادمك: `https://اسم-حسابك-tasmee-asr.hf.space`
6. في التطبيق: الإعدادات ← محرّك التعرّف ← «ترتيل · خادم»، والصق الرابط ثم «اختبر الاتصال».

ملاحظة: الـSpace المجاني ينام بعد فترة من عدم الاستخدام، فيتأخر أول طلب بعدها قليلاً.

## الواجهة

| الطلب | الوصف |
|---|---|
| `GET /health` | `{"ok": true, "model": "...", "ready": true, "engine": "faster-whisper"}` |
| `POST /transcribe` | جسم الطلب ملف WAV بصيغة 16-bit PCM (يُفضّل 16 ك.هرتز أحادي)، والردّ `{"text": "..."}` |

## الإعدادات (متغيرات البيئة)

- `MODEL_ID`: نموذج آخر بدل نموذج ترتيل (الافتراضي `tarteel-ai/whisper-base-ar-quran`).
- `ALLOWED_ORIGINS`: لحصر الاستخدام في موقع تطبيقك، مثلاً `https://اسمك.github.io` (الافتراضي: الكل).
- `THREADS`: عدد أنوية المعالج المستخدمة (الافتراضي: كلها).

## التشغيل محلياً

```bash
pip install -r requirements-convert.txt -r requirements.txt
python convert.py tarteel-ai/whisper-base-ar-quran ./model   # مرة واحدة
MODEL_DIR=./model uvicorn app:app --port 7860
```
