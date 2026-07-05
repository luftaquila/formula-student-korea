// Voltmeter holder — hollow bracket for a ZN30 round digital voltmeter
// (33.8 mm bezel, 30 mm body, 18.4 mm tall) plus two connectors, all wired
// from the open BOTTOM through a shared cavity. Shell walls run well below
// the meter so a harness can be dressed underneath.
//
// Open-bottom shell (perimeter walls + thin top lid), one continuous hollow:
//   • Voltmeter — Ø30 bore through a retention COLLAR hanging from the lid
//     (top 20 mm). Bezel on the collar rim; two spring-clip slits catch the
//     clips. Bore open at the collar bottom → rear terminals sit in the
//     hollow. Cavity centre x = 15 so the bore's LEFT edge is tangent to the
//     x=0 mounting-hole line.
//   • 5569-04A1 (Mini-Fit Jr. dual-row, 4-ckt, FLANGE/screw-mount) — lives in
//     an ㄱ-shaped tab that protrudes +X on the +Y side, sized to the real
//     connector so it CLEARS the collar. Per Molex SD 55690002-SD (body) and
//     SD 55690001-SD / flange sheet: mating-direction depth 12.8, mating face
//     ≈ 9.6 × 9.6, flange holes 13.2 apart (DIM C) 9.7 back from the mating
//     face, connector flange hole Ø2.4 (M3 self-tap). The tab gives two seat
//     pads with Ø3.2 clearance holes at the flange positions — an M3 driven
//     from the open bottom bolts each flange to the holder. Opening faces +X
//     (plug inserts +X → −X); pins drop into the hollow.
//   • XH-2.54 2-pin — window in the +Y wall, −X of the +Y mount hole.
//     Opening faces +Y (plug inserts +Y → −Y). (size still APPROX)
//
// Mounting: 2× M3, 40 mm apart on x=0, at (0, ±20). Solid bosses rise from
// the open bottom into the lid; each takes a blind self-tap pilot (Ø2.9)
// driven from behind the mounting plate — bottom-face fastening only.

// ---- meter / overall ----
inner_d      = 30;
outer_d      = 33.8;
cav_x        = inner_d / 2 - 10;  // 5 — moved −10 from the x=0-tangent position
collar_depth = 20;
wiring_depth = 5;                             // shell below the collar (bottom wiring)
H            = collar_depth + wiring_depth;   // 25
collar_od    = outer_d;

// ---- shell ----
wall_t = 2.5;
top_t  = 2;
top_r  = 2;                // rounding on the top-face edges

// ---- spring-clip slits (from the TOP) ----
clip_w     = 9.7;
clip_h     = 9;
top_lip    = 2;
slit_depth = 1.1;
slit_angle = clip_w / (inner_d / 2) * 180 / PI;

// ---- M3 mounting (bottom self-tap pilots in bosses) ----
mount_spacing = 40;
mount_x       = 0;
boss_od       = 7;
m3_pilot_d    = 2.9;
m3_pilot_h    = 10;

// ---- main body rounded rectangle ----
// body_x1 (main +X edge) is DERIVED below: it sits just behind the connector
// back, so the ㄱ-tab keeps its protrusion while the body drops the +X length
// freed by the voltmeter moving −X.
body_x0 = -17;
body_y0 = -25;  body_y1 = 25;
corner_r = 3;

// ---- 5569-04A1 dual-row 4-ckt, FLANGE variant (Molex SD-5569 series) ----
// Inserted ROTATED 180° about the mating (X) axis: flanges + the ㄱ-bent
// conductor point UP toward the lid, mounted to CEILING seat pads with M2.
c5569_depth      = 12.8;   // +X mating-direction body depth
c5569_w          = 9.6;    // mating face width  (2 columns) → Y
c5569_face_h     = 9.6;    // mating face height (2 rows)    → Z
c5569_bend_h     = 3.5;    // ㄱ bent-conductor leg height (SD-5569: 3.5±0.7), points UP
c5569_bend_x     = 5;      // bent conductor reach behind the housing back (−X)
c5569_clr        = 0.6;    // clearance per side
c5569_cy         = 12;     // connector centre Y (= tab centre; tab 1 mm wider −Y, window centred)
flange_span      = 13.2;   // DIM C — flange-hole centre-to-centre (Y)
flange_from_face = 9.7;    // flange hole back from the mating face (X)
latch_w          = 3.6;    // latch-clearance notch on the window's bottom edge — width (Y)
latch_h          = 4.5;    // latch-clearance notch — height below the window (Z)
m2_pilot_d       = 1.7;    // M2 self-tap pilot in the ceiling seat pad
seat_t           = 4;      // ceiling seat pad thickness (3 → 4, +1 mm thicker)

