"""
تنزيل نموذج FastConformer-Quran أثناء بناء الخادم.
المستودع «مقيَّد» (gated): وافق على شروطه في صفحة النموذج أولاً، وضع رمز الدخول في أسرار الـSpace باسم HF_TOKEN.
الاستخدام: python download.py /model
"""
import os
import sys

from huggingface_hub import hf_hub_download

REPO = os.environ.get("MODEL_REPO", "Muno459/fastconformer-quran")
FILE = os.environ.get("MODEL_FILE", "nemo/fastconformer-quran.nemo")


def token():
    for p in ("/run/secrets/HF_TOKEN",):
        if os.path.exists(p):
            return open(p).read().strip()
    return os.environ.get("HF_TOKEN") or None


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/model"
    tok = token()
    if not tok:
        sys.exit("HF_TOKEN غير موجود: أضفه في Settings ← Variables and secrets ← New secret")
    path = hf_hub_download(REPO, FILE, local_dir=out, token=tok)
    print("downloaded", path, os.path.getsize(path) // 1048576, "MB", flush=True)
