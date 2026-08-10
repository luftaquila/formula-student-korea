// Assetto Corsa .kn5 writer + reader — dependency-free port of kn5.py (file
// version 5). Byte layout mirrored exactly; see kn5.py for provenance (moppius
// exporter for the writer, RaduMC kn5-converter for the reader).
//
// Isomorphic: writeKn5 returns a Uint8Array (the caller writes/zips it), so this
// runs in the browser export path and in Node tests without fs.
//
// Coordinate convention: AC is Y-up. Convert world (x_east, y_north, z_up) ->
// (x, z, -y) via acVec before building meshes.

import { ByteWriter, ByteReader } from "./binio.mjs";

const MAGIC = new Uint8Array([0x73, 0x63, 0x36, 0x39, 0x36, 0x39]); // "sc6969"
const VERSION = 5;
const NODE_DUMMY = 1;
const NODE_MESH = 2;

// world (x_east, y_north, z_up) -> AC (x, z, -y)
export function acVec(v) {
  return [v[0], v[2], -v[1]];
}

export const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export function translationMatrix(pos) {
  const m = IDENTITY.map((row) => row.slice());
  m[0][3] = pos[0];
  m[1][3] = pos[1];
  m[2][3] = pos[2];
  return m;
}

export function dummyNode(name, matrix = IDENTITY, children = []) {
  return { kind: "dummy", name, matrix, children };
}

export function meshNode(name, positions, normals, uvs, indices, materialId, opts = {}) {
  return {
    kind: "mesh",
    name,
    positions,               // list of [x,y,z] in AC space
    normals,
    uvs,
    indices,                 // flat list of uint16
    materialId,
    tangents: opts.tangents || positions.map(() => [0, 0, 0]),
    castShadows: opts.castShadows ?? true,
    visible: opts.visible ?? true,
    transparent: opts.transparent ?? false,
    renderable: opts.renderable ?? true,
    layer: opts.layer ?? 0,
    lodIn: opts.lodIn ?? 0.0,
    lodOut: opts.lodOut ?? 0.0,
  };
}

function writeNode(w, node) {
  if (node.kind === "dummy") {
    w.u32(NODE_DUMMY);
    w.str(node.name);
    w.u32(node.children.length);
    w.bool(true);
    w.matrixColMajor(node.matrix);
    for (const c of node.children) writeNode(w, c);
  } else if (node.kind === "mesh") {
    if (node.positions.length > 65536) {
      throw new Error(`mesh '${node.name}' exceeds 65536 vertices`);
    }
    w.u32(NODE_MESH);
    w.str(node.name);
    w.u32(0);
    w.bool(true);
    w.bool(node.castShadows);
    w.bool(node.visible);
    w.bool(node.transparent);
    w.u32(node.positions.length);
    for (let i = 0; i < node.positions.length; i++) {
      w.vec3(node.positions[i]);
      w.vec3(node.normals[i]);
      w.vec2(node.uvs[i]);
      w.vec3(node.tangents[i]);
    }
    w.u32(node.indices.length);
    for (const idx of node.indices) w.u16(idx);
    w.u32(node.materialId);
    w.u32(node.layer);
    w.f32(node.lodIn);
    w.f32(node.lodOut);
    let cx = 0, cy = 0, cz = 0, radius = 0;
    if (node.positions.length) {
      let minx = Infinity, miny = Infinity, minz = Infinity;
      let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      for (const p of node.positions) {
        if (p[0] < minx) minx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[2] < minz) minz = p[2];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] > maxy) maxy = p[1];
        if (p[2] > maxz) maxz = p[2];
      }
      cx = (minx + maxx) / 2;
      cy = (miny + maxy) / 2;
      cz = (minz + maxz) / 2;
      radius = Math.max(maxx - minx, maxy - miny, maxz - minz);
    }
    w.vec3([cx, cy, cz]);
    w.f32(radius);
    w.bool(node.renderable);
  } else {
    throw new TypeError(`unknown node kind: ${node.kind}`);
  }
}

