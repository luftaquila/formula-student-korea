// Little-endian binary reader/writer — isomorphic (browser + Node), dependency
// free. Mirrors the Python `struct` helpers used by kn5.py / ai_line.py so the
// AC track writers can be ported byte-for-byte. Keep this file free of npm and
// Node built-ins (Buffer, fs) so it runs unchanged in the browser export path.
//
// Type map (all little-endian, matching Python struct format chars):
//   u32 = "I"   i32 = "i"   u16 = "H"   u8/byte = "B"   bool = "?"   f32 = "f"
//   vec2/3/4 = "2f"/"3f"/"4f"
//   str  = u32 length prefix + UTF-8 bytes  (Python _W.s)
//   blob = u32 length prefix + raw bytes    (Python _W.blob)
//   matrixColMajor(m) = for row in 4: for col in 4: f32 m[col][row]  (Python _W.matrix)

const _enc = new TextEncoder();
const _dec = new TextDecoder("utf-8");

export class ByteWriter {
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }

  _ensure(n) {
    if (this.len + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u32(v) { this._ensure(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  i32(v) { this._ensure(4); this.view.setInt32(this.len, v | 0, true); this.len += 4; return this; }
  u16(v) { this._ensure(2); this.view.setUint16(this.len, v & 0xffff, true); this.len += 2; return this; }
  u8(v)  { this._ensure(1); this.view.setUint8(this.len, v & 0xff); this.len += 1; return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  f32(v) { this._ensure(4); this.view.setFloat32(this.len, v, true); this.len += 4; return this; }

  vec2(v) { this.f32(v[0]); this.f32(v[1]); return this; }
  vec3(v) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); return this; }
  vec4(v) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); this.f32(v[3]); return this; }

  bytes(data) {
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._ensure(src.byteLength);
    this.buf.set(src, this.len);
    this.len += src.byteLength;
    return this;
  }

  str(s) {
    const b = _enc.encode(s);
    this.u32(b.byteLength);
    this.bytes(b);
    return this;
  }

  blob(data) {
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.u32(src.byteLength);
    this.bytes(src);
    return this;
  }

  // m is a 4x4 nested array indexed m[i][j]; written col-major exactly as
  // kn5.py's _W.matrix (for row in 4: for col in 4: write m[col][row]).
  matrixColMajor(m) {
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 4; col++) this.f32(m[col][row]);
    return this;
  }

  toBytes() { return this.buf.subarray(0, this.len); }
}

export class ByteReader {
  constructor(data) {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.p = 0;
  }

  u32() { const v = this.view.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.view.getInt32(this.p, true); this.p += 4; return v; }
  u16() { const v = this.view.getUint16(this.p, true); this.p += 2; return v; }
  u8()  { const v = this.view.getUint8(this.p); this.p += 1; return v; }
  bool() { return this.u8() !== 0; }
  f32() { const v = this.view.getFloat32(this.p, true); this.p += 4; return v; }

  vec3() { return [this.f32(), this.f32(), this.f32()]; }

  take(n) { const b = this.buf.subarray(this.p, this.p + n); this.p += n; return b; }
  skip(n) { this.p += n; return this; }

  str() {
    const n = this.u32();
    return _dec.decode(this.take(n));
  }

  get leftover() { return this.buf.byteLength - this.p; }
}
