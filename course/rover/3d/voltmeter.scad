// Voltmeter holder tube — bigger of the two from Suporte+Voltimetro+3+v1.stl,
// upright (axis = +Z) with no tilt. Holds a ZN30 round digital voltmeter
// (33.8 mm bezel, 30 mm body, 18.4 mm total height). Outer Ø matches the
// bezel so the bezel sits flush on the rim. Closed bottom.
//
// ZN30 has two opposing vertical spring-clip tabs on the body. As the meter
// is pressed down into the holder, the clips deflect inward against the
// cavity wall, then snap back outward into the slit pockets. The meter is
// retained because the clip catches on the SLIT TOP EDGE.
//   • Slits are pockets on the inner wall — they do NOT cut through to the
//     outside; an outer skin of `outer_skin` mm is left intact.
//   • A lip of `top_lip` mm is left above each slit so the clip has a top
//     edge to catch on.
//
// Bottom features:
//   • Connector hole (10.5 × 6.7 mm) on the +X side, aligned with one slit.
//   • M3 mounting hole on the −X side, with a 1 mm counterbore on the
//     cavity side. Floor is only 2 mm so the M3 SHCS head (~3 mm tall)
//     protrudes ~2 mm into the cavity — fine because the meter body
//     bottoms out well above the floor.

inner_d      = 30;     // body / cutout
outer_d      = 33.8;   // bezel
inner_depth  = 20;
floor_t      = 2;

// spring-clip slits — clip 9.7 mm wide × 9 mm axial (vertical-press tabs)
clip_w     = 9.7;   // arc length on the inner wall
clip_h     = 9;     // axial depth of the clip / slit
top_lip    = 2;     // material left above the slit (catch surface for the clip)
outer_skin = 0.8;   // outer wall left intact (slit is a pocket, not a window)

// connector hole (+X side, aligned with the 0° slit)
hole_long   = 10.5;
hole_short  = 6.7;
hole_gap    = 2.5;          // mid-of-long-side to inner-circle edge

// M3 mounting hole (−X side)
m3_clearance_d = 3.2;       // close fit for M3 bolt
m3_head_d      = 6.0;       // counterbore Ø for M3 SHCS head (Ø5.5 + clearance)
m3_clamp_t     = 1.0;       // floor left below the counterbore (clamping)
m3_x           = -9;        // bolt centre, mirror of connector hole side

height = inner_depth + floor_t;
wall   = (outer_d - inner_d) / 2;

// arc-length → sweep angle on the inner wall
slit_angle = clip_w / (inner_d / 2) * 180 / PI;

$fn = 120;

module slit_at(direction_deg) {
    slit_depth = wall - outer_skin;
    rotate([0, 0, direction_deg - slit_angle / 2])
        rotate_extrude(angle = slit_angle)
            translate([inner_d / 2 - 0.5, height - top_lip - clip_h])
                square([slit_depth + 0.5, clip_h]);
}

module connector_hole() {
    translate([inner_d / 2 - hole_gap - hole_short, -hole_long / 2, -0.1])
        cube([hole_short, hole_long, floor_t + 0.2]);
}

module m3_mount() {
    // through-hole for the bolt shank
    translate([m3_x, 0, -0.1])
        cylinder(h = floor_t + 0.2, d = m3_clearance_d);
    // counterbore from the cavity-floor side, leaving `m3_clamp_t` for clamping
    translate([m3_x, 0, m3_clamp_t])
        cylinder(h = floor_t - m3_clamp_t + 0.1, d = m3_head_d);
}

difference() {
    cylinder(h = height, d = outer_d);

    translate([0, 0, floor_t])
        cylinder(h = inner_depth + 0.1, d = inner_d);

    slit_at(0);
    slit_at(180);

    connector_hole();
    m3_mount();
}
