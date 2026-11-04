"""Checks that the harness itself still exercises what the CR-001 tests rely on."""

import pytest


def test_firefox_permission_request_needs_user_input(browser_name, ext, mock):
    """With prompts disabled Firefox still rejects permissions.request outside a user input handler, so the
    Save tests fail if the popup awaits before requesting (the CR-001 bug)"""
    if browser_name != 'firefox':
        pytest.skip('Firefox only: Playwright evaluates scripts as a user gesture')
    with pytest.raises(RuntimeError, match='may only be called from a user input handler'):
        ext.probe('request', mock.url + '/*')
    ext.click_probe_grant(mock.url + '/*')
    ext.probe_page.wait(lambda: ext.probe_page.text('#result') == 'granted:true', 10, 'grant from a click')
