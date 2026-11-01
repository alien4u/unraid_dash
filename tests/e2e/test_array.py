"""F4 parity row (AC-40 to AC-44) and F5 disk chip colors (AC-47, AC-48)."""

import re

import pytest

from helpers import open_dashboard

PARITY_LABELS = ('Parity check', 'Last check', 'No parity check run yet')
RELATIVE_OR_DATE = r'(just now|\d+[mhd] ago|[A-Z][a-z]{2} \d{1,2})'


def parity_rows(page):
    return [row for row in page.detail_rows('#cardArray') if row[0] in PARITY_LABELS]


def chip(page, name):
    return next(c for c in page.chips() if c['name'] == name)


def test_parity_running(ext, mock):
    """AC-40 (provisional RUNNING fixture): progress and speed plus a progress bar"""
    mock.set_parity('running')
    page = open_dashboard(ext, mock)
    assert parity_rows(page) == [['Parity check', '42% - 187 MB/s']]
    bars = page.eval('''() => [...document.querySelectorAll('#cardArray .ut-progress-row')]
        .map((pRow) => [pRow.querySelector('.ut-progress-label').textContent, pRow.querySelector('.ut-progress-value').textContent])''')
    assert ['', '42%'] in bars


def test_parity_running_with_errors_correcting(ext, mock):
    """AC-40, AC-41 (schema-only values: the v4.37.9 server never fills errors/correcting)"""
    mock.set_parity('running_errors')
    page = open_dashboard(ext, mock)
    [[label, value]] = parity_rows(page)
    assert label == 'Parity check'
    assert value.startswith('42% - 187 MB/s') and '(correcting)' in value and '3 errors' in value
    assert page.texts('#cardArray .ut-detail-value .ut-text-error') == ['3 errors']


def test_parity_paused(ext, mock):
    """AC-41 (provisional PAUSED fixture)"""
    mock.set_parity('paused')
    page = open_dashboard(ext, mock)
    assert parity_rows(page) == [['Parity check', 'paused at 42%']]


@pytest.mark.parametrize('variant, result', [
    ('completed', 'Completed'),
    ('completed_numeric', 'Completed, 0 errors'),
    ('completed_errors', 'Completed, 2 errors'),
    ('cancelled', 'Cancelled'),
    ('failed', 'Failed'),
])
def test_parity_last_check(ext, mock, variant, result):
    """AC-42; 'completed' is the captured real response (errors null)"""
    mock.set_parity(variant)
    page = open_dashboard(ext, mock)
    [[label, value]] = parity_rows(page)
    assert label == 'Last check'
    assert re.fullmatch(RELATIVE_OR_DATE + ' - ' + re.escape(result), value), value


def test_parity_never_run(ext, mock):
    """AC-42"""
    mock.set_parity('never_run')
    page = open_dashboard(ext, mock)
    assert parity_rows(page) == [['No parity check run yet', None]]


@pytest.mark.parametrize('setup', ['null', 'http400'])
def test_parity_unavailable(ext, mock, setup):
    """AC-43: the row is hidden and the rest of the Array card renders"""
    if setup == 'null':
        mock.set_parity('null')
    else:
        mock.fail('ParityStatus', 'http400', 'parityCheckStatus')
    page = open_dashboard(ext, mock)
    assert parity_rows(page) == []
    assert [row[0] for row in page.detail_rows('#cardArray')] == ['Capacity', 'Disks', 'Parity']
    assert len(page.chips()) == 11


def test_parity_array_stopped(ext, mock):
    """AC-44"""
    mock.set_parity('running')
    mock.set_array_state('STOPPED')
    page = open_dashboard(ext, mock)
    assert parity_rows(page) == []


def test_disk_chip_colors(ext, mock):
    """AC-47, AC-48 with the real thresholds (hot 45, max 55)"""
    mock.set_disk('disk1', temp=46)
    mock.set_disk('disk3', temp=56)
    mock.set_disk('parity2', temp=55, numErrors=2)
    mock.set_disk('cache', temp=56)
    page = open_dashboard(ext, mock)

    assert chip(page, 'parity') == {'name': 'parity', 'dot': 'running', 'temp': '30°C', 'tempClass': None,
                                    'tooltip': '30°C (warn 45°, crit 55°)'}
    assert chip(page, 'disk1')['dot'] == 'warning' and chip(page, 'disk1')['tempClass'] == 'warning'
    assert chip(page, 'disk1')['tooltip'] == '46°C (warn 45°, crit 55°)'
    assert chip(page, 'disk3')['dot'] == 'error' and chip(page, 'disk3')['tempClass'] == 'error'
    assert chip(page, 'parity2')['dot'] == 'error'
    assert chip(page, 'disk2') == {'name': 'disk2', 'dot': 'standby', 'temp': None, 'tempClass': None,
                                   'tooltip': 'Standby'}
    for name in ('cache', 'cache2'):
        ssd = chip(page, name)
        assert ssd['dot'] == 'running' and ssd['tempClass'] is None, ssd
        assert ssd['tooltip'] == ssd['temp'], ssd


@pytest.mark.parametrize('setup', ['no_max', 'missing', 'http400'])
def test_disk_chip_threshold_fallbacks(ext, mock, setup):
    """AC-47: a null max disables only the red level; missing or failing thresholds disable temperature colors"""
    mock.set_disk('disk1', temp=46)
    mock.set_disk('disk3', temp=56)
    if setup == 'no_max':
        mock.set_display({'hot': 45, 'max': None})
    elif setup == 'missing':
        mock.set_display(None)
    else:
        mock.fail('DiskTempThresholds', 'http400', 'display')
    page = open_dashboard(ext, mock)

    if setup == 'no_max':
        assert chip(page, 'disk3')['dot'] == 'warning' and chip(page, 'disk3')['tempClass'] == 'warning'
        assert chip(page, 'disk3')['tooltip'] == '56°C (warn 45°)'
    else:
        for name in ('disk1', 'disk3'):
            assert chip(page, name)['dot'] == 'running' and chip(page, name)['tempClass'] is None
            assert chip(page, name)['tooltip'] == chip(page, name)['temp']
