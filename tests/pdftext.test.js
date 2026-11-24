const assert = require('assert');
const P = require('../js/pdftext.js');
let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n  ', e.message); process.exitCode = 1; } }

t('rejoins words split at the final letter (base letters)', () => {
  const broken = 'منصة معار ف التعليمي ة نبذه ع ن دور ة مراح ل إنتا ج الفساء ل النسيجي ة\nمقدم ة الدور ة : الفريو ز للخدما ت\nالعلمي ة الدقيق ةلتقني ة زراع ة الأنسج ة النباتي ة';
  assert.strictEqual(P.repairBase(broken),
    'منصة معارف التعليمية نبذه عن دورة مراحل إنتاج الفساءل النسيجية\nمقدمة الدورة : الفريوز للخدمات\nالعلمية الدقيقة لتقنية زراعة الأنسجة النباتية');
});

t('leaves clean text untouched', () => {
  const good = 'ذهب الطالب إلى المدرسة في الصباح وكان من أوائل الحاضرين و هو سعيد';
  assert.strictEqual(P.repairBase(good), good);
});

t('presentation forms: removes spaces inside words, restores missing ones', () => {
  // ﻋ ﻦ  (ع أول + ن آخر) → عن
  assert.strictEqual(P.cleanText(P.repairForms('ﻋ ﻦ')), 'عن');
  // ﺍﻟﺘﻌﻠﻴﻤﻴ ﺔ → التعليمية
  assert.strictEqual(P.cleanText(P.repairForms('ﺍﻟﺘﻌﻠﻴﻤﻴ ﺔ')), 'التعليمية');
  // ﺍﻟﺪﻗﻴﻖ ﺔﻟﺘﻘﻨﻴ ﺔ → الدقيقة لتقنية
  const s = 'ﺍﻟﺪﻗﻴﻘ ﺔﻟﺘﻘﻨﻴ ﺔ';
  assert.strictEqual(P.cleanText(P.repairForms(s)), 'الدقيقة لتقنية');
});

t('scoring prefers the clean version', () => {
  assert.ok(P.score('منصة معارف التعليمية نبذه عن دورة') > P.score('منصة معار ف التعليمي ة نبذه ع ن دور ة'));
});

t('pageText prefers file order when both look clean (multi-column safe)', () => {
  // stream gives the clean logical text; positions are scrambled so geometry would mangle it
  const items = [
    { str: 'منصة معارف التعليمية', dir: 'rtl', transform: [12, 0, 0, 12, 50, 700], width: 40, hasEOL: true },
    { str: 'نبذه عن دورة مراحل', dir: 'rtl', transform: [12, 0, 0, 12, 300, 700.5], width: 40, hasEOL: false },
  ];
  const out = P.pageText(items);
  assert.ok(out.startsWith('منصة معارف التعليمية'), out);
});

t('reversed detection still works', () => {
  const s = 'ذهب الطالب إلى المدرسة في الصباح وكان من أوائل الحاضرين على الدرس هذا اليوم في الفصل';
  assert.deepStrictEqual([P.looksReversed([s]), P.looksReversed([P.flipText(s)])], [false, true]);
});
console.log(`\n${pass} passed`);
