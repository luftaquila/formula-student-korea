// Bottle holder — closed-bottom rounded-rect sleeve with two mounting flanges.
//
// Bottle cross-section: 104 (X) × 85 (Y), corner r = 15. The sleeve is a
// pocket with a closed floor that grips the bottle over a 60 mm band.
//
// The bottle sits centered in a 108 × 86 panel cutout (NOT modeled — it is a
// hole in the structure the holder mounts to). Bolt offsets are measured from
// this cutout's edges, whose long sides lie at y = ±43.
//
// FIXING SURFACE = z = 0 plane at the BOTTOM (flange + closed floor = mounting
// base). The sleeve rises 60 mm UP from it (z = 0 → +60); the whole holder
// sits on top of the panel, so nothing has to pass through the cutout.
//
// Mounting holes (M3 self-tap pilots through the flanges):
//   Side A  (+Y cutout edge, 10  mm out → y = +53  ):  x = ±28    (2× M3)
//   Side B  (-Y cutout edge, 8.5 mm out → y = -51.5):  x = ±34.5  (2× M3, 69/2)
//
// The flanges join the sleeve with VERTICAL (straight, y-parallel) sides and
// rounded outer corners.

$fn = 96;
eps = 0.1;

// ---- Bottle (nominal pocket outline) ----
bottle_x = 104;
bottle_y = 85;
bottle_r = 15;

// ---- Panel cutout (NOT modeled; datum for the bolt offsets) ----
cutout_x = 108;
cutout_y = 86;

// ---- Bottle pocket fit (tuned from test prints; negative = interference) ----
gap_long  = 0;      // per-side clearance on the long  (X, 104) walls
gap_short = -0.25;  // per-side clearance on the short (Y, 85) walls — grip
gap_r     = 0;      // pocket corner radius vs bottle_r: RAISE if the corners
                    // leave a gap to the bottle, LOWER if they bind first

// ---- Sleeve ----
wall      = 3;      // sleeve wall thickness
floor_t   = 3;      // closed-bottom floor thickness
down      = 0;      // sleeve extent below the fixing surface (0 = flange at base)
up        = 60;     // sleeve height above the fixing surface

// ---- Flanges / mounting ----
screw_len    = 10;  // M3 self-tap screw length (drives in from below)
m3_pilot     = 2.6; // M3 self-tap pilot Ø — matches neighbouring parts (PLA/PETG)
pilot_cap    = 2;   // solid cap above the blind pilot (screw can't exit the top)
flange_t     = screw_len + pilot_cap;  // fixing-base thickness = full screw + cap
bolt_pad_r   = 6;   // material pad radius around each bolt hole
flange_round  = 5;  // rounding radius of the flange outer corners

// Side A: +Y cutout edge, 10 mm out, holes at x = ±28.
offset_a  = 10;
spacing_a = 28;
ya = cutout_y/2 + offset_a;
holes_a = [ [spacing_a, ya], [-spacing_a, ya] ];

// Side B: -Y cutout edge, 8.5 mm out, holes at x = ±34.5 (= 69/2).
offset_b  = 8.5;
spacing_b = 34.5;
yb = -(cutout_y/2 + offset_b);
holes_b = [ [spacing_b, yb], [-spacing_b, yb] ];

// ---- Derived cavity / outer footprint ----
inner_x = bottle_x + 2 * gap_long;    // pocket long-side inner width  (104.0)
inner_y = bottle_y + 2 * gap_short;   // pocket short-side inner depth  (84.5)
inner_r = bottle_r + gap_r;           // pocket corner radius           (15.0)

outer_x = inner_x + 2 * wall;
outer_y = inner_y + 2 * wall;
outer_r = inner_r + wall;

// 2D centered rounded rectangle.
module rrect(w, d, r) {
    hull()
        for (sx = [-1, 1], sy = [-1, 1])
            translate([sx * (w/2 - r), sy * (d/2 - r)])
                circle(r = r);
}

// 2D footprint of a flange: rounded rect with vertical (y-parallel) sides,
// from just inside the sleeve wall (bore trims the excess) out past the bolt
// line. Shared by the flange body and the chamfer clip so their ends match.
module flange_outline(y_line, spacing) {
    s     = sign(y_line);
    y_in  = s * (inner_y/2 - 1);         // inside the wall (bore trims the excess)
    y_out = y_line + s * bolt_pad_r;     // past the bolt line by one pad
    ylo   = min(y_in, y_out);
    yhi   = max(y_in, y_out);
    translate([0, (ylo + yhi) / 2])
        rrect(2 * (spacing + bolt_pad_r), yhi - ylo, flange_round);
}

module flange(y_line, spacing) {
    linear_extrude(flange_t)
        flange_outline(y_line, spacing);
}

module bottle_holder() {
    difference() {
        union() {
            // Sleeve outer solid.
            translate([0, 0, -down])
                linear_extrude(down + up)
                    rrect(outer_x, outer_y, outer_r);
            flange(ya, spacing_a);
            flange(yb, spacing_b);
        }

        // Bottle pocket — closed floor at the bottom, open top.
        translate([0, 0, -down + floor_t])
            linear_extrude(down + up - floor_t + eps)
                rrect(inner_x, inner_y, inner_r);

        // M3 self-tap pilots — BLIND: open at the base (bottom), depth = full
        // screw length, capped by pilot_cap on top so a screw driven from below
        // cannot exit the top. Head clamps under the panel.
        for (p = concat(holes_a, holes_b))
            translate([p[0], p[1], -eps])
                cylinder(d = m3_pilot, h = screw_len + eps);
    }
}

bottle_holder();
