// chalk_dispenser.scad — minimal horizontal-axis drum dispenser.
//
// A short cylinder (drum) sits in a horizontal-axis chamber. The drum
// has one axial through-pocket offset from its rotation axis, plus a
// short hub extension on one end that mates with the servo spline.
// An MG995 positional servo, bolted to the +X face of the body,
// toggles the drum 0°↔180°:
//
//   • 0°   pocket faces UP   → hopper above gravity-fills the pocket
//   • 180° pocket faces DOWN → pocket empties into the nozzle below
//
// One toggle = one shot. Both rest positions are valid stops, so the
// servo never has to return to a "home".
//
// Three printed parts, all support-free:
//   • drum     — print upright on its end-face; pocket/spline bores
//                are vertical → no overhang.
//   • body_top — chamber roof + hopper. Print hopper-opening-up; the
//                chamber's split plane sits on the bed.
//   • body_bot — chamber floor + nozzle. Print nozzle-opening-up (i.e.,
//                inverted relative to the assembled orientation); the
//                chamber's split plane sits on the bed.
//
// The body is tall enough on the +X face to host the two MG995 ear
// pilots above and below the split plane — one per body half, so the
// renders no longer show a half-pilot ghost on each piece. The drum's
// hub extension pokes through the chamber wall's spline pass-through
// to engage the servo's 4 mm spline with ~9 mm of D-bore length.
//
// Coordinates:
//   • X = drum axis            (servo on +X face)
//   • Y = lateral              (servo body width direction)
//   • Z = vertical             (hopper up, nozzle down; ears on ±Z)
//   • origin = drum centre

$fn = 64;
view = "exploded";    // exploded | assembled | drum | top | bot | hopper | columns | antenna_cap

// ---- Drum ----
// Drum rotation axis is along world X. Z height of that axis (was 0).
drum_axis_z   = 1;      // raise drum centre 1 mm in Z; chamber bore,
                        // spline pass-through and nozzle hull follow.
drum_d        = 28;
drum_l        = 36;     // shortened from 40 so chamber_l shrinks too,
                        // widening the X-strip between chamber bore
                        // and lip outer edge → thicker self-tap walls
                        // for the body↔body M2 bolts.
end_cap_h     = 3;      // thinned (was 5) — "드럼의 받침대 부분"
solid_head_h  = 3;      // thinned (was 5)
pocket_d      = 22;     // cavity bore (= axial blind hole)
pocket_h      = drum_l - end_cap_h - solid_head_h;
                        // = 30. Bounded on BOTH ends by drum material
                        // so the chamber wall never sees an open
                        // cavity at the axial slop gaps. Walls are
                        // symmetric (5 mm each) so the cavity sits
                        // visibly inside the drum body.
pocket_offset = 5;      // cavity centre offset from drum axis
// cavity far edge at offset + pocket_d/2 = 16 > drum radius 14, so
// the cavity opens through the drum's curved surface as a slot. The
// chamber wall closes that slot externally to retain the powder. The
// remaining drum_l − pocket_h = 10 mm of solid material at the +Z end
// hosts the spline bore (no overlap with the cavity).

// Hub extension on the servo-side end of the drum — extends past the
// drum's main body so it reaches through the chamber wall's spline
// hole into the servo.
hub_ext_d = 21;         // hub OD (solid cylinder — no internal bore)
hub_ext_h = 8;          // length of hub extension

// ---- Servo (MG995) ----
// Local servo frame: X = length (ear-to-ear axis), Y = width, Z =
// height (spline axis). In the world frame we rotate so spline → -X,
// which puts length → world Z and width → world Y.
servo_len         = 40.7;  // length (mounts to world Z axis)
servo_wid         = 19.7;  // width  (mounts to world Y axis)
servo_hgt         = 42.9;  // height (mounts to world X axis, spline at -X)
servo_ear_pitch   = 49;    // ear-to-ear hole pitch along length axis
servo_spline_d    = 5.85;
servo_spline_flat = 5.45;
servo_spline_h    = 4.0;
servo_clearance   = 0.4;

// ---- Body / chamber / hopper / nozzle ----
chamber_slop_r = 0.4;
chamber_slop_x = 0.4;
wall_t         = 3;
// Inlet matches the drum pocket TOP-DOWN PROJECTION (pocket_h ×
// pocket_d = 30 × 22). Anything dropped within this rectangle from
// above lands on the pocket opening on the drum surface.
// Hopper exterior is rectangular for stiffness. Box footprint ≤ 250
// (user constraint). A SKIRT (sloped frustum) joins the small lip
// to the box footprint, eliminating the open ledge between them.
// Interior is split into a long vertical cavity on top and a short
// funnel zone at the bottom that tapers to the Ø16 inlet.
hopper_box_x        = 200;     // ≤ 250
hopper_box_y        = 200;     // ≤ 250
hopper_lip_h        = 6;     // recess bottom stays ≥1 mm above the
                             // chamber bore top so the bore doesn't
                             // poke through into the recess area
hopper_skirt_h      = 20;      // lip-to-box transition
hopper_funnel_h     = 30;      // funnel rise INSIDE the box
hopper_top_cavity_h = 100;     // vertical (straight) cavity
hopper_box_h        = hopper_funnel_h + hopper_top_cavity_h;   // 130

// Antenna mount inside the hopper, sitting at the box's top edge
// height (so nothing protrudes above the hopper). Three thick struts
// EMBEDDED in the −X, +Y and −Y walls carry the central platform.
// The platform sits FLUSH with the box top — the SMA bulkhead drops
// through it and is clamped by a nut from below (= via the open
// hopper top). Antenna XY = nozzle XY = world (0, 0).
sma_hole_d       = 6.5;     // SMA bulkhead clearance (standard)
mount_plate_d    = 16;       // platform OD around the SMA hole
mount_plate_h    = 4;        // platform thickness (= struts thickness)
mount_bridge_w   = 14;       // strut Y/X cross-section width
mount_diag_low_z = 80;       // anchor Z (above funnel_top) for each
                             // diagonal brace. Higher = shorter brace.

