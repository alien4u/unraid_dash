"""MJ-003: late responses, actions and status checks never cross servers or overtake newer data."""

import time

import pytest

from browsers import docker_row, vm_row
from helpers import seed, server_entry, wait_ops


def two_servers(ext, mock, mock_b):
    mock.patch('Core', 'vars.name', 'TowerA')
    mock_b.patch('Core', 'vars.name', 'TowerB')
    seed(ext, [server_entry('server-a', mock.url, name='Tower A'), server_entry('server-b', mock_b.url, name='Tower B')])


def server_name(page):
    return (page.text('#cardSystem .ut-server-link') or '').strip()


@pytest.mark.parametrize('outcome', ['answers', 'fails'])
def test_slow_server_does_not_overwrite_other(ext, mock, mock_b, outcome):
    """AC-12, AC-13"""
    two_servers(ext, mock, mock_b)
    mock.delay('Core', 5)
    if outcome == 'fails':
        mock.fail('Core', 'http502')
    page = ext.open_popup()
    wait_ops(mock, 0, 'Core')
    page.click('#serverTabs .ut-tab[data-server-id="server-b"]')
    page.wait(lambda: server_name(page) == 'TowerB', 15, 'server B dashboard')

    time.sleep(6)
    view = page.view()
    assert server_name(page) == 'TowerB'
    assert view['dashboard'] and view['strip'] is None and view['message'] is None
    assert [tab['id'] for tab in view['tabs'] if tab['active']] == ['server-b']

    container_b = mock_b.container('app-01')
    page.click(docker_row('app-01') + ' [data-action="itemControl"]')
    wait_ops(mock_b, 0, 'DockerStop')
    assert mock_b.requests()[mock_b.ops().index('DockerStop')]['variables'] == {'id': container_b['id']}
    assert 'DockerStop' not in mock.ops()
    page.wait_row(docker_row('app-01'), lambda state: state['toggle']['command'] == 'start', 15, 'B stopped')
    assert mock.container('app-01')['state'] == 'RUNNING'


def test_overlapping_refreshes_keep_newest(ext, mock):
    """AC-60: dashboard and notification list"""
    mock.patch('Core', 'vars.name', 'Old')
    notification = mock.add_notification('WARNING', title='Old title')
    seed(ext, [server_entry('server-a', mock.url)])
    page = ext.open_popup()
    page.wait(lambda: server_name(page) == 'Old', 15, 'first load')

    mock.patch('Core', 'vars.name', 'Older')
    mock.delay('Core', 5)
    page.click('#refreshBtn')
    wait_ops(mock, 0, 'Core', 2)
    mock.patch('Core', 'vars.name', 'Newest')
    page.click('#refreshBtn')
    page.wait(lambda: server_name(page) == 'Newest', 10, 'newer refresh rendered')
    time.sleep(6)
    assert server_name(page) == 'Newest'

    mock.delay('NotificationList', 5)
    page.click('#cardNotifications .ut-notif-summary')
    wait_ops(mock, 0, 'NotificationList')
    page.click('#cardNotifications .ut-notif-summary')
    mock.update_notification(notification['id'], title='New title')
    page.click('#cardNotifications .ut-notif-summary')
    page.wait(lambda: page.texts('.ut-notif-item-title') == ['New title'], 10, 'newer list rendered')
    time.sleep(6)
    assert page.texts('.ut-notif-item-title') == ['New title']


def test_action_then_switch(ext, mock, mock_b):
    """AC-61: an action on A leaves no trace on B; A's checks pause while B is shown and stop with the popup"""
    two_servers(ext, mock, mock_b)
    page = ext.open_popup()
    page.wait(lambda: server_name(page) == 'TowerA', 15, 'server A dashboard')
    mock.delay('DockerStop', 4)
    page.click(docker_row('app-01') + ' [data-action="itemControl"]')
    page.wait_row(docker_row('app-01'), lambda state: state['status'] == 'Stopping...', 5, 'A pending')

    page.click('#serverTabs .ut-tab[data-server-id="server-b"]')
    page.wait(lambda: server_name(page) == 'TowerB', 15, 'server B dashboard')
    mark_a = mock.mark()
    for _ in range(14):
        state = page.docker('app-01')
        assert state['status'] is None and state['note'] is None, state
        assert state['toggle'] == {'command': 'stop', 'title': 'Stop', 'disabled': False, 'icon': '#ico-stop',
                                   'spinner': False}
        time.sleep(0.5)
    assert 'DockerStatus' not in mock.ops(mark_a)

    page.click('#serverTabs .ut-tab[data-server-id="server-a"]')
    page.wait(lambda: server_name(page) == 'TowerA', 15, 'server A again')
    state = page.wait_row(docker_row('app-01'), lambda s: s['status'] is None and s['toggle']['command'] == 'start',
                          15, 'A row shows the observed stop')
    assert state['note'] is None and state['dot'] == 'stopped'

    mock.configure(vm_shutdown_polls=None)
    vm = mock.vm('vm-2')
    page.click(vm_row(vm['id']) + ' [data-action="itemControl"]')
    wait_ops(mock, mark_a, 'VMStatus', 2)
    page.close()
    time.sleep(1)
    mark_closed = mock.mark()
    time.sleep(7)
    assert 'VMStatus' not in mock.ops(mark_closed)


def test_notifications_switch(ext, mock, mock_b):
    """AC-14"""
    note_a = mock.add_notification('WARNING', title='A note')
    note_b = mock_b.add_notification('WARNING', title='B note')
    two_servers(ext, mock, mock_b)
    page = ext.open_popup()
    page.wait(lambda: server_name(page) == 'TowerA', 15, 'server A dashboard')
    mock.delay('NotificationList', 4)
    page.click('#cardNotifications .ut-notif-summary')
    wait_ops(mock, 0, 'NotificationList')

    page.click('#serverTabs .ut-tab[data-server-id="server-b"]')
    page.wait(lambda: server_name(page) == 'TowerB', 15, 'server B dashboard')
    page.click('#cardNotifications .ut-notif-summary')
    page.wait(lambda: page.texts('.ut-notif-item-title') == ['B note'], 10, "B's list")
    time.sleep(5)
    assert page.texts('.ut-notif-item-title') == ['B note']

    page.click(f'[data-action="archiveNotification"][data-id="{note_b["id"]}"]')
    wait_ops(mock_b, 0, 'ArchiveNotification')
    assert mock_b.requests()[mock_b.ops().index('ArchiveNotification')]['variables'] == {'id': note_b['id']}
    assert 'ArchiveNotification' not in mock.ops()
    assert note_a['id'] in [n['id'] for n in mock.unread]
