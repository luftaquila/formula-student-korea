"""Crash-safe persistence for the rover's active mission.

The checkpoint is the rover-side source used to recover progress after a pilot
container or host reboot. It never authorizes motion: a loaded checkpoint is
always exposed as held until a protocol-v2 resume command is accepted.
"""

import errno
import hashlib
import json
import os
import time
from pathlib import Path


MISSION_CHECKPOINT_FILENAME = 'mission_checkpoint.json'
MISSION_CHECKPOINT_FAULT_FILENAME = 'mission_checkpoint.fault.json'
MISSION_CHECKPOINT_SCHEMA = 1
MISSION_MAX_OCCURRENCES = 1000
MISSION_CHECKPOINT_FAULT_SCHEMA = 1
MISSION_MOTION_STATES = frozenset({
    'held', 'running', 'completion_pending', 'dispense_uncertain',
})
_UNSUPPORTED_DIRECTORY_FSYNC_ERRNOS = frozenset({
    errno.EINVAL,
    getattr(errno, 'ENOTSUP', errno.EINVAL),
    getattr(errno, 'EOPNOTSUPP', errno.EINVAL),
})


def checkpoint_path(state_dir=None):
    root = state_dir or os.environ.get('PILOT_STATE_DIR', '/var/lib/pilot')
    return Path(root) / MISSION_CHECKPOINT_FILENAME


def checkpoint_fault_path(state_dir=None):
    root = state_dir or os.environ.get('PILOT_STATE_DIR', '/var/lib/pilot')
    return Path(root) / MISSION_CHECKPOINT_FAULT_FILENAME


def _canonical(payload):
    return json.dumps(
        payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
        allow_nan=False,
    ).encode('utf-8')


def _checksum(payload):
    return hashlib.sha256(_canonical(payload)).hexdigest()


def _validate(payload):
    if not isinstance(payload, dict):
        raise ValueError('checkpoint payload must be an object')
    if payload.get('schema_version') != MISSION_CHECKPOINT_SCHEMA:
        raise ValueError('unsupported checkpoint schema')
    if not isinstance(payload.get('mission_id'), int) or payload['mission_id'] <= 0:
        raise ValueError('invalid mission_id')
    if not isinstance(payload.get('plan_hash'), str) or len(payload['plan_hash']) != 64:
        raise ValueError('invalid plan_hash')
    command_seq = payload.get('command_seq', 0)
    command_id = payload.get('last_command_id')
    command_result = payload.get('last_command_result')
    command_reason = payload.get('last_command_reason')
    if (not isinstance(command_seq, int) or isinstance(command_seq, bool)
            or command_seq < 0):
        raise ValueError('invalid command_seq')
    if command_id is not None and (not isinstance(command_id, str) or not command_id):
        raise ValueError('invalid last_command_id')
    if command_result not in (None, 'accepted', 'rejected'):
        raise ValueError('invalid last_command_result')
    if command_reason is not None and not isinstance(command_reason, str):
        raise ValueError('invalid last_command_reason')
    if command_seq > 0 and command_id is None:
        raise ValueError('command identity is incomplete')
    waypoints = payload.get('waypoints')
    if not isinstance(waypoints, list) or len(waypoints) > MISSION_MAX_OCCURRENCES:
        raise ValueError('invalid waypoints')
    seen = set()
    for waypoint in waypoints:
        if not isinstance(waypoint, dict):
            raise ValueError('invalid waypoint')
        waypoint_id = waypoint.get('id')
        if not isinstance(waypoint_id, str) or not waypoint_id or waypoint_id in seen:
            raise ValueError('invalid or duplicate waypoint id')
        seen.add(waypoint_id)
        for key in ('lat', 'lng'):
            value = waypoint.get(key)
            if not isinstance(value, (int, float)):
                raise ValueError(f'invalid waypoint {key}')
    completed = payload.get('completed_waypoint_ids', [])
    if (not isinstance(completed, list)
            or any(not isinstance(item, str) or item not in seen for item in completed)):
        raise ValueError('invalid completed waypoint ids')
    if payload.get('finish_behavior') not in ('stop', 'return_to_start'):
        raise ValueError('invalid finish_behavior')
    motion_state = payload.get('motion_state', 'held')
    if motion_state not in MISSION_MOTION_STATES:
        raise ValueError('invalid motion_state')
    active_waypoint_id = payload.get('active_waypoint_id')
    if active_waypoint_id is not None and active_waypoint_id not in seen:
        raise ValueError('invalid active_waypoint_id')
    if (motion_state == 'dispense_uncertain'
            and (active_waypoint_id is None or active_waypoint_id in completed)):
        raise ValueError('dispense uncertainty requires a pending active waypoint')
    return payload


def _fsync_directory(path):
    """Durably commit a rename/unlink, ignoring only known unsupported errno."""
    try:
        directory_fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as exc:
        if exc.errno in _UNSUPPORTED_DIRECTORY_FSYNC_ERRNOS:
            return
        raise


