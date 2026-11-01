"""F5 temperature summary on the System card (AC-45, AC-46)."""

import re

import pytest

from helpers import open_dashboard


def temp_row(page):
    rows = [value for label, value in page.detail_rows('#cardSystem') if label == 'Temp']
    return rows[0] if rows else None


def test_temperature_real_summary_is_plausible(ext, mock):
    """AC-45 against the captured real response: every shown value must be a plausible temperature.
    The API summary averages every *_input lm-sensors key (fans, voltages, energy) as CELSIUS upstream."""
    page = open_dashboard(ext, mock)
    row = temp_row(page)
    assert row is not None
    values = [int(v) for v in re.findall(r'(-?\d+)°[CF]', row)]
    assert values and all(value < 150 for value in values), row


@pytest.mark.parametrize('variant, expected, warning, critical', [
    ('plausible', 'avg 38°C - hottest 57°C, 1 warning', ['1 warning'], []),
    ('fahrenheit', 'avg 101°F - hottest 134°F, 2 critical', [], ['2 critical']),
])
def test_temperature_summary_format(ext, mock, variant, expected, warning, critical):
    """AC-45: rounded values in the API unit, warning (orange) and critical (red) counts"""
    mock.set_temperature(variant)
    page = open_dashboard(ext, mock)
    assert temp_row(page) == expected
    assert page.texts('#cardSystem .ut-detail-value .ut-text-warning') == warning
    assert page.texts('#cardSystem .ut-detail-value .ut-text-error') == critical


@pytest.mark.parametrize('setup', ['kelvin', 'null', 'http400', '4.37.5', 'unknown_version'])
def test_temperature_hidden(ext, mock, setup):
    """AC-45 (other units hide the row), AC-46 (old/unknown API never asks; null or failing hides the row)"""
    if setup in ('kelvin', 'null'):
        mock.set_temperature(setup)
    elif setup == 'http400':
        mock.fail('Temperature', 'http400', 'temperature')
    elif setup == '4.37.5':
        mock.set_api_version('4.37.5')
    else:
        mock.fail('ApiVersion', 'gql', 'Internal server error')
    page = open_dashboard(ext, mock)
    assert temp_row(page) is None
    assert [label for label, _ in page.detail_rows('#cardSystem')] == ['Server', 'Uptime', 'CPU', 'Cores', 'Memory',
                                                                     'Network']
    if setup in ('4.37.5', 'unknown_version'):
        assert 'Temperature' not in mock.ops()
