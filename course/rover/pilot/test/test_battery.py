"""Tests for battery_node voltage→percent mapping and publish pipeline."""

import json

import pytest
from pilot.battery_node import BatteryNode, voltage_to_percent


@pytest.fixture
def battery():
    return BatteryNode()


def test_voltage_to_percent_full():
    assert voltage_to_percent(12.6) == 100
    assert voltage_to_percent(13.0) == 100


def test_voltage_to_percent_empty():
    assert voltage_to_percent(9.9) == 0
    assert voltage_to_percent(8.0) == 0


def test_voltage_to_percent_linear_midpoint():
    mid = (12.6 + 9.9) / 2
    assert voltage_to_percent(mid) == 50


def test_voltage_to_percent_none():
    assert voltage_to_percent(None) is None


def test_simulated_publish_emits_json(battery):
    published = []
    battery._pub.publish = lambda msg: published.append(msg)
    battery.set_parameter_value('source', 'simulated')
    battery.set_parameter_value('simulated_voltage', 11.25)
    battery._publish_battery()
    assert len(published) == 1
    payload = json.loads(published[0].data)
    assert payload['source'] == 'simulated'
    assert payload['voltage'] == 11.25
    assert isinstance(payload['percent'], int)
    assert 0 <= payload['percent'] <= 100


def test_ina219_source_without_smbus_reports_none(battery, monkeypatch):
    """source=ina219 must not crash when smbus2 is missing."""
    published = []
    battery._pub.publish = lambda msg: published.append(msg)
    battery.set_parameter_value('source', 'ina219')
    # Ensure smbus2 import fails
    import sys
    monkeypatch.setitem(sys.modules, 'smbus2', None)
    battery._publish_battery()
    payload = json.loads(published[0].data)
    assert payload['voltage'] is None
    assert payload['percent'] is None
