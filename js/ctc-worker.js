/*
 * ctc-worker.js — يشغّل نموذج «المعلّم» داخل المتصفح:
 *   HisnLabs Tajweed v2 (‏Apache-2.0): مُشفِّر Whisper-base مدرَّب على التلاوة، بلا مُفكِّك.
 *   يسمع المقطع دفعة واحدة ويكتب ما سمعه بالكتابة الصوتية للقرآن، مع ثقته في كل رمز.
 * المطابقة مع النص تجري في الصفحة (js/phonetic.js)؛ هنا السماع فقط.
 */
import { makeResumableFetch } from './resumable.js';

const MODEL_URL = 'https://huggingface.co/Hisnlabs/tajweed-v2/resolve/main/onnx/model-int8.onnx';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const TF_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const STORE = 'tasmee-models';
const RATE = 16000;
const LEAD = RATE * 0.4; // مقاطع التدريب تبدأ وتنتهي بصمت (inference.py في مستودع النموذج)
// ترتيب رموز النموذج (config.json)؛ الفهرس ٠ = فراغ CTC
const PH = Array.from('ءبتثجحخدذرزسشصضطظعغفقكلمنهويا').concat(['ۦ', 'ۥ', 'َ', 'ُ', 'ِ', '۪', 'ـ', 'ٲ', 'ڇ', 'ں', '۾', 'ۜ', 'ؙ']);

let ort = null, sess = null, fe = null, loading = null;
let chain = Promise.resolve();
const RF = self.caches && self.fetch ? makeResumableFetch({ fetch: self.fetch.bind(self), caches: self.caches }) : null;
const post = (m) => self.postMessage(m);

/* ---------- ملف النموذج: محفوظ على الجهاز، ويُستكمل تحميله إن انقطع ---------- */
async function modelBytes(url) {
  let store = null;
  try {
    store = await caches.open(STORE);
    const hit = await store.match(url);
    if (hit) { post({ type: 'progress', phase: 'open' }); return new Uint8Array(await hit.arrayBuffer()); }
  } catch (e) { /* لا ذاكرة: نحمّل كل مرة */ }
  let parts, got;
  try {
    ({ parts, got } = await download(RF ? RF.fetch : fetch, url));
  } catch (e) {
    // التحميل على أجزاء لم ينجح (خادم أو شبكة لا تقبل طلبات الأجزاء): نجرّب التحميل العادي مرة
    if (!RF) throw e;
    ({ parts, got } = await download(fetch, url));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (store) {
    try {
      await store.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(got) } }));
      if (RF) RF.forget(url).catch(() => {});
    } catch (e) { /* امتلأت الذاكرة: تبقى أجزاء التحميل وتُستعمل في المرة القادمة */ }
  }
  return buf;
}

async function download(get, url) {
  const res = await get(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got - shown >= 262144 || got === total) { shown = got; post({ type: 'progress', phase: 'model', loaded: got, total }); }
  }
  if (total && got !== total) throw new Error('incomplete download ' + got + '/' + total);
  return { parts, got };
}

/* ---------- محرّك التشغيل (onnxruntime-web) ---------- */
async function loadOrt() {
  if (ort) return ort;
  let last = null;
  for (const f of ['ort.wasm.min.mjs', 'ort.min.mjs']) {
    try { ort = await import(ORT_BASE + f); break; } catch (e) { last = e; }
  }
  if (!ort) throw last || new Error('ort');
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, (self.navigator && self.navigator.hardwareConcurrency) || 2) : 1;
  return ort;
}

