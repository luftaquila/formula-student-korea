// MDD10A → rover chassis mount plate.
// Self-tapping M3 on both sides.
// Board sits on raised bosses; the plate body never contacts the PCB
// so the MDD10A heatsink/back side has clear airflow.

$fn = 64;

// ---- Plate ----
plate_thickness = 3;
plate_pad_r     = 3;      // base rim around each board boss (= boss_od/2)
chassis_pad_r   = 4;      // lobe around each chassis hole that protrudes outside the base

// ---- M3 self-tapping ----
m3_clearance    = 3.4;    // chassis-side: through-hole for M3 shank
m3_self_pilot   = 2.8;    // board-side: pilot bore for self-tap into plastic

// ---- Board-side bosses ----
boss_h          = 5;      // standoff height under PCB (airflow gap)
boss_od         = 6;

// ---- Board screw spacing (4 corners of a rectangle) ----
board_dx        = 55.88;
board_dy        = 78.74;

// ---- Chassis screw positions ----
// Base layout (A as origin):
//   B = A + (right 41, down 14)
//   C = A + (left 5,  down 68)
//   D = C + (right 37, down 1)
// Field tweaks: D shifted left 2mm; C placed 37.5mm left of D (Y preserved);
//               A keeps original C→A relationship (right 5, up 68);
//               B repositioned 45mm above D.
D = [  30, -69];
C = D + [-37.5,  1];
A = C + [    5, 68];
B = D + [    0, 45];
chassis_screws = [A, B, C, D];

// Chassis holes whose footprint exits the board-boss base outline → need a lobe.
external_chassis = [];

board_screws = [
    [       0,        0],
    [board_dx,        0],
    [board_dx, board_dy],
    [       0, board_dy],
];

// ---- Anchor board so its BR corner is 8mm right of chassis hole D, same Y ----
br_target      = D + [8, 0];
board_off      = br_target - [board_dx, 0];
board_screws_p = [for (p = board_screws) p + board_off];

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
    union() {
        // base outline: rounded rectangle hugging the 4 board bosses
        // (tangent straight edges between adjacent boss circles)
        hull()
            for (p = board_screws_p)
                translate([p[0], p[1], 0])
                    cylinder(r = plate_pad_r, h = plate_thickness);
        // circular lobe only for chassis holes that would otherwise exit the base
        for (p = external_chassis)
            translate([p[0], p[1], 0])
                cylinder(r = chassis_pad_r, h = plate_thickness);
    }
}

module mdd10a_plate() {
    difference() {
        union() {
            plate_body();
            for (p = board_screws_p)
                translate([p[0], p[1], 0]) boss();
        }
        for (p = chassis_screws)
            translate([p[0], p[1], 0]) chassis_hole();
        for (p = board_screws_p)
            translate([p[0], p[1], 0]) boss_pilot();
    }
}

mdd10a_plate();
