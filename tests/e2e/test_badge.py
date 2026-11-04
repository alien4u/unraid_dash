"""MJ-001: toolbar badge after restart and after popup changes (AC-07, AC-08, AC-63)."""

import pytest

from browsers import ChromiumExtension, wait_until
from build import build_extension
from flows import add_server
from helpers import open_dashboard, seed, server_entry
from mock_server import ADMIN_KEY


def wait_badge(ext, expected, timeout=10):
    return wait_until(lambda: ext.badge() == expected, timeout, 0.25, f'badge {expected!r} (now {ext.badge()!r})')


def test_badge_after_browser_restart(browser_name, mock):
    """AC-07: quit and relaunch; the badge shows the unread total within 60 s without opening the popup"""
    if browser_name == 'firefox':
        pytest.skip('manual: temporary add-ons are removed when Firefox quits and release Firefox cannot '
                    'install the unsigned test build permanently')
    for importance in ('WARNING', 'ALERT', 'INFO'):
        mock.add_notification(importance)
    own = ChromiumExtension(build_extension('chromium', ['http://127.0.0.1/*'], 'chromium-restart-ext')).start()
    try:
        seed(own, [server_entry('server-a', mock.url)])
        assert own.badge() == ''
        own.restart()
        wait_badge(own, '3', timeout=60)
    finally:
        own.stop()


def test_badge_after_save_and_interval_change(ext, mock):
    """AC-08, AC-63: saving a server and changing the refresh interval refresh the badge; Off hides it"""
    mock.add_notification('WARNING')
    mock.add_notification('ALERT')
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    wait_badge(ext, '2')

    mock.add_notification('INFO')
    page.select('#refreshInterval', '30000')
    wait_badge(ext, '3')

    page.select('#refreshInterval', '0')
    wait_badge(ext, '')


def test_badge_after_archive(ext, mock):
    """AC-63: archiving one notification and archive all"""
    first = mock.add_notification('WARNING', title='First')
    mock.add_notification('WARNING', title='Second')
    mock.add_notification('ALERT', title='Third')
    page = open_dashboard(ext, mock)
    ext.probe('send', {'action': 'refreshBadge'})
    wait_badge(ext, '3')

    page.click('#cardNotifications .ut-notif-summary')
    page.wait(lambda: page.exists(f'[data-action="archiveNotification"][data-id="{first["id"]}"]'), 10,
              'notification list')
    page.click(f'[data-action="archiveNotification"][data-id="{first["id"]}"]')
    wait_badge(ext, '2')

    page.click('#cardNotifications [data-action="archiveAll"]')
    wait_badge(ext, '')


def test_badge_after_delete_server(ext, mock, mock_b):
    """AC-63: deleting a server recounts; deleting the last one clears the badge"""
    mock.add_notification('WARNING')
    mock_b.add_notification('ALERT')
    mock_b.add_notification('ALERT')
    seed(ext, [server_entry('server-a', mock.url, name='Tower A'), server_entry('server-b', mock_b.url, name='Tower B')])
    ext.probe('send', {'action': 'refreshBadge'})
    wait_badge(ext, '3')

    page = ext.open_popup()
    page.click('#settingsBtn')
    page.click('#serverList .ut-server-item:nth-child(2) .delete')
    wait_badge(ext, '1')

    page.click('#serverList .ut-server-item:nth-child(1) .delete')
    wait_badge(ext, '')
    assert page.dialog_seen()
