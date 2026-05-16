// Switch holder — 2-piece sealed enclosure for a panel-mount push-button.
//
// CUP (lower): closed bottom + walls (6 mm), open top. Bottom plate has
// chassis mount holes. 4 corner M3 self-tap pilots embedded in the wall
// at the top.
//
// LID / PANEL (upper): flat plate (3.5 mm). Center ø22.3 hole for the M22
// thread. 4 corner counterbored holes — 3 mm deep ø5.7 counterbore (= M3
// head fully buried) + 0.5 mm shoulder of ø3.4 shank-clearance below, for
// the bolt head to clamp the lid against the cup. No tongue, no internal
// protrusion. M22 thread above lid for the nut: 6 - 3.5 = 2.5 mm.
//
// Box depth math (panel-inside portion fully enclosed):
//   cup_h = floor_t + sq_h + col_h = 3 + 33.8 + 13 = 49.8 mm
//   cavity height = sq_h + col_h = 46.8 mm  (≥ 42.5 mm panel min)
//
// Assembly:
//   1. Bolt cup to chassis through bottom mount holes.
//   2. Drop switch into cavity from open top.
//   3. Set lid — tongue enters cavity opening, plate seats on cup rim.
//   4. M3 self-tap (×4) through plate counterbores into cup wall pilots.
//   5. M22 nut on top clamps switch (ø24 shoulder ↔ plate ø22.3 underside).

$fn = 64;

// ---- Switch dimensions ----
sq_x         = 29.2;       // square contact block width  (X)
sq_y         = 37.2;       // square contact block depth  (Y)
sq_h         = 33.8;       // square contact block height (Z)
col_d        = 24;         // largest column OD (= ø24 threaded base)
col_h        = 13;         // ø24 + ø21.8 column height above square base
panel_d      = 22.3;       // M22 panel hole through lid plate

// ---- Cup ----
wall         = 6;          // thin enough; gives 0.65 mm material between
                           // counterbore and plate outer edge with 1.2 mm
                           // around the M3 self-tap pilot (cavity-side)
floor_t      = 3;
clearance    = 0.4;        // cavity clearance per side around square base

// ---- Lid (panel) ----
lid_t        = 3.5;        // 3 mm counterbore (M3 head) + 0.5 mm shoulder
                           // for bolt head to clamp the plate.

// ---- Lid-to-cup screws (M3 self-tap, ISO 4762 socket head cap) ----
m3_pilot     = 2.6;        // self-tap pilot in cup walls (PLA/PETG)
m3_clearance = 3.4;        // shank clearance through lid plate
m3_head_d    = 5.7;        // counterbore (ø5.5 head + light fit)
m3_head_h    = 3.0;        // counterbore depth
corner_inset = 3.5;        // counterbore sits 0.65 mm inside plate edge
screw_depth  = 10;         // pilot depth into cup wall

// ---- Mount holes (cup bottom face, into chassis) ----
// 2× M3 clearance at diagonal corners of a mount_rect_x × mount_rect_y
// rectangle, shifted along the longer (Y) axis by mount_offset_y from the
// bottom-face center. 1× M2 clearance for wiring on the opposite side.
m3_clear        = 3.4;
m2_clear        = 2.4;
mount_rect_x    = 1.5;     // mount-hole rectangle width  (X) — small diagonal
mount_rect_y    = 9;       // mount-hole rectangle depth  (Y)
mount_offset_y  = 8;       // shift of mount rect along +Y from center
wiring_offset_y = -12;     // M2 wiring hole position (opposite side, -Y)

mount_holes  = [
    [-mount_rect_x/2, mount_offset_y + mount_rect_y/2, m3_clear],
    [ mount_rect_x/2, mount_offset_y - mount_rect_y/2, m3_clear],
    [0,               wiring_offset_y,                 m2_clear],
];

// ---- View ----
view = "exploded";         // "cup" | "lid" | "exploded" | "assembled" | "side"

// ---- Derived ----
inner_x   = sq_x + 2 * clearance;
inner_y   = sq_y + 2 * clearance;
outer_x   = inner_x + 2 * wall;
outer_y   = inner_y + 2 * wall;
cup_h     = floor_t + sq_h + col_h;

corner_screws = [
    [ outer_x/2 - corner_inset,  outer_y/2 - corner_inset],
    [-outer_x/2 + corner_inset,  outer_y/2 - corner_inset],
    [ outer_x/2 - corner_inset, -outer_y/2 + corner_inset],
    [-outer_x/2 + corner_inset, -outer_y/2 + corner_inset],
];

module cup() {
    difference() {
        translate([-outer_x/2, -outer_y/2, 0])
            cube([outer_x, outer_y, cup_h]);

        // Switch cavity — rectangular, full inner height, open top.
        translate([-inner_x/2, -inner_y/2, floor_t])
            cube([inner_x, inner_y, sq_h + col_h + 0.1]);

        // Chassis mounting holes through bottom plate.
        for (h = mount_holes)
            translate([h[0], h[1], -0.1])
                cylinder(d = h[2], h = floor_t + 0.2);

        // Lid screw pilots (top of walls, 4 corners).
        for (p = corner_screws)
            translate([p[0], p[1], cup_h - screw_depth])
                cylinder(d = m3_pilot, h = screw_depth + 0.1);
    }
}

// Lid: flat plate, no internal protrusion.
// Each corner hole = ø3.4 shank clearance through full plate + ø5.7
// counterbore from top down by m3_head_h (head buried, head bottom clamps
// the 0.5 mm shoulder of plate left below the counterbore).
module lid() {
    difference() {
        translate([-outer_x/2, -outer_y/2, 0])
            cube([outer_x, outer_y, lid_t]);

        // M22 hole through plate.
        translate([0, 0, -0.1])
            cylinder(d = panel_d, h = lid_t + 0.2);

        // Corner counterbored holes.
        for (p = corner_screws) {
            translate([p[0], p[1], -0.1])
                cylinder(d = m3_clearance, h = lid_t + 0.2);
            translate([p[0], p[1], lid_t - m3_head_h])
                cylinder(d = m3_head_d, h = m3_head_h + 0.1);
        }
    }
}

if      (view == "cup")       cup();
else if (view == "lid")       lid();
else if (view == "exploded")  { cup(); translate([0, 0, cup_h + 10]) lid(); }
else if (view == "assembled") { cup(); translate([0, 0, cup_h]) lid(); }
else if (view == "side")      { cup(); translate([outer_x + 10, 0, 0]) lid(); }
