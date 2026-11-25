// اختبارات مطابقة محرّك «المعلّم»: node tests/phonetic.test.js
// تستخدم المرجع الصوتي الحقيقي (data/quran-ph.txt) ونصّ المصحف الإملائي من تنزيل (tests/fixtures).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../js/phonetic.js');
const M = require('../js/matcher.js');

const ref = new P.Ref(fs.readFileSync(path.join(__dirname, '../data/quran-ph.txt'), 'utf8'));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/quran-sample.json'), 'utf8')).surahs;

let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n  ', e.stack.split('\n').slice(0, 3).join('\n   ')); process.exitCode = 1; } }

/** سياق القارئ لسورة: كلماتها وبدايات آياتها، كما يبنيه التطبيق */
function ctxOf(s, pos = 0, strict = 'mid') {
  const words = [], ayahs = [];
  for (const a of FX[s]) { ayahs.push({ start: words.length, k: a.k, g: a.g }); words.push(...M.tokenize(a.text)); }
  return { words, ayahs, pos, strict };
}
const wordIdx = (ctx, k, w = 0) => ctx.ayahs.find((a) => a.k === k).start + w;
/** ما «يُفترض أن يُسمع» للكلمات [a, b) كما في المرجع */
const say = (ctx, a, b) => ref.window(ctx, a, b).W.join('');
const gs = (str, p = 0.95) => Array.from(str).map((c) => ({ c, raw: c, p }));
const st = (res, i) => (res.judged.find((j) => j.i === i) || {}).st;
const sts = (res) => res.judged.map((j) => j.st).join(',');

t('المرجع: ٦٢٣٦ آية، والفاتحة كما في الكتابة الصوتية', () => {
  assert.ok(ref.ok);
  assert.strictEqual(ref.ayah(1), 'بسملاهرحمانرحۦم');
  assert.strictEqual(ref.ayah(6222), 'قلهولاهءحد'); // الإخلاص ١
});

t('تجميع مخرجات النموذج كما في quran-transcript: الشدّة والمدّ مجموعة واحدة', () => {
  assert.strictEqual(P.normPh('بِسمِللَااهِررَحمَاانِ'), 'بسملاهرحمان');
  assert.strictEqual(P.normPh('قَاالَ'), 'قال');
  const g = P.groups('رَببِ', [0.9, 0.9, 0.9, 0.5, 0.9]);
  assert.deepStrictEqual(g.map((x) => x.c).join(''), 'رب');
  assert.strictEqual(P.display(P.groups('ءَلحَمدُلِللَااهِ')), 'ءَلحَمدُلِلَّاهِ');
});

t('توزيع المرجع على الكلمات المعروضة', () => {
  const c = ctxOf('2');
  const w = ref.window(c, wordIdx(c, 5), wordIdx(c, 6));
  const per = {};
  w.W.forEach((ch, k) => { per[w.wi[k]] = (per[w.wi[k]] || '') + ch; });
  const parts = Object.keys(per).map((k) => per[k]);
  assert.deepStrictEqual(parts, ['ءلاءك', 'علا', 'هد', 'م', 'ربهم', 'وءلاءك', 'هم', 'لمفلحۥن']);
});

t('تلاوة صحيحة آيةً آية: كل الكلمات صحيحة والمؤشر يتقدّم', () => {
  const c = ctxOf('1');
  let pos = 0;
  for (const a of c.ayahs) {
    const e = a.k < 7 ? c.ayahs[a.k].start : c.words.length;
    const r = P.judge(ref, gs(say(c, a.start, e)), { ...c, pos });
    assert.ok(r.judged.every((j) => j.st === 'ok'), a.k + ': ' + sts(r));
    assert.strictEqual(r.pos, e);
    pos = r.pos;
  }
  assert.strictEqual(pos, c.words.length);
});

t('وصل آيتين دون وقف (تسقط همزة الوصل في أول الثانية)', () => {
  const c = ctxOf('1');
  const h = ref.ayah(1) + ref.ayah(2).slice(1); // «…الرحيمِ الحمدُ» دون همزة
  const r = P.judge(ref, gs(h), c);
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, c.ayahs[2].start);
});

