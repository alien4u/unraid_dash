"""Tests against the real Unraid server from the env file (pytest --real).

Read-only tests only query. Disruptive tests act on TEST_CONTAINER and TEST_VM, create labeled test
notifications, and leave the container and VM RUNNING. "Update all" is never run against the real server.
"""

import json
import re
import ssl
import urllib.request
import uuid
from pathlib import Path

import pytest

from browsers import docker_row, vm_row, wait_until
from flows import AUTH_TEXT
from helpers import seed, server_entry

pytestmark = pytest.mark.real

PLAUSIBLE_MAX = 150


class RealApi:
    """Minimal GraphQL client for setup, expectations and cleanup."""

    def __init__(self, env):
        self.url = env['UNRAID_URL'].rstrip('/') + '/graphql'
        self.key = env['UNRAID_ADMIN_KEY']
        ca_file = env.get('UNRAID_CA_FILE')
        self.context = ssl.create_default_context(cafile=str(Path(ca_file).expanduser())) if ca_file else None

    def call(self, query, variables=None):
        body = json.dumps({'query': query, 'variables': variables or {}}).encode()
        request = urllib.request.Request(self.url, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'x-api-key': self.key})
        with urllib.request.urlopen(request, timeout=60, context=self.context) as response:
            payload = json.loads(response.read())
        if payload.get('errors'):
            raise RuntimeError(payload['errors'][0].get('message'))
        return payload['data']

    def containers(self):
        data = self.call('query { docker { containers { id names state } containerUpdateStatuses { name updateStatus } } }')
        statuses = {s['name']: s['updateStatus'] for s in data['docker']['containerUpdateStatuses']}
        return {c['names'][0].lstrip('/'): dict(c, updateStatus=statuses.get(c['names'][0].lstrip('/')))
                for c in data['docker']['containers']}

    def vms(self):
        return {vm['name']: vm for vm in self.call('query { vms { domains { id name state } } }')['vms']['domains']}

    def ensure_running(self, container_name, vm_name):
        """Puts the test container and VM back in RUNNING, whatever a test left behind."""
        if container_name:
            container = self.containers()[container_name]
            if container['state'] != 'RUNNING':
                field = 'unpause' if container['state'] == 'PAUSED' else 'start'
                self.call(f'mutation ($id: PrefixedID!) {{ docker {{ {field}(id: $id) {{ id }} }} }}', {'id': container['id']})
            wait_until(lambda: self.containers()[container_name]['state'] == 'RUNNING', 120, 2, 'test container RUNNING')
        if vm_name:
            vm = self.vms()[vm_name]
            if vm['state'] == 'SHUTDOWN':
                wait_until(lambda: self.vms()[vm_name]['state'] != 'SHUTDOWN', 180, 3, 'test VM to finish shutting down')
                vm = self.vms()[vm_name]
            if vm['state'] != 'RUNNING':
                field = 'resume' if vm['state'] == 'PAUSED' else 'start'
                self.call(f'mutation ($id: PrefixedID!) {{ vm {{ {field}(id: $id) }} }}', {'id': vm['id']})
            wait_until(lambda: self.vms()[vm_name]['state'] == 'RUNNING', 180, 3, 'test VM RUNNING')


@pytest.fixture(scope='session')
def api(real_env):
    return RealApi(real_env)


@pytest.fixture
def real_page(ext, real_env):
    seed(ext, [server_entry('real', real_env['UNRAID_URL'], real_env['UNRAID_ADMIN_KEY'], 'Real')])
    page = ext.open_popup()
    page.wait_dashboard(timeout=40)
    return page


@pytest.fixture
def targets(real_env, api):
    container = real_env.get('TEST_CONTAINER')
    vm = real_env.get('TEST_VM')
    api.ensure_running(container, vm)
    yield {'container': container, 'vm': vm}
    api.ensure_running(container, vm)


def toggle(selector):
    return selector + ' [data-action="itemControl"]'


# Read-only

