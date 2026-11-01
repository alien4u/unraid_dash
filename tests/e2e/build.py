"""Builds the test copy of the extension: the release files plus host_permissions and a probe page."""

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'tests' / 'artifacts'
PROBE = Path(__file__).resolve().parent / 'probe'
GECKO_ID = 'unraid-dash@alien-technology.com'


def build_extension(browser, origins, name=None):
    """Copies the extension into tests/artifacts/<name> with test-only host permissions and the probe page.

    Chromium grants manifest host_permissions at install, so permissions.request for a covered
    origin resolves without the native prompt. Firefox treats MV3 host_permissions as optional;
    the grant there comes from the extensions.webextOptionalPermissionPrompts pref.
    """
    dest = ARTIFACTS / (name or f'{browser}-ext')
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    for entry in ('popup.html', 'css', 'img', 'js'):
        source = ROOT / entry
        if source.is_dir():
            shutil.copytree(source, dest / entry)
        else:
            shutil.copy2(source, dest / entry)
    for entry in ('probe.html', 'probe.js'):
        shutil.copy2(PROBE / entry, dest / entry)

    manifest_name = 'manifest_firefox.json' if browser == 'firefox' else 'manifest.json'
    manifest = json.loads((ROOT / manifest_name).read_text())
    manifest['host_permissions'] = sorted(set(origins))
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return dest
