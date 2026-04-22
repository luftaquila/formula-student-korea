"""Tests for protocol/status helper utilities."""

from fsk_rover.lib.protocol_utils import assemble_sse_data, has_required_fix_status


class TestHasRequiredFixStatus:
    def test_accepts_exact_match(self):
        assert has_required_fix_status('rtk_fixed', 'rtk_fixed')

    def test_accepts_higher_quality(self):
        assert has_required_fix_status('rtk_fixed', 'rtk_float')

    def test_rejects_lower_quality(self):
        assert not has_required_fix_status('3d_fix', 'rtk_fixed')

    def test_unknown_required_defaults_to_strictest(self):
        assert not has_required_fix_status('rtk_float', 'invalid')


class TestAssembleSSEData:
    def test_joins_multiline_payload(self):
        assert assemble_sse_data(['{"foo":', '"bar"}']) == '{"foo":\n"bar"}'

    def test_preserves_empty_data_line(self):
        assert assemble_sse_data(['first', '', 'third']) == 'first\n\nthird'
