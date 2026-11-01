# Unraid Dash tests

Unit tests for `js/background.js` (Bun), browser tests against a mock Unraid API (Playwright Chromium, Selenium Firefox), optional tests against a real server, and release checks.

## Install

```bash
cd tests
uv sync                                   # pytest, playwright 1.58.0 (Chromium build 1208), selenium
uv run playwright install chromium        # only if the Chromium build is not cached yet
```

Firefox is used from `/Applications/Firefox.app` (override with `FIREFOX_APP`, or `FIREFOX_BINARY` off macOS). Selenium Manager downloads geckodriver on first use.

## Unit tests

```bash
cd tests/unit && bun test
```

`background.js` runs in a `node:vm` context with in-memory `chrome.*` stubs and a stubbed `fetch` that answers from `tests/fixtures/mock`.

## Browser tests (mock server)

```bash
cd tests
uv run pytest                             # both browsers, mock server and release checks
uv run pytest --browser chromium          # or firefox
uv run pytest -m "not slow"               # skip the tests that wait for the 15 s timeout or a 60 s cap
HEADED=1 uv run pytest --browser chromium -k badge
```

Each test gets a fresh mock server (`e2e/mock_server.py`, stdlib, `127.0.0.1` on a random port) seeded from `fixtures/mock`. Run it standalone with `python3 -I e2e/mock_server.py --port 8765 [--api-version 4.29.2]`; keys are `admin-key` and `viewer-key`.

The extension is copied to `tests/artifacts/<browser>-ext` with test-only `host_permissions` and a `probe.html` page used to seed storage and read the badge. The release files are not changed. The popup is opened as a tab. Firefox starts through `open -n` on macOS, so it also works from a sandboxed shell, and is driven by geckodriver `--connect-existing`. The add-on is installed as a temporary add-on.

## Real server

```bash
cd tests
uv run pytest e2e/test_real.py --real --browser chromium -m "real and not disruptive"   # read-only
uv run pytest e2e/test_real.py --real -m disruptive                                    # acts on TEST_CONTAINER / TEST_VM
```

Settings come from `~/.config/unraid-dash-test/.env` (`--env-file` to change it). Disruptive tests stop, pause, restart and update only `TEST_CONTAINER`, `TEST_UPDATE_CONTAINER` and `TEST_VM`, and leave the container and VM running. They create labeled test notifications and archive only those. Update all runs only against the mock.

## Fixtures

`python3 -I tools/capture_fixtures.py` records every read query against the real server into `fixtures/real/` (gitignored) and a scrubbed copy into `fixtures/mock/`.