def test_real_dashboard_loads(real_page, real_env, api):
    view = real_page.view()
    assert view['message'] is None and view['strip'] is None
    assert real_page.text('#cardSystem .ut-card-badge') == 'v' + real_env['UNRAID_VERSION']
    assert sorted(real_page.docker_names()) == sorted(api.containers())


def test_real_temperature_plausible(real_page):
    """AC-45: expected to fail while the API summary mixes fans, voltages and energy into CELSIUS"""
    rows = [value for label, value in real_page.detail_rows('#cardSystem') if label == 'Temp']
    assert rows, 'no Temp row on an API 4.37.6+ server'
    values = [int(v) for v in re.findall(r'(-?\d+)°[CF]', rows[0])]
    assert values and all(value < PLAUSIBLE_MAX for value in values), rows[0]


def test_real_disk_chip_colors(real_page, api):
    """AC-47, AC-48: HDDs by display hot/max, SSD/NVMe never colored by temperature"""
    display = api.call('query { info { display { hot max } } }')['info']['display']
    array = api.call('query { array { parities { name status temp numErrors isSpinning rotational } '
                     'disks { name status temp numErrors isSpinning rotational } '
                     'caches { name status temp numErrors isSpinning rotational } } }')['array']
    chips = {chip['name']: chip for chip in real_page.chips()}
    for disk in array['parities'] + array['disks'] + array['caches']:
        if not disk['status'] or disk['status'] == 'DISK_NP' or disk['numErrors']:
            continue
        chip = chips[disk['name']]
        temp = disk['temp']
        if disk['rotational'] is False or temp is None:
            assert chip['tempClass'] is None, chip
            continue
        if display['max'] is not None and temp >= display['max']:
            assert chip['tempClass'] == 'error', chip
        elif temp >= display['hot']:
            assert chip['tempClass'] == 'warning', chip
        else:
            assert chip['tempClass'] is None, chip
        crit = f', crit {display["max"]}°' if display['max'] is not None else ''
        assert chip['tooltip'] == f'{temp}°C (warn {display["hot"]}°{crit})', chip


def test_real_parity_row(real_page, api):
    """AC-40 to AC-42 for whatever state the server is in"""
    parity = api.call('query { array { state parityCheckStatus { status progress speed } } }')['array']
    rows = {label: value for label, value in real_page.detail_rows('#cardArray')
            if label in ('Parity check', 'Last check', 'No parity check run yet')}
    status = parity['parityCheckStatus']['status']
    print(f'parity {status}: {rows}')
    if parity['state'] != 'STARTED':
        assert rows == {}
    elif status == 'RUNNING':
        assert rows['Parity check'].startswith(f"{parity['parityCheckStatus']['progress']}% - ")
    elif status == 'PAUSED':
        assert rows['Parity check'].startswith(f"paused at {parity['parityCheckStatus']['progress']}%")
    elif status == 'NEVER_RUN':
        assert list(rows) == ['No parity check run yet']
    else:
        assert list(rows) == ['Last check']
        assert rows['Last check'].split(' - ')[-1].startswith({'COMPLETED': 'Completed', 'CANCELLED': 'Cancelled',
                                                               'FAILED': 'Failed'}[status])


def test_real_links_and_update_dots(real_page, api):
    """AC-21, AC-24: links equal the template WebUI; update dots match the server's update statuses"""
    containers = api.call('query { docker { containers { id webUiUrl } } }')['docker']['containers']
    web_ui = {c['id']: c['webUiUrl'] for c in containers}
    for name, container in api.containers().items():
        state = real_page.docker(name)
        if web_ui.get(container['id']):
            assert state['link'] == web_ui[container['id']], name
        assert state['updateBadge'] == (container['updateStatus'] in ('UPDATE_AVAILABLE', 'REBUILD_READY')), name


