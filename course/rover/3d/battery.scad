// Battery enclosure — basket + sunshade canopy.
//
// Basket: open-top rectangular battery basket with internal cavity 215 × 70 × 45.
//   6-point M4 chassis fastening through the floor (countersunk heads flush below
//   the battery surface). Walls and floor are honeycombed for stiffness with
//   ventilation; a closed perimeter frame and bolt keepouts preserve clamp area.
//   The top frame is locally thickened outward by frame_extra so the M2 sunshade
//   pilots can sit centered in a wider corner column with symmetric ~2.65mm walls.
//
// Sunshade: corner-wrapped canopy that bolts to the basket's extended top frame
//   via 4 M2 self-tapping screws (one per corner). Each ㄱ-shaped bracket wraps a
//   basket external corner with two perpendicular faces sharing a corner block;
//   one M2 passes horizontally through the long-wall face into the basket's solid
//   corner column. A downward step at the basket-top z auto-aligns the bracket
//   vertically. The roof flows into a single continuous 4-sided diagonal skirt
//   that slopes outward and downward from the roof's top edge, blocking angular
//   sun while leaving the basket-to-skirt-bottom side gap for hot-air escape.
//
// Modules:
//   battery_basket()  — the open-top basket
//   battery_shade()   — the canopy that bolts on top
// Render call at the bottom shows both assembled. Comment one out to print solo.

$fn = 64;

// ============================================================================
// SHARED GEOMETRY
// ============================================================================

// ---- Internal cavity ----
internal_w = 215;
internal_d = 70;
wall_h     = 45;       // internal height above floor

// ---- Shell ----
wall_t     = 5;
floor_t    = 5;

// ---- Honeycomb ventilation ----
hex_a         = 9;     // hex apothem (flat-to-flat / 2)
web_t         = 5;     // web between cells
edge_margin   = 6;     // closed frame margin around each panel
floor_keepout = 11;    // solid radius around each bolt in floor

// ---- Top frame extension (locally thicker wall around the screw) ----
// The shade pilot lives in the solid top frame (edge_margin = 6 → z 44–50).
// Extending the wall outward by frame_extra at this z range turns the corner
// column into a 5+frame_extra square so the pilot can sit centered with
// thicker symmetric walls. Below z=44 the wall stays the original 5mm.
frame_extra  = 2;
top_frame_z0 = floor_t + wall_h - edge_margin;    // 44
top_frame_z1 = floor_t + wall_h;                  // 50
basket_top_z = floor_t + wall_h;                  // = top_frame_z1

// ---- Top-frame external bounds (used by basket extension AND shade) ----
basket_x0 = -wall_t - frame_extra;
basket_x1 = internal_w + wall_t + frame_extra;
basket_y0 = -internal_d - wall_t - frame_extra;
basket_y1 = wall_t + frame_extra;

// ============================================================================
// FASTENERS
// ============================================================================

// ---- M4 chassis fasteners (DIN 7991-ish countersunk heads) ----
m4_clearance = 4.5;
m4_csk_od    = 8.6;
m4_csk_depth = 3.0;

// ---- M2 sunshade fasteners ----
// Bracket has clearance through; basket has the self-tap pilot. The pilot
// enters the EXTENDED top-frame outer face at z = top - 3 (mid of the 6mm
// solid top frame), centered in the 7mm-wide corner column for symmetric
// ~2.65mm walls on both the exterior and cavity sides.
m2_self_pilot     = 1.7;
m2_clearance      = 2.4;
m2_head_d         = 4.4;     // bolt head counterbore Ø (M2 self-tap head ~Ø4 + clearance)
m2_head_h         = 2.5;     // counterbore depth — head sinks fully below the bracket surface

