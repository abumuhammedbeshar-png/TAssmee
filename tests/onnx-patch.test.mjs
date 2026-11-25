// اختبارات تعديل النموذج (استبدال ConvInteger): node tests/onnx-patch.test.mjs
// (تحقّقنا أيضاً بـ onnxruntime أن مخرجات النموذج المعدّل تطابق الأصلي تماماً.)
import assert from 'node:assert';
import { patchConvInteger, opTypes, _pb } from '../js/onnx-patch.js';
const { fields, cat, lenField, strField, intField, node, intAttr } = _pb;

let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n  ', e.stack.split('\n').slice(0, 3).join('\n   ')); process.exitCode = 1; } }

/** نموذج صغير بنمط quantize_dynamic: DynamicQuantizeLinear → ConvInteger → Cast → Mul */
function model({ withValueInfo = true, zp = true } = {}) {
  const ints = (name, vals) => lenField(5, cat([strField(1, name), ...vals.map((v) => intField(8, v)), intField(20, 7)]));
  const tensor = (name, dt, dims, raw) => cat([...dims.map((d) => intField(1, d)), intField(2, dt), lenField(9, raw), strField(8, name)]);
  const vi = (name, dt) => cat([strField(1, name), lenField(2, lenField(1, intField(1, dt)))]);
  const conv = cat([strField(1, 'x_q'), strField(1, 'w_q'), strField(1, zp ? 'x_zp' : ''), ...(zp ? [strField(1, 'w_zp')] : []), strField(2, 'conv_out'),
    strField(3, '/conv1/Conv_quant'), strField(4, 'ConvInteger'), ints('kernel_shape', [3]), ints('pads', [1, 1])]);
  const graph = cat([
    lenField(1, node('DynamicQuantizeLinear', ['x'], ['x_q', 'x_scale', 'x_zp'], 'dql')),
    lenField(1, conv),
    lenField(1, node('Cast', ['conv_out'], ['conv_f'], 'cast', [intAttr('to', 1)])),
    lenField(1, node('Mul', ['conv_f', 'x_scale'], ['y'], 'mul')),
    strField(2, 'g'),
    lenField(5, tensor('w_q', 3, [4, 2, 3], new Uint8Array(24).fill(7))),
    lenField(5, tensor('w_zp', 3, [], Uint8Array.of(0))),
    lenField(11, vi('x', 1)), lenField(12, vi('y', 1)),
    ...(withValueInfo ? [lenField(13, vi('conv_out', 6))] : []),
  ]);
  return cat([intField(1, 8), lenField(8, cat([strField(1, ''), intField(2, 13)])), strField(2, 'test'), lenField(7, graph)]);
}
const graphFields = (b) => { const g = fields(b).find((f) => f.no === 7); return fields(b, g.vs, g.ve); };
const dec = new TextDecoder();

t('يستبدل ConvInteger بعمليات قياسية بالترتيب الصحيح', () => {
  const r = patchConvInteger(model());
  assert.strictEqual(r.replaced, 1);
  assert.deepStrictEqual(opTypes(r.bytes), ['DynamicQuantizeLinear', 'Cast', 'Cast', 'Sub', 'Cast', 'Cast', 'Reshape', 'Sub', 'Conv', 'Cast', 'Mul']);
});

t('Conv الجديد يحتفظ بخصائص الالتفاف ويخرج إلى الاسم نفسه', () => {
  const r = patchConvInteger(model());
  const g = graphFields(r.bytes);
  const conv = g.filter((f) => f.no === 1).map((f) => fields(r.bytes, f.vs, f.ve)).find((nf) => nf.some((x) => x.no === 4 && dec.decode(r.bytes.subarray(x.vs, x.ve)) === 'Conv'));
  const attrNames = conv.filter((x) => x.no === 5).map((a) => { const n = fields(r.bytes, a.vs, a.ve).find((y) => y.no === 1); return dec.decode(r.bytes.subarray(n.vs, n.ve)); });
  assert.deepStrictEqual(attrNames, ['kernel_shape', 'pads']);
  const out = conv.find((x) => x.no === 2);
  assert.strictEqual(dec.decode(r.bytes.subarray(out.vs, out.ve)), 'conv_out');
});

t('يحذف وصف النوع int32 لمخرج ConvInteger، ويضيف شكل نقطة الصفر', () => {
  const r = patchConvInteger(model());
  const g = graphFields(r.bytes);
  assert.strictEqual(g.filter((f) => f.no === 13).length, 0);
  assert.strictEqual(g.filter((f) => f.no === 5).length, 3); // w_q, w_zp + الشكل [-1, 1, 1]
});

t('دون نقاط صفر: Cast ثم Conv فقط', () => {
  const r = patchConvInteger(model({ zp: false, withValueInfo: false }));
  assert.deepStrictEqual(opTypes(r.bytes), ['DynamicQuantizeLinear', 'Cast', 'Cast', 'Conv', 'Cast', 'Mul']);
});

t('نموذج بلا ConvInteger يُعاد كما هو', () => {
  const m = model();
  const once = patchConvInteger(m).bytes;
  const twice = patchConvInteger(once);
  assert.strictEqual(twice.replaced, 0);
  assert.strictEqual(twice.bytes, once);
});

t('ترميز الأعداد السالبة (int64) بعشرة بايتات', () => {
  assert.strictEqual(_pb.vbytes(-1).length, 10);
  assert.deepStrictEqual(_pb.vbytes(300), [0xac, 0x02]);
});

console.log(`\n${pass} passed`);
