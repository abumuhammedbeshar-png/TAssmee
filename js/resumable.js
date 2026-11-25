/*
 * resumable.js — تحميل ملفات النموذج الكبيرة (‎.onnx) على أجزاء تُحفظ أولاً بأول.
 * إن خرجتَ من التطبيق أو انقطع الاتصال أثناء التحميل، يُستكمل في المرة التالية
 * من حيث توقف بدل البدء من الصفر.
 *
 * يُغلِّف fetch داخل الـWorker: كل الطلبات تمرّ كما هي، إلا ملفات ‎.onnx الكبيرة
 * فتُحمَّل بطلبات Range بحجم CHUNK وتُحفظ في ذاكرة «tasmee-partial».
 * تبقى المكتبة (transformers.js) هي من يحفظ الملف الكامل في «transformers-cache»،
 * وبعدها تُحذف الأجزاء.
 */
export const PART_CACHE = 'tasmee-partial';
export const MODEL_CACHE = 'transformers-cache';
const CHUNK = 4 * 1024 * 1024;
const MARK = 'tasmee-part=';

const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '');
const isBig = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && /\.onnx(_data)?$/i.test(x.pathname);
  } catch (e) {
    return false;
  }
};
const totalOf = (h) => {
  const m = /\/\s*(\d+)\s*$/.exec(h || '');
  return m ? +m[1] : 0;
};
const baseOf = (u) => {
  const i = u.indexOf(MARK);
  return i > 0 ? u.slice(0, i - 1) : u;
};
function join(parts, size) {
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function makeResumableFetch(o = {}) {
  const orig = o.fetch;
  const store = o.caches;
  const chunk = o.chunk || CHUNK;
  const tries = o.tries || 6;
  const wait = o.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onNet = o.onNet || (() => {});
  const key = (url, part) => new URL(url + (url.includes('?') ? '&' : '?') + MARK + part).href;
  const backoff = (n) => Math.min(15000, 1000 * 2 ** (n - 1));

  async function wipe(cache, url) {
    const pre = key(url, '');
    for (const r of await cache.keys()) if (r.url.startsWith(pre)) await cache.delete(r);
  }

  async function readMeta(cache, url) {
    try {
      const r = await cache.match(key(url, 'meta'));
      return r ? await r.json() : null;
    } catch (e) {
      return null;
    }
  }

  async function savedPart(cache, url, idx, len) {
    try {
      const r = await cache.match(key(url, idx));
      if (!r) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      return b.length === len ? b : null;
    } catch (e) {
      return null;
    }
  }

  const range = (url, from, to) => orig(url, { headers: { Range: `bytes=${from}-${to}` }, cache: 'no-store' });

  async function sizeOf(url) {
    try {
      const h = await orig(url, { method: 'HEAD', cache: 'no-store' });
      const n = +h.headers.get('content-length');
      return h.ok && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  // بعد اكتمال الملف: ننتظر حتى تحفظه المكتبة، ثم نحذف أجزاءه
  async function settle(url) {
    for (let k = 0; k < 90; k++) {
      await wait(2000);
      try {
        const m = await store.open(MODEL_CACHE);
        if (await m.match(url)) { await wipe(await store.open(PART_CACHE), url); return; }
      } catch (e) {
        return;
      }
    }
  }

  function body(url, cache, total, first) {
    const n = Math.ceil(total / chunk);
    const len = (i) => Math.min(chunk, total - i * chunk);
    let next = 0;
    let cur = null; // الجزء الجاري تحميله: { idx, got, parts, reader, fails }
    if (first) { cur = { idx: 0, got: 0, parts: [], reader: first.body.getReader(), fails: 0 }; next = 1; }
    const drop = () => {
      if (cur && cur.reader) {
        const r = cur.reader;
        cur.reader = null;
        try { r.cancel().catch(() => {}); } catch (e) { /* ignore */ }
      }
    };
    return new ReadableStream({
      async pull(ctl) {
        for (;;) {
          if (!cur) {
            if (next >= n) { ctl.close(); settle(url); return; }
            const idx = next++;
            const b = await savedPart(cache, url, idx, len(idx));
            if (b) { ctl.enqueue(b); return; }
            cur = { idx, got: 0, parts: [], reader: null, fails: 0 };
          }
          const size = len(cur.idx);
          const start = cur.idx * chunk;
          try {
            if (!cur.reader) {
              const r = await range(url, start + cur.got, start + size - 1);
              if (r.status !== 206) {
                try { r.body && r.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
                throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
              }
              const t = totalOf(r.headers.get('content-range'));
              if (t && t !== total) {
                try { r.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
                throw Object.assign(new Error('model-changed'), { changed: true });
              }
              cur.reader = r.body.getReader();
            }
            const { done, value } = await cur.reader.read();
            if (done) { cur.reader = null; throw new Error('short-read'); }
            const v = value.length > size - cur.got ? value.subarray(0, size - cur.got) : value;
            cur.parts.push(v);
            cur.got += v.length;
            cur.fails = 0;
            if (cur.got === size) {
              const idx = cur.idx;
              const whole = join(cur.parts, size);
              drop();
              cur = null;
              await cache.put(key(url, idx), new Response(whole)).catch(() => {});
            }
            if (v.length) { ctl.enqueue(v); return; }
          } catch (e) {
            drop();
            if (e && e.changed) { await wipe(cache, url).catch(() => {}); ctl.error(e); return; }
            const permanent = e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
            if (permanent || ++cur.fails >= tries) { ctl.error(e); return; }
            await wait(backoff(cur.fails)); // نعيد المحاولة من حيث انقطع داخل الجزء نفسه
          }
        }
      },
      cancel() { drop(); },
    });
  }

  const reply = (stream, total) => new Response(stream, {
    status: 200,
    headers: { 'Content-Length': String(total), 'Content-Type': 'application/octet-stream' },
  });

  async function resumable(url) {
    const cache = await store.open(PART_CACHE);
    let meta = await readMeta(cache, url);
    if (meta && (meta.chunk !== chunk || !(meta.total > 0))) { await wipe(cache, url); meta = null; }
    if (meta) return reply(body(url, cache, meta.total, null), meta.total);

    // أول مرة: نطلب الجزء الأول، ومنه نعرف حجم الملف
    let r = null;
    for (let a = 1; ; a++) {
      try { r = await range(url, 0, chunk - 1); break; } catch (e) {
        if (a >= 2) return orig(url);
        await wait(backoff(a));
      }
    }
    if (r.status !== 206) return r; // الخادم لا يدعم الأجزاء أو أعاد خطأ: نترك المكتبة تتصرف كما كانت
    let total = totalOf(r.headers.get('content-range'));
    if (!total) total = await sizeOf(url);
    if (!total) {
      try { r.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
      return orig(url);
    }
    await cache.put(key(url, 'meta'), new Response(JSON.stringify({ total, chunk }))).catch(() => {});
    return reply(body(url, cache, total, r), total);
  }

  function fetchWrapped(input, init) {
    const url = urlOf(input);
    try { onNet(url); } catch (e) { /* ignore */ }
    const method = String((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
    let ranged = false;
    try { ranged = !!(init && init.headers && new Headers(init.headers).has('range')); } catch (e) { /* ignore */ }
    if (!store || method !== 'GET' || ranged || !isBig(url)) return orig(input, init);
    return resumable(url).catch(() => orig(input, init));
  }

  // يحذف أجزاء الملفات التي صارت محفوظة كاملة لدى المكتبة
  async function tidy() {
    if (!store || !(await store.has(PART_CACHE))) return;
    const part = await store.open(PART_CACHE);
    const model = await store.open(MODEL_CACHE);
    const bases = new Set((await part.keys()).map((r) => baseOf(r.url)));
    for (const u of bases) if (await model.match(u)) await wipe(part, u);
    if (!(await part.keys()).length) await store.delete(PART_CACHE);
  }

  // حذف أجزاء ملف بعد أن حفظه صاحبه كاملاً في ذاكرته الخاصة
  async function forget(url) {
    if (!store || !(await store.has(PART_CACHE))) return;
    await wipe(await store.open(PART_CACHE), url);
  }

  return { fetch: fetchWrapped, tidy, forget };
}
