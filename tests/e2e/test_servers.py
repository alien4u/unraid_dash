"""CR-001, MJ-005, MJ-002 (AC-11): saving, editing and rolling back servers."""

import json
import time

import pytest

from browsers import MOCK_HOST_PATTERN, wait_until
from flows import (AUTH_TEXT, DENIED_TEXT, TEST_DENIED_TEXT, add_server, answer_open_prompt,
                   click_and_close_on_prompt, click_with_open_prompt, edit_server, expect_prompt, form_open, form_title,
                   form_values,
                   grant_origin, hold_storage_writes, keep_draft, save_and_close_on_prompt, save_and_deny,
                   save_answered_with_final_write_held, server_list, session_draft, write_draft, write_held)
from helpers import seed, server_entry, stored
from mock_server import ADMIN_KEY

SAVE = '#saveServerBtn'
TEST = '#testConnectionBtn'


def only_server(ext):
    servers = stored(ext, 'servers') or []
    assert len(servers) == 1, servers
    return servers[0]


def assert_no_plaintext_key(ext, key):
    assert key not in json.dumps(ext.probe('get', None))


def save_with_outcome(ext, page, landed):
    """Save, popup closed on the prompt, the staged record either in storage or never written."""
    if landed:
        save_and_close_on_prompt(ext, page)
    else:
        hold_storage_writes(page)
        click_and_close_on_prompt(ext, page, SAVE)
    assert any(server.get('pendingPermission') for server in stored(ext, 'servers') or []) == landed


def test_add_server_without_test_connection(ext, mock):
    """AC-01"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)

    assert 'denied' not in (page.text('#testResult') or '')
    assert server_list(page) == [{'name': 'Tower A', 'url': mock.url}]
    server = only_server(ext)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server['id']: ADMIN_KEY}
    assert stored(ext, 'settings')['activeServerId'] == server['id']

    page.click('#settingsBack')
    page.wait_dashboard()
    assert 'Core' in mock.ops()


def test_save_after_test_connection(ext, mock):
    """AC-02 (Firefox also checks that Save does not prompt a second time)"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    expect_prompt(ext, page)
    page.click('#testConnectionBtn')
    if ext.name == 'firefox':
        ext.answer_prompt(allow=True)
    page.wait(lambda: (page.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')

    page.click('#saveServerBtn')
    page.wait(lambda: not form_open(page), 10, 'form to close after Save')
    if ext.name == 'firefox':
        assert not ext.prompt_shown()
    assert server_list(page) == [{'name': 'Tower A', 'url': mock.url}]


def test_add_server_denied(ext, mock):
    """AC-03"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    save_and_deny(ext, page)

    page.wait(lambda: page.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert form_open(page)
    assert form_values(page) == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert server_list(page) == []


def test_edit_name_and_key_only(ext, mock):
    """AC-04: same, already granted origin; Firefox prompts are on so an unexpected prompt or a rejected request fails"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']

    ext.set_prompts(True)
    edit_server(page)
    page.fill('#serverFormName', 'Tower Renamed')
    page.fill('#serverFormKey', 'viewer-key')
    page.click('#saveServerBtn')
    page.wait(lambda: not form_open(page), 10, 'form to close after Save')

    assert server_list(page) == [{'name': 'Tower Renamed', 'url': mock.url}]
    server = only_server(ext)
    assert server['id'] == server_id and 'pendingPermission' not in server
    assert ext.probe('storedKeys') == {server_id: 'viewer-key'}


def test_edit_url_denied_restores_previous(ext, mock, mock_b):
    """AC-06"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']

    edit_server(page)
    new_url = f'http://localhost:{mock_b.port}'
    page.fill_server_form('Tower Moved', new_url, 'viewer-key')
    save_and_deny(ext, page)
    page.wait(lambda: page.text('#testResult') == DENIED_TEXT, 10, 'denied message')

    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert reopened.text('#cardSystem .ut-server-link').startswith('Tower')


def test_prompt_closed_popup_then_allowed(ext, mock):
    """AC-05, AC-55: the save outlives the popup; reopening keeps the server and loads it"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    save_and_close_on_prompt(ext, page)
    grant_origin(ext, mock.url)

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    server = only_server(ext)
    assert server['name'] == 'Tower A' and 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server['id']: ADMIN_KEY}


def test_prompt_closed_popup_then_denied(ext, mock):
    """AC-56, AC-79, AC-81: nothing is stored and the form comes back with the denied message"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    save_and_close_on_prompt(ext, page)

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.view()['message'] or '').startswith('No servers configured'), 10,
                  'no-server message')
    assert (stored(ext, 'servers') or []) == []
    assert not any(key.endswith('::prev') for key in (stored(ext, 'encryptedKeys') or {}))

    assert reopened.text('#testResult') == DENIED_TEXT
    assert reopened.view()['settings'] and form_open(reopened)
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': url, 'key': ADMIN_KEY}
    assert server_list(reopened) == []


def test_prompt_closed_popup_edit_url_denied(ext, mock):
    """AC-57 deny, AC-79, AC-81: previous name, URL and key come back in storage; the form holds the draft"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', url, 'viewer-key')
    save_and_close_on_prompt(ext, page)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}

    assert reopened.view()['settings'] and form_open(reopened)
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower Moved', 'url': url, 'key': 'viewer-key'}
    assert server_list(reopened) == [{'name': 'Tower A', 'url': mock.url}]

    # The dashboard does not render behind Settings; leaving it shows the previous server loading normally
    reopened.click('#settingsBack')
    reopened.wait_dashboard()
    assert reopened.text('#cardSystem .ut-server-link').startswith('Tower')


