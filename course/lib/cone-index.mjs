// Per-side sequence number for cones — the "#N" shown on markers and in the cone
// list. A cone's index is its 1-based rank among same-side cones ordered by
// ascending id (so the earliest-added left cone is left #1, and so on).
//
// Computed in a single O(n) pass into a Map for O(1) lookup. This replaces a
// per-cone `find` + `filter` over the whole cone array, which was O(n²) per
// render — and, because the cone array is a deeply-reactive Vue ref, an O(n²)
// walk through the reactive Proxy `get` trap that re-ran on every map pan.
//
// Semantics match the original exactly: rank = count of same-side cones whose id
// is <= this cone's id (inclusive of itself). Input order is irrelevant; ranking
// is by id, so the array is copied and sorted (never mutated in place, which on a
// reactive array would trigger a reactivity loop).
export function buildSideRanks(cones) {
  const counts = {};
  const ranks = new Map();
  for (const c of [...cones].sort((a, b) => a.id - b.id)) {
    counts[c.side] = (counts[c.side] || 0) + 1;
    ranks.set(c.id, counts[c.side]);
  }
  return ranks;
}