// ---- M3 fasteners (used by the seam-joiner bolts) ----
m3_self_pilot     = 2.5;     // M3 self-tap pilot Ø
m3_clearance      = 3.4;     // M3 clearance Ø
m3_head_d         = 5.6;     // M3 head counterbore Ø (Ø5.5 head + clearance)
m3_head_h         = 3.0;     // M3 head height
shade_pilot_depth = 4;
shade_pilot_inset = 3.5;
shade_pilot_z     = floor_t + wall_h - 3;
// [x, y_outer, dir] — y_outer is the EXTENDED top-frame outer face,
// dir is the drilling direction (+1 or -1 along y).
shade_pilots = [
    [-wall_t - frame_extra + shade_pilot_inset,             wall_t + frame_extra,                -1],
    [internal_w + wall_t + frame_extra - shade_pilot_inset, wall_t + frame_extra,                -1],
    [-wall_t - frame_extra + shade_pilot_inset,             -internal_d - wall_t - frame_extra,  +1],
    [internal_w + wall_t + frame_extra - shade_pilot_inset, -internal_d - wall_t - frame_extra,  +1],
];

// ============================================================================
// CHASSIS SCREW LAYOUT
// ============================================================================

A_rel = [  0,   0];
B_rel = A_rel + [  0, -25];
C_rel = A_rel + [168,   0];
D_rel = A_rel + [168, -25];
E_rel = B_rel + [ 34.5, -18];
F_rel = D_rel + [-34.5, -18];
screws_rel = [A_rel, B_rel, C_rel, D_rel, E_rel, F_rel];

function vmin(vs, i) = min([for (p = vs) p[i]]);
function vmax(vs, i) = max([for (p = vs) p[i]]);

sx0 = vmin(screws_rel, 0);
sx1 = vmax(screws_rel, 0);
sy0 = vmin(screws_rel, 1);
sy1 = vmax(screws_rel, 1);
// Center the screw bbox inside the floor, then shift the whole pattern
// 5mm down in Y so the basket sits 5mm forward of the bolt array.
bolt_y_shift = -5;
center_off = [
    (internal_w - (sx1 - sx0)) / 2 - sx0,
    -((internal_d - (sy1 - sy0)) / 2 + sy1) + bolt_y_shift,
];
screws = [for (p = screws_rel) p + center_off];

// ============================================================================
// SHADE GEOMETRY
// ============================================================================

roof_t        = 3;
overhang      = 12;     // roof past basket footprint on all sides
standoff_h    = 35;     // air gap between basket top and roof underside
bracket_drop  = 8;      // bracket extends this far below basket top
arm           = 16;     // length of each ㄱ leg face along the wall
leg_t         = 5;      // bracket thickness perpendicular to its wall
lip_h         = 1.5;    // upper bracket overhangs the basket top by this much,
                        // forming a downward step at z=basket_top_z that lands on
                        // the wall top — auto-aligns the bracket to the pilot
skirt_drop    = 25;     // perimeter skirt drop below the roof TOP
skirt_outward = 15;     // skirt bottom edge offset outward from the top edge
skirt_t       = 3;      // skirt wall thickness

// ---- Center seam joint (couples the two split halves under the roof) ----
// A small boss is added to the roof underside spanning the seam. Two
// HORIZONTAL M3 × 8 bolts pass from the boss's LEFT face directly through
// the LEFT half (clearance) across the seam and self-tap into the RIGHT half.
// Each bolt physically clamps both halves through the seam. Bolt heads sit
// in counterbores cut into the boss's left face — no separate bracket plate.
// Bolt path = 3 (head counterbore) + 3 (LEFT clearance) + 5 (RIGHT pilot) = 11mm
// = M3 × 8 head (3) + shank (8).
joiner_x_half       = 6;      // boss half-extent along X (each side of seam)
joiner_y_half       = 9;      // boss half-extent along Y (head Ø5.6 + 1.2mm margin)
joiner_boss_h       = 8;      // boss thickness — head sits centered with ~1.2mm Z margin
seam_bolt_y_offset  = 5;      // horizontal seam bolts: ±this in Y (10mm spacing)
seam_pilot_depth    = 5;      // self-tap engagement length in the RIGHT half