// ---- Chassis-fix columns (hopper → plate self-tap posts) ----
//   • 4 vertical columns drop from the hopper's lip-extension flange
//     down to the chassis mount plate, aligning with the plate's M3
//     holes. Each column hosts an M3 self-tap pilot at the bottom so
//     an M3 bolt entering from below the plate threads up into the
//     column, clamping hopper to plate.
// Column shape: rectangular prism that spans the SHORT edge of the
// hole pattern (= contains both X-row holes at one Y), with the TOP
// face SLOPED to match the hopper skirt's outer face — so the
// column stays under the skirt's slope and never appears inside
// the hopper cavity.
fix_col_x_pad     = 5;         // X margin past each X hole
fix_col_y_pad     = 5;         // = fix_col_x_pad → square 10 × 10 footprint
fix_col_pilot_d   = 2.6;       // = m3_pilot, inlined to dodge SCAD's
                               // forward-evaluation order
fix_col_pilot_h   = 8;         // self-tap depth from column bottom

// ---- GPS board mount (TBD — spec only, not modelled yet) ----
//   • 4 mounting holes, Ø3.7
//   • 38 mm × 38 mm square centre-to-centre pitch
//   • To be held by 4 vertical bosses (self-tap), TBD location.
                             // Triangle in side view: vertical on
                             // wall, horizontal under strut,
                             // hypotenuse as the diagonal.
// Brace stops 15 mm short of the mount centre so the area around
// the SMA hole stays as flat strut only (no brace material covering
// the connector seat).
mount_diag_clear = 15;
mount_diag_run_x = 50 - mount_diag_clear;   // = 35 (wall 50 mm away)
mount_diag_run_y = 100 - mount_diag_clear;  // = 85 (wall 100 mm away)

// Asymmetric mount — the body+nozzle assembly sits at the hopper's
// −X corner (far side from the +X servo). The lip+inlet stay above
// the body (centred on body), but the HOPPER BOX is shifted +X by
// hopper_box_offset_x so the box's −X edge meets the lip's −X edge.
// The big mass of the hopper hangs in +X over the servo, putting the
// loaded COG well +X of the body — used at chassis mount time to
// counter the forward-protruding nozzle.
hopper_lip_x_size   = 40;
hopper_offset_x     = 0;       // lip/inlet stay centred on body
hopper_box_offset_x = +50;     // toward SERVO side (+X), 50 mm in
                               // from the very end.
hopper_bolt_x_rel   = (pocket_h/2 + hopper_lip_x_size/2) / 2;
                               // = (15 + 20) / 2 = 17.5 (lip-frame)
nozzle_inlet_d = 28.8;  // = chamber_bore_d — the entire chamber floor
                        // opens straight into the nozzle funnel so
                        // powder cannot pile up on a closed-off ledge.
                        // (Numeric duplicate of chamber_bore_d so that
                        // OpenSCAD lazy-evaluation order doesn't bite.)
nozzle_bot_d   = 18;
nozzle_h       = 25;
ear_margin     = 7;     // plastic around each ear hole on the +X face
screw_margin   = 5;     // join-screw clearance from chamber bore in X

// Spline pass-through through chamber wall — sized to clear the drum's
// hub extension with slop.
spline_hole_d  = hub_ext_d + 2 * 0.3;  // = 7.6

// ---- Fasteners (repo convention) ----
m3_pilot     = 2.6;
m3_clearance = 3.4;
m3_head_d    = 5.7;   // M3 socket-cap head OD
m3_head_h    = 3.0;   // M3 socket-cap head height
m2_pilot     = 1.7;   // M2 self-tap pilot
m2_clearance = 2.4;   // M2 shank clearance
m2_head_d    = 3.8;   // M2 socket-cap head OD
m2_head_h    = 2.0;   // M2 socket-cap head height
m4_pilot     = 3.3;   // M4 self-tap pilot (~0.8 × M4 thread Ø)
m4_clearance = 4.5;   // M4 shank clearance — matches servo Ø4.5

// ---- Servo mount holes (DS-R003 / MG995-style ear pattern) ----
//   • 4 holes, 2 per width-side, Ø4.5
//   • Long-edge (length axis = world Z) hole pitch: 49 mm
//   • Nearest hole offset from spline axis (along Z): 14.5 mm
//   • Far hole offset:                                34.5 mm
//   • Short-edge (width axis = world Y) half-pitch:    5 mm  (assumed
//     MG995 standard; image not directly readable)
//   • Hole depth from shaft-side face into servo body: 12.95 mm
//     (only matters for bolt-length selection, not for the through-
//     hole in our chamber wall)
servo_mount_d            = 4.5;
servo_mount_long_pitch   = 49;
servo_mount_shaft_to_near = 14.5;
servo_mount_shaft_to_far  = servo_mount_long_pitch - servo_mount_shaft_to_near - 1;
                                                            // = 33.5
                                                            // (lower boss moved
                                                            //  +1 mm vs nominal
                                                            //  servo pitch)
servo_mount_short_y      = 5;
servo_mount_face_dist    = 12.95;  // distance from shaft-side face
                                   // to mounting-hole plane

// Servo bosses — ONE rectangular boss per ear, each containing 2
// M3 self-tap pilots (one per mount hole on that ear). Height
// 22 mm extends from body +X face out toward the servo.
// Boss perimeter sized so each pilot sits the SAME distance (3 mm)
// from its nearest edge in both Y and Z.
//   Y wide  = 2 * servo_mount_short_y + 2 * 3 = 16
//   Z thick = 2 * 3                           = 6
servo_boss_h        = 16;     // 1 mm taller than the original 15 mm
top_boss_z_offset   = 1;      // raise upper servo boss 1 mm in Z;
                              // lower boss stays at -servo_mount_shaft_to_far
servo_boss_wide     = 2 * servo_mount_short_y + 6;   // = 16
servo_boss_thick    = 6;                              // = 6
servo_boss_pilot_d  = m4_pilot;                       // 3.3 (M4 self-tap;
                                                      // M4 shank fills Ø4.5
                                                      // servo hole snugly)

// Ear pattern is asymmetric in Z — its centre sits 10 mm off the
// spline (shaft) on the far side. The body Z is shifted by the same
// amount so the body wraps just enough around BOTH ears.
ear_center_z = (servo_mount_shaft_to_near - servo_mount_shaft_to_far) / 2;  // = -10

// ---- Derived ----
chamber_bore_d = drum_d + 2 * chamber_slop_r;
chamber_l      = drum_l + 2 * chamber_slop_x;

