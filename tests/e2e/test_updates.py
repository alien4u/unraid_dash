"""F2: update one container and Update all (AC-24 to AC-32, AC-58, AC-59, AC-62)."""

import time

import pytest

from browsers import docker_row
from helpers import open_dashboard, stored, wait_ops
from mock_server import VIEWER_KEY

UPDATE_ALL = '#cardDocker .ut-card-header-right button.ut-btn-sm'


def update_button(name):
    return docker_row(name) + ' [data-action="updateDocker"]'


def header_buttons(page):
    return page.eval('''() => [...document.querySelectorAll('#cardDocker .ut-card-header-right button.ut-btn-sm')]
        .map((pB) => ({text: pB.textContent, disabled: pB.disabled}))''')


def confirm_box(page):
    return page.eval('''() => {
        const oBox = document.querySelector('#cardDocker .ut-confirm');
        return oBox && {text: oBox.querySelector('.ut-confirm-text').textContent,
                        buttons: [...oBox.querySelectorAll('button')].map((pB) => pB.textContent)};
    }''')


@pytest.mark.parametrize('version, key, expected', [
    ('4.37.9+bedd403a', None, ['app-01', 'app-02']),
    ('4.30.0', None, ['app-01', 'app-02']),
    ('4.29.2', None, []),
    ('4.37.9+bedd403a', VIEWER_KEY, []),
])
def test_update_button_visibility(ext, mock, version, key, expected):
    """AC-24"""
    mock.set_api_version(version)
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.set_container('app-02', updateStatus='REBUILD_READY')
    mock.set_container('app-03', updateStatus='UNKNOWN')
    page = open_dashboard(ext, mock, **({'key': key} if key else {}))
    with_button = page.eval('''() => [...document.querySelectorAll('#cardDocker [data-action="updateDocker"]')]
        .map((pB) => pB.dataset.name)''')
    assert sorted(with_button) == expected
    for name in expected:
        assert page.docker(name)['update']['title'] == 'Update'


def test_update_one_container(ext, mock):
    """AC-25, AC-26, AC-62"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.configure(update_seconds=3)
    page = open_dashboard(ext, mock)
    selector = docker_row('app-01')

    mark = mock.mark()
    page.click(update_button('app-01'))
    state = page.wait_row(selector, lambda s: s['status'] == 'Updating...', 5, 'updating state')
    assert state['update']['disabled'] and state['update']['spinner']
    assert state['toggle']['disabled'] and state['more']['disabled']
    assert not page.dialog_seen()
    assert stored(ext, 'pendingUpdates')['server-a']['items']['app-01']['id'] == mock.container('app-01')['id']

    page.click('#cardSystem .ut-card-header')
    page.wait(lambda: page.eval("() => document.getElementById('cardSystem').classList.contains('ut-card--collapsed')"),
              5, 'popup stays usable while pending')
    page.click('#cardSystem .ut-card-header')

    state = page.wait_row(selector, lambda s: s['note'] == 'app-01 updated', 25, 'update success text')
    assert state['noteType'] == 'success' and state['status'] is None and not state['updateBadge']
    assert state['update'] is None
    wait_ops(mock, mark, 'Core')
    ops = mock.ops(mark)
    assert set(ops[:ops.index('Me')]) == {'DockerUpdate', 'DockerUpdateStatus'}, ops
    assert stored(ext, 'pendingUpdates') in (None, {})
    page.wait_row(selector, lambda s: s['note'] is None, 10, 'success text gone after 5 s')


@pytest.mark.parametrize('message', [
    'manifest unknown: manifest unknown',
    "pull access denied for example/app-01, repository does not exist or may require 'docker login': "
    'denied: requested access to the resource is denied',
])
def test_update_failure(ext, mock, message):
    """AC-27: the server's message is shown (the second one is Docker's text for a removed or private image)"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.fail('DockerUpdate', 'gql', message)
    page = open_dashboard(ext, mock)
    page.click(update_button('app-01'))
    state = page.wait_row(docker_row('app-01'), lambda s: s['note'], 25, 'failure text')
    assert state['note'] == f'Update failed for app-01: {message}'
    assert state['noteType'] == 'error' and state['status'] is None
    assert state['update'] == {'disabled': False, 'title': 'Update', 'spinner': False}


