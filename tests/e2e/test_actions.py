"""MJ-004, MN-005, F3: row actions, pending states, More menu and narrow status checks."""

import time

import pytest

from browsers import docker_row, vm_row
from helpers import open_dashboard, wait_ops, watch
from mock_server import VIEWER_KEY

NARROW_DOCKER = {'DockerStatus'}
FULL_DASHBOARD = {'Core', 'Array', 'Network', 'Docker', 'DockerBasic', 'VMs', 'ParityStatus', 'DiskTempThresholds',
                  'DockerUpdates', 'DockerWebUi', 'Temperature', 'Me', 'ApiVersion'}


def toggle(selector):
    return selector + ' [data-action="itemControl"]'


@pytest.mark.parametrize('mode, message', [
    ('gql', 'port is already allocated'),
    ('gql_partial', 'port is already allocated'),
    ('gql', "error while creating mount source path '/mnt/user/appdata/app-09': "
            'mkdir /mnt/user/appdata/app-09: permission denied'),
])
def test_action_error_inline(ext, mock, mode, message):
    """AC-15: container start and VM start failures show the server message on the row
    (the third message is Docker's text for an appdata path the daemon cannot create)"""
    mock.set_container('app-09', state='EXITED')
    mock.fail('DockerStart', mode, message)
    mock.fail('VMStart', mode, 'Requested operation is not valid: domain is already running')
    page = open_dashboard(ext, mock)

    page.click(toggle(docker_row('app-09')))
    state = page.wait_row(docker_row('app-09'), lambda s: s['note'], 10, 'container error note')
    assert state['note'] == f'Could not start app-09: {message}'
    assert state['noteType'] == 'error'
    assert state['toggle']['disabled'] is False and state['toggle']['title'] == 'Start'
    time.sleep(6)
    assert page.docker('app-09')['note'] == f'Could not start app-09: {message}'

    vm = mock.vm('vm-1')
    page.click(toggle(vm_row(vm['id'])))
    state = page.wait_row(vm_row(vm['id']), lambda s: s['note'], 10, 'VM error note')
    assert state['note'] == 'Could not start vm-1: Requested operation is not valid: domain is already running'
    assert state['toggle']['disabled'] is False and state['toggle']['title'] == 'Start'


@pytest.mark.parametrize('action, mode, message, view_only', [
    ('start', 'forbidden', None, True),
    ('start', 'forbidden_partial', None, True),
    ('start', 'gql', 'error response from daemon: open /mnt/user/appdata/app-09: permission denied', False),
    ('restart', 'forbidden', None, True),
])
def test_permission_text_only_for_forbidden(ext, mock, action, mode, message, view_only):
    """AC-69: the permission text and the switch to view-only controls come only from extensions.code FORBIDDEN,
    for container actions and for a VM restart (vm.stop answered FORBIDDEN)"""
    expected = message or 'This API key does not have permission. Use an admin API key for full control.'
    if action == 'start':
        mock.fail('DockerStart', mode, message)
        page = open_dashboard(ext, mock)
        page.click(toggle(docker_row('app-09')))
        state = page.wait_row(docker_row('app-09'), lambda s: s['note'], 10, 'error note')
        assert state['note'] == f'Could not start app-09: {expected}'
    else:
        mock.fail('VMStop', mode, message)
        vm = mock.vm('vm-2')
        page = open_dashboard(ext, mock)
        page.open_menu(vm_row(vm['id']))
        page.click_menu_item('Restart')
        state = page.wait_row(vm_row(vm['id']), lambda s: s['note'], 10, 'error note')
        assert state['note'] == f'Could not restart vm-2: {expected}'
        assert 'VMStart' not in mock.ops()

    time.sleep(10)
    toggle_state = page.docker('app-01')['toggle']
    if view_only:
        assert toggle_state['disabled'] and toggle_state['title'] == 'View-only API key'
    else:
        assert not toggle_state['disabled'] and toggle_state['title'] == 'Stop'


def test_container_stop_start_narrow_checks(ext, mock):
    """AC-16, AC-62, AC-34: target states reached, no confirmation, only narrow status queries while pending"""
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')

    mark = mock.mark()
    page.click(toggle(selector))
    states = watch(page, selector, lambda s: s['status'] is None and s['toggle']['command'] == 'start')
    assert any(s['status'] == 'Stopping...' and s['toggle']['disabled'] and s['toggle']['spinner'] for s in states)
    final = states[-1]
    assert final['dot'] == 'stopped' and final['note'] is None and final['toggle']['title'] == 'Start'
    ops = set(mock.ops(mark))
    assert ops == {'DockerStop'} | NARROW_DOCKER, ops
    assert mock.container('app-01')['state'] == 'EXITED'

    mark = mock.mark()
    page.click(toggle(selector))
    states = watch(page, selector, lambda s: s['status'] is None and s['toggle']['command'] == 'stop')
    assert states[-1]['dot'] == 'running' and states[-1]['note'] is None
    assert set(mock.ops(mark)) == {'DockerStart'} | NARROW_DOCKER
    assert not page.dialog_seen()