// Body is sized to the chamber only — the hopper cone sprouts out of
// the top face and the nozzle out of the bottom face, both free to
// extend past the body's footprint without bulking up the chassis.
// The +X face still has to be tall enough to host the servo ears at
// Z = ±servo_ear_pitch/2 with a small margin around each hole.
// body_x is extended in X so the corner join-screws sit past the
// chamber bore's X ends (chamber bore is a cylinder along X with
// half-length chamber_l/2; screws at X = ±(body_x/2 − 5) need to be
// further out than chamber_l/2 + screw_radius).
// body_x sized so the X-direction wall equals the Y-direction wall.
// body wall in X = body wall in Y = lip_inset + lip + slop = 5 mm.
body_y = chamber_bore_d + 2 * wall_t + 4;   // = 38.8
body_x = 50.8;   // hardcoded so the X strip between chamber bore and
                 // lip outer stays 4.9 mm wide (= ≥1.6 mm edge plastic
                 // around the body↔body M2 self-tap pilots) even after
                 // drum_l shrank to 36.
body_z = max(chamber_bore_d + 2 * wall_t,
             servo_mount_long_pitch + 2 * ear_margin);  // = 63

// Body shifted in Z so the asymmetric ear pattern fits with even
// margins on both ends. body_z_top above spline = 21.5, body_z_bot
// below = -41.5. The split plane stays at Z=0 (spline height).
body_z_top = ear_center_z + body_z/2;   //  +21.5
body_z_bot = ear_center_z - body_z/2;   //  -41.5

// Body-half joint: INNER LIP + RECESS. body_top has a lip extending
// below the split plane; body_bot has a matching recess. Spline area
// (+X side along shaft axis) is cleared by a RECTANGULAR slot, not a
// circular hole — so each half meets at the split plane with straight
// edges (no half-circle that can catch on assembly tolerance).
lip_h         = 5;     // lip Z extension below split plane
lip_inset     = 2;     // body_bot wall thickness around recess
lip_slop      = 0.1;   // recess ↔ lip slip fit
bolt_depth    = 7;     // M2 pilot total depth from body Y face
bolt_z        = -lip_h/2;
cbore_depth   = 1;     // counterbore = lip_inset − 1. 1 mm backing
                       // plastic; M2 head (2 mm) protrudes 1 mm.
spline_slot_w = spline_hole_d;  // match circular hole diameter so the
                                // rectangular lip slot meets the
                                // circular top hole at Z=0 with no
                                // ledge (both ±3.8 in Y at split)

// Hopper bolt Z station (needs body_z_top, defined above).
hopper_bolt_z = body_z_top - hopper_lip_h/2;

// 4 transverse join-bolt positions
join_bolts = [
    [ 1,  1],   // (+X, +Y) corner
    [ 1, -1],   // (+X, -Y) corner
    [-1,  1],   // (-X, +Y) corner
    [-1, -1],   // (-X, -Y) corner
];
// Bolts enter via lip's LONG side (±Y face). X position centered in
// the strip between chamber bore X edge and lip outer X edge.
//   lip_outer_X = body_x/2 - lip_inset - lip_slop = 27.9
//   strip span: (20.4 .. 27.9) — bolt at midpoint = 24.15
join_bolt_x = (chamber_l/2 + (body_x/2 - lip_inset - lip_slop)) / 2;

// ---- Helpers ----

module d_bore(h) {
    intersection() {
        cylinder(d = servo_spline_d, h = h);
        translate([-servo_spline_d/2 - 1, -servo_spline_flat/2, -0.1])
            cube([servo_spline_d + 2, servo_spline_flat, h + 0.2]);
    }
}

// ============================================================
// drum
// ============================================================

module drum() {
    difference() {
        union() {
            // Main drum body
            cylinder(d = drum_d, h = drum_l, center = true);
            // Hub extension on the +Z end — solid Ø21 stub that pokes
            // through the chamber wall's spline hole.
            translate([0, 0, drum_l/2])
                cylinder(d = hub_ext_d, h = hub_ext_h);
        }
        // Cavity cuboid (flat-walled).
        translate([pocket_offset - pocket_d/2,
                   -pocket_d/2,
                   -drum_l/2 + end_cap_h])
            cube([pocket_d, pocket_d, pocket_h]);
        // 4× M2 self-tap pilots in the hub extension (servo-side
        // flange face) — 7 mm radius from drum axis, 90° apart.
        // Pilot bores from the +Z end face down into the hub.
        for (a = [0, 90, 180, 270])
            rotate([0, 0, a])
                translate([7, 0, drum_l/2 + hub_ext_h - 6])
                    cylinder(d = m2_pilot, h = 6 + 0.1);
    }
}

// ============================================================
// body (full geometry — sliced into body_top / body_bot)
// ============================================================

module servo_boss() {
    // Rectangular boss in world frame: attaches to body's +X face,
    // tall along +X, wide in Y (covers both mount holes), thick in
    // Z. Two self-tap pilots at Y = ±servo_mount_short_y, plus a
    // 1.5 mm × 3 mm boundary groove on the +Z face splitting them.
    difference() {
        translate([0, -servo_boss_wide/2, -servo_boss_thick/2])
            cube([servo_boss_h, servo_boss_wide, servo_boss_thick]);
        for (sy = [-servo_mount_short_y, +servo_mount_short_y])
            translate([-0.1, sy, 0])
                rotate([0, 90, 0])
                    cylinder(d = servo_boss_pilot_d,
                             h = servo_boss_h + 0.2);
        // Boundary groove between the two pilots — 1.5 mm wide,
        // 3 mm deep, cut into the boss's TOP face (+X end face).
        // Runs the full Z thickness of the boss.
        translate([servo_boss_h - 3,
                   -0.75,
                   -servo_boss_thick/2 - 0.05])
            cube([3 + 0.05,
                  1.5,
                  servo_boss_thick + 0.1]);
    }
}

