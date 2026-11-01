"""Release checks (AC-51 to AC-54)."""

import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VERSION = '1.3.0'


def manifest(name):
    return json.loads((ROOT / name).read_text())


def test_manifest_versions():
    """AC-51"""
    assert manifest('manifest.json')['version'] == VERSION
    assert manifest('manifest_firefox.json')['version'] == VERSION


def test_build_produces_both_packages(tmp_path):
    """AC-51: build.sh run on a copy of the release files (the repo's dist/ is not touched)"""
    if not (ROOT / 'build.sh').exists():
        pytest.skip('build.sh is gitignored and not present in this checkout')
    for name in ('manifest.json', 'manifest_firefox.json', 'popup.html', 'build.sh'):
        shutil.copy2(ROOT / name, tmp_path / name)
    for name in ('css', 'img', 'js'):
        shutil.copytree(ROOT / name, tmp_path / name)
    subprocess.run(['bash', 'build.sh'], cwd=tmp_path, check=True, capture_output=True)

    chrome = tmp_path / 'dist' / f'unraid_dash_v{VERSION}_chrome_edge.zip'
    firefox = tmp_path / 'dist' / f'unraid_dash_v{VERSION}_firefox.zip'
    with zipfile.ZipFile(chrome) as package:
        assert json.loads(package.read('manifest.json')) == manifest('manifest.json')
        assert {'popup.html', 'js/background.js', 'js/popup.js', 'css/main.css'} <= set(package.namelist())
    with zipfile.ZipFile(firefox) as package:
        assert json.loads(package.read('manifest.json')) == manifest('manifest_firefox.json')
        assert {'popup.html', 'js/background.js', 'js/popup.js', 'css/main.css'} <= set(package.namelist())


def test_changelog_and_readme():
    """AC-52, AC-73"""
    changelog_path = ROOT / 'CHANGELOG.md'
    if changelog_path.exists():
        changelog = changelog_path.read_text()
        entry = changelog.split(f'## v{VERSION}', 1)[1].split('\n## ', 1)[0]
        assert '### Bug Fixes' in entry and '### Features' in entry
    readme = (ROOT / 'README.md').read_text()
    assert f'badge/version-{VERSION}-' in readme
    assert re.search(rf'^### v{re.escape(VERSION)}\b', readme, re.M)
    store_rows = re.findall(r'^\| (Chrome Web Store|Edge Add-ons|Firefox Add-ons) \| (v[\d.]+) \|', readme, re.M)
    assert [version for _, version in store_rows] == ['v1.2.0'] * 3
    features = readme.split('## ✨ Features', 1)[1].split('\n## ', 1)[0]
    for phrase in ('Update all', 'WebUI links', 'Restart', 'Pause', 'Parity check', 'Temperature'):
        assert phrase in features, phrase
    entry = readme.split(f'### v{VERSION}', 1)[1].split('\n### ', 1)[0]
    for phrase in ('temperature sensors', 'invalid API key', 'permission denied', 'VM Restart'):
        assert re.search(re.escape(phrase), entry, re.I), phrase


def test_privacy_lists_new_stored_data():
    """AC-53, AC-73: per-server custom order, pending updates, the staged-save marker and pending VM restarts"""
    privacy = (ROOT / 'PRIVACY.md').read_text()
    section = privacy.split('## What Is Stored Locally', 1)[1].split('\n## ', 1)[0]
    assert re.search(r'custom order per server', section, re.I)
    assert re.search(r'pending container updates', section, re.I)
    assert re.search(r'pending marker', section, re.I)
    assert re.search(r'pending VM restarts', section, re.I)
    assert re.search(r'\*\*Last updated:\*\* November 1, 2026', privacy)


def test_no_new_permissions_or_html_injection():
    """AC-54: permissions match v1.2.0 (main) and no innerHTML/insertAdjacentHTML/outerHTML"""
    for name in ('manifest.json', 'manifest_firefox.json'):
        released = json.loads(subprocess.run(['git', 'show', f'main:{name}'], cwd=ROOT, check=True,
                                             capture_output=True, text=True).stdout)
        current = manifest(name)
        for key in ('permissions', 'optional_host_permissions', 'host_permissions'):
            assert current.get(key) == released.get(key), (name, key)
    for path in [*sorted((ROOT / 'js').glob('*.js')), ROOT / 'popup.html']:
        assert not re.search(r'\b(innerHTML|outerHTML|insertAdjacentHTML)\b', path.read_text()), path.name