leg_z0 = basket_top_z - bracket_drop;
leg_z1 = basket_top_z + standoff_h;
leg_h  = leg_z1 - leg_z0;

// Center joiner derived geometry
basket_center_x = (basket_x0 + basket_x1) / 2;
basket_center_y = (basket_y0 + basket_y1) / 2;
joiner_z_top    = basket_top_z + standoff_h;          // roof underside (boss top)
joiner_z_bot    = joiner_z_top - joiner_boss_h;       // boss bottom
boss_x_left     = basket_center_x - joiner_x_half;    // boss left face (head counterbores are cut here)
boss_x_right    = basket_center_x + joiner_x_half;    // boss right face
seam_bolt_z     = (joiner_z_bot + joiner_z_top) / 2;  // bolt centered in boss Z
seam_bolts_y = [
    basket_center_y - seam_bolt_y_offset,
    basket_center_y + seam_bolt_y_offset,
];

// Each entry is a basket external corner (cx, cy) on the EXTENDED top frame
corners = [
    [basket_x0, basket_y1],   // front-left
    [basket_x1, basket_y1],   // front-right
    [basket_x0, basket_y0],   // back-left
    [basket_x1, basket_y0],   // back-right
];

// Outward direction (away from basket externally) at this corner
function ox(cx) = sign(cx);
function oy(cy) = sign(cy);
// Along-wall direction (face extends from the corner toward basket center)
function sxw(cx) = -ox(cx);
function syw(cy) = -oy(cy);

// ============================================================================
// HEX GRID UTILITIES
// ============================================================================

// 2D pointy-top hex tessellation filling [x0, y0] .. [x0+w, y0+h].
module hex_grid_2d(x0, y0, w, h, a, web) {
    pitch = 2 * a + web;
    px    = pitch;
    py    = pitch * sqrt(3) / 2;
    nx    = ceil(w / px) + 2;
    ny    = ceil(h / py) + 2;
    for (j = [-1 : ny])
        for (i = [-1 : nx]) {
            ox = (j % 2 == 0) ? 0 : px / 2;
            translate([x0 + i * px + ox, y0 + j * py])
                rotate(30)
                    circle(r = 2 * a / sqrt(3), $fn = 6);
        }
}

// Hex pattern clipped to a margin-inset rectangle (closed frame around).
module hex_panel_2d(w, h, margin) {
    intersection() {
        translate([margin, margin])
            square([w - 2 * margin, h - 2 * margin]);
        hex_grid_2d(0, 0, w, h, hex_a, web_t);
    }
}

// ============================================================================
// BASKET HOLES AND VENTS
// ============================================================================

module screw_hole() {
    translate([0, 0, -0.1])
        cylinder(d = m4_clearance, h = floor_t + 0.2);
    translate([0, 0, floor_t - m4_csk_depth])
        cylinder(d1 = m4_clearance, d2 = m4_csk_od, h = m4_csk_depth + 0.01);
}

module shade_pilot_h(x, y_outer, dir) {
    translate([x, y_outer - dir * 0.01, shade_pilot_z])
        rotate([-90 * dir, 0, 0])
            cylinder(d = m2_self_pilot, h = shade_pilot_depth + 0.02);
}

module floor_vents() {
    translate([0, 0, -1])
        linear_extrude(height = floor_t + 2)
            difference() {
                translate([0, -internal_d])
                    hex_panel_2d(internal_w, internal_d, edge_margin);
                for (p = screws)
                    translate([p[0], p[1]])
                        circle(r = floor_keepout);
            }
}

module front_wall_vents() {
    L = internal_w + 2 * wall_t;
    translate([-wall_t, wall_t + 1, floor_t])
        rotate([90, 0, 0])
            linear_extrude(height = wall_t + 2)
                hex_panel_2d(L, wall_h, edge_margin);
}

