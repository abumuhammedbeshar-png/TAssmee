const assert = require('assert');
const M = require('../js/matcher.js');

let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n  ', e.message); process.exitCode = 1; } }

const FATIHA = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ الرَّحْمَٰنِ الرَّحِيمِ مَالِكِ يَوْمِ الدِّينِ إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ';
const mk = (txt, s) => new M.Session(M.tokenize(txt), { strictness: s || 'mid' });

t('norm strips diacritics & unifies letters', () => {
  assert.strictEqual(M.norm('ٱلرَّحْمَٰنِ'), 'الرحمن');
  assert.strictEqual(M.norm('إِيَّاكَ'), 'اياك');
  assert.strictEqual(M.norm('الصَّلَاةَ'), 'الصلاه');
  assert.strictEqual(M.norm('ۛ'), '');
  assert.strictEqual(M.norm('ﷲ'), 'الله');
  assert.strictEqual(M.norm('Hello,'), 'hello');
});

t('tokenize attaches waqf marks to previous word', () => {
  const w = M.tokenize('لَا رَيْبَ ۛ فِيهِ ۛ هُدًى');
  assert.deepStrictEqual(w.map((x) => x.n), ['لا', 'ريب', 'فيه', 'هدي']);
  assert.ok(w[1].disp.includes('ۛ'));
});

t('perfect recitation in chunks (plain text vs diacritized)', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم');
  s.feed('الحمد لله رب العالمين');
  s.feed('الرحمن الرحيم مالك يوم الدين');
  s.feed('اياك نعبد واياك نستعين');
  const st = s.stats();
  assert.strictEqual(st.ok, 17); assert.strictEqual(st.err, 0); assert.ok(s.done);
});

t('ASR spelling variants still count as correct', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمان الرحيم الحمد لله رب العالمين');
  assert.strictEqual(s.stats().err, 0); assert.strictEqual(s.pos, 8);
});

t('wrong word inside a phrase is flagged with what was heard', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم الحمد لله رب الناس الرحمن الرحيم');
  assert.strictEqual(s.state[7], 'err');
  assert.strictEqual(s.heard[7], 'الناس');
  assert.strictEqual(s.pos, 10);
});

t('wrong word at end of phrase waits, then is flagged when reader moves on', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم الحمد لله رب الناس');
  assert.strictEqual(s.pos, 7); assert.strictEqual(s.state[7], 'p');
  s.feed('الرحمن الرحيم مالك');
  assert.strictEqual(s.state[7], 'err'); assert.strictEqual(s.heard[7], 'الناس');
});

t('wrong word at end, then corrected → counted correct', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم الحمد لله رب الناس');
  s.feed('العالمين');
  assert.strictEqual(s.state[7], 'ok');
});

t('skipped word is flagged as missed', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم الحمد لله العالمين الرحمن');
  assert.strictEqual(s.state[6], 'err'); assert.strictEqual(s.heard[6], '');
  assert.strictEqual(s.state[7], 'ok');
});

t('repeating previous words is ignored', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله الرحمن الرحيم الحمد لله رب العالمين');
  s.feed('رب العالمين الرحمن الرحيم');
  assert.strictEqual(s.stats().err, 0); assert.strictEqual(s.pos, 10);
});

t('merged / split words from the recognizer', () => {
  const s = mk('وَإِيَّاكَ نَسْتَعِينُ يَا أَيُّهَا النَّاسُ');
  s.feed('و اياك نستعين ياايها الناس');
  assert.strictEqual(s.stats().err, 0); assert.ok(s.done);
});

t('noise does not move the cursor or add errors', () => {
  const s = mk(FATIHA);
  s.feed('بسم الله');
  s.feed('ok google play music');
  assert.strictEqual(s.pos, 2); assert.strictEqual(s.stats().err, 0);
});

t('short phrase found later does not jump (needs 4 words)', () => {
  const s = mk(FATIHA);
  s.feed('مالك يوم الدين');
  assert.strictEqual(s.pos, 0); assert.strictEqual(s.state[0], 'p');
});

t('after jumping to the very end, reader can still go back', () => {
  const s = mk(FATIHA + ' ' + 'صراط الذين انعمت عليهم');
  s.feed('صراط الذين انعمت عليهم');
  assert.ok(s.done);
  s.feed('بسم الله الرحمن الرحيم الحمد لله');
  assert.strictEqual(s.state[0], 'ok'); assert.strictEqual(s.pos, 6); assert.ok(!s.done);
});