def test_prompt_closed_popup_edit_url_allowed(ext, mock, mock_b):
    """AC-57 allow: the new values are kept"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    save_and_close_on_prompt(ext, page)
    grant_origin(ext, mock_b.url)

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower B', mock_b.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: 'viewer-key'}
    assert 'Core' in mock_b.ops()


@pytest.mark.parametrize('button, action', [(SAVE, 'save'), (TEST, 'test')], ids=['save', 'test'])
def test_draft_holds_the_trimmed_values(ext, mock, button, action):
    """AC-75"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('  Tower A  ', mock.url + '//', f'  {ADMIN_KEY}  ')
    draft = click_and_close_on_prompt(ext, page, button)

    assert draft.pop('id').startswith('server-') if action == 'save' else draft.pop('id') == ''
    assert draft == {'action': action, 'name': 'Tower A', 'url': mock.url, 'apiKey': ADMIN_KEY}

    reopened = ext.open_popup()
    reopened.wait(lambda: form_open(reopened) or reopened.view()['dashboard'], 15, 'popup to use the draft')


@pytest.mark.parametrize('button', [SAVE, TEST], ids=['save', 'test'])
def test_storage_local_never_holds_the_draft_key(ext, mock, button):
    """AC-83: neither the closed popup nor the reopen writes the plaintext key to storage.local"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', f'http://localhost:{mock.port}', ADMIN_KEY)
    click_and_close_on_prompt(ext, page, button)
    assert_no_plaintext_key(ext, ADMIN_KEY)

    reopened = ext.open_popup()
    reopened.wait(lambda: form_open(reopened), 10, 'restored form')
    assert form_values(reopened)['key'] == ADMIN_KEY
    assert_no_plaintext_key(ext, ADMIN_KEY)


def test_draft_connection_test_allowed(ext, mock):
    """AC-80, AC-81: Test then Allow runs the test by itself; nothing is stored as a server"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    click_and_close_on_prompt(ext, page, TEST)
    grant_origin(ext, mock.url)

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')
    assert reopened.view()['settings'] and form_open(reopened)
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert server_list(reopened) == []


def test_draft_connection_test_denied(ext, mock):
    """AC-80: Test then Deny shows the usual message and sends no test"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    click_and_close_on_prompt(ext, page, TEST)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == TEST_DENIED_TEXT, 10, 'required message')
    assert reopened.view()['settings'] and form_open(reopened)
    assert form_values(reopened) == {'name': 'Tower A', 'url': url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert mock.ops() == []


def test_draft_connection_test_on_edit_then_save(ext, mock, mock_b):
    """AC-80, AC-81: a test while editing keeps the stored record; Save from the restored form is an edit"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    click_and_close_on_prompt(ext, page, TEST)
    grant_origin(ext, mock_b.url)

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower B', 'url': mock_b.url, 'key': 'viewer-key'}
    assert (only_server(ext)['name'], only_server(ext)['url']) == ('Tower A', mock.url)
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}

    reopened.click(SAVE)
    reopened.wait(lambda: not form_open(reopened), 10, 'form to close after Save')
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower B', mock_b.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: 'viewer-key'}


def test_draft_save_allowed_first_server_never_staged(ext, mock):
    """AC-78: the staged write never landed; the draft alone finishes the save"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    save_with_outcome(ext, page, landed=False)
    assert (stored(ext, 'servers') or []) == []
    grant_origin(ext, mock.url)

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    server = only_server(ext)
    assert (server['name'], server['url']) == ('Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server['id']: ADMIN_KEY}
    assert stored(ext, 'settings')['activeServerId'] == server['id']
    assert_no_plaintext_key(ext, ADMIN_KEY)


@pytest.mark.parametrize('landed', [True, False], ids=['staged', 'never_staged'])
def test_draft_save_allowed_second_server_becomes_active(ext, mock, mock_b, landed):
    """AC-78: an added server becomes active even when another server was active"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    first_id = only_server(ext)['id']
    page.open_add_server_form()
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    save_with_outcome(ext, page, landed)
    grant_origin(ext, mock_b.url)

    since = len(mock.ops())
    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)

    servers = stored(ext, 'servers')
    assert [server['name'] for server in servers] == ['Tower A', 'Tower B']
    assert not any('pendingPermission' in server or 'prev' in server for server in servers)
    second_id = servers[1]['id']
    assert stored(ext, 'settings')['activeServerId'] == second_id
    assert ext.probe('storedKeys') == {first_id: ADMIN_KEY, second_id: 'viewer-key'}
    assert [tab['id'] for tab in reopened.view()['tabs'] if tab['active']] == [second_id]
    assert 'Core' in mock_b.ops() and 'Core' not in mock.ops(since)


