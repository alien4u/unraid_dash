"""Multi-step UI flows shared by the e2e tests."""

from browsers import wait_until

AUTH_TEXT = 'Authentication failed. Check your API key in Settings, then try Refresh.'
DENIED_TEXT = 'Host permission denied. The extension needs access to connect to this server.'
TEST_DENIED_TEXT = 'Host permission is required to test this connection.'


def form_open(page):
    return page.eval("() => document.getElementById('serverForm').style.display === 'block'")


def form_values(page):
    return page.eval('''() => ({
        name: document.getElementById('serverFormName').value,
        url: document.getElementById('serverFormUrl').value,
        key: document.getElementById('serverFormKey').value
    })''')


def form_title(page):
    return page.text('#serverFormTitle')


def session_draft(page):
    """The form draft in storage.session, read from a popup page (the probe page reads storage.local only)."""
    return page.eval("async () => (await chrome.storage.session.get('serverFormDraft')).serverFormDraft ?? null")


def write_draft(page, action, server_id, name, url, key):
    """Stores a form draft directly, for a state a click cannot reach."""
    page.eval('(pDraft) => chrome.storage.session.set({serverFormDraft: pDraft}).then(() => true)',
              {'action': action, 'id': server_id, 'name': name, 'url': url, 'apiKey': key})


def keep_draft(page):
    """Makes this popup's draft removal do nothing, as if it died right after its last storage write."""
    page.eval('() => { chrome.storage.session.remove = () => {}; return true; }')


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


def staged_record_stored(page):
    return page.eval('''async () => ((await chrome.storage.local.get(['servers'])).servers || [])
        .some((pServer) => pServer.pendingPermission)''')


def click_and_close_on_prompt(ext, page, button, ready=None):
    """Clicks a form button, leaves the permission prompt unanswered and closes the popup (the prompt-closes-popup
    case). Returns the draft the click wrote; ready is an extra condition to wait for before closing."""
    if ext.name == 'chromium':
        page.stub_permission_request('never')
    else:
        ext.set_prompts(True)
    page.click(button)
    # Read from the popup itself: selecting another Firefox tab dismisses the prompt as a denial
    draft = wait_until(lambda: session_draft(page), 10, message='form draft in storage.session')
    if ready:
        wait_until(ready, 10, message='staged server record in storage')
    if ext.name == 'firefox':
        wait_until(ext.prompt_shown, 10, message='permission prompt')
    page.close()
    ext.set_prompts(False)
    return draft


def save_and_close_on_prompt(ext, page):
    """Clicks Save and closes the popup on the prompt once the staged record is in storage."""
    return click_and_close_on_prompt(ext, page, '#saveServerBtn', lambda: staged_record_stored(page))


def hold_storage_writes(page):
    """Makes storage.local writes from this popup hang from now on and marks the page when one is attempted."""
    page.eval('''() => {
        chrome.storage.local.set = () => {
            document.documentElement.dataset.heldWrite = '1';
            return new Promise(() => {});
        };
        return true;
    }''')


def write_held(page):
    return page.eval("() => document.documentElement.dataset.heldWrite === '1'")


def save_answered_with_final_write_held(ext, page, allow):
    """Save with the prompt answered in the open popup, which dies on its final storage write (the staged record is
    stored). Returns the draft still in storage.session at that point."""
    click_with_open_prompt(ext, page, '#saveServerBtn')
    wait_until(lambda: staged_record_stored(page), 10, message='staged server record in storage')
    hold_storage_writes(page)
    answer_open_prompt(ext, page, allow)
    wait_until(lambda: write_held(page), 10, message='final storage write')
    draft = session_draft(page)
    page.close()
    return draft


def click_with_open_prompt(ext, page, button):
    """Clicks a form button and leaves the popup open with the permission prompt unanswered."""
    if ext.name == 'chromium':
        page.eval('''() => {
            chrome.permissions.request = () => new Promise((pFnAnswer) => { window.fnAnswerPrompt = pFnAnswer; });
            return true;
        }''')
        page.click(button)
    else:
        ext.set_prompts(True)
        page.click(button)
        wait_until(ext.prompt_shown, 10, message='permission prompt')


def answer_open_prompt(ext, page, allow):
    """Answers the prompt of click_with_open_prompt; fails if the click did not ask for the permission."""
    if ext.name == 'chromium':
        page.eval('(pAllow) => { window.fnAnswerPrompt(pAllow); return true; }', allow)
    else:
        ext.answer_prompt(allow=allow)
        ext.set_prompts(False)


def grant_origin(ext, url):
    """Grants a host permission the way the user would have answered Allow while the popup was closed."""
    origin = url.rstrip('/') + '/*'
    if ext.probe('contains', origin):
        return
    ext.click_probe_grant(origin)
    wait_until(lambda: ext.probe('contains', origin), 10, message=f'grant of {origin}')