/**
 * Write a kn5 (version 5).
 * @param {{textures:Array<[string,Uint8Array]>, materials:Array<object>, root:object}} arg
 * @returns {Uint8Array}
 */
export function writeKn5({ textures, materials, root }) {
  const w = new ByteWriter(1 << 16);
  w.bytes(MAGIC);
  w.u32(VERSION);

  // textures
  w.i32(textures.length);
  for (const [name, data] of textures) {
    w.i32(1);
    w.str(name);
    w.blob(data);
  }

  // materials
  w.i32(materials.length);
  for (const m of materials) {
    w.str(m.name);
    w.str(m.shader ?? "ksPerPixel");
    w.u8(m.blend ?? 0);
    w.bool(m.alphaTested ?? false);
    w.i32(m.depth ?? 0);
    const props = m.props ?? [];
    w.u32(props.length);
    for (const [name, a, b, c, d] of props) {
      w.str(name);
      w.f32(a);
      w.vec2(b);
      w.vec3(c);
      w.vec4(d);
    }
    const texs = m.textures ?? [];
    w.u32(texs.length);
    for (let slot = 0; slot < texs.length; slot++) {
      const [mapping, texname] = texs[slot];
      w.str(mapping);
      w.u32(slot);
      w.str(texname);
    }
  }

  writeNode(w, root);
  return w.toBytes();
}

/**
 * Read a kn5 into a structural summary (for round-trip verification / tests).
 * Mirrors kn5.py read_kn5: it consumes every byte, so `leftover === 0` proves
 * the writer and reader agree.
 */
export function readKn5(data) {
  const r = new ByteReader(data);
  for (let i = 0; i < 6; i++) {
    if (r.u8() !== MAGIC[i]) throw new Error("bad magic");
  }
  const ver = r.u32();
  if (ver > 5) r.u32();

  const textures = [];
  const texCount = r.i32();
  for (let i = 0; i < texCount; i++) {
    r.i32();                 // active
    const name = r.str();
    const size = r.u32();
    r.take(size);
    textures.push([name, size]);
  }

  const materials = [];
  const matCount = r.i32();
  for (let i = 0; i < matCount; i++) {
    const name = r.str();
    const shader = r.str();
    r.u8();                  // blend
    r.u8();                  // alphaTested
    if (ver > 4) r.i32();    // depth
    const props = [];
    const propCount = r.u32();
    for (let p = 0; p < propCount; p++) {
      const pn = r.str();
      const a = r.f32();
      r.take(36);            // v2 + v3 + v4
      props.push([pn, a]);
    }
    const texs = [];
    const tc = r.u32();
    for (let t = 0; t < tc; t++) {
      const mp = r.str();
      r.u32();               // slot
      const tn = r.str();
      texs.push([mp, tn]);
    }
    materials.push({ name, shader, props, textures: texs });
  }

  const nodes = [];
  const readNode = () => {
    const t = r.u32();
    const name = r.str();
    const nchild = r.u32();
    const info = { type: t, name, children: nchild };
    r.u8();                  // active
    if (t === NODE_DUMMY) {
      r.take(64);
    } else if (t === NODE_MESH) {
      r.u8(); r.u8(); r.u8();
      const vc = r.u32();
      info.vertices = vc;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < vc; v++) {
        const p = r.vec3();
        for (let axis = 0; axis < 3; axis++) {
          if (p[axis] < min[axis]) min[axis] = p[axis];
          if (p[axis] > max[axis]) max[axis] = p[axis];
        }
        r.take((3 + 2 + 3) * 4); // normal + uv + tangent
      }
      if (vc) info.positionBounds = { min, max };
      const ic = r.u32();
      info.indices = ic;
      r.take(ic * 2);
      info.materialId = r.u32();
      r.take(29);
    }
    nodes.push(info);
    for (let c = 0; c < nchild; c++) readNode();
  };
  readNode();

  return { version: ver, textures, materials, nodes, leftover: r.leftover };
}
