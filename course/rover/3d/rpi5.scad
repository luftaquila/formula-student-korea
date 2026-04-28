// Raspberry Pi 5 → rover chassis mount plate.
// 4 board mounts (RPi5 standard 58 × 49). 4-point chassis support.
// Two board holes coincide with chassis holes (TL=A, BR=D), so a single
// M2.5 screw at each shared point fastens chassis-plate-PCB.
// Chassis-only screws are M3; shared and board self-tap are M2.5.
// Board sits on raised bosses for airflow.

$fn = 64;

// ---- Plate ----
plate_thickness = 3;
plate_pad_r     = 3;      // rim around board bosses (= boss_od/2)
chassis_pad_r   = 4;      // rim around chassis holes that exit the base

// ---- Fasteners ----
m3_clearance    = 3.4;    // M3 through-hole (chassis-only screws)
m25_clearance   = 2.7;    // M2.5 through-hole (shared screws)
m25_self_pilot  = 2.3;    // M2.5 self-tap pilot (board-only bosses)

// ---- Board-side bosses ----
boss_h          = 5;      // standoff height under PCB
boss_od         = 6;

// ---- Board screws (RPi5 mounting holes, 4 corners of 58 × 49) ----
board_dx        = 58;
board_dy        = 49;
board_TL        = [       0,         0];
board_TR        = [board_dx,         0];
board_BL        = [       0, -board_dy];
board_BR        = [board_dx, -board_dy];
board_screws_p  = [board_TL, board_TR, board_BL, board_BR];

// ---- Chassis screws ----
// A coincides with board TL; D coincides with board BR.
// C = A + (-1, -19); B = D + (0, 30).
A = board_TL;
D = board_BR;
C = A + [-1, -19];
B = D + [ 0,  30];
chassis_screws = [A, B, C, D];

// Position groups
shared_positions       = [A, D];                  // single screw fastens both
board_only_positions   = [board_TR, board_BL];    // boss + self-tap pilot
chassis_only_positions = [B, C];                  // plate clearance only, no boss

// Chassis holes too close to the base outline to leave material around them
// → extend the plate toward the deficient side via a circular lobe.
external_chassis = [B, C];

module hole(d, depth) {
    translate([0, 0, -0.1])
        cylinder(d = d, h = depth + 0.2);
}

module boss() {
    translate([0, 0, plate_thickness])
        cylinder(d = boss_od, h = boss_h);
}

module plate_body() {
    union() {
        // Base outline: rounded rectangle hugging the 4 board bosses.
        hull()
            for (p = board_screws_p)
                translate([p[0], p[1], 0])
                    cylinder(r = plate_pad_r, h = plate_thickness);
        // Lobes only for chassis holes that exit the base.
        for (p = external_chassis)
            translate([p[0], p[1], 0])
                cylinder(r = chassis_pad_r, h = plate_thickness);
    }
}

module rpi5_plate() {
    full_depth = plate_thickness + boss_h;
    difference() {
        union() {
            plate_body();
            for (p = board_screws_p)
                translate([p[0], p[1], 0]) boss();
        }
        // Chassis-only: M3 clearance through plate (no boss above).
        for (p = chassis_only_positions)
            translate([p[0], p[1], 0]) hole(m3_clearance, plate_thickness);
        // Board-only: M2.5 self-tap pilot through plate + boss.
        for (p = board_only_positions)
            translate([p[0], p[1], 0]) hole(m25_self_pilot, full_depth);
        // Shared: M2.5 clearance through plate + boss for one through-screw.
        for (p = shared_positions)
            translate([p[0], p[1], 0]) hole(m25_clearance, full_depth);
    }
}

rpi5_plate();
