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

if (show_plate) t_sign();
if (show_brace) brace();
