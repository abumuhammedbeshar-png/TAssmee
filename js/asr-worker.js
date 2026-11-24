/*
 * asr-worker.js — يشغّل نموذج ترتيل داخل المتصفح عبر transformers.js
 * يُحمَّل كـ Module Worker حتى لا يتجمّد التطبيق أثناء التعرّف.
 */
const DEFAULT_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let T = null;
let asr = null;
let loading = null;
let forced = null; // هل نجح فرض بادئة «عربي/تفريغ» على النموذج؟
let ids = null;
let chain = Promise.resolve();

async function gpuDtype() {
  try {
    if (!self.navigator || !self.navigator.gpu) return null;
    const ad = await self.navigator.gpu.requestAdapter();
    if (!ad) return null;
    return ad.features && ad.features.has('shader-f16') ? 'fp16' : 'q4';
  } catch (e) {
    return null;
  }
}

async function load(model, lib) {
  T = T || (await import(lib || DEFAULT_LIB));
  if (T.env) {
    T.env.allowLocalModels = false;
    T.env.useBrowserCache = true;
  }
  const files = {};
  const progress_callback = (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress') files[p.file] = [p.loaded || 0, p.total || 0];
    else if (p.status === 'done' && files[p.file]) files[p.file][0] = files[p.file][1];
    else return;
    let l = 0, t = 0;
    for (const k in files) { l += files[k][0]; t += files[k][1]; }
    self.postMessage({ type: 'progress', loaded: l, total: t, file: p.file });
  };
  const gpu = await gpuDtype();
  const tries = gpu ? [['webgpu', gpu], ['wasm', 'q8']] : [['wasm', 'q8']];
  let last = null;
  for (const [device, dtype] of tries) {
    try {
      asr = await T.pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
      await asr(new Float32Array(16000), { max_new_tokens: 4 }); // تجربة تحمية تكشف أعطال WebGPU مبكراً
      return { device, dtype, model };
    } catch (e) {
      last = e;
      asr = null;
    }
  }
  throw last || new Error('load failed');
}

function tokId(tok, fallback) {
  try {
    const m = asr.tokenizer && asr.tokenizer.model;
    const v = m && m.tokens_to_ids ? m.tokens_to_ids.get(tok) : undefined;
    if (Number.isInteger(v)) return v;
  } catch (e) { /* ignore */ }
  return fallback;
}

async function run(audio) {
  const base = { max_new_tokens: 220 };
  if (forced !== false) {
    try {
      ids = ids || { ar: tokId('<|ar|>', 50272), tr: tokId('<|transcribe|>', 50359), nt: tokId('<|notimestamps|>', 50363) };
      // ملف الإعدادات المنشور لا يعرّف النموذج كمتعدد اللغات، فنمرّر رموز البادئة صراحةً
      const out = await asr(audio, {
        ...base,
        is_multilingual: true,
        language: 'ar',
        task: 'transcribe',
        lang_to_id: { '<|ar|>': ids.ar },
        task_to_id: { transcribe: ids.tr },
        no_timestamps_token_id: ids.nt,
      });
      forced = true;
      return out.text;
    } catch (e) {
      if (forced === true) throw e;
      forced = false;
    }
  }
  const out = await asr(audio, base);
  return out.text;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    try {
      loading = loading || load(m.model, m.lib);
      const info = await loading;
      self.postMessage({ type: 'ready', ...info });
    } catch (err) {
      loading = null;
      self.postMessage({ type: 'fail', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'run') {
    chain = chain.then(async () => {
      try {
        const text = await run(m.audio);
        self.postMessage({ type: 'result', id: m.id, text });
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
      }
    });
  }
};
