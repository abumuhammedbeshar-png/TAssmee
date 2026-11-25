/*
 * phonetic.js — مطابقة محرّك «المعلّم» (نموذج HisnLabs Tajweed v2)
 *
 * النموذج لا يكتب كلمات، بل يكتب ما سمعه بـ«الكتابة الصوتية للقرآن» (حروف وحركات ومدود).
 * لذلك لا نسأله «ماذا قلت؟» بل نقارن ما سمعه بما كان يجب أن يُقرأ:
 *   ١. المرجع الصوتي لكل آية (data/quran-ph.txt) يُوزَّع على كلمات المصحف المعروضة.
 *   ٢. ما سمعه النموذج يُحاذى مع مرجع الكلمات التي أمام القارئ (محاذاة تسمح بالبدء والانتهاء في أي موضع).
 *   ٣. لكل كلمة: صحيحة، أو خطأ، أو غير مؤكدة (إن كان الفرق في رموز لم يتأكد منها النموذج).
 * نتسامح مع ما يتغيّر صوتياً بين الوقف والوصل: التنوين والتاء المربوطة في آخر الكلمة، وهمزة الوصل في أولها.
 */
(function (root) {
  'use strict';

  /* ---------- رموز الكتابة الصوتية ---------- */
  // ترتيب مخرجات النموذج (config.json في HisnLabs/tajweed-v2)؛ الفهرس ٠ = فراغ CTC
  const PHONEMES = Array.from('ءبتثجحخدذرزسشصضطظعغفقكلمنهويا') .concat(['ۦ', 'ۥ', 'َ', 'ُ', 'ِ', '۪', 'ـ', 'ٲ', 'ڇ', 'ں', '۾', 'ۜ', 'ؙ']);
  const CORE = 'ءبتثجحخدذرزسشصضطظعغفقكلمنهويا' + 'ۥۦ۾ںـٲ';
  const RESID = 'َُِڇؙ۪ۜ';
  // مجموعة = حرف أساسي (قد يتكرر: شدّة أو مدّ) + علامة واحدة اختيارية — كما في quran-transcript
  const GROUP_RE = new RegExp('(?:' + Array.from(CORE).map((c) => c + '+').join('|') + ')[' + RESID + ']?', 'gu');

  /** يقسم الكتابة الصوتية إلى مجموعات: [{c: الحرف الممثِّل، raw: نص المجموعة، p: ثقة النموذج}] */
  function groups(ph, probs) {
    const out = [];
    const s = String(ph || '');
    GROUP_RE.lastIndex = 0;
    let m;
    while ((m = GROUP_RE.exec(s))) {
      const p = probs && probs.length > m.index ? probs[m.index] : 1;
      out.push({ c: m[0][0], raw: m[0], p });
    }
    return out;
  }
  const normPh = (ph) => groups(ph).map((g) => g.c).join('');

  /* ---------- عرض ما سُمع بحروف مقروءة ---------- */
  const DISP = { 'ۦ': 'ي', 'ۥ': 'و', 'ں': 'ن', '۾': 'م', 'ـ': 'ا', 'ٲ': 'أ' };
  const MADD = 'اۦۥـ';
  function display(gs) {
    let out = '';
    for (const g of gs) {
      const ch = Array.from(g.raw);
      const base = ch[0];
      const b = DISP[base] || base;
      if (MADD.includes(base)) { out += b; continue; }
      const doubled = ch.filter((c) => c === base).length > 1;
      const vowel = ch.find((c) => 'َُِ'.includes(c)) || '';
      out += b + (doubled ? 'ّ' : '') + vowel;
    }
    return out.normalize('NFC');
  }

  /* ---------- هيكل الكلمة المكتوبة (لتوزيع مرجع الآية على كلماتها) ---------- */
  const TANWEEN = /[ًٌٍ]/;
  function letters(word) {
    const out = [];
    for (const ch of String(word || '').normalize('NFC')) {
      if (ch === 'ٰ') { out.push('ا'); continue; }                 // الألف الخنجرية
      if (TANWEEN.test(ch)) { out.push('N'); continue; }          // تنوين: نون تُلفظ وصلاً
      if (ch === 'آ') { out.push('ء', 'ا'); continue; }
      if ('أإؤئء'.includes(ch)) { out.push('ء'); continue; }
      if (ch === 'ٱ') { out.push('ا'); continue; }
      if (ch === 'ک') { out.push('ك'); continue; }
      if (ch === 'ی') { out.push('ي'); continue; }
      if (/[\u0621-\u064A]/.test(ch)) out.push(ch);
    }
    return out;
  }
  // كلفة إسقاط الحرف المكتوب حين لا يُلفظ: ألف «ال» ولامها الشمسية أرخص من لام الكلمة نفسها
  const DROP = { 'N': 0.2, 'ا': 0.6, 'ى': 0.6, 'و': 0.8, 'ي': 0.8 };
  /** حروف الكلمة المكتوبة مع كلفة إسقاط كل حرف: [{c, d}] */
  function skeleton(word) {
    const L = letters(word);
    const out = L.map((c) => ({ c, d: DROP[c] || 1 }));
    // أداة التعريف بعد حرف عطف أو جر اختياري: (و|ف|ب|ك)?ال… ، أو «لل» (لِـ + الـ)
    const p = L.length > 3 && 'وفبك'.includes(L[0]) && L[1] === 'ا' && L[2] === 'ل' ? 1 : 0;
    if (L.length > 2 + p && L[p] === 'ا' && L[p + 1] === 'ل') { out[p].d = 0.3; out[p + 1].d = 0.5; }
    else if (L.length > 3 && L[0] === 'ل' && L[1] === 'ل') out[1].d = 0.5;
    return out;
  }
  // ما يقابل كل حرف مكتوب في الكتابة الصوتية
  const SK = { 'ا': 'اـءٲ', 'ى': 'اۦيـ', 'و': 'وۥ', 'ي': 'يۦ', 'ن': 'نں۾', 'م': 'م۾', 'ة': 'ته', 'ء': 'ءٲا', 'N': 'نں۾' };
  const mapCost = (s, r) => (s === r ? 0 : SK[s] && SK[s].includes(r) ? 0.1 : 1);

  /** يوزّع حروف مرجع الآية على كلماتها: wordOf[k] = رقم الكلمة (داخل الآية) لكل حرف من المرجع */
  function mapAyah(ref, words) {
    const R = Array.from(ref);
    const S = [], sd = [], sw = [];
    words.forEach((w, k) => { for (const x of skeleton(w)) { S.push(x.c); sd.push(x.d); sw.push(k); } });
    const n = R.length, m = S.length, M1 = m + 1;
    const wordOf = new Int16Array(n);
    if (!n || !m) return wordOf;
    const C = new Float32Array((n + 1) * M1), B = new Uint8Array((n + 1) * M1);
    for (let j = 1; j <= m; j++) { C[j] = C[j - 1] + sd[j - 1]; B[j] = 3; }
    for (let i = 1; i <= n; i++) {
      const row = i * M1, prev = row - M1, r = R[i - 1];
      C[row] = C[prev] + 1; B[row] = 2;
      for (let j = 1; j <= m; j++) {
        let best = C[prev + j - 1] + mapCost(S[j - 1], r), b = 1;
        const u = C[prev + j] + 1; if (u < best) { best = u; b = 2; }
        const l = C[row + j - 1] + sd[j - 1]; if (l < best) { best = l; b = 3; }
        C[row + j] = best; B[row + j] = b;
      }
    }
    const at = new Int16Array(n).fill(-1);
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const b = B[i * M1 + j];
      if (b === 1) { at[i - 1] = sw[j - 1]; i--; j--; } else if (b === 2) i--; else j--;
    }
    // حرف صوتي بلا مقابل مكتوب: يتبع الكلمة السابقة (أو اللاحقة في أول الآية)
    let last = -1;
    for (let k = 0; k < n; k++) if (at[k] >= 0) last = at[k]; else at[k] = last;
    let next = words.length - 1;
    for (let k = n - 1; k >= 0; k--) if (at[k] >= 0) next = at[k]; else at[k] = next;
    for (let k = 1; k < n; k++) if (at[k] < at[k - 1]) at[k] = at[k - 1];
    wordOf.set(at);
    return wordOf;
  }

  /* ---------- المرجع الصوتي للمصحف ---------- */
  class Ref {
    constructor(text) {
      this.lines = String(text || '').split('\n').filter((l) => l && l[0] !== '#');
      this.maps = new Map();
    }
    get ok() { return this.lines.length === 6236; }
    ayah(g) { return this.lines[g - 1] || ''; }
    /** توزيع آية على كلماتها المعروضة (مع ذاكرة) */
    wordMap(g, words) {
      const key = g + '|' + words.length;
      let m = this.maps.get(key);
      if (!m) { m = mapAyah(this.ayah(g), words); this.maps.set(key, m); }
      return m;
    }
    /**
     * مرجع الكلمات [lo, hi) من نصّ القارئ: الحروف، ورقم الكلمة لكل حرف، وعلامات (١ أول الآية، ٢ آخرها).
     * ctx.words: كلمات النص ({disp}) · ctx.ayahs: [{start, g}] مرتبة
     */
    window(ctx, lo, hi) {
      const W = [], wi = [], F = [];
      const A = ctx.ayahs, N = ctx.words.length;
      for (let a = 0; a < A.length; a++) {
        const s = A[a].start, e = a + 1 < A.length ? A[a + 1].start : N;
        if (e <= lo || s >= hi) continue;
        const ref = Array.from(this.ayah(A[a].g));
        if (!ref.length) continue;
        const map = this.wordMap(A[a].g, ctx.words.slice(s, e).map((w) => w.disp || w));
        for (let k = 0; k < ref.length; k++) {
          const g = s + map[k];
          if (g < lo || g >= hi) continue;
          W.push(ref[k]); wi.push(g);
          F.push((k === 0 ? 1 : 0) | (k === ref.length - 1 ? 2 : 0));
        }
      }
      return { W, wi, F: Uint8Array.from(F) };
    }
  }

  /* ---------- المحاذاة ---------- */
  const NEAR = { 'ں': 'ن', '۾': 'م', 'ـ': 'ا', 'ٲ': 'ء', 'ۦ': 'ي', 'ۥ': 'و' };
  const NASAL = 'نمں۾';
  function sub(a, b) {
    if (a === b) return 0;
    if ((NEAR[a] || a) === (NEAR[b] || b)) return 0.3;
    if (NASAL.includes(a) && NASAL.includes(b) && ('ں۾'.includes(a) || 'ں۾'.includes(b))) return 0.3;
    return 1;
  }
  const insCost = (H, i) => (i === 0 && H[0] === 'ء' ? 0.15 : 1);       // همزة الوصل عند الابتداء
  const delCost = (W, F, j) => (W[j] === 'ء' && F[j] & 1 ? 0.2 : 1);     // همزة أول الآية تسقط وصلاً

  /**
   * محاذاة ما سُمع H كاملاً مع جزء من المرجع W. النهاية في W حرّة، والبداية حرّة فيما قبل موضع القارئ
   * (pre[j] = كلفة تخطّي الحرف j قبل أول ما قُرئ: صفر لما قرأه سابقاً، وكلفة حذف لما لم يقرأه بعد).
   */
  function align(H, W, F, pre, near) {
    const n = H.length, m = W.length, M1 = m + 1;
    const C = new Float32Array((n + 1) * M1), B = new Uint8Array((n + 1) * M1), S = new Int32Array((n + 1) * M1);
    for (let j = 0; j <= m; j++) { S[j] = j; if (j) C[j] = C[j - 1] + (pre ? pre[j - 1] : 0); }
    for (let i = 1; i <= n; i++) {
      const row = i * M1, prev = row - M1, h = H[i - 1], ins = insCost(H, i - 1);
      C[row] = C[prev] + ins; B[row] = 2; S[row] = 0;
      for (let j = 1; j <= m; j++) {
        let best = C[prev + j - 1] + sub(h, W[j - 1]), b = 1, st = S[prev + j - 1];
        const u = C[prev + j] + ins; if (u < best) { best = u; b = 2; st = S[prev + j]; }
        // عند التساوي نفضّل الحذف: يقع الحذف على الكلمة اللاحقة كاملة («قرأ الأولى وأسقط الثانية»)
        const l = C[row + j - 1] + delCost(W, F, j - 1); if (l <= best) { best = l; b = 3; st = S[row + j - 1]; }
        C[row + j] = best; B[row + j] = b; S[row + j] = st;
      }
    }
    // أفضل نهاية؛ وعند التساوي (نصّ مكرّر مثل ﴿إِنَّ مَعَ الْعُسْرِ يُسْرًا﴾) نختار ما يبدأ من موضع القارئ لا ما قبله
    const last = n * M1;
    let cost = Infinity;
    for (let j = 0; j <= m; j++) if (C[last + j] < cost) cost = C[last + j];
    let jEnd = -1, first = -1;
    for (let j = 0; j <= m; j++) {
      if (C[last + j] > cost + 1e-6) continue;
      if (first < 0) first = j;
      if (near != null && S[last + j] >= near) { jEnd = j; break; }
    }
    if (jEnd < 0) jEnd = first;
    const ops = [];
    let i = n, j = jEnd;
    while (i > 0) {
      const b = B[i * M1 + j];
      if (b === 1) { ops.push({ t: sub(H[i - 1], W[j - 1]) < 0.5 ? 'M' : 'S', i: i - 1, j: j - 1 }); i--; j--; }
      else if (b === 2) { ops.push({ t: 'I', i: i - 1, j }); i--; }
      else { ops.push({ t: 'D', i: -1, j: j - 1 }); j--; }
    }
    ops.reverse();
    return { cost, ops, jStart: j, jEnd };
  }

  /**
   * بحث سريع (صفّان فقط) عن أفضل موضع لما سُمع في مرجع طويل: سورة كاملة.
   * near: موضع القارئ في W؛ عند تساوي المواضع (آية تتكرّر) نختار أقربها بعده.
   */
  function locate(H, W, F, near) {
    const n = H.length, m = W.length;
    let pc = new Float32Array(m + 1), cc = new Float32Array(m + 1);
    let ps = new Int32Array(m + 1), cs = new Int32Array(m + 1);
    for (let j = 0; j <= m; j++) ps[j] = j;
    for (let i = 1; i <= n; i++) {
      const h = H[i - 1], ins = insCost(H, i - 1);
      cc[0] = pc[0] + ins; cs[0] = 0;
      for (let j = 1; j <= m; j++) {
        let best = pc[j - 1] + sub(h, W[j - 1]), s = ps[j - 1];
        const u = pc[j] + ins; if (u < best) { best = u; s = ps[j]; }
        const l = cc[j - 1] + delCost(W, F, j - 1); if (l < best) { best = l; s = cs[j - 1]; }
        cc[j] = best; cs[j] = s;
      }
      [pc, cc] = [cc, pc]; [ps, cs] = [cs, ps];
    }
    let cost = Infinity;
    for (let j = 0; j <= m; j++) if (pc[j] < cost) cost = pc[j];
    near = near | 0;
    let jEnd = -1, back = -1;
    for (let j = 0; j <= m; j++) {
      if (pc[j] > cost + 1e-6) continue;
      if (ps[j] >= near) { jEnd = j; break; }
      back = j;
    }
    if (jEnd < 0) jEnd = back;
    return { cost, jStart: ps[jEnd], jEnd };
  }

  /* ---------- ما يُتجاهل في أول التلاوة: الاستعاذة والبسملة ---------- */
  const ISTI = Array.from('ءعۥذبلاهمنشيطانرجۦم');
  const BASM = Array.from('بسملاهرحمانرحۦم');
  function lev(a, b) {
    const m = b.length;
    let p = new Array(m + 1), c = new Array(m + 1);
    for (let j = 0; j <= m; j++) p[j] = j;
    for (let i = 1; i <= a.length; i++) {
      c[0] = i;
      for (let j = 1; j <= m; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [p, c] = [c, p];
    }
    return p[m];
  }
  function stripPrefix(H, P) {
    let best = Infinity, k = 0;
    for (let L = P.length - 4; L <= P.length + 4; L++) {
      if (L < 1 || L > H.length) continue;
      const d = lev(H.slice(0, L), P);
      if (d < best) { best = d; k = L; }
    }
    return best <= Math.max(2, Math.floor(P.length * 0.2)) ? k : 0;
  }

  /* ---------- الحكم على الكلمات ---------- */
  // ثقة النموذج فيما سمعه: حرف مختلف سمعه بثقة عالية «خطأ مؤكد»، وما دون ذلك «فرق محتمل» بوزن أقل
  const SURE = 0.85;
  const weightOf = (p) => (p >= SURE ? 1 : p >= 0.6 ? 0.75 : 0.5);
  const END_Z = 'ناتهمںۦۥيو۾'; // ما يتغيّر في آخر الكلمة بين الوقف والوصل (تنوين، تاء مربوطة، مدّ…)
  /**
   * الحكم على كلمة من فروقها. hard: حروف مختلفة أو زائدة سمعها النموذج بثقة. soft: حروف ناقصة وفروق غير مؤكدة.
   * L: عدد رموز الكلمة. المتوسطة: الحرف المختلف بثقة خطأ دائماً، ويُتجاوز عن نقص حرف في الكلمة الطويلة.
   */
  function verdict(hard, soft, L, strict) {
    if (strict === 'low') {
      const tol = L >= 10 ? 2 : L >= 5 ? 1 : 0, e = hard + soft;
      return e <= tol + 1e-6 ? 'ok' : e <= tol + 1 + 1e-6 ? 'skip' : 'err';
    }
    if (hard > 0) return 'err';
    // حرف ناقص واحد قد يكون من سرعة القراءة لا خطأً: «غير مؤكد» في المتوسطة، و«خطأ» في الصارمة
    const tol = strict === 'high' ? 0 : L >= 7 ? 1 : 0;
    return soft <= tol + 1e-6 ? 'ok' : soft <= tol + (strict === 'high' ? 0.5 : 1) + 1e-6 ? 'skip' : 'err';
  }

  /**
   * يحكم على ما سُمع في عبارة واحدة.
   * gs: مجموعات ما سمعه النموذج (groups) · ctx: {words, ayahs, pos, strict}
   * يعيد {judged: [{i, st: 'ok'|'err'|'skip', heard}], pos, jumped, text, preview} أو null إن لم يُفهم شيء.
   */
  function judge(ref, gs, ctx) {
    let G = gs.slice();
    let k = stripPrefix(G.map((g) => g.c), ISTI);
    if (k) G = G.slice(k);
    let firstAyah = null;
    for (const a of ctx.ayahs) if (a.start <= ctx.pos) firstAyah = a;
    if (!(firstAyah && firstAyah.g === 1)) { k = stripPrefix(G.map((g) => g.c), BASM); if (k) G = G.slice(k); }
    const H = G.map((g) => g.c);
    const n = H.length;
    const text0 = display(G);
    if (n < 3) return null;

    const N = ctx.words.length, pos = Math.min(ctx.pos | 0, N);
    let lo = Math.max(0, pos - 4), hi = Math.min(N, pos + 12 + Math.ceil(n / 2));
    let win = ref.window(ctx, lo, hi);
    // تخطّي ما لم يُقرأ بعد في أول العبارة له كلفة الحذف: «قرأ الكلمة الأولى وأسقط الثانية» لا «أسقط الأولى وأخطأ في الثانية»
    const preOf = (w) => w.wi.map((g) => (g >= pos ? 1 : 0));
    const nearOf = (w) => { const k = w.wi.findIndex((g) => g >= pos); return k < 0 ? w.W.length : k; };
    let a = win.W.length ? align(H, win.W, win.F, preOf(win), nearOf(win)) : null;
    let jumped = false;
    const good = (x, lim) => x && x.cost / n <= lim && x.ops.filter((o) => o.t === 'M').length >= n * 0.5;

    if (!good(a, 0.4)) {
      // القارئ ليس حيث نظن: نبحث في النص كله
      if (n < 10) return { judged: [], pos, jumped: false, text: text0, preview: [] };
      const all = ref.window(ctx, 0, N);
      if (!all.W.length) return null;
      let near = all.wi.findIndex((g) => g >= pos);
      if (near < 0) near = all.W.length;
      const r = locate(H, all.W, all.F, near);
      if (r.cost / n > 0.3) return { judged: [], pos, jumped: false, text: text0, preview: [] };
      const s = Math.max(0, r.jStart - 2), e = Math.min(all.W.length, r.jEnd + 2);
      lo = all.wi[s]; hi = all.wi[e - 1] + 1;
      win = ref.window(ctx, lo, hi);
      a = align(H, win.W, win.F, null, nearOf(win));   // موضع جديد وجدناه بالبحث: بدايته حرّة
      if (!good(a, 0.3)) return { judged: [], pos, jumped: false, text: text0, preview: [] };
      jumped = true;
    }

    const { W, wi, F } = win;
    const { ops, jStart, jEnd } = a;
    if (jEnd <= jStart) return { judged: [], pos, jumped: false, text: text0, preview: [] };
    const wFirst = wi[jStart], wLast = wi[jEnd - 1];

    // حدود كل كلمة في المرجع
    const span = new Map();
    for (let j = 0; j < W.length; j++) {
      const s = span.get(wi[j]);
      if (s) s[1] = j + 1; else span.set(wi[j], [j, j + 1]);
    }
    // الفروق لكل كلمة
    const per = new Map();
    const P = (w) => { let x = per.get(w); if (!x) per.set(w, (x = { e: [], hi: [] })); return x; };
    const weight = (i) => (i >= 0 ? weightOf(G[i].p) : 1);
    for (const o of ops) {
      if (o.t === 'I') {
        const w = o.j > jStart ? wi[o.j - 1] : wi[Math.min(o.j, jEnd - 1)];
        P(w).e.push({ t: 'I', j: o.j, h: H[o.i], r: '', wt: weight(o.i) });
        P(w).hi.push(o.i);
      } else {
        const w = wi[o.j];
        if (o.t !== 'D') P(w).hi.push(o.i);
        if (o.t === 'S') P(w).e.push({ t: 'S', j: o.j, h: H[o.i], r: W[o.j], wt: weight(o.i) });
        else if (o.t === 'D') P(w).e.push({ t: 'D', j: o.j, h: '', r: W[o.j], wt: W[o.j] === 'ء' && F[o.j] & 1 ? 0 : 1 });
      }
    }
    // أول كلمة بدأ القارئ من وسطها، أو آخر كلمة توقّف قبل تمامها: الحروف الناقصة فروق
    const [f0] = span.get(wFirst);
    for (let j = f0; j < jStart; j++) if (!(W[j] === 'ء')) P(wFirst).e.push({ t: 'D', j, h: '', r: W[j], wt: 1 });
    const [, l1] = span.get(wLast);
    for (let j = jEnd; j < l1; j++) P(wLast).e.push({ t: 'D', j, h: '', r: W[j], wt: 1 });

    const judged = [];
    let okN = 0, errN = 0;
    for (let w = wFirst; w <= wLast; w++) {
      const sp = span.get(w);
      // كلمة اندمج لفظها كله في جارتيها (إدغام «مِن نَّـ»): تتبعهما
      if (!sp) { judged.push({ i: w, st: 'merge', heard: '' }); continue; }
      const [s, e] = sp;
      const L = e - s;
      const x = per.get(w) || { e: [], hi: [] };
      let edits = x.e.slice();
      const ayahEnd = F[e - 1] & 2, ayahStart = F[s] & 1;
      // الوقف والوصل في آخر الكلمة: نتجاوز عن فرق واحد
      if (w === wLast || ayahEnd) {
        const k2 = edits.findIndex((d) => (d.j >= e - 1 || (d.t === 'I' && d.j >= e)) && (!d.h || END_Z.includes(d.h)) && (!d.r || END_Z.includes(d.r)));
        if (k2 >= 0) edits.splice(k2, 1);
      }
      // همزة الوصل في أول الكلمة عند الابتداء، أو سقوطها عند الوصل
      if (w === wFirst || ayahStart) edits = edits.filter((d) => !(d.j <= s && (d.h === 'ء' || d.r === 'ء')));
      let hard = 0, soft = 0;
      for (const d of edits) if (d.t !== 'D' && d.wt >= 1) hard++; else soft += d.wt;
      const st = verdict(hard, soft, L, ctx.strict || 'mid');
      const heard = display(x.hi.filter((i) => i >= 0).sort((p, q) => p - q).map((i) => G[i]));
      judged.push({ i: w, st, heard, ayahEnd: !!ayahEnd });
      if (w >= pos) { if (st === 'ok') okN++; else if (st === 'err') errN++; }
    }

    judged.forEach((j, k) => {
      if (j.st !== 'merge') return;
      const a = judged[k - 1], b = judged[k + 1];
      j.st = a && b && a.st === 'ok' && b.st === 'ok' ? 'ok' : 'skip';
    });
    // آخر كلمة لم تُقرأ صحيحة: لا نحكم عليها حتى يتابع القارئ (قد يكون توقّف في منتصفها)
    let newPos = wLast + 1;
    const lastJ = judged[judged.length - 1];
    if (lastJ && lastJ.i === wLast && lastJ.st !== 'ok' && !lastJ.ayahEnd) { judged.pop(); newPos = wLast; }
    // إن بدت المطابقة ضعيفة لا نُخطّئ القارئ (قد يكون الخلل في السماع)
    if (errN >= 2 && okN / (okN + errN) < 0.5) for (const j of judged) if (j.st === 'err') j.st = 'skip';

    // كلمات تخطّاها القارئ قبل أول ما قرأ
    const before = [];
    if (!jumped && wFirst > pos) {
      if (wFirst - pos <= 2) for (let w = pos; w < wFirst; w++) before.push({ i: w, st: 'err', heard: '' });
      else { for (let w = pos; w < wFirst; w++) before.push({ i: w, st: 'skip', heard: '' }); jumped = true; }
    } else if (jumped && wFirst > pos) for (let w = pos; w < wFirst; w++) before.push({ i: w, st: 'skip', heard: '' });
    // من أعاد ما قرأه قبل الموضع الحالي لا نرجع به إلى الوراء
    if (!jumped && newPos < pos) newPos = pos;

    const all = before.concat(judged).map(({ i, st, heard }) => ({ i, st, heard }));
    const text = judged.map((j) => (j.st === 'err' ? j.heard || '…' : ctx.words[j.i].disp || ctx.words[j.i])).join(' ');
    return { judged: all, pos: newPos, jumped, text: text || text0, preview: judged.filter((j) => j.st === 'ok').map((j) => j.i) };
  }

  /** لما لا سياق له (البحث بالتلاوة): نصّ تقريبي مما سُمع */
  const roughText = (gs) => display(gs);

  const api = { PHONEMES, groups, normPh, display, skeleton, mapAyah, Ref, align, locate, judge, roughText, stripPrefix, ISTI, BASM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Phonetic = api;
})(typeof window !== 'undefined' ? window : globalThis);
