"""Shared test helpers: env file, storage seeding, dashboard setup."""

from pathlib import Path
from urllib.parse import urlsplit

from browsers import wait_until
from mock_server import ADMIN_KEY


def load_env(path):
    env = {}
    for line in Path(path).expanduser().read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip()
    return env


def origin_of(url):
    parts = urlsplit(url)
    return f'{parts.scheme}://{parts.netloc}'


def server_entry(server_id, url, key=ADMIN_KEY, name=None):
    return {'id': server_id, 'name': name or server_id, 'url': url, 'apiKey': key, 'enabled': True}


def default_settings(active_id, **overrides):
    list_settings = {'sortMode': 'running-az', 'visibleCount': 0, 'customOrder': []}
    settings = {
        'refreshInterval': 60000,
        'activeServerId': active_id,
        'listSettings': {'docker': dict(list_settings), 'vms': dict(list_settings)},
    }
    settings.update(overrides)
    return settings


def seed(ext, servers, extra=None, **settings):
    ext.probe('seed', servers, default_settings(servers[0]['id'], **settings), extra or {})


def open_dashboard(ext, mock, key=ADMIN_KEY, extra=None, **settings):
    """Seeds one server on the mock, opens the popup and waits for the dashboard."""
    seed(ext, [server_entry('server-a', mock.url, key, 'Tower A')], extra, **settings)
    page = ext.open_popup()
    page.wait_dashboard()
    return page


def stored(ext, key):
    return ext.probe('get', [key]).get(key)


def wait_ops(mock, since, op, count=1, timeout=10):
    return wait_until(lambda: mock.ops(since).count(op) >= count, timeout, message=f'{count}x {op} request')