@pytest.mark.parametrize('landed', [True, False], ids=['staged', 'never_staged'])
def test_draft_save_allowed_edit_changes_origin(ext, mock, mock_b, landed):
    """AC-78: an edit that changes the origin keeps the new values and clears the old server state. The new
    host still reports an update, so only the reset (not a finished status check) can clear the old record."""
    mock_b.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    record = {'bulk': False, 'startedAt': int(time.time() * 1000), 'total': 1, 'done': 0, 'failed': 0, 'unknown': 0,
              'items': {'app-01': {'id': mock.container('app-01')['id'], 'startState': 'RUNNING'}}}
    page.eval('(pRecords) => chrome.storage.local.set({pendingUpdates: pRecords})', {server_id: record})

    edit_server(page)
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    save_with_outcome(ext, page, landed)
    assert server_id in stored(ext, 'pendingUpdates')
    grant_origin(ext, mock_b.url)

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower B', mock_b.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: 'viewer-key'}
    assert 'Core' in mock_b.ops()
    assert reopened.docker('app-01')['status'] is None
    wait_until(lambda: server_id not in (stored(ext, 'pendingUpdates') or {}), 5, message='old update record removed')


def test_restored_form_prompts_again_and_saves(ext, mock):
    """AC-79, AC-81: Save on the form restored after a denial prompts again and works"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    save_and_close_on_prompt(ext, page)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    click_with_open_prompt(ext, reopened, SAVE)
    answer_open_prompt(ext, reopened, True)
    reopened.wait(lambda: not form_open(reopened), 10, 'form to close after Save')

    assert server_list(reopened) == [{'name': 'Tower A', 'url': url}]
    server = only_server(ext)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server['id']: ADMIN_KEY}


@pytest.mark.parametrize('button', [SAVE, TEST], ids=['save', 'test'])
def test_draft_is_used_once(ext, mock, button):
    """AC-77: the draft is gone after the first reopen and the second one shows no form"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', f'http://localhost:{mock.port}', ADMIN_KEY)
    click_and_close_on_prompt(ext, page, button)

    first = ext.open_popup()
    first.wait(lambda: form_open(first), 10, 'restored form')
    assert session_draft(first) is None
    first.close()

    second = ext.open_popup()
    second.wait(lambda: (second.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    assert not second.view()['settings'] and not form_open(second)
    assert session_draft(second) is None


def test_draft_dropped_on_key_error(ext, mock):
    """AC-77: with a key error the draft is removed and not used, and staged records stay unsettled"""
    staged = dict(server_entry('server-a', mock.url, ADMIN_KEY, 'Tower A'), pendingPermission=True)
    seed(ext, [staged], extra={'_ek': [0] * 32})
    page = ext.open_popup()
    page.eval("""(pId, pUrl) => chrome.storage.session.set({
        serverFormDraft: {action: 'save', id: pId, name: 'From Draft', url: pUrl, apiKey: 'draft-key'}
    })""", 'server-a', mock.url)
    page.close()

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.view()['message'] or '').startswith('Encryption key mismatch'), 10, 'key error')
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    server = only_server(ext)
    assert server['name'] == 'Tower A' and server['pendingPermission'] is True


@pytest.mark.parametrize('button, allow', [(SAVE, True), (SAVE, False), (TEST, True), (TEST, False)],
                         ids=['save_allow', 'save_deny', 'test_allow', 'test_deny'])
def test_surviving_popup_removes_draft(ext, mock, button, allow):
    """AC-76: the draft exists while the prompt is open and goes when the answer reaches a popup still open"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    click_with_open_prompt(ext, page, button)
    assert wait_until(lambda: session_draft(page), 10, message='form draft')['apiKey'] == ADMIN_KEY

    answer_open_prompt(ext, page, allow)
    wait_until(lambda: session_draft(page) is None, 10, message='draft removal')

    if button == SAVE and allow:
        page.wait(lambda: not form_open(page), 10, 'form to close after Save')
        assert server_list(page) == [{'name': 'Tower A', 'url': mock.url}]
        return

    if button == SAVE:
        expected = DENIED_TEXT
    elif allow:
        expected = 'Connected to Tower'
    else:
        expected = TEST_DENIED_TEXT
    page.wait(lambda: (page.text('#testResult') or '').startswith(expected), 10, 'result message')
    assert form_open(page)
    assert form_values(page) == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []


def test_connection_test_response_lost_runs_again_on_reopen(ext, mock):
    """AC-76, AC-80: granted, but the popup dies before the result; the draft stays and the reopen runs the test"""
    mock.fail('TestConnection', 'hang', once=True)
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    click_with_open_prompt(ext, page, TEST)
    answer_open_prompt(ext, page, True)
    wait_until(lambda: 'TestConnection' in mock.ops(), 10, message='test request')
    assert page.text(TEST) == 'Testing...'
    assert session_draft(page)['action'] == 'test'
    page.close()

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')
    assert reopened.view()['settings'] and form_open(reopened)
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert session_draft(reopened) is None
    assert mock.ops().count('TestConnection') == 2


def test_final_write_held_allowed_add(ext, mock, mock_b):
    """AC-76, AC-78: Allow reached the popup, which died on its final write; the reopen finishes the add from the
    draft and the new server becomes active"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    first_id = only_server(ext)['id']
    page.open_add_server_form()
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    assert save_answered_with_final_write_held(ext, page, True)['name'] == 'Tower B'
    assert stored(ext, 'servers')[1]['pendingPermission'] is True
    assert stored(ext, 'settings')['activeServerId'] == first_id

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    servers = stored(ext, 'servers')
    assert [server['name'] for server in servers] == ['Tower A', 'Tower B']
    assert not any('pendingPermission' in server or 'prev' in server for server in servers)
    assert stored(ext, 'settings')['activeServerId'] == servers[1]['id']
    assert ext.probe('storedKeys') == {first_id: ADMIN_KEY, servers[1]['id']: 'viewer-key'}


