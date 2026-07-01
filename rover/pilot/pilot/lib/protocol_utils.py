"""Small protocol and status helpers shared across rover nodes."""

FIX_STATUS_PRIORITY = {
    'no_fix': 0,
    '3d_fix': 1,
    'rtk_float': 2,
    'rtk_fixed': 3,
}


def has_required_fix_status(current_status, required_status):
    """Return True when the current fix status meets the configured threshold."""
    current = FIX_STATUS_PRIORITY.get(current_status, -1)
    threshold = FIX_STATUS_PRIORITY.get(required_status, FIX_STATUS_PRIORITY['rtk_fixed'])
    return current >= threshold


def assemble_sse_data(lines):
    """Join SSE data lines according to the event-stream spec."""
    return '\n'.join(lines)