t('الوقف في وسط الآية ثم الابتداء بهمزة الوصل', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 2), mid = a + 2; // «ذَٰلِكَ الْكِتَابُ» | «لَا رَيْبَ…»
  const r1 = P.judge(ref, gs(say(c, a, mid)), { ...c, pos: a });
  assert.ok(r1.judged.every((j) => j.st === 'ok'), sts(r1));
  assert.strictEqual(r1.pos, mid);
  // ابتداء من «الْكِتَابُ» بعد الوقف: همزة وصل في أوله
  const r2 = P.judge(ref, gs('ء' + say(c, a + 1, mid + 2)), { ...c, pos: a + 1 });
  assert.ok(r2.judged.every((j) => j.st === 'ok'), sts(r2));
});

t('الوقف على كلمة منوّنة (هُدًى ← هُدَا)', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 2), huda = wordIdx(c, 2, 5);
  const r = P.judge(ref, gs(say(c, a, huda + 1) + 'ا'), { ...c, pos: a });
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, huda + 1);
});

t('حرف مبدَّل بثقة عالية = خطأ، ويُعرض ما سُمع', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 5), w = a + 7; // الْمُفْلِحُونَ
  const h = say(c, a, a + 8).replace('لمفلحۥن', 'لمقلحۥن');
  const r = P.judge(ref, gs(h), { ...c, pos: a });
  assert.strictEqual(st(r, w), 'err', sts(r));
  assert.ok(r.judged.filter((j) => j.i !== w).every((j) => j.st === 'ok'), sts(r));
  assert.ok(r.judged.find((j) => j.i === w).heard.includes('ق'));
});

t('الفرق الذي لم يتأكد منه النموذج: صحيحة في المتوسطة، و«غير مؤكدة» في الصارمة', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 5);
  const good = say(c, a, a + 8);
  const k = good.indexOf('وءلاءكهم') + 6; // «هُمُ»
  const g = gs(good.slice(0, k) + 'ب' + good.slice(k + 1));
  g[k].p = 0.7;
  assert.strictEqual(st(P.judge(ref, g, { ...c, pos: a }), a + 6), 'ok');
  assert.strictEqual(st(P.judge(ref, g, { ...c, pos: a, strict: 'high' }), a + 6), 'skip');
});

t('خطأ النطق في حرف متقارب المخرج (الذين ← الزين) ليس خطأ حفظ', () => {
  const c = ctxOf('1');
  const a = wordIdx(c, 7);
  const h = say(c, a, a + 3).replace('لذۦن', 'لزۦن');
  const r = P.judge(ref, gs(h), { ...c, pos: a });
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
});

t('مدّ أو همزة لم يسمعها النموذج لا تُخطّئ الكلمة', () => {
  const c = ctxOf('1');
  const a = wordIdx(c, 2);
  const h = say(c, a, a + 4).replace('لعالمۦن', 'لعلمن').replace('ءلحمد', 'لحمد');
  const r = P.judge(ref, gs(h), { ...c, pos: a });
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
});

t('كلمة أُسقطت = خطأ', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 3); // الَّذِينَ يُؤْمِنُونَ بِالْغَيْبِ …
  const h = say(c, a, a + 1) + say(c, a + 2, a + 6);
  const r = P.judge(ref, gs(h), { ...c, pos: a });
  assert.strictEqual(st(r, a + 1), 'err', sts(r));
  assert.ok([a, a + 2, a + 3, a + 4].every((i) => st(r, i) === 'ok'), sts(r));
});

t('الاستعاذة والبسملة قبل التلاوة لا تُحسب', () => {
  const c = ctxOf('2');
  const h = 'ءعۥذبلاهمنشيطانرجۦم' + 'بسملاهرحمانرحۦم' + ref.ayah(8) + ref.ayah(9);
  const r = P.judge(ref, gs(h), c);
  assert.ok(r.judged.length >= 8 && r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.jumped, false);
});

t('القفز إلى موضع آخر: يتابع القارئ ولا يُخطّئه فيما تخطّاه', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 10);
  const r = P.judge(ref, gs(say(c, a, a + 10)), { ...c, pos: 0 });
  assert.strictEqual(r.jumped, true);
  assert.ok(r.judged.filter((j) => j.i < a).every((j) => j.st === 'skip'));
  assert.ok(r.judged.filter((j) => j.i >= a).every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, a + 10);
});

t('كلام لا علاقة له بالنص: لا حكم', () => {
  const c = ctxOf('112');
  const r = P.judge(ref, gs('سشصضطظغخثزذسشصضطظ'), c);
  assert.strictEqual(r.judged.length, 0);
  assert.strictEqual(r.pos, 0);
});

