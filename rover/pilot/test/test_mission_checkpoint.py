import errno
import json
import os

import pytest

from pilot.lib.mission_checkpoint import (
    MISSION_MAX_OCCURRENCES,
    clear_mission_checkpoint,
    clear_mission_checkpoint_fault,
    load_mission_checkpoint,
    load_mission_checkpoint_fault,
    mission_checkpoint_identity,
    save_mission_checkpoint,
    save_mission_checkpoint_fault,
)


def _payload():
    return {
        'mission_id': 42,
        'plan_hash': 'a' * 64,
        'command_seq': 3,
        'last_command_id': 'cmd-3',
        'finish_behavior': 'return_to_start',
        'mission_start': {'lat': 35.0, 'lng': 126.0},
        'waypoints': [
            {'id': 'wp-a', 'lat': 35.1, 'lng': 126.1},
            {'id': 'wp-b', 'lat': 35.2, 'lng': 126.2},
        ],
        'completed_waypoint_ids': ['wp-a'],
        'active_waypoint_id': 'wp-b',
        'motion_state': 'held',
    }


def test_checkpoint_round_trip_and_clear(tmp_path):
    path = tmp_path / 'mission.json'
    save_mission_checkpoint(_payload(), path)

    restored = load_mission_checkpoint(path)
    assert restored['mission_id'] == 42
    assert restored['completed_waypoint_ids'] == ['wp-a']
    assert restored['waypoints'][1]['id'] == 'wp-b'
    assert restored.get('last_command_result') is None
    assert not (tmp_path / '.mission.json.tmp').exists()

    assert clear_mission_checkpoint(path) is True
    assert clear_mission_checkpoint(path) is False


def test_checkpoint_fails_closed_on_corruption(tmp_path):
    path = tmp_path / 'mission.json'
    save_mission_checkpoint(_payload(), path)
    envelope = json.loads(path.read_text(encoding='utf-8'))
    envelope['completed_waypoint_ids'].append('wp-b')
    path.write_text(json.dumps(envelope), encoding='utf-8')

    with pytest.raises(ValueError, match='checksum'):
        load_mission_checkpoint(path)


def test_checkpoint_rejects_unknown_completed_waypoint(tmp_path):
    payload = _payload()
    payload['completed_waypoint_ids'] = ['not-in-plan']

    with pytest.raises(ValueError, match='completed waypoint'):
        save_mission_checkpoint(payload, tmp_path / 'mission.json')


def test_checkpoint_rejects_more_than_the_supported_mission_size(tmp_path):
    payload = _payload()
    payload['waypoints'] = [
        {'id': f'wp-{index}', 'lat': 35.0, 'lng': 126.0}
        for index in range(MISSION_MAX_OCCURRENCES + 1)
    ]
    payload['completed_waypoint_ids'] = []
    payload['active_waypoint_id'] = None

    with pytest.raises(ValueError, match='invalid waypoints'):
        save_mission_checkpoint(payload, tmp_path / 'mission.json')


def test_checkpoint_round_trips_command_result_and_dispense_uncertainty(tmp_path):
    payload = _payload()
    payload['last_command_result'] = 'rejected'
    payload['last_command_reason'] = 'checkpoint_write_failed'
    payload['motion_state'] = 'dispense_uncertain'

    path = tmp_path / 'mission.json'
    save_mission_checkpoint(payload, path)

    restored = load_mission_checkpoint(path)
    assert restored['last_command_result'] == 'rejected'
    assert restored['last_command_reason'] == 'checkpoint_write_failed'
    assert restored['motion_state'] == 'dispense_uncertain'
    assert restored['active_waypoint_id'] == 'wp-b'


def test_checkpoint_propagates_directory_fsync_io_failure(monkeypatch, tmp_path):
    real_fsync = os.fsync

    def fail_directory(fd):
        if os.path.isdir(f'/proc/self/fd/{fd}'):
            raise OSError(errno.EIO, 'directory I/O failed')
        return real_fsync(fd)

    monkeypatch.setattr(os, 'fsync', fail_directory)

    with pytest.raises(OSError) as exc_info:
        save_mission_checkpoint(_payload(), tmp_path / 'mission.json')
    assert exc_info.value.errno == errno.EIO


def test_checkpoint_ignores_only_explicit_unsupported_directory_fsync(monkeypatch, tmp_path):
    real_fsync = os.fsync

    def unsupported_directory(fd):
        if os.path.isdir(f'/proc/self/fd/{fd}'):
            raise OSError(errno.EINVAL, 'directory fsync unsupported')
        return real_fsync(fd)

    monkeypatch.setattr(os, 'fsync', unsupported_directory)
    path = tmp_path / 'mission.json'

    save_mission_checkpoint(_payload(), path)

    assert load_mission_checkpoint(path)['mission_id'] == 42


def test_checkpoint_clear_propagates_directory_fsync_io_failure(monkeypatch, tmp_path):
    path = tmp_path / 'mission.json'
    save_mission_checkpoint(_payload(), path)
    real_fsync = os.fsync

    def fail_directory(fd):
        if os.path.isdir(f'/proc/self/fd/{fd}'):
            raise OSError(errno.ENOSPC, 'directory metadata full')
        return real_fsync(fd)

    monkeypatch.setattr(os, 'fsync', fail_directory)

    with pytest.raises(OSError) as exc_info:
        clear_mission_checkpoint(path)
    assert exc_info.value.errno == errno.ENOSPC


def test_checkpoint_fault_round_trip_is_checksummed_and_durably_cleared(tmp_path):
    path = tmp_path / 'mission.fault.json'

    save_mission_checkpoint_fault(
        'checksum mismatch', mission_id=42, plan_hash='b' * 64, path=path)

    fault = load_mission_checkpoint_fault(path)
    assert fault['reason'] == 'checksum mismatch'
    assert fault['mission_id'] == 42
    assert fault['plan_hash'] == 'b' * 64
    assert isinstance(fault['detected_at'], int)
    assert clear_mission_checkpoint_fault(path) is True
    assert clear_mission_checkpoint_fault(path) is False


def test_checkpoint_fault_rejects_tampering(tmp_path):
    path = tmp_path / 'mission.fault.json'
    save_mission_checkpoint_fault('invalid checkpoint', path=path)
    envelope = json.loads(path.read_text(encoding='utf-8'))
    envelope['reason'] = 'silently repaired'
    path.write_text(json.dumps(envelope), encoding='utf-8')

    with pytest.raises(ValueError, match='checksum'):
        load_mission_checkpoint_fault(path)


def test_invalid_checkpoint_identity_is_only_best_effort_correlation(tmp_path):
    path = tmp_path / 'mission.json'
    save_mission_checkpoint(_payload(), path)
    envelope = json.loads(path.read_text(encoding='utf-8'))
    envelope['checksum'] = 'corrupt'
    path.write_text(json.dumps(envelope), encoding='utf-8')

    assert mission_checkpoint_identity(path) == (42, 'a' * 64)
    with pytest.raises(ValueError, match='checksum'):
        load_mission_checkpoint(path)