module body_full() {
    difference() {
        union() {
            // Central block surrounding the chamber.
            translate([-body_x/2, -body_y/2, body_z_bot])
                cube([body_x, body_y, body_z]);
            // Nozzle exterior — hull from the FULL body bottom face
            // (body_x × body_y rectangle) down to a round barb.
            hull() {
                translate([-body_x/2, -body_y/2, body_z_bot])
                    cube([body_x, body_y, 0.5]);
                translate([0, 0, body_z_bot - nozzle_h])
                    cylinder(d = nozzle_bot_d + 2*wall_t, h = 0.5);
            }
            // Servo mount bosses — 2 rectangular bosses on +X face,
            // one per ear. Each boss holds 2 M3 self-tap pilots at
            // Y = ±servo_mount_short_y. Boss is built in world frame
            // already (tall along +X), no rotate needed.
            // Upper boss is raised by top_boss_z_offset.
            for (sz = [+servo_mount_shaft_to_near + top_boss_z_offset,
                       -servo_mount_shaft_to_far])
                translate([body_x/2 - 0.05, 0, sz])
                    servo_boss();
        }

        // Chamber bore — horizontal cylinder along the X axis,
        // axis Z raised by drum_axis_z.
        translate([0, 0, drum_axis_z])
            rotate([0, 90, 0])
                cylinder(d = chamber_bore_d, h = chamber_l + 0.2,
                         center = true);

        // Hopper inlet hole — pocket top-down projection (30 × 22),
        // shifted to the −X side by hopper_offset_x.
        translate([hopper_offset_x - pocket_h/2,
                   -pocket_d/2, -0.1])
            cube([pocket_h, pocket_d,
                  body_z_top + 0.2]);

        // Nozzle interior — hull from the chamber bore's INNER lower
        // half cylinder (over the cavity X-range only) down to the
        // round barb. Chamber wall stays intact at drum's axial ends
        // so the drum is supported axially and at its bottom radius.
        hull() {
            translate([0, 0, drum_axis_z])
                intersection() {
                    rotate([0, 90, 0])
                        cylinder(d = chamber_bore_d,
                                 h = pocket_h + 0.2,
                                 center = true);
                    translate([-200, -200, -200])
                        cube([400, 400, 200]);   // Z <= 0 half-space
                }
            translate([0, 0, body_z_bot - nozzle_h - 0.1])
                cylinder(d = nozzle_bot_d, h = 0.5);
        }

        // Servo spline pass-through, +X chamber wall (Z follows drum).
        translate([chamber_l/2 - 0.1, 0, drum_axis_z])
            rotate([0, 90, 0])
                cylinder(d = spline_hole_d,
                         h = (body_x/2 - chamber_l/2) + 0.2);

        // Join-bolt holes belong to body_top (self-tap into lip) and
        // body_bot (clearance through outer wall). They are added in
        // those modules, not here in body_full.
    }
}

