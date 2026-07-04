// T-shaped sign plate, 3 mm flat, with an angled kickstand brace.
// Wide T: horizontal cap 240 mm wide on top, 25 mm-wide stem hanging below.
// Bounding box 240 (W) × 150 (H); bar stroke 25 mm uniform.
// Symmetric about X = 0; bottom of stem sits at Y = 0.
//
// Brace: a solid wedge fused to the BACK of the plate that follows the whole T
// footprint — the same Y–Z tilt-wedge profile under the 25 mm stem for its full
// height AND under the 240 mm cap over the cap's own y-band, but never past the
// plate outline. Set the part down on the wedge's base and the T face stands at
// tilt_angle from horizontal. tilt_angle = atan(25/15) = 59.04°, matching the
// battery sunshade skirt's horizontal slope.

$fn = 64;

// ---- Plate parameters ----
thickness = 3;     // plate thickness (extrude depth)
width     = 240;   // overall horizontal span (top bar length)
height    = 150;   // overall vertical span (cap + stem)
stroke    = 25;    // bar width: cap height = stem width

// ---- Brace parameters ----
show_plate    = true;
show_brace    = true;
tilt_angle    = atan(25 / 15);       // 59.04° from horizontal (= shade skirt)
brace_len     = height;              // hypotenuse: stem bottom → cap top edge (150)
brace_overlap = 0.4;                 // sink the wedge underside into the plate for a clean union

// Wedge profiled in the model Y–Z plane:
//   A = stem bottom on the plate top   (y = 0,         z = thickness)
//   B = cap top edge on the plate top  (y = brace_len, z = thickness)  → hypotenuse A–B
//   F = apex; base A–F leaves the plate at tilt_angle (so the part still stands
//       at tilt_angle) and is brace_base long. brace_base is half the
//       right-triangle ground edge, so F–B is no longer perpendicular — the
//       triangle is intentionally not a right triangle. The wedge still tapers
//       to a sharp corner at A and B, spanning the full stem bottom → cap top.
brace_base = brace_len * cos(tilt_angle) / 2;          // ground (shortest) edge, halved → 38.6
foot_y     = brace_base * cos(tilt_angle);             // 19.9
foot_z     = thickness + brace_base * sin(tilt_angle); // 36.1

// ---- Plate ----
// 2D T outline, reused by the plate and by the brace's footprint clip.
module t_shape_2d() {
    union() {
        // top horizontal bar (cap), full width
        translate([-width / 2, height - stroke])
            square([width, stroke]);
        // vertical stem, full height (overlaps cap → robust union)
        translate([-stroke / 2, 0])
            square([stroke, height]);
    }
}

module t_sign() {
    linear_extrude(height = thickness) t_shape_2d();
}

// ---- Angled kickstand brace ----
// The Y–Z tilt-wedge profile, drawn in linear_extrude's own XY then mapped:
// polygon (a, b) → model (Z = a, Y = b); rotate([0,-90,0]) extrudes it along −X.
// The two extra points sink only the wedge's underside brace_overlap into the
// plate for a watertight union WITHOUT shortening the visible A→F→B triangle —
// its corners stay flush on the plate top.
//
// The prism is extruded across the FULL plate width and then intersected with
// the T footprint, so the wedge backs the entire T outline: the full triangle
// under the 25 mm stem, and the cap's y-band slice under the 240 mm cap. It
// never extends past the plate (only "as much as the plate is above it").
module brace() {
    intersection() {
        translate([width / 2, 0, 0])
            rotate([0, -90, 0])
                linear_extrude(height = width)
                    polygon([
                        [thickness - brace_overlap, 0],          // sunk base, stem-bottom end
                        [thickness,                 0],          // A  stem bottom, on plate top
                        [foot_z,                    foot_y],     // F  right-angle apex
                        [thickness,                 brace_len],  // B  cap top, on plate top
                        [thickness - brace_overlap, brace_len],  // sunk base, cap-top end
                    ]);
        // clip to the T footprint → support only directly under the plate
        linear_extrude(height = foot_z + 1) t_shape_2d();
    }
}

// Stand the part in its as-used pose: the A–F kickstand base face (the −Y-side
// wedge face) rests flat on Z = 0, so the T sign leans back at tilt_angle from
// the ground. Drop A onto the X-axis (translate −thickness in Z), then rotate
// about X by 180° − tilt_angle so the A–F face turns face-down onto Z = 0.
module place() {
    rotate([180 - tilt_angle, 0, 0])
        translate([0, 0, -thickness])
            children();
}

