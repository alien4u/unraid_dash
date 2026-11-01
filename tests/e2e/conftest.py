import pytest

from browsers import ChromiumExtension, FirefoxExtension, stop_playwright
from build import build_extension
from helpers import load_env, origin_of
from mock_server import MockServer


class RealEnv(dict):
    """Keeps API keys out of tracebacks, which print fixture values."""

    def __repr__(self):
        return repr({key: '***' if key.endswith('_KEY') else value for key, value in self.items()})


def pytest_configure(config):
    if config.getoption('--real'):
        config.option.tbstyle = 'short'


def pytest_generate_tests(metafunc):
    if 'browser_name' in metafunc.fixturenames:
        choice = metafunc.config.getoption('--browser')
        names = ['chromium', 'firefox'] if choice == 'all' else [choice]
        metafunc.parametrize('browser_name', names, scope='session')


@pytest.fixture(scope='session')
def real_env(request):
    if not request.config.getoption('--real'):
        return None
    env = load_env(request.config.getoption('--env-file'))
    missing = [key for key in ('UNRAID_URL', 'UNRAID_ADMIN_KEY', 'UNRAID_VIEWER_KEY') if not env.get(key)]
    if missing:
        pytest.exit(f'env file is missing {", ".join(missing)}')
    return RealEnv(env)


@pytest.fixture(scope='session')
def browser(request, browser_name, real_env):
    origins = ['http://127.0.0.1/*']
    if real_env:
        origins.append(origin_of(real_env['UNRAID_URL']) + '/*')
    ext_dir = build_extension(browser_name, origins)
    session = ChromiumExtension(ext_dir) if browser_name == 'chromium' else FirefoxExtension(ext_dir)
    session.start()
    yield session
    session.stop()


@pytest.fixture(scope='session', autouse=True)
def playwright_shutdown():
    yield
    stop_playwright()


@pytest.fixture
def ext(browser):
    """The extension with empty storage and badge; popup pages opened by the test are closed after it."""
    browser.set_prompts(False)
    browser.probe('clear')
    browser.probe('clearBadge')
    yield browser
    browser.close_pages()
    browser.set_prompts(False)
    browser.probe('clear')


@pytest.fixture
def mock():
    server = MockServer().start()
    yield server
    server.stop()


@pytest.fixture
def mock_b():
    server = MockServer().start()
    yield server
    server.stop()
