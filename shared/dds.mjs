// Uncompressed DDS textures — dependency-free, isomorphic. AC's kn5 texture path
// expects DDS (an embedded PNG loads but is not sampled on track meshes → the
// road looked untextured), so build_track.py emits uncompressed A8R8G8B8 DDS via
// Pillow; this is the JS equivalent.
//
// Pixel format A8R8G8B8: the dword (little-endian on disk) is A<<24|R<<16|G<<8|B,
// so bytes land as B,G,R,A — writeDDS takes RGBA input and writes BGRA on disk.
// Texture pixels are cosmetic and NOT byte-compared (numpy-RNG noise is not
// reproducible in JS); tests assert the DDS header only.

import { ByteWriter } from "./binio.mjs";

const DDS_MAGIC = new Uint8Array([0x44, 0x44, 0x53, 0x20]); // "DDS "

/**
 * Write an uncompressed 32-bit (A8R8G8B8) DDS.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  flat R,G,B,A per pixel, row-major top-to-bottom
 * @returns {Uint8Array}
 */
export function writeDDS(width, height, rgba) {
  const w = new ByteWriter(128 + width * height * 4);
  w.bytes(DDS_MAGIC);
  w.u32(124);                       // dwSize
  w.u32(0x0000100f);                // CAPS|HEIGHT|WIDTH|PITCH|PIXELFORMAT
  w.u32(height);                    // dwHeight
  w.u32(width);                     // dwWidth
  w.u32(width * 4);                 // dwPitchOrLinearSize (bytes per row)
  w.u32(0);                         // dwDepth
  w.u32(0);                         // dwMipMapCount
  for (let i = 0; i < 11; i++) w.u32(0); // dwReserved1[11]
  // DDS_PIXELFORMAT
  w.u32(32);                        // dwSize
  w.u32(0x41);                      // DDPF_RGB | DDPF_ALPHAPIXELS
  w.u32(0);                         // dwFourCC
  w.u32(32);                        // dwRGBBitCount
  w.u32(0x00ff0000);               // R mask
  w.u32(0x0000ff00);               // G mask
  w.u32(0x000000ff);               // B mask
  w.u32(0xff000000);               // A mask
  w.u32(0x1000);                    // dwCaps = DDSCAPS_TEXTURE
  w.u32(0);                         // dwCaps2
  w.u32(0);                         // dwCaps3
  w.u32(0);                         // dwCaps4
  w.u32(0);                         // dwReserved2

  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    px[i * 4] = b; px[i * 4 + 1] = g; px[i * 4 + 2] = r; px[i * 4 + 3] = a; // BGRA
  }
  w.bytes(px);
  return w.toBytes();
}

// Deterministic PRNG (mulberry32) so textures are reproducible run-to-run.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Light 3×3 box blur on RGB (alpha untouched); softens the noise like the small
// Gaussian blur in build_track.py (cosmetic).
function boxBlur(rgba, w, h) {
  const out = rgba.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            sum += rgba[(yy * w + xx) * 4 + c]; cnt++;
          }
        }
        out[(y * w + x) * 4 + c] = Math.round(sum / cnt);
      }
    }
  }
  return out;
}

function noisyBase(size, base, std, seed) {
  const rng = mulberry32(seed);
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = (rng() * 2 - 1) * std * 1.732; // ~N(0,std) via uniform
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(base[c] + n)));
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Mid-grey tarmac with white edge lines + a dashed centre line (u=0/1 map to the
 * road edges, v runs along length) — mirrors asphalt_dds in build_track.py.
 */
export function asphaltDDS(size = 256) {
  let rgba = boxBlur(noisyBase(size, [88, 89, 94], 5, 1), size, size);
  const set = (row, col, rgb) => {
    const i = (row * size + col) * 4;
    rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
  };
  const lw = Math.max(3, Math.floor(size / 44));
  const edge = [220, 220, 215];
  for (let v = 0; v < size; v++) {
    for (let k = 0; k < lw; k++) { set(v, k, edge); set(v, size - 1 - k, edge); }
  }
  const c = Math.floor(size / 2);
  const dashEnd = Math.floor(size * 0.55);
  const dashCol = [220, 220, 210];
  for (let v = 0; v < dashEnd; v++) {
    for (let u = c - 3; u < c + 3; u++) set(v, u, dashCol);
  }
  return writeDDS(size, size, rgba);
}

/** Green grass with softened noise — mirrors grass_dds in build_track.py. */
export function grassDDS(size = 256) {
  const rgba = boxBlur(noisyBase(size, [56, 84, 48], 14, 2), size, size);
  return writeDDS(size, size, rgba);
}