def test_final_write_held_allowed_edit(ext, mock, mock_b):
    """AC-76, AC-78: same for an edit; the snapshot of the staged record is dropped and the new values kept"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    assert save_answered_with_final_write_held(ext, page, True)['id'] == server_id
    assert only_server(ext)['prev']['url'] == mock.url

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower B', mock_b.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: 'viewer-key'}
    assert 'Core' in mock_b.ops()


def test_final_write_held_denied(ext, mock):
    """AC-76, AC-79: Deny reached the popup, which died on its final write; the reopen rolls back and restores it"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    assert save_answered_with_final_write_held(ext, page, False)['action'] == 'save'
    assert only_server(ext)['pendingPermission'] is True

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert session_draft(reopened) is None


def test_replaying_a_finished_save_changes_nothing(ext, mock, mock_b):
    """AC-76: the popup dies after the final write but before the draft is removed; the replay leaves the same state"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    page.open_add_server_form()
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    page.eval('() => { chrome.storage.session.remove = () => {}; return true; }')
    click_with_open_prompt(ext, page, SAVE)
    answer_open_prompt(ext, page, True)
    page.wait(lambda: not form_open(page), 10, 'form to close after Save')
    assert session_draft(page)['name'] == 'Tower B'
    servers = stored(ext, 'servers')
    keys = ext.probe('storedKeys')
    assert len(servers) == 2 and stored(ext, 'settings')['activeServerId'] == servers[1]['id']
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    assert stored(ext, 'servers') == servers
    assert ext.probe('storedKeys') == keys
    assert stored(ext, 'settings')['activeServerId'] == servers[1]['id']


def test_staged_record_without_draft_settles_from_the_grant(ext, mock):
    """AC-55, AC-77: no draft (the browser restarted before the reopen); a granted staged record is kept"""
    grant_origin(ext, mock.url)
    seed(ext, [dict(server_entry('server-a', mock.url, ADMIN_KEY, 'Tower A'), pendingPermission=True)])

    page = ext.open_popup()
    page.wait_dashboard()
    server = only_server(ext)
    assert server['name'] == 'Tower A' and 'pendingPermission' not in server
    assert ext.probe('storedKeys') == {'server-a': ADMIN_KEY}


def test_draft_save_edit_of_inactive_server_keeps_active(ext, mock, mock_b):
    """AC-78: an edit finished from a draft does not switch the active server"""
    grant_origin(ext, mock.url)
    grant_origin(ext, mock_b.url)
    seed(ext, [server_entry('server-a', mock.url, ADMIN_KEY, 'Tower A'),
               server_entry('server-b', mock.url, ADMIN_KEY, 'Tower B')])
    page = ext.open_popup()
    page.wait_dashboard()
    page.eval('(pDraft) => chrome.storage.session.set({serverFormDraft: pDraft}).then(() => true)',
              {'action': 'save', 'id': 'server-b', 'name': 'Tower B2', 'url': mock_b.url, 'apiKey': 'viewer-key'})
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    servers = stored(ext, 'servers')
    assert [server['name'] for server in servers] == ['Tower A', 'Tower B2']
    assert not any('pendingPermission' in server or 'prev' in server for server in servers)
    assert stored(ext, 'settings')['activeServerId'] == 'server-a'
    assert [tab['id'] for tab in reopened.view()['tabs'] if tab['active']] == ['server-a']
    assert ext.probe('storedKeys') == {'server-a': ADMIN_KEY, 'server-b': 'viewer-key'}


def test_draft_save_denied_never_staged_add(ext, mock):
    """AC-79: the staged write never landed; nothing to roll back and the form comes back"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    save_with_outcome(ext, page, landed=False)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert session_draft(reopened) is None

    reopened.click('#settingsBack')
    reopened.wait(lambda: (reopened.view()['message'] or '').startswith('No servers configured'), 10,
                  'no-server message')


