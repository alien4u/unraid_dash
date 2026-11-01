"""CR-001, MJ-005, MJ-002 (AC-11): saving, editing and rolling back servers."""

from flows import (AUTH_TEXT, DENIED_TEXT, add_server, edit_server, form_open, form_values, grant_origin,
                   save_and_close_on_prompt, save_and_deny, server_list)
from helpers import stored
from mock_server import ADMIN_KEY


def only_server(ext):
    servers = stored(ext, 'servers') or []
    assert len(servers) == 1, servers
    return servers[0]


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
    ext.set_prompts(True)
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
    """AC-56"""
    page = ext.open_popup()
    page.open_add_server_form()
    page.fill_server_form('Tower A', f'http://localhost:{mock.port}', ADMIN_KEY)
    save_and_close_on_prompt(ext, page)

    reopened = ext.open_popup()
    reopened.wait(lambda: (reopened.view()['message'] or '').startswith('No servers configured'), 10,
                  'no-server message')
    assert (stored(ext, 'servers') or []) == []
    assert not any(key.endswith('::prev') for key in (stored(ext, 'encryptedKeys') or {}))


def test_prompt_closed_popup_edit_url_denied(ext, mock):
    """AC-57 deny: previous name, URL and key come back"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, ADMIN_KEY)
    server_id = only_server(ext)['id']
    edit_server(page)
    page.fill_server_form('Tower Moved', f'http://localhost:{mock.port}', 'viewer-key')
    save_and_close_on_prompt(ext, page)

    reopened = ext.open_popup()
    reopened.wait_dashboard()
    server = only_server(ext)
    assert (server['id'], server['name'], server['url']) == (server_id, 'Tower A', mock.url)
    assert 'pendingPermission' not in server and 'prev' not in server
    assert ext.probe('storedKeys') == {server_id: ADMIN_KEY}


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


def test_wrong_key_first_server_shows_auth_error(ext, mock):
    """AC-11: the mock answers a bad key like the real server (HTTP 200, extensions.code UNAUTHENTICATED)"""
    page = ext.open_popup()
    add_server(page, 'Tower A', mock.url, 'wrong-key')
    page.click('#settingsBack')

    message = page.wait(lambda: page.view()['message'], 20, 'full-panel message')
    assert message == AUTH_TEXT
