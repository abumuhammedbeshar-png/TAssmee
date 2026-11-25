/*
 * onnx-patch.js — تعديل صغير على ملف النموذج داخل المتصفح قبل تشغيله.
 *
 * نموذج «المعلّم» مضغوط بدقة int8، وطبقتا الالتفاف الأوليان فيه من نوع ConvInteger،
 * وهي عملية لا يوفّرها onnxruntime-web ("Could not find an implementation for ConvInteger").
 * نستبدل كل ConvInteger بعمليات قياسية تعطي النتيجة نفسها تماماً:
 *     Conv( float(x_q) − float(x_zp) ,  float(w_q) − float(w_zp) )
 * (القيم أعداد صحيحة صغيرة فتُحسب بالأعداد العشرية دون خطأ تقريب). بقية النموذج يبقى int8 كما هو.
 *
 * التعديل على مستوى ترميز protobuf مباشرة: نقرأ حقول الملف ونعيد كتابة ما يلزم فقط، وننسخ الباقي كما هو.
 */

/* ---------- قراءة protobuf ---------- */
function varint(b, p) {
  let x = 0, mul = 1, c;
  do {
    c = b[p++];
    x += (c & 0x7f) * mul;
    mul *= 128;
  } while (c & 0x80);
  return [x, p];
}
/** حقول رسالة: [{no, wt, s: بداية الحقل, e: نهايته, vs, ve: حدود القيمة (للحقول الطولية), v: القيمة الرقمية}] */
function fields(b, s = 0, e = b.length) {
  const out = [];
  let p = s;
  while (p < e) {
    const start = p;
    let tag;
    [tag, p] = varint(b, p);
    const no = Math.floor(tag / 8), wt = tag & 7;
    const f = { no, wt, s: start };
    if (wt === 0) { [f.v, p] = varint(b, p); }
    else if (wt === 1) p += 8;
    else if (wt === 5) p += 4;
    else if (wt === 2) { let n; [n, p] = varint(b, p); f.vs = p; f.ve = p + n; p += n; }
    else throw new Error('protobuf wire type ' + wt);
    f.e = p;
    out.push(f);
  }
  if (p !== e) throw new Error('protobuf overrun');
  return out;
}
const dec = new TextDecoder();
const str = (b, f) => dec.decode(b.subarray(f.vs, f.ve));

/* ---------- كتابة protobuf ---------- */
const enc = new TextEncoder();
function vbytes(x) {
  const out = [];
  if (x < 0) { // int64 سالب: ١٠ بايتات بتمثيل المتمّم الثنائي
    let v = BigInt.asUintN(64, BigInt(x));
    while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    out.push(Number(v));
    return out;
  }
  while (x >= 0x80) { out.push((x % 128) | 0x80); x = Math.floor(x / 128); }
  out.push(x);
  return out;
}
const tag = (no, wt) => vbytes(no * 8 + wt);
function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const lenField = (no, bytes) => cat([Uint8Array.from(tag(no, 2)), Uint8Array.from(vbytes(bytes.length)), bytes]);
const strField = (no, s) => lenField(no, enc.encode(s));
const intField = (no, x) => Uint8Array.from(tag(no, 0).concat(vbytes(x)));

/** NodeProto: input=1, output=2, name=3, op_type=4, attribute=5 */
function node(op, inputs, outputs, name, attrs) {
  return cat([
    ...inputs.map((x) => strField(1, x)),
    ...outputs.map((x) => strField(2, x)),
    strField(3, name),
    strField(4, op),
    ...(attrs || []),
  ]);
}
/** AttributeProto من نوع INT: name=1, i=3, type=20 (INT = 2) */
const intAttr = (name, v) => lenField(5, cat([strField(1, name), intField(3, v), intField(20, 2)]));
/** TensorProto INT64 أحادي البعد: dims=1, data_type=2 (INT64 = 7), int64_data=7 (packed), name=8 */
function int64Tensor(name, values) {
  const packed = Uint8Array.from(values.flatMap((v) => vbytes(v)));
  return cat([intField(1, values.length), intField(2, 7), lenField(7, packed), strField(8, name)]);
}

/* ---------- التعديل ---------- */
const FLOAT = 1;

/** عدد أبعاد الالتفاف من خاصية kernel_shape (افتراضياً أحادي البعد كما في Whisper) */
function convRank(b, nodeFields) {
  for (const a of nodeFields.filter((f) => f.no === 5)) {
    const af = fields(b, a.vs, a.ve);
    const nm = af.find((f) => f.no === 1);
    if (!nm || str(b, nm) !== 'kernel_shape') continue;
    const ints = af.filter((f) => f.no === 8);
    if (ints.length === 1 && ints[0].wt === 2) { // packed
      let n = 0, p = ints[0].vs;
      while (p < ints[0].ve) { [, p] = varint(b, p); n++; }
      return 2 + n;
    }
    if (ints.length) return 2 + ints.length;
  }
  return 3;
}

