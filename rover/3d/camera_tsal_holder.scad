// Camera holder + TSAL holder — two SEPARATE printable parts in one file.
// They SHARE the same 2× M3 mounting holes (x = ±12.5, 25 mm apart): the same two
// M3 bolts fasten both to the chassis, stacked front-to-back along the bolt axis.
//
//   CAMERA HOLDER  (3 mm plate, gold):
//     plate 85.8 (X) × 23.2 (Y); 2× M2 (Ø2.4) at x = ±40.5, 2.5 below the top edge
//     (camera/TSAL module bolts on here); 2× M3 (Ø3.4) at x = ±12.5 on a rounded
//     strip above the plate (chassis mount).
//   TSAL HOLDER  (3 mm plate, blue):
//     shares the M3 holes; a 35 mm strip rises +Y and, 60 mm above the M3 hole
//     centres, its 40 (X) × 10 (Y) head begins, carrying 2× M2 (Ø2.4) at x = ±12.5,
//     centres 2 mm below the head's top edge.
//
// Shown EXPLODED along Z (the shared bolt axis) by default; explode = 0 seats them.

$fn = 64;
eps = 0.1;

// ============================ shared parameters ======================
m2_clearance = 2.4;   // M2 shank clearance Ø (repo convention)
m3_clearance = 3.4;   // M3 shank clearance Ø (repo convention)
corner_r     = 4;     // rounding radius of the free/exposed plate corners

// shared M3 chassis-mount pattern (both parts bolt through these)
m3_spacing = 25;              // hole centre-to-centre (X)
m3_x = m3_spacing / 2;        // 12.5

// ============================== CAMERA HOLDER ========================
cam_t = 3;            // plate thickness
cam_w = 85.8;         // plate width  (X)
cam_h = 23.2;         // plate height (Y)

cam_m2_spacing  = 81;                 // camera/TSAL module bolt pitch
cam_m2_from_top = 2.5;                // M2 centre below the top edge
cam_m2_x = cam_m2_spacing / 2;        // 40.5
cam_m2_y = cam_h - cam_m2_from_top;   // 20.7

cam_m3_edge = 5;                      // edge distance around each M3 hole
cam_m3_y = cam_h + cam_m3_edge;       // 28.2  ← the SHARED M3 hole Y
strip_w  = 2 * m3_x + 2 * cam_m3_edge;   // 35
strip_h  = 2 * cam_m3_edge;              // 10

// Mounting strip: rounded ONLY at the top two corners; sides run straight down
// into the plate.
module cam_strip_2d() {
    y0 = cam_h;
    y1 = cam_h + strip_h;
    hull()
        for (sx = [-1, 1]) {
            translate([sx * strip_w / 2, y0]) circle(r = eps);
            translate([sx * (strip_w / 2 - corner_r), y1 - corner_r]) circle(corner_r);
        }
}

module camera_holder() {
    difference() {
        linear_extrude(cam_t) {
            translate([-cam_w / 2, 0]) square([cam_w, cam_h]);   // main plate
            cam_strip_2d();                                      // chassis-mount strip
        }
        // M2 camera/TSAL-module clearance holes
        for (sx = [-1, 1])
            translate([sx * cam_m2_x, cam_m2_y, -eps])
                cylinder(d = m2_clearance, h = cam_t + 2 * eps);
        // M3 chassis clearance holes (shared)
        for (sx = [-1, 1])
            translate([sx * m3_x, cam_m3_y, -eps])
                cylinder(d = m3_clearance, h = cam_t + 2 * eps);
    }
}

// =============================== TSAL HOLDER =========================
// Shares the camera holder's M3 holes at (x = ±12.5, y = cam_m3_y). A wider FOOT
// carries the shared M3 holes; a NARROW 25 mm riser rises +Y; 60 mm above the M3
// hole centres the 40 × 10 head begins.
tsal_t   = 3;                     // plate thickness
foot_w   = strip_w;               // 35 — local widening around the shared M3 holes
riser_w  = 25;                    // 25 — narrow middle strip (riser)
head_w   = 40;                    // head width  (X)
head_h   = 10;                    // head height (Y)
riser_up = 60;                    // M3 hole centre → head bottom edge

foot_bot = cam_m3_y - cam_m3_edge;   // 23.2 (free bottom end, 5 mm below the M3 holes)
foot_top = cam_m3_y + cam_m3_edge;   // 33.2 (foot → riser neck-down)
head_y0  = cam_m3_y + riser_up;      // 88.2 (head bottom edge)
head_y1  = head_y0 + head_h;         // 98.2 (head top edge)

tsal_m2_spacing  = 25;
tsal_m2_from_top = 2;                 // M2 centre below the head's top edge
tsal_m2_x = tsal_m2_spacing / 2;      // 12.5
tsal_m2_y = head_y1 - tsal_m2_from_top;   // 96.2

// M3 foot: 35 wide (= camera mount width), a rounded rectangle with ALL FOUR
// corners rounded; the 25 mm riser rises from the flat middle of its top edge.
module tsal_foot_2d() {
    hull()
        for (sx = [-1, 1], sy = [foot_bot + corner_r, foot_top - corner_r])
            translate([sx * (foot_w / 2 - corner_r), sy])
                circle(corner_r);
}
// 25 mm riser: straight strip from the foot top up to the head bottom.
module tsal_riser_2d() {
    translate([-riser_w / 2, foot_top]) square([riser_w, head_y0 - foot_top]);
}
// 40 × 10 head — SHARP corners (no rounding).
module tsal_head_2d() {
    translate([-head_w / 2, head_y0]) square([head_w, head_h]);
}

module tsal_holder() {
    difference() {
        linear_extrude(tsal_t) {
            tsal_foot_2d();
            tsal_riser_2d();
            tsal_head_2d();
        }
        // M3 chassis clearance holes (shared with the camera holder)
        for (sx = [-1, 1])
            translate([sx * m3_x, cam_m3_y, -eps])
                cylinder(d = m3_clearance, h = tsal_t + 2 * eps);
        // M2 TSAL-light clearance holes on the head
        for (sx = [-1, 1])
            translate([sx * tsal_m2_x, tsal_m2_y, -eps])
                cylinder(d = m2_clearance, h = tsal_t + 2 * eps);
    }
}

// ================================ ASSEMBLY ===========================
// Two separate parts sharing the M3 bolt axis (Z). The camera plate sits at
// z ∈ [0, cam_t]; the TSAL plate stacks BEHIND it (z ∈ [−tsal_t, 0]). `explode`
// pushes the TSAL further back along −Z for the exploded view.
show_camera = true;
show_tsal   = true;
explode     = 20;     // gap between the two parts along the shared bolt axis; 0 = seated

if (show_camera) color("Goldenrod") camera_holder();
if (show_tsal)   color("SteelBlue")
    translate([0, 0, -tsal_t - explode]) tsal_holder();
