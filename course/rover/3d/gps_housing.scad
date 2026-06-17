// FSK GPS-registration unit — carry housing.
//
// The base plate NESTS UP INTO the housing (slip fit inside the walls), flush
// with the wall bottom edge. The Pi lies flat on it. The ZED-F9P is stacked
// above, hung from the CEILING on 4 posts. Lift the housing and the ZED comes
// with it; the base plate (Pi) stays clear.
//
//   BASE PLATE — Pi on 4 short M2.5 bosses; slides up into the housing bottom.
//                M2 socket-cap join bolts come up from below into the corner
//                pillars; their heads are buried in the plate's bottom face.
//   HOUSING    — walls + ceiling, open bottom that captures the base plate.
//                4 square ZED posts drop from the ceiling (35 mm above the ZED →
//                ceiling antenna mount). SMA bulkhead at the ceiling centre. Pi
//                power exits a +Y-wall slot. 4 square join pillars are BUILT INTO
//                the wall corners and sit on the base-plate top.
//
// ZED ceiling posts and corner join pillars are SQUARE; Pi bosses are round.
//
// Clearances: GPS X 40 mm both sides · RPi front 30 mm · GPS top→ceiling 35 mm.
//
// VERIFIED geometry:
//   • Pi Zero 2 W — RPI-ZERO-V1_2 drawing: 65×30, 4×M2.5 on 58×23 (3.5 insets).
//     Connectors one long edge; from microSD edge: HDMI 12.4, USB 41.4, PWR 54.0.
//   • ZED-F9P — 4×M3 on 38×38. SMA Ø6.5 + Ø16 pad. M2 socket-cap = Ø3.8 head ×2.0.
//
// VERIFY: zed_x/zed_y outline; zed_z; fit_clear (printer slip fit).

$fn = 64;
eps = 0.1;

// "exploded" | "assembled" | "base" | "housing"
view        = "exploded";
explode     = 80;

/* ------------------------------ Boards ------------------------------ */
pi_x         = 65;
pi_y         = 30;
pi_hole_dx   = 58;
pi_hole_dy   = 23;
pi_pcb_t     = 1.4;
pwr_x_edge   = 54.0;    // PWR micro-USB centre, from the microSD/left edge

zed_hole     = 38;      // 4×M3 on a 38×38 square
zed_x        = 38;      // outline ≈ mount pattern (VERIFY)
zed_y        = 38;
zed_pcb_t    = 1.6;

/* ----------------------- Layout / clearances ------------------------ */
boss_h        = 5;      // Pi standoff height
gps_x_clear   = 40;     // 40 mm each X side of the ZED (antenna −X, USB +X)
pi_front_clear= 30;     // 30 mm ahead of the Pi connector edge (+Y)
back_margin   = 6;      // wall room behind the boards (−Y)
zed_z         = 28;     // ZED board height above the base-plate top (clears the Pi)
ceil_gap      = 35;     // ZED top → ceiling antenna mount (per spec)

/* ---------------------- Shell / fasteners --------------------------- */
wall         = 3;
ceil_t       = 3;
base_t       = 4;       // base-plate thickness: M2 head (2.0) buried + 2.0 left
fit_clear    = 0.4;     // base-plate slip fit inside the walls (0.2/side)
pi_boss_d    = 6;       // Pi standoff (round cylinder)
zed_post_sq  = 7;       // ZED ceiling post (square)
corner_sq    = 9;       // base-plate join pillar (square, in the wall corner)
round_r      = 2;       // exterior edge rounding so it's hand-safe

m25_pilot    = 2.1;     // M2.5 self-tap (Pi)
m3_pilot     = 2.6;     // M3 self-tap (ZED ceiling posts)
zed_pilot_depth  = 6;
// M2 socket-cap join (base plate → corner pillars)
m2_clear     = 2.4;     // M2 shank clearance
m2_head_d    = 4.0;     // Ø3.8 socket-cap head + fit
m2_head_h    = 2.0;     // head height (buried in the plate bottom)
m2_pilot     = 1.7;     // M2 self-tap into the pillar
join_depth   = 8;

/* ----------------------- Antenna (ceiling) -------------------------- */
sma_hole_d   = 6.5;
sma_pad_d    = 16;
sma_pad_h    = 1;

/* ----------------------- Power-cable notch -------------------------- */
power_w      = 14;
power_h      = 11;

/* --------------------------- Derived -------------------------------- */
interior_x = max(zed_x + 2 * gps_x_clear, pi_x + 12);            // 118
interior_y = pi_front_clear + pi_y + (zed_y - pi_y)/2 + back_margin; // 70
interior_h = zed_z + zed_pcb_t + ceil_gap;                       // 64.6 (cavity above plate)
outer_x    = interior_x + 2 * wall;
outer_y    = interior_y + 2 * wall;
base_w     = interior_x - fit_clear;
base_d     = interior_y - fit_clear;

// z = 0 is the base-plate TOP (boards mount here). Plate body is z[-base_t, 0];
// the housing walls wrap down to -base_t around it.
board_cy = -interior_y/2 + back_margin + zed_y/2;
pwr_x    =  pwr_x_edge - pi_x/2;                        // +21.5