/**
 * يعيد نسخة من النموذج بلا ConvInteger، أو النموذج نفسه إن لم يكن فيه.
 * bytes: Uint8Array لملف ‎.onnx · يعيد {bytes, replaced: عدد العقد المستبدلة}
 */
export function patchConvInteger(bytes) {
  const b = bytes;
  const top = fields(b);
  const g = top.find((f) => f.no === 7 && f.wt === 2);
  if (!g) return { bytes, replaced: 0 };
  const gf = fields(b, g.vs, g.ve);
  const parts = [], changedOut = new Set(), extraInit = [];
  let replaced = 0;
  for (const f of gf) {
    if (f.no === 1 && f.wt === 2) {
      const nf = fields(b, f.vs, f.ve);
      const op = nf.find((x) => x.no === 4);
      const dom = nf.find((x) => x.no === 7);
      if (op && str(b, op) === 'ConvInteger' && (!dom || !str(b, dom))) {
        const ins = nf.filter((x) => x.no === 1).map((x) => str(b, x));
        const outs = nf.filter((x) => x.no === 2).map((x) => str(b, x));
        const nmf = nf.find((x) => x.no === 3);
        const base = (nmf ? str(b, nmf) : 'ConvInteger') + '_tasmee' + replaced;
        const attrs = nf.filter((x) => x.no === 5).map((x) => b.subarray(x.s, x.e)); // dilations, group, kernel_shape, pads, strides
        const [xq, wq, xzp, wzp] = ins;
        const nodes = [];
        const castF = (src, dst) => nodes.push(node('Cast', [src], [dst], dst, [intAttr('to', FLOAT)]));
        castF(xq, base + '_x');
        let x = base + '_x';
        if (xzp) { castF(xzp, base + '_xz'); nodes.push(node('Sub', [x, base + '_xz'], [base + '_xs'], base + '_xs')); x = base + '_xs'; }
        castF(wq, base + '_w');
        let w = base + '_w';
        if (wzp) {
          // نقطة الصفر قد تكون عدداً واحداً أو واحدة لكل قناة خرج: نشكّلها [-1, 1, …] لتتوافق مع الأوزان
          const shape = base + '_zshape';
          extraInit.push(lenField(5, int64Tensor(shape, [-1, ...new Array(convRank(b, nf) - 1).fill(1)])));
          castF(wzp, base + '_wz');
          nodes.push(node('Reshape', [base + '_wz', shape], [base + '_wzr'], base + '_wzr'));
          nodes.push(node('Sub', [w, base + '_wzr'], [base + '_ws'], base + '_ws'));
          w = base + '_ws';
        }
        nodes.push(cat([...[x, w].map((s) => strField(1, s)), ...outs.map((s) => strField(2, s)), strField(3, base + '_conv'), strField(4, 'Conv'), ...attrs]));
        for (const n of nodes) parts.push(lenField(1, n));
        outs.forEach((o) => changedOut.add(o));
        replaced++;
        continue;
      }
    }
    parts.push(b.subarray(f.s, f.e));
  }
  if (!replaced) return { bytes, replaced: 0 };
  // نوع مخرج ConvInteger كان int32 وصار float: نحذف وصفه إن وُجد ليستنتجه المحرّك
  const kept = [];
  for (const p of parts) {
    const pf = fields(p);
    const f = pf[0];
    if (pf.length === 1 && f.no === 13 && f.wt === 2) {
      const nm = fields(p, f.vs, f.ve).find((x) => x.no === 1);
      if (nm && changedOut.has(str(p, nm))) continue;
    }
    kept.push(p);
  }
  const graph = cat(kept.concat(extraInit));
  const out = [];
  for (const f of top) out.push(f === g ? lenField(7, graph) : b.subarray(f.s, f.e));
  return { bytes: cat(out), replaced };
}

/** أنواع العقد في النموذج (للاختبار والتشخيص) */
export function opTypes(bytes) {
  const g = fields(bytes).find((f) => f.no === 7 && f.wt === 2);
  if (!g) return [];
  return fields(bytes, g.vs, g.ve).filter((f) => f.no === 1 && f.wt === 2).map((f) => {
    const op = fields(bytes, f.vs, f.ve).find((x) => x.no === 4);
    return op ? str(bytes, op) : '';
  });
}

// للاختبارات: بناء نماذج صغيرة
export const _pb = { fields, varint, vbytes, tag, cat, lenField, strField, intField, node, intAttr, int64Tensor };
