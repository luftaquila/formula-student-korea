import json
import time

import pytest

from pilot.lib.mission_checkpoint import load_mission_checkpoint
from pilot.navigator_node import NavigatorNode, State


PLAN_A = 'a' * 64
PLAN_B = 'b' * 64


def _command(*, action='start', seq=1, command_id='cmd-1', plan_hash=PLAN_A,
             waypoints=None, finish_behavior='stop', mission_start=None):
    if waypoints is None:
        waypoints = [
            {'id': 'wp-1', 'cone_id': 101, 'lat': 35.0001, 'lng': 126.0001},
            {'id': 'wp-2', 'cone_id': 102, 'lat': 35.0002, 'lng': 126.0002},
        ]
    payload = {
        'protocol_version': 2,
        'mission_id': 7,
        'plan_hash': plan_hash,
        'command_id': command_id,
        'command_seq': seq,
        'action': action,
        'waypoints': waypoints,
        'finish_behavior': finish_behavior,
        'mission_start': mission_start,
    }
    return type('Msg', (), {'data': json.dumps(payload)})()


def _ready_node(monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    node = NavigatorNode()
    node._gps_lat = 35.0
    node._gps_lon = 126.0
    node._gps_heading_compass = 0.0
    node._gps_fix_status = 'rtk_fixed'
    node._gps_speed = 0.6
    node._last_gps_time = time.monotonic()
    reports = []
    node._pub_mission_report.publish = lambda msg: reports.append(json.loads(msg.data))
    return node, reports


def test_start_is_checkpointed_before_motion_and_duplicate_is_idempotent(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    command = _command()

    node._on_mission_command(command)

    assert node._state == State.CALIBRATING
    checkpoint = load_mission_checkpoint()
    assert checkpoint['mission_id'] == 7
    assert [wp['id'] for wp in checkpoint['waypoints']] == ['wp-1', 'wp-2']
    assert reports[-1]['command_result'] == 'accepted'
    cal_start = (node._cal_start_lat, node._cal_start_lon)

    node._on_mission_command(command)

    assert node._state == State.CALIBRATING
    assert (node._cal_start_lat, node._cal_start_lon) == cal_start
    assert reports[-1]['command_result'] == 'accepted'


def test_emergency_stop_and_reboot_restore_held_until_explicit_resume(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())

    node._on_emergency_stop(None)
    assert node._state == State.EMERGENCY_STOP
    assert reports[-1]['event'] == 'interrupted'
    node._on_clear_emergency(None)
    assert node._state == State.PAUSED
    assert reports[-1]['event'] == 'held'

    rebooted = NavigatorNode()
    assert rebooted._state == State.PAUSED
    assert rebooted._mission_id == 7
    assert rebooted._mission_waypoint_ids == ['wp-1', 'wp-2']


def test_resume_accepts_edited_pending_route_without_replaying_completed(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._mission_completed_ids.add('wp-1')
    node._save_mission_checkpoint('held')

    rebooted = NavigatorNode()
    rebooted._gps_lat = 35.00015
    rebooted._gps_lon = 126.00015
    rebooted._gps_fix_status = 'rtk_fixed'
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(json.loads(msg.data))
    edited = [
        {'id': 'wp-2', 'cone_id': 102, 'lat': 35.0002, 'lng': 126.0002},
        {'id': 'wp-3', 'cone_id': 103, 'lat': 35.0003, 'lng': 126.0003},
    ]

    rebooted._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-2', plan_hash=PLAN_B,
        waypoints=edited,
    ))

    assert rebooted._state == State.CALIBRATING
    assert rebooted._mission_completed_ids == {'wp-1'}
    assert rebooted._mission_waypoint_ids == ['wp-2', 'wp-3']
    assert [wp['id'] for wp in rebooted._mission_all_waypoints] == ['wp-1', 'wp-2', 'wp-3']
    assert reports[-1]['command_result'] == 'accepted'


def test_return_only_resume_is_supported(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(finish_behavior='return_to_start'))
    node._mission_completed_ids.update({'wp-1', 'wp-2'})
    node._save_mission_checkpoint('held')
    node._state = State.PAUSED

    node._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-2', plan_hash=PLAN_B,
        waypoints=[], finish_behavior='return_to_start',
        mission_start={'lat': 35.0, 'lng': 126.0},
    ))

    assert node._state == State.CALIBRATING
    assert node._mission_waypoint_ids == []
    assert node._waypoints == []


def test_completion_stays_checkpointed_until_server_ack(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'cone_id': 101, 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SPRAYING
    node._cur_wp_idx = 0
    node._segments = []

    node._on_spray_done(None)

    events = [report['event'] for report in reports]
    assert events[-2:] == ['waypoint_completed', 'mission_completed']
    assert reports[-1]['completed_waypoint_ids'] == ['wp-1']
    assert node._state == State.IDLE
    assert node._mission_id == 7
    checkpoint = load_mission_checkpoint()
    assert checkpoint['motion_state'] == 'completion_pending'

    node._on_mission_reset(None)
    assert node._mission_id is None
    assert load_mission_checkpoint() is None


def test_reboot_replays_unacknowledged_completion(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'cone_id': 101, 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._mission_completed_ids.add('wp-1')
    node._finish_v2_mission_if_active()

    rebooted = NavigatorNode()
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(json.loads(msg.data))
    rebooted._on_mission_state_request(None)

    assert reports[-1]['event'] == 'mission_completed'
    assert reports[-1]['completed_waypoint_ids'] == ['wp-1']
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'


def test_spray_timeout_holds_same_pending_waypoint(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'cone_id': 101, 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SPRAYING
    node._cur_wp_idx = 0
    node._spray_enter_time = time.monotonic() - 10.0

    node._handle_spraying()

    assert node._state == State.PAUSED
    assert reports[-1]['event'] == 'waypoint_failed'
    assert reports[-1]['waypoint_id'] == 'wp-1'
    assert load_mission_checkpoint()['completed_waypoint_ids'] == []


def test_server_terminal_reset_clears_stale_checkpoint(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())

    node._on_mission_reset(None)

    assert node._state == State.IDLE
    assert node._mission_id is None
    assert load_mission_checkpoint() is None
