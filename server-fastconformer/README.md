---
title: Tasmee FastConformer
emoji: 📖
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: other
---

# خادم «تسميع» بنموذج FastConformer-Quran

يشغّل نموذج [Muno459/fastconformer-quran](https://huggingface.co/Muno459/fastconformer-quran): نموذج FastConformer Large برأس CTC، مدرَّب على تلاوة القرآن (رواية حفص)، ويكتب نصاً مشكّلاً. لا «يصحّح» خطأ القارئ تلقائياً لأنه لا يعتمد على نموذج لغوي. يستقبل مقاطع الصوت من التطبيق ويعيد النص، بنفس واجهة خادم ترتيل (مجلد `server`)، فلا يتغيّر في التطبيق إلا الرابط.

**الترخيص:** النموذج مرخّص بـ NPL-1.1 (Quran-Lab No-Profit License): الاستخدام غير الربحي فقط. النموذج الأساسي من NVIDIA مرخّص بـ CC-BY-4.0. التطبيق مجاني وخدمي، فاستخدامه هنا جائز. لا تستخدمه في خدمة مدفوعة أو فيها إعلانات.

## النشر المجاني على Hugging Face Spaces

المستودع **مقيَّد**: يجب أن توافق على شروطه، وأن يعطي حسابُك الخادمَ إذناً بتنزيله. نفّذ الخطوات بهذا الترتيب:

1. **وافق على شروط النموذج:** سجّل الدخول في huggingface.co، وافتح صفحة [Muno459/fastconformer-quran](https://huggingface.co/Muno459/fastconformer-quran)، ووافق على الشروط الظاهرة أعلاها (Agree and access repository).
2. **أنشئ رمز دخول:** صورة حسابك ← Settings ← Access Tokens ← Create new token. اختر النوع **Read**، وسمّه مثلاً `tasmee`، ثم انسخ الرمز (يبدأ بـ `hf_`). لا تشاركه مع أحد.
3. **أنشئ الـSpace:** صورة حسابك ← New Space. اسم مثل `tasmee-fastconformer`، و**Docker** ثم **Blank**، والعتاد **CPU basic (Free)**، ثم Create Space.
4. **أضف الرمز سرّاً:** في الـSpace افتح Settings ← Variables and secrets ← **New secret**. الاسم `HF_TOKEN` بالضبط، والقيمة الرمز الذي نسخته. ثم Save.
5. **ارفع الملفات الخمسة** من هذا المجلد: `README.md` و`Dockerfile` و`requirements.txt` و`download.py` و`app.py` (Files ← Add file ← Upload files ← Commit).
6. **انتظر البناء:** قد يستغرق ٢٠–٣٠ دقيقة في المرة الأولى (مكتبة NeMo كبيرة، والنموذج نحو ٤٦٠ م.ب)، حتى تظهر الحالة **Running**. بعدها يحتاج الخادم دقيقة أو اثنتين ليحمّل النموذج.
7. **تأكد أنه يعمل:** افتح `https://اسم-حسابك-tasmee-fastconformer.hf.space/health`، فيجب أن ترى `"ok": true` و`"ready": true`.
8. **في التطبيق:** الإعدادات ← محرّك التعرّف ← «خادم خاص»، والصق الرابط (دون `/health`)، ثم «اختبر الاتصال».

**إن فشل البناء:** افتح تبويب **Logs**. إن ذكر `HF_TOKEN` فراجع الخطوتين ٢ و٤، وإن ذكر `401` أو `403` فراجع الخطوة ١، ثم اضغط Settings ← **Factory rebuild**. ولأي خطأ آخر أرسل صورة آخر الأسطر.

ملاحظات:
- الـSpace المجاني ينام بعد فترة دون استخدام، فيتأخر أول طلب بعدها (تحميل النموذج من جديد نحو دقيقة).
- لحصر الاستخدام في تطبيقك: أضف متغيراً (Variable) اسمه `ALLOWED_ORIGINS` وقيمته `https://اسمك.github.io`.

## الواجهة

| الطلب | الوصف |
|---|---|
| `GET /health` | `{"ok": true, "model": "Muno459/fastconformer-quran", "ready": true, "engine": "nemo-fastconformer"}` |
| `POST /transcribe` | جسم الطلب ملف WAV بصيغة 16-bit PCM، والردّ `{"text": "..."}` |

## الإعدادات (متغيرات البيئة)

- `ALLOWED_ORIGINS`: المواقع المسموح لها (الافتراضي: الكل).
- `THREADS`: عدد أنوية المعالج (الافتراضي: كلها).
