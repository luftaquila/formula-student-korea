// Converter → rover chassis mount plate.
// 3-point chassis support (A, B, C). Board has 2 mount holes.
// Self-tapping M3 on both sides.
// Board sits on raised bosses; the plate body never contacts the PCB.

$fn = 64;

// ---- Plate ----
plate_thickness = 3;
plate_pad_r     = 3;      // rim around board bosses (= boss_od/2)
chassis_pad_r   = 4;      // rim around chassis holes

// ---- M3 self-tapping ----
m3_clearance    = 3.4;    // chassis-side: through-hole for M3 shank
m3_self_pilot   = 2.8;    // board-side: pilot bore for self-tap into plastic

// ---- Board-side bosses ----
boss_h          = 5;      // standoff height under PCB (airflow gap)
boss_od         = 6;

// ---- Chassis screw positions (3-point) ----
// A as origin; B 24mm below A; C 23mm right of B.
A = [ 0,   0];
B = A + [ 0, -24];
C = B + [23,   0];
chassis_screws = [A, B, C];

// ---- Board screws (2 holes) ----
// h1: y = midpoint of A and B; x = A.x - 9.
// h2: 51.5mm right of h1 (originally 53.5; field tweak: shifted 2mm left).
board_h1 = [A[0] - 9, (A[1] + B[1]) / 2];
board_h2 = board_h1 + [51.5, 0];
board_screws_p = [board_h1, board_h2];

// ---- Boss-height island inside the chassis-3-point bounding box ----
// The 3 chassis screws span a rectangular bbox; place a raised pad
// inside that bbox with margin so it clears each chassis pilot.
island_margin = 5;

function vmin(vs, i) = min([for (p = vs) p[i]]);
function vmax(vs, i) = max([for (p = vs) p[i]]);

island_x0 = vmin(chassis_screws, 0) + island_margin;
island_y0 = vmin(chassis_screws, 1) + island_margin;
island_w  = vmax(chassis_screws, 0) - vmin(chassis_screws, 0) - 2 * island_margin;
island_d  = vmax(chassis_screws, 1) - vmin(chassis_screws, 1) - 2 * island_margin;

module chassis_hole() {
    translate([0, 0, -0.1])
        cylinder(d = m3_clearance, h = plate_thickness + 0.2);
}

module boss() {
    translate([0, 0, plate_thickness])
        cylinder(d = boss_od, h = boss_h);
}

module boss_pilot() {
    translate([0, 0, -0.1])
        cylinder(d = m3_self_pilot, h = plate_thickness + boss_h + 0.2);
}

module plate_body() {
    // Convex hull of all 5 screw positions: rounded pentagon with
    // straight tangent edges between adjacent cylinders.
    hull() {
        for (p = board_screws_p)
            translate([p[0], p[1], 0])
                cylinder(r = plate_pad_r, h = plate_thickness);
        for (p = chassis_screws)
            translate([p[0], p[1], 0])
                cylinder(r = chassis_pad_r, h = plate_thickness);
    }
}

module island() {
    translate([island_x0, island_y0, plate_thickness])
        cube([island_w, island_d, boss_h]);
}

module converter_plate() {
    difference() {
        union() {
            plate_body();
            for (p = board_screws_p)
                translate([p[0], p[1], 0]) boss();
            island();
        }
        for (p = chassis_screws)
            translate([p[0], p[1], 0]) chassis_hole();
        for (p = board_screws_p)
            translate([p[0], p[1], 0]) boss_pilot();
    }
}

converter_plate();
