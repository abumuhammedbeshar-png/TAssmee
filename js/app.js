/* تسميع — التطبيق الرئيسي */
(() => {
  'use strict';
  const M = window.Matcher;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const AR = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const BUILD = 10; // رقم إصدار التطبيق، يظهر في الإعدادات
  const API = 'https://api.alquran.cloud/v1';
  const AUDIO = (ed, n) => `https://cdn.islamic.network/quran/audio/128/${ed}/${n}.mp3`;
  const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const RECITERS = [
    ['ar.alafasy', 'مشاري العفاسي'], ['ar.husary', 'محمود خليل الحصري'], ['ar.minshawi', 'محمد صديق المنشاوي'],
    ['ar.abdulbasitmurattal', 'عبد الباسط عبد الصمد (مرتّل)'], ['ar.mahermuaiqly', 'ماهر المعيقلي'],
    ['ar.abdurrahmaansudais', 'عبد الرحمن السديس'], ['ar.saoodshuraym', 'سعود الشريم'],
  ];
  const DIALECTS = [['ar-SA', 'العربية (السعودية)'], ['ar-EG', 'العربية (مصر)'], ['ar-AE', 'العربية (الإمارات)'], ['ar-JO', 'العربية (الأردن)'], ['ar-MA', 'العربية (المغرب)']];

  /* ================= الإعدادات ================= */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tasmee:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tasmee:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const DEF = { strict: 'mid', font: 28, reciter: 'ar.alafasy', lang: 'ar-SA', goal: 150, hidden: false, theme: 'auto', engine: 'auto', server: '', model: window.ASR.DEFAULT_MODEL, modelOk: false };
  const STORED = store.get('settings', {});
  const S = Object.assign({}, DEF, STORED);
  // من كان على «ترتيل · الجهاز» افتراضياً (دون أن يختاره بنفسه) ينتقل إلى «تلقائي»
  if (!STORED.engineChosen && (!STORED.engine || STORED.engine === 'local')) S.engine = 'auto';
  function saveSettings() { store.set('settings', S); applySettings(); }
  function applySettings() {
    const r = document.documentElement;
    if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
    r.style.setProperty('--fs', S.font + 'px');
    const hero = getComputedStyle(r).getPropertyValue('--hero').trim();
    if (hero) $('meta[name=theme-color]').setAttribute('content', hero);
    if (R.sess) R.sess.setStrictness(effStrict(R.kind));
    syncEngines();
  }
  function syncEngines() {
    const A = window.ASR;
    A.ServerEngine.url = S.server;
    const model = (S.model || '').trim() || A.DEFAULT_MODEL;
    if (A.LocalEngine.model !== model) {
      if (A.LocalEngine.ready || A.LocalEngine.loading) A.LocalEngine.reset();
      A.LocalEngine.model = model;
    }
  }

  /* ================= التخزين (IndexedDB مع بديل في الذاكرة) ================= */
  const DB = (() => {
    const mem = {};
    const ms = (s) => (mem[s] = mem[s] || new Map());
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          if (!window.indexedDB) return rej(new Error('no-idb'));
          const r = indexedDB.open('tasmee', 1);
          r.onupgradeneeded = () => { for (const s of ['kv', 'books', 'pdfs', 'sessions']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return dbp;
    }
    async function run(s, mode, fn) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(s, mode);
        const q = fn(t.objectStore(s));
        t.oncomplete = () => res(q.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      async get(s, k) { try { return await run(s, 'readonly', (o) => o.get(k)); } catch (e) { return ms(s).get(k); } },
      async put(s, k, v) { try { await run(s, 'readwrite', (o) => o.put(v, k)); } catch (e) { ms(s).set(k, v); } },
      async del(s, k) { try { await run(s, 'readwrite', (o) => o.delete(k)); } catch (e) { ms(s).delete(k); } },
      async all(s) { try { return await run(s, 'readonly', (o) => o.getAll()); } catch (e) { return Array.from(ms(s).values()); } },
      async clear(s) { try { await run(s, 'readwrite', (o) => o.clear()); } catch (e) { ms(s).clear(); } },
    };
  })();

  /* ================= بيانات القرآن ================= */
  const BASM = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
  let SURAHS = [];
  let QIDX = null;

  async function fetchJSON(url, onProg) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!onProg || !r.body || !r.body.getReader) return r.json();
    const rd = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      chunks.push(value); got += value.length; onProg(got);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  function splitBasmala(text) {
    const parts = text.split(/\s+/);
    let seen = 0, i = 0;
    while (i < parts.length && seen < 4) {
      const n = M.norm(parts[i]);
      if (n) { if (n !== BASM[seen]) return null; seen++; }
      i++;
    }
    while (i < parts.length && !M.norm(parts[i])) i++;
    return seen === 4 && i < parts.length ? { basmala: parts.slice(0, i).join(' '), rest: parts.slice(i).join(' ') } : null;
  }
  function cleanSurah(s) {
    let basmala = '';
    const ayahs = s.ayahs.map((a, i) => {
      let text = a.text;
      if (i === 0 && s.number !== 1 && s.number !== 9) {
        const b = splitBasmala(text);
        if (b) { basmala = b.basmala; text = b.rest; }
      }
      return { k: a.numberInSurah, g: a.number, text };
    });
    return { n: s.number, name: s.name, basmala, ayahs };
  }
  async function surahList() {
    let l = await DB.get('kv', 'surahs');
    if (l && l.length) return l;
    const j = await fetchJSON(`${API}/surah`);
    l = j.data.map((s) => ({ n: s.number, name: s.name, en: s.englishName, ayahs: s.numberOfAyahs, type: s.revelationType }));
    await DB.put('kv', 'surahs', l);
    return l;
  }
  async function getSurah(n) {
    let s = await DB.get('kv', 'surah:' + n);
    if (s) return s;
    const j = await fetchJSON(`${API}/surah/${n}/quran-simple`);
    s = cleanSurah(j.data);
    await DB.put('kv', 'surah:' + n, s);
    return s;
  }
  async function quranIndex(onProg) {
    if (QIDX) return QIDX;
    let full = await DB.get('kv', 'quran');
    if (!full) {
      const j = await fetchJSON(`${API}/quran/quran-simple`, onProg);
      full = j.data.surahs.map(cleanSurah);
      await DB.put('kv', 'quran', full);
      for (const s of full) DB.put('kv', 'surah:' + s.n, s);
    }
    QIDX = [];
    for (const s of full) for (const a of s.ayahs) QIDX.push({ s: s.n, name: s.name, k: a.k, text: a.text, w: M.words(a.text) });
    return QIDX;
  }
  function lcs(A, B) {
    const n = B.length;
    let prev = new Uint16Array(n + 1), cur = new Uint16Array(n + 1);
    for (let i = 1; i <= A.length; i++) {
      const a = A[i - 1];
      for (let j = 1; j <= n; j++) {
        const b = B[j - 1];
        const eq = a === b || (Math.abs(a.length - b.length) <= 2 && M.sim(a, b) >= 0.8);
        cur[j] = eq ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
      cur.fill(0);
    }
    return prev[n];
  }
  function searchQuran(q) {
    const Q = M.words(q).slice(0, 20);
    if (!Q.length || !QIDX) return [];
    const need = Math.max(1, Math.ceil(Q.length * 0.6));
    const res = [];
    for (const a of QIDX) {
      const sc = lcs(Q, a.w);
      if (sc >= need) res.push({ a, sc: sc / Q.length - a.w.length * 0.0004 });
    }
    res.sort((x, y) => y.sc - x.sc);
    return res.slice(0, 8);
  }
  const shortName = (name) => String(name || '').replace(/^سُورَةُ\s+/, '');
  const typeAr = (t) => (t === 'Meccan' ? 'مكية' : 'مدنية');

  /* ================= واجهة عامة ================= */
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    const dock = !$('#reader').hidden ? $('#reader .dock') : $('#bookview').hidden ? $('.tabbar') : null;
    t.style.bottom = (dock ? dock.offsetHeight + 14 : 24) + 'px';
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), ms || 2600);
  }
  let sheetOnClose = null;
  function openSheet(html, onClose) {
    if (!$('#sheet').hidden) closeSheet();
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    sheetOnClose = onClose || null;
    return $('#sheet-body');
  }
  function closeSheet() {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true;
    $('#sheet-body').innerHTML = '';
    const f = sheetOnClose; sheetOnClose = null;
    if (f) f();
  }
  function ringSVG(pct, color, track) {
    const size = 120, sw = 10, r = (size - sw) / 2, c = 2 * Math.PI * r;
    const off = c * (1 - clamp(pct, 0, 100) / 100);
    return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="60" cy="60" r="${r}" fill="none" stroke="${track}" stroke-width="${sw}"/>` +
      `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
  }
  const fmtDur = (s) => AR(Math.floor(s / 60)) + ':' + AR(String(s % 60).padStart(2, '0'));
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms || 50); } catch (e) { /* ignore */ } };

  function go(tab) {
    $$('.tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
    $$('.tabbar button').forEach((b) => { if (b.dataset.go === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (tab === 'books') renderBooks();
    if (tab === 'progress') renderProgress();
    window.scrollTo(0, 0);
  }

  // زر الرجوع في الجوال يغلق الشاشة المفتوحة بدل الخروج من التطبيق
  let navDepth = 0;
  const topOpen = () => !$('#reader').hidden || !$('#bookview').hidden || !$('#admin').hidden;
  function pushNav() { try { history.pushState({ d: ++navDepth }, ''); } catch (e) { /* ignore */ } }
  function navBack() { if (navDepth > 0) history.back(); else closeTop(); }
  function closeTop() { if (!$('#reader').hidden) closeReader(); else if (!$('#admin').hidden) closeAdmin(); else if (!$('#bookview').hidden) closeBook(); }
  window.addEventListener('popstate', () => {
    if (!$('#sheet').hidden) { closeSheet(); if (topOpen()) { try { history.pushState({ d: navDepth }, ''); } catch (e) { /* ignore */ } } return; }
    navDepth = Math.max(0, navDepth - 1);
    closeTop();
  });

  /* ================= التعرّف على الكلام ================= */
  class Listener {
    constructor(o) { Object.assign(this, o); this.active = false; this.rec = null; this.starts = []; }
    start() {
      if (!SR) return false;
      this.active = true;
      this._spawn();
      return true;
    }
    _spawn() {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < 8000);
      this.starts.push(now);
      if (this.starts.length > 12) { this.active = false; this.onError('loop'); this.onState('idle'); return; }
      const r = new SR();
      r.lang = this.lang;
      r.interimResults = true;
      r.continuous = !IS_ANDROID; // أندرويد يكرّر النص في الوضع المستمر، فنعيد التشغيل بعد كل عبارة
      r.maxAlternatives = 1;
      const done = new Set();
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const tx = res[0] ? res[0].transcript : '';
          if (res.isFinal) { if (!done.has(i)) { done.add(i); this.onFinal(tx, res[0] ? res[0].confidence : undefined); } } else interim += tx + ' ';
        }
        this.onPartial(interim.trim());
      };
      r.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        this.active = false;
        this.onError(e.error);
      };
      r.onend = () => {
        if (this.rec !== r) return;
        if (this.active) setTimeout(() => { if (this.active && this.rec === r) this._spawn(); }, 60);
        else { this.rec = null; this.onState('idle'); }
      };
      this.rec = r;
      try { r.start(); this.onState('listening'); } catch (err) { this.active = false; this.rec = null; this.onError('start'); this.onState('idle'); }
    }
    stop() {
      this.active = false;
      return new Promise((res) => {
        if (!this.rec) { this.onState('idle'); res(); return; }
        const t = setTimeout(res, 1500);
        const prev = this.onState;
        this.onState = (st) => { prev(st); if (st === 'idle') { clearTimeout(t); res(); } };
        try { this.rec.stop(); } catch (e) { this.rec = null; this.onState('idle'); }
      });
    }
  }
  const MIC_ERR = {
    'not-allowed': 'لم يُسمح باستخدام الميكروفون. فعّل الإذن لهذا الموقع من إعدادات المتصفح.',
    'service-not-allowed': 'خدمة التعرّف على الصوت غير متاحة. جرّب متصفح Chrome.',
    'audio-capture': 'لم يُعثر على ميكروفون يعمل.',
    network: 'التعرّف على الصوت يحتاج اتصالاً بالإنترنت.',
    'language-not-supported': 'هذه اللغة غير مدعومة للتعرّف على الصوت في متصفحك.',
    loop: 'توقّف الاستماع. اضغط الميكروفون للمتابعة.',
    start: 'تعذّر تشغيل الميكروفون. أعد المحاولة.',
    'engine-load': 'تعذّر تحميل نموذج ترتيل. تحقّق من اتصالك بالإنترنت، أو اختر محرّكاً آخر من الإعدادات.',
    'engine-run': 'تعذّر التعرّف على هذا المقطع. تابع القراءة.',
    'engine-unsupported': 'متصفحك لا يدعم تشغيل النموذج على الجهاز. اختر «خادم» أو «المتصفح» من الإعدادات.',
    'no-server': 'أدخل رابط خادم التعرّف من الإعدادات أولاً.',
    'ctc-load': 'تعذّر تحميل «المعلّم». تحقّق من اتصالك بالإنترنت، أو اختر محرّكاً آخر من الإعدادات.',
    server: 'تعذّر الوصول إلى خادم التعرّف. تأكد أن الخادم يعمل.',
  };
  const ENGINE_NAME = { browser: 'تعرّف المتصفح', local: 'نموذج ترتيل على جهازك', server: 'نموذج ترتيل على الخادم', ctc: '«المعلّم» على جهازك (تجريبي)' };
  // نموذج ترتيل مدرَّب على القرآن فقط، فالكتب تبقى على تعرّف المتصفح
  // «تلقائي»: نموذج ترتيل إن كان الجهاز يدعم WebGPU (سريع)، وإلا تعرّف المتصفح الفوري
  let GPU = false;
  try {
    if (navigator.gpu) navigator.gpu.requestAdapter().then((a) => { GPU = !!a; if ($('#eng-panel')) renderEngPanel(); }, () => {});
  } catch (e) { /* ignore */ }
  function autoEngine() {
    const L = window.ASR.LocalEngine;
    if (L.ready) return L.fast || !SR ? 'local' : 'browser';
    if (GPU) return 'local';
    return SR ? 'browser' : 'local';
  }
  // kind: 'quran' (تسميع سورة) · 'search' (البحث بالتلاوة) · غير ذلك (الكتب)
  const engineFor = (kind) => {
    if (kind !== 'quran' && kind !== 'search') return 'browser';
    let e = S.engine === 'auto' ? autoEngine() : S.engine;
    // «المعلّم» يقارن بما يجب أن يُقرأ، فلا يصلح للبحث عن آية مجهولة
    if (e === 'ctc' && kind === 'search') e = SR ? 'browser' : 'local';
    return ENGINE_NAME[e] ? e : 'browser';
  };
  const canListen = (kind) => (engineFor(kind) === 'browser' ? !!SR : !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  function makeListener(kind, h) {
    const e = engineFor(kind);
    if (e === 'browser') return SR ? new Listener(h) : null;
    const A = window.ASR;
    return new A.ModelListener(Object.assign({ engine: e === 'local' ? A.LocalEngine : e === 'ctc' ? A.CtcEngine : A.ServerEngine }, h));
  }
  // تعرّف المتصفح أقل دقة مع التلاوة، فنتساهل معه ما لم يختر المستخدم دقة بنفسه
  const effStrict = (kind) => (S.strictChosen ? S.strict : engineFor(kind) === 'browser' ? 'low' : S.strict);
  const needsConsent = (kind) => {
    const e = engineFor(kind);
    return (e === 'local' && !window.ASR.LocalEngine.ready && !S.modelOk) || (e === 'ctc' && !window.ASR.CtcEngine.ready && !S.ctcOk);
  };
  function askModelDownload(go, kind) {
    if (engineFor(kind || 'quran') === 'ctc' && !S.ctcOk) {
      openSheet(`<h3>تحميل «المعلّم» (تجريبي)</h3>
        <p>«المعلّم» نموذج يسمع تلاوتك ويقارنها بالآيات حرفاً حرفاً، فيصحّح بسرعة كبيرة حتى على الجوالات التي لا تدعم تسريع الرسوميات. سيُحمَّل إلى جهازك مرة واحدة: نحو ٢٣ م.ب للنموذج و١٠ م.ب لمحرّك التشغيل. يُستحسن الاتصال بشبكة Wi-Fi، وإن انقطع التحميل يُستكمل من حيث توقف.</p>
        <p class="note">بعد التحميل يعمل داخل جهازك حتى دون إنترنت، ولا يغادره صوتك. ما زال تجريبياً: إن رأيت تصحيحاً غير دقيق فأخبرنا، أو اختر محرّكاً آخر من الإعدادات.</p>
        <div class="row"><button class="btn primary" id="md-ok">حمّل وابدأ</button><button class="btn ghost" id="md-no">استخدم تعرّف المتصفح</button></div>`);
      $('#md-ok').onclick = () => { S.ctcOk = true; store.set('settings', S); closeSheet(); go(); };
      $('#md-no').onclick = () => { S.engine = 'browser'; saveSettings(); closeSheet(); go(); };
      return;
    }
    openSheet(`<h3>تحميل نموذج ترتيل</h3>
      <p>لتصحيح التلاوة بدقة أعلى سيُحمَّل نموذج ترتيل المفتوح (whisper-base-ar-quran) إلى جهازك مرة واحدة: نحو ${navigator.gpu ? '١٠٠–٢٠٠' : '١٠٠'} م.ب. يُستحسن الاتصال بشبكة Wi-Fi.</p>
      <p class="note">بعد التحميل يعمل التعرّف داخل جهازك حتى دون إنترنت، ولا يغادره صوتك.</p>
      <div class="row"><button class="btn primary" id="md-ok">حمّل وابدأ</button><button class="btn ghost" id="md-no">استخدم تعرّف المتصفح</button></div>`);
    $('#md-ok').onclick = () => { S.modelOk = true; store.set('settings', S); closeSheet(); go(); };
    $('#md-no').onclick = () => { S.engine = 'browser'; saveSettings(); closeSheet(); go(); };
  }
  function micError(code, detail) {
    // التفاصيل التقنية (مثل «model: HTTP 404») تساعد على معرفة سبب تعذّر التحميل
    const msg = (MIC_ERR[code] || 'حدث خطأ في الاستماع. أعد المحاولة.') + (detail && /load|unsupported/.test(code) ? ` (${detail})` : '');
    toast(msg, 7000);
    const h = $('#r-heard');
    if (h && !$('#reader').hidden) { h.textContent = msg; h.classList.remove('on'); }
  }

  /* ================= شاشة التسميع ================= */
  const R = { kind: null, ref: null, title: '', sub: '', words: [], sess: null, els: [], live: [], listener: null, t0: 0, sid: null, lang: 'ar-SA', log: '', audio: null, ayahs: [], extra: {}, prevCur: 0, wake: null };

  function buildText(blocks) {
    const words = [], html = [], ayahs = [];
    let wrap = '';
    const open = (c) => { if (wrap !== c) { if (wrap) html.push('</div>'); html.push(`<div class="${c}">`); wrap = c; } };
    const close = () => { if (wrap) html.push('</div>'); wrap = ''; };
    const W = (toks) => toks.map((t) => { const i = words.length; words.push(t); return `<span class="w" data-i="${i}">${esc(t.disp)}</span>`; }).join(' ');
    for (const b of blocks) {
      if (b.type === 'title') { close(); html.push(`<div class="stitle"><span>${esc(b.text)}</span></div>`); }
      else if (b.type === 'basmala') { close(); html.push(`<p class="basmala">${esc(b.text)}</p>`); }
      else if (b.type === 'ayah') {
        open('mushaf');
        ayahs.push({ start: words.length, k: b.k, g: b.g });
        html.push(W(b.toks) + ` <button class="am" data-k="${b.k}" data-g="${b.g}" aria-label="الآية ${b.k}">${AR(b.k)}</button> `);
      } else if (b.type === 'page') { open('bookflow'); html.push(`<div class="pgbreak">صفحة ${AR(b.page)}</div>`); }
      else if (b.type === 'para') { open('bookflow'); html.push(`<p class="para" dir="auto">${W(b.toks)}</p>`); }
    }
    close();
    return { words, html: html.join(''), ayahs };
  }

  function openReader(o) {
    stopListening(); stopAudio();
    const built = buildText(o.blocks);
    Object.assign(R, { kind: o.kind, ref: o.ref, title: o.title, sub: o.sub || '', lang: o.lang || 'ar-SA', t0: 0, sid: null, log: '', live: [], vcur: null, finished: false, extra: o.extra || {}, words: built.words, ayahs: built.ayahs });
    R.sess = new M.Session(built.words, { strictness: effStrict(o.kind) });
    const box = $('#r-text');
    box.innerHTML = `<div class="page" dir="${o.dir || 'rtl'}">${built.html}</div>`;
    R.els = [];
    for (const el of $$('.w', box)) R.els[+el.dataset.i] = el;
    $('#r-title').textContent = o.title;
    $('#r-sub').textContent = o.sub || '';
    if (o.restore && o.restore.st && o.restore.n === R.sess.N) {
      const rs = o.restore;
      R.sess.state = rs.st.split('').map((c) => CH2ST[c] || 'p');
      R.sess.pos = clamp(rs.pos | 0, 0, R.sess.N);
      R.sess.start = clamp(rs.start | 0, 0, R.sess.N);
      for (const k in rs.heard) R.sess.heard[+k] = rs.heard[k];
      R.sid = rs.sid || null;
      R.t0 = rs.el ? Date.now() - rs.el : 0;
    }
    let pos = o.restore ? 0 : o.pos || 0;
    if (o.ayah) { const a = R.ayahs.find((x) => x.k === o.ayah); if (a) pos = a.start; }
    if (pos) R.sess.setPos(pos);
    setHidden(S.hidden, true);
    $('#r-type').hidden = canListen(o.kind);
    const h = $('#r-heard');
    h.classList.remove('on');
    h.textContent = canListen(o.kind) ? `اضغط الميكروفون وابدأ القراءة من حفظك · ${ENGINE_NAME[engineFor(o.kind)]}` : 'متصفحك لا يدعم التعرّف على الصوت؛ استخدم Chrome، أو اكتب من حفظك';
    micState('idle');
    $('#reader').hidden = false;
    document.body.style.overflow = 'hidden';
    pushNav();
    paintAll(); updateStats();
    box.scrollTop = 0;
    requestAnimationFrame(() => scrollToCur(true));
  }

  function closeReader() {
    stopListening(); stopAudio();
    if (R.sess) saveResume({ done: !!R.finished });
    const saved = R.sess && R.sess.stats().judged ? saveSession() : Promise.resolve();
    $('#reader').hidden = true;
    if ($('#bookview').hidden) document.body.style.overflow = '';
    $('#r-text').innerHTML = '';
    R.els = []; R.sess = null; R.live = []; R.vcur = null;
    renderContinue();
    saved.then(refreshMemo, refreshMemo);
  }

  function paint(i) {
    const el = R.els[i];
    if (!el) return;
    const s = R.sess.state[i];
    el.className = 'w s-' + s + (i === (R.vcur != null ? R.vcur : R.sess.pos) ? ' cur' : '') + (R.live.includes(i) ? ' live' : '');
    if (s === 'err') el.title = R.sess.heard[i] ? 'سمعتُ: ' + R.sess.heard[i] : 'لم تُقرأ';
    else if (el.title) el.removeAttribute('title');
  }
  function paintAll() { for (let i = 0; i < R.els.length; i++) paint(i); R.prevCur = R.sess.pos; }
  function moveCur() { const p = R.prevCur; R.prevCur = R.sess.pos; paint(p); paint(R.sess.pos); }
  function setLive(idx) {
    const old = R.live, oldV = R.vcur;
    R.live = idx;
    // المؤشر يتقدّم مع الكلمات المسموعة لحظياً، قبل اعتمادها
    R.vcur = idx.length ? Math.max(...idx) + 1 : null;
    for (const i of old) paint(i);
    for (const i of idx) paint(i);
    if (oldV != null) paint(oldV);
    if (R.vcur != null) paint(R.vcur);
    paint(R.sess.pos);
    if (R.vcur != null && R.vcur !== oldV) scrollToCur();
  }
  function updateStats() {
    const st = R.sess.stats();
    $('#c-ok').textContent = AR(st.ok);
    $('#c-err').textContent = AR(st.err);
    $('#c-hint').textContent = AR(st.hint);
    $('#r-prog').style.width = (R.sess.N ? (R.sess.pos / R.sess.N) * 100 : 0) + '%';
  }
  function scrollToCur(instant) {
    if (!R.els.length) return;
    const el = R.els[Math.min(R.vcur != null ? R.vcur : R.sess.pos, R.els.length - 1)];
    const box = $('#r-text');
    const bb = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const bottom = window.innerHeight - $('#reader .dock').offsetHeight - 24;
    if (r.top < bb.top + 30 || r.bottom > bottom) {
      const target = box.scrollTop + (r.top - bb.top) - (bottom - bb.top) * 0.35;
      box.scrollTo({ top: Math.max(0, target), behavior: instant ? 'auto' : 'smooth' });
    }
  }
  function logHeard(text, final) {
    const h = $('#r-heard');
    if (final) R.log = (R.log + ' ' + text).trim().slice(-300);
    const show = (R.log + ' ' + (final ? '' : text)).trim();
    if (!show) return;
    h.textContent = show.length > 70 ? '… ' + show.slice(-70) : show;
    h.classList.add('on');
  }

  function onFinal(text, conf) {
    if (!R.sess || !text) return;
    // محرّك «المعلّم» يعيد حكماً جاهزاً على الكلمات بدل نصّ
    const judged = typeof text === 'object';
    logHeard(judged ? text.text || '' : text, true);
    setLive([]);
    const { changed, jumped } = judged ? R.sess.apply(text) : R.sess.feed(text, { conf });
    for (const i of changed) paint(i);
    moveCur(); updateStats(); saveResume();
    if (jumped) toast('تابعناك من الموضع الذي تقرأ منه');
    if (changed.some((i) => R.sess.state[i] === 'err')) buzz(70);
    scrollToCur();
    // لا ننهي تلقائياً إن وصلنا للنهاية بقفزة؛ قد يعود القارئ إلى ما تخطّاه
    if (R.sess.done && !jumped) { stopListening(); setTimeout(finish, 350); }
  }
  function onPartial(text) {
    if (!R.sess) return;
    if (text && typeof text === 'object') { if (text.text) logHeard(text.text, false); setLive(text.preview || []); return; }
    if (text) logHeard(text, false);
    setLive(text ? R.sess.preview(text) : []);
  }
  function micState(st) {
    const on = st === 'listening', busy = st === 'loading';
    const b = $('#r-mic');
    b.classList.toggle('on', on);
    b.classList.toggle('busy', busy);
    b.setAttribute('aria-label', on ? 'أوقف الاستماع' : busy ? 'إلغاء' : 'ابدأ التسميع');
    $('use', b).setAttribute('href', on || busy ? '#i-stop' : '#i-mic');
    if (on && !R.log) { const h = $('#r-heard'); h.textContent = engineFor(R.kind) === 'browser' ? 'أستمع إليك…' : 'أستمع إليك… يظهر التصحيح بعد كل وقفة قصيرة'; h.classList.remove('on'); }
    if (!on && R.live.length) setLive([]);
  }
  function startListening() {
    if (!R.sess) return;
    if (R.sess.done) { toast('أتممت النص. اضغط زر الإعادة لتبدأ من جديد'); return; }
    if (needsConsent(R.kind)) { askModelDownload(startListening, R.kind); return; }
    stopAudio();
    const L = makeListener(R.kind, {
      lang: R.lang, onFinal, onPartial, onError: micError,
      context: () => ({ words: R.words, ayahs: R.kind === 'quran' ? R.ayahs : [], pos: R.sess.pos, strict: effStrict(R.kind) }),
      onState: (st) => { if (R.listener === L || !R.listener) micState(st); },
      onStatus: (t) => { if (t && R.listener === L) { const h = $('#r-heard'); h.textContent = t; h.classList.remove('on'); } },
    });
    if (!L) {
      $('#r-type').hidden = false; $('#r-typein').focus();
      toast('التعرّف على الصوت غير متاح في هذا المتصفح. جرّب Chrome، أو اكتب من حفظك.', 4000);
      return;
    }
    R.listener = L;
    L.start();
    if (!R.t0) R.t0 = Date.now();
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { R.wake = w; }, () => {}); } catch (e) { /* ignore */ }
  }
  function stopListening() {
    const L = R.listener;
    R.listener = null;
    if (R.wake) { try { R.wake.release(); } catch (e) { /* ignore */ } R.wake = null; }
    return L ? Promise.resolve(L.stop()) : Promise.resolve();
  }

  function setHidden(v, silent) {
    S.hidden = !!v; store.set('settings', S);
    $('#r-text').classList.toggle('veil', S.hidden);
    const b = $('#r-hide');
    b.setAttribute('aria-pressed', String(S.hidden));
    b.setAttribute('aria-label', S.hidden ? 'إظهار النص' : 'إخفاء النص');
    $('use', b).setAttribute('href', S.hidden ? '#i-eyeoff' : '#i-eye');
    if (!silent) toast(S.hidden ? 'وضع الحفظ: النص مخفيّ ويظهر كلما قرأته' : 'النص ظاهر');
  }

  function hint() {
    if (!R.sess) return;
    const g = R.sess.hint();
    if (g < 0) return;
    paint(g); moveCur(); updateStats(); scrollToCur(); saveResume();
    if (R.sess.done) setTimeout(finish, 350);
  }
  function resetReader() {
    stopListening();
    R.sess.reset(R.sess.start);
    R.sid = null; R.t0 = 0; R.log = ''; R.live = []; R.vcur = null; R.finished = false;
    paintAll(); updateStats(); saveResume();
    const h = $('#r-heard'); h.classList.remove('on'); h.textContent = 'بدأنا من جديد. اضغط الميكروفون واقرأ';
    scrollToCur(true);
  }
  // حفظ الجلسة كاملة (حالة كل كلمة والموضع والمدة) كي تتابع من حيث توقفت بعد إغلاق التطبيق
  const ST2CH = { p: 'p', ok: 'o', err: 'e', skip: 's', hint: 'h' };
  const CH2ST = { p: 'p', o: 'ok', e: 'err', s: 'skip', h: 'hint' };
  function saveResume(extra) {
    if (!R.sess) return;
    const heard = {};
    R.sess.state.forEach((st, i) => { if (st === 'err' && R.sess.heard[i]) heard[i] = R.sess.heard[i]; });
    store.set('session', Object.assign({
      v: 1, kind: R.kind, ref: R.ref, title: R.title, sub: R.sub, lang: R.lang,
      from: R.extra.from, to: R.extra.to,
      pos: R.sess.pos, start: R.sess.start, n: R.sess.N,
      st: R.sess.state.map((x) => ST2CH[x] || 'p').join(''), heard,
      sid: R.sid, el: R.t0 ? Date.now() - R.t0 : 0, at: Date.now(), done: false,
    }, extra || {}));
  }
  function lastSession() {
    const r = store.get('session', null);
    if (r && r.title) return r;
    const old = store.get('resume', null); // توافق مع النسخة السابقة
    return old && old.title ? old : null;
  }
  function openFromState(r) {
    if (r.kind === 'quran') openSurah(r.ref, { pos: r.pos, restore: r });
    else openBookReader(r.ref, { from: r.from, to: r.to, pos: r.pos, restore: r });
  }
  let autoResumed = false;
  function maybeAutoResume() {
    if (autoResumed) return;
    autoResumed = true;
    const r = lastSession();
    if (!r || r.done || !r.st || !/[oesh]/.test(r.st)) return;
    if (Date.now() - (r.at || 0) > 12 * 3600 * 1000) return;
    openFromState(r);
    setTimeout(() => { if (!$('#reader').hidden) toast('تابعنا من حيث توقفت'); }, 600);
  }
  /** حفظ ما سُمّع قبل أن يُغلق التطبيق، كي لا يضيع التقدّم */
  function parkSession() {
    if (R.listener) stopListening();
    if (!R.sess) return;
    saveResume({ done: !!R.finished || R.sess.done });
    if (R.sess.stats().judged) saveSession();
  }
  async function saveSession() {
    if (!R.sess) return null;
    const st = R.sess.stats();
    if (!st.judged) return null;
    if (!R.sid) R.sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const rec = { id: R.sid, kind: R.kind, ref: R.ref, title: R.title, date: Date.now(), ok: st.ok, err: st.err, hint: st.hint, skip: st.skip, judged: st.judged, total: st.total, accuracy: st.accuracy, hidden: !!S.hidden, dur: R.t0 ? Math.round((Date.now() - R.t0) / 1000) : 0 };
    // نسخة فورية: الكتابة في قاعدة البيانات قد لا تكتمل إن أُغلق التطبيق الآن
    store.set('pending', rec);
    await DB.put('sessions', rec.id, rec);
    const p = store.get('pending', null);
    if (p && p.id === rec.id && p.judged <= rec.judged) store.set('pending', null);
    if (window.Cloud && Cloud.user) Cloud.logSession(rec).catch((e) => console.warn('sync', e));
    SESS = null;
    return rec;
  }
  /** جلسة لم تكتمل كتابتها قبل إغلاق التطبيق: نحفظها عند التشغيل التالي */
  async function flushPending() {
    const rec = store.get('pending', null);
    if (!rec || !rec.id) return;
    try {
      const cur = await DB.get('sessions', rec.id);
      if (!cur || (cur.judged || 0) < rec.judged) {
        await DB.put('sessions', rec.id, rec);
        if (window.Cloud && Cloud.user) Cloud.logSession(rec).catch(() => {});
      }
      SESS = null;
    } catch (e) { return; }
    const p = store.get('pending', null);
    if (p && p.id === rec.id) store.set('pending', null);
  }

  async function finish() {
    if (!R.sess) return;
    if (R.listener) {
      const h = $('#r-heard'); h.textContent = 'لحظة… أُكمل معالجة آخر ما قرأت'; h.classList.remove('on');
      await stopListening();
      if (!R.sess) return;
    }
    const st = R.sess.stats();
    if (!st.judged) { toast('لم تقرأ شيئاً بعد. اضغط الميكروفون وابدأ.'); return; }
    R.finished = true;
    saveSession();
    saveResume({ done: true });
    const dur = R.t0 ? Math.round((Date.now() - R.t0) / 1000) : 0;
    const errs = [];
    R.sess.state.forEach((s, i) => { if (s === 'err') errs.push(i); });
    const color = st.accuracy >= 90 ? 'var(--ok)' : st.accuracy >= 70 ? 'var(--hint)' : 'var(--err)';
    const msg = st.accuracy >= 95 ? 'ممتاز! حفظٌ متقن.' : st.accuracy >= 80 ? 'جيد، راجع الكلمات المعلَّمة بالأحمر.' : 'يحتاج إلى مراجعة. جرّب القراءة والنص ظاهر أولاً.';
    openSheet(`<h3>نتيجة التسميع</h3>
      <div class="score"><div class="ring">${ringSVG(st.accuracy, color, 'var(--line)')}<div class="c"><b>${AR(st.accuracy)}٪</b><span>الدقة</span></div></div></div>
      <p style="text-align:center">${msg}</p>
      <div class="sumgrid"><div><b>${AR(st.ok)}</b><span>صحيحة</span></div><div><b>${AR(st.err)}</b><span>أخطاء</span></div><div><b>${AR(st.hint)}</b><span>تلميحات</span></div><div><b>${fmtDur(dur)}</b><span>المدة</span></div></div>
      ${errs.length ? `<h3 style="font-size:16px">راجع هذه الكلمات</h3><ul class="errs">${errs.slice(0, 60).map((i) => `<li><button data-jump="${i}"><span class="exp">${esc(R.words[i].disp)}</span><span class="got">${R.sess.heard[i] ? 'سمعتُ: ' + esc(R.sess.heard[i]) : 'لم تُقرأ'}</span></button></li>`).join('')}</ul>` : ''}
      <div class="row"><button class="btn ghost" id="s-again"><svg><use href="#i-redo"/></svg>أعد التسميع</button><button class="btn primary" id="s-done">تم</button></div>`);
    $('#s-again').onclick = () => { closeSheet(); resetReader(); };
    $('#s-done').onclick = closeSheet;
    $$('[data-jump]').forEach((b) => { b.onclick = () => { closeSheet(); flashWord(+b.dataset.jump); }; });
  }
  function flashWord(i) {
    const el = R.els[i];
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 600 });
  }
  function ayahOf(i) {
    let a = null;
    for (const x of R.ayahs) { if (x.start <= i) a = x; else break; }
    return a;
  }
  function wordSheet(i) {
    const st = R.sess.state[i];
    const veiled = S.hidden && st === 'p';
    const a = R.kind === 'quran' ? ayahOf(i) : null;
    openSheet(`<div class="bigword" id="w-big">${veiled ? '• • •' : esc(R.words[i].disp)}</div>
      ${st === 'err' ? `<p style="text-align:center;color:var(--err)">${R.sess.heard[i] ? 'سمعتُ: «' + esc(R.sess.heard[i]) + '»' : 'لم تُقرأ هذه الكلمة'}</p>` : ''}
      <div class="actions">
        <button class="btn ghost" id="w-here"><svg><use href="#i-mic"/></svg>ابدأ التسميع من هنا</button>
        ${a ? `<button class="btn ghost" id="w-play"><svg><use href="#i-play"/></svg>استمع إلى الآية ${AR(a.k)}</button>` : ''}
        ${veiled ? '<button class="btn ghost" id="w-peek"><svg><use href="#i-eye"/></svg>اكشف الكلمة</button>' : ''}
      </div>`);
    $('#w-here').onclick = () => { R.sess.setPos(i); paintAll(); updateStats(); saveResume(); closeSheet(); toast('سيبدأ التسميع من هذه الكلمة'); };
    if (a) $('#w-play').onclick = () => { closeSheet(); playAyah(a.k, a.g); };
    if (veiled) $('#w-peek').onclick = () => { $('#w-big').textContent = R.words[i].disp; $('#w-peek').remove(); };
  }

  function playAyah(k, g) {
    const playing = R.audio && R.audio.k === k;
    stopAudio();
    if (playing) return;
    stopListening();
    const a = new Audio(AUDIO(S.reciter, g));
    a.k = k;
    R.audio = a;
    const el = $(`#r-text .am[data-k="${k}"]`);
    if (el) el.classList.add('playing');
    const name = (RECITERS.find((r) => r[0] === S.reciter) || RECITERS[0])[1];
    a.onended = () => {
      if (el) el.classList.remove('playing');
      if (R.audio !== a) return;
      R.audio = null;
      const nx = R.ayahs.find((x) => x.k === k + 1); // متابعة الآية التالية
      if (nx && !$('#reader').hidden) playAyah(nx.k, nx.g);
    };
    a.onerror = () => { if (el) el.classList.remove('playing'); if (R.audio === a) R.audio = null; toast('تعذّر تشغيل التلاوة. تحقّق من اتصالك بالإنترنت.'); };
    a.play().then(() => toast(`الآية ${AR(k)} · ${name} — اضغط رقم الآية للإيقاف`), () => {});
  }
  function stopAudio() {
    if (R.audio) { const a = R.audio; R.audio = null; try { a.pause(); } catch (e) { /* ignore */ } }
    $$('#r-text .am.playing').forEach((e) => e.classList.remove('playing'));
  }

  /* ================= المصحف ================= */
  let MEMO = {};
  async function loadSurahs() {
    const ol = $('#surahs');
    try {
      SURAHS = await surahList();
      renderSurahs();
    } catch (e) {
      ol.innerHTML = '<li class="empty">تعذّر تحميل فهرس السور. تحقّق من اتصالك بالإنترنت.<br><button class="btn ghost sm" id="retry" style="margin-top:10px">أعد المحاولة</button></li>';
      $('#retry').onclick = () => { ol.innerHTML = '<li class="loading">جارٍ تحميل فهرس السور…</li>'; loadSurahs(); };
    }
  }
  function renderSurahs() {
    if (!SURAHS.length) return;
    const q = M.norm($('#q-surah').value.trim());
    const list = SURAHS.filter((s) => !q || String(s.n) === q || M.norm(s.name).includes(q) || M.norm(s.en).includes(q));
    $('#surahs').innerHTML = list.length ? list.map((s) => {
      const m = MEMO[s.n];
      const badge = m ? (m.done ? '<span class="badge done">محفوظة</span>' : m.pct >= 5 ? `<span class="badge part">${AR(m.pct)}٪</span>` : '') : '';
      return `<li><button class="srow" data-s="${s.n}"><span class="num"><svg><use href="#i-star8"/></svg><span>${AR(s.n)}</span></span>` +
        `<div><div class="sname">${esc(shortName(s.name))}</div><div class="smeta">${typeAr(s.type)} · ${AR(s.ayahs)} آية</div></div>${badge}</button></li>`;
    }).join('') : '<li class="empty">لا توجد سورة بهذا الاسم</li>';
  }
  async function openSurah(n, o) {
    o = o || {};
    let s;
    try { s = await getSurah(n); } catch (e) { toast('تعذّر تحميل السورة. تحقّق من اتصالك بالإنترنت.', 3500); return; }
    const meta = SURAHS.find((x) => x.n === n);
    const blocks = [{ type: 'title', text: s.name }];
    if (s.basmala) blocks.push({ type: 'basmala', text: s.basmala });
    for (const a of s.ayahs) blocks.push({ type: 'ayah', k: a.k, g: a.g, toks: M.tokenize(a.text) });
    openReader({ kind: 'quran', ref: n, title: 'سورة ' + shortName(s.name), sub: (meta ? typeAr(meta.type) + ' · ' : '') + AR(s.ayahs.length) + ' آية', blocks, lang: S.lang, pos: o.pos, ayah: o.ayah, restore: o.restore });
  }
  function renderContinue() {
    const r = lastSession();
    const el = $('#continue');
    if (!r || !r.title) { el.innerHTML = ''; return; }
    const pct = r.n ? Math.round((r.pos / r.n) * 100) : 0;
    const line = [r.sub || '', r.n && !r.done ? `أتممتَ ${AR(pct)}٪` : r.done ? 'اكتملت' : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<button class="cont" id="cont-btn"><div><span class="k">${r.done ? 'آخر تسميع' : 'تابع من حيث توقفت'}</span><b>${esc(r.title)}</b><span class="k">${esc(line)}</span></div><span class="go"><svg><use href="#i-back"/></svg></span></button>`;
    $('#cont-btn').onclick = () => openFromState(r);
  }

  function openVoiceSearch(autoMic) {
    if (autoMic !== true) autoMic = false;
    let vl = null;
    openSheet(`<h3>ابحث بالتلاوة</h3>
      <p class="note">اقرأ بضع كلمات من أي آية، أو اكتبها، فنجد لك موضعها.</p>
      <div class="listen"><button class="mic" id="vs-mic" aria-label="استمع"><svg><use href="#i-mic"/></svg></button><p id="vs-heard">اضغط الميكروفون واقرأ</p></div>
      <form id="vs-form" class="typein"><input id="vs-q" type="search" placeholder="مثال: الله نور السماوات والأرض" autocomplete="off"><button class="btn primary" type="submit">ابحث</button></form>
      <p class="note" id="vs-status"></p><ol class="results" id="vs-res"></ol>`, () => { if (vl) vl.stop(); });
    const status = $('#vs-status');
    const ensure = async () => {
      if (QIDX) return true;
      status.textContent = 'جارٍ تحميل نص المصحف للبحث (مرة واحدة فقط)…';
      try {
        await quranIndex((b) => { if ($('#vs-status')) status.textContent = `جارٍ التحميل… ${AR((b / 1048576).toFixed(1))} م.ب`; });
        status.textContent = '';
        return true;
      } catch (e) { status.textContent = 'تعذّر تحميل المصحف. تحقّق من اتصالك بالإنترنت.'; return false; }
    };
    const run = async (q) => {
      if (!q.trim() || !(await ensure()) || !$('#vs-res')) return 0;
      const res = searchQuran(q);
      $('#vs-res').innerHTML = res.length ? res.map(({ a }) => `<li><button data-s="${a.s}" data-k="${a.k}"><span class="ref">${esc(a.name)} · الآية ${AR(a.k)}</span><span class="txt">${esc(a.text)}</span></button></li>`).join('') : '<li class="empty">لم نجد آية مطابقة. جرّب كلمات أكثر.</li>';
      $$('#vs-res [data-s]').forEach((b) => { b.onclick = () => { closeSheet(); openSurah(+b.dataset.s, { ayah: +b.dataset.k }); }; });
      return res.length;
    };
    $('#vs-form').onsubmit = (e) => { e.preventDefault(); run($('#vs-q').value); };
    $('#vs-mic').onclick = () => {
      if (!canListen('search')) { toast('التعرّف على الصوت غير متاح في هذا المتصفح؛ اكتب الكلمات بدلاً من ذلك.'); $('#vs-q').focus(); return; }
      if (vl) { vl.stop(); return; }
      if (needsConsent('search')) { askModelDownload(() => openVoiceSearch(true), 'search'); return; }
      let acc = '';
      vl = makeListener('search', {
        lang: S.lang,
        onStatus: (t) => { const h = $('#vs-heard'); if (h && t) h.textContent = t; },
        onPartial: (t) => { const h = $('#vs-heard'); if (h) h.textContent = (acc + ' ' + t).trim() || 'أستمع…'; },
        onFinal: async (t) => {
          acc = (acc + ' ' + t).trim();
          if (!$('#vs-q')) return;
          $('#vs-q').value = acc; $('#vs-heard').textContent = acc;
          if ((await run(acc)) && vl) vl.stop();
        },
        onState: (st) => {
          const b = $('#vs-mic');
          if (b) { b.classList.toggle('on', st === 'listening'); b.classList.toggle('busy', st === 'loading'); }
          if (st === 'listening' && !acc && $('#vs-heard')) $('#vs-heard').textContent = 'أستمع… اقرأ ثم توقّف لحظة';
          if (st === 'idle') vl = null;
        },
        onError: (c) => toast(MIC_ERR[c] || 'حدث خطأ في الاستماع', 4000),
      });
      vl.start();
      ensure();
    };
    if (autoMic) $('#vs-mic').click();
  }

  /* ================= الكتب (PDF) ================= */
  let PDFJS = null;
  const WASM = () => new URL('lib/', location.href).href;
  async function loadPdfjs() {
    if (PDFJS) return PDFJS;
    const m = await import(new URL('lib/pdf.min.js', location.href).href);
    m.GlobalWorkerOptions.workerSrc = new URL('lib/pdf.worker.min.js', location.href).href;
    PDFJS = m;
    return m;
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (Array.from(document.scripts).some((s) => s.src === src)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  // استخراج النص وإصلاح تقطيع الكلمات العربية: js/pdftext.js
  const { pageText, cleanText, flipText, looksReversed, detectLang, hasText, repairBase, looksReadable, readableRatio } = window.PdfText;
  const XV = 2; // إصدار طريقة الاستخراج؛ الكتب الأقدم تُعاد معالجتها تلقائياً

  async function extractPages(buf, onProg) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), wasmUrl: WASM(), isEvalSupported: false });
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(pageText(tc.items));
      page.cleanup();
      if (onProg) onProg(p, doc.numPages);
    }
    try { await task.destroy(); } catch (e) { /* ignore */ }
    let flipped = false;
    if (looksReversed(pages)) { for (let i = 0; i < pages.length; i++) pages[i] = flipText(pages[i]); flipped = true; }
    return { pages, flipped };
  }

  /** الكتب المستوردة بإصدار أقدم: نعيد استخراجها من ملف PDF المحفوظ (مع إبقاء الصفحات المعدّلة يدوياً) */
  async function upgradeBook(b) {
    if (b.xv === XV) return false;
    const manual = new Set(b.manual || []);
    const blob = await DB.get('pdfs', b.id);
    if (blob && !b.pasted) {
      toast('نحسّن استخراج نص هذا الكتاب…', 4000);
      try {
        const { pages, flipped } = await extractPages(await blob.arrayBuffer());
        pages.forEach((t, i) => {
          if (manual.has(i + 1)) return;
          if (!hasText(t) && hasText(b.pages[i])) return;
          b.pages[i] = t;
        });
        b.flipped = flipped;
      } catch (e) { console.error(e); b.pages = b.pages.map((t, i) => (manual.has(i + 1) ? t : repairBase(t))); }
    } else {
      b.pages = b.pages.map((t, i) => (manual.has(i + 1) ? t : repairBase(t)));
    }
    b.xv = XV;
    await DB.put('books', b.id, b);
    return true;
  }
  const markManual = (b, p) => { b.manual = Array.from(new Set([...(b.manual || []), p])); };
  function toParas(t) {
    const out = [];
    let cur = '';
    for (const raw of String(t || '').split('\n')) {
      const l = raw.trim();
      if (!l) { if (cur) { out.push(cur); cur = ''; } continue; }
      cur = cur ? cur + ' ' + l : l;
      if (/[.!?؟۔:»"]$/.test(l) && cur.length > 60) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out;
  }
  function paginate(text, per) {
    const pages = [];
    let cur = [], n = 0;
    for (const p of text.split('\n')) {
      const c = M.words(p).length;
      if (n + c > per && cur.length) { pages.push(cur.join('\n')); cur = []; n = 0; }
      cur.push(p); n += c;
    }
    if (cur.length) pages.push(cur.join('\n'));
    return pages;
  }

  async function importPdf(file) {
    if (!file) return;
    if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('اختر ملفاً بصيغة PDF'); return; }
    const prog = $('#pdf-prog'), bar = $('#pdf-prog i'), lab = $('#pdf-prog span');
    prog.hidden = false; bar.style.width = '0%'; lab.textContent = 'جارٍ فتح الملف…';
    try {
      const buf = await file.arrayBuffer();
      const { pages, flipped } = await extractPages(buf, (p, n) => {
        bar.style.width = (p / n) * 100 + '%';
        lab.textContent = `استخراج النص: صفحة ${AR(p)} من ${AR(n)}`;
      });
      const first = Math.max(1, pages.findIndex(hasText) + 1);
      const id = 'b' + Date.now().toString(36);
      const book = { id, name: file.name.replace(/\.pdf$/i, ''), pageCount: pages.length, pages, lang: detectLang(pages.join(' ')), flipped, created: Date.now(), from: first, to: first, xv: XV };
      await DB.put('books', id, book);
      try { await DB.put('pdfs', id, new Blob([buf], { type: 'application/pdf' })); } catch (e) { /* ignore */ }
      prog.hidden = true;
      renderBooks();
      if (!pages.some(hasText)) toast('هذا الكتاب مصوَّر (بلا طبقة نص). استخدم زر «استخراج النص من الصفحات المصوّرة».', 5000);
      else if (flipped) toast('صحّحنا اتجاه النص المعكوس تلقائياً', 3500);
      openBook(id);
    } catch (e) {
      console.error(e);
      prog.hidden = true;
      toast(e && e.name === 'PasswordException' ? 'الملف محميّ بكلمة مرور' : 'تعذّر قراءة الملف. تأكد أنه PDF سليم.', 4000);
    }
    $('#pdf-in').value = '';
  }

  async function renderBooks() {
    const books = (await DB.all('books')) || [];
    books.sort((a, b) => (b.used || b.created) - (a.used || a.created));
    $('#books').innerHTML = books.length ? books.map((b) => `<button class="bcard" data-book="${esc(b.id)}"><span class="spine" aria-hidden="true"></span><span><b>${esc(b.name)}</b>` +
      `<span>${AR(b.pageCount)} صفحة · ${b.lang === 'en-US' ? 'English' : 'العربية'}${b.last ? ' · آخر تسميع: ص ' + AR(b.last.from) + (b.last.to !== b.last.from ? '–' + AR(b.last.to) : '') : ''}</span></span></button>`).join('')
      : '<p class="empty">مكتبتك فارغة. ارفع أول كتاب لتبدأ التسميع منه.</p>';
  }

  const BV = { book: null, pg: 1 };
  async function openBook(id) {
    const b = await DB.get('books', id);
    if (!b) { toast('لم يُعثر على الكتاب'); return; }
    if (await upgradeBook(b)) toast('حسّنّا استخراج النص وأصلحنا الكلمات المقطّعة', 3500);
    BV.book = b;
    BV.pg = b.from || 1;
    $('#bv-title').textContent = b.name;
    $('#bv-meta').textContent = `${AR(b.pageCount)} صفحة`;
    for (const k of ['from', 'to']) { const inp = $('#bv-' + k); inp.max = b.pageCount; inp.value = b[k] || 1; }
    $('#bv-lang').value = b.lang;
    $('#bv-editwrap').hidden = true; $('#bv-preview').hidden = false;
    $('#bookview').hidden = false;
    document.body.style.overflow = 'hidden';
    $('.bv-body').scrollTop = 0;
    pushNav();
    renderBV();
  }
  function closeBook() {
    $('#bookview').hidden = true;
    document.body.style.overflow = '';
    BV.book = null;
    renderBooks();
  }
  function bvRange() {
    const b = BV.book;
    let from = clamp(parseInt($('#bv-from').value, 10) || 1, 1, b.pageCount);
    let to = clamp(parseInt($('#bv-to').value, 10) || from, 1, b.pageCount);
    if (to < from) to = from;
    return { from, to };
  }
  function renderBV() {
    const b = BV.book;
    if (!b) return;
    const p = BV.pg, t = b.pages[p - 1] || '';
    $('#bv-pg').textContent = AR(p) + ' من ' + AR(b.pageCount);
    const pv = $('#bv-preview');
    if (!hasText(t)) {
      pv.className = 'bookpage empty-pg'; pv.removeAttribute('dir');
      pv.textContent = 'لا يوجد نص قابل للقراءة في هذه الصفحة (قد تكون صورة ممسوحة). استخدم «استخراج النص من الصفحات المصوّرة»، أو «تعديل النص» لكتابته يدوياً.';
    } else { pv.className = 'bookpage'; pv.dir = b.lang === 'en-US' ? 'ltr' : 'rtl'; pv.textContent = t; }
    $('#bv-prev').disabled = p <= 1;
    $('#bv-next').disabled = p >= b.pageCount;
    const { from, to } = bvRange();
    let words = 0, empty = 0;
    for (let i = from; i <= to; i++) { const tx = b.pages[i - 1] || ''; if (hasText(tx)) words += M.words(tx).length; else empty++; }
    const n = to - from + 1;
    $('#bv-count').textContent = `${AR(words)} كلمة في ${AR(n)} ${n === 1 ? 'صفحة' : 'صفحات'}` + (empty ? ` · ${AR(empty)} بلا نص` : '') + (words > 2500 ? ' · نطاق طويل، يُستحسن تقسيمه' : '');
    const ocr = $('#bv-ocr');
    ocr.hidden = !empty;
    if (!ocr.disabled) ocr.textContent = `استخراج النص من الصفحات المصوّرة (${AR(empty)})`;
  }
  function onRangeChange() {
    const b = BV.book;
    const { from, to } = bvRange();
    b.from = from; b.to = to;
    BV.pg = from;
    DB.put('books', b.id, b);
    renderBV();
  }
  async function openBookReader(id, o) {
    o = o || {};
    const b = BV.book && BV.book.id === id ? BV.book : await DB.get('books', id);
    if (!b) { toast('لم يُعثر على الكتاب'); return; }
    await upgradeBook(b);
    const from = clamp(o.from || b.from || 1, 1, b.pageCount);
    const to = clamp(o.to || b.to || from, from, b.pageCount);
    const blocks = [];
    for (let p = from; p <= to; p++) {
      const paras = toParas(b.pages[p - 1]);
      if (!paras.length) continue;
      blocks.push({ type: 'page', page: p });
      for (const t of paras) { const toks = M.tokenize(t); if (toks.length) blocks.push({ type: 'para', toks }); }
    }
    if (!blocks.some((x) => x.type === 'para')) { toast('لا يوجد نص في هذه الصفحات. استخرج النص أو عدّله يدوياً أولاً.', 4000); return; }
    b.last = { from, to }; b.used = Date.now();
    DB.put('books', b.id, b);
    openReader({ kind: 'book', ref: b.id, title: b.name, sub: from === to ? `صفحة ${AR(from)}` : `الصفحات ${AR(from)}–${AR(to)}`, blocks, lang: b.lang, pos: o.pos || 0, restore: o.restore, extra: { from, to }, dir: b.lang === 'en-US' ? 'ltr' : 'rtl' });
  }
  /** تحسين الصورة قبل التعرّف: تدرّج رمادي ثم مدّ التباين */
  function prepCanvas(c) {
    const ctx = c.getContext('2d');
    let im;
    try { im = ctx.getImageData(0, 0, c.width, c.height); } catch (e) { return; }
    const d = im.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    if (hi - lo > 30 && hi - lo < 250) {
      const k = 255 / (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, ((d[i] - lo) * k) | 0));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(im, 0, 0);
  }
  async function renderPage(doc, p, scale) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    page.cleanup();
    return c;
  }
  async function runOCR() {
    const b = BV.book;
    const { from, to } = bvRange();
    const targets = [];
    for (let p = from; p <= to; p++) if (!hasText(b.pages[p - 1])) targets.push(p);
    if (!targets.length) { toast('كل الصفحات المحددة فيها نص'); return; }
    if (targets.length > 30) { toast('اختر ٣٠ صفحة على الأكثر في كل مرة'); return; }
    const blob = await DB.get('pdfs', b.id);
    if (!blob) { toast('ملف PDF الأصلي غير محفوظ؛ ارفع الكتاب مرة أخرى'); return; }
    const btn = $('#bv-ocr');
    btn.disabled = true;
    const out = {};
    let worker = null, task = null;
    try {
      btn.textContent = 'جارٍ تجهيز الصفحات…';
      const pdfjs = await loadPdfjs();
      task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), wasmUrl: WASM(), isEvalSupported: false });
      const doc = await task.promise;
      btn.textContent = 'جارٍ تحميل أداة التعرّف الضوئي (مرة واحدة)…';
      await loadScript(TESSERACT);
      worker = await window.Tesseract.createWorker(b.lang === 'en-US' ? 'eng' : 'ara');
      let k = 0;
      for (const p of targets) {
        btn.textContent = `التعرّف على صفحة ${AR(p)} (${AR(++k)} من ${AR(targets.length)})…`;
        const pg0 = await doc.getPage(p);
        const w0 = pg0.getViewport({ scale: 1 }).width;
        pg0.cleanup();
        const scale = clamp(2200 / (w0 || 600), 1.5, 4); // التعرّف الضوئي يحتاج صورة كبيرة
        const canvas = await renderPage(doc, p, scale);
        prepCanvas(canvas);
        const r = await worker.recognize(canvas);
        out[p] = repairBase(cleanText(r.data.text));
      }
      await reviewOCR(b, out);
    } catch (e) {
      console.error(e);
      toast('تعذّر التعرّف الضوئي. تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.', 4500);
    }
    if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
    if (task) { try { await task.destroy(); } catch (e) { /* ignore */ } }
    btn.disabled = false;
    renderBV();
  }
  /** يعرض ما قرأه التعرّف الضوئي ليقرّر المستخدم حفظه أو رفضه */
  async function reviewOCR(b, out) {
    const pages = Object.keys(out).map(Number).sort((x, y) => x - y);
    const texts = pages.map((p) => out[p]);
    const got = texts.filter(hasText);
    if (!got.length) {
      openSheet(`<h3>تعذّرت قراءة الصفحات</h3>
        <p>لم نستطع قراءة أي نص من هذه الصفحات. غالباً الصور منخفضة الجودة.</p>${ocrTips()}`);
      bindOcrTips();
      return;
    }
    const ok = readableRatio(texts) >= 0.5;
    const sample = (got.find(looksReadable) || got[0]).slice(0, 600);
    openSheet(`<h3>${ok ? 'راجع النص المستخرج' : 'النص المستخرج غير مفهوم'}</h3>
      <p class="note">قرأنا ${AR(got.length)} من ${AR(pages.length)} صفحة. هذا نموذج مما قرأناه:</p>
      <div class="bookpage" dir="auto" style="max-height:34vh;overflow:auto;font-size:16px">${esc(sample)}</div>
      ${ok ? '<p class="note">إن كان مطابقاً للكتاب فاحفظه، وعدّل ما يلزم من «تعديل النص».</p>'
           : `<p class="note">الحروف متناثرة وغير مطابقة للكتاب، فلا ينفع للتسميع.</p>${ocrTips()}`}
      <div class="row">${ok ? '<button class="btn primary" id="oc-save">احفظ النص</button>' : '<button class="btn ghost" id="oc-save">احفظه على أي حال</button>'}
        <button class="btn ghost" id="oc-drop">تجاهل</button></div>`);
    bindOcrTips();
    $('#oc-drop').onclick = closeSheet;
    $('#oc-save').onclick = async () => {
      for (const p of pages) { if (hasText(out[p])) { b.pages[p - 1] = out[p]; markManual(b, p); } }
      await DB.put('books', b.id, b);
      closeSheet(); renderBV();
      toast('حُفظ النص. راجعه وعدّل ما يلزم قبل التسميع.', 4000);
    };
  }
  const ocrTips = () => `<p class="note"><b>الأفضل لهذا الكتاب:</b></p>
    <ul class="note" style="margin:0;padding-inline-start:20px">
      <li>انسخ نص الكتاب من الإنترنت إن كان متوفراً، والصقه هنا.</li>
      <li>أو استخدم «عدسة Google» على صور الكتاب، فهي أدقّ بكثير مع الخطوط المزخرفة، ثم الصق ما تقرؤه.</li>
      <li>أو ابحث عن نسخة PDF نصّية من الكتاب بدل المصوّرة.</li>
    </ul>
    <div class="row"><button class="btn primary" id="oc-paste"><svg><use href="#i-paste"/></svg>الصق نصاً الآن</button></div>`;
  function bindOcrTips() { const b = $('#oc-paste'); if (b) b.onclick = () => { closeSheet(); openPaste(); }; }

  /** استيراد ملف نصّي (.txt) — يكتشف ترميز ويندوز العربي تلقائياً */
  async function importTxt(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (/\uFFFD/.test(text)) {
        try { text = new TextDecoder('windows-1256').decode(buf); } catch (e) { /* ignore */ }
      }
      text = cleanText(text);
      if (M.words(text).length < 2) { toast('الملف فارغ أو غير مقروء'); return; }
      await addTextBook(file.name.replace(/\.(txt|md)$/i, ''), text);
    } catch (e) { console.error(e); toast('تعذّرت قراءة الملف'); }
    $('#txt-in').value = '';
  }
  async function addTextBook(name, text) {
    const pages = paginate(text, 220);
    const id = 'b' + Date.now().toString(36);
    const book = { id, name: name || 'نص', pageCount: pages.length, pages, lang: detectLang(text), created: Date.now(), from: 1, to: Math.min(pages.length, 3), pasted: true, xv: XV };
    await DB.put('books', id, book);
    renderBooks();
    openBook(id);
    return book;
  }

  function openPaste() {
    openSheet(`<h3>الصق نصاً للتسميع</h3>
      <div class="set">
        <label class="field"><span>العنوان</span><input type="text" id="p-name" placeholder="مثال: متن الأجرومية"></label>
        <label class="field"><span>النص</span><textarea id="p-text" rows="8" dir="auto" placeholder="الصق هنا النص الذي تحفظه"></textarea></label>
      </div>
      <div class="row"><button class="btn primary" id="p-save">حفظ وفتح</button></div>`);
    $('#p-save').onclick = async () => {
      const text = cleanText($('#p-text').value);
      const name = $('#p-name').value.trim() || 'نص ملصق';
      if (M.words(text).length < 2) { toast('النص قصير جداً'); return; }
      closeSheet();
      await addTextBook(name, text);
    };
  }
  function confirmSheet(title, text, okLabel, onOk) {
    openSheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button class="btn danger" id="cf-ok">${esc(okLabel)}</button><button class="btn ghost" id="cf-no">إلغاء</button></div>`);
    $('#cf-ok').onclick = () => { closeSheet(); onOk(); };
    $('#cf-no').onclick = closeSheet;
  }

  /* ================= التقدّم ================= */
  let SESS = null;
  async function sessions() {
    if (!SESS) SESS = ((await DB.all('sessions')) || []).sort((a, b) => b.date - a.date);
    return SESS;
  }
  function computeMemo(ss) {
    const m = {};
    for (const s of ss) {
      if (s.kind !== 'quran' || !s.hidden || !s.total) continue;
      const pct = Math.round((s.ok / s.total) * 100);
      const cur = m[s.ref] || { pct: 0, done: false };
      cur.pct = Math.max(cur.pct, pct);
      if (s.judged / s.total >= 0.9 && s.accuracy >= 90) cur.done = true;
      m[s.ref] = cur;
    }
    return m;
  }
  async function refreshMemo() { MEMO = computeMemo(await sessions()); renderSurahs(); }
  const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  function streakText(n) {
    if (!n) return 'ابدأ اليوم سلسلة أيام المراجعة';
    if (n === 1) return 'اليوم الأول في سلسلة المراجعة';
    if (n === 2) return 'يومان متتاليان من المراجعة';
    if (n <= 10) return `${AR(n)} أيام متتالية من المراجعة`;
    return `${AR(n)} يوماً متتالياً من المراجعة`;
  }
  async function renderProgress() {
    const ss = await sessions();
    const byDay = {};
    let words = 0, ok = 0;
    for (const s of ss) { const k = dayKey(s.date); byDay[k] = (byDay[k] || 0) + s.judged; words += s.judged; ok += s.ok; }
    const today = byDay[dayKey(Date.now())] || 0;
    let streak = 0;
    const d = new Date();
    if (!byDay[dayKey(d)]) d.setDate(d.getDate() - 1);
    while (byDay[dayKey(d)]) { streak++; d.setDate(d.getDate() - 1); }
    const pct = Math.min(100, Math.round((today / S.goal) * 100));
    $('#today').innerHTML = `<div class="ring">${ringSVG(pct, 'var(--gold)', 'rgb(255 255 255 / .16)')}<div class="c"><b>${AR(today)}</b><span>من ${AR(S.goal)} كلمة</span></div></div>` +
      `<div><h1>${pct >= 100 ? 'أتممت هدف اليوم' : 'هدف اليوم'}</h1><p>${streakText(streak)}</p></div>`;
    const days = [];
    const names = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
    for (let i = 6; i >= 0; i--) { const x = new Date(); x.setDate(x.getDate() - i); days.push({ v: byDay[dayKey(x)] || 0, n: names[x.getDay()], t: i === 0 }); }
    const max = Math.max(S.goal, ...days.map((x) => x.v));
    const memo = computeMemo(ss);
    const done = Object.keys(memo).filter((k) => memo[k].done).map(Number).sort((a, b) => a - b);
    const sname = (n) => { const s = SURAHS.find((x) => x.n === n); return s ? shortName(s.name) : 'سورة ' + AR(n); };
    const when = (t) => new Date(t).toLocaleString('ar-u-nu-arab', { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    $('#progress').innerHTML = `
      <div class="stats"><div class="stat"><b>${AR(streak)}</b><span>أيام متتالية</span></div><div class="stat"><b>${AR(words)}</b><span>كلمة سمّعتها</span></div><div class="stat"><b>${AR(words ? Math.round((ok / words) * 100) : 0)}٪</b><span>متوسط الدقة</span></div></div>
      <h2 class="sec">آخر سبعة أيام</h2>
      <div class="week">${days.map((x) => `<div class="${x.t ? 't' : ''}" title="${AR(x.v)} كلمة"><i style="height:${Math.max(3, Math.round((x.v / max) * 96))}px"></i><span>${x.n}</span></div>`).join('')}</div>
      <h2 class="sec">السور المحفوظة · ${AR(done.length)} من ١١٤</h2>
      ${done.length ? `<div class="chipsrow">${done.map((n) => `<span class="mchip">${esc(sname(n))}</span>`).join('')}</div>` : '<p class="note">سمّع سورة كاملة والنص مخفيّ بدقة ٩٠٪ فأكثر لتُحسب محفوظة.</p>'}
      <h2 class="sec">آخر الجلسات</h2>
      ${ss.length ? `<ul class="hist">${ss.slice(0, 15).map((s) => `<li><span class="acc ${s.accuracy >= 90 ? 'g' : s.accuracy >= 70 ? 'm' : 'b'}">${AR(s.accuracy)}٪</span><div><b>${esc(s.title)}</b><span>${esc(when(s.date))} · ${AR(s.judged)} كلمة${s.err ? ' · ' + AR(s.err) + ' أخطاء' : ''}${s.hidden ? ' · النص مخفي' : ''}</span></div></li>`).join('')}</ul>` : '<p class="note">لا توجد جلسات بعد. افتح سورة أو كتاباً وابدأ التسميع.</p>'}`;
  }

  /* ================= الإعدادات ================= */
  function openSettings() {
    const seg = (k, opts, cls) => `<div class="seg ${cls || ''}" data-k="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${S[k] === v}">${l}</button>`).join('')}</div>`;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('');
    openSheet(`<h3>الإعدادات</h3><div class="set">${accountBlock()}
      <div class="field"><span>دقّة التصحيح <small>· المتساهلة تتجاوز عن أخطاء التعرّف الصوتي، والصارمة تدقّق أكثر${S.strictChosen ? '' : ' · تُضبط تلقائياً حسب المحرّك'}</small></span>${seg('strict', [['low', 'متساهلة'], ['mid', 'متوسطة'], ['high', 'صارمة']])}</div>
      <label class="field"><span>حجم الخط: <b id="st-fv">${AR(S.font)}</b></span><input type="range" id="st-font" min="20" max="44" step="1" value="${S.font}"></label>
      <label class="field"><span>القارئ</span><select id="st-rec">${opt(RECITERS, S.reciter)}</select></label>
      <div class="field"><span>محرّك التعرّف على التلاوة</span>${seg('engine', [['auto', 'تلقائي (الأسرع لجهازك)'], ['browser', 'المتصفح · فوري'], ['local', 'ترتيل · على الجهاز'], ['server', 'ترتيل · خادم'], ['ctc', 'المعلّم · سريع (تجريبي)']], 'two')}<div id="eng-panel" class="engpanel"></div></div>
      <label class="field"><span>لهجة تعرّف المتصفح</span><select id="st-lang">${opt(DIALECTS, S.lang)}</select></label>
      <label class="field"><span>الهدف اليومي (عدد الكلمات)</span><input type="number" id="st-goal" min="10" step="10" inputmode="numeric" value="${S.goal}"></label>
      <div class="field"><span>المظهر</span>${seg('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']])}</div>
      <div class="field"><span>إصدار التطبيق: <b>${AR(BUILD)}</b></span>
        <button class="btn ghost sm" type="button" id="st-upd"><svg><use href="#i-redo"/></svg>تحقّق من وجود تحديث</button>
        <small>يجلب أحدث نسخة من الموقع ويعيد تشغيل التطبيق. لا يحذف كتبك ولا تقدّمك.</small></div>
      <button class="btn danger" id="st-wipe"><svg><use href="#i-trash"/></svg>مسح كل البيانات المحفوظة</button>
      <p class="note">نص المصحف من مشروع «تنزيل» (tanzil.net) دون تعديل، عبر خدمة AlQuran.cloud، والتلاوات من خدمة Islamic Network. الكتب التي ترفعها تبقى على جهازك ولا تُرسل إلى أي خادم.</p>
    </div>`);
    $$('#sheet .seg').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      S[sg.dataset.k] = b.dataset.v;
      $$('[data-v]', sg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      saveSettings();
      if (sg.dataset.k === 'engine') { S.engineChosen = true; store.set('settings', S); renderEngPanel(); }
      if (sg.dataset.k === 'strict') { S.strictChosen = true; store.set('settings', S); }
    }));
    renderEngPanel();
    $('#st-font').oninput = (e) => { S.font = +e.target.value; $('#st-fv').textContent = AR(S.font); saveSettings(); };
    $('#st-rec').onchange = (e) => { S.reciter = e.target.value; saveSettings(); };
    $('#st-lang').onchange = (e) => { S.lang = e.target.value; saveSettings(); if (R.kind === 'quran') R.lang = S.lang; };
    $('#st-goal').onchange = (e) => { S.goal = clamp(parseInt(e.target.value, 10) || DEF.goal, 10, 100000); saveSettings(); if (!$('#tab-progress').hidden) renderProgress(); };
    $('#st-upd').onclick = async () => {
      const b = $('#st-upd');
      b.disabled = true; b.textContent = 'جارٍ التحديث…';
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
        }
        if (window.caches) {
          // نُبقي نموذج ترتيل المحمَّل كي لا يُعاد تحميله (١٠٠–٢٠٠ م.ب) مع كل تحديث
          const keep = ['transformers-cache', 'tasmee-partial', 'tasmee-models'];
          const ks = await caches.keys();
          await Promise.all(ks.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
        }
      } catch (e) { /* ignore */ }
      location.reload();
    };
    $('#st-wipe').onclick = () => confirmSheet('مسح كل البيانات؟', 'سيُحذف سجلّ التقدّم والكتب المرفوعة ونص المصحف المحفوظ للعمل دون اتصال. لا يمكن التراجع.', 'امسح', async () => {
      for (const s of ['kv', 'books', 'pdfs', 'sessions']) await DB.clear(s);
      try { Object.keys(localStorage).filter((k) => k.startsWith('tasmee:')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
      location.reload();
    });
  }

  function engStatus() {
    const L = window.ASR.LocalEngine;
    if (L.ready) return `جاهز على جهازك · ${L.info.device === 'webgpu' ? 'WebGPU (سريع)' : 'WASM'} · ${L.info.dtype}`;
    if (L.loading) return 'جارٍ التحميل…';
    return 'لم يُحمَّل بعد.';
  }
  function renderEngPanel() {
    const box = $('#eng-panel');
    if (!box) return;
    const books = '<p class="note">الكتب تستخدم تعرّف المتصفح دائماً، لأن نموذج ترتيل مدرَّب على القرآن وحده.</p>';
    if (S.engine === 'auto') {
      const e = autoEngine();
      box.innerHTML = `<p class="note">يختار الأسرع لجهازك: نموذج ترتيل الدقيق إن كان جهازك يدعم تسريع الرسوميات (WebGPU)، وإلا تعرّف المتصفح الذي يتابعك كلمةً كلمة فوراً.</p>
        <p class="note"><b>على جهازك الآن:</b> ${esc(ENGINE_NAME[e])} · ${GPU ? 'يدعم WebGPU' : 'لا يدعم WebGPU'}</p>${books}`;
    } else if (S.engine === 'local') {
      box.innerHTML = `<p class="note">نموذج ترتيل المفتوح يعمل داخل جهازك: لا يغادره صوتك، ويعمل دون إنترنت بعد تحميله مرة واحدة (نحو ١٠٠–٢٠٠ م.ب). يصحّح بعد كل وقفة قصيرة؛ سريع على الأجهزة التي تدعم WebGPU، وأبطأ بثوانٍ على غيرها.</p>
        <p class="note" id="eng-st">${esc(engStatus())}</p>
        ${window.ASR.LocalEngine.ready ? '' : '<button class="btn ghost sm" id="eng-load" type="button">حمّل النموذج الآن</button>'}
        <details><summary>متقدّم</summary><label class="field"><span>معرّف النموذج على Hugging Face (بصيغة ONNX)</span><input type="text" id="st-model" dir="ltr" value="${esc(S.model)}" autocomplete="off"></label></details>${books}`;
      const lb = $('#eng-load');
      if (lb && !window.ASR.LocalEngine.loading) {
        window.ASR.LocalEngine.stored().then((k) => {
          const st = $('#eng-st');
          if (!k || !st || !lb.isConnected || window.ASR.LocalEngine.ready || window.ASR.LocalEngine.loading) return;
          if (k === 'saved') {
            st.textContent = 'محفوظ على جهازك، ويعمل دون إنترنت. يُشغَّل تلقائياً عند أول تسميع.';
            lb.textContent = 'شغّله الآن';
          } else {
            st.textContent = 'تحميل سابق لم يكتمل، وسيُستكمل من حيث توقف.';
            lb.textContent = 'أكمل التحميل';
          }
        });
      }
      if (lb) lb.onclick = () => {
        S.modelOk = true; store.set('settings', S);
        lb.disabled = true;
        const st = $('#eng-st');
        window.ASR.LocalEngine.ensure((t) => { if (t && st.isConnected) st.textContent = t; })
          .then(() => { toast('نموذج ترتيل جاهز'); if ($('#eng-panel')) renderEngPanel(); })
          .catch(() => { if (st.isConnected) st.textContent = MIC_ERR['engine-load']; lb.disabled = false; });
      };
      $('#st-model').onchange = (e) => { S.model = e.target.value.trim() || window.ASR.DEFAULT_MODEL; saveSettings(); renderEngPanel(); };
    } else if (S.engine === 'ctc') {
      const C = window.ASR.CtcEngine;
      box.innerHTML = `<p class="note">«المعلّم» نموذج مفتوح (HisnLabs Tajweed v2) يسمع الأصوات لا الكلمات، فيقارن تلاوتك بالآيات حرفاً حرفاً ولا «يصحّح» خطأك تلقائياً كما تفعل نماذج الكتابة. يعمل داخل جهازك دون إنترنت بعد تحميله مرة واحدة (نحو ٣٣ م.ب)، ويصحّح فور كل وقفة حتى على الجوالات المتوسطة.</p>
        <p class="note">تجريبي: دُرّب أكثره على أصوات قرّاء رجال، فقد تقلّ دقته مع غيرهم. الحرف الذي لم يتأكد منه يُعلَّم «لم تُتحقَّق» لا «خطأ». البحث بالتلاوة يستخدم محرّكاً آخر.</p>
        <p class="note" id="eng-st">${esc(C.ready ? `جاهز على جهازك · ${C.info && C.info.threads > 1 ? 'عدة أنوية' : 'نواة واحدة'}` : C.loading ? 'جارٍ التحميل…' : 'لم يُحمَّل بعد.')}</p>
        ${C.ready ? '' : '<button class="btn ghost sm" id="eng-load" type="button">حمّل «المعلّم» الآن</button>'}
        ${C.log.length ? `<details class="ctc-log"><summary>تشخيص: آخر ما سمعه «المعلّم»</summary>${C.log.map((x) => `<div class="note" dir="rtl" style="border-top:1px solid var(--line,#ddd);padding-top:.4em">
          <div><b>سُمع:</b> ${esc(x.heard)}</div><div><b>المتوقَّع:</b> ${esc(x.expected || '—')}</div>
          <div><b>الحكم:</b> ${x.words.map((w) => `${esc(w.w)} ${w.st === 'ok' ? '✓' : w.st === 'err' ? `✗(${esc(w.heard || '')})` : '؟'}`).join(' · ') || 'لم يُطابق النص'}</div>
          ${x.ms ? `<div><small>${AR(x.ms)} م.ث</small></div>` : ''}</div>`).join('')}</details>` : ''}${books}`;
      const lb = $('#eng-load');
      if (lb && !C.loading) {
        C.stored().then((k) => {
          const st = $('#eng-st');
          if (!k || !st || !lb.isConnected || C.ready || C.loading) return;
          if (k === 'saved') { st.textContent = 'محفوظ على جهازك، ويعمل دون إنترنت. يُشغَّل تلقائياً عند أول تسميع.'; lb.textContent = 'شغّله الآن'; }
          else { st.textContent = 'تحميل سابق لم يكتمل، وسيُستكمل من حيث توقف.'; lb.textContent = 'أكمل التحميل'; }
        });
      }
      if (lb) lb.onclick = () => {
        S.ctcOk = true; store.set('settings', S);
        lb.disabled = true;
        const st = $('#eng-st');
        C.ensure((t) => { if (t && st.isConnected) st.textContent = t; })
          .then(() => { toast('«المعلّم» جاهز'); if ($('#eng-panel')) renderEngPanel(); })
          .catch((e) => { if (st.isConnected) st.textContent = MIC_ERR['ctc-load'] + (e && e.message ? ` (${e.message})` : ''); lb.disabled = false; });
      };
    } else if (S.engine === 'server') {
      box.innerHTML = `<p class="note">شغّل الخادم المرفق في مجلد <b dir="ltr">server</b> على Hugging Face Spaces مجاناً، ثم الصق رابطه هنا. مناسب للجوالات البطيئة.</p>
        <label class="field"><span>رابط الخادم</span><input type="url" id="st-server" dir="ltr" placeholder="https://username-tasmee-asr.hf.space" value="${esc(S.server)}" autocomplete="off"></label>
        <div class="row"><button class="btn ghost sm" id="eng-test" type="button">اختبر الاتصال</button></div><p class="note" id="eng-st"></p>${books}`;
      $('#st-server').onchange = (e) => { S.server = e.target.value.trim(); saveSettings(); };
      $('#eng-test').onclick = async () => {
        S.server = $('#st-server').value.trim(); saveSettings();
        const st = $('#eng-st');
        st.textContent = 'جارٍ الاتصال…';
        try {
          await window.ASR.ServerEngine.ensure();
          const j = await window.ASR.ServerEngine.health();
          st.textContent = `متصل · ${j.model || 'نموذج ترتيل'}${j.ready === false ? ' (يُحمَّل الآن على الخادم)' : ''}`;
        } catch (e) { st.textContent = MIC_ERR[(e && e.code) || 'server'] || MIC_ERR.server; }
      };
    } else {
      box.innerHTML = '<p class="note">سريع ولا يحتاج تحميلاً، لكنه غير مدرَّب على التلاوة، فيخطئ أكثر مع المدود والقراءة السريعة. في Chrome يُرسَل الصوت إلى خوادم Google.</p>';
    }
  }


  /* ================= الحسابات ================= */
  const Cloud = window.Cloud;
  const AUTH_ERR = {
    'auth/invalid-email': 'البريد الإلكتروني غير صحيح.',
    'auth/missing-email': 'اكتب بريدك الإلكتروني.',
    'auth/missing-password': 'اكتب كلمة المرور.',
    'auth/user-disabled': 'هذا الحساب موقوف. تواصل مع إدارة التطبيق.',
    'auth/user-not-found': 'لا يوجد حساب بهذا البريد.',
    'auth/wrong-password': 'البريد أو كلمة المرور غير صحيحة.',
    'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة.',
    'auth/invalid-login-credentials': 'البريد أو كلمة المرور غير صحيحة.',
    'auth/email-already-in-use': 'هذا البريد مسجّل من قبل. سجّل الدخول، أو استعد كلمة المرور.',
    'auth/weak-password': 'كلمة المرور قصيرة: ٦ أحرف على الأقل.',
    'auth/password-does-not-meet-requirements': 'كلمة المرور لا تستوفي الشروط المطلوبة.',
    'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.',
    'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت.',
    'auth/operation-not-allowed': 'الدخول بالبريد غير مفعّل في مشروع Firebase (Authentication ← Sign-in method ← Email/Password).',
    'auth/unauthorized-domain': 'هذا الموقع غير مضاف في Firebase (Authentication ← Settings ← Authorized domains).',
    'permission-denied': 'لا تملك صلاحية لهذا الإجراء. تحقّق من قواعد Firestore.',
    'sdk-load': 'تعذّر الاتصال بخدمة الحسابات. تحقّق من الإنترنت.',
  };
  const authErr = (e) => AUTH_ERR[(e && e.code) || ''] || 'حدث خطأ. أعد المحاولة.' + (e && e.code ? ` (${e.code})` : '');
  let authMode = 'login';
  const initials = (n, e) => esc((String(n || e || '؟').trim()[0] || '؟').toUpperCase());
  const ago = (t) => {
    if (!t) return '—';
    const d = (Date.now() - t) / 1000;
    if (d < 60) return 'الآن';
    if (d < 3600) return `منذ ${AR(Math.floor(d / 60))} د`;
    if (d < 86400) return `منذ ${AR(Math.floor(d / 3600))} س`;
    if (d < 86400 * 30) return `منذ ${AR(Math.floor(d / 86400))} يوم`;
    return new Date(t).toLocaleDateString('ar-u-nu-arab', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  function showAuth(view, data) {
    const box = $('#auth-card');
    $('#auth').hidden = false;
    document.body.style.overflow = 'hidden';
    data = data || {};
    if (view === 'loading') {
      box.innerHTML = '<p class="center note">جارٍ التحقق من حسابك…</p>';
    } else if (view === 'form') {
      const su = authMode === 'signup';
      box.innerHTML = `<div class="seg"><button type="button" data-m="login" aria-pressed="${!su}">تسجيل الدخول</button><button type="button" data-m="signup" aria-pressed="${su}">حساب جديد</button></div>
        <form id="auth-form" novalidate>
          ${su ? '<label class="field"><span>الاسم</span><input type="text" name="name" autocomplete="name" required placeholder="اسمك كما يظهر للمدير"></label>' : ''}
          <label class="field"><span>البريد الإلكتروني</span><input type="email" name="email" autocomplete="email" inputmode="email" required placeholder="name@example.com" value="${esc(data.email || '')}"></label>
          <label class="field"><span>كلمة المرور</span><div class="pw"><input type="password" name="pass" autocomplete="${su ? 'new-password' : 'current-password'}" required minlength="6" placeholder="${su ? '٦ أحرف على الأقل' : ''}"><button type="button" id="pw-eye" aria-label="إظهار كلمة المرور"><svg><use href="#i-eye"/></svg></button></div></label>
          <p class="auth-msg ${data.ok ? 'ok' : 'err'}" id="auth-msg" ${data.msg ? '' : 'hidden'}>${esc(data.msg || '')}</p>
          <button class="btn primary wide" type="submit" id="auth-go">${su ? 'إنشاء الحساب' : 'دخول'}</button>
          ${su ? '' : '<button type="button" class="linkbtn" id="auth-forgot">نسيت كلمة المرور؟</button>'}
        </form>`;
      $$('[data-m]', box).forEach((b) => { b.onclick = () => { authMode = b.dataset.m; showAuth('form', { email: $('#auth-form [name=email]').value }); }; });
      $('#pw-eye').onclick = () => { const i = $('#auth-form [name=pass]'); i.type = i.type === 'password' ? 'text' : 'password'; };
      const msg = (t, ok) => { const m = $('#auth-msg'); m.hidden = !t; m.textContent = t || ''; m.className = 'auth-msg ' + (ok ? 'ok' : 'err'); };
      $('#auth-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target, email = f.email.value.trim(), pass = f.pass.value, name = su ? f.name.value.trim() : '';
        if (su && !name) { msg('اكتب اسمك.'); return; }
        if (!email || !pass) { msg('اكتب البريد وكلمة المرور.'); return; }
        const go = $('#auth-go'); go.disabled = true; msg('');
        try { if (su) await Cloud.signUp(name, email, pass); else await Cloud.signIn(email, pass); }
        catch (er) { msg(authErr(er)); go.disabled = false; }
      };
      const fg = $('#auth-forgot');
      if (fg) fg.onclick = async () => {
        const email = $('#auth-form [name=email]').value.trim();
        if (!email) { msg('اكتب بريدك أولاً، ثم اضغط «نسيت كلمة المرور».'); return; }
        try { await Cloud.reset(email); msg('أرسلنا رابط تعيين كلمة المرور إلى بريدك. افحص صندوق الوارد والرسائل غير المرغوبة.', true); }
        catch (er) { msg(authErr(er)); }
      };
    } else if (view === 'verify') {
      box.innerHTML = `<div class="big-ic"><svg><use href="#i-paste"/></svg></div>
        <h2 class="center">فعّل بريدك الإلكتروني</h2>
        <p class="center">أرسلنا رابط التفعيل إلى<br><b dir="ltr">${esc(data.email || '')}</b><br>افتح الرابط، ثم ارجع واضغط «تحقّقتُ».</p>
        <p class="auth-msg err" id="auth-msg" hidden></p>
        <div class="row"><button class="btn primary" id="v-done">تحقّقتُ، تابع</button><button class="btn ghost" id="v-resend">أعد الإرسال</button></div>
        <button class="linkbtn" data-act="logout">الدخول بحساب آخر</button>`;
      const msg = (t, ok) => { const m = $('#auth-msg'); m.hidden = !t; m.textContent = t; m.className = 'auth-msg ' + (ok ? 'ok' : 'err'); };
      $('#v-done').onclick = async () => {
        try { const u = await Cloud.reloadUser(); if (u.emailVerified) onUser(u); else msg('لم يُفعَّل البريد بعد. افتح الرابط في رسالتنا (وافحص الرسائل غير المرغوبة).'); }
        catch (er) { msg(authErr(er)); }
      };
      $('#v-resend').onclick = async () => { try { await Cloud.resendVerify(); msg('أُعيد إرسال الرابط.', true); } catch (er) { msg(authErr(er)); } };
    } else if (view === 'blocked') {
      box.innerHTML = `<div class="big-ic bad"><svg><use href="#i-logout"/></svg></div>
        <h2 class="center">الحساب موقوف</h2><p class="center">أوقفت الإدارة هذا الحساب. تواصل مع إدارة التطبيق لإعادة تفعيله.</p>
        <button class="btn ghost wide" data-act="logout">تسجيل الخروج</button>`;
    } else if (view === 'error') {
      box.innerHTML = `<h2 class="center">تعذّر الاتصال</h2><p class="center">${esc(data.msg || '')}</p><button class="btn primary wide" id="a-retry">أعد المحاولة</button>`;
      $('#a-retry').onclick = () => location.reload();
    }
  }
  function hideAuth() { $('#auth').hidden = true; if (!topOpen()) document.body.style.overflow = ''; }
  function setAdminUI() { $$('.admin-only').forEach((el) => { el.hidden = !(Cloud && Cloud.isAdmin); }); }

  async function onUser(u) {
    setAdminUI();
    if (!u) {
      store.set('lastUser', null);
      if (Cloud.requireLogin) { authMode = authMode || 'login'; showAuth('form'); } else hideAuth();
      return;
    }
    if (Cloud.requireVerified && !u.emailVerified) { showAuth('verify', { email: u.email }); return; }
    try {
      const p = await Cloud.ensureProfile(u);
      store.set('lastUser', { uid: u.uid, email: u.email, name: p.name || u.displayName || '', status: p.status, role: p.role });
    } catch (e) {
      // دون اتصال: نعتمد آخر حالة معروفة لهذا المستخدم
      const last = store.get('lastUser', null);
      if (!(last && last.uid === u.uid)) { console.warn(e); }
      else Cloud.profile = Object.assign({ uid: u.uid }, last);
    }
    if (Cloud.profile && Cloud.profile.status === 'blocked') { showAuth('blocked'); return; }
    setAdminUI();
    hideAuth();
    flushPending();
    maybeAutoResume();
  }
  async function doLogout() {
    closeSheet();
    if (!$('#admin').hidden) closeAdmin();
    try { await Cloud.signOut(); } catch (e) { /* ignore */ }
    authMode = 'login';
  }
  function initAuth() {
    if (!Cloud || !Cloud.configured) return;
    const last = store.get('lastUser', null);
    if (Cloud.requireLogin && !last) showAuth('loading');
    Cloud.onChange(onUser).catch((e) => {
      // تعذّر تحميل خدمة الحسابات (غالباً دون اتصال): من سجّل دخوله سابقاً يتابع، وغيره ينتظر الاتصال
      if (last && last.status !== 'blocked') { hideAuth(); return; }
      if (Cloud.requireLogin) showAuth('error', { msg: authErr(e) });
    });
  }
  function accountBlock() {
    if (!Cloud || !Cloud.configured) return '';
    const u = Cloud.user;
    if (!u) return `<div class="acct"><div class="avatar">؟</div><div style="flex:1"><b>لم تسجّل الدخول</b><span>سجّل الدخول ليُحفظ تقدّمك في حسابك</span></div><button class="btn ghost sm" type="button" id="acct-login">دخول</button></div>`;
    const p = Cloud.profile || {};
    setTimeout(() => { const b = $('#acct-login'); if (b) b.onclick = () => { closeSheet(); showAuth('form'); }; }, 0);
    return `<div class="acct"><div class="avatar">${initials(p.name || u.displayName, u.email)}</div>
      <div style="flex:1;min-width:0"><b>${esc(p.name || u.displayName || 'مستخدم')}${Cloud.isAdmin ? '<span class="role">مدير</span>' : ''}</b><span dir="ltr">${esc(u.email)}</span></div></div>
      <div class="row" style="margin-top:0">${Cloud.isAdmin ? '<button class="btn ghost sm" type="button" data-act="admin"><svg><use href="#i-users"/></svg>إدارة المستخدمين</button>' : ''}<button class="btn ghost sm" type="button" data-act="logout"><svg><use href="#i-logout"/></svg>تسجيل الخروج</button></div>`;
  }

  /* ================= لوحة إدارة المستخدمين ================= */
  const ADM = { users: [], filter: 'all' };
  async function openAdmin() {
    if (!Cloud || !Cloud.isAdmin) { toast('هذه الصفحة للمدير فقط'); return; }
    closeSheet();
    $('#admin').hidden = false;
    document.body.style.overflow = 'hidden';
    pushNav();
    await loadAdmin();
  }
  function closeAdmin() { $('#admin').hidden = true; if (!topOpen()) document.body.style.overflow = ''; }
  async function loadAdmin() {
    $('#adm-list').innerHTML = '<li class="empty">جارٍ تحميل المستخدمين…</li>';
    try { ADM.users = await Cloud.listUsers(); renderAdmin(); }
    catch (e) { console.error(e); $('#adm-list').innerHTML = `<li class="empty">${esc(authErr(e))}</li>`; }
  }
  const isAdminUser = (x) => x.role === 'admin' || Cloud.isAdminEmail(x.email);
  function renderAdmin() {
    const us = ADM.users;
    const week = Date.now() - 7 * 86400000;
    const active = us.filter((x) => Cloud.ms(x.lastActive) > week).length;
    const blocked = us.filter((x) => x.status === 'blocked').length;
    $('#adm-sub').textContent = `${AR(us.length)} مستخدم`;
    $('#adm-stats').innerHTML = [[us.length, 'المستخدمون'], [active, 'نشطون هذا الأسبوع'], [blocked, 'موقوفون'], [us.reduce((a, x) => a + (x.words || 0), 0), 'كلمة سُمّعت']]
      .map(([v, l]) => `<div class="stat"><b>${AR(v)}</b><span>${l}</span></div>`).join('');
    const q = $('#adm-q').value.trim().toLowerCase();
    const list = us.filter((x) => {
      if (ADM.filter === 'active' && x.status === 'blocked') return false;
      if (ADM.filter === 'blocked' && x.status !== 'blocked') return false;
      if (ADM.filter === 'admin' && !isAdminUser(x)) return false;
      return !q || String(x.name || '').toLowerCase().includes(q) || String(x.email || '').toLowerCase().includes(q);
    });
    $('#adm-list').innerHTML = list.length ? list.map((x) => {
      const acc = x.words ? Math.round(((x.ok || 0) / x.words) * 100) : 0;
      return `<li><button class="urow" data-uid="${esc(x.uid)}"><span class="avatar">${initials(x.name, x.email)}</span>
        <span class="who"><b>${esc(x.name || 'بلا اسم')}${x.status === 'blocked' ? '<span class="tag blocked">موقوف</span>' : ''}${isAdminUser(x) ? '<span class="tag admin">مدير</span>' : ''}</b>
        <span class="mail">${esc(x.email || '')}</span><span class="meta">آخر نشاط: ${esc(ago(Cloud.ms(x.lastActive)))}</span></span>
        <span class="num-r"><b>${AR(x.sessions || 0)}</b><br>جلسة</span><span class="num-r"><b>${x.words ? AR(acc) + '٪' : '—'}</b><br>الدقة</span></button></li>`;
    }).join('') : '<li class="empty">لا يوجد مستخدمون مطابقون</li>';
  }
  async function userSheet(uid) {
    const x = ADM.users.find((u) => u.uid === uid);
    if (!x) return;
    const me = Cloud.user && Cloud.user.uid === uid;
    const acc = x.words ? Math.round(((x.ok || 0) / x.words) * 100) : 0;
    const blocked = x.status === 'blocked';
    const admin = x.role === 'admin';
    openSheet(`<div class="acct"><div class="avatar">${initials(x.name, x.email)}</div><div style="flex:1;min-width:0"><b>${esc(x.name || 'بلا اسم')}</b><span dir="ltr">${esc(x.email || '')}</span></div></div>
      <dl class="kv">
        <dt>الحالة</dt><dd>${blocked ? '<span class="tag blocked" style="margin:0">موقوف</span>' : 'نشط'}${isAdminUser(x) ? ' · مدير' : ''}</dd>
        <dt>تاريخ التسجيل</dt><dd>${esc(ago(Cloud.ms(x.createdAt)))}</dd>
        <dt>آخر دخول</dt><dd>${esc(ago(Cloud.ms(x.lastLogin)))}</dd>
        <dt>الجلسات</dt><dd>${AR(x.sessions || 0)} جلسة · ${AR(x.words || 0)} كلمة · دقة ${AR(acc)}٪</dd>
      </dl>
      <h3 style="font-size:16px">آخر الجلسات</h3><ul class="hist" id="u-sess"><li><span class="note">جارٍ التحميل…</span></li></ul>
      ${me ? '<p class="note">هذا حسابك.</p>' : `<div class="row">
        <button class="btn ${blocked ? 'primary' : 'danger'}" id="u-block">${blocked ? 'إعادة تفعيل الحساب' : 'إيقاف الحساب'}</button>
        <button class="btn ghost" id="u-role">${admin ? 'إزالة صلاحية المدير' : 'جعله مديراً'}</button></div>`}
      <p class="note">لحذف الحساب نهائياً أو تغيير كلمة مروره: Firebase console ← Authentication ← Users.</p>`);
    if (!me) {
      $('#u-block').onclick = async () => {
        try { await Cloud.setStatus(uid, blocked ? 'active' : 'blocked'); x.status = blocked ? 'active' : 'blocked'; toast(blocked ? 'أُعيد تفعيل الحساب' : 'أُوقف الحساب'); renderAdmin(); userSheet(uid); }
        catch (e) { toast(authErr(e), 4000); }
      };
      $('#u-role').onclick = async () => {
        try { await Cloud.setRole(uid, admin ? 'user' : 'admin'); x.role = admin ? 'user' : 'admin'; toast(admin ? 'أُزيلت صلاحية المدير' : 'أصبح مديراً'); renderAdmin(); userSheet(uid); }
        catch (e) { toast(authErr(e), 4000); }
      };
    }
    try {
      const ss = await Cloud.userSessions(uid);
      const ul = $('#u-sess');
      if (!ul) return;
      ul.innerHTML = ss.length ? ss.map((r) => `<li><span class="acc ${r.accuracy >= 90 ? 'g' : r.accuracy >= 70 ? 'm' : 'b'}">${AR(r.accuracy || 0)}٪</span><div><b>${esc(r.title || '')}</b><span>${esc(ago(Cloud.ms(r.date)))} · ${AR(r.judged || 0)} كلمة${r.err ? ' · ' + AR(r.err) + ' أخطاء' : ''}</span></div></li>`).join('')
        : '<li><span class="note">لا توجد جلسات بعد.</span></li>';
    } catch (e) { const ul = $('#u-sess'); if (ul) ul.innerHTML = `<li><span class="note">${esc(authErr(e))}</span></li>`; }
  }
  function exportCSV() {
    const rows = [['الاسم', 'البريد', 'الحالة', 'الدور', 'تاريخ التسجيل', 'آخر نشاط', 'الجلسات', 'الكلمات', 'الدقة %']];
    for (const x of ADM.users) {
      rows.push([x.name || '', x.email || '', x.status || '', isAdminUser(x) ? 'admin' : 'user', new Date(Cloud.ms(x.createdAt) || 0).toISOString().slice(0, 10),
        new Date(Cloud.ms(x.lastActive) || 0).toISOString().slice(0, 10), x.sessions || 0, x.words || 0, x.words ? Math.round(((x.ok || 0) / x.words) * 100) : 0]);
    }
    const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `tasmee-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ================= الربط ================= */
  function bind() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'settings') openSettings();
        else if (act === 'vsearch') openVoiceSearch();
        else if (act === 'go-books') go('books');
        else if (act === 'paste') openPaste();
        else if (act === 'txt') $('#txt-in').click();
        else if (act === 'admin') openAdmin();
        else if (act === 'logout') doLogout();
        return;
      }
      const g = e.target.closest('[data-go]');
      if (g) { go(g.dataset.go); return; }
      const s = e.target.closest('.srow');
      if (s) { openSurah(+s.dataset.s); return; }
      const bk = e.target.closest('[data-book]');
      if (bk) openBook(bk.dataset.book);
    });
    $('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(); else if (topOpen()) navBack(); } });
    $('#q-surah').addEventListener('input', renderSurahs);

    // الكتب
    $('#pdf-in').addEventListener('change', (e) => importPdf(e.target.files[0]));
    $('#txt-in').addEventListener('change', (e) => importTxt(e.target.files[0]));
    const drop = $('#drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); importPdf(e.dataTransfer.files[0]); });
    $('#bv-back').onclick = navBack;
    $('#bv-from').addEventListener('change', onRangeChange);
    $('#bv-to').addEventListener('change', onRangeChange);
    $('#bv-lang').onchange = (e) => { BV.book.lang = e.target.value; DB.put('books', BV.book.id, BV.book); renderBV(); };
    $('#bv-prev').onclick = () => { if (BV.pg > 1) { BV.pg--; renderBV(); } };
    $('#bv-next').onclick = () => { if (BV.pg < BV.book.pageCount) { BV.pg++; renderBV(); } };
    $('#bv-flip').onclick = () => {
      const b = BV.book;
      b.pages = b.pages.map(flipText); b.flipped = !b.flipped;
      DB.put('books', b.id, b); renderBV();
      toast('قلبنا اتجاه النص في كل الصفحات');
    };
    $('#bv-ocr').onclick = runOCR;
    $('#bv-edit').onclick = () => {
      $('#bv-editor').value = BV.book.pages[BV.pg - 1] || '';
      $('#bv-editwrap').hidden = false; $('#bv-preview').hidden = true; $('#bv-editor').focus();
    };
    $('#bv-cancel').onclick = () => { $('#bv-editwrap').hidden = true; $('#bv-preview').hidden = false; };
    $('#bv-save').onclick = () => {
      BV.book.pages[BV.pg - 1] = cleanText($('#bv-editor').value);
      markManual(BV.book, BV.pg);
      DB.put('books', BV.book.id, BV.book);
      $('#bv-editwrap').hidden = true; $('#bv-preview').hidden = false;
      renderBV(); toast('حُفظ نص الصفحة');
    };
    $('#bv-del').onclick = () => confirmSheet('حذف الكتاب؟', `سيُحذف «${BV.book.name}» من جهازك.`, 'احذف', async () => {
      const id = BV.book.id;
      await DB.del('books', id); await DB.del('pdfs', id);
      const r = lastSession();
      if (r && r.ref === id) { store.set('session', null); store.set('resume', null); renderContinue(); }
      navBack();
    });
    $('#bv-start').onclick = () => { const { from, to } = bvRange(); openBookReader(BV.book.id, { from, to }); };

    // إدارة المستخدمين
    $('#adm-back').onclick = navBack;
    $('#adm-refresh').onclick = loadAdmin;
    $('#adm-csv').onclick = exportCSV;
    $('#adm-q').addEventListener('input', renderAdmin);
    $('#adm-filter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      ADM.filter = b.dataset.f;
      $$('#adm-filter [data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderAdmin();
    });
    $('#adm-list').addEventListener('click', (e) => { const b = e.target.closest('[data-uid]'); if (b) userSheet(b.dataset.uid); });

    // شاشة التسميع
    $('#r-back').onclick = navBack;
    $('#r-mic').onclick = () => { if (R.listener) stopListening(); else startListening(); };
    $('#r-hint').onclick = hint;
    $('#r-finish').onclick = finish;
    $('#r-reset').onclick = () => { if (R.sess && R.sess.touched()) confirmSheet('إعادة التسميع؟', 'ستُمسح نتيجة هذه المحاولة من الشاشة (تبقى محفوظة في سجلّك).', 'أعد', () => { saveSession(); resetReader(); }); else resetReader(); };
    $('#r-hide').onclick = () => setHidden(!S.hidden);
    $('#r-kbd').onclick = () => { const f = $('#r-type'); f.hidden = !f.hidden; if (!f.hidden) $('#r-typein').focus(); };
    $('#r-type').onsubmit = (e) => { e.preventDefault(); const v = $('#r-typein').value.trim(); if (v) { if (!R.t0) R.t0 = Date.now(); onFinal(v); } $('#r-typein').value = ''; };
    $('#r-typein').addEventListener('input', (e) => {
      const v = e.target.value;
      if (/\s$/.test(v) && v.trim()) { if (!R.t0) R.t0 = Date.now(); onFinal(v.trim()); e.target.value = ''; }
    });
    $('#r-text').addEventListener('click', (e) => {
      const am = e.target.closest('.am');
      if (am) { playAyah(+am.dataset.k, +am.dataset.g); return; }
      const w = e.target.closest('.w');
      if (w && R.sess) wordSheet(+w.dataset.i);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) parkSession(); });
    window.addEventListener('pagehide', parkSession);
  }

  function init() {
    if (window.__ASR_LIB) window.ASR.LocalEngine.lib = window.__ASR_LIB;
    applySettings();
    bind();
    flushPending();
    initAuth();
    loadSurahs();
    renderContinue();
    if (!Cloud || !Cloud.configured || !Cloud.requireLogin || store.get('lastUser', null)) maybeAutoResume();
    refreshMemo();
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings); } catch (e) { /* ignore */ }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // نسخة جديدة من التطبيق نُشرت: نعيد التحميل إن لم يكن المستخدم في منتصف تسميع
        // ولا نعيد التحميل أثناء تنزيل نموذج ترتيل كي لا ينقطع
        const L = window.ASR && window.ASR.LocalEngine;
        const C = window.ASR && window.ASR.CtcEngine;
        if (!hadController || reloading || !$('#reader').hidden || (L && L.loading && !L.ready) || (C && C.loading && !C.ready)) return;
        reloading = true;
        location.reload();
      });
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').then((reg) => {
        if (!reg || !reg.update) return;
        const check = () => { if (!document.hidden) { try { reg.update().catch(() => {}); } catch (e) { /* ignore */ } } };
        document.addEventListener('visibilitychange', check);
        setTimeout(check, 3000);
      }).catch(() => {}));
    }
    window.__tasmee = { R, S, DB, loadPdfjs, renderPage, flipText, looksReversed, Cloud: window.Cloud };
  }
  init();
})();
