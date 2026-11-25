/*
 * asr.js — التعرّف على التلاوة بنموذج ترتيل (tarteel-ai/whisper-base-ar-quran)
 *  - التقاط الصوت من الميكروفون وتحويله إلى 16 كيلوهرتز
 *  - تقطيعه عند وقفات القارئ (كشف الصوت من الصمت)
 *  - محرّكان: داخل الجهاز (transformers.js في Web Worker) أو خادم خارجي
 * الواجهة نفسها التي يستعملها التطبيق مع تعرّف المتصفح: start() / stop() / onFinal / onPartial / onState / onError
 */
(function (root) {
  'use strict';
  const RATE = 16000;
  const FRAME = 480; // 30 ms
  const DEFAULT_MODEL = 'iqbalaesthetic/Basira';

  const WORKLET = `class TasmeeTap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor('tasmee-tap', TasmeeTap);`;

  function concat(frames) {
    let n = 0;
    for (const f of frames) n += f.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }

  /* ---------- التقاط الصوت وتقطيعه ---------- */
  class Segmenter {
    constructor(o) {
      this.onSegment = o.onSegment || (() => {});
      this.onPartial = o.onPartial || (() => {});
      this.onLevel = o.onLevel || (() => {});
      // إطارات الصمت التي تُنهي العبارة، وكل كم إطاراً نعرض معاينة (الإطار ٣٠ م.ث)
      this.endFrames = o.endFrames || 17;
      this.previewEvery = o.previewEvery || 50;
      this.seq = 0;
      this.reset();
    }
    reset() {
      this.state = 'idle';
      this.pre = []; this.seg = []; this.lv = [];
      this.run = 0; this.voiced = 0; this.silence = 0; this.sinceP = 0;
    }
    async start(ctx) {
      this.ctx = ctx;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ratio = ctx.sampleRate / RATE;
      this.rpos = 0; this.rtail = null;
      this.pend = new Float32Array(0);
      this.noise = null;
      this.src = ctx.createMediaStreamSource(this.stream);
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(ctx.destination);
      if (ctx.audioWorklet && root.AudioWorkletNode) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        this.node = new AudioWorkletNode(ctx, 'tasmee-tap');
        this.node.port.onmessage = (e) => this.push(e.data);
      } else {
        this.node = ctx.createScriptProcessor(4096, 1, 1);
        this.node.onaudioprocess = (e) => this.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      this.src.connect(this.node);
      this.node.connect(this.sink);
    }
    stop() {
      try { this.src && this.src.disconnect(); } catch (e) { /* ignore */ }
      try { this.node && this.node.disconnect(); } catch (e) { /* ignore */ }
      if (this.node && this.node.port) this.node.port.onmessage = null;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.src = this.node = this.stream = null;
    }
    resample(x) {
      if (Math.abs(this.ratio - 1) < 1e-6) return x;
      const buf = this.rtail ? concat([this.rtail, x]) : x;
      const out = [];
      const step = this.ratio;
      const half = step > 1.5 ? Math.floor(step / 2) : 0; // متوسط نافذة بسيط يقلّل التشوّه عند خفض المعدّل
      const keep = 1 + 2 * half;
      let pos = this.rpos;
      while (pos + 1 + half < buf.length) {
        const i = Math.floor(pos);
        if (half) {
          let sum = 0, n = 0;
          for (let k = i - half; k <= i + half; k++) if (k >= 0) { sum += buf[k]; n++; }
          out.push(sum / n);
        } else {
          const f = pos - i;
          out.push(buf[i] * (1 - f) + buf[i + 1] * f);
        }
        pos += step;
      }
      const cut = Math.max(0, buf.length - keep);
      this.rpos = pos - cut;
      this.rtail = buf.slice(cut);
      return Float32Array.from(out);
    }
    push(chunk) {
      const x = this.resample(chunk);
      const all = this.pend.length ? concat([this.pend, x]) : x;
      let o = 0;
      while (all.length - o >= FRAME) { this.frame(all.slice(o, o + FRAME)); o += FRAME; }
      this.pend = all.slice(o);
    }
    frame(f) {
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      const rms = Math.sqrt(s / f.length);
      if (this.noise === null) this.noise = Math.min(rms, 0.01);
      else if (rms < this.noise) this.noise = this.noise * 0.85 + rms * 0.15;
      else this.noise = Math.min(0.05, this.noise * (this.state === 'idle' ? 0.995 : 0.9995) + rms * (this.state === 'idle' ? 0.005 : 0.0005));
      const thr = Math.max(this.noise * 3, 0.008);
      const speech = rms > thr;
      this.onLevel(Math.min(1, rms / (thr * 4)));

      if (this.state === 'idle') {
        this.pre.push(f);
        if (this.pre.length > 13) this.pre.shift();
        this.run = speech ? this.run + 1 : 0;
        if (this.run >= 3) {
          this.state = 'speech';
          this.seq++;
          this.seg = this.pre.slice();
          this.lv = this.seg.map(() => thr);
          this.pre = [];
          this.voiced = this.run; this.silence = 0; this.sinceP = 0;
        }
        return;
      }
      this.seg.push(f); this.lv.push(rms);
      if (speech) { this.silence = 0; this.voiced++; } else this.silence++;
      if (this.silence >= this.endFrames) { this.end(); return; } // صمت قصير = نهاية عبارة
      if (this.seg.length >= 334) { this.cut(); return; }        // ~10 ث حدّ أقصى
      if (++this.sinceP >= this.previewEvery && this.voiced >= 15) { // معاينة أثناء القراءة
        this.sinceP = 0;
        this.onPartial(concat(this.seg), this.seq);
      }
    }
    end() {
      const keep = Math.max(0, this.seg.length - Math.max(0, this.silence - 8));
      const audio = concat(this.seg.slice(0, keep));
      const ok = this.voiced >= 10;
      const seq = this.seq;
      this.reset();
      if (ok) this.onSegment(audio, seq);
    }
    cut() {
      // اقطع عند أهدأ إطار في آخر ثانيتين كي لا تنقسم كلمة
      const from = Math.max(1, this.seg.length - 67);
      let k = this.seg.length - 1;
      for (let i = from; i < this.seg.length; i++) if (this.lv[i] < this.lv[k]) k = i;
      const audio = concat(this.seg.slice(0, k));
      const seq = this.seq;
      this.seg = this.seg.slice(k); this.lv = this.lv.slice(k);
      this.seq++;
      this.voiced = 0; this.sinceP = 0;
      this.onSegment(audio, seq);
    }
    flush() {
      if (this.state === 'speech' && this.voiced >= 10) this.end();
      else this.reset();
    }
  }

  /* ---------- ترميز WAV (للخادم) ---------- */
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  const err = (code, msg) => Object.assign(new Error(msg || code), { code });
  const AR = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  const fmtMB = (b) => AR((b / 1048576).toFixed(0));

  /* ---------- المحرّك داخل الجهاز ---------- */
  const LocalEngine = {
    worker: null, ready: false, loading: null, info: null, fast: false,
    pending: new Map(), id: 0, listeners: new Set(), model: DEFAULT_MODEL, lib: null,
    ensure(onStatus) {
      if (this.ready) return Promise.resolve(this.info);
      if (onStatus) this.listeners.add(onStatus);
      if (!this.loading) {
        // نطلب من المتصفح ألا يحذف النموذج المحفوظ عند امتلاء الذاكرة
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ }
        this.loading = new Promise((res, rej) => {
          let w;
          try {
            w = new Worker(new URL('js/asr-worker.js', root.location.href), { type: 'module' });
          } catch (e) { rej(err('engine-unsupported')); return; }
          this.worker = w;
          this.emit('جارٍ تجهيز نموذج ترتيل…');
          w.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') {
              if (!m.net) this.emit('جارٍ تشغيل نموذج ترتيل المحفوظ على جهازك…');
              else if (m.total > 0) this.emit(`جارٍ تحميل نموذج ترتيل… ${AR(Math.min(99, Math.round((m.loaded / m.total) * 100)))}٪ (${fmtMB(m.loaded)} من ${fmtMB(m.total)} م.ب) · يُستكمل من حيث توقف إن خرجت`);
            } else if (m.type === 'ready') {
              this.ready = true; this.info = m; this.fast = m.device === 'webgpu';
              this.emit('');
              res(m);
            } else if (m.type === 'fail') {
              rej(err('engine-load', m.message));
            } else if (m.type === 'result' || m.type === 'error') {
              const p = this.pending.get(m.id);
              if (!p) return;
              this.pending.delete(m.id);
              if (m.type === 'result') p.res(m.text || ''); else p.rej(err('engine-run', m.message));
            }
          };
          w.onerror = (e) => { rej(err('engine-load', e.message)); };
          w.postMessage({ type: 'load', model: this.model, lib: this.lib || undefined });
        }).catch((e) => {
          this.loading = null;
          if (this.worker) { this.worker.terminate(); this.worker = null; }
          throw e;
        }).finally(() => { this.listeners.clear(); });
      }
      return this.loading;
    },
    emit(t) { for (const f of this.listeners) { try { f(t); } catch (e) { /* ignore */ } } },
    // حالة النموذج على الجهاز: 'saved' محفوظ كاملاً، 'partial' تحميل لم يكتمل، null لم يُحمَّل
    async stored() {
      try {
        if (!root.caches) return null;
        const id = '/' + this.model + '/';
        const has = async (name, test) => (await caches.has(name)) && (await (await caches.open(name)).keys()).some((r) => r.url.includes(id) && test(r.url));
        const enc = await has('transformers-cache', (u) => /encoder_model[^/]*\.onnx$/.test(u));
        const dec = enc && (await has('transformers-cache', (u) => /decoder_model[^/]*\.onnx$/.test(u)));
        if (enc && dec) return 'saved';
        if (await has('tasmee-partial', () => true)) return 'partial';
      } catch (e) { /* ignore */ }
      return null;
    },
    transcribe(audio) {
      if (!this.ready) return Promise.reject(err('engine-load'));
      return new Promise((res, rej) => {
        const id = ++this.id;
        this.pending.set(id, { res, rej });
        this.worker.postMessage({ type: 'run', id, audio }, [audio.buffer]);
      });
    },
    reset() {
      if (this.worker) this.worker.terminate();
      this.worker = null; this.ready = false; this.loading = null; this.info = null; this.fast = false;
      for (const p of this.pending.values()) p.rej(err('engine-run'));
      this.pending.clear();
    },
  };

  /* ---------- المحرّك على خادم ---------- */
  const ServerEngine = {
    url: '', fast: true,
    base() { return String(this.url || '').trim().replace(/\/+$/, ''); },
    async ensure() { if (!/^https?:\/\//i.test(this.base())) throw err('no-server'); },
    async health() {
      const r = await fetch(this.base() + '/health', { cache: 'no-store' });
      if (!r.ok) throw err('server', 'HTTP ' + r.status);
      return r.json();
    },
    async transcribe(audio, opt) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 45000);
      try {
        const r = await fetch(this.base() + '/transcribe?final=' + (opt && opt.final === false ? '0' : '1'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(audio, RATE), signal: ctl.signal });
        if (!r.ok) throw err('server', 'HTTP ' + r.status);
        const j = await r.json();
        return j.text || '';
      } catch (e) { throw e.code ? e : err('server', e.message); } finally { clearTimeout(t); }
    },
  };

  /* ---------- محرّك «المعلّم»: نموذج HisnLabs Tajweed v2 على الجهاز (تجريبي) ----------
   * لا يكتب كلمات بل يسمع الأصوات، فيحكم على كل كلمة بمقارنتها بالمرجع الصوتي للآيات (js/phonetic.js).
   * أسرع بكثير من Whisper: يسمع المقطع دفعة واحدة، وحجمه ٢٣ م.ب. */
  const CTC_MODEL_URL = 'https://huggingface.co/HisnLabs/tajweed-v2/resolve/main/onnx/model-int8.onnx';
  const CTC_DATA_URL = 'data/quran-ph.txt?v=1';
  const CtcEngine = {
    worker: null, ready: false, loading: null, info: null, fast: true, ref: null,
    pending: new Map(), id: 0, listeners: new Set(),
    async loadRef() {
      if (this.ref) return this.ref;
      const url = new URL(CTC_DATA_URL, root.location.href).href;
      let r = null, store = null;
      try { store = await caches.open('tasmee-models'); r = await store.match(url); } catch (e) { /* ignore */ }
      if (!r) {
        r = await fetch(url);
        if (!r.ok) throw err('ctc-load', 'HTTP ' + r.status);
        if (store) store.put(url, r.clone()).catch(() => {});
      }
      const ref = new root.Phonetic.Ref(await r.text());
      if (!ref.ok) throw err('ctc-load', 'bad reference data');
      this.ref = ref;
      return ref;
    },
    ensure(onStatus) {
      if (this.ready) return Promise.resolve(this.info);
      if (onStatus) this.listeners.add(onStatus);
      if (!this.loading) {
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ }
        const model = new Promise((res, rej) => {
          let w;
          try {
            w = new Worker(new URL('js/ctc-worker.js', root.location.href), { type: 'module' });
          } catch (e) { rej(err('engine-unsupported')); return; }
          this.worker = w;
          this.emit('جارٍ تجهيز «المعلّم»…');
          w.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') {
              if (m.phase === 'open') this.emit('جارٍ تشغيل «المعلّم» المحفوظ على جهازك…');
              else if (m.phase === 'start') this.emit('جارٍ تشغيل «المعلّم»…');
              else if (m.phase === 'model' && m.total > 0) this.emit(`جارٍ تحميل «المعلّم»… ${AR(Math.min(99, Math.round((m.loaded / m.total) * 100)))}٪ (${fmtMB(m.loaded)} من ${fmtMB(m.total)} م.ب) · يُستكمل من حيث توقف إن خرجت`);
            } else if (m.type === 'ready') res(m);
            else if (m.type === 'fail') rej(err('ctc-load', m.message));
            else if (m.type === 'result' || m.type === 'error') {
              const p = this.pending.get(m.id);
              if (!p) return;
              this.pending.delete(m.id);
              if (m.type === 'result') p.res(m); else p.rej(err('engine-run', m.message));
            }
          };
          w.onerror = (e) => { rej(err('ctc-load', e.message)); };
          w.postMessage({ type: 'load' });
        });
        this.loading = Promise.all([this.loadRef(), model]).then(([, info]) => {
          this.ready = true; this.info = info;
          this.emit('');
          return info;
        }).catch((e) => {
          this.loading = null;
          if (this.worker) { this.worker.terminate(); this.worker = null; }
          throw e && e.code ? e : err('ctc-load', e && e.message);
        }).finally(() => { this.listeners.clear(); });
      }
      return this.loading;
    },
    emit(t) { for (const f of this.listeners) { try { f(t); } catch (e) { /* ignore */ } } },
    /** يعيد حكماً على الكلمات {judged, pos, text, preview} إن أُعطي سياق القارئ، وإلا نصاً تقريبياً */
    async transcribe(audio, opt) {
      if (!this.ready) throw err('ctc-load');
      const r = await new Promise((res, rej) => {
        const id = ++this.id;
        this.pending.set(id, { res, rej });
        this.worker.postMessage({ type: 'run', id, audio }, [audio.buffer]);
      });
      const P = root.Phonetic;
      const gs = P.groups(r.ph, r.probs);
      const ctx = opt && opt.ctx;
      if (!ctx || !ctx.ayahs || !ctx.ayahs.length) return P.roughText(gs);
      return P.judge(this.ref, gs, ctx) || { judged: [], pos: ctx.pos, text: '', preview: [] };
    },
    async stored() {
      try {
        if (!root.caches) return null;
        if ((await caches.has('tasmee-models')) && (await (await caches.open('tasmee-models')).match(CTC_MODEL_URL))) return 'saved';
        if ((await caches.has('tasmee-partial')) && (await (await caches.open('tasmee-partial')).keys()).some((q) => q.url.includes('tajweed-v2'))) return 'partial';
      } catch (e) { /* ignore */ }
      return null;
    },
    reset() {
      if (this.worker) this.worker.terminate();
      this.worker = null; this.ready = false; this.loading = null; this.info = null;
      for (const p of this.pending.values()) p.rej(err('engine-run'));
      this.pending.clear();
    },
  };

  const tidy = (t) => String(t || '').replace(/[[(][^\])]*[\])]/g, ' ').replace(/\s+/g, ' ').trim();

  /* ---------- مستمع بنفس واجهة تعرّف المتصفح ---------- */
  class ModelListener {
    constructor(o) {
      Object.assign(this, { onFinal() {}, onPartial() {}, onState() {}, onError() {}, onStatus() {} }, o);
      this.active = false; this.queue = []; this.busy = false; this.drainers = []; this.segm = null; this.ctx = null;
    }
    start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.onError('audio-capture'); this.onState('idle'); return false; }
      this.active = true;
      const AC = root.AudioContext || root.webkitAudioContext;
      try { this.ctx = new AC({ sampleRate: RATE }); } catch (e) { this.ctx = new AC(); }
      this.onState('loading');
      (async () => {
        try {
          await this.engine.ensure((t) => { if (this.active) this.onStatus(t); });
          if (!this.active) return;
          // المحرّك السريع (WebGPU أو الخادم): نصحّح بعد ~٠٫٣٥ ث من الوقفة ونعرض معاينة كل ~ثانية.
          // البطيء (WASM): ننتظر ~٠٫٥ ث كي لا تتكدّس المقاطع القصيرة في طابور المعالجة.
          const fast = !!this.engine.fast;
          this.segm = new Segmenter({
            endFrames: fast ? 12 : 17,
            previewEvery: fast ? 33 : 50,
            onSegment: (a, seq) => this.job(a, true, seq),
            onPartial: (a, seq) => this.partial(a, seq),
          });
          try { await this.segm.start(this.ctx); } catch (e) {
            // بعض المتصفحات ترفض ربط الميكروفون بسياق 16 ك.هرتز؛ نعيد بالمعدّل الافتراضي
            if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError')) throw e;
            try { this.ctx.close(); } catch (x) { /* ignore */ }
            this.ctx = new AC();
            this.segm.stop();
            await this.segm.start(this.ctx);
          }
          if (!this.active) { this.close(); return; }
          this.onStatus('');
          this.onState('listening');
        } catch (e) {
          const code = (e && e.code) || (e && e.name === 'NotAllowedError' ? 'not-allowed' : e && e.name === 'NotFoundError' ? 'audio-capture' : 'engine-load');
          const was = this.active;
          this.active = false;
          this.close();
          if (was) this.onError(code);
          this.onState('idle');
        }
      })();
      return true;
    }
    job(audio, final, seq) { this.queue.push({ audio, final, seq }); this.pump(); }
    partial(audio, seq) { if (this.engine.fast && !this.busy && !this.queue.length) this.job(audio, false, seq); }
    async pump() {
      if (this.busy) return;
      const j = this.queue.shift();
      if (!j) { this.checkDrain(); return; }
      if (!j.final && (this.queue.length || !this.segm || j.seq !== this.segm.seq)) { this.pump(); return; }
      this.busy = true;
      try {
        if (j.final) this.onStatus('⏳ أصحّح ما قرأت…');
        // سياق القارئ (الكلمات وموضعه) يُقرأ لحظة المعالجة، بعد اعتماد ما قبله
        const ctx = typeof this.context === 'function' ? this.context() : null;
        const out = await this.engine.transcribe(j.audio, { final: j.final, ctx });
        if (out && typeof out === 'object') {
          // حكم جاهز على الكلمات (محرّك «المعلّم»)
          if (j.final) {
            this.onPartial('');
            if (out.judged && out.judged.length) this.onFinal(out);
            else if (this.active) this.onStatus(out.text ? 'لم أتبيّن موضع قراءتك. تابع من حيث توقفت' : 'أستمع إليك…');
          } else if (this.active && out.preview) this.onPartial(out);
        } else {
          const text = tidy(out);
          if (j.final && !text && this.active) this.onStatus('أستمع إليك…');
          if (j.final) { this.onPartial(''); if (text) this.onFinal(text); } else if (this.active && text) this.onPartial(text);
        }
      } catch (e) {
        if (j.final) this.onError((e && e.code) || 'engine-run');
      }
      this.busy = false;
      this.pump();
    }
    checkDrain() {
      if (this.busy || this.queue.length) return;
      const d = this.drainers; this.drainers = [];
      d.forEach((f) => f());
    }
    close() {
      if (this.segm) { try { this.segm.stop(); } catch (e) { /* ignore */ } }
      if (this.ctx) { try { this.ctx.close(); } catch (e) { /* ignore */ } }
      this.segm = null; this.ctx = null;
    }
    stop() {
      if (this.segm && this.active) this.segm.flush();
      this.active = false;
      this.close();
      this.queue = this.queue.filter((j) => j.final);
      this.onState('idle');
      return new Promise((res) => { this.drainers.push(res); this.checkDrain(); setTimeout(res, 20000); });
    }
  }

  root.ASR = { Segmenter, ModelListener, LocalEngine, ServerEngine, CtcEngine, encodeWav, DEFAULT_MODEL, RATE };
})(window);