t('jumping ahead marks skipped words (not errors)', () => {
  const s = mk(FATIHA);
  s.feed('مالك يوم الدين اياك نعبد');
  assert.strictEqual(s.state[0], 'skip'); assert.strictEqual(s.state[9], 'skip');
  assert.strictEqual(s.state[10], 'ok'); assert.strictEqual(s.pos, 15);
  assert.strictEqual(s.stats().err, 0);
});

t('start from a chosen position', () => {
  const s = mk(FATIHA);
  s.setPos(10);
  s.feed('مالك يوم الدين');
  assert.strictEqual(s.stats().ok, 3); assert.strictEqual(s.state[0], 'p');
});

t('preview does not commit', () => {
  const s = mk(FATIHA);
  assert.deepStrictEqual(s.preview('بسم الله الرحمن'), [0, 1, 2]);
  assert.strictEqual(s.pos, 0);
});

t('hint reveals and advances', () => {
  const s = mk(FATIHA);
  s.hint();
  assert.strictEqual(s.state[0], 'hint'); assert.strictEqual(s.pos, 1);
  s.feed('الله الرحمن');
  assert.strictEqual(s.stats().accuracy, 67);
});

t('strict mode rejects near-misses, lenient accepts', () => {
  const a = mk('الْمُسْتَقِيمَ', 'high'); a.feed('المستقيمين'); a.feed('الا');
  const b = mk('الْمُسْتَقِيمَ', 'low'); b.feed('المستقيمين');
  assert.strictEqual(b.state[0], 'ok');
  assert.notStrictEqual(a.state[0], 'ok');
});

t('Uthmani model output matches standard Quran text', () => {
  assert.strictEqual(M.norm('ٱلصَّلَوٰةَ'), 'الصلاه');
  const s = mk('يَا أَيُّهَا الَّذِينَ آمَنُوا أَقِيمُوا الصَّلَاةَ وَآتُوا الزَّكَاةَ ذَٰلِكَ الْكِتَابُ');
  s.feed('يَٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوٓا۟ أَقِيمُوا۟ ٱلصَّلَوٰةَ وَءَاتُوا۟ ٱلزَّكَوٰةَ ذَٰلِكَ ٱلْكِتَٰبُ');
  assert.strictEqual(s.stats().err, 0, JSON.stringify(s.state));
  assert.ok(s.done);
});

t('alef-only difference is rejected in strict mode (قل ≠ قال)', () => {
  const a = mk('قَالَ رَبِّ', 'high'); a.feed('قل رب');
  assert.notStrictEqual(a.state[0], 'ok');
  const b = mk('قَالَ رَبِّ', 'mid'); b.feed('قل رب');
  assert.strictEqual(b.state[0], 'ok');
});

t('reader goes back after a wrong jump → follows again', () => {
  const s = mk(FATIHA);
  s.feed('مالك يوم الدين اياك نعبد');            // jumps ahead, words 0..9 skipped
  assert.strictEqual(s.state[0], 'skip');
  s.feed('بسم الله الرحمن الرحيم الحمد لله');     // reader starts from the beginning
  assert.strictEqual(s.state[0], 'ok'); assert.strictEqual(s.state[5], 'ok');
  assert.strictEqual(s.pos, 6);
  s.feed('رب العالمين الرحمن الرحيم');
  assert.strictEqual(s.pos, 10); assert.strictEqual(s.stats().err, 0);
});

t('words split into 2–3 pieces by a PDF still match', () => {
  const s = mk('منصة معار ف التعليمي ة نبذه ع ن دور ة مراح ل');
  s.feed('منصة معارف التعليمية نبذه عن دورة مراحل');
  assert.strictEqual(s.stats().err, 0, JSON.stringify(s.state)); assert.ok(s.done);
  const s3 = mk('ال تعليمي ة الحديثة');
  s3.feed('التعليمية الحديثة');
  assert.strictEqual(s3.stats().err, 0); assert.ok(s3.done);
});

t('English book text works too', () => {
  const s = mk('The quick brown fox jumps over the lazy dog.');
  s.feed('the quick brown fox'); s.feed('jumps over a lazy dog');
  assert.strictEqual(s.state[6], 'err'); assert.ok(s.done);
});

t('long text performance', () => {
  const big = Array.from({ length: 6000 }, (_, i) => 'كلمة' + (i % 50)).join(' ');
  const s = mk(big);
  const t0 = Date.now();
  for (let k = 0; k < 200; k++) s.feed(s.T.slice(s.pos, s.pos + 12).join(' '));
  assert.ok(Date.now() - t0 < 2000, 'too slow');
});

console.log(`\n${pass} passed`);
