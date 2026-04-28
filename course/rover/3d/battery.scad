// Battery basket — rover chassis mount.
// Open-top rectangular basket, internal cavity 215 × 70 × 45.
// 6-point M4 chassis fastening through the floor; bolt heads sit in 90°
// countersinks flush below the battery surface.
// Walls and floor are honeycombed for high stiffness-to-mass with
// ventilation. A peripheral closed frame and bolt keepouts preserve
// edge strength and clamp area.

$fn = 64;

// ---- Internal cavity ----
internal_w = 215;
internal_d = 70;
wall_h     = 45;       // internal height above floor

// ---- Shell ----
wall_t     = 5;
floor_t    = 5;

// ---- M4 countersunk fasteners (DIN 7991-ish) ----
m4_clearance = 4.5;
m4_csk_od    = 8.4;
m4_csk_depth = 2.5;

// ---- Honeycomb ventilation ----
hex_a         = 9;     // hex apothem (flat-to-flat / 2)
web_t         = 5;     // web between cells
edge_margin   = 6;     // closed frame margin around each panel
floor_keepout = 11;    // solid radius around each bolt in floor

// ---- Chassis screw layout (relative; later centered in floor) ----
A_rel = [  0,   0];
B_rel = A_rel + [  0, -25];
C_rel = A_rel + [162,   0];
D_rel = A_rel + [162, -25];
E_rel = B_rel + [ 34, -19];
F_rel = D_rel + [-34, -19];
screws_rel = [A_rel, B_rel, C_rel, D_rel, E_rel, F_rel];

function vmin(vs, i) = min([for (p = vs) p[i]]);
function vmax(vs, i) = max([for (p = vs) p[i]]);

sx0 = vmin(screws_rel, 0);
sx1 = vmax(screws_rel, 0);
sy0 = vmin(screws_rel, 1);
sy1 = vmax(screws_rel, 1);
center_off = [
    (internal_w - (sx1 - sx0)) / 2 - sx0,
    -((internal_d - (sy1 - sy0)) / 2 + sy1),
];
screws = [for (p = screws_rel) p + center_off];

// ---- Hex grid utilities ----

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

// ---- Hole and vent modules ----

module screw_hole() {
    translate([0, 0, -0.1])
        cylinder(d = m4_clearance, h = floor_t + 0.2);
    translate([0, 0, floor_t - m4_csk_depth])
        cylinder(d1 = m4_clearance, d2 = m4_csk_od, h = m4_csk_depth + 0.01);
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

module battery_basket() {
    difference() {
        // outer shell (floor + walls as one solid block)
        translate([-wall_t, -internal_d - wall_t, 0])
            cube([
                internal_w + 2 * wall_t,
                internal_d + 2 * wall_t,
                floor_t + wall_h,
            ]);
        // hollow interior above the floor
        translate([0, -internal_d, floor_t])
            cube([internal_w, internal_d, wall_h + 1]);
        // bolt holes through the floor
        for (p = screws)
            translate([p[0], p[1], 0]) screw_hole();
        // honeycomb ventilation
        floor_vents();
        front_wall_vents();
        back_wall_vents();
        left_wall_vents();
        right_wall_vents();
    }
}

battery_basket();
