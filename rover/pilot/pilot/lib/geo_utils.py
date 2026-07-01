"""Geographic and planar utility functions.

Two angle conventions in use across the rover stack:
- *compass bearing*: 0 = North, CW positive (radians). Matches u-blox
  `headMot`.
- *math angle*: 0 = East, CCW positive (radians). Used by every controller
  in pilot/lib/* because it lines up with `atan2(north, east)` on local
  ENU and with the standard bicycle kinematics derivation.

GPS-reported headings cross the boundary via `compass_to_math`; never
mix the two inside a single computation.
"""

from math import radians, degrees, sin, cos, sqrt, atan2, pi, hypot

R_EARTH = 6371000.0  # Earth radius in meters


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance between two GPS points in meters."""
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return R_EARTH * 2 * atan2(sqrt(a), sqrt(1 - a))


def enu_from_gps(lat, lon, ref_lat, ref_lon):
    """Convert GPS (lat, lon) to local East-North-Up (meters) relative to reference point.

    Accurate to ~1cm within 1km of reference point.
    """
    dlat = radians(lat - ref_lat)
    dlon = radians(lon - ref_lon)
    east = dlon * R_EARTH * cos(radians(ref_lat))
    north = dlat * R_EARTH
    return east, north


def gps_from_enu(east, north, ref_lat, ref_lon):
    """Convert local ENU (meters) back to GPS (lat, lon).

    Inverse of `enu_from_gps`; used by tests to synthesise GPS samples
    from a desired ENU pose. Production code only ever needs the
    forward direction.
    """
    lat = ref_lat + degrees(north / R_EARTH)
    lon = ref_lon + degrees(east / (R_EARTH * cos(radians(ref_lat))))
    return lat, lon


def normalize_angle(angle):
    """Wrap angle to [-pi, pi]."""
    while angle > pi:
        angle -= 2 * pi
    while angle < -pi:
        angle += 2 * pi
    return angle


def compass_to_math(compass_rad):
    """Compass bearing (0=N, CW+) → math angle (0=E, CCW+)."""
    return normalize_angle(pi / 2 - compass_rad)


def math_to_compass(math_rad):
    """Math angle (0=E, CCW+) → compass bearing (0=N, CW+).

    Inverse of `compass_to_math`; used by tests to fabricate the
    synthetic GPS heading messages the estimator expects. Production
    only ever converts compass→math at the GPS boundary.
    """
    return normalize_angle(pi / 2 - math_rad)


def fit_chord_heading(points):
    """Math-frame heading of the best-fit line through ENU points.

    Used by cold-start calibration: when the chassis has driven straight
    (κ=0), antenna positions trace a line whose direction equals chassis
    yaw. Linear regression over the full sample set is far more robust than
    using a 5-sample variance window or a single chord (start, end).

    Returns (heading_math_rad, residual_rms_m, chord_length_m). residual_rms
    is the RMS perpendicular distance from samples to the fit line — a
    direct quality metric. chord_length is the distance between first and
    last sample, used to gate trustworthiness (a heading from a 0.1 m chord
    is meaningless even if residuals are tiny).
    """
    n = len(points)
    if n < 2:
        return 0.0, float('inf'), 0.0
    mean_x = sum(p[0] for p in points) / n
    mean_y = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mean_x) ** 2 for p in points)
    syy = sum((p[1] - mean_y) ** 2 for p in points)
    sxy = sum((p[0] - mean_x) * (p[1] - mean_y) for p in points)
    # Total least squares (orthogonal regression). Eigenvector of the
    # covariance matrix's larger eigenvalue is the line direction.
    # Closed form for a 2x2 symmetric matrix:
    trace = sxx + syy
    det = sxx * syy - sxy * sxy
    disc = max(0.0, (trace * 0.5) ** 2 - det)
    eig_max = trace * 0.5 + sqrt(disc)
    # Direction vector: (eig_max - syy, sxy) or (sxy, eig_max - sxx).
    # Pick the one with larger magnitude for numerical stability.
    a, b = eig_max - syy, sxy
    c, d = sxy, eig_max - sxx
    if hypot(a, b) >= hypot(c, d):
        vx, vy = a, b
    else:
        vx, vy = c, d
    norm = hypot(vx, vy)
    if norm < 1e-9:
        # Degenerate: all samples coincident. Fall back to chord direction.
        return atan2(points[-1][1] - points[0][1], points[-1][0] - points[0][0]), float('inf'), 0.0
    vx, vy = vx / norm, vy / norm
    heading = atan2(vy, vx)
    # Sign: pick the direction matching first→last sample so we don't end
    # up 180° flipped. (The eigenvector is direction-agnostic.)
    chord_dx = points[-1][0] - points[0][0]
    chord_dy = points[-1][1] - points[0][1]
    if vx * chord_dx + vy * chord_dy < 0:
        heading = normalize_angle(heading + pi)
        vx, vy = -vx, -vy
    # RMS perpendicular residual.
    perp_x, perp_y = -vy, vx
    rss = sum((perp_x * (p[0] - mean_x) + perp_y * (p[1] - mean_y)) ** 2 for p in points)
    rms = sqrt(rss / n)
    chord = hypot(chord_dx, chord_dy)
    return heading, rms, chord
