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

t('spots unreadable OCR output', () => {
  // ما أخرجه التعرّف الضوئي من كتاب مصوَّر بخط مزخرف (الحالة الحقيقية)
  const junk1 = 'و ا\n2 يدا حال ليطاص\nو ان\n0 1 2\n2 مسدنم 8\nلن دسل ال اا م 0\n١ يُقول راي تَحْمَدَالعفُورٍ دوؤماسلمان.\nهوالجروريب\n8\n3 ووم مصداه الى ضاحكهة رحأ\n3 الحَمْدِلِلَهِ ملاع محَمَدٍوَالِوِوَمَنْ كلا 0\n5 2\n21 مم 40 رثا ار 5 الم انر عأأ\nلل 0\n7 5 اال 0 8';
  const junk2 = 'اط رااان م يكو راج يَحْمةَلهَمْر وَوْما سيان هْوَالحْوري ١ الحَمدي مس 0 ا 0 بسطتنات ل ال';
  assert.strictEqual(P.looksReadable(junk1), false);
  assert.strictEqual(P.looksReadable(junk2), false); // حروف مفردة متناثرة
});

t('accepts real book text', () => {
  const good1 = 'منصة معارف التعليمية نبذه عن دورة مراحل إنتاج الفسائل النسيجية مقدمة الدورة الفريوز للخدمات العلمية الدقيقة لتقنية زراعة الأنسجة النباتية';
  const good2 = 'العلم نور يضيء طريق الإنسان في الحياة ومن طلب العلم وجد في طلبه لذة لا تعدلها لذة الصبر مفتاح الفرج والعمل الدائم وإن قل خير من الكثير المنقطع';
  const good3 = 'يقول راجي رحمة الغفور دوما سليمان هو الجمزوري الحمد لله مصليا على محمد وآله ومن تلا وبعد هذا النظم للمريد في النون والتنوين والمدود';
  assert.strictEqual(P.looksReadable(good1), true);
  assert.strictEqual(P.looksReadable(good2), true);
  assert.strictEqual(P.looksReadable(good3), true);
});

t('readableRatio ignores blank pages', () => {
  const good = 'العلم نور يضيء طريق الإنسان في الحياة ومن طلب العلم وجد في طلبه لذة لا تعدلها';
  assert.strictEqual(P.readableRatio(['', '   ', good]), 1);
  assert.strictEqual(P.readableRatio(['', '0 1 2 و ا 8 مسدنم لن دسل ال اا م 0 رثا ار الم انر عأأ']), 0);
  assert.strictEqual(P.readableRatio([]), 0);
});


t('fixes PDFs that store words in visual (reversed) order', () => {
  // سطر عربي كلماته مخزّنة من اليسار إلى اليمين: "العلم نور يضيء طريق الإنسان"
  const words = ['الإنسان', 'طريق', 'يضيء', 'نور', 'العلم'];   // ترتيب الملف = من اليسار
  let x = 40;
  const items = words.map((w) => {
    const it = { str: w, dir: 'rtl', width: w.length * 9, height: 14, transform: [14, 0, 0, 14, x, 700] };
    x += w.length * 9 + 8;
    return it;
  });
  assert.strictEqual(P.streamIsVisual(items), true);
  assert.strictEqual(P.pageText(items), 'العلم نور يضيء طريق الإنسان');
});

t('leaves logical-order PDFs alone', () => {
  const words = ['العلم', 'نور', 'يضيء', 'طريق', 'الإنسان'];   // ترتيب منطقي سليم: x يتناقص
  let x = 520;
  const items = words.map((w) => {
    x -= w.length * 9 + 8;
    return { str: w, dir: 'rtl', width: w.length * 9, height: 14, transform: [14, 0, 0, 14, x, 700] };
  });
  assert.strictEqual(P.streamIsVisual(items), false);
  assert.strictEqual(P.pageText(items), 'العلم نور يضيء طريق الإنسان');
});

t('two columns of verse keep each hemistich in order', () => {
  // بيت شعر: الصدر يمين الصفحة والعجز يساره، والملف يخزّنهما بترتيب العرض
  const mk = (w, x) => ({ str: w, dir: 'rtl', width: w.length * 9, height: 14, transform: [14, 0, 0, 14, x, 600] });
  // الصدر يمين الصفحة (x كبير) والعجز يسارها، والملف يخزّنهما من اليسار
  const items = [mk('الجمزوري', 60), mk('هو', 150), mk('سليمان', 190), mk('دوما', 270),
                 mk('الغفور', 350), mk('رحمة', 420), mk('راجي', 480), mk('يقول', 540)];
  assert.strictEqual(P.pageText(items), 'يقول راجي رحمة الغفور دوما سليمان هو الجمزوري');
});

console.log(`\n${pass} passed`);
