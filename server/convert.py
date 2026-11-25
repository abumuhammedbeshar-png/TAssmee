"""
تحويل نموذج ترتيل إلى صيغة CTranslate2 (int8) ليعمل بمكتبة faster-whisper،
وهي أسرع بعدة مرات من مكتبة transformers على المعالج نفسه، وبالدقة نفسها تقريباً.

الاستخدام:  python convert.py [MODEL_ID] [OUT_DIR]
            python convert.py tarteel-ai/whisper-base-ar-quran ./model
يحتاج: pip install torch transformers ctranslate2   (مرة واحدة، وقت البناء فقط)
"""
import json
import os
import re
import sys

LANG_TOKEN = re.compile(r"^<\|[a-z]{2,3}\|>$")


def fix_config(out_dir, tokenizer_json, decoder_layers, decoder_heads):
    """يكمل حقول config.json التي قد تنقص حين لا يعرّف النموذج المنشور إعدادات Whisper كاملة."""
    path = os.path.join(out_dir, "config.json")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    with open(tokenizer_json, encoding="utf-8") as f:
        added = json.load(f).get("added_tokens", [])
    ids = {t["content"]: t["id"] for t in added}
    eos = ids.get("<|endoftext|>", 50257)

    if not cfg.get("suppress_ids"):
        cfg["suppress_ids"] = []
    if not cfg.get("suppress_ids_begin"):
        cfg["suppress_ids_begin"] = [220, eos]
    if not cfg.get("lang_ids"):
        cfg["lang_ids"] = sorted(i for c, i in ids.items() if LANG_TOKEN.match(c))
    if not cfg.get("alignment_heads"):
        cfg["alignment_heads"] = [[l, h] for l in range(decoder_layers // 2, decoder_layers) for h in range(decoder_heads)]

    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 else "tarteel-ai/whisper-base-ar-quran"
    out = sys.argv[2] if len(sys.argv) > 2 else "model"

    from ctranslate2.converters import TransformersConverter
    from transformers import AutoConfig, AutoTokenizer, WhisperFeatureExtractor

    TransformersConverter(model_id).convert(out, quantization="int8", force=True)

    # ملفات يحتاجها faster-whisper بجانب النموذج: المُرمِّز، وإعدادات استخراج الخصائص الصوتية
    tok_path = os.path.join(out, "tokenizer.json")
    AutoTokenizer.from_pretrained(model_id).backend_tokenizer.save(tok_path)
    WhisperFeatureExtractor.from_pretrained(model_id).save_pretrained(out)

    hf = AutoConfig.from_pretrained(model_id)
    cfg = fix_config(out, tok_path, hf.decoder_layers, hf.decoder_attention_heads)
    print(f"converted {model_id} -> {out} ({len(cfg['lang_ids'])} languages)", flush=True)


if __name__ == "__main__":
    main()