t('آخر كلمة لم تكتمل: تُؤجَّل ولا تُخطّأ', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 5);
  const h = say(c, a, a + 3) + say(c, a + 3, a + 5).slice(0, 2); // «…مِّن رَّ»
  const r = P.judge(ref, gs(h), { ...c, pos: a });
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.ok(r.pos <= a + 4);
  assert.ok(!r.judged.some((j) => j.i === a + 4));
});

t('إعادة كلمات سبقت ثم المتابعة: لا أخطاء، والمؤشر يتقدّم', () => {
  const c = ctxOf('113');
  const pos = 3;
  const r = P.judge(ref, gs(say(c, 1, 7)), { ...c, pos });
  assert.ok(r.judged.filter((j) => j.i >= pos).every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, 7);
});

t('كلمة اندمج لفظها في جارتيها (قُل لَّن يُصِيبَنَا) تتبعهما', () => {
  const c = ctxOf('9');
  const a = wordIdx(c, 51);
  const r = P.judge(ref, gs(ref.ayah(c.ayahs.find((x) => x.k === 51).g)), { ...c, pos: a });
  assert.ok(r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, c.ayahs.find((x) => x.k === 52).start);
});

t('حرف ناقص: خطأ في الصارمة، ويُتجاوز عنه في المتساهلة', () => {
  const c = ctxOf('2');
  const a = wordIdx(c, 4); // وَالَّذِينَ يُؤْمِنُونَ بِمَا أُنزِلَ إِلَيْكَ …
  const good = say(c, a, a + 5);
  const k = good.indexOf('يءمنۥن') + 2;
  const h = good.slice(0, k) + good.slice(k + 1); // سقط حرف من «يؤمنون»
  assert.strictEqual(st(P.judge(ref, gs(h), { ...c, pos: a, strict: 'high' }), a + 1), 'err');
  assert.strictEqual(st(P.judge(ref, gs(h), { ...c, pos: a, strict: 'low' }), a + 1), 'ok');
});

t('آية مكرّرة (﴿إِنَّ مَعَ الْعُسْرِ يُسْرًا﴾): تُحمل على موضع القارئ لا على ما قبله', () => {
  const c = ctxOf('94');
  const a6 = wordIdx(c, 6);
  const r = P.judge(ref, gs(ref.ayah(c.ayahs.find((x) => x.k === 6).g)), { ...c, pos: a6 });
  assert.ok(r.judged.filter((j) => j.i >= a6).length === 4 && r.judged.every((j) => j.st === 'ok'), sts(r));
  assert.strictEqual(r.pos, wordIdx(c, 7));
});

t('لازمة الرحمن ﴿فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ﴾: القفز إلى أقرب تكرار بعد القارئ', () => {
  const c = ctxOf('55');
  const g13 = c.ayahs.find((x) => x.k === 13);
  const h = ref.ayah(g13.g) + ref.ayah(g13.g + 1);  // الآيتان ١٣ و١٤ (الثانية تميّز الموضع)
  const r = P.judge(ref, gs(h), { ...c, pos: 0 });
  assert.strictEqual(r.jumped, true);
  assert.strictEqual(r.judged.find((j) => j.st === 'ok').i, g13.start);
});

t('Session.apply: يعتمد الحكم ولا يُخطّئ ما قبل الموضع', () => {
  const s = new M.Session(['قل', 'هو', 'الله', 'احد']);
  s.state[0] = 'ok'; s.pos = 1;
  const r = s.apply({ judged: [{ i: 0, st: 'err', heard: 'x' }, { i: 1, st: 'ok' }, { i: 2, st: 'err', heard: 'اللا' }], pos: 3 });
  assert.deepStrictEqual(s.state, ['ok', 'ok', 'err', 'p']);
  assert.strictEqual(s.heard[2], 'اللا');
  assert.strictEqual(s.pos, 3);
  assert.deepStrictEqual(r.changed.sort(), [1, 2]);
});

t('الأداء: سورة البقرة كاملة في البحث عن موضع القارئ', () => {
  const words = [], ayahs = [];
  // كلمات وهمية بعدد كلمات البقرة لا تلزم: نقيس البحث على المرجع نفسه
  let W = '';
  for (let g = 8; g <= 293; g++) W += ref.ayah(g);
  const H = Array.from(ref.ayah(200));
  const t0 = Date.now();
  const r = P.locate(H, Array.from(W), new Uint8Array(Array.from(W).length));
  const ms = Date.now() - t0;
  assert.ok(r.cost < 1, 'cost ' + r.cost);
  assert.ok(ms < 1500, ms + ' ms');
  void words; void ayahs;
});

console.log(`\n${pass} passed`);