// ---- XH-2.54 2-pin (APPROX placeholder) ----
cxh_w     = 8;             // along X
cxh_h     = 7;             // entrance height (Z) — bottom filled up 1 mm (was 8)
cxh_depth = 7;             // into the interior (−Y)
cxh_cx    = -9;            // centre X (−X of the +Y hole)
cxh_ztop  = H - 4;         // entrance top; ceiling above it is opened to the top

$fn = 120;

// ---- derived: 5569 ㄱ-tab ----
// The tab protrudes only as far as the connector needs: the housing back is
// placed so the ㄱ-bent conductor (c5569_back − bend_x) clears the collar by
// c5569_gap. As the voltmeter/collar moves −X, the tab shortens automatically.
pocket_w    = 11;                            // 11 × 11 square mating window (Y)
opening_h   = 11;                            // 11 × 11 square mating window (Z)
collar_r    = outer_d / 2;                   // 16.9
c5569_gap   = 2;                             // ㄱ-conductor clearance to the collar
c5569_back  = cav_x + sqrt(collar_r * collar_r - pow(c5569_cy - pocket_w / 2, 2))
                    + c5569_gap + c5569_bend_x;   // housing back
body_x1     = c5569_back + wall_t;           // main +X edge just behind the connector back
c5569_face  = c5569_back + c5569_depth;      // mating face
flange_x    = c5569_face - flange_from_face + 1.5;  // ceiling seat +1.5 mm → connector protrudes ~0.9 mm
flange_z    = H - top_t - seat_t;            // flange plane = ceiling-seat underside
opening_top = flange_z;                      // window TOP edge at the seat-pad face (z=flange_z)
opening_bot = opening_top - opening_h;       // 11 mm below; ㄱ conductor rises behind, in the hollow
tab_x0 = body_x1 - 5;                        // overlap into main body
tab_x1 = c5569_face + c5569_clr;             // tab outer +X face (mating opening)
tab_y0 = 2 * c5569_cy - body_y1;             // tab centred on the window (equal walls)
tab_y1 = body_y1;                            // flush with the body +Y wall (no step)

module rounded_rect_prism(x0, y0, x1, y1, r, h) {
    hull()
        for (px = [x0 + r, x1 - r], py = [y0 + r, y1 - r])
            translate([px, py, 0])
                cylinder(h = h, r = r);
}

// 2D outer profile: body rounded rectangle + ㄱ-tab (square back, rounded +X)
module rr2d(x0, y0, x1, y1, r) {
    hull() for (px = [x0 + r, x1 - r], py = [y0 + r, y1 - r]) translate([px, py]) circle(r = r, $fn = 48);
}
module shell_profile() {
    union() {
        rr2d(body_x0, body_y0, body_x1, body_y1, corner_r);
        hull() {
            translate([tab_x1 - corner_r, tab_y0 + corner_r]) circle(r = corner_r, $fn = 48);
            translate([tab_x1 - corner_r, tab_y1 - corner_r]) circle(r = corner_r, $fn = 48);
            translate([tab_x0, tab_y0]) square([0.01, tab_y1 - tab_y0]);
        }
    }
}
// outer shell: straight walls, flat bottom, top-face edges rounded by top_r
module shell_outer() {
    union() {
        linear_extrude(height = H - top_r) shell_profile();
        translate([0, 0, H - top_r])
            minkowski() {
                linear_extrude(height = 0.01) offset(r = -top_r) shell_profile();
                sphere(r = top_r, $fn = 24);
            }
    }
}

