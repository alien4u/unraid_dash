import pytest


def pytest_addoption(parser):
    parser.addoption('--browser', default='all', choices=['chromium', 'firefox', 'all'],
                     help='Browser(s) for the e2e tests (default: all)')
    parser.addoption('--real', action='store_true',
                     help='Also run tests marked real against the server in the env file')
    parser.addoption('--env-file', default='~/.config/unraid-dash-test/.env',
                     help='Env file with UNRAID_URL, keys and test targets (used with --real)')


def pytest_collection_modifyitems(config, items):
    if config.getoption('--real'):
        return
    skip = pytest.mark.skip(reason='real-server test, run with --real')
    for item in items:
        if 'real' in item.keywords:
            item.add_marker(skip)
