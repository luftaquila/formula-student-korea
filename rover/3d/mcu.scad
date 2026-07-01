// MCU board → rover chassis mount plate.
// 3-point chassis support (A, B, C). Board has 4 M2 mount holes
// at the corners of a 36 × 56 rectangle.
// Self-tapping screws on both sides.

$fn = 64;

// ---- Plate ----
plate_thickness = 3;
plate_pad_r     = 2.5;    // rim around each board boss (= boss_od/2)
chassis_pad_r   = 4;      // rim around each chassis hole that protrudes outside the base

// ---- Chassis side (rover hardware): M3 self-tapping ----
m3_clearance    = 3.4;

// ---- Board side: M2 self-tapping ----
m2_self_pilot   = 1.8;

// ---- Board-side bosses ----
boss_h          = 5;      // standoff height under PCB (airflow gap)
boss_od         = 5;

// ---- Chassis screw positions (3-point) ----
// C = A + (right 2, down 45). B = C + (left 22, up 30).
A = [0, 0];
C = A + [  2, -45];
B = C + [-22,  30];
chassis_screws = [A, B, C];

// Chassis holes that exit the board-boss base outline → need a lobe.
external_chassis = [];

// ---- Board screws (4 corners of a 36 × 56 rectangle) ----
board_dx = 36;
board_dy = 56;
board_screws = [
    [       0,        0],
    [board_dx,        0],
    [board_dx, board_dy],
    [       0, board_dy],
];

// ---- Anchor: center board over chassis bounding box ----
function vmin(vs, i) = min([for (p = vs) p[i]]);
function vmax(vs, i) = max([for (p = vs) p[i]]);
chassis_cx     = (vmin(chassis_screws, 0) + vmax(chassis_screws, 0)) / 2;
chassis_cy     = (vmin(chassis_screws, 1) + vmax(chassis_screws, 1)) / 2;
board_off      = [chassis_cx - board_dx / 2, chassis_cy - board_dy / 2];
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
        cylinder(d = m2_self_pilot, h = plate_thickness + boss_h + 0.2);
}

module plate_body() {
    union() {
        // base outline: rounded rectangle hugging the 4 board bosses
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

module mcu_plate() {
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

mcu_plate();
