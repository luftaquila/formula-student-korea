"""Crash-safe persistence for the rover's active mission.

The checkpoint is the rover-side source used to recover progress after a pilot
container or host reboot. It never authorizes motion: a loaded checkpoint is
always exposed as held until a protocol-v2 resume command is accepted.
"""

import hashlib
import json
import os
from pathlib import Path


MISSION_CHECKPOINT_FILENAME = 'mission_checkpoint.json'
MISSION_CHECKPOINT_SCHEMA = 1


def checkpoint_path(state_dir=None):
    root = state_dir or os.environ.get('PILOT_STATE_DIR', '/var/lib/pilot')
    return Path(root) / MISSION_CHECKPOINT_FILENAME


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
    waypoints = payload.get('waypoints')
    if not isinstance(waypoints, list) or len(waypoints) > 10000:
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
    if not isinstance(completed, list) or any(item not in seen for item in completed):
        raise ValueError('invalid completed waypoint ids')
    if payload.get('finish_behavior') not in ('stop', 'return_to_start'):
        raise ValueError('invalid finish_behavior')
    return payload


def save_mission_checkpoint(payload, path=None):
    target = Path(path) if path is not None else checkpoint_path()
    clean = dict(payload)
    clean['schema_version'] = MISSION_CHECKPOINT_SCHEMA
    clean.pop('checksum', None)
    _validate(clean)
    envelope = dict(clean)
    envelope['checksum'] = _checksum(clean)

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f'.{target.name}.tmp')
    encoded = _canonical(envelope) + b'\n'
    with open(tmp, 'wb') as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)
    try:
        directory_fd = os.open(target.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        # Some test/overlay filesystems do not support directory fsync. The file
        # itself is already durable and atomically replaced.
        pass
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
    try:
        directory_fd = os.open(target.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        pass
    return True
