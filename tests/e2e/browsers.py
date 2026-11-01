"""One interface over Playwright Chromium and Selenium Firefox for the extension tests.

Pages are driven through real clicks and keys; reads go through small JS functions so both
browsers share the same assertions. The probe page (probe.html in the test build) seeds storage
and reads the badge, alarms and permissions.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from build import GECKO_ID

FIREFOX_APP = os.environ.get('FIREFOX_APP', '/Applications/Firefox.app')
HEADED = os.environ.get('HEADED') == '1'

# Popup pages open as tabs sized like the toolbar popup (420 px body); Firefox windows stop at 500 px wide
POPUP_VIEWPORT = {'width': 420, 'height': 900}

_playwright = None


def get_playwright():
    global _playwright
    if _playwright is None:
        from playwright.sync_api import sync_playwright
        _playwright = sync_playwright().start()
    return _playwright


def stop_playwright():
    global _playwright
    if _playwright is not None:
        _playwright.stop()
        _playwright = None


def wait_until(fn, timeout=10, interval=0.1, message='condition'):
    """Polls fn until it returns a truthy value and returns that value."""
    end = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() > end:
            raise AssertionError(f'Timed out after {timeout}s waiting for {message}; last value: {value!r}')
        time.sleep(interval)


ROW_STATE_JS = '''(pSelector) => {
    const oRow = document.querySelector(pSelector);
    if (!oRow) return null;
    const oToggle = oRow.querySelector('[data-action="itemControl"]');
    const oMore = oRow.querySelector('[data-action="itemMore"]');
    const oUpdate = oRow.querySelector('[data-action="updateDocker"]');
    const oNote = oRow.querySelector('.ut-item-note');
    const oName = oRow.querySelector('.ut-item-name a, .ut-item-name > span:not(.ut-status-dot):not(.ut-update-badge)');
    const sDot = oRow.querySelector('.ut-item-name .ut-status-dot').className;
    return {
        dot: (sDot.match(/ut-status-dot--(\\w+)/) || [])[1] || null,
        name: oName ? oName.textContent : null,
        link: oRow.querySelector('.ut-item-name a')?.getAttribute('href') ?? null,
        updateBadge: !!oRow.querySelector('.ut-update-badge'),
        status: oRow.querySelector('.ut-item-status')?.textContent ?? null,
        note: oNote ? oNote.textContent : null,
        noteType: oNote ? (oNote.className.match(/ut-item-note--(\\w+)/) || [])[1] : null,
        buttons: [...oRow.querySelectorAll('.ut-item-actions > button')].map((pB) => pB.dataset.action),
        toggle: oToggle && {
            command: oToggle.dataset.command,
            title: oToggle.title,
            disabled: oToggle.disabled,
            icon: oToggle.querySelector('use')?.getAttribute('href') ?? null,
            spinner: !!oToggle.querySelector('.ut-btn-spinner')
        },
        more: oMore && {
            disabled: oMore.disabled,
            items: oMore.dataset.items,
            label: oMore.getAttribute('aria-label'),
            title: oMore.title
        },
        update: oUpdate && {
            disabled: oUpdate.disabled,
            title: oUpdate.title,
            spinner: !!oUpdate.querySelector('.ut-btn-spinner')
        }
    };
}'''

DETAIL_ROWS_JS = '''(pCard) => [...document.querySelectorAll(pCard + ' .ut-detail-row')].map((pRow) => {
    const oLabel = pRow.querySelector('.ut-detail-label');
    const oValue = pRow.querySelector('.ut-detail-value');
    return [oLabel ? oLabel.textContent : '', oValue ? oValue.textContent : null];
})'''

CHIPS_JS = '''() => [...document.querySelectorAll('#cardArray .ut-disk-chip')].map((pChip) => {
    const oTemp = pChip.querySelector('.ut-disk-chip-temp');
    return {
        name: [...pChip.childNodes].filter((pN) => pN.nodeType === 3).map((pN) => pN.textContent).join(''),
        dot: (pChip.querySelector('.ut-status-dot').className.match(/ut-status-dot--(\\w+)/) || [])[1],
        temp: oTemp ? oTemp.textContent : null,
        tempClass: oTemp ? (oTemp.className.match(/ut-text-(\\w+)/) || [])[1] || null : null,
        tooltip: pChip.dataset.tooltip ?? null
    };
})'''

VIEW_JS = '''() => {
    const fnShown = (pId) => {
        const oEl = document.getElementById(pId);
        return !!oEl && oEl.style.display !== 'none' && getComputedStyle(oEl).display !== 'none';
    };
    return {
        dashboard: fnShown('dashboard'),
        message: fnShown('message') ? document.getElementById('message').textContent : null,
        spinner: fnShown('spinner'),
        strip: fnShown('staleStrip') ? document.getElementById('staleStrip').textContent : null,
        settings: fnShown('settingsPanel'),
        tabs: [...document.querySelectorAll('#serverTabs .ut-tab')].map((pT) => ({
            id: pT.dataset.serverId, name: pT.textContent, active: pT.classList.contains('active')
        }))
    };
}'''


def docker_row(name):
    return f'#cardDocker .ut-item-row:has([data-action="openUrlOverride"][data-id="{name}"])'


def vm_row(vm_id):
    return f'#cardVMs .ut-item-row:has([data-action="openVmSettings"][data-id="{vm_id}"])'


class BasePage:
    """Shared queries; subclasses implement eval/click/fill/press/close."""

    def row(self, selector):
        return self.eval(ROW_STATE_JS, selector)

    def docker(self, name):
        return self.row(docker_row(name))

    def vm(self, vm_id):
        return self.row(vm_row(vm_id))

    def view(self):
        return self.eval(VIEW_JS)

    def text(self, selector):
        return self.eval('(pSel) => document.querySelector(pSel)?.textContent ?? null', selector)

    def texts(self, selector):
        return self.eval('(pSel) => [...document.querySelectorAll(pSel)].map((pEl) => pEl.textContent)', selector)

    def exists(self, selector):
        return self.eval('(pSel) => !!document.querySelector(pSel)', selector)

    def detail_rows(self, card):
        return self.eval(DETAIL_ROWS_JS, card)

    def chips(self):
        return self.eval(CHIPS_JS)

    def docker_names(self):
        return self.eval('''() => [...document.querySelectorAll('#cardDocker [data-action="openUrlOverride"]')]
            .map((pB) => pB.dataset.id)''')

    def vm_names(self):
        return self.eval('''() => [...document.querySelectorAll('#cardVMs .ut-item-row')]
            .map((pR) => pR.querySelector('.ut-item-name > span:not(.ut-status-dot)').textContent)''')

    def active_element(self):
        return self.eval('''() => {
            const oEl = document.activeElement;
            return oEl ? {tag: oEl.tagName, action: oEl.dataset.action ?? null, key: oEl.dataset.key ?? null,
                          role: oEl.getAttribute('role'), text: oEl.textContent} : null;
        }''')

    def wait(self, fn, timeout=10, message='condition'):
        return wait_until(fn, timeout=timeout, message=message)

    def wait_dashboard(self, timeout=15):
        return self.wait(lambda: self.view()['dashboard'] and self.exists('#cardSystem .ut-card-header'),
                         timeout, 'dashboard')

    def wait_row(self, selector, predicate, timeout=10, message='row state'):
        def check():
            state = self.row(selector)
            return state if state and predicate(state) else None
        return self.wait(check, timeout, message)

    def stub_permission_request(self, mode):
        """Replaces chrome.permissions.request: 'deny' answers false, 'never' never answers."""
        return self.eval('''(pMode) => {
            chrome.permissions.request = pMode === 'deny' ? async () => false : () => new Promise(() => {});
            return true;
        }''', mode)

    def fill_server_form(self, name, url, key):
        self.fill('#serverFormName', name)
        self.fill('#serverFormUrl', url)
        self.fill('#serverFormKey', key)

    def open_add_server_form(self):
        self.wait(lambda: self.exists('#settingsBtn'), 5, 'toolbar')
        if not self.view()['settings']:
            self.click('#settingsBtn')
        self.click('#addServerBtn')
        self.wait(lambda: self.eval("() => document.getElementById('serverForm').style.display === 'block'"),
                  5, 'server form')

    def open_menu(self, row_selector):
        """Opens a row's More menu. The menu closes on scroll, so the row is scrolled into view and the scroll
        event delivered before the click; otherwise an auto-scroll by the driver can close the menu it opened."""
        button = row_selector + ' [data-action="itemMore"]'
        self.eval('''(pSel) => new Promise((pFnDone) => {
            document.querySelector(pSel).scrollIntoView({block: 'center'});
            requestAnimationFrame(() => requestAnimationFrame(() => pFnDone(true)));
        })''', button)
        self.click(button)
        return self.wait(lambda: self.texts('.ut-menu[role="menu"] .ut-menu-item'), 5, 'More menu')

    def click_at(self, selector):
        """Clicks the centre of an element that is already on screen, without scrolling."""
        x, y = self.eval('''(pSel) => {
            const oRect = document.querySelector(pSel).getBoundingClientRect();
            return [oRect.left + oRect.width / 2, oRect.top + oRect.height / 2];
        }''', selector)
        self.click_point(x, y)

    def click_menu_item(self, title):
        """Clicks a More menu item where it is drawn: scrolling first would close the menu (it closes on scroll)."""
        x, y = self.eval('''(pTitle) => {
            const oItem = [...document.querySelectorAll('.ut-menu .ut-menu-item')].find((pI) => pI.textContent === pTitle);
            const oRect = oItem.getBoundingClientRect();
            return [oRect.left + oRect.width / 2, oRect.top + oRect.height / 2];
        }''', title)
        self.click_point(x, y)


class ChromiumPage(BasePage):

    def __init__(self, page):
        self.page = page
        self.dialogs = []
        page.on('dialog', self._on_dialog)

    def _on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.accept()

    def eval(self, fn, *args):
        return self.page.evaluate(f'(pArgs) => ({fn})(...pArgs)', list(args))

    def click(self, selector, timeout=5):
        self.page.click(selector, timeout=timeout * 1000)

    def fill(self, selector, value):
        self.page.fill(selector, value)

    def select(self, selector, value):
        self.page.select_option(selector, value)

    def click_point(self, x, y):
        self.page.mouse.click(x, y)

    def press(self, key):
        self.page.keyboard.press({'Space': ' '}.get(key, key))

    def dialog_seen(self):
        return bool(self.dialogs)

    def close(self):
        if not self.page.is_closed():
            self.page.close()


class FirefoxPage(BasePage):

    def __init__(self, browser, handle):
        self.browser = browser
        self.driver = browser.driver
        self.handle = handle
        self.dialogs = []

    def _focus(self):
        if self.driver.current_window_handle != self.handle:
            self.driver.switch_to.window(self.handle)
        self._take_alert()

    def _take_alert(self):
        from selenium.common.exceptions import NoAlertPresentException
        try:
            alert = self.driver.switch_to.alert
            self.dialogs.append(alert.text)
            alert.accept()
        except NoAlertPresentException:
            pass

    def eval(self, fn, *args):
        self._focus()
        result = self.driver.execute_async_script(f'''
            const fnDone = arguments[arguments.length - 1];
            const aArgs = Array.from(arguments).slice(0, -1);
            Promise.resolve().then(() => ({fn})(...aArgs)).then(
                (pValue) => fnDone({{ok: pValue === undefined ? null : JSON.parse(JSON.stringify(pValue))}}),
                (pErr) => fnDone({{err: String(pErr && pErr.message || pErr)}}));
        ''', *args)
        if 'err' in result:
            raise RuntimeError(result['err'])
        return result['ok']

    def click(self, selector, timeout=5):
        self._focus()
        element = wait_until(lambda: self._displayed(selector), timeout, message=f'clickable {selector}')
        # The fixed footer can cover the bottom row; centre the target like a user scrolling to it.
        # Then wait until it stops moving (panel slide-in animation), as Playwright's actionability check does.
        wait_until(lambda: self.driver.execute_async_script('''
            const [oEl, fnDone] = arguments;
            oEl.scrollIntoView({block: 'center'});
            const sBefore = JSON.stringify(oEl.getBoundingClientRect());
            requestAnimationFrame(() => requestAnimationFrame(() =>
                fnDone(sBefore === JSON.stringify(oEl.getBoundingClientRect()))));
        ''', element), timeout, 0.05, f'{selector} to stop moving')
        element.click()
        time.sleep(0.05)
        self._take_alert()

    def click_point(self, x, y):
        from selenium.webdriver.common.action_chains import ActionChains
        self._focus()
        actions = ActionChains(self.driver)
        actions.w3c_actions.pointer_action.move_to_location(int(x), int(y))
        actions.w3c_actions.pointer_action.click()
        actions.perform()
        self._take_alert()

    def _displayed(self, selector):
        from selenium.common.exceptions import StaleElementReferenceException
        from selenium.webdriver.common.by import By
        try:
            for element in self.driver.find_elements(By.CSS_SELECTOR, selector):
                if element.is_displayed() and element.is_enabled():
                    return element
        except StaleElementReferenceException:
            pass
        return None

    def fill(self, selector, value):
        from selenium.webdriver.common.by import By
        self._focus()
        element = self.driver.find_element(By.CSS_SELECTOR, selector)
        element.clear()
        element.send_keys(value)

    def select(self, selector, value):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import Select
        self._focus()
        Select(self.driver.find_element(By.CSS_SELECTOR, selector)).select_by_value(value)

    def press(self, key):
        from selenium.webdriver.common.action_chains import ActionChains
        from selenium.webdriver.common.keys import Keys
        self._focus()
        ActionChains(self.driver).send_keys(getattr(Keys, key.upper(), key)).perform()

    def dialog_seen(self):
        self._focus()
        return bool(self.dialogs)

    def close(self):
        if self.handle in self.driver.window_handles:
            self.driver.switch_to.window(self.handle)
            self.driver.close()
        self.driver.switch_to.window(self.browser.probe_handle)


class ChromiumExtension:
    name = 'chromium'

    def __init__(self, ext_dir):
        self.ext_dir = ext_dir
        self.user_data_dir = tempfile.mkdtemp(prefix='unraid-dash-chromium-')
        self.context = None
        self.pages = []

    def start(self):
        self.context = get_playwright().chromium.launch_persistent_context(
            self.user_data_dir, channel='chromium', headless=not HEADED, locale='en-US', viewport=POPUP_VIEWPORT,
            args=[f'--disable-extensions-except={self.ext_dir}', f'--load-extension={self.ext_dir}'])
        worker = self.context.service_workers[0] if self.context.service_workers else \
            self.context.wait_for_event('serviceworker', timeout=15000)
        self.ext_id = worker.url.split('/')[2]
        self.base = f'chrome-extension://{self.ext_id}'
        self.probe_page = self.context.new_page()
        self.probe_page.goto(self.base + '/probe.html')
        return self

    def restart(self):
        """Quits the browser and launches it again on the same profile."""
        self.context.close()
        self.pages = []
        return self.start()

    def stop(self):
        if self.context:
            self.context.close()
            self.context = None
        shutil.rmtree(self.user_data_dir, ignore_errors=True)

    def open_popup(self):
        page = self.context.new_page()
        page.goto(self.base + '/popup.html')
        wrapped = ChromiumPage(page)
        self.pages.append(wrapped)
        return wrapped

    def probe(self, method, *args):
        return self.probe_page.evaluate(f'(pArgs) => window.probe.{method}(...pArgs)', list(args))

    def click_probe_grant(self, origin):
        self.probe_page.evaluate("() => { document.getElementById('result').textContent = ''; }")
        self.probe_page.fill('#origin', origin)
        self.probe_page.click('#grant')

    def badge(self):
        return self.probe('badge')

    def set_prompts(self, enabled):
        """Chromium has no prompt switch; deny paths stub permissions.request instead."""

    def deny_prompt(self, timeout=5):
        raise NotImplementedError('Chromium permission prompts cannot be answered from automation')

    def close_pages(self):
        for page in self.pages:
            page.close()
        self.pages = []


class FirefoxExtension:
    name = 'firefox'

    def __init__(self, ext_dir):
        self.ext_dir = ext_dir
        self.ext_uuid = str(uuid.uuid4())
        self.profile = Path(tempfile.mkdtemp(prefix='unraid-dash-firefox-'))
        self.driver = None
        self.pages = []

    def start(self):
        from selenium import webdriver
        from selenium.webdriver.firefox.service import Service

        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        prefs = {
            'marionette.port': port,
            'extensions.webextensions.uuids': json.dumps({GECKO_ID: self.ext_uuid}),
            'extensions.webextOptionalPermissionPrompts': False,
            'security.enterprise_roots.enabled': True,
            'app.update.disabledForTesting': True,
            'app.update.auto': False,
            'browser.shell.checkDefaultBrowser': False,
            'browser.aboutwelcome.enabled': False,
            'datareporting.policy.dataSubmissionEnabled': False,
            'toolkit.telemetry.reportingpolicy.firstRun': False,
            'intl.locale.requested': 'en-US',
            'browser.tabs.warnOnClose': False,
        }
        (self.profile / 'user.js').write_text(
            ''.join(f'user_pref({json.dumps(key)}, {json.dumps(value)});\n' for key, value in prefs.items()))

        # Launched outside the driver so that a sandboxed parent process (macOS seatbelt) is not inherited
        args = (['-headless'] if not HEADED else []) + \
            ['-marionette', '-remote-allow-system-access', '-no-remote', '-profile', str(self.profile), 'about:blank']
        if sys.platform == 'darwin':
            subprocess.run(['open', '-n', '-g', '--env', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1', '-a', FIREFOX_APP,
                            '--args', *args], check=True)
        else:
            binary = os.environ.get('FIREFOX_BINARY', 'firefox')
            subprocess.Popen([binary, *args], env=dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS='1'))
        wait_until(lambda: (self.profile / 'MarionetteActivePort').exists(), 60, 0.2, 'Firefox Marionette')

        self.driver = webdriver.Firefox(service=Service(
            service_args=['--connect-existing', '--marionette-port', str(port), '--allow-system-access']))
        self.driver.set_script_timeout(60)
        self.driver.set_window_rect(width=POPUP_VIEWPORT['width'], height=POPUP_VIEWPORT['height'])
        self.driver.install_addon(str(self.ext_dir), temporary=True)
        self.base = f'moz-extension://{self.ext_uuid}'
        self.probe_handle = self.driver.current_window_handle
        self.driver.get(self.base + '/probe.html')
        self.probe_page = FirefoxPage(self, self.probe_handle)
        return self

    def stop(self):
        if self.driver is None:
            return
        try:
            with self.driver.context(self.driver.CONTEXT_CHROME):
                self.driver.execute_script('Services.startup.quit(Ci.nsIAppStartup.eForceQuit)')
        except Exception:
            pass
        try:
            self.driver.quit()
        except Exception:
            pass
        self.driver = None
        try:
            wait_until(lambda: subprocess.run(['pgrep', '-f', str(self.profile)], capture_output=True).returncode,
                       15, 0.2, 'Firefox exit')
        except AssertionError:
            subprocess.run(['pkill', '-f', str(self.profile)])
        shutil.rmtree(self.profile, ignore_errors=True)

    def open_popup(self):
        self.driver.switch_to.new_window('tab')
        self.driver.get(self.base + '/popup.html')
        page = FirefoxPage(self, self.driver.current_window_handle)
        self.pages.append(page)
        return page

    def probe(self, method, *args):
        return self.probe_page.eval(f'(...pArgs) => window.probe.{method}(...pArgs)', *args)

    def click_probe_grant(self, origin):
        self.probe_page.eval("() => { document.getElementById('result').textContent = ''; }")
        self.probe_page.fill('#origin', origin)
        self.probe_page.click('#grant')

    def badge(self):
        return self.probe('badge')

    def set_prompts(self, enabled):
        """With prompts off Firefox grants optional permissions without asking (user input still required)."""
        with self.driver.context(self.driver.CONTEXT_CHROME):
            self.driver.execute_script(
                'Services.prefs.setBoolPref("extensions.webextOptionalPermissionPrompts", arguments[0])', enabled)

    def prompt_shown(self):
        with self.driver.context(self.driver.CONTEXT_CHROME):
            return self.driver.execute_script('''
                const oNote = document.getElementById('addon-webext-permissions-notification');
                return !!oNote && !oNote.hidden && PopupNotifications.panel.state !== 'closed';''')

    def answer_prompt(self, allow, timeout=10):
        """Clicks Allow or Deny on the host permission doorhanger."""
        wait_until(self.prompt_shown, timeout, 0.2, 'permission prompt')
        with self.driver.context(self.driver.CONTEXT_CHROME):
            self.driver.execute_script(
                'document.getElementById("addon-webext-permissions-notification")[arguments[0]].click()',
                'button' if allow else 'secondaryButton')

    def close_pages(self):
        for page in self.pages:
            page.close()
        self.pages = []