def test_vm_stop_pending_until_shutoff(ext, mock):
    """AC-19, AC-62: SHUTDOWN keeps the row pending; SHUTOFF ends it"""
    mock.configure(vm_shutdown_polls=2)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    selector = vm_row(vm['id'])

    mark = mock.mark()
    page.click(toggle(selector))
    states = watch(page, selector, lambda s: s['status'] is None, timeout=30)
    pending = states[:-1]
    assert pending and all(s['status'] == 'Stopping...' and s['toggle']['disabled'] for s in pending), pending
    assert mock.ops(mark).count('VMStatus') >= 3
    assert states[-1]['toggle']['title'] == 'Start' and states[-1]['dot'] == 'stopped'
    assert set(mock.ops(mark)) == {'VMStop', 'VMStatus'}


@pytest.mark.slow
def test_poll_cap_status_unknown(ext, mock):
    """AC-19 cap: a VM that never reaches SHUTOFF is released after the 20 x 3 s checks"""
    mock.configure(vm_shutdown_polls=None)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    selector = vm_row(vm['id'])
    page.click(toggle(selector))
    page.wait_row(selector, lambda s: s['status'] == 'Stopping...', 5, 'pending')
    state = page.wait_row(selector, lambda s: s['status'] is None, 75, 'release at the cap')
    assert state['note'] == 'Status unknown, refresh to check'
    assert state['toggle']['disabled'] is False


def test_paused_vm_resume(ext, mock):
    """AC-18, AC-70 (no Restart for a paused VM)"""
    mock.set_vm('vm-2', state='PAUSED')
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    selector = vm_row(vm['id'])
    state = page.vm(vm['id'])
    assert state['toggle']['title'] == 'Resume' and state['toggle']['icon'] == '#ico-resume'
    assert state['toggle']['command'] == 'resume'
    assert state['more'] is None

    page.click(toggle(selector))
    state = page.wait_row(selector, lambda s: s['status'] is None and s['toggle']['command'] == 'stop', 15, 'running')
    assert 'VMResume' in mock.ops() and 'VMStart' not in mock.ops()
    assert state['dot'] == 'running'


def test_container_pause_resume(ext, mock):
    """AC-20, AC-36: More > Pause reaches PAUSED and the toggle becomes Resume; Resume returns to RUNNING"""
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')
    assert page.open_menu(selector) == ['Restart', 'Pause']
    page.click_menu_item('Pause')
    state = page.wait_row(selector, lambda s: s['status'] is None and s['dot'] == 'paused', 15, 'paused')
    assert state['toggle']['title'] == 'Resume' and state['toggle']['icon'] == '#ico-resume'
    assert state['more']['items'] == 'restart'

    page.click(toggle(selector))
    state = page.wait_row(selector, lambda s: s['status'] is None and s['dot'] == 'running', 15, 'resumed')
    assert state['toggle']['title'] == 'Stop'
    assert mock.ops().count('DockerPause') == 1 and mock.ops().count('DockerUnpause') == 1
    assert 'DockerStart' not in mock.ops()
    assert not page.dialog_seen()