def test_real_viewer_key_readonly(ext, real_env):
    """AC-24 read-only key: controls disabled, no Update controls"""
    seed(ext, [server_entry('real', real_env['UNRAID_URL'], real_env['UNRAID_VIEWER_KEY'], 'Real')])
    page = ext.open_popup()
    page.wait_dashboard(timeout=40)
    toggles = page.eval('''() => [...document.querySelectorAll('[data-action="itemControl"]')]
        .map((pB) => [pB.disabled, pB.title])''')
    assert toggles and all(item == [True, 'View-only API key'] for item in toggles)
    assert not page.exists('[data-action="updateDocker"]')
    assert not page.exists('#cardDocker .ut-card-header-right button.ut-btn-sm')


def test_real_invalid_key_auth_text(ext, real_env):
    """AC-11 against the real server's invalid-key answer"""
    seed(ext, [server_entry('real', real_env['UNRAID_URL'], '0' * 64, 'Real')])
    page = ext.open_popup()
    assert page.wait(lambda: page.view()['message'], 40, 'error message') == AUTH_TEXT


# Disruptive

@pytest.mark.disruptive
def test_real_container_stop_start(targets, real_page, api):
    """AC-16"""
    name = targets['container'] or pytest.skip('TEST_CONTAINER is not set')
    selector = docker_row(name)
    real_page.click(toggle(selector))
    real_page.wait_row(selector, lambda s: s['status'] is None and s['toggle']['command'] == 'start', 75, 'stopped')
    assert api.containers()[name]['state'] == 'EXITED'
    real_page.click(toggle(selector))
    state = real_page.wait_row(selector, lambda s: s['status'] is None and s['toggle']['command'] == 'stop', 75, 'running')
    assert state['note'] is None


@pytest.mark.disruptive
def test_real_container_pause_resume(targets, real_page, api):
    """AC-36"""
    name = targets['container'] or pytest.skip('TEST_CONTAINER is not set')
    selector = docker_row(name)
    real_page.open_menu(selector)
    real_page.click_menu_item('Pause')
    real_page.wait_row(selector, lambda s: s['status'] is None and s['dot'] == 'paused', 75, 'paused')
    assert api.containers()[name]['state'] == 'PAUSED'
    real_page.click(toggle(selector))
    real_page.wait_row(selector, lambda s: s['status'] is None and s['dot'] == 'running', 75, 'resumed')


@pytest.mark.disruptive
def test_real_container_restart(targets, real_page, api):
    """AC-35: success needs the server's answer; a restart slower than the 15 s request timeout ends at the
    60 s cap with the status-unknown note, which the AC allows"""
    name = targets['container'] or pytest.skip('TEST_CONTAINER is not set')
    selector = docker_row(name)
    real_page.open_menu(selector)
    real_page.click_menu_item('Restart')
    real_page.wait_row(selector, lambda s: s['status'] == 'Restarting...', 5, 'restart pending')
    state = real_page.wait_row(selector, lambda s: s['status'] is None, 75, 'restart finished')
    assert state['note'] in (None, 'Status unknown, refresh to check')
    assert api.containers()[name]['state'] == 'RUNNING'


@pytest.mark.disruptive
def test_real_vm_stop_start(targets, real_page, api):
    """AC-19, AC-16: Stopping... until SHUTOFF (or the status-unknown note at the cap), then Start"""
    name = targets['vm'] or pytest.skip('TEST_VM is not set')
    vm_id = api.vms()[name]['id']
    selector = vm_row(vm_id)
    real_page.click(toggle(selector))
    state = real_page.wait_row(selector, lambda s: s['status'] is None, 90, 'stop settled')
    if state['note'] is None:
        assert state['toggle']['command'] == 'start'
        assert api.vms()[name]['state'] == 'SHUTOFF'
    else:
        assert state['note'] == 'Status unknown, refresh to check'
        wait_until(lambda: api.vms()[name]['state'] == 'SHUTOFF', 180, 3, 'VM SHUTOFF')
        real_page.click('#refreshBtn')
        real_page.wait_row(selector, lambda s: s['toggle']['command'] == 'start', 30, 'Start toggle after refresh')
    real_page.click(toggle(selector))
    real_page.wait_row(selector, lambda s: s['status'] is None and s['toggle']['command'] == 'stop', 75, 'VM running')