def test_update_survives_popup_reopen(ext, mock):
    """AC-28: the remembered update resumes on reopen and no second update starts"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.configure(update_seconds=8)
    page = open_dashboard(ext, mock)
    page.click(update_button('app-01'))
    page.wait_row(docker_row('app-01'), lambda s: s['status'] == 'Updating...', 5, 'updating state')
    wait_ops(mock, 0, 'DockerUpdate')
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    state = reopened.docker('app-01')
    assert state['status'] == 'Updating...' and state['update']['disabled']
    state = reopened.wait_row(docker_row('app-01'), lambda s: s['note'] == 'app-01 updated', 30, 'update finished')
    assert mock.ops().count('DockerUpdate') == 1


def test_update_cap(ext, mock):
    """AC-29: a pending update older than 10 minutes that still has an update is released as unknown"""
    container = mock.container('app-01')
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    started = int(time.time() * 1000) - 11 * 60 * 1000
    record = {'bulk': False, 'startedAt': started, 'items': {'app-01': {'id': container['id'], 'startState': 'RUNNING'}},
              'total': 1, 'done': 0, 'failed': 0, 'unknown': 0}
    page = open_dashboard(ext, mock, extra={'pendingUpdates': {'server-a': record}})
    assert page.docker('app-01')['status'] == 'Updating...'
    state = page.wait_row(docker_row('app-01'), lambda s: s['note'], 25, 'cap text')
    assert state['note'] == 'Update status unknown. Refresh to check.'
    assert state['status'] is None and state['update']['disabled'] is False
    assert 'DockerUpdate' not in mock.ops()


def test_update_unsupported(ext, mock):
    """AC-58: HTTP 400 on the update mutation removes the Update controls for the session, no row error"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.set_container('app-02', updateStatus='UPDATE_AVAILABLE')
    mock.fail('DockerUpdate', 'http400', 'updateContainers')
    page = open_dashboard(ext, mock)
    assert header_buttons(page) == [{'text': 'Update all (2)', 'disabled': False}]
    page.click(update_button('app-01'))
    page.wait(lambda: not page.exists('#cardDocker [data-action="updateDocker"]'), 15, 'Update buttons removed')
    assert header_buttons(page) == []
    assert page.docker('app-01')['note'] is None and page.docker('app-01')['status'] is None
    assert page.view()['strip'] is None and page.view()['dashboard']
    page.click('#refreshBtn')
    wait_ops(mock, 0, 'Core', 2)
    time.sleep(1)
    assert not page.exists('#cardDocker [data-action="updateDocker"]')


def test_update_no_response(ext, mock):
    """AC-59: no answer to the mutation is not a failure; status checks decide"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.fail('DockerUpdate', 'hang')
    page = open_dashboard(ext, mock)
    page.click(update_button('app-01'))
    page.wait_row(docker_row('app-01'), lambda s: s['status'] == 'Updating...', 5, 'updating state')
    mock.set_container('app-01', updateStatus='UP_TO_DATE')
    page.wait_row(docker_row('app-01'), lambda s: s['note'] == 'app-01 updated', 25, 'update observed by checks')

    mock.set_container('app-02', updateStatus='UPDATE_AVAILABLE')
    page.click('#refreshBtn')
    page.wait(lambda: page.exists(update_button('app-02')), 10, 'second update button')
    page.click(update_button('app-02'))
    page.wait_row(docker_row('app-02'), lambda s: s['status'] == 'Updating...', 5, 'updating state')
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = page.docker('app-02')
        assert not (state['note'] or '').startswith('Update failed'), state
        assert state['status'] == 'Updating...', state
        time.sleep(0.5)


def test_update_all_confirm_cancel(ext, mock):
    """AC-30"""
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.set_container('app-02', updateStatus='REBUILD_READY')
    page = open_dashboard(ext, mock)
    assert header_buttons(page) == [{'text': 'Update all (2)', 'disabled': False}]

    page.click(UPDATE_ALL)
    assert not page.dialog_seen()
    assert confirm_box(page) == {'text': 'Update 2 containers? They will restart.', 'buttons': ['Update', 'Cancel']}
    page.click('#cardDocker .ut-confirm .ut-btn-ghost')
    assert confirm_box(page) is None
    assert header_buttons(page) == [{'text': 'Update all (2)', 'disabled': False}]
    assert 'DockerUpdate' not in mock.ops()


def test_update_all(ext, mock):
    """AC-31, AC-32"""
    for name in ('app-01', 'app-02', 'app-04'):
        mock.set_container(name, updateStatus='UPDATE_AVAILABLE')
    mock.configure(update_seconds=4)
    page = open_dashboard(ext, mock)
    page.click(UPDATE_ALL)
    page.click('#cardDocker .ut-confirm .ut-btn-primary')

    page.wait(lambda: header_buttons(page) == [{'text': 'Updating 3...', 'disabled': True}], 5, 'Updating 3...')
    for name in ('app-01', 'app-02', 'app-04'):
        state = page.docker(name)
        assert state['status'] == 'Updating...' and state['update']['disabled'], (name, state)
    request = mock.requests()[mock.ops().index('DockerUpdate')]
    assert sorted(request['variables']['ids']) == sorted(mock.container(n)['id'] for n in ('app-01', 'app-02', 'app-04'))

    mock.set_container('app-05', updateStatus='UPDATE_AVAILABLE')
    page.click('#refreshBtn')
    page.wait(lambda: page.exists(update_button('app-05')), 10, 'new update button while pending')
    assert page.docker('app-05')['update']['disabled'] is True
    assert [b['text'] for b in header_buttons(page)] == ['Updating 3...']

    badges = '''() => [...document.querySelectorAll('#cardDocker .ut-card-header-right .ut-card-badge')]
        .map((pB) => pB.textContent).find((pT) => pT.startsWith('Updated'))'''
    summary = page.wait(lambda: page.eval(badges), 30, 'summary')
    assert summary == 'Updated 3 of 3'
    assert mock.ops().count('DockerUpdate') == 1
    time.sleep(9)
    assert header_buttons(page) == [{'text': 'Update all (1)', 'disabled': False}]