def test_row_layout_and_menu(ext, mock):
    """AC-33, AC-38: control order, More menu contents and closing rules"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    page = open_dashboard(ext, mock)

    running = page.docker('app-01')
    assert running['buttons'] == ['openUrlOverride', 'updateDocker', 'itemMore', 'itemControl']
    assert running['more']['label'] == 'More actions' and running['more']['items'] == 'restart,pause'
    assert page.docker('app-02')['buttons'] == ['openUrlOverride', 'itemMore', 'itemControl']

    assert page.docker('app-09')['buttons'] == ['openUrlOverride', 'itemControl']
    stopped_vm = mock.vm('vm-1')
    assert page.vm(stopped_vm['id'])['buttons'] == ['openVmSettings', 'itemControl']
    running_vm = mock.vm('vm-2')
    assert page.vm(running_vm['id'])['more']['items'] == 'restart'

    menu_count = lambda: len(page.texts('.ut-menu'))
    page.open_menu(docker_row('app-01'))
    page.click_at('#footerVersion')
    page.wait(lambda: menu_count() == 0, 5, 'menu closed by outside click')

    page.open_menu(docker_row('app-01'))
    page.open_menu(docker_row('app-02'))
    assert menu_count() == 1

    page.press('Escape')
    page.wait(lambda: menu_count() == 0, 5, 'menu closed by Escape')

    page.open_menu(vm_row(running_vm['id']))
    assert page.texts('.ut-menu .ut-menu-item') == ['Restart']
    page.click_menu_item('Restart')
    page.wait(lambda: menu_count() == 0, 5, 'menu closed by item selection')


def test_container_restart(ext, mock):
    """AC-35: pending until the restart call returns, no polling, then a refresh"""
    mock.configure(restart_seconds=3)
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')
    page.open_menu(selector)
    mark = mock.mark()
    page.click_menu_item('Restart')
    page.wait_row(selector, lambda s: s['status'] == 'Restarting...', 5, 'restart pending')
    wait_ops(mock, mark, 'DockerRestart')
    time.sleep(2)
    assert page.docker('app-01')['status'] == 'Restarting...'
    state = page.wait_row(selector, lambda s: s['status'] is None, 10, 'restart finished')
    assert state['note'] is None and state['toggle']['title'] == 'Stop'
    ops = mock.ops(mark)
    assert 'DockerStatus' not in ops
    wait_ops(mock, mark, 'Core')
    assert not page.dialog_seen()


@pytest.mark.slow
def test_restart_without_response(ext, mock):
    """AC-35, AC-37: no answer keeps the row pending (RUNNING polls do not end it) until the 60 s cap"""
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')
    mock.fail('DockerRestart', 'hang')
    page.open_menu(selector)
    mark = mock.mark()
    page.click_menu_item('Restart')
    page.wait_row(selector, lambda s: s['status'] == 'Restarting...', 5, 'restart pending')
    time.sleep(40)
    assert page.docker('app-01')['status'] == 'Restarting...'
    state = page.wait_row(selector, lambda s: s['status'] is None, 30, 'release at the 60 s cap')
    assert state['note'] == 'Status unknown, refresh to check' and state['toggle']['disabled'] is False
    assert 'DockerStatus' not in mock.ops(mark)


@pytest.mark.parametrize('version, items', [('4.35.0', 'pause'), ('4.29.2', None)])
def test_container_menu_by_version(ext, mock, version, items):
    """AC-35 (no Restart before 4.36), AC-20 (no Pause before 4.30)"""
    mock.set_api_version(version)
    page = open_dashboard(ext, mock)
    state = page.docker('app-01')
    assert (state['more'] or {}).get('items') == items


def test_keyboard_menu(ext, mock):
    """AC-39: Tab reaches More, Enter opens the menu, Escape closes it and returns focus, Enter runs an item"""
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')
    page.eval('(pSel) => document.querySelector(pSel + \' [data-action="openUrlOverride"]\').focus()', selector)
    page.press('Tab')
    assert page.active_element()['action'] == 'itemMore'

    page.press('Enter')
    page.wait(lambda: page.texts('.ut-menu .ut-menu-item'), 5, 'menu open')
    assert page.active_element()['role'] == 'menuitem'
    page.press('Escape')
    page.wait(lambda: not page.texts('.ut-menu'), 5, 'menu closed')
    focused = page.active_element()
    assert focused['action'] == 'itemMore' and focused['key'] == 'app-01'

    page.press('Enter')
    page.wait(lambda: page.texts('.ut-menu .ut-menu-item'), 5, 'menu open again')
    page.press('Tab')
    page.press('Enter')
    page.wait_row(selector, lambda s: s['dot'] == 'paused' and s['status'] is None, 15, 'paused from keyboard')

    page.eval('(pSel) => document.querySelector(pSel + \' [data-action="itemMore"]\').focus()', selector)
    page.press('Tab')
    assert page.active_element()['action'] == 'itemControl'
    page.press('Space')
    page.wait_row(selector, lambda s: s['dot'] == 'running' and s['status'] is None, 15, 'resumed from keyboard')


def test_readonly_key_controls(ext, mock):
    """AC-24 (read-only part), F3 read-only: controls disabled with the view-only title, no Update controls"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    page = open_dashboard(ext, mock, key=VIEWER_KEY)
    state = page.docker('app-01')
    assert state['toggle']['disabled'] and state['toggle']['title'] == 'View-only API key'
    assert state['more']['disabled'] and state['more']['title'] == 'View-only API key'
    assert state['update'] is None
    assert not page.exists('#cardDocker .ut-card-header-right button.ut-btn-sm')
    vm = page.vm(mock.vm('vm-2')['id'])
    assert vm['toggle']['disabled'] and vm['toggle']['title'] == 'View-only API key'
