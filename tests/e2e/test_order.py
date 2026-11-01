"""MJ-006: custom order per server (AC-50, AC-65, AC-66)."""

from helpers import seed, server_entry, stored

DRAG_JS = '''(pFrom, pBefore) => {
    const oList = document.getElementById('listSettingsCustomList');
    const oSource = oList.querySelector(`.ut-drag-row[data-id="${pFrom}"]`);
    const oTarget = oList.querySelector(`.ut-drag-row[data-id="${pBefore}"]`);
    const oData = new DataTransfer();
    const fnFire = (pEl, pType, pY) => pEl.dispatchEvent(new DragEvent(pType,
        {bubbles: true, cancelable: true, dataTransfer: oData, clientY: pY}));
    const nTop = oTarget.getBoundingClientRect().top + 1;
    fnFire(oSource, 'dragstart', nTop);
    fnFire(oTarget, 'dragover', nTop);
    fnFire(oTarget, 'drop', nTop);
    fnFire(oSource, 'dragend', nTop);
}'''


def drag_rows(page):
    return page.eval("() => [...document.querySelectorAll('#listSettingsCustomList .ut-drag-row')].map((pR) => pR.dataset.id)")


def reorder(page, card, moves):
    """Opens the card's list settings, switches to Custom order, drags each item before another (None = the
    first row) and saves. The drag is dispatched as DragEvents on the rows, the events a mouse drag fires."""
    page.click(f'#{card} [data-action="openListSettings"]')
    page.select('#listSettingsSort', 'custom')
    page.wait(lambda: drag_rows(page), 5, 'custom order list')
    for item, before in moves:
        page.eval(DRAG_JS, item, before or drag_rows(page)[0])
    order = drag_rows(page)
    page.click('#listSettingsSave')
    return order


def switch(page, server_id, name):
    page.click(f'#serverTabs .ut-tab[data-server-id="{server_id}"]')
    page.wait(lambda: (page.text('#cardSystem .ut-server-link') or '').strip() == name, 15, f'{name} dashboard')


def two_servers(ext, mock, mock_b, **settings):
    mock.patch('Core', 'vars.name', 'TowerA')
    mock_b.patch('Core', 'vars.name', 'TowerB')
    seed(ext, [server_entry('server-a', mock.url, name='Tower A'), server_entry('server-b', mock_b.url, name='Tower B')],
         **settings)


def test_custom_order_per_server(ext, mock, mock_b):
    """AC-50: Docker and VM custom orders are kept per server"""
    two_servers(ext, mock, mock_b)
    page = ext.open_popup()
    page.wait_dashboard()

    order_a = reorder(page, 'cardDocker', [('app-05', 'app-01')])
    assert order_a[0] == 'app-05' and page.docker_names() == order_a
    vm_ids = {vm['name']: vm['id'] for vm in (mock.vm('vm-1'), mock.vm('vm-2'))}
    vm_order_a = reorder(page, 'cardVMs', [(vm_ids['vm-2'], vm_ids['vm-1'])])
    assert page.vm_names() == ['vm-2', 'vm-1']

    switch(page, 'server-b', 'TowerB')
    order_b = reorder(page, 'cardDocker', [('app-07', None)])
    assert order_b[0] == 'app-07' and page.docker_names() == order_b
    reorder(page, 'cardVMs', [(vm_ids['vm-1'], vm_ids['vm-2'])])
    assert page.vm_names() == ['vm-1', 'vm-2']

    switch(page, 'server-a', 'TowerA')
    assert page.docker_names() == order_a
    assert page.vm_names() == ['vm-2', 'vm-1']
    orders = stored(ext, 'settings')['customOrders']
    assert orders['server-a'] == {'docker': order_a, 'vms': vm_order_a}
    assert orders['server-b']['docker'] == order_b
    list_settings = stored(ext, 'settings')['listSettings']
    assert list_settings['docker']['sortMode'] == 'custom' and list_settings['docker']['visibleCount'] == 0


LEGACY = ['app-05', 'app-01', 'app-12']


def legacy_settings():
    return {'listSettings': {'docker': {'sortMode': 'custom', 'visibleCount': 0, 'customOrder': list(LEGACY)},
                             'vms': {'sortMode': 'running-az', 'visibleCount': 0, 'customOrder': []}}}


def test_upgrade_single_server(ext, mock):
    """AC-65: an existing v1.2.0 custom order shows unchanged"""
    seed(ext, [server_entry('server-a', mock.url)], **legacy_settings())
    page = ext.open_popup()
    page.wait_dashboard()
    names = page.docker_names()
    assert names[:3] == LEGACY
    assert names[3:] == sorted(names[3:])


def test_upgrade_multi_server(ext, mock, mock_b):
    """AC-66: every server starts from the legacy order; changing one leaves the other"""
    two_servers(ext, mock, mock_b, **legacy_settings())
    page = ext.open_popup()
    page.wait_dashboard()
    assert page.docker_names()[:3] == LEGACY
    switch(page, 'server-b', 'TowerB')
    assert page.docker_names()[:3] == LEGACY

    order_b = reorder(page, 'cardDocker', [('app-20', 'app-05')])
    assert order_b[0] == 'app-20'
    switch(page, 'server-a', 'TowerA')
    assert page.docker_names()[:3] == LEGACY
