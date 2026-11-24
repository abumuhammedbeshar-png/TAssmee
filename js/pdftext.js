/*
 * pdftext.js — استخراج نص عربي سليم من صفحات PDF
 *
 * ملفات PDF العربية تخزّن النص بطرق مختلفة: بعضها بترتيب منطقي سليم، وبعضها حرفاً حرفاً
 * بترتيب العرض، وبعضها يفصل الحروف الأخيرة (ة، ف، ل…) في عناصر مستقلة فتظهر الكلمات مقطّعة.
 * لذلك نستخرج كل صفحة بطريقتين، ونصلح التقطيع، ثم نختار النص الأقرب إلى عربية سليمة.
 */
(function (root) {
  'use strict';
  const M = root.Matcher || (typeof require !== 'undefined' ? require('./matcher.js') : null);

  const RTL_CH = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
  const LTR_CH = /[A-Za-zÀ-ɏ]/g;
  const AR = /[ء-ي]/;
  const MARKS = /[ً-ٰٟـ]/g;
  const bare = (w) => String(w).replace(MARKS, '');

  /* ---------- أشكال الحروف العربية (أول/وسط/آخر/منفرد) ---------- */
  const FORM = new Map();   // الحرف ← i منفرد | f آخر | I أول | m وسط
  const FBASE = new Map();
  (function build() {
    let prev = null, group = [];
    const flush = () => {
      const kinds = group.length === 4 ? ['i', 'f', 'I', 'm'] : group.length === 2 ? ['i', 'f'] : ['i'];
      group.forEach((c, k) => FORM.set(c, kinds[k] || 'i'));
    };
    for (let c = 0xFE80; c <= 0xFEFC; c++) {
      const ch = String.fromCharCode(c);
      const base = ch.normalize('NFKC');
      FBASE.set(ch, base);
      if (base !== prev) { if (group.length) flush(); group = []; prev = base; }
      group.push(ch);
    }
    flush();
  })();
  const DUAL = new Set('بتثجحخسشصضطظعغفقكلمنهيئ');
  const joinsNext = (c) => { const k = FORM.get(c); return k === 'I' || k === 'm'; };
  const joinsPrev = (c) => { const k = FORM.get(c); return k === 'f' || k === 'm'; };
  const endsWord = (c) => {
    const k = FORM.get(c);
    if (k !== 'i' && k !== 'f') return false;
    const b = FBASE.get(c);
    const last = b[b.length - 1];
    return DUAL.has(last) || last === 'ة' || last === 'ى';
  };

  /** إصلاح المسافات حسب أشكال الحروف (قبل التطبيع): حرف «أول/وسط» لا يُفصل عمّا بعده، وحرف «آخر/وسط» لا يُفصل عمّا قبله */
  function repairForms(s) {
    if (!/[ﺀ-ﻼ]/.test(s)) return s;
    const ch = Array.from(s);
    let out = '';
    const lastBase = () => {
      for (let k = out.length - 1; k >= 0; k--) {
        const c = out[k];
        if (/\s/.test(c)) return null;
        if (!/\p{M}/u.test(c)) return c;
      }
      return null;
    };
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (/\s/.test(c)) {
        let j = i;
        while (j < ch.length && /\s/.test(ch[j])) j++;
        const prev = lastBase(), next = ch[j];
        if (!(prev && next && (joinsNext(prev) || joinsPrev(next)))) out += ch.slice(i, j).join('');
        i = j - 1;
        continue;
      }
      if (FORM.has(c) && !joinsPrev(c)) {
        const prev = lastBase();
        if (prev && endsWord(prev)) out += ' '; // كلمتان ملتصقتان: الأولى انتهت بحرف لا يتصل بما بعده
      }
      out += c;
    }
    return out;
  }

  /* ---------- طريقتا الاستخراج ---------- */
  function streamText(items) {
    let s = '';
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      s += it.str;
      if (it.hasEOL) s += '\n';
    }
    return s.split('\n').map(repairForms).join('\n');
  }

  function fixLtrRuns(arr) {
    const isL = (i) => i.dir === 'ltr' && /[A-Za-z0-9]/.test(i.s);
    const out = arr.slice();
    let k = 0;
    while (k < out.length) {
      if (!isL(out[k])) { k++; continue; }
      let e = k;
      while (e + 1 < out.length && (isL(out[e + 1]) || (/^\s+$/.test(out[e + 1].s) && e + 2 < out.length && isL(out[e + 2])))) e++;
      if (e > k) out.splice(k, e - k + 1, ...out.slice(k, e + 1).reverse());
      k = e + 1;
    }
    return out;
  }

  /** إعادة بناء الأسطر من مواضع العناصر (للملفات التي تخزّن الحروف بترتيب العرض) */
  function geomText(items) {
    const its = [];
    for (const it of items) {
      if (typeof it.str !== 'string' || !it.str || !it.transform) continue;
      const t = it.transform;
      its.push({ s: it.str, dir: it.dir, x: t[4], y: t[5], w: it.width || 0, h: Math.abs(t[3]) || it.height || 10 });
    }
    if (!its.length) return '';
    its.sort((a, b) => b.y - a.y);
    const lines = [];
    for (const it of its) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(L.y - it.y) <= Math.max(L.h, it.h) * 0.5) { L.items.push(it); L.h = Math.max(L.h, it.h); }
      else lines.push({ y: it.y, h: it.h, items: [it] });
    }
    const dys = [];
    for (let i = 1; i < lines.length; i++) dys.push(lines[i - 1].y - lines[i].y);
    const med = dys.length ? dys.slice().sort((a, b) => a - b)[Math.floor(dys.length / 2)] : 0;
    let out = '';
    lines.forEach((L, li) => {
      const all = L.items.map((i) => i.s).join('');
      const r = (all.match(RTL_CH) || []).length, l = (all.match(LTR_CH) || []).length;
      const rtl = r > 0 && r >= l;
      let arr = L.items.slice().sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
      if (rtl) arr = fixLtrRuns(arr);
      let line = '';
      arr.forEach((c, k) => {
        if (k) {
          const p = arr[k - 1];
          const gap = rtl ? p.x - (c.x + c.w) : c.x - (p.x + p.w);
          if (gap > L.h * 0.22 && !/\s$/.test(line) && !/^\s/.test(c.s)) line += ' ';
        }
        line += c.s;
      });
      if (li) out += med && dys[li - 1] > med * 1.5 ? '\n\n' : '\n';
      out += repairForms(line);
    });
    return out;
  }

  function cleanText(s) {
    return String(s || '').normalize('NFKC').replace(/ /g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------- إصلاح التقطيع بعد التطبيع ---------- */
  const isSingle = (w) => { const b = bare(w); return b.length === 1 && AR.test(b) && b !== 'و'; };
  const badStart = (w) => /^[ةى]/.test(bare(w));
  function brokenRatio(t) {
    const ws = String(t || '').split(/\s+/).filter((w) => AR.test(w));
    if (!ws.length) return 0;
    return ws.filter((w) => isSingle(w) || badStart(w)).length / ws.length;
  }
  /** يُطبَّق فقط إذا بدا النص مقطّعاً: يعيد «ة/ى» إلى الكلمة السابقة، ويضمّ الحروف المنفردة */
  function repairBase(t) {
    if (brokenRatio(t) < 0.04) return t;
    return String(t).split('\n').map((line) => {
      const toks = line.split(' ').filter((w) => w !== '');
      const out = [];
      const prevAr = () => out.length && AR.test(bare(out[out.length - 1]).slice(-1));
      for (let w of toks) {
        while (prevAr() && /^[ةى]/.test(w)) {
          const m = w.match(/^[ةى][ً-ٰٟ]*/)[0];
          out[out.length - 1] += m;
          w = w.slice(m.length);
        }
        if (w) out.push(w);
      }
      const res = [];
      for (let k = 0; k < out.length; k++) {
        if (!isSingle(out[k])) { res.push(out[k]); continue; }
        let e = k;
        while (e + 1 < out.length && isSingle(out[e + 1])) e++;
        const nextNum = e + 1 < out.length && /^[\d٠-٩]/.test(out[e + 1]);
        const prev = res.length ? bare(res[res.length - 1]) : '';
        if (e > k) res.push(out.slice(k, e + 1).join(''));                         // «ع ن» ← «عن»
        else if (!nextNum && prev.length > 1 && AR.test(prev.slice(-1))) res[res.length - 1] += out[k]; // «معار ف» ← «معارف»
        else res.push(out[k]);
        k = e;
      }
      return res.join(' ');
    }).join('\n');
  }

  /* ---------- الحكم على جودة النص ---------- */
  const COMMON = new Set(['في', 'من', 'على', 'إلى', 'أن', 'الله', 'التي', 'الذي', 'عن', 'ما', 'لا', 'هذا', 'هذه', 'كان', 'قال', 'هو', 'هي', 'مع', 'كل', 'أو', 'ثم', 'قد', 'لم', 'بين', 'ذلك', 'إذا', 'عند', 'كما', 'إلا', 'وقد', 'وهو', 'فإن', 'التي', 'الذين', 'هذا', 'كانت', 'يكون', 'حتى', 'بعد', 'قبل', 'عليه', 'إن', 'لكن'].map(M.norm));
  const commonScore = (t) => M.words(t).reduce((c, w) => c + (COMMON.has(w) ? 1 : 0), 0);
  function score(t) {
    let ar = 0, bad = 0;
    for (const w of String(t || '').split(/\s+/)) {
      if (!AR.test(w)) continue;
      ar++;
      if (isSingle(w) || badStart(w)) bad++;
    }
    return commonScore(t) * 3 - bad * 4 + ar * 0.02;
  }

  /** نص صفحة واحدة من عناصر pdf.js: أفضل الطريقتين بعد الإصلاح */
  function pageText(items) {
    const a = repairBase(cleanText(streamText(items)));
    const b = repairBase(cleanText(geomText(items)));
    return score(a) >= score(b) ? a : b; // عند التساوي: ترتيب الملف نفسه (أسلم مع الأعمدة)
  }

  const flipLine = (l) => (l.match(/\P{M}\p{M}*/gu) || []).reverse().join('');
  const flipText = (t) => t.split('\n').map(flipLine).join('\n');
  function looksReversed(pages) {
    const sample = pages.slice(0, 15).join('\n').slice(0, 20000);
    const a = commonScore(sample), b = commonScore(flipText(sample));
    return b >= 5 && b > a * 2;
  }
  function detectLang(t) {
    const ar = (t.match(/[؀-ۿ]/g) || []).length;
    const la = (t.match(/[A-Za-z]/g) || []).length;
    return la > ar ? 'en-US' : 'ar-SA';
  }
  const hasText = (t) => String(t || '').replace(/\s/g, '').length >= 10;

  const api = { pageText, streamText, geomText, repairForms, repairBase, brokenRatio, score, cleanText, flipText, looksReversed, detectLang, hasText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfText = api;
})(typeof window !== 'undefined' ? window : globalThis);
