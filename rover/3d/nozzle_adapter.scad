// Nozzle adapter — Ø4.5 nozzle/hose → Ø6.3 hole reducer bushing.
//
// Plain sleeve, OD 6.3 / bore 4.8, 30 mm long, with a larger flange ring at
// ONE end only. The flange (Ø12) cannot pass through the Ø6.3 hole, so it
// catches on the hole's rim and sets the insertion depth — the adapter can
// only ever go in from the flange side.
//
//  ┌──────────┐   ← flange  Ø12 × 1.5  (catches on the hole rim)
//  └──┐█  █┌──┘
//     │█  █│
//     │█  █│      ← sleeve  Ø6.3 / Ø4.8, 30 mm (inside the hole)
//     │█  █│
//     └█  █┘      ← square end, no chamfer
//
// DATUM: z = 0 is the flange's outer (exposed) face. The seating face —
// the flange underside that bears on the panel around the hole — is at
// z = flange_t; the sleeve runs z = flange_t → flange_t + sleeve_len.
//
// The hose is pushed in from the flange side (the bore mouth is chamfered
// there) and is gripped along the full 30 mm bore.
//
// PRINT: as modeled — flange flat on the bed, sleeve pointing up. No
// supports needed. The 0.75 mm wall is thin: check the slicer actually
// fills it (2 perimeters at ~0.36 mm extrusion width) instead of leaving a
// gap, and keep the layer height ≤ 0.2 so the 30 mm tube stays true.

$fn = 96;
eps = 0.1;

// ---- Mating parts (nominal, measured) ----
hole_d   = 6.3;   // bore Ø of the hole the adapter drops into
nozzle_d = 4.5;   // outer Ø of the nozzle/hose the adapter grips

// ---- Fit (tune from test prints; negative = interference) ----
gap_hole   = 0;      // per-side clearance, sleeve OD vs hole — RAISE if the
                     // sleeve won't push in, LOWER (negative) if it rattles
gap_nozzle = 0.15;   // per-side clearance, bore vs hose — opened up from 0
                     // because the hose would not enter the Ø4.5 bore. Bore
                     // = 4.8. Still tight? go 0.25 (Ø5.0); past ~0.3 the
                     // wall drops under 0.6 mm and gets unprintable, so at
                     // that point widen hole_d/the sleeve OD instead.

// ---- Sleeve ----
sleeve_len = 30;  // insertion length (depth into the hole)

// ---- Flange (one end only; must NOT fit through hole_d) ----
flange_d     = 12;   // 2.85 radial lip beyond the Ø6.3 hole
flange_t     = 1.5;
bore_lead_in = 0.4;  // 45° chamfer at the bore mouth, hose entry side

// ---- Derived ----
sleeve_od = hole_d   - 2 * gap_hole;     // 6.3
bore_d    = nozzle_d + 2 * gap_nozzle;   // 4.8
total_h   = flange_t + sleeve_len;       // 31.5

module nozzle_adapter() {
    difference() {
        union() {
            cylinder(d = flange_d,  h = flange_t);
            cylinder(d = sleeve_od, h = total_h);
        }

        // Hose bore — straight through flange + sleeve.
        translate([0, 0, -eps])
            cylinder(d = bore_d, h = total_h + 2 * eps);

        // Bore mouth chamfer on the flange face (hose entry).
        translate([0, 0, -eps])
            cylinder(d1 = bore_d + 2 * (bore_lead_in + eps),
                     d2 = bore_d,
                     h  = bore_lead_in + eps);
    }
}

nozzle_adapter();
