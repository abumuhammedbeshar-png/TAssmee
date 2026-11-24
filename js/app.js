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
  const DEF = { strict: 'mid', font: 28, reciter: 'ar.alafasy', lang: 'ar-SA', goal: 150, hidden: false, theme: 'auto', engine: 'local', server: '', model: window.ASR.DEFAULT_MODEL, modelOk: false };
  const S = Object.assign({}, DEF, store.get('settings', {}));
  function saveSettings() { store.set('settings', S); applySettings(); }
  function applySettings() {
    const r = document.documentElement;
    if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
    r.style.setProperty('--fs', S.font + 'px');
    const hero = getComputedStyle(r).getPropertyValue('--hero').trim();
    if (hero) $('meta[name=theme-color]').setAttribute('content', hero);
    if (R.sess) R.sess.setStrictness(S.strict);
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
  const topOpen = () => !$('#reader').hidden || !$('#bookview').hidden;
  function pushNav() { try { history.pushState({ d: ++navDepth }, ''); } catch (e) { /* ignore */ } }
  function navBack() { if (navDepth > 0) history.back(); else closeTop(); }
  function closeTop() { if (!$('#reader').hidden) closeReader(); else if (!$('#bookview').hidden) closeBook(); }
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
          if (res.isFinal) { if (!done.has(i)) { done.add(i); this.onFinal(tx); } } else interim += tx + ' ';
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
        if (this.active) setTimeout(() => { if (this.active && this.rec === r) this._spawn(); }, 120);
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
    server: 'تعذّر الوصول إلى خادم التعرّف. تأكد أن الخادم يعمل.',
  };
  const ENGINE_NAME = { browser: 'تعرّف المتصفح', local: 'نموذج ترتيل على جهازك', server: 'نموذج ترتيل على الخادم' };
  // نموذج ترتيل مدرَّب على القرآن فقط، فالكتب تبقى على تعرّف المتصفح
  const engineFor = (kind) => (kind !== 'quran' ? 'browser' : ENGINE_NAME[S.engine] ? S.engine : 'browser');
  const canListen = (kind) => (engineFor(kind) === 'browser' ? !!SR : !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  function makeListener(kind, h) {
    const e = engineFor(kind);
    if (e === 'browser') return SR ? new Listener(h) : null;
    return new window.ASR.ModelListener(Object.assign({ engine: e === 'local' ? window.ASR.LocalEngine : window.ASR.ServerEngine }, h));
  }
  const needsConsent = (kind) => engineFor(kind) === 'local' && !window.ASR.LocalEngine.ready && !S.modelOk;
  function askModelDownload(go) {
    openSheet(`<h3>تحميل نموذج ترتيل</h3>
      <p>لتصحيح التلاوة بدقة أعلى سيُحمَّل نموذج ترتيل المفتوح (whisper-base-ar-quran) إلى جهازك مرة واحدة: نحو ${navigator.gpu ? '١٠٠–٢٠٠' : '١٠٠'} م.ب. يُستحسن الاتصال بشبكة Wi-Fi.</p>
      <p class="note">بعد التحميل يعمل التعرّف داخل جهازك حتى دون إنترنت، ولا يغادره صوتك.</p>
      <div class="row"><button class="btn primary" id="md-ok">حمّل وابدأ</button><button class="btn ghost" id="md-no">استخدم تعرّف المتصفح</button></div>`);
    $('#md-ok').onclick = () => { S.modelOk = true; store.set('settings', S); closeSheet(); go(); };
    $('#md-no').onclick = () => { S.engine = 'browser'; saveSettings(); closeSheet(); go(); };
  }
  function micError(code) {
    const msg = MIC_ERR[code] || 'حدث خطأ في الاستماع. أعد المحاولة.';
    toast(msg, 4500);
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
    Object.assign(R, { kind: o.kind, ref: o.ref, title: o.title, sub: o.sub || '', lang: o.lang || 'ar-SA', t0: 0, sid: null, log: '', live: [], extra: o.extra || {}, words: built.words, ayahs: built.ayahs });
    R.sess = new M.Session(built.words, { strictness: S.strict });
    const box = $('#r-text');
    box.innerHTML = `<div class="page" dir="${o.dir || 'rtl'}">${built.html}</div>`;
    R.els = [];
    for (const el of $$('.w', box)) R.els[+el.dataset.i] = el;
    $('#r-title').textContent = o.title;
    $('#r-sub').textContent = o.sub || '';
    let pos = o.pos || 0;
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
    const saved = R.sess && R.sess.stats().judged ? saveSession() : Promise.resolve();
    $('#reader').hidden = true;
    if ($('#bookview').hidden) document.body.style.overflow = '';
    $('#r-text').innerHTML = '';
    R.els = []; R.sess = null; R.live = [];
    renderContinue();
    saved.then(refreshMemo, refreshMemo);
  }

  function paint(i) {
    const el = R.els[i];
    if (!el) return;
    const s = R.sess.state[i];
    el.className = 'w s-' + s + (i === R.sess.pos ? ' cur' : '') + (R.live.includes(i) ? ' live' : '');
    if (s === 'err') el.title = R.sess.heard[i] ? 'سمعتُ: ' + R.sess.heard[i] : 'لم تُقرأ';
    else if (el.title) el.removeAttribute('title');
  }
  function paintAll() { for (let i = 0; i < R.els.length; i++) paint(i); R.prevCur = R.sess.pos; }
  function moveCur() { const p = R.prevCur; R.prevCur = R.sess.pos; paint(p); paint(R.sess.pos); }
  function setLive(idx) {
    const old = R.live;
    R.live = idx;
    for (const i of old) paint(i);
    for (const i of idx) paint(i);
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
    const el = R.els[Math.min(R.sess.pos, R.els.length - 1)];
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

  function onFinal(text) {
    if (!R.sess || !text) return;
    logHeard(text, true);
    setLive([]);
    const { changed, jumped } = R.sess.feed(text);
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
    if (needsConsent(R.kind)) { askModelDownload(startListening); return; }
    stopAudio();
    const L = makeListener(R.kind, {
      lang: R.lang, onFinal, onPartial, onError: micError,
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
    R.sid = null; R.t0 = 0; R.log = ''; R.live = [];
    paintAll(); updateStats();
    const h = $('#r-heard'); h.classList.remove('on'); h.textContent = 'بدأنا من جديد. اضغط الميكروفون واقرأ';
    scrollToCur(true);
  }
  function saveResume() {
    if (!R.sess) return;
    store.set('resume', { kind: R.kind, ref: R.ref, title: R.title, sub: R.sub, pos: R.sess.pos, from: R.extra.from, to: R.extra.to });
  }
  async function saveSession() {
    const st = R.sess.stats();
    if (!st.judged) return null;
    if (!R.sid) R.sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const rec = { id: R.sid, kind: R.kind, ref: R.ref, title: R.title, date: Date.now(), ok: st.ok, err: st.err, hint: st.hint, skip: st.skip, judged: st.judged, total: st.total, accuracy: st.accuracy, hidden: !!S.hidden, dur: R.t0 ? Math.round((Date.now() - R.t0) / 1000) : 0 };
    await DB.put('sessions', rec.id, rec);
    SESS = null;
    return rec;
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
    saveSession();
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
    openReader({ kind: 'quran', ref: n, title: 'سورة ' + shortName(s.name), sub: (meta ? typeAr(meta.type) + ' · ' : '') + AR(s.ayahs.length) + ' آية', blocks, lang: S.lang, pos: o.pos, ayah: o.ayah });
  }
  function renderContinue() {
    const r = store.get('resume', null);
    const el = $('#continue');
    if (!r || !r.title) { el.innerHTML = ''; return; }
    el.innerHTML = `<button class="cont" id="cont-btn"><div><span class="k">تابع من حيث توقفت</span><b>${esc(r.title)}</b><span class="k">${esc(r.sub || '')}</span></div><span class="go"><svg><use href="#i-back"/></svg></span></button>`;
    $('#cont-btn').onclick = () => { if (r.kind === 'quran') openSurah(r.ref, { pos: r.pos }); else openBookReader(r.ref, { from: r.from, to: r.to, pos: r.pos }); };
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
      if (!canListen('quran')) { toast('التعرّف على الصوت غير متاح في هذا المتصفح؛ اكتب الكلمات بدلاً من ذلك.'); $('#vs-q').focus(); return; }
      if (vl) { vl.stop(); return; }
      if (needsConsent('quran')) { askModelDownload(() => openVoiceSearch(true)); return; }
      let acc = '';
      vl = makeListener('quran', {
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
  const { pageText, cleanText, flipText, looksReversed, detectLang, hasText, repairBase } = window.PdfText;
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
    openReader({ kind: 'book', ref: b.id, title: b.name, sub: from === to ? `صفحة ${AR(from)}` : `الصفحات ${AR(from)}–${AR(to)}`, blocks, lang: b.lang, pos: o.pos || 0, extra: { from, to }, dir: b.lang === 'en-US' ? 'ltr' : 'rtl' });
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
        const canvas = await renderPage(doc, p, 2);
        const r = await worker.recognize(canvas);
        b.pages[p - 1] = repairBase(cleanText(r.data.text));
        markManual(b, p);
      }
      await DB.put('books', b.id, b);
      toast('تم استخراج النص. راجعه وعدّل ما يلزم قبل التسميع.', 4000);
    } catch (e) {
      console.error(e);
      toast('تعذّر التعرّف الضوئي. تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.', 4500);
    }
    if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
    if (task) { try { await task.destroy(); } catch (e) { /* ignore */ } }
    btn.disabled = false;
    renderBV();
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
      if (M.words(text).length < 2) { toast('النص قصير جداً'); return; }
      const pages = paginate(text, 220);
      const id = 'b' + Date.now().toString(36);
      const book = { id, name: $('#p-name').value.trim() || 'نص ملصق', pageCount: pages.length, pages, lang: detectLang(text), created: Date.now(), from: 1, to: Math.min(pages.length, 3), pasted: true };
      await DB.put('books', id, book);
      closeSheet(); renderBooks(); openBook(id);
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
    const seg = (k, opts) => `<div class="seg" data-k="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${S[k] === v}">${l}</button>`).join('')}</div>`;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('');
    openSheet(`<h3>الإعدادات</h3><div class="set">
      <div class="field"><span>دقّة التصحيح <small>· المتساهلة تتجاوز عن أخطاء التعرّف الصوتي، والصارمة تدقّق أكثر</small></span>${seg('strict', [['low', 'متساهلة'], ['mid', 'متوسطة'], ['high', 'صارمة']])}</div>
      <label class="field"><span>حجم الخط: <b id="st-fv">${AR(S.font)}</b></span><input type="range" id="st-font" min="20" max="44" step="1" value="${S.font}"></label>
      <label class="field"><span>القارئ</span><select id="st-rec">${opt(RECITERS, S.reciter)}</select></label>
      <div class="field"><span>محرّك التعرّف على التلاوة</span>${seg('engine', [['local', 'ترتيل · على الجهاز'], ['server', 'ترتيل · خادم'], ['browser', 'المتصفح']])}<div id="eng-panel" class="engpanel"></div></div>
      <label class="field"><span>لهجة تعرّف المتصفح</span><select id="st-lang">${opt(DIALECTS, S.lang)}</select></label>
      <label class="field"><span>الهدف اليومي (عدد الكلمات)</span><input type="number" id="st-goal" min="10" step="10" inputmode="numeric" value="${S.goal}"></label>
      <div class="field"><span>المظهر</span>${seg('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']])}</div>
      <button class="btn danger" id="st-wipe"><svg><use href="#i-trash"/></svg>مسح كل البيانات المحفوظة</button>
      <p class="note">نص المصحف من مشروع «تنزيل» (tanzil.net) دون تعديل، عبر خدمة AlQuran.cloud، والتلاوات من خدمة Islamic Network. الكتب التي ترفعها تبقى على جهازك ولا تُرسل إلى أي خادم.</p>
    </div>`);
    $$('#sheet .seg').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      S[sg.dataset.k] = b.dataset.v;
      $$('[data-v]', sg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      saveSettings();
      if (sg.dataset.k === 'engine') renderEngPanel();
    }));
    renderEngPanel();
    $('#st-font').oninput = (e) => { S.font = +e.target.value; $('#st-fv').textContent = AR(S.font); saveSettings(); };
    $('#st-rec').onchange = (e) => { S.reciter = e.target.value; saveSettings(); };
    $('#st-lang').onchange = (e) => { S.lang = e.target.value; saveSettings(); if (R.kind === 'quran') R.lang = S.lang; };
    $('#st-goal').onchange = (e) => { S.goal = clamp(parseInt(e.target.value, 10) || DEF.goal, 10, 100000); saveSettings(); if (!$('#tab-progress').hidden) renderProgress(); };
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
    if (S.engine === 'local') {
      box.innerHTML = `<p class="note">نموذج ترتيل المفتوح يعمل داخل جهازك: لا يغادره صوتك، ويعمل دون إنترنت بعد تحميله مرة واحدة (نحو ١٠٠–٢٠٠ م.ب). أسرع على الأجهزة التي تدعم WebGPU.</p>
        <p class="note" id="eng-st">${esc(engStatus())}</p>
        ${window.ASR.LocalEngine.ready ? '' : '<button class="btn ghost sm" id="eng-load" type="button">حمّل النموذج الآن</button>'}
        <details><summary>متقدّم</summary><label class="field"><span>معرّف النموذج على Hugging Face (بصيغة ONNX)</span><input type="text" id="st-model" dir="ltr" value="${esc(S.model)}" autocomplete="off"></label></details>${books}`;
      const lb = $('#eng-load');
      if (lb) lb.onclick = () => {
        S.modelOk = true; store.set('settings', S);
        lb.disabled = true;
        const st = $('#eng-st');
        window.ASR.LocalEngine.ensure((t) => { if (t && st.isConnected) st.textContent = t; })
          .then(() => { toast('نموذج ترتيل جاهز'); if ($('#eng-panel')) renderEngPanel(); })
          .catch(() => { if (st.isConnected) st.textContent = MIC_ERR['engine-load']; lb.disabled = false; });
      };
      $('#st-model').onchange = (e) => { S.model = e.target.value.trim() || window.ASR.DEFAULT_MODEL; saveSettings(); renderEngPanel(); };
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
      const r = store.get('resume', null);
      if (r && r.ref === id) { store.set('resume', null); renderContinue(); }
      navBack();
    });
    $('#bv-start').onclick = () => { const { from, to } = bvRange(); openBookReader(BV.book.id, { from, to }); };

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
    document.addEventListener('visibilitychange', () => { if (document.hidden && R.listener) stopListening(); });
  }

  function init() {
    if (window.__ASR_LIB) window.ASR.LocalEngine.lib = window.__ASR_LIB;
    applySettings();
    bind();
    loadSurahs();
    renderContinue();
    refreshMemo();
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings); } catch (e) { /* ignore */ }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // نسخة جديدة من التطبيق نُشرت: نعيد التحميل إن لم يكن المستخدم في منتصف تسميع
        if (!hadController || reloading || !$('#reader').hidden) return;
        reloading = true;
        location.reload();
      });
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
    window.__tasmee = { R, S, DB, loadPdfjs, renderPage, flipText, looksReversed };
  }
  init();
})();
