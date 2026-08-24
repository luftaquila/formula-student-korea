import json

import pytest

from pilot.lib.mission_checkpoint import (
    clear_mission_checkpoint,
    load_mission_checkpoint,
    save_mission_checkpoint,
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
