"""VM restart through the background coordinator (AC-37, AC-70 to AC-72)."""

import time

import pytest

from browsers import vm_row, wait_until
from helpers import open_dashboard, stored, wait_ops, watch

MINUTE_MS = 60000


def restart(page, vm_id, wait_pending=True):
    """More > Restart; a stop that fails at once can end the pending state before it can be sampled"""
    page.open_menu(vm_row(vm_id))
    page.click_menu_item('Restart')
    if wait_pending:
        page.wait_row(vm_row(vm_id), lambda s: s['status'] == 'Restarting...', 5, 'Restarting...')


def record(vm, phase, minutes_ago):
    started = int(time.time() * 1000) - minutes_ago * MINUTE_MS
    return {f'server-a::{vm["id"]}': {'serverId': 'server-a', 'vmId': vm['id'], 'name': vm['name'], 'phase': phase,
                                      'phaseStartedAt': started, 'outcome': None}}


def test_restart_stops_then_starts(ext, mock):
    """AC-37, AC-70, AC-62: Restarting... through SHUTDOWN and SHUTOFF, one vm.start, no note, narrow checks only"""
    mock.configure(vm_shutdown_polls=2)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    mark = mock.mark()
    restart(page, vm['id'])

    states = watch(page, vm_row(vm['id']), lambda s: s['status'] is None, timeout=40)
    assert all(s['status'] == 'Restarting...' and s['toggle']['disabled'] for s in states[:-1])
    final = states[-1]
    assert final['note'] is None and final['dot'] == 'running' and final['toggle']['title'] == 'Stop'

    ops = mock.ops(mark)
    assert set(ops) == {'VMStop', 'VMStatus', 'VMStart'}, ops
    assert ops.count('VMStop') == 1 and ops.count('VMStart') == 1
    assert ops.index('VMStop') < ops.index('VMStart')
    assert ops[:ops.index('VMStart')].count('VMStatus') == 3
    wait_until(lambda: stored(ext, 'pendingRestarts') == {}, 10, message='record removed')
    assert not page.dialog_seen()


def test_restart_resumes_after_reopen(ext, mock):
    """AC-71: closing the popup does not stop the restart; reopening shows Restarting... and follows it"""
    mock.configure(vm_shutdown_polls=1)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    restart(page, vm['id'])
    wait_ops(mock, 0, 'VMStop')
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert reopened.vm(vm['id'])['status'] == 'Restarting...'
    state = reopened.wait_row(vm_row(vm['id']), lambda s: s['status'] is None, 30, 'restart finished')
    assert state['note'] is None and state['toggle']['title'] == 'Stop'
    assert mock.ops().count('VMStart') == 1


def test_restart_finished_by_the_background(ext, mock):
    """AC-71: with the popup closed the alarm sends vm.start, ends the restart and stops itself"""
    mock.configure(vm_shutdown_polls=0)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    restart(page, vm['id'])
    wait_ops(mock, 0, 'VMStop')
    page.close()
    assert ext.probe('alarm', 'vmRestart')['periodInMinutes'] == 1
    key = f'server-a::{vm["id"]}'

    ext.probe('fireAlarm', 'vmRestart')
    wait_until(lambda: mock.ops().count('VMStart') == 1, 15, message='vm.start from the alarm')
    wait_until(lambda: (stored(ext, 'pendingRestarts') or {}).get(key, {}).get('phase') == 'starting', 10,
               message='starting record')

    ext.probe('fireAlarm', 'vmRestart')
    wait_until(lambda: stored(ext, 'pendingRestarts') == {}, 15, message='record removed')
    wait_until(lambda: ext.probe('alarm', 'vmRestart') is None, 10, message='alarm stopped')
    assert mock.ops().count('VMStart') == 1 and mock.vm('vm-2')['state'] == 'RUNNING'

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    time.sleep(4)
    state = reopened.vm(vm['id'])
    assert state['status'] is None and state['note'] is None


@pytest.mark.parametrize('phase, vm_state, note, starts', [
    ('stopping', 'RUNNING', 'Could not restart vm-2: the VM did not shut down', 0),
    ('stopping', 'SHUTOFF', None, 1),
    ('starting', 'SHUTOFF', 'Status unknown, refresh to check', 0),
])
def test_restart_time_limit(ext, mock, phase, vm_state, note, starts):
    """AC-72 with a record stored 6 minutes ago: the current state is checked before the 5-minute limit"""
    mock.set_vm('vm-2', state=vm_state)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock, extra={'pendingRestarts': record(vm, phase, 6)})
    assert page.vm(vm['id'])['status'] == 'Restarting...'

    state = page.wait_row(vm_row(vm['id']), lambda s: s['status'] is None, 20, 'restart ended')
    assert state['note'] == note
    assert mock.ops().count('VMStart') == starts
    wait_until(lambda: stored(ext, 'pendingRestarts') == {}, 10, message='record removed after it was shown')


@pytest.mark.parametrize('step, setup, message', [
    ('stop', ('VMStop', 'Requested operation is not valid: domain is not running'),
     'Requested operation is not valid: domain is not running'),
    ('start', ('VMStart', 'internal error: process exited while connecting to monitor'),
     'internal error: process exited while connecting to monitor'),
    ('stop', None, 'The server did not accept the command.'),
])
def test_restart_errors(ext, mock, step, setup, message):
    """AC-72: a GraphQL error or a false answer from stop or start ends the restart with the reason"""
    mock.configure(vm_shutdown_polls=0)
    if setup:
        mock.fail(setup[0], 'gql', setup[1])
    else:
        mock.configure(vm_result=False)
    vm = mock.vm('vm-2')
    page = open_dashboard(ext, mock)
    restart(page, vm['id'], wait_pending=step == 'start')

    state = page.wait_row(vm_row(vm['id']), lambda s: s['status'] is None and s['note'], 20, 'restart ended')
    assert state['note'] == f'Could not restart vm-2: {message}'
    assert state['noteType'] == 'error' and state['toggle']['disabled'] is False
    assert mock.ops().count('VMStart') == (1 if step == 'start' else 0)
    wait_until(lambda: stored(ext, 'pendingRestarts') == {}, 10, message='record removed after it was shown')