// ---- Cap underside flat (wings only; stem kept whole) ----
// The crossbar is a thin plate leaning at tilt_angle, so its underside is a slope.
// Shave that slope to a horizontal flat (parallel to Z=0) at cap_flat_z, but ONLY
// on the crossbar WINGS. The central stem-width column is left uncut, so the stem
// stays one continuous piece of plate running straight into the crossbar — it can
// never detach (same solid), and no gap/knife-edge can open at the join.
cap_flat_z = (height - stroke) * sin(tilt_angle) + thickness * cos(tilt_angle);

// The crossbar's y-band (local y ∈ [height-stroke, height]).
module cap_band() {
    translate([-width / 2, height - stroke, -1])
        cube([width, stroke, foot_z + 2]);
}

module sign_solid() {
    difference() {
        place() {
            if (show_plate) t_sign();
            if (show_brace) brace();
        }
        // Shave the WINGS only: (crossbar band − central stem column) below cap_flat_z.
        intersection() {
            difference() {
                place() cap_band();
                place() translate([-stroke / 2, height - stroke - 1, -foot_z])
                    cube([stroke, stroke + 2, 3 * foot_z]);
            }
            translate([-width, -width, cap_flat_z - 1000])
                cube([2 * width, 2 * width, 1000]);
        }
    }
}

// =====================================================================
// TWO SEPARATE PARTS: (1) the stand  = T sign + ㄷ wire cover, and
//                     (2) the USB holder ×2 (clip-on, its own colour).
// The holder is carved by the stand (difference) so it can NEVER overlap
// the plate/brace; `explode` lifts the holders off for the exploded view.
// =====================================================================

show_stand  = true;   // T sign  ("번호판 받침대")
show_holder = true;   // the two USB holders  (separate parts)
show_cover  = true;   // the wire cover  (separate ㄷ part)
explode     = 22;     // lift each detached part off the stand (0 = seated)

// ---- measured USB connector (the part that plugs INTO a holder) ----
usb_body    = [9.6, 17.5];   // body cross-section [W, L]
usb_depth   = 22;            // insertion depth
usb_flange  = [14.6, 23];    // top flange [W, L]
hook_w      = 4.6;           // snap-hook width
hook_proud  = 2;             // snap-hook free protrusion (hollow triangle, springy)

// ---- holder build params ----
clr         = 0.3;           // pocket clearance
wall        = 2.5;           // pocket wall
hook_wall   = 2.6;           // ±Y wall thickness — sized so the top's LONG side =
                             // pocket[1] + 2·hook_wall = 17.8 + 5.2 = 23 (matches flange)
hook_recess = 2.0;           // relief depth below the lip (into the 2.6 wall, ~0.6 skin):
                             // room for the latch to spring fully back out (≈ hook_proud)
hook_ledge  = 1;             // LIP thickness — the top hook_ledge mm of the ±Y walls stays
                             // TIGHT (the thin "panel" the latch grips) = flange→latch gap
hook_win_h  = 8;             // relief height below the lip (must clear the sprung latch)
chamf       = 0.3;           // small 45° lead-in on the lip's top edge (keeps the 1 mm lip)
r_top       = 3.5;           // rounding radius of the holder's top face corners
pocket = [usb_body[0] + clr, usb_body[1] + clr];   // 9.9 × 17.8

// ---- placement (socket pocket sits BEHIND the leaning crossbar) ----
usb_cx    = 125 - (pocket[0] + 2 * wall) / 2;   // holder OUTER ends 250 mm apart (end-to-end)
usb_rimZ  = 133;             // rim ABOVE the cap top edge
usb_cy    = -91;             // pocket centre — both thick end walls clear the plate
usb_floor = 2;
usb_baseZ = usb_rimZ - usb_depth - usb_floor;
sock_xw   = pocket[0] + 2 * wall;
sock_ymin = usb_cy - pocket[1] / 2 - hook_wall;   // −Y hook wall (thick)
sock_ymax = usb_cy + pocket[1] / 2 + hook_wall;   // +Y hook wall (thick, symmetric)

// ---- world mapping + vector helpers ----
tilt_rot = 180 - tilt_angle;
function W(x, y, z) = [ x,
    y * cos(tilt_rot) - (z - thickness) * sin(tilt_rot),
    y * sin(tilt_rot) + (z - thickness) * cos(tilt_rot) ];
function vlen(v)   = sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
function unit(v)   = v / vlen(v);
function vdot(a,b) = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
function vcross(a,b) = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function fb(s) = W(0, foot_y + s*(brace_len - foot_y), foot_z + s*(thickness - foot_z));
// local z of the brace's outer (F–B) face at stem position y (uniform across x)
function brace_top(y) = foot_z + (y - foot_y) * (thickness - foot_z) / (brace_len - foot_y);
nb = [0, -sin(tilt_angle), -cos(tilt_angle)];   // crossbar-back outward normal
nf = let (d = fb(1) - fb(0), n = vcross([1, 0, 0], d))
        (n[1] < 0 ? unit(n) : -unit(n));         // brace F–B face outward normal

