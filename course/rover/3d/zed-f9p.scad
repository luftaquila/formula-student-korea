// ZED-F9P GPS module → rover chassis mount plate.
// Board: 4 M3 mount holes at the corners of a 38 × 38 square.
// Chassis: 4 M2 mount holes at the corners of an 18.5 × 14 rectangle.
// Both patterns share the same origin (hole-centre coordinates),
// so the plate is symmetric about X and Y.
// Self-tapping screws on both sides.

$fn = 64;

// ---- Plate ----
plate_thickness = 3;
plate_pad_r     = 3.0;    // rim around each board boss (= boss_od/2)
chassis_pad_r   = 4;      // rim around chassis holes that protrude past the base

// ---- Chassis side (rover hardware): M2 self-tapping ----
m2_clearance    = 2.4;

// ---- Board side: M3 self-tapping ----
m3_self_pilot   = 2.6;

// ---- Board-side bosses ----
boss_h          = 5;      // standoff height under PCB (airflow gap)
boss_od         = 6;      // ≥ m3_self_pilot + 2 × wall, walls ≥ 1.7 mm

// ---- Chassis screw positions (4 corners of 18.5 × 14) ----
// Pattern is offset +5 mm in X from the plate origin so the chassis
// bolts align with the rover frame, not the GPS board centre.
chassis_dx       = 18.5;
chassis_dy       = 14;
chassis_offset_x = 5;
chassis_screws = [
    [chassis_offset_x - chassis_dx/2, -chassis_dy/2],
    [chassis_offset_x + chassis_dx/2, -chassis_dy/2],
    [chassis_offset_x + chassis_dx/2,  chassis_dy/2],
    [chassis_offset_x - chassis_dx/2,  chassis_dy/2],
];

// Chassis holes that exit the board-boss base outline → need a lobe.
// 18.5 × 14 sits well inside the 38 × 38 board pattern, so none.
external_chassis = [];

// ---- Board screws (4 corners of 38 × 38, centre = origin) ----
board_dx = 38;
board_dy = 38;
board_screws = [
    [-board_dx/2, -board_dy/2],
    [ board_dx/2, -board_dy/2],
    [ board_dx/2,  board_dy/2],
    [-board_dx/2,  board_dy/2],
];

module chassis_hole() {
    translate([0, 0, -0.1])
        cylinder(d = m2_clearance, h = plate_thickness + 0.2);
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
        // base outline: rounded square hugging the 4 board bosses
        hull()
            for (p = board_screws)
                translate([p[0], p[1], 0])
                    cylinder(r = plate_pad_r, h = plate_thickness);
        // circular lobe only for chassis holes that would exit the base
        for (p = external_chassis)
            translate([p[0], p[1], 0])
                cylinder(r = chassis_pad_r, h = plate_thickness);
    }
}

module zed_f9p_plate() {
    difference() {
        union() {
            plate_body();
            for (p = board_screws)
                translate([p[0], p[1], 0]) boss();
        }
        for (p = chassis_screws)
            translate([p[0], p[1], 0]) chassis_hole();
        for (p = board_screws)
            translate([p[0], p[1], 0]) boss_pilot();
    }
}

zed_f9p_plate();
