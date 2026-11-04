"""F1: container WebUI links (AC-21, AC-22, AC-23)."""

from browsers import docker_row
from helpers import open_dashboard


def link(page, name):
    return page.docker(name)['link']


def set_override(page, name, url):
    page.click(docker_row(name) + ' [data-action="openUrlOverride"]')
    page.wait(lambda: page.eval("() => document.getElementById('urlOverrideBackdrop').style.display === 'flex'"),
              5, 'container settings modal')
    checked = page.eval("() => document.getElementById('urlOverrideCheckbox').checked")
    if bool(url) != checked:
        page.click('#urlOverrideCheckbox')
    if url:
        page.fill('#urlOverrideInput', url)
    page.click('#urlModalSave')
    page.wait(lambda: page.eval("() => document.getElementById('urlOverrideBackdrop').style.display === 'none'"),
              5, 'modal closed')


def test_links_from_template(ext, mock):
    """AC-21: href equals webUiUrl, including containers without a published port"""
    page = open_dashboard(ext, mock)
    assert mock.container('app-02')['webUiUrl'] == 'http://app-02.example.lan:5678/'
    assert link(page, 'app-02') == 'http://app-02.example.lan:5678/'
    assert mock.container('app-09')['ports'] == []
    assert link(page, 'app-09') == 'http://192.0.2.10:80'
    assert link(page, 'app-17') == 'https://plex.example.lan:32400'


def test_link_precedence(ext, mock):
    """AC-22: override > webUiUrl > port detection > plain text"""
    page = open_dashboard(ext, mock)
    set_override(page, 'app-02', 'https://override.example.lan:9443')
    assert link(page, 'app-02') == 'https://override.example.lan:9443'
    set_override(page, 'app-02', None)
    assert link(page, 'app-02') == 'http://app-02.example.lan:5678/'

    assert mock.container('app-06')['webUiUrl'] is None
    assert link(page, 'app-06') == 'http://127.0.0.1:6379'
    assert mock.container('app-03')['webUiUrl'] is None and mock.container('app-03')['ports'] == []
    state = page.docker('app-03')
    assert state['link'] is None and state['name'] == 'app-03'


def test_links_below_430_or_failing(ext, mock):
    """AC-23: API < 4.30 never asks for webUiUrl; a failing webUiUrl query keeps v1.2.0 links"""
    mock.set_api_version('4.29.2')
    page = open_dashboard(ext, mock)
    assert 'DockerWebUi' not in mock.ops()
    assert link(page, 'app-02') == 'http://127.0.0.1:5678'
    assert link(page, 'app-09') is None
    assert len(page.docker_names()) == 31
    page.close()

    mock.set_api_version('4.37.9+bedd403a')
    mock.fail('DockerWebUi', 'http400', 'webUiUrl')
    page = ext.open_popup()
    page.wait_dashboard()
    assert link(page, 'app-02') == 'http://127.0.0.1:5678'
    assert len(page.docker_names()) == 31
    assert page.view()['strip'] is None