/* ---------- خصائص الصوت: log-mel بـ٨٠ نطاقاً كما في Whisper، بطول المقطع الحقيقي ---------- */
async function melOf(x, audio) {
  const r = await x(audio);
  const t = r.input_features;
  const nf = t.dims[t.dims.length - 1], nm = t.dims[t.dims.length - 2];
  if (nm !== 80) throw new Error('mel bins ' + nm);
  let T = Math.min(3000, Math.floor(audio.length / 160), nf);
  T -= T % 2; // النموذج يطلب عدداً زوجياً من الإطارات
  const data = new Float32Array(80 * T);
  for (let k = 0; k < 80; k++) data.set(t.data.subarray(k * nf, k * nf + T), k * T);
  return { data, T };
}
async function loadFE() {
  if (fe) return fe;
  const T = await import(TF_LIB);
  const probe = new Float32Array(RATE).map((_, i) => 0.1 * Math.sin(i / 7));
  const check = async (x) => {
    const m = await melOf(x, probe);
    if (m.T < 90 || !m.data.every(Number.isFinite)) throw new Error('bad features');
    return x;
  };
  const cfg = {
    feature_extractor_type: 'WhisperFeatureExtractor', feature_size: 80, sampling_rate: RATE, hop_length: 160,
    chunk_length: 30, n_fft: 400, n_samples: 480000, nb_max_frames: 3000, padding_side: 'right', padding_value: 0, return_attention_mask: false,
  };
  try { fe = await check(new T.WhisperFeatureExtractor(cfg)); }
  catch (e) { fe = await check(await T.AutoFeatureExtractor.from_pretrained('onnx-community/whisper-base')); }
  return fe;
}

/* ---------- السماع: CTC بأفضل مسار (أعلى رمز في كل إطار، دون تكرار ولا فراغ) ---------- */
async function hear(audio) {
  const a = new Float32Array(audio.length + 2 * LEAD);
  a.set(audio, LEAD);
  const { data, T } = await melOf(fe, a);
  if (T < 2) return { ph: '', probs: [] };
  const names = sess.inputNames;
  const feeds = {};
  feeds[names.includes('mel') ? 'mel' : names[0]] = new ort.Tensor('float32', data, [1, 80, T]);
  if (names.includes('riwaya')) feeds.riwaya = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]); // حفص
  const out = await sess.run(feeds);
  const lp = out.logprobs || out[sess.outputNames[0]];
  const V = lp.dims[lp.dims.length - 1], F = lp.dims[lp.dims.length - 2], d = lp.data;
  let ph = '', prev = 0;
  const probs = [];
  for (let t = 0; t < F; t++) {
    const o = t * V;
    let k = 0, best = -Infinity;
    for (let v = 0; v < V; v++) if (d[o + v] > best) { best = d[o + v]; k = v; }
    if (k !== prev && k !== 0) {
      let z = 0;
      for (let v = 0; v < V; v++) z += Math.exp(d[o + v] - best);
      ph += PH[k - 1] || '';
      probs.push(1 / z); // احتمال الرمز المختار (يصحّ سواء كانت المخرجات لوغاريتم احتمالات أو قيماً خاماً)
    }
    prev = k;
  }
  return { ph, probs };
}

// كل مرحلة تُسمّى في رسالة الخطأ، كي نعرف أين تعثّر التحميل على جهاز المستخدم
const stage = (name, p) => p.catch((e) => { throw new Error(name + ': ' + ((e && e.message) || e)); });

async function load() {
  post({ type: 'progress', phase: 'runtime' });
  const [, bytes] = await Promise.all([stage('runtime', loadOrt()), stage('model', modelBytes(MODEL_URL))]);
  post({ type: 'progress', phase: 'start' });
  sess = await stage('session', ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
  await stage('features', loadFE());
  await stage('warmup', hear(new Float32Array(RATE))); // تحمية
  return { device: 'wasm', model: 'Hisnlabs/tajweed-v2', threads: ort.env.wasm.numThreads };
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    try {
      loading = loading || load();
      post({ type: 'ready', ...(await loading) });
    } catch (err) {
      loading = null;
      post({ type: 'fail', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'run') {
    chain = chain.then(async () => {
      try {
        const t0 = Date.now();
        const r = await hear(m.audio);
        post({ type: 'result', id: m.id, ph: r.ph, probs: r.probs, ms: Date.now() - t0 });
      } catch (err) {
        post({ type: 'error', id: m.id, message: String((err && err.message) || err) });
      }
    });
  }
};
