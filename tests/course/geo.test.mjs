import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  haversine, COORD_DECIMALS, formatCoord, formatLatLng, ALT_DECIMALS, formatAlt,
} from "../../course/lib/geo.mjs";

describe("haversine", () => {
  it("returns 0 for the same point", () => {
    assert.equal(haversine({ lat: 35.28, lng: 128.63 }, { lat: 35.28, lng: 128.63 }), 0);
  });

  it("measures a known north-south offset", () => {
    // 0.001° of latitude ≈ 111.2 m anywhere on the globe.
    const d = haversine({ lat: 35.28, lng: 128.63 }, { lat: 35.281, lng: 128.63 });
    assert.ok(Math.abs(d - 111.2) < 0.5, `${d.toFixed(2)} m`);
  });
});

describe("coordinate display formatting", () => {
  it("pads to a fixed 8 decimals so panels line up", () => {
    assert.equal(COORD_DECIMALS, 8);
    assert.equal(formatCoord(35.28), "35.28000000");
    assert.equal(formatCoord(128.6312345678), "128.63123457");
    assert.equal(formatCoord(-1.5), "-1.50000000");
    assert.equal(formatCoord(0), "0.00000000");
  });

  it("keeps every digit an RTK fix can justify", () => {
    // 8 decimals ≈ 1.1 mm — a decimal finer than the receiver's cm-level h_acc,
    // so display rounding never hides a real difference between two fixes.
    const a = { lat: 35.28, lng: 128.63 };
    const b = { lat: Number(formatCoord(35.28 + 1e-8)), lng: 128.63 };
    assert.notEqual(formatCoord(a.lat), formatCoord(b.lat));
    assert.ok(haversine(a, b) < 0.002, `${haversine(a, b)} m`);
  });

  it("joins a pair as 'lat, lng'", () => {
    assert.equal(formatLatLng(35.28, 128.63), "35.28000000, 128.63000000");
  });
});

describe("altitude display formatting", () => {
  it("pads to a fixed 2 decimals (1 cm) everywhere", () => {
    assert.equal(ALT_DECIMALS, 2);
    assert.equal(formatAlt(12.3), "12.30");
    assert.equal(formatAlt(12.345), "12.35");
    assert.equal(formatAlt(0), "0.00");
    assert.equal(formatAlt(-3.5), "-3.50");
  });

  it("no longer collapses a cm-level difference the way 1 decimal did", () => {
    // The cone list used to show 1 decimal, so two cones 4 cm apart in height
    // read as the same "12.3 m" there while the detail panel disagreed.
    assert.notEqual(formatAlt(12.32), formatAlt(12.36));
  });
});