// wire duct endpoints: pocket floor → out onto the brace's OUTER (F–B) back face,
// high enough (y=133) to be ABOVE the flat-cut underside. The cover sits ON this
// outermost surface and stands proud of it (never buried, never dangling below).
function duct_in(sx)  = [sx, usb_cy, usb_baseZ + 3];
function duct_out(sx) = W(sx, 137, brace_top(137));

// =============================== HOLDER ==============================
// 2D centred rounded rectangle (corner radius r) → the holder's rounded top face.
module rrect(w, d, r) {
    hull()
        for (ix = [-1, 1], iy = [-1, 1])
            translate([ix * (w / 2 - r), iy * (d / 2 - r)])
                circle(r = r);
}
module socket_boss(sx) {
    translate([sx, usb_cy, usb_baseZ])
        linear_extrude(usb_depth + usb_floor)
            rrect(sock_xw, sock_ymax - sock_ymin, r_top);
}
module socket_cavity(sx) {
    translate([sx, usb_cy, usb_rimZ]) {
        // body pocket (tight = body + clr). The top hook_ledge mm of the ±Y walls is
        // the LIP: the thin "panel" the connector's springy latch grips.
        translate([-pocket[0] / 2, -pocket[1] / 2, -usb_depth])
            cube([pocket[0], pocket[1], usb_depth + 1]);
        // PANEL-MOUNT catch on BOTH ±Y walls: BELOW the lip the wall is relieved, so
        // the latch — squeezed flush while it passes the tight lip — springs fully back
        // out here and its top catches UNDER the lip (grips it like a panel). Blind:
        // outer skin (hook_wall − hook_recess ≈ 0.6) stays.
        translate([-(hook_w + 0.4) / 2, -pocket[1] / 2 - hook_recess, -hook_ledge - hook_win_h])
            cube([hook_w + 0.4, hook_recess + 0.1, hook_win_h]);          // −Y relief
        translate([-(hook_w + 0.4) / 2, pocket[1] / 2 - 0.1, -hook_ledge - hook_win_h])
            cube([hook_w + 0.4, hook_recess + 0.1, hook_win_h]);          // +Y relief
        // 45° lead-in on each lip's TOP edge so the latch ramp starts camming instead
        // of butting the flat rim; the lip stays tight below it (mapping: polygon(a,b)
        // → model Z=a, Y=b; extrude along −X across the latch width).
        translate([(hook_w + 0.4) / 2, 0, 0]) rotate([0, -90, 0])
            linear_extrude(hook_w + 0.4)
                polygon([[0.1, -pocket[1]/2], [-chamf, -pocket[1]/2], [0.1, -pocket[1]/2 - chamf]]);
        translate([(hook_w + 0.4) / 2, 0, 0]) rotate([0, -90, 0])
            linear_extrude(hook_w + 0.4)
                polygon([[0.1, pocket[1]/2], [-chamf, pocket[1]/2], [0.1, pocket[1]/2 + chamf]]);
    }
}
// one holder: a smooth wedge from the vertical socket down to a flat pad on the
// crossbar back, then CARVED by the stand → the mating face follows the leaning
// plate exactly (full contact, no vertical step, no interference).
module holder_wedge(sx) {
    hull() {
        socket_boss(sx);
        place() translate([sx - sock_xw / 2, 124, thickness - 0.5])
            cube([sock_xw, 26, 1]);          // flat pad lying on the crossbar back
    }
}
module usb_holder(sx) {
    difference() {
        // wedge body PLUS a straight-down fill to the flat underside plane, so the
        // base cuts to ONE horizontal face instead of the wedge's natural slope.
        hull() {
            holder_wedge(sx);
            translate([0, 0, cap_flat_z])
                linear_extrude(0.1) projection() holder_wedge(sx);
        }
        socket_cavity(sx);
        // wire exit: a ROUND hole out the pocket's BACK (+Y) wall just above the
        // floor — keeps the pocket FLOOR clean (no teardrop) — then a tube to the
        // crossbar back, ending at the same round exit the cover collects from.
        hull() {
            translate([sx, usb_cy + pocket[1] / 2, usb_baseZ + usb_floor + 2.5])
                rotate([90, 0, 0]) cylinder(r = 2.6, h = 4, center = true, $fn = 24);
            translate(duct_out(sx)) sphere(2.6, $fn = 20);
        }
        sign_solid();               // mate to the sign
        cover_shells();             // clear the SOLID cover envelope (no channel void → no floating bit)
        // flat, floor-parallel bottom (horizontal cut at the crossbar's flat underside)
        translate([-500, -500, cap_flat_z - 500]) cube([1000, 1000, 500]);
    }
}

