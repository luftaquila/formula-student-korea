import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { writeDDS, asphaltDDS, grassDDS } from "../../shared/dds.mjs";
import { encodePNG } from "../../shared/png.mjs";

const u32le = (buf, off) => buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
const u32be = (buf, off) => (buf[off] * 0x1000000) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3];

describe("dds header", () => {
  it("writes a valid uncompressed A8R8G8B8 DDS header", () => {
    const w = 4, h = 2;
    const rgba = new Uint8Array(w * h * 4).fill(200);
    const dds = writeDDS(w, h, rgba);
    assert.equal(String.fromCharCode(dds[0], dds[1], dds[2], dds[3]), "DDS ");
    assert.equal(u32le(dds, 4), 124, "dwSize");
    assert.equal(u32le(dds, 12), h, "dwHeight");
    assert.equal(u32le(dds, 16), w, "dwWidth");
    assert.equal(u32le(dds, 88), 32, "dwRGBBitCount");
    assert.equal(u32le(dds, 92) >>> 0, 0x00ff0000, "R mask");
    assert.equal(u32le(dds, 96) >>> 0, 0x0000ff00, "G mask");
    assert.equal(u32le(dds, 100) >>> 0, 0x000000ff, "B mask");
    assert.equal(u32le(dds, 104) >>> 0, 0xff000000, "A mask");
    assert.equal(dds.byteLength, 128 + w * h * 4, "total size");
  });

  it("stores pixels as BGRA on disk", () => {
    const rgba = new Uint8Array([10, 20, 30, 40]); // one pixel R,G,B,A
    const dds = writeDDS(1, 1, rgba);
    assert.deepEqual(Array.from(dds.subarray(128)), [30, 20, 10, 40]); // B,G,R,A
  });

  it("asphaltDDS / grassDDS are 256×256 valid DDS", () => {
    for (const dds of [asphaltDDS(), grassDDS()]) {
      assert.equal(String.fromCharCode(dds[0], dds[1], dds[2], dds[3]), "DDS ");
      assert.equal(u32le(dds, 12), 256);
      assert.equal(u32le(dds, 16), 256);
      assert.equal(dds.byteLength, 128 + 256 * 256 * 4);
    }
  });
});

describe("png encoder", () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff;
  const png = encodePNG(w, h, rgba);

  it("has the PNG signature and an IHDR with correct dims", () => {
    assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR chunk: length(4) at 8, type at 12, data at 16
    assert.equal(String.fromCharCode(png[12], png[13], png[14], png[15]), "IHDR");
    assert.equal(u32be(png, 16), w);
    assert.equal(u32be(png, 20), h);
    assert.equal(png[24], 8, "bit depth");
    assert.equal(png[25], 6, "colour type RGBA");
  });

  it("decodes back to the original pixels (Node zlib inflate of IDAT)", () => {
    // walk chunks, collect IDAT payloads
    let off = 8;
    const idat = [];
    let sawIEND = false;
    while (off < png.length) {
      const len = u32be(png, off);
      const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
      const data = png.subarray(off + 8, off + 8 + len);
      if (type === "IDAT") idat.push(Buffer.from(data));
      if (type === "IEND") sawIEND = true;
      off += 12 + len;
    }
    assert.ok(sawIEND, "IEND present");
    const raw = zlib.inflateSync(Buffer.concat(idat));
    // reconstruct scanlines (filter byte 0 each row) -> compare pixels
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      assert.equal(raw[y * (stride + 1)], 0, "filter byte");
      for (let x = 0; x < stride; x++) {
        assert.equal(raw[y * (stride + 1) + 1 + x], rgba[y * stride + x]);
      }
    }
  });
});
