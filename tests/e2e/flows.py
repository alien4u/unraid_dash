"""Multi-step UI flows shared by the e2e tests."""

from browsers import wait_until

AUTH_TEXT = 'Authentication failed. Check your API key in Settings, then try Refresh.'
DENIED_TEXT = 'Host permission denied. The extension needs access to connect to this server.'


def form_open(page):
    return page.eval("() => document.getElementById('serverForm').style.display === 'block'")


def form_values(page):
    return page.eval('''() => ({
        name: document.getElementById('serverFormName').value,
        url: document.getElementById('serverFormUrl').value,
        key: document.getElementById('serverFormKey').value
    })''')


def server_list(page):
    return page.eval('''() => [...document.querySelectorAll('#serverList .ut-server-item')].map((pItem) => ({
        name: pItem.querySelector('.ut-server-item-name').textContent,
        url: pItem.querySelector('.ut-server-item-url').textContent
    }))''')


def add_server(page, name, url, key):
    """Settings > Add > Save, answered by whatever grant the browser is set up for."""
    page.open_add_server_form()
    page.fill_server_form(name, url, key)
    page.click('#saveServerBtn')
    page.wait(lambda: not form_open(page), 10, 'server form to close after Save')


def edit_server(page, index=0):
    if not page.view()['settings']:
        page.click('#settingsBtn')
    page.eval('''(pIndex) => {
        document.querySelectorAll('#serverList .edit-server')[pIndex].setAttribute('data-test-target', '1');
    }''', index)
    page.click('#serverList .edit-server[data-test-target="1"]')
    page.wait(lambda: form_open(page), 5, 'edit form')


def save_and_deny(ext, page):
    """Clicks Save and denies the host permission: a real Deny click on Firefox, a stubbed answer on Chromium."""
    if ext.name == 'chromium':
        page.stub_permission_request('deny')
        page.click('#saveServerBtn')
    else:
        ext.set_prompts(True)
        page.click('#saveServerBtn')
        ext.answer_prompt(allow=False)
        ext.set_prompts(False)


def save_and_close_on_prompt(ext, page):
    """Clicks Save, leaves the permission prompt unanswered and closes the popup (the Chrome prompt-closes-popup case)."""
    if ext.name == 'chromium':
        page.stub_permission_request('never')
    else:
        ext.set_prompts(True)
    page.click('#saveServerBtn')
    # Read from the popup itself: selecting another Firefox tab dismisses the prompt as a denial
    wait_until(lambda: page.eval('''async () => ((await chrome.storage.local.get(['servers'])).servers || [])
                   .some((pServer) => pServer.pendingPermission)'''), 10, message='staged server record in storage')
    if ext.name == 'firefox':
        wait_until(ext.prompt_shown, 10, message='permission prompt')
    page.close()
    ext.set_prompts(False)


def grant_origin(ext, url):
    """Grants a host permission the way the user would have answered Allow while the popup was closed."""
    origin = url.rstrip('/') + '/*'
    if ext.probe('contains', origin):
        return
    ext.click_probe_grant(origin)
    wait_until(lambda: ext.probe('contains', origin), 10, message=f'grant of {origin}')
