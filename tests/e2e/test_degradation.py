"""Cross-cutting degradation (AC-49)."""

import pytest

from browsers import vm_row
from helpers import open_dashboard, seed, server_entry


def test_api_below_430(ext, mock):
    """AC-49 on API 4.29: v1.2.0 dashboard plus VM actions, parity and disk thresholds; no 4.30+ queries"""
    mock.set_api_version('4.29.2')
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    mock.set_disk('disk1', temp=46)
    page = open_dashboard(ext, mock)

    assert not {'DockerWebUi', 'DockerUpdates', 'Temperature'} & set(mock.ops())
    view = page.view()
    assert view['strip'] is None and view['message'] is None
    assert len(page.docker_names()) == 31
    assert not page.exists('#cardDocker [data-action="updateDocker"], #cardDocker [data-action="itemMore"]')
    assert not page.exists('#cardDocker .ut-update-badge')
    assert page.vm(mock.vm('vm-2')['id'])['more']['items'] == 'restart'
    assert [label for label, _ in page.detail_rows('#cardArray') if label == 'Last check'] == ['Last check']
    disk1 = next(c for c in page.chips() if c['name'] == 'disk1')
    assert disk1['dot'] == 'warning'


@pytest.mark.parametrize('mode', ['http400', pytest.param('hang', marks=pytest.mark.slow)])
def test_feature_queries_failing(ext, mock, mode):
    """AC-49: F1, F4 and F5 queries failing (HTTP 400 or timeout) never cause a full-panel error"""
    for op in ('DockerWebUi', 'ParityStatus', 'Temperature', 'DiskTempThresholds', 'DockerUpdates'):
        mock.fail(op, mode, 'mockField')
    mock.set_container('app-01', updateStatus='UPDATE_AVAILABLE')
    seed(ext, [server_entry('server-a', mock.url)])
    page = ext.open_popup()
    page.wait_dashboard(timeout=40 if mode == 'hang' else 15)

    view = page.view()
    assert view['message'] is None and view['strip'] is None
    assert len(page.docker_names()) == 31
    assert page.docker('app-02')['link'] == 'http://127.0.0.1:5678'
    labels = [label for label, _ in page.detail_rows('#cardArray')]
    assert labels == ['Capacity', 'Disks', 'Parity']
    assert 'Temp' not in [label for label, _ in page.detail_rows('#cardSystem')]
    assert page.exists(vm_row(mock.vm('vm-2')['id']))