// =============================== COVER ===============================
ch_w = 8; ch_h = 6; ch_wall = 1.6; ch_base = 2;   // outer 8×6, wire channel 4.8 wide × 4 deep
emb = 0.3;                                         // minimal embed to fuse the walls (was coincident)
// A ㄷ cover laid ON a surface: shell minus channel. The walls sit ON the surface,
// the cap closes the OUTSIDE (+ez), the surface itself is the 4th wall → the wire
// is enclosed/covered. e0/e1 extend the P-end / Q-end (clean merges, no overshoot).
module ch_at(P, Q, U) {
    ex = unit(Q - P); ez = unit(U - ex * vdot(U, ex)); ey = vcross(ez, ex);
    multmatrix([[ex[0], ey[0], ez[0], P[0]],
                [ex[1], ey[1], ez[1], P[1]],
                [ex[2], ey[2], ez[2], P[2]],
                [0, 0, 0, 1]]) children();
}
module ch_shell(P, Q, U, e0, e1) {
    ch_at(P, Q, U)
        translate([-e0, -ch_w / 2, -emb]) cube([vlen(Q - P) + e0 + e1, ch_w, ch_h + emb]);
}
module ch_groove(P, Q, U, e0, e1) {
    ch_at(P, Q, U)
        translate([-e0 - 1, -(ch_w - 2*ch_wall) / 2, -emb - 0.1])
            cube([vlen(Q - P) + e0 + e1 + 2, ch_w - 2*ch_wall, ch_h - ch_base + emb + 0.1]);
}
// Cover matches the T: crossbar runs the FULL width (x = ±120) on the brace face
// (high enough to clear the flat-cut underside); the stem drops from the crossbar
// CENTRE all the way to the foot. They meet in a clean T (stem top closed in).
CB_P = W(-120, 137, brace_top(137)); CB_Q = W(120, 137, brace_top(137));
ST_P = duct_out(0);                  ST_Q = fb(0.05);   // stops just above the foot (stays ≥ Z 0)
module cover_shells() {
    ch_shell(CB_P, CB_Q, nf, 0, 0);
    ch_shell(ST_P, ST_Q, nf, 0, 0);
}
module cover_grooves() {
    ch_groove(CB_P, CB_Q, nf, 0, 0);
    ch_groove(ST_P, ST_Q, nf, 0, 0);
}
// Open the cap (back) over length Lo at the P/Q end of a run → wire can be laid in/out.
module cap_open(P, Q, U, from_p, from_q, Lo) {
    L = vlen(Q - P);
    ch_at(P, Q, U) {
        if (from_p) translate([-1, -ch_w / 2, ch_h - ch_base]) cube([Lo + 1, ch_w, ch_base + 1]);
        if (from_q) translate([L - Lo, -ch_w / 2, ch_h - ch_base]) cube([Lo + 1, ch_w, ch_base + 1]);
    }
}
// The wire cover is its OWN part: ㄷ shells − wire channel − open ends, underside
// carved to mate on the stand (seats with no overlap, lifts off cleanly).
module cover_part() {
    intersection() {
        difference() {
            cover_shells();
            cover_grooves();                         // channel open on the underside (stand side)
            // don't cover the holder wire holes: cut an opening (a bit bigger than the
            // hole) right over each holder's wire exit so the wire can come out.
            ch_at(CB_P, CB_Q, nf)
                for (s = [-1, 1])
                    translate([s * usb_cx + 120 - 4, -ch_w / 2 - 1, -2])
                        cube([8, ch_w + 2, ch_h + 4]);
        }
        // keep the +nf side of the brace F–B plane → one clean flat base (every wall
        // cut on the SAME plane, no knife edges, no half-cut walls)
        ch_at(CB_P, CB_Q, nf) translate([-500, -500, 0]) cube([1000, 1000, 1000]);
        // keep Z ≥ 0 → cover ends flush at the floor
        translate([-500, -500, 0]) cube([1000, 1000, 1000]);
    }
}

// ============================== ASSEMBLY =============================
// Three separate parts, shown exploded by default: stand (T sign), 2 USB holders,
// and the wire cover — each lifts off along its own mating normal.
module stand() { sign_solid(); }

// Exploded outward along the brace normal nf, in physical stack order:
// stand → cover (nearest the stand) → holder (furthest out, i.e. behind the cover).
if (show_stand)  stand();                                                    // yellow — T sign
if (show_cover)  color("Coral")  translate(1.6 * explode * nf) cover_part(); // coral  — wire cover (near stand)
if (show_holder) color("SteelBlue")
    for (s = [-1, 1]) translate(4.2 * explode * nf) usb_holder(s * usb_cx);  // blue   — USB holders (furthest)
