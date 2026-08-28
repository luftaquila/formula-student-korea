import json
import time

import pytest
from rclpy.qos import DurabilityPolicy, ReliabilityPolicy

from pilot.lib.mission_checkpoint import (
    checkpoint_fault_path, checkpoint_path, load_mission_checkpoint,
    load_mission_checkpoint_fault,
)
from pilot import navigator_node as navigator_module
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


def _reset_msg(node, *, mission_id=None, plan_hash=None):
    return type('Msg', (), {'data': json.dumps({
        'protocol_version': 2,
        'mission_id': node._mission_id if mission_id is None else mission_id,
        'plan_hash': node._mission_plan_hash if plan_hash is None else plan_hash,
    })})()


def _hold_msg(*, mission_id=7, plan_hash=PLAN_A, hold_id='hold-1',
              reason='bridge_restarted'):
    return type('Msg', (), {'data': json.dumps({
        'protocol_version': 2,
        'mission_id': mission_id,
        'plan_hash': plan_hash,
        'hold_id': hold_id,
        'reason': reason,
    })})()


def test_start_is_checkpointed_before_motion_and_duplicate_is_idempotent(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    command = _command()

    node._on_mission_command(command)

    assert node._state == State.CALIBRATING
    checkpoint = load_mission_checkpoint()
    assert checkpoint['mission_id'] == 7
    assert [wp['id'] for wp in checkpoint['waypoints']] == ['wp-1', 'wp-2']
    assert checkpoint['last_command_result'] == 'accepted'
    assert reports[-1]['command_result'] == 'accepted'
    cal_start = (node._cal_start_lat, node._cal_start_lon)

    node._on_mission_command(command)

    assert node._state == State.CALIBRATING
    assert (node._cal_start_lat, node._cal_start_lon) == cal_start
    assert reports[-1]['command_result'] == 'accepted'


def test_end_reports_accepted_only_after_motion_is_held(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    velocity = []
    node._pub_velocity.publish = lambda msg: velocity.append(
        (msg.linear.x, msg.angular.z))

    node._on_mission_command(_command(
        action='end', seq=2, command_id='cmd-end'))

    assert velocity[-1] == (0.0, 0.0)
    assert node._state == State.IDLE
    assert reports[-1]['event'] == 'command'
    assert reports[-1]['command_id'] == 'cmd-end'
    assert reports[-1]['command_result'] == 'accepted'
    assert reports[-1]['motion_state'] == 'held'
    assert load_mission_checkpoint() is None


def test_emergency_stop_and_reboot_restore_held_until_explicit_resume(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())

    node._on_emergency_stop(None)
    assert node._state == State.EMERGENCY_STOP
    assert reports[-1]['event'] == 'interrupted'
    node._on_clear_emergency(None)
    assert node._state == State.PAUSED
    assert reports[-1]['event'] == 'held'
    assert reports[-1]['emergency_stop_cleared'] is True
    assert reports[-1]['motion_state'] == 'held'
    assert reports[-1]['checkpoint_persisted'] is True

    rebooted = NavigatorNode()
    assert rebooted._state == State.PAUSED
    assert rebooted._mission_id == 7
    assert rebooted._mission_waypoint_ids == ['wp-1', 'wp-2']


def test_pause_during_gps_error_cancels_auto_recovery_and_replays_held_result(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._state = State.NAVIGATING
    node._last_gps_time = (
        time.monotonic() - node.get_parameter('gps_timeout').value - 1.0)

    node._control_loop()

    assert node._state == State.ERROR
    assert node._pre_error_state == State.NAVIGATING
    pause = _command(action='pause', seq=2, command_id='cmd-pause-error')
    velocity = []
    node._pub_velocity.publish = lambda msg: velocity.append(
        (msg.linear.x, msg.angular.z))
    reports.clear()

    node._on_mission_command(pause)

    assert velocity[-1] == (0.0, 0.0)
    assert node._state == State.PAUSED
    assert node._pre_error_state is None
    checkpoint = load_mission_checkpoint()
    assert checkpoint['motion_state'] == 'held'
    assert checkpoint['last_command_id'] == 'cmd-pause-error'
    assert checkpoint['last_command_result'] == 'accepted'
    command_report = reports[-1]
    assert command_report['event'] == 'command'
    assert command_report['command_result'] == 'accepted'
    assert command_report['motion_state'] == 'held'

    # Exact redelivery must replay the durable result without reopening the
    # GPS recovery path that previously pointed back to NAVIGATING.
    reports.clear()
    node._on_mission_command(pause)
    assert reports[-1]['command_result'] == 'accepted'
    assert reports[-1]['motion_state'] == 'held'

    node._gps_fix_status = 'rtk_fixed'
    node._last_gps_time = time.monotonic()
    node.set_parameter_value('fix_recovery_hold_s', 0.0)
    node._control_loop()

    assert node._state == State.PAUSED
    assert node._pre_error_state is None


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

    node._on_mission_reset(_reset_msg(node))
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
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._trigger_spray()
    node._spray_enter_time = time.monotonic() - 10.0

    node._handle_spraying()

    assert node._state == State.PAUSED
    assert reports[-1]['event'] == 'waypoint_failed'
    assert reports[-1]['waypoint_id'] == 'wp-1'
    assert reports[-1]['outcome'] == 'dispense_outcome_uncertain'
    assert load_mission_checkpoint()['completed_waypoint_ids'] == []
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'


def test_server_terminal_reset_clears_stale_checkpoint(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())

    node._on_mission_reset(_reset_msg(node))

    assert node._state == State.IDLE
    assert node._mission_id is None
    assert load_mission_checkpoint() is None


def test_rejected_start_result_survives_reboot_and_exact_replay(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._gps_fix_status = 'no_fix'
    command = _command()

    node._on_mission_command(command)

    assert reports[-1]['command_result'] == 'rejected'
    original_reason = reports[-1]['reason']
    checkpoint = load_mission_checkpoint()
    assert checkpoint['last_command_result'] == 'rejected'
    assert checkpoint['last_command_reason'] == original_reason

    rebooted = NavigatorNode()
    replayed = []
    rebooted._pub_mission_report.publish = lambda msg: replayed.append(json.loads(msg.data))
    rebooted._on_mission_command(command)

    assert replayed[-1]['command_result'] == 'rejected'
    assert replayed[-1]['reason'] == original_reason
    assert rebooted._state == State.PAUSED


def test_accepted_start_result_survives_reboot_without_restarting_motion(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    command = _command()
    node._on_mission_command(command)

    rebooted = NavigatorNode()
    replayed = []
    rebooted._pub_mission_report.publish = lambda msg: replayed.append(json.loads(msg.data))
    rebooted._on_mission_command(command)

    assert replayed[-1]['command_result'] == 'accepted'
    assert rebooted._state == State.PAUSED
    assert load_mission_checkpoint()['last_command_result'] == 'accepted'


def test_unknown_staged_command_fails_closed_and_persists_replay_result(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    command = _command()
    node._mission_id = 7
    node._mission_plan_hash = PLAN_A
    node._mission_command_seq = 1
    node._mission_last_command_id = 'cmd-1'
    node._mission_last_command_result = None
    node._mission_waypoint_ids = ['wp-1']
    node._mission_all_waypoints = [
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]
    node._waypoints = [{'lat': 35.0001, 'lng': 126.0001}]
    node._save_mission_checkpoint('held')

    rebooted = NavigatorNode()
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(json.loads(msg.data))
    rebooted._on_mission_command(command)

    assert reports[-1]['command_result'] == 'rejected'
    assert reports[-1]['reason'] == 'command_result_unknown'
    checkpoint = load_mission_checkpoint()
    assert checkpoint['last_command_result'] == 'rejected'
    assert checkpoint['last_command_reason'] == 'command_result_unknown'
    assert rebooted._state == State.PAUSED


def test_checkpoint_failure_never_becomes_accepted_on_duplicate(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    monkeypatch.setattr('pilot.navigator_node.save_mission_checkpoint',
                        lambda *_a, **_kw: (_ for _ in ()).throw(OSError('disk full')))
    command = _command()

    node._on_mission_command(command)
    node._on_mission_command(command)

    assert [report['command_result'] for report in reports[-2:]] == [
        'rejected', 'rejected',
    ]
    assert reports[-1]['reason'] == 'checkpoint_write_failed'
    assert node._state != State.CALIBRATING


def test_transient_stage_failure_durably_records_rejection(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    real_save = navigator_module.save_mission_checkpoint
    calls = 0

    def fail_once(payload):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError('transient directory failure')
        return real_save(payload)

    monkeypatch.setattr(navigator_module, 'save_mission_checkpoint', fail_once)

    node._on_mission_command(_command())

    assert reports[-1]['command_result'] == 'rejected'
    assert reports[-1]['reason'] == 'checkpoint_write_failed'
    checkpoint = load_mission_checkpoint()
    assert checkpoint['last_command_result'] == 'rejected'
    assert checkpoint['last_command_reason'] == 'checkpoint_write_failed'
    assert node._state != State.CALIBRATING


def test_navigator_mission_subscriptions_are_reliable_transient_local(
        monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    node = NavigatorNode()
    specs = {topic: qos for _msg_type, topic, _callback, qos in node._subscription_specs}
    publisher_specs = {
        topic: qos for _msg_type, topic, qos in node._publisher_specs
    }

    for topic in ('/rover/cmd/mission', '/rover/cmd/mission_state_request',
                  '/rover/cmd/mission_reset',
                  '/rover/cmd/mission_safety_hold'):
        assert specs[topic].reliability == ReliabilityPolicy.RELIABLE
        assert specs[topic].durability == DurabilityPolicy.TRANSIENT_LOCAL
        assert specs[topic].depth == 1
    report_qos = publisher_specs['/rover/mission/report']
    assert report_qos.reliability == ReliabilityPolicy.RELIABLE
    assert report_qos.durability == DurabilityPolicy.TRANSIENT_LOCAL
    assert report_qos.depth == 10


def test_completion_pending_is_terminal_fence_for_resume(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._mission_completed_ids.add('wp-1')
    node._finish_v2_mission_if_active()
    before = load_mission_checkpoint()

    node._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-2', plan_hash=PLAN_B,
        waypoints=[{'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001}],
    ))

    assert reports[-2]['event'] == 'command'
    assert reports[-2]['command_result'] == 'rejected'
    assert reports[-2]['reason'] == 'mission_already_completed'
    assert reports[-1]['event'] == 'mission_completed'
    assert load_mission_checkpoint() == before
    assert node._mission_completion_pending is True


def test_exact_accepted_command_replays_before_completion_fence(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    command = _command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ])
    node._on_mission_command(command)
    node._mission_completed_ids.add('wp-1')
    node._finish_v2_mission_if_active()
    reports.clear()

    node._on_mission_command(command)

    assert [report['event'] for report in reports] == [
        'command', 'mission_completed',
    ]
    assert reports[0]['command_result'] == 'accepted'
    assert reports[0]['command_id'] == 'cmd-1'
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'


def test_empty_all_skipped_resume_is_durable_completion(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._save_mission_checkpoint('held')
    node._state = State.PAUSED
    reports.clear()

    empty_resume = _command(
        action='resume', seq=2, command_id='cmd-empty', plan_hash=PLAN_B,
        waypoints=[], finish_behavior='stop')
    node._on_mission_command(empty_resume)

    assert [report['event'] for report in reports] == [
        'command', 'mission_completed',
    ]
    assert reports[0]['command_result'] == 'accepted'
    assert node._mission_completion_pending is True
    checkpoint = load_mission_checkpoint()
    assert checkpoint['motion_state'] == 'completion_pending'
    assert checkpoint['waypoints'] == []
    assert checkpoint['completed_waypoint_ids'] == []
    assert checkpoint['last_command_id'] == 'cmd-empty'
    assert checkpoint['last_command_result'] == 'accepted'

    rebooted = NavigatorNode()
    replayed = []
    rebooted._pub_mission_report.publish = lambda msg: replayed.append(
        json.loads(msg.data))
    rebooted._on_mission_command(empty_resume)
    assert [report['event'] for report in replayed] == [
        'command', 'mission_completed',
    ]
    assert replayed[0]['command_result'] == 'accepted'


def test_empty_start_remains_rejected(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)

    node._on_mission_command(_command(waypoints=[]))

    assert reports[-1]['command_result'] == 'rejected'
    assert reports[-1]['reason'] == 'empty_remaining_plan'


def test_empty_resume_explicitly_resolves_uncertain_occurrence_as_completion(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._trigger_spray()
    node._state = State.PAUSED
    reports.clear()

    node._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-resolve', plan_hash=PLAN_B,
        waypoints=[], finish_behavior='stop'))

    assert reports[0]['event'] == 'command'
    assert reports[0]['command_result'] == 'accepted'
    assert reports[1]['event'] == 'mission_completed'
    assert node._mission_dispense_uncertain_id is None
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'


def test_stale_terminal_reset_cannot_clear_newer_mission(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())

    node._on_mission_reset(_reset_msg(node, mission_id=999))
    assert node._mission_id == 7
    assert load_mission_checkpoint()['mission_id'] == 7

    node._on_mission_reset(_reset_msg(node, plan_hash=PLAN_B))
    assert node._mission_id == 7


def test_dispense_uncertainty_survives_reboot_and_requires_route_resolution(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    triggered = []
    node._pub_waypoint_reached.publish = lambda msg: triggered.append(msg.data)
    node._state = State.SETTLING
    node._cur_wp_idx = 0

    node._trigger_spray()

    assert triggered == [0]
    checkpoint = load_mission_checkpoint()
    assert checkpoint['motion_state'] == 'dispense_uncertain'
    assert checkpoint['active_waypoint_id'] == 'wp-1'

    rebooted = NavigatorNode()
    rebooted._gps_lat = 35.0
    rebooted._gps_lon = 126.0
    rebooted._gps_fix_status = 'rtk_fixed'
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(json.loads(msg.data))
    rebooted._on_mission_state_request(None)
    assert reports[-1]['event'] == 'waypoint_failed'
    assert reports[-1]['outcome'] == 'dispense_outcome_uncertain'
    rebooted._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-2', plan_hash=PLAN_B,
    ))

    command_report = next(report for report in reversed(reports)
                          if report['event'] == 'command')
    assert command_report['command_result'] == 'rejected'
    assert command_report['reason'] == 'dispense_outcome_uncertain'
    assert rebooted._state == State.PAUSED

    rebooted._on_mission_command(_command(
        action='resume', seq=3, command_id='cmd-3', plan_hash='c' * 64,
        waypoints=[{'id': 'wp-2', 'lat': 35.0002, 'lng': 126.0002}],
    ))

    assert rebooted._mission_dispense_uncertain_id is None
    assert rebooted._mission_waypoint_ids == ['wp-2']
    assert rebooted._state == State.CALIBRATING
    assert reports[-1]['command_result'] == 'accepted'


def test_state_report_carries_durable_causal_command_snapshot(monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._on_pause(None)
    checkpoint = load_mission_checkpoint()

    assert checkpoint['last_command_id'] == 'cmd-1'
    assert checkpoint['command_seq'] == 1
    assert checkpoint['last_command_result'] == 'accepted'

    rebooted = NavigatorNode()
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))
    rebooted._on_mission_state_request(None)

    state = reports[-1]
    assert state['event'] == 'state'
    assert state['motion_state'] == 'held'
    assert state['last_command_id'] == checkpoint['last_command_id']
    assert state['command_seq'] == checkpoint['command_seq']
    assert state['last_command_result'] == checkpoint['last_command_result']
    assert state['last_command_reason'] == checkpoint['last_command_reason']


def test_pause_still_cancels_and_holds_an_uncertain_dispense(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    cancelled = []
    node._pub_spray_cancel.publish = lambda msg: cancelled.append(msg.data)
    node._trigger_spray()

    node._on_mission_command(_command(
        action='pause', seq=2, command_id='cmd-pause',
    ))

    assert cancelled == [0]
    assert node._state == State.PAUSED
    assert node._mission_dispense_uncertain_id == 'wp-1'
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'
    assert reports[-1]['event'] == 'command'
    assert reports[-1]['command_result'] == 'accepted'


def test_dispense_trigger_is_not_published_when_uncertain_checkpoint_fails(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    triggered = []
    node._pub_waypoint_reached.publish = lambda msg: triggered.append(msg.data)
    node._save_mission_checkpoint = lambda _state=None: False

    node._trigger_spray()

    assert triggered == []
    assert node._state == State.PAUSED
    assert reports[-1]['event'] == 'waypoint_failed'
    assert reports[-1]['outcome'] == 'checkpoint_write_failed'


def test_waypoint_completion_checkpoint_failure_holds_without_advancing(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._segments = [object(), object()]
    node._trigger_spray()
    node._save_mission_checkpoint = lambda _state=None: False

    node._on_spray_done(None)

    assert node._state == State.PAUSED
    assert node._cur_seg_idx == 0
    assert node._mission_completed_ids == {'wp-1'}
    assert [report['event'] for report in reports[-2:]] == [
        'waypoint_completed', 'held',
    ]
    # The last durable file remains the pre-actuator uncertainty marker.
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'


def test_last_waypoint_completion_is_atomically_completion_pending(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._segments = [object()]
    node._trigger_spray()
    original_save = node._save_mission_checkpoint
    saved_states = []

    def recording_save(state=None):
        saved_states.append(state)
        return original_save(state)

    node._save_mission_checkpoint = recording_save
    node._on_spray_done(None)

    assert saved_states[0] == 'completion_pending'
    assert 'running' not in saved_states
    checkpoint = load_mission_checkpoint()
    assert checkpoint['motion_state'] == 'completion_pending'
    assert checkpoint['completed_waypoint_ids'] == ['wp-1']


def test_terminal_checkpoint_failure_holds_and_does_not_advance(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._segments = [object()]
    node._trigger_spray()
    node._save_mission_checkpoint = lambda _state=None: False

    node._on_spray_done(None)

    assert node._state == State.PAUSED
    assert node._cur_seg_idx == 0
    assert node._mission_completion_pending is True
    assert [report['event'] for report in reports[-2:]] == [
        'waypoint_completed', 'mission_completed',
    ]
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'


def test_completion_checkpoint_survives_estop_and_clear(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._mission_completed_ids.add('wp-1')
    node._finish_v2_mission_if_active()
    reports.clear()

    node._on_emergency_stop(None)
    assert node._state == State.EMERGENCY_STOP
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'
    assert reports[-1]['event'] == 'mission_completed'

    node._on_clear_emergency(None)
    assert node._state == State.PAUSED
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'
    assert reports[-1]['event'] == 'mission_completed'
    assert reports[-1]['emergency_stop_cleared'] is True
    assert reports[-1]['motion_state'] == 'held'
    assert reports[-1]['checkpoint_persisted'] is True


def test_corrupt_checkpoint_latches_across_reboots_until_correlated_reset(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    path = checkpoint_path()
    envelope = json.loads(path.read_text(encoding='utf-8'))
    envelope['checksum'] = 'corrupt'
    path.write_text(json.dumps(envelope), encoding='utf-8')

    faulted = NavigatorNode()
    assert faulted._mission_checkpoint_fault['mission_id'] == 7
    assert faulted._mission_checkpoint_fault['plan_hash'] == PLAN_A
    assert load_mission_checkpoint_fault()['mission_id'] == 7
    path.unlink()

    # The separate fault record prevents disappearance/replacement of the bad
    # progress file from silently turning the next boot into a clean IDLE.
    rebooted = NavigatorNode()
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))
    rebooted._on_mission_command(_command(
        action='resume', seq=2, command_id='cmd-blocked'))
    assert reports[-1]['command_result'] == 'rejected'
    assert reports[-1]['reason'] == 'mission_storage_fault'

    rebooted._on_mission_reset(_reset_msg(
        rebooted, mission_id=999, plan_hash=PLAN_A))
    assert checkpoint_fault_path().exists()
    rebooted._on_mission_reset(_reset_msg(
        rebooted, mission_id=7, plan_hash=PLAN_A))
    assert not checkpoint_fault_path().exists()

    rebooted._gps_lat = 35.0
    rebooted._gps_lon = 126.0
    rebooted._gps_fix_status = 'rtk_fixed'
    rebooted._on_mission_command(_command(
        action='start', seq=3, command_id='cmd-recovered'))
    assert reports[-1]['command_result'] == 'accepted'
    assert rebooted._state == State.CALIBRATING


def test_unidentifiable_corrupt_checkpoint_requires_explicit_end_recovery(
        monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    checkpoint_path().write_text('{not-json', encoding='utf-8')
    node = NavigatorNode()
    reports = []
    node._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))

    node._on_mission_command(_command())
    assert reports[-1]['reason'] == 'mission_storage_fault'
    node._on_mission_reset(_reset_msg(
        node, mission_id=7, plan_hash=PLAN_A))
    assert checkpoint_fault_path().exists()

    node._on_mission_command(_command(
        action='end', seq=2, command_id='cmd-recover'))

    assert reports[-1]['command_result'] == 'accepted'
    assert node._mission_checkpoint_fault is None
    assert not checkpoint_path().exists()
    assert not checkpoint_fault_path().exists()


def test_fault_latch_write_failure_still_blocks_each_boot(
        monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    checkpoint_path().write_text('{not-json', encoding='utf-8')
    monkeypatch.setattr(
        navigator_module, 'save_mission_checkpoint_fault',
        lambda *_a, **_kw: (_ for _ in ()).throw(OSError('read-only disk')))

    first = NavigatorNode()
    second = NavigatorNode()
    reports = []
    second._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))
    second._on_mission_command(_command())

    assert first._mission_checkpoint_fault is not None
    assert second._mission_checkpoint_fault is not None
    assert reports[-1]['command_result'] == 'rejected'
    assert reports[-1]['reason'] == 'mission_storage_fault'
    assert not checkpoint_fault_path().exists()
    assert checkpoint_path().exists()

    second._gps_lat = 35.0
    second._gps_lon = 126.0
    second._gps_fix_status = 'rtk_fixed'
    second._on_execute_path(type('Msg', (), {'data': json.dumps([
        {'lat': 35.0001, 'lng': 126.0001},
    ])})())
    assert second._state == State.IDLE
    assert second._waypoints == []


def test_explicit_end_recovers_even_when_corrupt_identity_is_untrusted(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    path = checkpoint_path()
    envelope = json.loads(path.read_text(encoding='utf-8'))
    envelope['mission_id'] = 999
    path.write_text(json.dumps(envelope), encoding='utf-8')
    faulted = NavigatorNode()
    reports = []
    faulted._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))

    faulted._on_mission_command(_command(
        action='end', seq=2, command_id='cmd-explicit-recovery'))

    assert reports[-1]['command_result'] == 'accepted'
    assert reports[-1]['command_id'] == 'cmd-explicit-recovery'
    assert faulted._mission_checkpoint_fault is None
    assert not checkpoint_path().exists()
    assert not checkpoint_fault_path().exists()


def test_safety_hold_is_persisted_and_correlated_before_ack(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    reports.clear()

    node._on_mission_safety_hold(_hold_msg())

    assert node._state == State.PAUSED
    assert load_mission_checkpoint()['motion_state'] == 'held'
    assert reports[-1]['event'] == 'held'
    assert reports[-1]['hold_id'] == 'hold-1'
    assert reports[-1]['checkpoint_persisted'] is True
    assert reports[-1]['motion_state'] == 'held'

    # Server redelivery before acknowledgement must be idempotent and produce
    # another correlated acknowledgement without releasing the hold.
    node._on_mission_safety_hold(_hold_msg())
    assert reports[-1]['hold_id'] == 'hold-1'
    assert node._state == State.PAUSED

    # Power loss after the local checkpoint but before the bridge's HTTP report
    # leaves the replacement navigator held; the server's same hold redelivery
    # yields a fresh correlated acknowledgement.
    rebooted = NavigatorNode()
    reboot_reports = []
    rebooted._pub_mission_report.publish = lambda msg: reboot_reports.append(
        json.loads(msg.data))
    assert rebooted._state == State.PAUSED
    rebooted._on_mission_safety_hold(_hold_msg())
    assert reboot_reports[-1]['hold_id'] == 'hold-1'
    assert reboot_reports[-1]['checkpoint_persisted'] is True


def test_safety_hold_reports_unpersisted_and_preserves_completion_fence(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._mission_completed_ids.add('wp-1')
    node._finish_v2_mission_if_active()
    reports.clear()
    node._save_mission_checkpoint = lambda _state=None: False

    node._on_mission_safety_hold(_hold_msg())

    assert reports[0]['event'] == 'held'
    assert reports[0]['hold_id'] == 'hold-1'
    assert reports[0]['checkpoint_persisted'] is False
    assert reports[0]['motion_state'] == 'completion_pending'
    assert reports[1]['event'] == 'mission_completed'
    assert node._mission_completion_pending is True
    # The durable file was already completion_pending before this failed write.
    assert load_mission_checkpoint()['motion_state'] == 'completion_pending'


def test_safety_hold_rejects_stale_identity_without_ack(monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    reports.clear()

    node._on_mission_safety_hold(_hold_msg(mission_id=999))
    node._on_mission_safety_hold(_hold_msg(plan_hash=PLAN_B))

    assert reports == []
    assert node._state == State.CALIBRATING


def test_safety_hold_does_not_release_estop_and_acks_as_interrupted(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._on_emergency_stop(None)
    reports.clear()

    node._on_mission_safety_hold(_hold_msg())

    assert node._state == State.EMERGENCY_STOP
    assert reports[-1]['event'] == 'interrupted'
    assert reports[-1]['hold_id'] == 'hold-1'
    assert reports[-1]['checkpoint_persisted'] is True
    assert load_mission_checkpoint()['motion_state'] == 'held'


def test_safety_hold_cancels_dispense_and_preserves_uncertainty(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    cancelled = []
    node._pub_spray_cancel.publish = lambda msg: cancelled.append(msg.data)
    node._trigger_spray()
    reports.clear()

    node._on_mission_safety_hold(_hold_msg())

    assert cancelled == [0]
    assert node._state == State.PAUSED
    assert node._mission_dispense_uncertain_id == 'wp-1'
    assert reports[-1]['event'] == 'held'
    assert reports[-1]['motion_state'] == 'dispense_uncertain'
    assert reports[-1]['checkpoint_persisted'] is True
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'


def test_reboot_hold_ack_preserves_uncertainty_after_earlier_state_request(
        monkeypatch, tmp_path):
    node, _reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command(waypoints=[
        {'id': 'wp-1', 'lat': 35.0001, 'lng': 126.0001},
    ]))
    node._state = State.SETTLING
    node._cur_wp_idx = 0
    node._trigger_spray()

    rebooted = NavigatorNode()
    reports = []
    rebooted._pub_mission_report.publish = lambda msg: reports.append(
        json.loads(msg.data))

    # These intents use separate transient-local DDS topics. Exercise the order
    # in which the server rejects this first report while its reboot hold exists.
    rebooted._on_mission_state_request(None)
    rebooted._on_mission_safety_hold(_hold_msg(reason='rover_rebooted'))

    assert reports[0]['event'] == 'waypoint_failed'
    assert reports[0]['outcome'] == 'dispense_outcome_uncertain'
    hold_ack = reports[1]
    assert hold_ack['event'] == 'held'
    assert hold_ack['hold_id'] == 'hold-1'
    assert hold_ack['checkpoint_persisted'] is True
    assert hold_ack['motion_state'] == 'dispense_uncertain'
    assert hold_ack['reason'] == 'dispense_outcome_uncertain'
    assert hold_ack['outcome'] == 'dispense_outcome_uncertain'
    assert hold_ack['active_waypoint_id'] == 'wp-1'
    assert load_mission_checkpoint()['motion_state'] == 'dispense_uncertain'


def test_clean_reboot_accepts_correlated_end_retry_after_local_end_was_lost(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    node._on_mission_command(_command(
        action='end', seq=2, command_id='cmd-end-before-power-loss'))

    assert reports[-1]['command_result'] == 'accepted'
    assert reports[-1]['motion_state'] == 'held'
    assert load_mission_checkpoint() is None

    # Simulate power loss before the accepted report reached the server. A new
    # server command must still get a correlated held acknowledgement even
    # though the replacement navigator has no mission checkpoint to restore.
    rebooted = NavigatorNode()
    reboot_reports = []
    rebooted._pub_mission_report.publish = lambda msg: reboot_reports.append(
        json.loads(msg.data))
    rebooted._on_mission_safety_hold(_hold_msg())
    assert reboot_reports == []

    rebooted._on_mission_command(_command(
        action='end', seq=3, command_id='cmd-end-retry'))

    assert rebooted._state == State.IDLE
    assert reboot_reports[-1]['event'] == 'command'
    assert reboot_reports[-1]['command_id'] == 'cmd-end-retry'
    assert reboot_reports[-1]['command_result'] == 'accepted'
    assert reboot_reports[-1]['motion_state'] == 'held'
    assert load_mission_checkpoint() is None


def test_pause_checkpoint_failure_still_reports_held_motion_state(
        monkeypatch, tmp_path):
    node, reports = _ready_node(monkeypatch, tmp_path)
    node._on_mission_command(_command())
    reports.clear()
    node._save_mission_checkpoint = lambda _state=None: False

    node._on_mission_command(_command(
        action='pause', seq=2, command_id='cmd-pause'))

    command_report = reports[-1]
    assert node._state == State.PAUSED
    assert reports[0]['event'] == 'held'
    assert command_report['event'] == 'command'
    assert command_report['command_result'] == 'rejected'
    assert command_report['reason'] == 'checkpoint_write_failed'
    assert command_report['motion_state'] == 'held'