def test_draft_save_denied_never_staged_edit(ext, mock):
    """AC-79: the staged write never landed; the record is untouched and the form holds the draft"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', url, 'viewer-key')
    save_with_outcome(ext, page, landed=False)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower Moved', 'url': url, 'key': 'viewer-key'}
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower A', mock.url)
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}
    assert session_draft(reopened) is None

    reopened.click('#settingsBack')
    reopened.wait_dashboard()


def test_final_write_held_denied_edit(ext, mock):
    """AC-76, AC-79: Deny reached the popup, which died on its final write; the edit rolls back and the form returns"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', url, 'viewer-key')
    assert save_answered_with_final_write_held(ext, page, False)['id'] == server_id
    assert only_server(ext)['pendingPermission'] is True

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower Moved', 'url': url, 'key': 'viewer-key'}
    server = only_server(ext)
    assert (server['name'], server['url']) == ('Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}


def test_after_final_write_denied_add(ext, mock):
    """AC-76, AC-79: the popup dies after the rollback but before the draft is removed; the form still comes back"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', url, ADMIN_KEY)
    keep_draft(page)
    click_with_open_prompt(ext, page, SAVE)
    answer_open_prompt(ext, page, False)
    page.wait(lambda: page.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert (stored(ext, 'servers') or []) == []
    assert session_draft(page)['name'] == 'Tower A'
    page.close()

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message on reopen')
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': url, 'key': ADMIN_KEY}
    assert session_draft(reopened) is None


def test_after_final_write_denied_edit(ext, mock):
    """AC-76, AC-79: same for an edit; the restored record stays and the form holds the draft"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', url, 'viewer-key')
    keep_draft(page)
    click_with_open_prompt(ext, page, SAVE)
    answer_open_prompt(ext, page, False)
    page.wait(lambda: page.text('#testResult') == DENIED_TEXT, 10, 'denied message')
    assert only_server(ext)['name'] == 'Tower A'
    assert session_draft(page)['id'] == server_id
    page.close()

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == DENIED_TEXT, 10, 'denied message on reopen')
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower Moved', 'url': url, 'key': 'viewer-key'}
    assert only_server(ext)['name'] == 'Tower A'
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}


def test_after_final_write_allowed_edit_with_origin_change(ext, mock, mock_b):
    """AC-76: the popup dies after the final write of an origin-changing edit; the replay leaves the same state"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    edit_server(page)
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    keep_draft(page)
    click_with_open_prompt(ext, page, SAVE)
    answer_open_prompt(ext, page, True)
    page.wait(lambda: not form_open(page), 10, 'form to close after Save')
    servers = stored(ext, 'servers')
    keys = ext.probe('storedKeys')
    assert session_draft(page)['name'] == 'Tower B'
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert stored(ext, 'servers') == servers
    assert ext.probe('storedKeys') == keys
    assert session_draft(reopened) is None
    assert 'Core' in mock_b.ops()


def test_draft_connection_test_on_edit_denied(ext, mock):
    """AC-80, AC-81: Test then Deny while editing keeps the record, shows the usual message and sends no test"""
    url = f'http://localhost:{mock.port}'
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', url, 'viewer-key')
    click_and_close_on_prompt(ext, page, TEST)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.text('#testResult') == TEST_DENIED_TEXT, 10, 'required message')
    assert form_title(reopened) == 'Edit Server'
    assert form_values(reopened) == {'name': 'Tower Moved', 'url': url, 'key': 'viewer-key'}
    assert only_server(ext)['name'] == 'Tower A'
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}
    assert 'TestConnection' not in mock.ops()


def test_staged_record_without_draft_rolls_back_when_not_granted(ext, mock):
    """AC-56, AC-77: no draft (the browser restarted before the reopen); an ungranted staged add is removed, no form"""
    url = f'http://localhost:{mock.port}'
    seed(ext, [dict(server_entry('server-a', url, ADMIN_KEY, 'Tower A'), pendingPermission=True)])

    page = ext.open_popup()
    page.wait(lambda: (page.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    assert (stored(ext, 'servers') or []) == []
    assert not form_open(page)


def test_save_draft_settles_another_staged_record(ext, mock, mock_b):
    """AC-77: the save draft finishes first, then an unrelated staged record settles from its own grant"""
    other_url = f'http://localhost:{mock.port}'
    other = dict(server_entry('server-z', other_url, 'viewer-key', 'Other'), pendingPermission=True)
    page = ext.open_popup()
    page.wait(lambda: (page.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    seed(ext, [other])
    grant_origin(ext, mock_b.url)
    write_draft(page, 'save', 'server-new', 'Tower B', mock_b.url, ADMIN_KEY)
    page.close()

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == ('server-new', 'Tower B', mock_b.url)
    assert 'pendingPermission' not in server
    assert stored(ext, 'settings')['activeServerId'] == 'server-new'
    assert ext.probe('storedKeys') == {'server-new': ADMIN_KEY}


def test_reopened_popup_dies_mid_test(ext, mock):
    """AC-77: the reopened popup dies before the test response; the granted draft stays and the next open runs it"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    click_and_close_on_prompt(ext, page, TEST)
    grant_origin(ext, mock.url)

    mock.fail('TestConnection', 'hang', once=True)
    dying = ext.open_popup()
    wait_until(lambda: 'TestConnection' in mock.ops(), 10, message='test request')
    assert session_draft(dying)['action'] == 'test'
    dying.close()

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')
    assert form_title(reopened) == 'Add Server'
    assert form_values(reopened) == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert (stored(ext, 'servers') or []) == []
    assert session_draft(reopened) is None
    assert mock.ops().count('TestConnection') == 2