module back_wall_vents() {
    L = internal_w + 2 * wall_t;
    translate([-wall_t, -internal_d + 1, floor_t])
        rotate([90, 0, 0])
            linear_extrude(height = wall_t + 2)
                hex_panel_2d(L, wall_h, edge_margin);
}

module left_wall_vents() {
    W = internal_d + 2 * wall_t;
    translate([1, -internal_d - wall_t, floor_t])
        rotate([0, -90, 0])
            linear_extrude(height = wall_t + 2)
                hex_panel_2d(wall_h, W, edge_margin);
}

module right_wall_vents() {
    W = internal_d + 2 * wall_t;
    translate([internal_w - 1, -internal_d - wall_t, floor_t + wall_h])
        rotate([0, 90, 0])
            linear_extrude(height = wall_t + 2)
                hex_panel_2d(wall_h, W, edge_margin);
}

// ============================================================================
// BASKET
// ============================================================================

module battery_basket() {
    difference() {
        union() {
            // outer shell (floor + walls as one solid block)
            translate([-wall_t, -internal_d - wall_t, 0])
                cube([
                    internal_w + 2 * wall_t,
                    internal_d + 2 * wall_t,
                    floor_t + wall_h,
                ]);
            // top frame extension — wall thickens outward by frame_extra at
            // z=[top_frame_z0, top_frame_z1] so the screw corner column is
            // wider, giving symmetric ~2.65mm walls around the pilot.
            translate([
                -wall_t - frame_extra,
                -internal_d - wall_t - frame_extra,
                top_frame_z0,
            ])
                cube([
                    internal_w + 2 * wall_t + 2 * frame_extra,
                    internal_d + 2 * wall_t + 2 * frame_extra,
                    top_frame_z1 - top_frame_z0,
                ]);
        }
        // hollow interior above the floor
        translate([0, -internal_d, floor_t])
            cube([internal_w, internal_d, wall_h + 1]);
        // bolt holes through the floor
        for (p = screws)
            translate([p[0], p[1], 0]) screw_hole();
        // sunshade pilots (horizontal, into front/back wall solid top frame)
        for (p = shade_pilots)
            shade_pilot_h(p[0], p[1], p[2]);
        // honeycomb ventilation
        floor_vents();
        front_wall_vents();
        back_wall_vents();
        left_wall_vents();
        right_wall_vents();
    }
}

// ============================================================================
// SHADE
// ============================================================================

// One ㄱ-bracket as 2 perpendicular faces; each includes the outside-corner
// block as overlap so the union is a single solid. Lower portion (below
// basket top) sits flush with the basket external face. Upper portion
// (above basket top) is shifted inward by lip_h, which makes a downward
// step at z=basket_top_z that lands on the wall top — registers the
// bracket vertically so the M2 clearance lines up with the basket pilot.
module corner_bracket(cx, cy) {
    out_x = ox(cx);
    out_y = oy(cy);
    sx    = sxw(cx);
    sy    = syw(cy);

    // Lower portions — inner face flush with basket external wall
    lo_bf1_x0 = min(cx + out_x * leg_t, cx + sx * arm);
    lo_bf1_x1 = max(cx + out_x * leg_t, cx + sx * arm);
    lo_bf1_y0 = min(cy, cy + out_y * leg_t);
    lo_bf1_y1 = max(cy, cy + out_y * leg_t);
    lo_bf2_x0 = min(cx + out_x * leg_t, cx);
    lo_bf2_x1 = max(cx + out_x * leg_t, cx);
    lo_bf2_y0 = min(cy + out_y * leg_t, cy + sy * arm);
    lo_bf2_y1 = max(cy + out_y * leg_t, cy + sy * arm);