def _atomic_write_json(target, payload):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f'.{target.name}.tmp')
    encoded = _canonical(payload) + b'\n'
    with open(tmp, 'wb') as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)
    _fsync_directory(target.parent)


def save_mission_checkpoint(payload, path=None):
    target = Path(path) if path is not None else checkpoint_path()
    clean = dict(payload)
    clean['schema_version'] = MISSION_CHECKPOINT_SCHEMA
    clean.pop('checksum', None)
    _validate(clean)
    envelope = dict(clean)
    envelope['checksum'] = _checksum(clean)

    _atomic_write_json(target, envelope)
    return target


def load_mission_checkpoint(path=None):
    target = Path(path) if path is not None else checkpoint_path()
    if not target.exists():
        return None
    try:
        envelope = json.loads(target.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'cannot read mission checkpoint: {exc}') from exc
    if not isinstance(envelope, dict):
        raise ValueError('checkpoint envelope must be an object')
    checksum = envelope.pop('checksum', None)
    if not isinstance(checksum, str) or checksum != _checksum(envelope):
        raise ValueError('mission checkpoint checksum mismatch')
    return _validate(envelope)


def clear_mission_checkpoint(path=None):
    target = Path(path) if path is not None else checkpoint_path()
    try:
        target.unlink()
    except FileNotFoundError:
        return False
    _fsync_directory(target.parent)
    return True


def mission_checkpoint_identity(path=None):
    """Best-effort identity extraction from an otherwise invalid checkpoint.

    The returned values never authorize motion. They only let an explicit
    server end/reset be correlated to the storage fault that blocked recovery.
    """
    target = Path(path) if path is not None else checkpoint_path()
    try:
        envelope = json.loads(target.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None, None
    if not isinstance(envelope, dict):
        return None, None
    mission_id = envelope.get('mission_id')
    if not isinstance(mission_id, int) or isinstance(mission_id, bool) or mission_id <= 0:
        mission_id = None
    plan_hash = envelope.get('plan_hash')
    if not isinstance(plan_hash, str) or len(plan_hash) != 64:
        plan_hash = None
    return mission_id, plan_hash


def save_mission_checkpoint_fault(reason, mission_id=None, plan_hash=None,
                                  path=None):
    """Durably latch a checkpoint validation/read failure.

    A separate record is necessary because accepting a new start after treating
    a corrupt progress file as clean IDLE can repeat an already-dispensed
    occurrence. Only an explicit correlated end/reset clears this latch.
    """
    if not isinstance(reason, str) or not reason:
        raise ValueError('checkpoint fault reason is required')
    if mission_id is not None and (
            not isinstance(mission_id, int) or isinstance(mission_id, bool)
            or mission_id <= 0):
        raise ValueError('invalid checkpoint fault mission_id')
    if plan_hash is not None and (
            not isinstance(plan_hash, str) or len(plan_hash) != 64):
        raise ValueError('invalid checkpoint fault plan_hash')
    target = Path(path) if path is not None else checkpoint_fault_path()
    clean = {
        'schema_version': MISSION_CHECKPOINT_FAULT_SCHEMA,
        'reason': reason,
        'mission_id': mission_id,
        'plan_hash': plan_hash,
        'detected_at': int(time.time() * 1000),
    }
    envelope = dict(clean)
    envelope['checksum'] = _checksum(clean)
    _atomic_write_json(target, envelope)
    return target


def load_mission_checkpoint_fault(path=None):
    target = Path(path) if path is not None else checkpoint_fault_path()
    if not target.exists():
        return None
    try:
        envelope = json.loads(target.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'cannot read mission checkpoint fault: {exc}') from exc
    if not isinstance(envelope, dict):
        raise ValueError('checkpoint fault envelope must be an object')
    checksum = envelope.pop('checksum', None)
    if not isinstance(checksum, str) or checksum != _checksum(envelope):
        raise ValueError('mission checkpoint fault checksum mismatch')
    if envelope.get('schema_version') != MISSION_CHECKPOINT_FAULT_SCHEMA:
        raise ValueError('unsupported checkpoint fault schema')
    if not isinstance(envelope.get('reason'), str) or not envelope['reason']:
        raise ValueError('invalid checkpoint fault reason')
    mission_id = envelope.get('mission_id')
    plan_hash = envelope.get('plan_hash')
    if mission_id is not None and (
            not isinstance(mission_id, int) or isinstance(mission_id, bool)
            or mission_id <= 0):
        raise ValueError('invalid checkpoint fault mission_id')
    if plan_hash is not None and (
            not isinstance(plan_hash, str) or len(plan_hash) != 64):
        raise ValueError('invalid checkpoint fault plan_hash')
    return envelope


def clear_mission_checkpoint_fault(path=None):
    target = Path(path) if path is not None else checkpoint_fault_path()
    try:
        target.unlink()
    except FileNotFoundError:
        return False
    _fsync_directory(target.parent)
    return True