@pytest.mark.parametrize('landed, allowed_writes', [(True, 1), (False, 0)], ids=['staged', 'never_staged'])
def test_reopened_popup_dies_mid_save(ext, mock, mock_b, landed, allowed_writes):
    """AC-77, AC-78: the reopened popup dies before its final write; the granted draft stays and the next open ends
    with the server saved once and active. Holding every write covers a popup that dies before its first one."""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    first_id = only_server(ext)['id']
    page.open_add_server_form()
    page.fill_server_form('Tower B', mock_b.url, 'viewer-key')
    save_with_outcome(ext, page, landed)
    grant_origin(ext, mock_b.url)

    dying = ext.open_popup(hold_writes=allowed_writes)
    dying.wait(lambda: write_held(dying), 10, 'held storage write')
    assert session_draft(dying)['name'] == 'Tower B'
    dying.close()
    assert stored(ext, 'settings')['activeServerId'] == first_id

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    assert not reopened.view()['settings'] and not form_open(reopened)
    assert session_draft(reopened) is None
    servers = stored(ext, 'servers')
    assert [server['name'] for server in servers] == ['Tower A', 'Tower B']
    assert not any('pendingPermission' in server or 'prev' in server for server in servers)
    assert stored(ext, 'settings')['activeServerId'] == servers[1]['id']
    assert ext.probe('storedKeys') == {first_id: ADMIN_KEY, servers[1]['id']: 'viewer-key'}
    assert 'Core' in mock_b.ops()