    // Upper portions — inner face shifted inward by lip_h to form the step
    up_bf1_y0 = min(cy - out_y * lip_h, cy + out_y * leg_t);
    up_bf1_y1 = max(cy - out_y * lip_h, cy + out_y * leg_t);
    up_bf2_x0 = min(cx + out_x * leg_t, cx - out_x * lip_h);
    up_bf2_x1 = max(cx + out_x * leg_t, cx - out_x * lip_h);

    lower_h = basket_top_z - leg_z0;
    upper_h = leg_z1 - basket_top_z;

    union() {
        translate([lo_bf1_x0, lo_bf1_y0, leg_z0])
            cube([lo_bf1_x1 - lo_bf1_x0, lo_bf1_y1 - lo_bf1_y0, lower_h]);
        translate([lo_bf2_x0, lo_bf2_y0, leg_z0])
            cube([lo_bf2_x1 - lo_bf2_x0, lo_bf2_y1 - lo_bf2_y0, lower_h]);
        translate([lo_bf1_x0, up_bf1_y0, basket_top_z])
            cube([lo_bf1_x1 - lo_bf1_x0, up_bf1_y1 - up_bf1_y0, upper_h]);
        translate([up_bf2_x0, lo_bf2_y0, basket_top_z])
            cube([up_bf2_x1 - up_bf2_x0, lo_bf2_y1 - lo_bf2_y0, upper_h]);
    }
}

// M2 clearance hole through the long-wall face, drilling toward the basket.
// Counterbore at the outer end recesses the bolt head fully below the surface.
module corner_clearance(cx, cy) {
    out_y = oy(cy);
    sx    = sxw(cx);
    pilot_x = cx + sx * shade_pilot_inset;
    // Counterbore for the bolt head at the bracket outer face
    translate([pilot_x, cy + out_y * (leg_t + 0.1), shade_pilot_z])
        rotate([90 * out_y, 0, 0])
            cylinder(d = m2_head_d, h = m2_head_h + 0.1);
    // Shaft clearance through the full bracket thickness
    translate([pilot_x, cy + out_y * (leg_t + 0.1), shade_pilot_z])
        rotate([90 * out_y, 0, 0])
            cylinder(d = m2_clearance, h = leg_t + 0.2);
}

module roof() {
    translate([
        basket_x0 - overhang,
        basket_y0 - overhang,
        basket_top_z + standoff_h,
    ])
        cube([
            (basket_x1 - basket_x0) + 2 * overhang,
            (basket_y1 - basket_y0) + 2 * overhang,
            roof_t,
        ]);
}

// Diagonal skirt: a single continuous 4-sided frustum that starts at the
// roof's top face (z = roof top, NOT roof underside) and slopes outward and
// downward by skirt_outward over skirt_drop. The slant begins at the very
// top edge of the roof so there is no vertical rectangular shoulder at the
// perimeter — the roof's top corner flows directly into the slanted brim.
// Subtracting an inset frustum makes the wall hollow with thickness skirt_t.
module skirt() {
    eps   = 0.01;
    z_top = basket_top_z + standoff_h + roof_t;     // roof top
    z_bot = z_top - skirt_drop;
    // Top rectangle: matches the roof outer perimeter
    xt0 = basket_x0 - overhang;
    xt1 = basket_x1 + overhang;
    yt0 = basket_y0 - overhang;
    yt1 = basket_y1 + overhang;
    // Bottom rectangle: offset outward by skirt_outward on all 4 sides
    xb0 = xt0 - skirt_outward;
    xb1 = xt1 + skirt_outward;
    yb0 = yt0 - skirt_outward;
    yb1 = yt1 + skirt_outward;
    difference() {
        // Outer frustum: top face at z_top (roof top), bottom face at z_bot
        hull() {
            translate([xt0, yt0, z_top - eps])
                cube([xt1 - xt0, yt1 - yt0, eps]);
            translate([xb0, yb0, z_bot])
                cube([xb1 - xb0, yb1 - yb0, eps]);
        }
        // Inner frustum (extends slightly above and below outer for clean cut)
        hull() {
            translate([xt0 + skirt_t, yt0 + skirt_t, z_top])
                cube([xt1 - xt0 - 2 * skirt_t, yt1 - yt0 - 2 * skirt_t, eps]);
            translate([xb0 + skirt_t, yb0 + skirt_t, z_bot - eps])
                cube([xb1 - xb0 - 2 * skirt_t, yb1 - yb0 - 2 * skirt_t, eps]);
        }
    }
}

