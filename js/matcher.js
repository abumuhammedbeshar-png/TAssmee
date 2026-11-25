/*
 * matcher.js — محرّك التسميع
 * يطابق ما يقوله المستخدم (نص من التعرّف على الكلام) مع النص المحفوظ كلمةً كلمة،
 * بمحاذاة مرنة (برمجة ديناميكية) تتسامح مع أخطاء التعرّف وتكرار القارئ للكلمات.
 */
(function (root) {
  'use strict';

  // التشكيل وعلامات المصحف والتطويل
  const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ]/g;

  function norm(w) {
    if (!w) return '';
    let s = String(w).normalize('NFKC')
      .replace(/و[\u064B-\u065F]*\u0670/g, 'ا') // الرسم العثماني: الصلوٰة → الصلاة
      .replace(DIAC, '');
    s = s
      .replace(/[أإآٱٲٳٵ]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/[ئىی]/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ک/g, 'ك')
      .replace(/ء/g, '')
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
    return s;
  }

  /** يقسم النص إلى كلمات؛ العلامات التي لا حروف فيها تُلحق بالكلمة السابقة للعرض فقط */
  function tokenize(text) {
    const out = [];
    const raw = String(text || '').normalize('NFKC').split(/\s+/);
    for (const t of raw) {
      if (!t) continue;
      const n = norm(t);
      if (!n) {
        if (out.length) out[out.length - 1].disp += ' ' + t;
        continue;
      }
      out.push({ disp: t, n });
    }
    return out;
  }

  function words(text) {
    return tokenize(text).map((t) => t.n);
  }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const c = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  // الرسم العثماني يحذف الألف أو يضيفها (الكتٰب، يٰأيها): نعدّ الفرق في الألف وحده تشابهاً «قريباً»
  // لا يُقبل في الوضع الصارم
  const noAlef = (s) => s.replace(/ا/g, '');
  const loose = (a, b) => { const x = noAlef(a); return x.length > 1 && x === noAlef(b); };

  function sim(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const s = 1 - lev(a, b) / Math.max(a.length, b.length);
    return s < 0.8 && loose(a, b) ? 0.8 : s;
  }

  const STRICTNESS = { low: 0.6, mid: 0.72, high: 0.86 };
  const INS = 1.0;   // كلمة زائدة سُمعت (تكرار/ضوضاء) — تُتجاهل
  const DEL = 1.0;   // كلمة متوقعة لم تُقرأ
  const SUB = 1.05;  // كلمة خاطئة مكان كلمة متوقعة

  /**
   * محاذاة R (كلمات مسموعة) مع T (نافذة من النص تبدأ عند موضع القارئ).
   * بداية النافذة إلزامية، ونهايتها حرّة (لا يُحاسب على ما لم يصل إليه بعد).
   */
  function align(R, T, thr) {
    const n = R.length, m = T.length;
    const W = m + 1;
    const D = new Float64Array((n + 1) * W).fill(Infinity);
    const B = new Int8Array((n + 1) * W);
    const S = new Float32Array((n + 1) * W);
    const at = (i, j) => i * W + j;
    const mthr = Math.max(thr, 0.88); // الدمج/الفصل يحتاج تطابقاً شبه تام كي لا يبتلع كلمة ساقطة
    D[0] = 0;
    for (let j = 1; j <= m; j++) { D[at(0, j)] = j * DEL; B[at(0, j)] = 3; }
    for (let i = 1; i <= n; i++) {
      D[at(i, 0)] = i * INS; B[at(i, 0)] = 2;
      for (let j = 1; j <= m; j++) {
        let best = Infinity, bk = 0, bs = 0;
        const s = sim(R[i - 1], T[j - 1]);
        const c1 = D[at(i - 1, j - 1)] + (s >= thr ? (1 - s) * 0.5 : SUB);
        if (c1 < best) { best = c1; bk = s >= thr ? 1 : 4; bs = s; }
        const c2 = D[at(i - 1, j)] + INS;
        if (c2 < best) { best = c2; bk = 2; }
        const c3 = D[at(i, j - 1)] + DEL;
        if (c3 < best) { best = c3; bk = 3; }
        if (j >= 2) { // كلمة مسموعة واحدة = كلمتان في النص (دمج)
          const cat = T[j - 2] + T[j - 1];
          let s2 = sim(R[i - 1], cat);
          const lz = thr <= 0.8 && loose(R[i - 1], cat);
          if (lz) s2 = Math.max(s2, 0.8);
          if (s2 >= mthr || lz) {
            const c = D[at(i - 1, j - 2)] + 0.1 + (1 - s2) * 0.5;
            if (c < best) { best = c; bk = 5; bs = s2; }
          }
        }
        if (i >= 2) { // كلمتان مسموعتان = كلمة واحدة في النص (فصل)
          const cat = R[i - 2] + R[i - 1];
          let s3 = sim(cat, T[j - 1]);
          const lz = thr <= 0.8 && loose(cat, T[j - 1]);
          if (lz) s3 = Math.max(s3, 0.8);
          if (s3 >= mthr || lz) {
            const c = D[at(i - 2, j - 1)] + 0.1 + (1 - s3) * 0.5;
            if (c < best) { best = c; bk = 6; bs = s3; }
          }
        }
        if (j >= 3) { // كلمة مسموعة = ثلاث قطع في النص (نصوص PDF المقطّعة)
          const cat3 = T[j - 3] + T[j - 2] + T[j - 1];
          const s4 = sim(R[i - 1], cat3);
          if (s4 >= mthr) {
            const c = D[at(i - 1, j - 3)] + 0.15 + (1 - s4) * 0.5;
            if (c < best) { best = c; bk = 7; bs = s4; }
          }
        }
        D[at(i, j)] = best; B[at(i, j)] = bk; S[at(i, j)] = bs;
      }
    }
    let end = 0, bestCost = Infinity;
    for (let j = 0; j <= m; j++) {
      const c = D[at(n, j)];
      if (c < bestCost - 1e-9 || (Math.abs(c - bestCost) < 1e-9 && j > end)) { bestCost = c; end = j; }
    }
    const ops = [];
    let i = n, j = end;
    while (i > 0 || j > 0) {
      const k = B[at(i, j)];
      if (k === 1) { ops.push({ type: 'M', r: [i - 1], t: [j - 1], sim: S[at(i, j)] }); i--; j--; }
      else if (k === 4) { ops.push({ type: 'S', r: [i - 1], t: [j - 1] }); i--; j--; }
      else if (k === 2) { ops.push({ type: 'I', r: [i - 1], t: [] }); i--; }
      else if (k === 3) { ops.push({ type: 'D', r: [], t: [j - 1] }); j--; }
      else if (k === 5) { ops.push({ type: 'M', r: [i - 1], t: [j - 2, j - 1], sim: S[at(i, j)] }); i--; j -= 2; }
      else if (k === 6) { ops.push({ type: 'M', r: [i - 2, i - 1], t: [j - 1], sim: S[at(i, j)] }); i -= 2; j--; }
      else if (k === 7) { ops.push({ type: 'M', r: [i - 1], t: [j - 3, j - 2, j - 1], sim: S[at(i, j)] }); i--; j -= 3; }
      else break;
    }
    ops.reverse();
    return { ops, end, cost: bestCost };
  }

  const countM = (ops) => ops.reduce((a, o) => a + (o.type === 'M' ? o.t.length : 0), 0);

  /**
   * جلسة تسميع على قائمة كلمات.
   * الحالات: p = لم تُقرأ، ok = صحيحة، err = خطأ/سقط، skip = تخطّاها القارئ، hint = كُشفت بتلميح
   */
  class Session {
    constructor(list, opts) {
      this.T = list.map((w) => (typeof w === 'string' ? norm(w) : w.n));
      this.N = this.T.length;
      this.state = new Array(this.N).fill('p');
      this.heard = new Array(this.N).fill('');
      this.pos = 0;
      this.start = 0;
      this.trail = [];
      this.setStrictness((opts && opts.strictness) || 'mid');
    }
    setStrictness(k) { this.thr = STRICTNESS[k] || STRICTNESS.mid; }
    get done() { return this.pos >= this.N; }

    setPos(i) {
      this.pos = Math.max(0, Math.min(this.N, i | 0));
      this.trail = [];
      if (!this.touched()) this.start = this.pos;
    }
    touched() { return this.state.some((s) => s !== 'p'); }

    reset(from) {
      this.state.fill('p'); this.heard.fill('');
      this.trail = [];
      this.pos = this.start = Math.max(0, Math.min(this.N, from | 0));
    }

    _window(n) { return this.T.slice(this.pos, Math.min(this.N, this.pos + n * 2 + 8)); }

    /** معاينة بلا حفظ: الكلمات التي يبدو أنها قُرئت صحيحة الآن (لنتائج التعرّف المؤقتة) */
    preview(text) {
      if (this.done) return [];
      const R = words(text);
      if (!R.length) return [];
      const { ops } = align(R, this._window(R.length), this.thr);
      const out = [];
      for (const o of ops) if (o.type === 'M') for (const t of o.t) out.push(this.pos + t);
      return out;
    }

    /**
     * اعتماد عبارة نهائية من التعرّف.
     * opts.conf: ثقة التعرّف (٠–١). الثقة المنخفضة أو المطابقة الضعيفة لا تُخطّئ القارئ،
     * بل تُعلّم الكلمات «لم تُتحقَّق» كي لا يُتَّهم الحافظ بخطأ لم يرتكبه.
     */
    feed(text, opts) {
      opts = opts || {};
      const toks = tokenize(text);
      const R = toks.map((t) => t.n);
      if (!R.length) return { changed: [], jumped: false };
      let base = this.pos;
      let ops = [], end = 0;
      if (!this.done) ({ ops, end } = align(R, this._window(R.length), this.thr));
      let jumped = false;
      const changed = [];

      if (countM(ops) === 0 && R.length >= 3) {
        // القارئ ليس حيث نظن: نبحث عمّا يقرؤه أمام المؤشر، ثم خلفه (إن عاد إلى موضع سابق)
        // القفز للأمام يحتاج ٤ كلمات متطابقة على الأقل (أقل ضرراً أن نتأخر من أن نقفز خطأً)
        const j = (this.done ? null : this._find(R, this.pos + 1, Math.min(this.N, this.pos + 800), false, 4)) ||
          this._find(R, Math.max(0, this.pos - 1500), this.pos, true, 3);
        if (j) {
          for (let k = this.pos; k < j.at; k++) {
            if (this.state[k] === 'p') { this.state[k] = 'skip'; changed.push(k); }
          }
          base = j.at; ops = j.ops; end = j.end; jumped = true;
          this.trail = [];
        }
      }

      // جودة مطابقة هذه العبارة: كم كلمة متوقّعة طابقت مقابل ما خُطّئ أو سقط
      let mN = 0, badN = 0;
      for (const o of ops) {
        if (o.type === 'M') mN += o.t.length;
        else if (o.type === 'S' || o.type === 'D') badN++;
      }
      const quality = mN + badN ? mN / (mN + badN) : 1;
      const lowConf = opts.conf != null && opts.conf > 0 && opts.conf < 0.55;
      const soft = lowConf || (badN >= 2 && quality < 0.5);
      const bad = soft ? 'skip' : 'err';

      let seenM = false;
      const trailText = this.trail.join(' ');
      let usedTrail = false;
      for (const o of ops) {
        if (o.type === 'M') {
          seenM = true;
          for (const t of o.t) { const g = base + t; if (this.state[g] === 'p' || this.state[g] === 'skip') { this.state[g] = 'ok'; changed.push(g); } }
        } else if (o.type === 'S') {
          const g = base + o.t[0];
          this.state[g] = bad; this.heard[g] = soft ? '' : toks[o.r[0]].disp; changed.push(g);
        } else if (o.type === 'D') {
          const g = base + o.t[0];
          if (this.state[g] === 'p') {
            this.state[g] = bad;
            if (!soft && !seenM && trailText && !usedTrail) { this.heard[g] = trailText; usedTrail = true; }
            changed.push(g);
          }
        }
      }
      // الكلمات الزائدة في آخر العبارة: قد تكون خطأً لم يُحسم بعد
      const tail = [];
      for (let k = ops.length - 1; k >= 0 && ops[k].type === 'I'; k--) tail.unshift(toks[ops[k].r[0]].disp);
      this.trail = end > 0 || tail.length ? tail : this.trail;
      this.pos = base + end;
      return { changed, jumped };
    }

    /**
     * اعتماد حكم جاهز على الكلمات (من محرّك «المعلّم» الذي يحكم بنفسه بالمقارنة الصوتية).
     * res.judged: [{i, st: 'ok'|'err'|'skip', heard}] · res.pos: الموضع الجديد · res.jumped
     * لا نُخطّئ كلمة قبل الموضع الحالي (القارئ يعيد ما قرأه)، ولا نغيّر «صحيحة» إلى «خطأ».
     */
    apply(res) {
      const changed = [];
      const lim = this.pos;
      for (const j of (res && res.judged) || []) {
        const g = j.i;
        if (!(g >= 0 && g < this.N)) continue;
        const s = this.state[g];
        if (j.st === 'ok') {
          if (s === 'p' || s === 'skip') { this.state[g] = 'ok'; changed.push(g); }
        } else if (g >= lim || res.jumped) {
          if (j.st === 'err' && (s === 'p' || s === 'skip')) { this.state[g] = 'err'; this.heard[g] = j.heard || ''; changed.push(g); }
          else if (j.st === 'skip' && s === 'p') { this.state[g] = 'skip'; changed.push(g); }
        }
      }
      if (res && res.pos != null) this.pos = Math.max(0, Math.min(this.N, res.pos | 0));
      this.trail = [];
      return { changed, jumped: !!(res && res.jumped) };
    }

    _find(R, from, to, last, min) {
      const need = Math.max(min || 3, Math.ceil(R.length * 0.7));
      let found = null;
      for (let k = from; k < to; k++) {
        if (sim(R[0], this.T[k]) < this.thr && sim(R[1], this.T[k]) < this.thr) continue;
        const T = this.T.slice(k, Math.min(this.N, k + R.length * 2 + 8));
        const a = align(R, T, this.thr);
        const first = a.ops.find((o) => o.type !== 'I');
        const n = first && first.type === 'M' && first.t[0] === 0 ? countM(a.ops) : 0;
        // الأكثر تطابقاً؛ وعند التساوي: الأقرب إلى المؤشر
        if (n >= need && (!found || n > found.n || (last && n === found.n))) found = { at: k, ops: a.ops, end: a.end, n };
      }
      return found;
    }

    hint() {
      if (this.done) return -1;
      const g = this.pos;
      this.state[g] = 'hint';
      this.pos++;
      this.trail = [];
      return g;
    }

    stats() {
      let ok = 0, err = 0, hint = 0, skip = 0;
      for (const s of this.state) {
        if (s === 'ok') ok++; else if (s === 'err') err++; else if (s === 'hint') hint++; else if (s === 'skip') skip++;
      }
      const judged = ok + err + hint;
      return { ok, err, hint, skip, judged, total: this.N, accuracy: judged ? Math.round((ok / judged) * 100) : 0 };
    }
  }

  const api = { norm, tokenize, words, lev, sim, align, Session, STRICTNESS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
