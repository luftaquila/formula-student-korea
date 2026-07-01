// Tiny dependency-free PNG encoder (8-bit RGBA) — isomorphic. Uses only STORED
// (uncompressed) zlib blocks so no DEFLATE compressor is needed; a valid PNG,
// just not size-optimised. Lets pack-track stay isomorphic (no node-canvas) for
// the small minimap / outline / preview polygons.

const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 over the concatenation of the given byte arrays.
function crc32(...arrays) {
  let c = 0xffffffff;
  for (const a of arrays) for (let i = 0; i < a.length; i++) c = _crcTable[(c ^ a[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % MOD; b = (b + a) % MOD; }
  return ((b << 16) | a) >>> 0;
}

// Growable byte buffer (no large spreads — those overflow the call stack).
class Buf {
  constructor(n = 1024) { this.b = new Uint8Array(n); this.n = 0; }
  _ensure(k) {
    if (this.n + k <= this.b.length) return;
    let c = this.b.length * 2;
    while (c < this.n + k) c *= 2;
    const nb = new Uint8Array(c); nb.set(this.b.subarray(0, this.n)); this.b = nb;
  }
  byte(v) { this._ensure(1); this.b[this.n++] = v & 0xff; }
  u32be(v) { this._ensure(4); this.b[this.n++] = (v >>> 24) & 0xff; this.b[this.n++] = (v >>> 16) & 0xff; this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff; }
  arr(a) { this._ensure(a.length); this.b.set(a, this.n); this.n += a.length; }
  out() { return this.b.subarray(0, this.n); }
}

// zlib stream wrapping DEFLATE stored blocks (BTYPE=00).
function zlibStored(raw) {
  const buf = new Buf(raw.length + 64);
  buf.byte(0x78); buf.byte(0x01);
  let off = 0;
  do {
    const len = Math.min(65535, raw.length - off);
    const final = off + len >= raw.length ? 1 : 0;
    buf.byte(final);                              // BFINAL bit, BTYPE=00
    buf.byte(len & 0xff); buf.byte((len >> 8) & 0xff);        // LEN (LE)
    const nlen = ~len & 0xffff;
    buf.byte(nlen & 0xff); buf.byte((nlen >> 8) & 0xff);      // NLEN (LE)
    buf.arr(raw.subarray(off, off + len));
    off += len;
  } while (off < raw.length);
  const ad = adler32(raw);
  buf.byte((ad >>> 24) & 0xff); buf.byte((ad >>> 16) & 0xff); buf.byte((ad >>> 8) & 0xff); buf.byte(ad & 0xff);
  return buf.out();
}

function writeChunk(buf, type, data) {
  buf.u32be(data.length);
  const tb = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  buf.arr(tb);
  buf.arr(data);
  buf.u32be(crc32(tb, data));
}

/**
 * Encode an 8-bit RGBA image as PNG bytes.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba flat R,G,B,A per pixel, row-major top-to-bottom
 * @returns {Uint8Array}
 */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));   // filter byte 0 per row
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array([
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,   // bit depth 8, colour type RGBA, compression 0, filter 0, interlace 0
  ]);

  const buf = new Buf(raw.length + 256);
  buf.arr(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // signature
  writeChunk(buf, "IHDR", ihdr);
  writeChunk(buf, "IDAT", zlibStored(raw));
  writeChunk(buf, "IEND", new Uint8Array(0));
  return buf.out();
}