module interior() {
    translate([0, 0, -1])
        rounded_rect_prism(body_x0 + wall_t, body_y0 + wall_t,
                           body_x1 - wall_t, body_y1 - wall_t,
                           max(corner_r - wall_t, 1), H - top_t + 1);
    translate([body_x1 - wall_t - 2, tab_y0 + wall_t, -1])
        cube([(tab_x1 - wall_t) - (body_x1 - wall_t - 2),
              tab_y1 - tab_y0 - 2 * wall_t, H - top_t + 1]);
}

module vm_collar() { translate([cav_x, 0, H - collar_depth]) cylinder(h = collar_depth, d = collar_od); }
module vm_bore()   { translate([cav_x, 0, H - collar_depth - 0.1]) cylinder(h = collar_depth + 0.2, d = inner_d); }

module slit_at(direction_deg) {
    translate([cav_x, 0, 0])
        rotate([0, 0, direction_deg - slit_angle / 2])
            rotate_extrude(angle = slit_angle)
                translate([inner_d / 2 - 0.5, H - top_lip - clip_h])
                    square([slit_depth + 0.5, clip_h]);
}

module mount_boss(y)  { translate([mount_x, y, 0])    cylinder(h = H - top_t, d = boss_od); }
module mount_pilot(y) { translate([mount_x, y, -0.1]) cylinder(h = m3_pilot_h + 0.1, d = m3_pilot_d); }

// +X mating window (housing height only). The connector body sits in the
// already-hollow tab interior; the ㄱ-bent conductor rises into that hollow
// (opening_top → flange_z) and the flanges meet the ceiling seats above.
module pocket_5569() {
    // 11×11 mating window
    translate([tab_x1 - wall_t - 0.5, c5569_cy - pocket_w / 2, opening_bot])
        cube([wall_t + 1, pocket_w, opening_h]);
    // latch-clearance notch on the window's bottom edge (centred, extends down)
    translate([tab_x1 - wall_t - 0.5, c5569_cy - latch_w / 2, opening_bot - latch_h])
        cube([wall_t + 1, latch_w, latch_h + 0.1]);
}
// CEILING seat pads (받침대 겸 마운팅홀): hang from the lid; the flipped
// connector's flanges press up against them, M2 self-taps from below.
module ceiling_seats() {
    for (sy = [-1, 1])
        translate([flange_x - 5, c5569_cy + sy * flange_span / 2 - 3.5, flange_z])
            cube([10, 7, seat_t + 0.1]);
}
module flange_pilots() {
    for (sy = [-1, 1])
        translate([flange_x, c5569_cy + sy * flange_span / 2, flange_z - 1])
            cylinder(h = seat_t + top_t, d = m2_pilot_d);
}
// XH window on the +Y wall — opening on +Y, into the interior; the ceiling
// above it is dropped to the window top (see xh_ceiling), so it stays closed.
module win_xh() {
    translate([cxh_cx - cxh_w / 2, body_y1 - cxh_depth, cxh_ztop - cxh_h])
        cube([cxh_w, cxh_depth + 0.5, cxh_h]);
}
// solid ceiling filler: lowers the interior roof over the XH down to the
// window top (cxh_ztop). Kept INSIDE the +Y wall (no protrusion) — the wall
// itself already caps the wall-side of the window.
module xh_ceiling() {
    translate([cxh_cx - cxh_w / 2, body_y1 - cxh_depth, cxh_ztop])
        cube([cxh_w, cxh_depth - wall_t + 0.5, (H - top_t) - cxh_ztop + 0.1]);
}

module voltmeter() {
difference() {
    union() {
        difference() {
            shell_outer();
            interior();
        }
        vm_collar();
        mount_boss( mount_spacing / 2);
        mount_boss(-mount_spacing / 2);
        ceiling_seats();
        xh_ceiling();
    }

    vm_bore();
    slit_at(0);
    slit_at(180);

    mount_pilot( mount_spacing / 2);
    mount_pilot(-mount_spacing / 2);

    pocket_5569();
    flange_pilots();
    win_xh();
}
}

voltmeter();