@pytest.mark.disruptive
def test_real_vm_restart(targets, real_page, api):
    """AC-37"""
    name = targets['vm'] or pytest.skip('TEST_VM is not set')
    selector = vm_row(api.vms()[name]['id'])
    real_page.open_menu(selector)
    real_page.click_menu_item('Restart')
    real_page.wait_row(selector, lambda s: s['status'] == 'Restarting...', 5, 'restart pending')
    state = real_page.wait_row(selector, lambda s: s['status'] is None, 75, 'restart finished')
    if (state['note'] or '').startswith('Could not restart'):
        # rebootVm gives up after 10 s while the guest keeps shutting down, so wait for SHUTOFF before teardown
        wait_until(lambda: api.vms()[name]['state'] == 'SHUTOFF', 180, 3, 'VM SHUTOFF after the failed reboot')
    assert state['note'] in (None, 'Status unknown, refresh to check')


@pytest.mark.disruptive
def test_real_update_container(real_page, real_env, api):
    """AC-25, AC-26 (single container only; Update all is mock-only)"""
    name = real_env.get('TEST_UPDATE_CONTAINER') or pytest.skip('TEST_UPDATE_CONTAINER is not set')
    status = api.containers()[name]['updateStatus']
    if status != 'UPDATE_AVAILABLE':
        pytest.skip(f'{name} has updateStatus {status}, not UPDATE_AVAILABLE')
    selector = docker_row(name)
    real_page.click(selector + ' [data-action="updateDocker"]')
    real_page.wait_row(selector, lambda s: s['status'] == 'Updating...', 5, 'updating state')
    state = real_page.wait_row(selector, lambda s: s['status'] is None, 660, 'update settled')
    assert state['note'] == f'{name} updated'
    assert api.containers()[name]['updateStatus'] == 'UP_TO_DATE'


@pytest.mark.disruptive
def test_real_notifications_badge_and_archive(real_page, ext, api):
    """AC-08, AC-63: two labeled test notifications are created, counted on the badge and archived one by one"""
    label = f'Unraid Dash test {uuid.uuid4().hex[:8]}'
    created = []

    def unread():
        data = api.call('query { notifications { overview { unread { total } } } }')
        return data['notifications']['overview']['unread']['total']

    def labeled_ids():
        listed = api.call('query { notifications { list(filter: {type: UNREAD, offset: 0, limit: 100}) { id title } } }')
        return [item['id'] for item in sorted(listed['notifications']['list'], key=lambda item: item['title'])
                if item['title'].startswith(label)]

    try:
        for index in (1, 2):
            api.call('mutation ($input: NotificationData!) { createNotification(input: $input) { id } }', {
                'input': {'title': f'{label} #{index}', 'subject': 'Automated test, safe to delete',
                          'description': 'Created by the Unraid Dash test suite', 'importance': 'INFO'}})
        # createNotification returns a different id than the notification list, so the list ids are used
        created = labeled_ids()
        assert len(created) == 2, created

        real_page.click('#refreshBtn')
        ext.probe('send', {'action': 'refreshBadge'})
        wait_until(lambda: ext.badge() == str(unread()), 15, 0.5, 'badge equals unread total')

        for notification_id in created:
            if not real_page.exists('#cardNotifications .ut-notif-list, #cardNotifications .ut-notif-list-loading'):
                real_page.click('#cardNotifications .ut-notif-summary')
            button = f'[data-action="archiveNotification"][data-id="{notification_id}"]'
            real_page.wait(lambda: real_page.exists(button), 20, 'test notification in the list')
            expected = unread() - 1
            real_page.click(button)
            wait_until(lambda: ext.badge() == (str(expected) if expected else ''), 15, 0.5, 'badge after archive')
    finally:
        for notification_id in labeled_ids():
            api.call('mutation ($id: PrefixedID!) { archiveNotification(id: $id) { id } }', {'id': notification_id})