@pytest.mark.parametrize('button', [SAVE, TEST], ids=['save', 'test'])
def test_finished_draft_action_leaves_no_draft(ext, mock, button):
    """AC-77: once the granted action has finished the draft is gone; a further open shows no form, repeats nothing"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    click_and_close_on_prompt(ext, page, button)
    grant_origin(ext, mock.url)

    first = ext.open_popup()
    if button == SAVE:
        first.wait_dashboard()
    else:
        first.wait(lambda: (first.text('#testResult') or '').startswith('Connected to Tower'), 10, 'test result')
    wait_until(lambda: session_draft(first) is None, 10, message='draft removal')
    tests_sent = mock.ops().count('TestConnection')
    first.close()

    second = ext.open_popup()
    if button == SAVE:
        second.wait_dashboard()
        assert only_server(ext)['name'] == 'Tower A'
    else:
        second.wait(lambda: (second.view()['message'] or '').startswith('No servers configured'), 10,
                    'no-server message')
        assert (stored(ext, 'servers') or []) == []
    assert not second.view()['settings'] and not form_open(second)
    assert session_draft(second) is None
    assert mock.ops().count('TestConnection') == tests_sent


def test_reopened_connection_test_error_removes_the_draft(ext, mock):
    """AC-76, AC-77: an error answer also finishes the test; the draft goes and a later open shows no form"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, 'wrong-key')
    click_and_close_on_prompt(ext, page, TEST)
    grant_origin(ext, mock.url)

    first = ext.open_popup()
    first.wait(lambda: first.text('#testResult') == AUTH_TEXT, 10, 'error result')
    assert form_values(first) == {'name': 'Tower A', 'url': mock.url, 'key': 'wrong-key'}
    wait_until(lambda: session_draft(first) is None, 5, message='draft removal')
    tests_sent = mock.ops().count('TestConnection')
    first.close()

    second = ext.open_popup()
    second.wait(lambda: (second.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    assert not second.view()['settings'] and not form_open(second)
    assert session_draft(second) is None
    assert (stored(ext, 'servers') or []) == []
    assert mock.ops().count('TestConnection') == tests_sent


def test_probe_clear_removes_the_draft(ext):
    """AC-89: a draft left by a failed test does not reach the next one"""
    page = ext.open_popup()
    page.wait(lambda: (page.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    write_draft(page, 'test', '', 'Tower A', 'http://localhost:1', ADMIN_KEY)
    assert session_draft(page)['name'] == 'Tower A'

    ext.probe('clear')
    assert session_draft(page) is None


@pytest.fixture
def real_popup(browser_name, ext):
    """Firefox only: the real toolbar popup and doorhanger, with openPopup allowed without a gesture as on Firefox 149+.
    The Chromium prompt cannot be answered from automation, so its reopen is a manual check in TEST-COVERAGE.
    Starts with no host grant at all, as after a fresh install."""
    if browser_name != 'firefox':
        pytest.skip('Firefox only: the Chromium prompt cannot be answered from automation')
    ext.revoke_host_grants()
    assert ext.probe('origins') == []
    assert not ext.probe('contains', MOCK_HOST_PATTERN)
    ext.set_open_popup_without_gesture(True)
    ext.set_prompts(True)
    yield ext
    ext.close_real_popup()
    ext.set_open_popup_without_gesture(False)
    ext.set_prompts(False)


def submit_real_form(real_popup, button, url):
    """Opens the real popup, fills the form and clicks the button; returns with the doorhanger open."""
    real_popup.open_real_popup()
    real_popup.submit_real_popup_form(button, 'Tower A', url, ADMIN_KEY)
    wait_until(real_popup.prompt_shown, 10, message='permission prompt')
    assert session_draft(real_popup.probe_page)['url'] == url


def wait_for_real_result(real_popup, text):
    return wait_until(lambda: (lambda state: state if state and state['result'].startswith(text) else None)(
        real_popup.real_popup_state()), 10, message=f'real popup showing {text}')


def assert_real_popup_stays_closed(real_popup):
    # Longer than the three openPopup attempts, 300 ms apart
    time.sleep(1.2)
    assert not real_popup.real_popup_open()


def test_real_popup_reopens_after_allow_and_runs_the_test(real_popup, mock):
    """AC-84, AC-86: panel closed before Allow; the popup reopens by itself and runs the test from the draft"""
    submit_real_form(real_popup, TEST, mock.url)
    real_popup.close_real_popup()
    assert real_popup.prompt_shown()
    real_popup.answer_prompt(allow=True)

    state = wait_for_real_result(real_popup, 'Connected to Tower')
    assert state['settings'] and state['form'] and state['title'] == 'Add Server'
    assert state['values'] == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    wait_until(lambda: session_draft(real_popup.probe_page) is None, 5, message='draft removal')
    assert (stored(real_popup, 'servers') or []) == []


def test_real_popup_reopens_after_allow_and_finishes_the_save(real_popup, mock):
    """AC-84, AC-86: panel closed before Allow; the popup reopens by itself and ends on the dashboard"""
    submit_real_form(real_popup, SAVE, mock.url)
    real_popup.close_real_popup()
    assert real_popup.prompt_shown()
    real_popup.answer_prompt(allow=True)

    state = wait_until(lambda: (lambda pState: pState if pState and pState['dashboard'] else None)(
        real_popup.real_popup_state()), 15, message='real popup dashboard')
    assert not state['settings'] and not state['form']
    assert session_draft(real_popup.probe_page) is None
    server = only_server(real_popup)
    assert (server['name'], server['url']) == ('Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert real_popup.probe('storedKeys') == {server['id']: ADMIN_KEY}
    assert 'Core' in mock.ops()


@pytest.mark.parametrize('button, text', [(SAVE, DENIED_TEXT), (TEST, TEST_DENIED_TEXT)], ids=['save', 'test'])
def test_real_popup_not_reopened_on_deny(real_popup, mock, button, text):
    """AC-85: Deny fires no event, so the popup stays closed; the next open restores the form from the draft"""
    submit_real_form(real_popup, button, mock.url)
    real_popup.close_real_popup()
    real_popup.answer_prompt(allow=False)

    assert_real_popup_stays_closed(real_popup)
    assert session_draft(real_popup.probe_page)['url'] == mock.url

    real_popup.open_real_popup()
    state = wait_for_real_result(real_popup, text)
    assert state['values'] == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    assert session_draft(real_popup.probe_page) is None


@pytest.mark.parametrize('button', [SAVE, TEST], ids=['save', 'test'])
def test_real_popup_still_open_at_allow_keeps_its_form(real_popup, mock, button):
    """AC-85: a popup still open when Allow arrives finishes in place; the rejected reopen attempts do not touch it"""
    submit_real_form(real_popup, button, mock.url)
    real_popup.mark_real_popup()
    real_popup.answer_prompt(allow=True)

    if button == TEST:
        wait_for_real_result(real_popup, 'Connected to Tower')
    else:
        wait_until(lambda: not real_popup.real_popup_state()['form'], 10, message='form to close after Save')
    wait_until(lambda: session_draft(real_popup.probe_page) is None, 10, message='draft removal')

    # Past the three openPopup attempts, 300 ms apart
    time.sleep(1.2)
    assert real_popup.real_popup_state()['mark'] == '1'
    if button == TEST:
        assert real_popup.real_popup_state()['values'] == {'name': 'Tower A', 'url': mock.url, 'key': ADMIN_KEY}
    else:
        assert only_server(real_popup)['name'] == 'Tower A'


def test_real_popup_rejected_reopen_leaves_the_draft_for_the_user(real_popup, mock):
    """AC-84: openPopup rejecting as on Firefox 142 to 148 shows nothing; the user's own open still finishes the test"""
    submit_real_form(real_popup, TEST, mock.url)
    real_popup.close_real_popup()
    real_popup.set_open_popup_without_gesture(False)
    real_popup.answer_prompt(allow=True)

    assert_real_popup_stays_closed(real_popup)
    assert session_draft(real_popup.probe_page)['action'] == 'test'

    real_popup.set_open_popup_without_gesture(True)
    real_popup.open_real_popup()
    wait_for_real_result(real_popup, 'Connected to Tower')
    wait_until(lambda: session_draft(real_popup.probe_page) is None, 5, message='draft removal')


def test_real_popup_reopens_after_the_background_unloaded(real_popup, mock):
    """AC-84: a user slow to answer: the idle background page has unloaded and the grant wakes it"""
    real_popup.set_background_idle_ms(1000)
    try:
        submit_real_form(real_popup, TEST, mock.url)
        real_popup.close_real_popup()
        wait_until(lambda: real_popup.background_state() == 'stopped', 40, 0.25, 'background page to unload')
        assert real_popup.prompt_shown()
        real_popup.answer_prompt(allow=True)

        wait_for_real_result(real_popup, 'Connected to Tower')
        wait_until(lambda: session_draft(real_popup.probe_page) is None, 5, message='draft removal')
    finally:
        real_popup.set_background_idle_ms(None)


def test_real_popup_stays_closed_without_a_matching_draft(real_popup, mock):
    """AC-85: a grant with no draft, or with a draft for an origin still not granted, opens nothing"""
    real_popup.set_prompts(False)
    grant_origin(real_popup, mock.url)
    assert_real_popup_stays_closed(real_popup)

    write_draft(real_popup.probe_page, 'test', '', 'Other', f'http://localhost:{mock.port}', ADMIN_KEY)
    # Another host: a further port on the mock's host adds no grant on Firefox, so no event would fire
    grant_origin(real_popup, 'http://other-host.invalid')
    assert_real_popup_stays_closed(real_popup)
    assert session_draft(real_popup.probe_page)['name'] == 'Other'


@pytest.mark.parametrize('button', [TEST, SAVE], ids=['test', 'save'])
def test_real_popup_server_on_a_port_works_after_allow(real_popup, mock, button):
    """AC-114, AC-115, AC-118: no manifest host permission, real popup and doorhanger, mock on a port. The grant is for
    the host, because Firefox does not honor a port in a host permission and the mock sends no CORS headers."""
    assert not real_popup.probe_page.eval('() => browser.runtime.getManifest().host_permissions')
    submit_real_form(real_popup, button, mock.url)
    real_popup.answer_prompt(allow=True)

    if button == TEST:
        wait_for_real_result(real_popup, 'Connected to Tower (v7.3.4)')
    else:
        wait_until(lambda: not real_popup.real_popup_state()['form'], 10, message='form to close after Save')
        assert only_server(real_popup)['url'] == mock.url
        real_popup.close_real_popup()
        real_popup.open_real_popup()
        wait_until(lambda: real_popup.real_popup_state()['dashboard'], 15, message='real popup dashboard')
        assert 'Core' in mock.ops()
    assert real_popup.probe('origins') == [MOCK_HOST_PATTERN]


def test_real_popup_old_port_grant_is_repaired_by_one_edit_and_save(real_popup, mock):
    """AC-116: a server added before this version holds only the port grant and is unreachable; one edit and Save
    prompts, obtains the host grant and restores the connection"""
    real_popup.set_prompts(False)
    old_pattern = mock.url + '/*'
    real_popup.click_probe_grant(old_pattern)
    wait_until(lambda: real_popup.probe('contains', old_pattern), 10, message='old port grant')
    assert not real_popup.probe('contains', MOCK_HOST_PATTERN)
    seed(real_popup, [server_entry('server-a', mock.url, ADMIN_KEY, 'Tower A')])

    real_popup.set_prompts(True)
    real_popup.open_real_popup()
    state = wait_until(lambda: (lambda pState: pState if pState and pState['message'] else None)(
        real_popup.real_popup_state()), 20, message='error panel')
    assert state['message'].startswith('Server is unreachable')
    assert mock.ops() == []

    real_popup.save_real_popup_edit()
    wait_until(real_popup.prompt_shown, 10, message='permission prompt')
    real_popup.answer_prompt(allow=True)
    wait_until(lambda: not real_popup.real_popup_state()['form'], 10, message='form to close after Save')
    assert real_popup.probe('contains', MOCK_HOST_PATTERN)

    real_popup.close_real_popup()
    real_popup.open_real_popup()
    wait_until(lambda: real_popup.real_popup_state()['dashboard'], 15, message='real popup dashboard')
    assert 'Core' in mock.ops()


@pytest.mark.parametrize('button', [SAVE, TEST], ids=['save', 'test'])
def test_permission_request_pattern(ext, mock, button):
    """AC-114, AC-118: Chromium and Edge ask for the origin with its port, Firefox for the host without it"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', mock.url, ADMIN_KEY)
    page.eval('''() => {
        window.aRequested = [];
        chrome.permissions.request = async (pPermissions) => {

            window.aRequested.push(pPermissions.origins);
            return true;
        };
        return true;
    }''')
    page.click(button)
    page.wait(lambda: page.eval('() => window.aRequested.length'), 5, 'permission request')
    expected = MOCK_HOST_PATTERN if ext.name == 'firefox' else mock.url + '/*'
    assert page.eval('() => window.aRequested') == [[expected]]


def test_background_pattern_in_the_real_worker(browser_name, ext):
    """AC-114: the reopen check reads location in the service worker, and its retry would swallow an error there.
    Firefox runs this code in the real reopen tests; the Chromium prompt cannot be answered from automation."""
    if browser_name != 'chromium':
        pytest.skip('Chromium only: covered on Firefox by test_real_popup_reopens_after_allow_*')
    worker = ext.context.service_workers[0]
    assert worker.evaluate('location.protocol') == 'chrome-extension:'
    assert worker.evaluate("getHostPattern('http://127.0.0.1:8765')") == 'http://127.0.0.1:8765/*'
    assert worker.evaluate("getHostPattern('https://tower.lan')") == 'https://tower.lan/*'


def test_granted_check_pattern(ext, mock):
    """AC-114: the check a restored draft relies on uses the same pattern as the request"""
    page = ext.open_popup()
    page.wait(lambda: (page.view()['message'] or '').startswith('No servers configured'), 10, 'no-server message')
    write_draft(page, 'test', '', 'Tower A', mock.url, ADMIN_KEY)

    reopened = ext.open_popup()
    reopened.wait(lambda: reopened.eval('() => window.aContainsCalls.length'), 10, 'permission check')
    expected = MOCK_HOST_PATTERN if ext.name == 'firefox' else mock.url + '/*'
    assert reopened.eval('() => window.aContainsCalls')[0] == [expected]


def test_wrong_key_first_server_shows_auth_error(ext, mock):
    """AC-11: the mock answers a bad key like the real server (HTTP 200, extensions.code UNAUTHENTICATED)"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, 'wrong-key')
    page.click('#settingsBack')

    message = page.wait(lambda: page.view()['message'], 20, 'full-panel message')
    assert message == AUTH_TEXT