pi_holes = [
    [-pi_hole_dx/2, board_cy - pi_hole_dy/2],
    [ pi_hole_dx/2, board_cy - pi_hole_dy/2],
    [ pi_hole_dx/2, board_cy + pi_hole_dy/2],
    [-pi_hole_dx/2, board_cy + pi_hole_dy/2],
];
zed_holes = [
    [-zed_hole/2, board_cy - zed_hole/2],
    [ zed_hole/2, board_cy - zed_hole/2],
    [ zed_hole/2, board_cy + zed_hole/2],
    [-zed_hole/2, board_cy + zed_hole/2],
];
corner_signs = [[1,1], [-1,1], [1,-1], [-1,-1]];
corner_posts = [for (s = corner_signs)
    [s[0] * (interior_x/2 - corner_sq/2), s[1] * (interior_y/2 - corner_sq/2)]];

/* ============================= MODULES ============================== */

module sq_post(cx, cy, z0, hgt, sq) {
    translate([cx - sq/2, cy - sq/2, z0]) cube([sq, sq, hgt]);
}

// Box centred in X/Y, spanning z[z0, z0+h], with EVERY outer edge rounded (r).
module rounded_box(w, d, h, z0, r) {
    hull() for (sx = [-1, 1]) for (sy = [-1, 1]) for (sz = [0, 1])
        translate([sx * (w/2 - r), sy * (d/2 - r), z0 + (sz == 0 ? r : h - r)]) sphere(r);
}

// Base plate: nests inside the housing. Body z[-base_t, 0]; Pi bosses on top.
module base_plate() {
    difference() {
        union() {
            translate([-base_w/2, -base_d/2, -base_t]) cube([base_w, base_d, base_t]);
            for (p = pi_holes) translate([p[0], p[1], 0]) cylinder(d = pi_boss_d, h = boss_h);
        }
        // Pi M2.5 self-tap (driven from the top, into boss + a little plate).
        for (p = pi_holes)
            translate([p[0], p[1], -2]) cylinder(d = m25_pilot, h = boss_h + 2 + eps);
        // M2 join: shank clearance through the plate + head counterbore buried in
        // the BOTTOM face (z = -base_t). base_t = head(2.0) + 2.0 mm left above it.
        for (c = corner_posts) {
            translate([c[0], c[1], -base_t - eps]) cylinder(d = m2_clear,  h = base_t + 2*eps);
            translate([c[0], c[1], -base_t - eps]) cylinder(d = m2_head_d, h = m2_head_h + eps);
        }
    }
}

// Housing: walls (down to -base_t) + ceiling; carries ZED posts + join pillars.
module housing() {
    union() {
        difference() {
            rounded_box(outer_x, outer_y, base_t + interior_h + ceil_t, -base_t, round_r);
            // Full interior column: base-plate recess (z<0) + cavity (z>0).
            translate([-interior_x/2, -interior_y/2, -base_t - eps])
                cube([interior_x, interior_y, base_t + interior_h + eps]);
            // PWR slot in the +Y wall at the Pi connector level.
            translate([pwr_x - power_w/2, interior_y/2 - eps, 0]) cube([power_w, wall + 2*eps, power_h]);
            // SMA bulkhead hole through the ceiling centre.
            translate([0, 0, interior_h - eps]) cylinder(d = sma_hole_d, h = ceil_t + 2*eps);
        }
        // Antenna reinforcement pad.
        difference() {
            translate([0, 0, interior_h - sma_pad_h]) cylinder(d = sma_pad_d, h = sma_pad_h);
            translate([0, 0, interior_h - sma_pad_h - eps]) cylinder(d = sma_hole_d, h = sma_pad_h + 2*eps);
        }
        // ZED ceiling posts (square): ceiling → zed_z; M3 pilot from below.
        for (p = zed_holes)
            difference() {
                sq_post(p[0], p[1], zed_z, interior_h - zed_z, zed_post_sq);
                translate([p[0], p[1], zed_z - eps]) cylinder(d = m3_pilot, h = zed_pilot_depth + eps);
            }
        // Join pillars (square): built into the wall corners, sit on the plate
        // top (z=0). M2 self-tap pilot for the bolt coming up from the plate.
        for (s = corner_signs)
            let(lx = (s[0] > 0) ? interior_x/2 - corner_sq : -interior_x/2,
                ly = (s[1] > 0) ? interior_y/2 - corner_sq : -interior_y/2,
                cx = s[0] * (interior_x/2 - corner_sq/2),
                cy = s[1] * (interior_y/2 - corner_sq/2))
            difference() {
                translate([lx, ly, 0]) cube([corner_sq, corner_sq, interior_h]);
                translate([cx, cy, -eps]) cylinder(d = m2_pilot, h = join_depth + eps);
            }
    }
}

/* ============================== VIEW =============================== */
if (view == "base") {
    base_plate();
} else if (view == "housing") {
    housing();
} else if (view == "assembled") {
    base_plate();
    housing();
} else {  // exploded
    translate([0, 0, -explode]) base_plate();
    housing();
}