module body_top() {
    difference() {
        union() {
            // Upper half of body_full
            intersection() {
                body_full();
                translate([-200, -200, 0])
                    cube([400, 400, 400]);
            }
            // Inner lip extending DOWN past the split plane.
            translate([-(body_x - 2*(lip_inset + lip_slop))/2,
                       -(body_y - 2*(lip_inset + lip_slop))/2,
                       -lip_h])
                cube([body_x - 2*(lip_inset + lip_slop),
                      body_y - 2*(lip_inset + lip_slop),
                      lip_h + 0.05]);
        }
        // Chamber bore through the lip — cylindrical (matches body
        // main's bore so drum surface seals against chamber wall).
        translate([0, 0, drum_axis_z])
            rotate([0, 90, 0])
                cylinder(d = chamber_bore_d, h = chamber_l + 0.2,
                         center = true);
        // Additional RECTANGULAR widening of the chamber-bore cut in
        // the lip Z range only — makes the lip's inner walls
        // vertical (no cylindrical residue at corners), so drum can
        // slide in without catching on a curved leftover.
        translate([-chamber_l/2 - 0.1,
                   -chamber_bore_d/2,
                   -lip_h - 0.05])
            cube([chamber_l + 0.2,
                  chamber_bore_d,
                  lip_h + 0.1]);
        // Nozzle interior through the lip
        hull() {
            translate([0, 0, drum_axis_z])
                intersection() {
                    rotate([0, 90, 0])
                        cylinder(d = chamber_bore_d,
                                 h = pocket_h + 0.2, center = true);
                    translate([-200, -200, -200])
                        cube([400, 400, 200]);
                }
            translate([0, 0, body_z_bot - nozzle_h - 0.1])
                cylinder(d = nozzle_bot_d, h = 0.5);
        }
        // Hopper recess on top face — sized to hopper_lip_x_size in X
        // (+ slop) and body_y - 2·lip_inset in Y, shifted by
        // hopper_offset_x to the −X side.
        translate([hopper_offset_x
                       - hopper_lip_x_size/2 - lip_slop,
                   -(body_y - 2*lip_inset)/2,
                   body_z_top - hopper_lip_h - 0.05])
            cube([hopper_lip_x_size + 2*lip_slop,
                  body_y - 2*lip_inset,
                  hopper_lip_h + 0.1]);
        // Hopper-bolt clearance + counterbore through body_top ±Y
        // outer walls. Bolt X is asymmetric: shifted with the lip.
        for (s = join_bolts) {
            translate([hopper_offset_x + s[0] * hopper_bolt_x_rel,
                       s[1] * (body_y/2 + 0.1),
                       hopper_bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m3_clearance,
                             h = lip_inset + lip_slop + 0.2);
            translate([hopper_offset_x + s[0] * hopper_bolt_x_rel,
                       s[1] * (body_y/2 + 0.1),
                       hopper_bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m3_head_d, h = cbore_depth + 0.1);
        }
        // M2 bolt self-tap pilots into the lip's long-side wall —
        // 4 corners, bolts enter through ±Y face of body.
        for (s = join_bolts)
            translate([s[0] * join_bolt_x,
                       s[1] * (body_y/2 + 0.1),
                       bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m2_pilot, h = bolt_depth + 0.1);
        // Rectangular slot — cuts the LIP ONLY (Z = -lip_h to 0). The
        // body_top main (Z >= 0) keeps the circular spline hole from
        // body_full's subtraction; only the lip gets the clean
        // rectangular cutout so it doesn't catch on assembly.
        translate([chamber_l/2 - 0.1,
                   -spline_slot_w/2,
                   -lip_h - 0.05])
            cube([(body_x/2 - chamber_l/2) + 0.2,
                  spline_slot_w,
                  lip_h + 0.1]);
    }
}

// ---- Chassis mounting flange (on body_bot +X face) ----
//   Flat plate extending out from body_bot's +X face in the Z band
//   between the bottom boss bottom and the nozzle top (≈ 5 mm).
//   4 vertical bolt holes through the plate, oriented along −Z
//   (= nozzle dispersion direction).
//
//   • Long edge 62.5 mm along Y, midpoint on Y = 0.
//   • Short edge 10 mm along X (= boss direction).
//   • Near-X hole pair sits 35 mm from body_bot centre.
chassis_mount_z_top = -servo_mount_shaft_to_far - servo_boss_thick/2;
                                                // boss bottom Z (= -36.5)
chassis_mount_z_bot = body_z_bot;               // = body bottom Z
chassis_mount_h     = chassis_mount_z_top - chassis_mount_z_bot;
chassis_hole_d      = m3_clearance;             // = 3.4 (M3 chassis bolts)
chassis_hole_x_near = body_x/2 + 35;            // 35 mm out from body
                                                // +X face = 60.4
chassis_hole_x_far  = chassis_hole_x_near + 10; // = 70.4 (short edge 10)
chassis_hole_y      = 62.5 / 2;                 // = 31.25 (long edge half)

// 2 mid mounting holes 25.5 mm further into the hopper (+X) past the
// _far hole. Y position is set absolutely (c-c = 49 mm).
chassis_hole_x_mid  = chassis_hole_x_far + 25.5; // = 95.9
chassis_hole_y_mid  = 24.5;                      // c-c = 49

// 2 extra mounting holes 64 mm further into the hopper (+X). Y
// position is set absolutely (c-c = 69 mm). Self-tap columns only
// — no chassis plate extension; bolt threads in from below.
chassis_hole_x_far2 = chassis_hole_x_far + 64;  // = 134.4
chassis_hole_y_far2 = 34.5;                     // c-c = 69
chassis_plate_x_in  = body_x/2;                 // body +X face
chassis_plate_x_out = chassis_hole_x_far + 5;   // 5 mm margin past far hole
chassis_plate_y_ext = chassis_hole_y + 5;       // 5 mm margin past holes
chassis_gusset_h    = 12;                       // gusset vertical leg on
                                                // body +X face (small —
                                                // just braces the joint)
chassis_gusset_run  = 15;                       // gusset X extent past
                                                // body +X face
chassis_gusset_y_in = body_y/2 - wall_t;        // gusset inner Y face

module body_bot() {
    difference() {
        union() {
            // Lower half of body_full
            intersection() {
                body_full();
                translate([-200, -200, -400])
                    cube([400, 400, 400]);
            }
            // Chassis mount flange — tapered transition from body
            // width at body +X face to full plate width at the near
            // hole row, then constant width out to plate +X edge.
            hull() {
                translate([chassis_plate_x_in - 0.05,
                           -body_y/2,
                           chassis_mount_z_bot])
                    cube([0.1, body_y, chassis_mount_h]);
                translate([chassis_hole_x_near - 0.05,
                           -chassis_plate_y_ext,
                           chassis_mount_z_bot])
                    cube([0.1,
                          chassis_plate_y_ext * 2,
                          chassis_mount_h]);
            }
            translate([chassis_hole_x_near,
                       -chassis_plate_y_ext,
                       chassis_mount_z_bot])
                cube([chassis_plate_x_out - chassis_hole_x_near,
                      chassis_plate_y_ext * 2,
                      chassis_mount_h]);
            // Two vertical diagonal gussets on body's ±Y ends —
            // triangles in X-Z plane bracing the cantilevered plate
            // against the body wall.
            // +Y gusset
            hull() {
                translate([body_x/2,
                           chassis_gusset_y_in,
                           chassis_mount_z_top + chassis_gusset_h])
                    cube([0.1, wall_t, 0.1]);
                translate([body_x/2,
                           chassis_gusset_y_in,
                           chassis_mount_z_top])
                    cube([0.1, wall_t, 0.1]);
                translate([body_x/2 + chassis_gusset_run,
                           chassis_gusset_y_in,
                           chassis_mount_z_top])
                    cube([0.1, wall_t, 0.1]);
            }
            // −Y gusset
            hull() {
                translate([body_x/2,
                           -body_y/2,
                           chassis_mount_z_top + chassis_gusset_h])
                    cube([0.1, wall_t, 0.1]);
                translate([body_x/2,
                           -body_y/2,
                           chassis_mount_z_top])
                    cube([0.1, wall_t, 0.1]);
                translate([body_x/2 + chassis_gusset_run,
                           -body_y/2,
                           chassis_mount_z_top])
                    cube([0.1, wall_t, 0.1]);
            }
        }
        // Recess cavity to receive body_top's lip
        translate([-(body_x - 2*lip_inset)/2,
                   -(body_y - 2*lip_inset)/2,
                   -lip_h - 0.05])
            cube([body_x - 2*lip_inset,
                  body_y - 2*lip_inset,
                  lip_h + 0.1]);
        // M2 bolt clearance + counterbore.
        for (s = join_bolts) {
            translate([s[0] * join_bolt_x,
                       s[1] * (body_y/2 + 0.1),
                       bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m2_clearance,
                             h = lip_inset + lip_slop + 0.2);
            translate([s[0] * join_bolt_x,
                       s[1] * (body_y/2 + 0.1),
                       bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m2_head_d, h = cbore_depth + 0.1);
        }
        // 4× chassis mount holes — vertical (−Z direction).
        for (hx = [chassis_hole_x_near, chassis_hole_x_far])
            for (hy = [-chassis_hole_y, chassis_hole_y])
                translate([hx, hy, chassis_mount_z_bot - 0.1])
                    cylinder(d = chassis_hole_d,
                             h = chassis_mount_h + 0.2);
    }
}

// ============================================================
// Reference / visualisation (not printed)
// ============================================================

// ----------------------------------------------------------------
// Hopper — separate printed part. Rectangular box exterior with
// conical interior. Joins body_top with the SAME lip+recess+side-
// bolt scheme as the body_top↔body_bot joint: a 5 mm lip on the
// hopper drops into a matching recess on body_top's top face, and
// 4 M2 bolts pass through body_top's ±Y outer wall to self-tap
// into the lip. The module is built in world coordinates with
// the lip top sitting at Z = body_z_top (so callers do not have
// to translate it). For the standalone "hopper" view, callers
// usually re-anchor it at Z=0.
// ----------------------------------------------------------------
module hopper() {
    // Lip footprint: X-size set explicitly (hopper_lip_x_size) and
    // shifted by hopper_offset_x; Y matches recess as before.
    hopper_lip_x = hopper_lip_x_size;                     // 40
    hopper_lip_y = body_y - 2 * (lip_inset + lip_slop);   // 34.6

    // Box interior cross-section
    int_x = hopper_box_x - 2 * wall_t;                    // 194
    int_y = hopper_box_y - 2 * wall_t;                    // 194

    // Anchored at body_z_top so callers don't translate.
    // Hopper-local Z stations:
    //   -hopper_lip_h .. 0           : lip
    //    0 .. hopper_skirt_h         : skirt (frustum, lip→box)
    //    skirt .. skirt + funnel     : funnel zone (inside box)
    //    skirt+funnel .. skirt+box_h : vertical (straight) cavity
    skirt_top   = hopper_skirt_h;
    funnel_top  = skirt_top + hopper_funnel_h;
    box_top_z   = skirt_top + hopper_box_h;

    translate([0, 0, body_z_top]) {
        difference() {
            union() {
                // Lip plate, shifted in X by hopper_offset_x.
                translate([hopper_offset_x - hopper_lip_x/2,
                           -hopper_lip_y/2,
                           -hopper_lip_h])
                    cube([hopper_lip_x,
                          hopper_lip_y,
                          hopper_lip_h + 0.05]);
                // Skirt — hull from lip footprint at Z=0 to the
                // OFFSET box footprint at Z=skirt_top. Box centre
                // is shifted +X by hopper_box_offset_x.
                hull() {
                    translate([hopper_offset_x - hopper_lip_x/2,
                               -hopper_lip_y/2, -0.05])
                        cube([hopper_lip_x, hopper_lip_y, 0.1]);
                    translate([hopper_box_offset_x - hopper_box_x/2,
                               -hopper_box_y/2, skirt_top - 0.05])
                        cube([hopper_box_x, hopper_box_y, 0.1]);
                }
                // Rectangular box sitting on top of the skirt, +X
                // shifted by hopper_box_offset_x. Top stays OPEN
                // for powder filling.
                translate([hopper_box_offset_x - hopper_box_x/2,
                           -hopper_box_y/2, skirt_top])
                    cube([hopper_box_x, hopper_box_y, hopper_box_h]);
                // Chassis-fix columns now live in the standalone
                // chassis_fix_columns() module so they can be
                // printed separately from the hopper.
                // Antenna mount platform — disc at world (0, 0),
                // flush with the box top.
                translate([0, 0,
                           skirt_top + hopper_box_h - mount_plate_h])
                    cylinder(d = mount_plate_d, h = mount_plate_h);
                // Three FLAT struts at the top mount_plate_h band,
                // each running from its wall to the disc.
                // −X strut
                translate([hopper_box_offset_x - hopper_box_x/2,
                           -mount_bridge_w/2,
                           skirt_top + hopper_box_h - mount_plate_h])
                    cube([-(hopper_box_offset_x - hopper_box_x/2),
                          mount_bridge_w,
                          mount_plate_h]);
                // +Y strut
                translate([-mount_bridge_w/2, 0,
                           skirt_top + hopper_box_h - mount_plate_h])
                    cube([mount_bridge_w,
                          hopper_box_y/2,
                          mount_plate_h]);
                // −Y strut
                translate([-mount_bridge_w/2,
                           -hopper_box_y/2,
                           skirt_top + hopper_box_h - mount_plate_h])
                    cube([mount_bridge_w,
                          hopper_box_y/2,
                          mount_plate_h]);
                // Diagonal braces BELOW each strut. Triangle in the
                // X-Z (or Y-Z) plane: vertical leg on the wall,
                // horizontal leg under the strut, hypotenuse = the
                // real diagonal beam.
                // −X brace
                hull() {
                    translate([hopper_box_offset_x - hopper_box_x/2,
                               -mount_bridge_w/2,
                               funnel_top + mount_diag_low_z])
                        cube([wall_t, mount_bridge_w, 0.1]);
                    translate([hopper_box_offset_x - hopper_box_x/2,
                               -mount_bridge_w/2,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([wall_t + mount_diag_run_x,
                              mount_bridge_w, 0.1]);
                }
                // +Y brace
                hull() {
                    translate([-mount_bridge_w/2,
                               hopper_box_y/2 - wall_t,
                               funnel_top + mount_diag_low_z])
                        cube([mount_bridge_w, wall_t, 0.1]);
                    translate([-mount_bridge_w/2,
                               hopper_box_y/2 - wall_t
                                   - mount_diag_run_y,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([mount_bridge_w,
                              wall_t + mount_diag_run_y, 0.1]);
                }
                // −Y brace
                hull() {
                    translate([-mount_bridge_w/2,
                               -hopper_box_y/2,
                               funnel_top + mount_diag_low_z])
                        cube([mount_bridge_w, wall_t, 0.1]);
                    translate([-mount_bridge_w/2,
                               -hopper_box_y/2,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([mount_bridge_w,
                              wall_t + mount_diag_run_y, 0.1]);
                }
            }
            // ---- Interior cavities ----
            // (1) Rectangular inlet through the lip (shifted).
            translate([hopper_offset_x - pocket_h/2,
                       -pocket_d/2,
                       -hopper_lip_h - 0.1])
                cube([pocket_h,
                      pocket_d,
                      hopper_lip_h + 0.2]);
            // (2) Funnel: hull from inlet rect at lip top up to the
            //     +X-OFFSET box interior at funnel_top.
            hull() {
                translate([hopper_offset_x - pocket_h/2,
                           -pocket_d/2, -0.05])
                    cube([pocket_h, pocket_d, 0.1]);
                translate([hopper_box_offset_x - int_x/2,
                           -int_y/2, funnel_top])
                    cube([int_x, int_y, 0.1]);
            }
            // (3) Vertical cavity from funnel_top to box top —
            //     SHAPED to preserve struts, diagonal braces and
            //     mount disc. Same shapes as in the union above.
            difference() {
                translate([hopper_box_offset_x - int_x/2,
                           -int_y/2, funnel_top])
                    cube([int_x, int_y,
                          hopper_top_cavity_h + 0.2]);
                // Mount disc path
                translate([0, 0,
                           skirt_top + hopper_box_h
                               - mount_plate_h - 0.05])
                    cylinder(d = mount_plate_d,
                             h = mount_plate_h + 0.1);
                // Strut paths (top mount_plate_h Z band)
                // −X
                translate([hopper_box_offset_x - int_x/2 - 0.1,
                           -mount_bridge_w/2,
                           skirt_top + hopper_box_h
                               - mount_plate_h])
                    cube([-(hopper_box_offset_x - int_x/2) + 0.1,
                          mount_bridge_w,
                          mount_plate_h + 0.2]);
                // +Y
                translate([-mount_bridge_w/2, -0.05,
                           skirt_top + hopper_box_h
                               - mount_plate_h])
                    cube([mount_bridge_w,
                          int_y/2 + 0.1,
                          mount_plate_h + 0.2]);
                // −Y
                translate([-mount_bridge_w/2,
                           -int_y/2 - 0.05,
                           skirt_top + hopper_box_h
                               - mount_plate_h])
                    cube([mount_bridge_w,
                          int_y/2 + 0.1,
                          mount_plate_h + 0.2]);
                // Diagonal brace paths
                // −X brace
                hull() {
                    translate([hopper_box_offset_x - hopper_box_x/2,
                               -mount_bridge_w/2,
                               funnel_top + mount_diag_low_z])
                        cube([wall_t, mount_bridge_w, 0.1]);
                    translate([hopper_box_offset_x - hopper_box_x/2,
                               -mount_bridge_w/2,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([wall_t + mount_diag_run_x,
                              mount_bridge_w, 0.1]);
                }
                // +Y brace
                hull() {
                    translate([-mount_bridge_w/2,
                               hopper_box_y/2 - wall_t,
                               funnel_top + mount_diag_low_z])
                        cube([mount_bridge_w, wall_t, 0.1]);
                    translate([-mount_bridge_w/2,
                               hopper_box_y/2 - wall_t
                                   - mount_diag_run_y,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([mount_bridge_w,
                              wall_t + mount_diag_run_y, 0.1]);
                }
                // −Y brace
                hull() {
                    translate([-mount_bridge_w/2,
                               -hopper_box_y/2,
                               funnel_top + mount_diag_low_z])
                        cube([mount_bridge_w, wall_t, 0.1]);
                    translate([-mount_bridge_w/2,
                               -hopper_box_y/2,
                               skirt_top + hopper_box_h
                                   - mount_plate_h - 0.1])
                        cube([mount_bridge_w,
                              wall_t + mount_diag_run_y, 0.1]);
                }
            }

            // 4× M3 self-tap pilots in lip ±Y sides. X is asymmetric
            // around the SHIFTED lip centre.
            for (s = join_bolts)
                translate([hopper_offset_x
                               + s[0] * hopper_bolt_x_rel,
                           s[1] * (body_y/2 + 0.1),
                           hopper_bolt_z - body_z_top])
                    rotate([90 * s[1], 0, 0])
                        cylinder(d = m3_pilot,
                                 h = bolt_depth + 0.1);

            // SMA antenna mount hole — Ø6.5 through the disc at
            // world (0, 0). Bulkhead drops in from above and the
            // nut threads on from below via the open hopper top.
            translate([0, 0,
                       skirt_top + hopper_box_h
                           - mount_plate_h - 0.1])
                cylinder(d = sma_hole_d,
                         h = mount_plate_h + 0.2);

            // (chassis-fix column self-tap pilots live in the
            // chassis_fix_columns() module now)
        }
    }
}

// ============================================================
// chassis_fix_columns — standalone, printed separately from
// the hopper. Each column has a SLOPED top face that follows
// the hopper skirt's +X outer face so it abuts the skirt flush
// from below. M3 self-tap pilot at the bottom; chassis bolt
// threads up from below.
// ============================================================
module chassis_fix_columns() {
    skirt_top = hopper_skirt_h;
    col_z_bot = chassis_mount_z_bot - body_z_top;
    // ---- MID column dims ----
    col_x_lo  = chassis_hole_x_mid - fix_col_x_pad;
    col_x_hi  = chassis_hole_x_mid + fix_col_x_pad;
    col_y_in  = chassis_hole_y_mid - fix_col_y_pad;
    col_y_out = chassis_hole_y_mid + fix_col_y_pad;
    col_z_top_lo = (col_x_lo - hopper_lip_x_size/2)
                       / ((hopper_box_offset_x
                              + hopper_box_x/2)
                           - hopper_lip_x_size/2)
                       * skirt_top;
    col_z_top_hi = (col_x_hi - hopper_lip_x_size/2)
                       / ((hopper_box_offset_x
                              + hopper_box_x/2)
                           - hopper_lip_x_size/2)
                       * skirt_top;
    // ---- FAR column dims ----
    col2_x_lo  = chassis_hole_x_far2 - fix_col_x_pad;
    col2_x_hi  = chassis_hole_x_far2 + fix_col_x_pad;
    col2_y_in  = chassis_hole_y_far2 - fix_col_y_pad;
    col2_y_out = chassis_hole_y_far2 + fix_col_y_pad;
    col2_z_top_lo = (col2_x_lo - hopper_lip_x_size/2)
                        / ((hopper_box_offset_x
                               + hopper_box_x/2)
                            - hopper_lip_x_size/2)
                        * skirt_top;
    col2_z_top_hi = (col2_x_hi - hopper_lip_x_size/2)
                        / ((hopper_box_offset_x
                               + hopper_box_x/2)
                            - hopper_lip_x_size/2)
                        * skirt_top;

    // Anchored at body_z_top so callers don't translate.
    // Column volumes via hull() of 8 vertex markers — preview-safe
    // (no manual face winding) and the slope follows X axis.
    module col_hull(x_lo, x_hi, y_a, y_b, z_top_lo, z_top_hi) {
        d = 0.01;
        hull() {
            translate([x_lo, y_a, col_z_bot])     cube(d);
            translate([x_hi, y_a, col_z_bot])     cube(d);
            translate([x_hi, y_b, col_z_bot])     cube(d);
            translate([x_lo, y_b, col_z_bot])     cube(d);
            translate([x_lo, y_a, z_top_lo])      cube(d);
            translate([x_hi, y_a, z_top_hi])      cube(d);
            translate([x_hi, y_b, z_top_hi])      cube(d);
            translate([x_lo, y_b, z_top_lo])      cube(d);
        }
    }

    translate([0, 0, body_z_top]) {
        difference() {
            union() {
                col_hull(col_x_lo,  col_x_hi,
                          col_y_in,  col_y_out,
                          col_z_top_lo, col_z_top_hi);     // +Y MID
                col_hull(col_x_lo,  col_x_hi,
                         -col_y_out, -col_y_in,
                          col_z_top_lo, col_z_top_hi);     // −Y MID
                col_hull(col2_x_lo, col2_x_hi,
                          col2_y_in, col2_y_out,
                          col2_z_top_lo, col2_z_top_hi);   // +Y FAR
                col_hull(col2_x_lo, col2_x_hi,
                         -col2_y_out, -col2_y_in,
                          col2_z_top_lo, col2_z_top_hi);   // −Y FAR
            }
            // M3 self-tap pilots at column bottoms — bolts thread
            // up from below.
            for (cy = [-chassis_hole_y_mid, chassis_hole_y_mid])
                translate([chassis_hole_x_mid, cy,
                           col_z_bot - 0.1])
                    cylinder(d = fix_col_pilot_d,
                             h = fix_col_pilot_h + 0.1);
            for (cy = [-chassis_hole_y_far2, chassis_hole_y_far2])
                translate([chassis_hole_x_far2, cy,
                           col_z_bot - 0.1])
                    cylinder(d = fix_col_pilot_d,
                             h = fix_col_pilot_h + 0.1);
        }
    }
}

// ============================================================
// antenna_cap — alternative to hopper. Mounts on body_top via
// the same lip+recess fit and the same 4× M3 cross-bolts as the
// hopper, so it is interchangeable with hopper(). Hosts an SMA
// bulkhead at world (0, 0) (= nozzle axis).
//
// Above-lip structure = TWO ⊓ arches (ㄷ with the closed side
// up) rotated 90° to each other, sharing the same centre. Top
// bars cross at the centre, forming a + cross at the top with
// the SMA hole through their intersection. Four legs drop from
// the bar ends to the lip at the 4 cardinal midpoints. The +X
// leg carries a Ø10 horizontal tunnel for the antenna cable.
// ============================================================
module antenna_cap() {
    cap_lip_x       = hopper_lip_x_size;                   // 40
    cap_lip_y       = body_y - 2 * (lip_inset + lip_slop); // 34.6
    cap_h           = 40;     // ⊓ height (above body_z_top)
    arch_t          = 4;      // arch material thickness (leg X / top-bar Z)
    arch_d          = mount_bridge_w;                      // 14 (extrusion depth)
    cap_side_hole_d = 10;
    cap_side_hole_z = body_z_top + cap_side_hole_d / 2;
                                                           // bottom edge flush
                                                           // with lip top

    difference() {
        union() {
            // Lip — solid block in body recess, unchanged.
            translate([hopper_offset_x - cap_lip_x/2,
                       -cap_lip_y/2,
                       body_z_top - hopper_lip_h])
                cube([cap_lip_x, cap_lip_y, hopper_lip_h + 0.05]);

            // ⊓ #1 — arch along X axis (extruded in Y by arch_d).
            // top bar spans full X width at the top of the cap.
            translate([hopper_offset_x - cap_lip_x/2,
                       -arch_d/2,
                       body_z_top + cap_h - arch_t])
                cube([cap_lip_x, arch_d, arch_t]);
            // −X leg
            translate([hopper_offset_x - cap_lip_x/2,
                       -arch_d/2, body_z_top])
                cube([arch_t, arch_d, cap_h]);
            // +X leg
            translate([hopper_offset_x + cap_lip_x/2 - arch_t,
                       -arch_d/2, body_z_top])
                cube([arch_t, arch_d, cap_h]);

            // ⊓ #2 — arch along Y axis (extruded in X by arch_d).
            // top bar spans full Y width at the top of the cap.
            translate([-arch_d/2,
                       -cap_lip_y/2,
                       body_z_top + cap_h - arch_t])
                cube([arch_d, cap_lip_y, arch_t]);
            // −Y leg
            translate([-arch_d/2, -cap_lip_y/2, body_z_top])
                cube([arch_d, arch_t, cap_h]);
            // +Y leg
            translate([-arch_d/2, cap_lip_y/2 - arch_t, body_z_top])
                cube([arch_d, arch_t, cap_h]);
        }

        // SMA Ø6.5 hole at world (0, 0) through the top-bar
        // intersection.
        translate([0, 0, body_z_top + cap_h - arch_t - 0.05])
            cylinder(d = sma_hole_d, h = arch_t + 0.1);

        // Ø10 horizontal cable hole through +X leg.
        translate([hopper_offset_x + cap_lip_x/2 - arch_t - 0.05,
                   0,
                   cap_side_hole_z])
            rotate([0, 90, 0])
                cylinder(d = cap_side_hole_d, h = arch_t + 0.1);

        // 4× M3 self-tap pilots in the lip ±Y sides — same X
        // pattern as hopper so the body's cross-bolts thread in
        // identically.
        for (s = join_bolts)
            translate([hopper_offset_x + s[0] * hopper_bolt_x_rel,
                       s[1] * (cap_lip_y/2 + 0.1),
                       hopper_bolt_z])
                rotate([90 * s[1], 0, 0])
                    cylinder(d = m3_pilot, h = bolt_depth + 0.1);
    }
}

module servo_dummy() {
    // Servo body cuboid in world frame:
    //   X span = servo_hgt (length axis from face to back),
    //   Y span = servo_wid,
    //   Z span = servo_len (ear-to-ear axis).
    color("dimgray")
        translate([body_x/2 + servo_clearance,
                   -servo_wid/2, -servo_len/2])
            cube([servo_hgt, servo_wid, servo_len]);
    color("silver")
        translate([body_x/2 + servo_clearance - servo_spline_h, 0, 0])
            rotate([0, 90, 0])
                cylinder(d = servo_spline_d, h = servo_spline_h);
}

module drum_in_chamber() {
    // drum module is built along its local Z axis; rotate into the
    // assembled orientation (drum axis along world X, hub on +X end).
    // Lift by drum_axis_z so drum axis sits at the same Z as the
    // chamber bore and spline pass-through.
    translate([0, 0, drum_axis_z])
        rotate([0, 90, 0])
            drum();
}

// ============================================================
// Assemblies
// ============================================================

module assemble() {
    body_top();
    body_bot();
    drum_in_chamber();
    hopper();   // anchors itself at body_z_top
    chassis_fix_columns();
}

module explode() {
    translate([0, 0, 80]) hopper();   // hopper drifts up
    translate([0, 0,  35]) body_top();
    translate([0, 0, -35]) body_bot();
    drum_in_chamber();
    translate([0, 0, -30]) chassis_fix_columns();   // drop columns
    translate([0, -130, 80]) antenna_cap();         // beside hopper (−Y)
}

// ============================================================
// Dispatcher
// ============================================================

if      (view == "drum")      drum();
else if (view == "top")       body_top();
else if (view == "bot")       body_bot();
else if (view == "hopper")    hopper();
else if (view == "columns")   chassis_fix_columns();
else if (view == "antenna_cap") antenna_cap();
else if (view == "exploded")  explode();
else                          assemble();
