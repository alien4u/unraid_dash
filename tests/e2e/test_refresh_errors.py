"""MJ-002, MN-001: visible refresh errors and readable error text (AC-09, AC-10, AC-17)."""

import re
import time

import pytest

from helpers import open_dashboard, seed, server_entry

UNREACHABLE_TEXT = 'Server is unreachable. Verify the URL is correct and the server is online, then try Refresh.'
TIMEOUT_TEXT = 'Connection timed out. The server may be busy or offline. Try clicking Refresh.'


def test_stale_strip_on_failed_refresh(ext, mock):
    """AC-09"""
    page = open_dashboard(ext, mock)
    loaded_at = time.strftime('%H:%M')
    mock.set_down(True)
    page.click('#refreshBtn')

    strip = page.wait(lambda: page.view()['strip'], 20, 'stale strip')
    match = re.fullmatch(r'Last refresh failed: (.+)\. Showing data from (\d{2}:\d{2})\.', strip)
    assert match, strip
    assert match.group(1) + '.' == UNREACHABLE_TEXT
    assert match.group(2) in (loaded_at, time.strftime('%H:%M'))
    view = page.view()
    assert view['dashboard'] and view['message'] is None
    assert page.exists('#cardDocker .ut-item-row')

    mock.set_down(False)
    page.click('#refreshBtn')
    page.wait(lambda: page.view()['strip'] is None, 20, 'strip removed after a successful refresh')


def test_first_load_error_full_panel(ext, mock, mock_b):
    """AC-10: no data yet (first load, then after a server switch) shows the full-panel error"""
    mock_b.set_down(True)
    seed(ext, [server_entry('server-b', mock_b.url, name='Tower B'), server_entry('server-a', mock.url, name='Tower A')])
    page = ext.open_popup()
    message = page.wait(lambda: page.view()['message'], 20, 'full-panel error')
    assert message == UNREACHABLE_TEXT
    assert not page.view()['spinner']

    page.click('#serverTabs .ut-tab[data-server-id="server-a"]')
    page.wait_dashboard()
    page.click('#serverTabs .ut-tab[data-server-id="server-b"]')
    message = page.wait(lambda: page.view()['message'], 20, 'full-panel error after switch')
    view = page.view()
    assert message == UNREACHABLE_TEXT
    assert not view['spinner'] and not view['dashboard'] and view['strip'] is None


@pytest.mark.slow
def test_timeout_text(ext, mock):
    """AC-17: a server that accepts the connection but never answers shows the TIMEOUT text"""
    mock.delay('Core', 20, once=False)
    seed(ext, [server_entry('server-a', mock.url)])
    page = ext.open_popup()
    message = page.wait(lambda: page.view()['message'], 40, 'timeout message')
    assert message == TIMEOUT_TEXT
    assert 'UNKNOWN' not in message


@pytest.mark.parametrize('mode, expected', [
    ('http502', 'Server error (502). Try again later.'),
    ('http400', 'The server rejected the request (API version mismatch?).'),
])
def test_http_error_texts(ext, mock, mode, expected):
    """AC-17: raw HTTP_5xx / HTTP_400 codes are replaced by friendly text"""
    mock.fail('Core', mode)
    seed(ext, [server_entry('server-a', mock.url)])
    page = ext.open_popup()
    assert page.wait(lambda: page.view()['message'], 20, 'error message') == expected
