// اختبارات استكمال تحميل النموذج: node tests/resumable.test.mjs
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { makeResumableFetch, PART_CACHE, MODEL_CACHE } from '../js/resumable.js';

/* ---------- ذاكرة Cache API مبسّطة (غير موجودة في Node) ---------- */
class MemCache {
  constructor() { this.m = new Map(); }
  k(req) { return new URL(typeof req === 'string' ? req : req.url).href; }
  async match(req) {
    const e = this.m.get(this.k(req));
    return e ? new Response(e.body.slice(), { headers: e.headers }) : undefined;
  }
  async put(req, res) { this.m.set(this.k(req), { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] }); }
  async delete(req) { return this.m.delete(this.k(req)); }
  async keys() { return [...this.m.keys()].map((u) => ({ url: u })); }
}
class MemCaches {
  constructor() { this.c = new Map(); }
  async open(n) { if (!this.c.has(n)) this.c.set(n, new MemCache()); return this.c.get(n); }
  async has(n) { return this.c.has(n); }
  async delete(n) { return this.c.delete(n); }
}

/* ---------- خادم يحاكي Hugging Face ---------- */
const SIZE = 1_000_003;
let DATA = crypto.randomBytes(SIZE);
const log = [];
const opt = { ignoreRange: false, dropAt: null, size: () => DATA.length };
const server = http.createServer((req, res) => {
  const range = req.headers.range || null;
  log.push({ method: req.method, url: req.url, range });
  const buf = DATA;
  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': buf.length }); res.end(); return; }
  const m = /bytes=(\d+)-(\d+)?/.exec(range || '');
  if (!m || opt.ignoreRange) { res.writeHead(200, { 'Content-Length': buf.length }); res.end(buf); return; }
  const a = +m[1], b = Math.min(m[2] ? +m[2] : buf.length - 1, buf.length - 1);
  const part = buf.subarray(a, b + 1);
  res.writeHead(206, { 'Content-Length': part.length, 'Content-Range': `bytes ${a}-${b}/${buf.length}` });
  if (opt.dropAt != null && a <= opt.dropAt && opt.dropAt <= b) {
    // ينقطع الاتصال في منتصف الجزء
    const cut = opt.dropAt - a;
    opt.dropAt = null;
    res.write(part.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
    return;
  }
  res.end(part);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const URL1 = `${BASE}/iqbalaesthetic/Basira/resolve/main/onnx/encoder_model_quantized.onnx`;

const CHUNK = 100_000;
const fast = () => Promise.resolve();
const mk = (caches, extra = {}) => makeResumableFetch({ fetch: (...a) => fetch(...a), caches, chunk: CHUNK, wait: fast, ...extra });

// يحاكي ما تفعله transformers.js: قراءة الجسم مع التقدّم، ثم الحفظ في transformers-cache
async function consume(f, url, caches, stopAt, noSave) {
  const res = await f(url);
  assert.strictEqual(res.status, 200);
  const total = +res.headers.get('content-length');
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (stopAt && got >= stopAt) { await reader.cancel(); return { stopped: got, total }; }
  }
  const buf = Buffer.concat(parts);
  if (!noSave) await (await caches.open(MODEL_CACHE)).put(url, new Response(buf, { headers: res.headers }));
  return { buf, total };
}
const ranges = () => log.filter((l) => l.range).map((l) => +/bytes=(\d+)/.exec(l.range)[1]);
const partKeys = async (c) => ((await c.has(PART_CACHE)) ? (await (await c.open(PART_CACHE)).keys()).length : 0);

let pass = 0;
async function t(name, fn) {
  log.length = 0; opt.ignoreRange = false; opt.dropAt = null;
  try { await fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n  ', e.stack); process.exitCode = 1; }
}

await t('تحميل كامل على أجزاء يطابق الملف الأصلي', async () => {
  const c = new MemCaches();
  const { buf, total } = await consume(mk(c).fetch, URL1, c);
  assert.strictEqual(total, SIZE);
  assert.ok(buf.equals(DATA));
  assert.strictEqual(ranges().length, Math.ceil(SIZE / CHUNK));
});

await t('الخروج أثناء التحميل ثم العودة: يُستكمل من حيث توقف', async () => {
  const c = new MemCaches();
  const r1 = await consume(mk(c).fetch, URL1, c, 450_000); // «خرج» المستخدم بعد ٤٥٠ ك.ب
  assert.ok(r1.stopped >= 450_000);
  log.length = 0;
  const { buf } = await consume(mk(c).fetch, URL1, c); // فتح التطبيق من جديد
  assert.ok(buf.equals(DATA));
  const starts = ranges();
  assert.strictEqual(starts[0], 4 * CHUNK, 'يبدأ من أول جزء لم يكتمل، لا من الصفر');
  assert.strictEqual(starts.length, Math.ceil(SIZE / CHUNK) - 4);
});

await t('انقطاع الاتصال في منتصف جزء: يعيد المحاولة من البايت الذي انقطع عنده', async () => {
  const c = new MemCaches();
  opt.dropAt = 250_000;
  const { buf } = await consume(mk(c).fetch, URL1, c);
  assert.ok(buf.equals(DATA));
  assert.ok(ranges().some((s) => s > 200_000 && s < 300_000 && s !== 200_000), 'طلب من منتصف الجزء');
});

await t('بعد حفظ الملف كاملاً تُحذف أجزاؤه (tidy)', async () => {
  const c = new MemCaches();
  const rf = mk(c);
  await consume(rf.fetch, URL1, c);
  assert.ok((await partKeys(c)) > 0);
  await rf.tidy();
  assert.strictEqual(await partKeys(c), 0);
});

await t('forget: يحذف أجزاء ملف حفظه صاحبه في ذاكرة أخرى', async () => {
  const c = new MemCaches();
  const rf = mk(c);
  await consume(rf.fetch, URL1, c, 0, true);
  assert.ok((await partKeys(c)) > 0);
  await rf.forget(URL1);
  assert.strictEqual(await partKeys(c), 0);
});

await t('إن لم يكتمل حفظ المكتبة، تعمل الأجزاء المحفوظة دون إنترنت', async () => {
  const c = new MemCaches();
  await consume(mk(c).fetch, URL1, c, 0, true); // كأن حفظ المكتبة فشل (امتلاء الذاكرة مثلاً)
  await new Promise((r) => setTimeout(r, 50));
  log.length = 0;
  const { buf } = await consume(mk(c).fetch, URL1, c);
  assert.ok(buf.equals(DATA));
  assert.strictEqual(log.length, 0, 'لا طلبات شبكة');
});

await t('خادم لا يدعم الأجزاء: يعمل كما كان (تحميل عادي)', async () => {
  const c = new MemCaches();
  opt.ignoreRange = true;
  const { buf } = await consume(mk(c).fetch, URL1, c);
  assert.ok(buf.equals(DATA));
});

await t('الملفات الصغيرة (json) تمرّ دون تغيير', async () => {
  const c = new MemCaches();
  const r = await mk(c).fetch(`${BASE}/iqbalaesthetic/Basira/resolve/main/config.json`);
  await r.arrayBuffer();
  assert.strictEqual(log[0].range, null);
});

await t('إن أخفى الخادم Content-Range يُعرف الحجم بطلب HEAD', async () => {
  const c = new MemCaches();
  const hide = async (...a) => {
    const r = await fetch(...a);
    const h = new Headers(r.headers); h.delete('content-range');
    return new Response(r.body, { status: r.status, headers: h });
  };
  const { buf } = await consume(makeResumableFetch({ fetch: hide, caches: c, chunk: CHUNK, wait: fast }).fetch, URL1, c);
  assert.ok(buf.equals(DATA));
  assert.ok(log.some((l) => l.method === 'HEAD'));
});

await t('إن تغيّر الملف على الخادم تُحذف الأجزاء القديمة ثم يُحمَّل من جديد', async () => {
  const c = new MemCaches();
  await consume(mk(c).fetch, URL1, c, 300_000);
  DATA = crypto.randomBytes(SIZE + 7);
  await assert.rejects(consume(mk(c).fetch, URL1, c), /model-changed/);
  const { buf } = await consume(mk(c).fetch, URL1, c);
  assert.ok(buf.equals(DATA));
});

await t('دون إنترنت ودون أجزاء محفوظة: يفشل كما كان', async () => {
  const c = new MemCaches();
  const off = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(makeResumableFetch({ fetch: off, caches: c, chunk: CHUNK, wait: fast }).fetch(URL1), /Failed to fetch/);
});

server.close();
console.log(`\n${pass} اختبارات ناجحة`);