// Center boss on the roof underside spanning the seam. After the shade is
// split at shade_split_x, each half keeps its half of this boss; the seam
// bolts thread through both halves' bosses to clamp them together.
module joiner_boss() {
    translate([
        boss_x_left,
        basket_center_y - joiner_y_half,
        joiner_z_bot,
    ])
        cube([2 * joiner_x_half, 2 * joiner_y_half, joiner_boss_h]);
}

// Two horizontal seam-bolt paths drilled through the boss in +X. From the
// boss's left face inward: head counterbore (M3 head Ø, ~3mm deep) → M3
// clearance through the rest of the LEFT half → M3 self-tap pilot in the
// RIGHT half. The head ends up flush-buried in the boss face, no separate
// bracket plate needed — each M3 × 8 bolt directly clamps both halves.
module seam_bolt_holes() {
    for (yp = seam_bolts_y) {
        // Counterbore for the M3 head, cut into the boss's LEFT face
        translate([boss_x_left - 0.1, yp, seam_bolt_z])
            rotate([0, 90, 0])
                cylinder(d = m3_head_d, h = m3_head_h + 0.1);
        // Clearance through LEFT half boss (continues past the head counterbore)
        translate([boss_x_left - 0.1, yp, seam_bolt_z])
            rotate([0, 90, 0])
                cylinder(d = m3_clearance, h = joiner_x_half + 0.2);
        // Self-tap pilot in RIGHT half, starting at the seam
        translate([basket_center_x, yp, seam_bolt_z])
            rotate([0, 90, 0])
                cylinder(d = m3_self_pilot, h = seam_pilot_depth);
    }
}

module battery_shade() {
    difference() {
        union() {
            roof();
            skirt();
            joiner_boss();
            for (c = corners) corner_bracket(c[0], c[1]);
        }
        for (c = corners) corner_clearance(c[0], c[1]);
        seam_bolt_holes();
    }
}

// ============================================================================
// PRINT PART SELECTION
// ============================================================================
// The full shade is 283 × 138mm — its X dimension exceeds the Bambu P1S 256mm
// bed, so the shade is split at the basket centerline into LEFT and RIGHT
// halves (~141mm wide each). Each half carries 2 brackets (its corners) and
// half the roof + skirt. The two halves butt against each other at the cut
// plane during assembly; bond at the seam if needed (or rely on the 4 M2
// screws into the basket to hold them in place).
//
// "all"          — full assembly view (basket + complete shade)
// "basket"       — basket only
// "shade"        — full shade (does NOT fit P1S, for reference / larger printers)
// "shade_left"   — left half of the shade (fits P1S)
// "shade_right"  — right half of the shade (fits P1S)
print_part = "all";

shade_split_x = (basket_x0 + basket_x1) / 2;     // basket centerline along X

module shade_left() {
    intersection() {
        battery_shade();
        translate([-1000, -1000, -1000])
            cube([1000 + shade_split_x, 2000, 2000]);
    }
}

module shade_right() {
    intersection() {
        battery_shade();
        translate([shade_split_x, -1000, -1000])
            cube([2000, 2000, 2000]);
    }
}

if (print_part == "basket") {
    battery_basket();
} else if (print_part == "shade") {
    battery_shade();
} else if (print_part == "shade_left") {
    shade_left();
} else if (print_part == "shade_right") {
    shade_right();
} else {
    battery_basket();
    battery_shade();
}
