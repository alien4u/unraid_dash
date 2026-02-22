const runPopupLogic = async () => {

    if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
        window.chrome = browser;
    }

    const DEFAULT_LIST_SETTINGS = {
        sortMode: 'running-az',
        visibleCount: 6,
        customOrder: []
    };

    const DEFAULT_SETTINGS = {
        theme: 'light',
        refreshInterval: 60000,
        activeServerId: null,
        visibleCards: {
            system: true,
            array: true,
            docker: true,
            vms: true,
            notifications: true
        },
        collapsedCards: {
            system: false,
            array: false,
            docker: false,
            vms: false,
            notifications: false
        },
        listSettings: {
            docker: {...DEFAULT_LIST_SETTINGS},
            vms: {...DEFAULT_LIST_SETTINGS}
        }
    };

    const ERROR_MESSAGES = {
        AUTH_ERROR: 'Authentication failed. Check your API key.',
        UNREACHABLE: 'Server is unreachable. Check the URL and network.',
        TIMEOUT: 'Connection timed out. Server may be busy or offline.',
        NO_SERVER: 'No server configured.',
        INVALID_CONFIG: 'Invalid server configuration.'
    };

    const oSpinner = document.getElementById('spinner');
    const oMessage = document.getElementById('message');
    const oDashboard = document.getElementById('dashboard');
    const oServerTabs = document.getElementById('serverTabs');
    const oSettingsPanel = document.getElementById('settingsPanel');

    const oThemeToggle = document.getElementById('themeToggle');
    const oRefreshBtn = document.getElementById('refreshBtn');
    const oSettingsBtn = document.getElementById('settingsBtn');
    const oSettingsBack = document.getElementById('settingsBack');

    const oAddServerBtn = document.getElementById('addServerBtn');
    const oServerList = document.getElementById('serverList');
    const oServerForm = document.getElementById('serverForm');
    const oServerFormTitle = document.getElementById('serverFormTitle');
    const oServerFormId = document.getElementById('serverFormId');
    const oServerFormName = document.getElementById('serverFormName');
    const oServerFormUrl = document.getElementById('serverFormUrl');
    const oServerFormKey = document.getElementById('serverFormKey');
    const oTestConnectionBtn = document.getElementById('testConnectionBtn');
    const oTestResult = document.getElementById('testResult');
    const oCancelServerBtn = document.getElementById('cancelServerBtn');
    const oSaveServerBtn = document.getElementById('saveServerBtn');
    const oRefreshInterval = document.getElementById('refreshInterval');

    const oVisSystem = document.getElementById('visSystem');
    const oVisArray = document.getElementById('visArray');
    const oVisDocker = document.getElementById('visDocker');
    const oVisVMs = document.getElementById('visVMs');
    const oVisNotifications = document.getElementById('visNotifications');

    const oCardSystem = document.getElementById('cardSystem');
    const oCardArray = document.getElementById('cardArray');
    const oCardDocker = document.getElementById('cardDocker');
    const oCardVMs = document.getElementById('cardVMs');
    const oCardNotifications = document.getElementById('cardNotifications');

    const oListSettingsBackdrop = document.getElementById('listSettingsBackdrop');
    const oListSettingsTitle = document.getElementById('listSettingsTitle');
    const oListSettingsSort = document.getElementById('listSettingsSort');
    const oListSettingsCount = document.getElementById('listSettingsCount');
    const oListSettingsCustomSection = document.getElementById('listSettingsCustomSection');
    const oListSettingsCustomList = document.getElementById('listSettingsCustomList');
    const oListSettingsClose = document.getElementById('listSettingsClose');
    const oListSettingsCancel = document.getElementById('listSettingsCancel');
    const oListSettingsSave = document.getElementById('listSettingsSave');

    const oUrlModalBackdrop = document.getElementById('urlOverrideBackdrop');
    const oUrlModalName = document.getElementById('urlModalName');
    const oUrlModalDetected = document.getElementById('urlModalDetected');
    const oUrlModalCheckbox = document.getElementById('urlOverrideCheckbox');
    const oUrlModalInput = document.getElementById('urlOverrideInput');
    const oUrlModalClose = document.getElementById('urlModalClose');
    const oUrlModalCancel = document.getElementById('urlModalCancel');
    const oUrlModalSave = document.getElementById('urlModalSave');

    let aServers = [];
    let oSettings = {...DEFAULT_SETTINGS};
    let oCurrentData = null;
    let sActiveServerId = null;
    let nRefreshTimer = null;
    let bDockerExpanded = false;
    let bVMsExpanded = false;
    let bNotificationsExpanded = false;
    let aNotificationItems = [];
    let bNotificationsLoading = false;
    let oDockerUrlOverrides = {};
    let sUrlOverrideContainerId = null;
    let sListSettingsCardType = null;

    const loadStorage = async () => {

        const oResult = await new Promise((resolve) => {

            chrome.storage.local.get(['servers', 'settings', 'dockerUrlOverrides'], resolve);
        });

        aServers = oResult.servers || [];
        oSettings = {...DEFAULT_SETTINGS, ...oResult.settings};

        oSettings.visibleCards = {
            ...DEFAULT_SETTINGS.visibleCards,
            ...(oResult.settings?.visibleCards || {})
        };

        oSettings.collapsedCards = {
            ...DEFAULT_SETTINGS.collapsedCards,
            ...(oResult.settings?.collapsedCards || {})
        };

        const oStoredList = oResult.settings?.listSettings || {};
        oSettings.listSettings = {
            docker: {...DEFAULT_LIST_SETTINGS, ...(oStoredList.docker || {})},
            vms: {...DEFAULT_LIST_SETTINGS, ...(oStoredList.vms || {})}
        };

        oDockerUrlOverrides = oResult.dockerUrlOverrides || {};
        sActiveServerId = oSettings.activeServerId;

        if (aServers.length > 0 && !aServers.find((pS) => pS.id === sActiveServerId)) {
            sActiveServerId = aServers[0].id;
        }
    };

    const saveStorage = () => {

        return new Promise((resolve) => {

            chrome.storage.local.set({
                servers: aServers,
                settings: {
                    ...oSettings,
                    activeServerId: sActiveServerId
                }
            }, resolve);
        });
    };

    const getOverrideKey = (pContainerId) => {

        return sActiveServerId + '::' + pContainerId;
    };

    const saveOverrides = () => {

        return new Promise((resolve) => {

            chrome.storage.local.set({dockerUrlOverrides: oDockerUrlOverrides}, resolve);
        });
    };

    const applyTheme = () => {

        if (oSettings.theme === 'dark') {
            document.body.classList.add('theme-dark');
        } else {
            document.body.classList.remove('theme-dark');
        }
    };

    const showSpinner = () => {

        oSpinner.classList.remove('hidden');
        oSpinner.style.display = '';
        oMessage.style.display = 'none';
        oDashboard.style.display = 'none';
    };

    /**
     * Shows a message with trusted HTML. Only use for static templates,
     * never pass dynamic user/server data.
     */
    const showMessageHtml = (pHtml) => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oDashboard.style.display = 'none';
        oMessage.innerHTML = pHtml;
        oMessage.className = 'ut-message';
        oMessage.style.display = 'block';
    };

    const showMessageText = (pText, pIsError) => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oDashboard.style.display = 'none';
        oMessage.textContent = pText;
        oMessage.className = 'ut-message' + (pIsError ? ' ut-message-error' : '');
        oMessage.style.display = 'block';
    };

    const showDashboard = () => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oMessage.style.display = 'none';
        oDashboard.style.display = 'flex';
    };

    const getErrorMessage = (pError) => {

        if (!pError) {
            return 'An unknown error occurred.';
        }

        return ERROR_MESSAGES[pError] || pError;
    };

    const renderServerTabs = () => {

        const aEnabled = aServers.filter((pS) => pS.enabled !== false);

        if (aEnabled.length <= 1) {
            oServerTabs.style.display = 'none';
            return;
        }

        oServerTabs.style.display = 'flex';
        oServerTabs.innerHTML = '';

        aEnabled.forEach((pServer) => {

            const oBtn = document.createElement('button');
            oBtn.className = 'ut-tab' + (pServer.id === sActiveServerId ? ' active' : '');
            oBtn.textContent = pServer.name || pServer.url;
            oBtn.dataset.serverId = pServer.id;

            oBtn.addEventListener('click', () => {

                switchServer(pServer.id);
            });

            oServerTabs.appendChild(oBtn);
        });
    };

    const switchServer = (pServerId) => {

        sActiveServerId = pServerId;
        oSettings.activeServerId = pServerId;
        bDockerExpanded = false;
        bVMsExpanded = false;
        bNotificationsExpanded = false;
        aNotificationItems = [];

        saveStorage();
        renderServerTabs();
        fetchAndRender();
    };

    const fetchAndRender = () => {

        if (aServers.length === 0) {

            showMessageHtml(
                '<svg class="ut-message-icon"><use href="#ico-settings"/></svg>' +
                'No servers configured.<br><a id="openSettingsLink">Open Settings</a> to add your Unraid server.'
            );

            const oLink = document.getElementById('openSettingsLink');

            if (oLink) {

                oLink.addEventListener('click', () => {

                    openSettings();
                });
            }

            return;
        }

        showSpinner();

        chrome.runtime.sendMessage({
            action: 'fetchDashboard',
            serverId: sActiveServerId
        }, (pResponse) => {

            if (chrome.runtime.lastError) {

                showMessageText('Extension error: ' + chrome.runtime.lastError.message, true);
                return;
            }

            if (!pResponse) {

                showMessageText('No response from background service.', true);
                return;
            }

            if (pResponse.error) {

                showMessageText(getErrorMessage(pResponse.error), true);
                return;
            }

            oCurrentData = pResponse.data;
            renderDashboard();
        });
    };

    const renderDashboard = () => {

        if (!oCurrentData) {
            return;
        }

        showDashboard();

        const oVis = oSettings.visibleCards;

        oCardSystem.style.display = oVis.system ? '' : 'none';
        oCardArray.style.display = oVis.array ? '' : 'none';
        oCardDocker.style.display = oVis.docker ? '' : 'none';
        oCardVMs.style.display = oVis.vms ? '' : 'none';
        oCardNotifications.style.display = oVis.notifications ? '' : 'none';

        if (oVis.system) renderSystemCard();
        if (oVis.array) renderArrayCard();
        if (oVis.docker) renderDockerCard();
        if (oVis.vms) renderVMsCard();
        if (oVis.notifications) renderNotificationsCard();

        setupCollapsibleCards();
    };

    /* Notifications card handles its own collapse (see renderNotificationsCard)
       because it re-renders itself when expanding/collapsing the list */
    const setupCollapsibleCards = () => {

        const aCardDefs = [
            {el: oCardSystem, key: 'system'},
            {el: oCardArray, key: 'array'},
            {el: oCardDocker, key: 'docker'},
            {el: oCardVMs, key: 'vms'}
        ];

        aCardDefs.forEach((pCard) => {

            const oHeader = pCard.el.querySelector('.ut-card-header');

            if (!oHeader) {
                return;
            }

            if (!oHeader.querySelector('.ut-card-chevron')) {

                const oChevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                oChevron.setAttribute('class', 'ut-icon ut-card-chevron');

                const oUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                oUse.setAttribute('href', '#ico-chevron');
                oChevron.appendChild(oUse);
                oHeader.appendChild(oChevron);
            }

            if (oSettings.collapsedCards[pCard.key]) {
                pCard.el.classList.add('ut-card--collapsed');
            } else {
                pCard.el.classList.remove('ut-card--collapsed');
            }

            if (!oHeader.dataset.collapseBound) {
                oHeader.dataset.collapseBound = '1';
                oHeader.addEventListener('click', (pEvent) => {
                    if (pEvent.target.closest('button')) {
                        return;
                    }
                    toggleCard(pCard.key, pCard.el);
                });
            }
        });
    };

    const toggleCard = (pKey, pCardEl) => {

        const bCollapsed = !oSettings.collapsedCards[pKey];
        oSettings.collapsedCards[pKey] = bCollapsed;

        if (bCollapsed) {
            pCardEl.classList.add('ut-card--collapsed');
        } else {
            pCardEl.classList.remove('ut-card--collapsed');
        }

        saveStorage();
    };

    const renderSystemCard = () => {

        const oVars = oCurrentData.vars || {};
        const oInfo = oCurrentData.info || {};
        const oMetrics = oCurrentData.metrics || {};
        const oOS = oInfo.os || {};
        const oCPU = oInfo.cpu || {};
        const oMemMetrics = oMetrics.memory || {};

        const aAccessUrls = oCurrentData.network?.accessUrls || [];
        const oNet = aAccessUrls.find((pU) => pU.type === 'LAN') || aAccessUrls[0] || {};

        const sVersion = oVars.version || '?';
        const sName = oVars.name || 'Unraid';
        const sUptime = formatUptime(oOS.uptime);
        const sCPUBrand = oCPU.brand || 'Unknown CPU';
        const nCPUPercent = Math.round(oMetrics.cpu?.percentTotal || 0);

        const nMemTotal = Number(oMemMetrics.total) || 0;
        const nMemUsed = Number(oMemMetrics.used) || 0;
        const nMemPercent = Math.round(oMemMetrics.percentTotal || 0);

        oCardSystem.innerHTML =
            '<div class="ut-card-header">' +
                '<div class="ut-card-header-left">' +
                    '<svg class="ut-icon"><use href="#ico-system"/></svg>' +
                    '<span class="ut-card-title">System</span>' +
                '</div>' +
                '<span class="ut-card-badge">v' + escapeHtml(sVersion) + '</span>' +
            '</div>' +
            '<div class="ut-card-body">' +
                '<div class="ut-detail-row">' +
                    '<span class="ut-detail-label">Server</span>' +
                    '<span class="ut-detail-value">' + escapeHtml(sName) + '</span>' +
                '</div>' +
                '<div class="ut-detail-row">' +
                    '<span class="ut-detail-label">Uptime</span>' +
                    '<span class="ut-detail-value">' + escapeHtml(sUptime) + '</span>' +
                '</div>' +
                '<div class="ut-detail-row">' +
                    '<span class="ut-detail-label">CPU</span>' +
                    '<span class="ut-detail-value">' + escapeHtml(sCPUBrand) + '</span>' +
                '</div>' +
                (oNet.ipv4 ? '<div class="ut-detail-row">' +
                    '<span class="ut-detail-label">Network</span>' +
                    '<span class="ut-detail-value">' + escapeHtml(oNet.ipv4) + '</span>' +
                '</div>' : '') +
                '<div style="margin-top:8px;">' +
                    renderProgressBar('CPU', nCPUPercent) +
                    renderProgressBar('RAM', nMemPercent,
                        formatBytes(nMemUsed) + ' / ' + formatBytes(nMemTotal)) +
                '</div>' +
            '</div>';
    };

    const renderArrayCard = () => {

        const bArrayAvailable = oCurrentData.array !== null && oCurrentData.array !== undefined;

        if (!bArrayAvailable) {

            oCardArray.innerHTML =
                '<div class="ut-card-header">' +
                    '<div class="ut-card-header-left">' +
                        '<svg class="ut-icon"><use href="#ico-array"/></svg>' +
                        '<span class="ut-card-title">Array</span>' +
                    '</div>' +
                    '<span class="ut-card-badge">unavailable</span>' +
                '</div>' +
                '<div class="ut-card-body">' +
                    '<div class="ut-detail-row"><span class="ut-detail-label">Array data not available on this server</span></div>' +
                '</div>';
            return;
        }

        const oArray = oCurrentData.array;
        const sState = oArray.state || 'Unknown';
        const oCapacity = oArray.capacity?.kilobytes || {};
        const aParities = oArray.parities || [];
        const aDisks = oArray.disks || [];
        const aCaches = oArray.caches || [];

        const nTotalKB = Number(oCapacity.total) || 0;
        const nUsedKB = Number(oCapacity.used) || 0;
        const nPercent = nTotalKB > 0 ? Math.round((nUsedKB / nTotalKB) * 100) : 0;

        const nDiskOk = aDisks.filter((pD) => pD.status && pD.status !== 'DISK_NP').length;
        const nDiskErrors = aDisks.filter((pD) => pD.numErrors > 0).length;
        const nParityOk = aParities.filter((pP) => pP.status && pP.status !== 'DISK_NP').length;

        let sStateClass = 'running';

        if (sState !== 'STARTED') {
            sStateClass = sState === 'STOPPED' ? 'stopped' : 'warning';
        }

        oCardArray.innerHTML =
            '<div class="ut-card-header">' +
                '<div class="ut-card-header-left">' +
                    '<svg class="ut-icon"><use href="#ico-array"/></svg>' +
                    '<span class="ut-card-title">Array</span>' +
                '</div>' +
                '<span class="ut-card-badge">' +
                    '<span class="ut-status-dot ut-status-dot--' + sStateClass + '"></span>' +
                    escapeHtml(sState) +
                '</span>' +
            '</div>' +
            '<div class="ut-card-body">' +
                (nTotalKB > 0 ?
                    '<div class="ut-detail-row">' +
                        '<span class="ut-detail-label">Capacity</span>' +
                        '<span class="ut-detail-value">' +
                            formatBytes(nUsedKB * 1024) + ' / ' + formatBytes(nTotalKB * 1024) +
                        '</span>' +
                    '</div>' +
                    renderProgressBar('Used', nPercent) : '') +
                '<div class="ut-detail-row" style="margin-top:4px;">' +
                    '<span class="ut-detail-label">Disks</span>' +
                    '<span class="ut-detail-value">' + nDiskOk + ' active' +
                        (nDiskErrors > 0 ? ', <span style="color:var(--ut-status-error)">' + nDiskErrors + ' with errors</span>' : '') +
                    '</span>' +
                '</div>' +
                '<div class="ut-detail-row">' +
                    '<span class="ut-detail-label">Parity</span>' +
                    '<span class="ut-detail-value">' + nParityOk + ' active</span>' +
                '</div>' +
                renderDiskSection('Parity', aParities) +
                renderDiskSection('Disks', aDisks) +
                renderDiskSection('Cache', aCaches) +
            '</div>';
    };

    const renderDiskSection = (pTitle, pDisks) => {

        const aActive = pDisks.filter((pD) => pD.status && pD.status !== 'DISK_NP');

        if (aActive.length === 0) {
            return '';
        }

        let sHtml = '<div class="ut-disk-section">' +
            '<div class="ut-disk-section-title">' + escapeHtml(pTitle) + '</div>' +
            '<div class="ut-disk-grid">';

        aActive.forEach((pDisk) => {

            const sStatus = getDiskStatusClass(pDisk);
            const sName = pDisk.name || '?';

            let sTempHtml = '';
            let sTooltip = pDisk.temp != null ? escapeHtml(pDisk.temp) + '°C' : '';

            if (pDisk.temp != null) {
                sTempHtml = '<span class="ut-disk-chip-temp">' + escapeHtml(pDisk.temp) + '°C</span>';
            } else if (pDisk.isSpinning === false) {
                sTooltip = 'Standby';
            }

            if (pDisk.numErrors > 0) {
                sTooltip += (sTooltip ? ' · ' : '') + pDisk.numErrors + ' error' + (pDisk.numErrors !== 1 ? 's' : '');
            }

            sHtml += '<span class="ut-disk-chip"' +
                (sTooltip ? ' data-tooltip="' + sTooltip + '"' : '') + '>' +
                '<span class="ut-status-dot ut-status-dot--' + sStatus + '"></span>' +
                escapeHtml(sName) + sTempHtml +
                '</span>';
        });

        sHtml += '</div></div>';

        return sHtml;
    };

    const getDiskStatusClass = (pDisk) => {

        if (pDisk.numErrors > 0) {
            return 'error';
        }

        if (pDisk.status === 'DISK_OK') {
            return pDisk.isSpinning === false ? 'standby' : 'running';
        }

        if (pDisk.status === 'DISK_DSBL') {
            return 'stopped';
        }

        return 'warning';
    };

    const sortListItems = (pItems, pCardType, pFnName) => {

        const oLS = oSettings.listSettings[pCardType];
        const sSortMode = oLS.sortMode;

        const aSorted = [...pItems];

        if (sSortMode === 'az') {

            aSorted.sort((pA, pB) => pFnName(pA).localeCompare(pFnName(pB)));

        } else if (sSortMode === 'za') {

            aSorted.sort((pA, pB) => pFnName(pB).localeCompare(pFnName(pA)));

        } else if (sSortMode === 'custom') {

            const aOrder = oLS.customOrder;
            const oIndexMap = new Map();
            aOrder.forEach((pId, pIdx) => oIndexMap.set(pId, pIdx));

            aSorted.sort((pA, pB) => {

                const nIdxA = oIndexMap.has(pA.id) ? oIndexMap.get(pA.id) : Infinity;
                const nIdxB = oIndexMap.has(pB.id) ? oIndexMap.get(pB.id) : Infinity;

                if (nIdxA !== nIdxB) return nIdxA - nIdxB;

                return pFnName(pA).localeCompare(pFnName(pB));
            });

        } else {

            aSorted.sort((pA, pB) => {

                if (pA.state === 'RUNNING' && pB.state !== 'RUNNING') return -1;
                if (pA.state !== 'RUNNING' && pB.state === 'RUNNING') return 1;

                return pFnName(pA).localeCompare(pFnName(pB));
            });
        }

        return aSorted;
    };

    const getVisibleCount = (pCardType, pTotalCount) => {

        const nSetting = oSettings.listSettings[pCardType].visibleCount;

        return nSetting === 0 ? pTotalCount : nSetting;
    };

    const getVMName = (pVM) => pVM.name || pVM.id || '?';

    const openListSettingsModal = (pCardType) => {

        sListSettingsCardType = pCardType;

        const sLabel = pCardType === 'docker' ? 'Docker' : 'VM';
        oListSettingsTitle.textContent = sLabel + ' List Settings';

        const oLS = oSettings.listSettings[pCardType];
        oListSettingsSort.value = oLS.sortMode;
        oListSettingsCount.value = String(oLS.visibleCount);

        updateCustomOrderVisibility();
        oListSettingsBackdrop.style.display = 'flex';
    };

    const closeListSettingsModal = () => {

        oListSettingsBackdrop.style.display = 'none';
        sListSettingsCardType = null;
    };

    const updateCustomOrderVisibility = () => {

        const bCustom = oListSettingsSort.value === 'custom';
        oListSettingsCustomSection.style.display = bCustom ? '' : 'none';

        if (bCustom && sListSettingsCardType) {
            renderCustomOrderList(sListSettingsCardType);
        }
    };

    const renderCustomOrderList = (pCardType) => {

        let aItems = [];
        let fnName;

        if (pCardType === 'docker') {
            aItems = oCurrentData?.docker?.containers || [];
            fnName = getContainerName;
        } else {
            aItems = oCurrentData?.vms?.domains || [];
            fnName = getVMName;
        }

        const aExistingOrder = oSettings.listSettings[pCardType].customOrder;
        const oIdSet = new Set(aItems.map((pI) => pI.id));

        const aOrdered = [];
        const aUsed = new Set();

        aExistingOrder.forEach((pId) => {

            if (oIdSet.has(pId)) {
                aOrdered.push(pId);
                aUsed.add(pId);
            }
        });

        const aNew = aItems.filter((pI) => !aUsed.has(pI.id));
        aNew.sort((pA, pB) => fnName(pA).localeCompare(fnName(pB)));
        aNew.forEach((pI) => aOrdered.push(pI.id));

        const oItemMap = new Map();
        aItems.forEach((pI) => oItemMap.set(pI.id, pI));

        oListSettingsCustomList.innerHTML = '';

        aOrdered.forEach((pId) => {

            const oItem = oItemMap.get(pId);

            if (!oItem) return;

            const sName = fnName(oItem);
            const bRunning = oItem.state === 'RUNNING';
            const sStatusClass = bRunning ? 'running' : (oItem.state === 'PAUSED' ? 'paused' : 'stopped');

            const oRow = document.createElement('div');
            oRow.className = 'ut-drag-row';
            oRow.draggable = true;
            oRow.dataset.id = pId;
            oRow.innerHTML =
                '<span class="ut-drag-handle"><svg class="ut-icon"><use href="#ico-drag"/></svg></span>' +
                '<span class="ut-status-dot ut-status-dot--' + sStatusClass + '"></span>' +
                '<span class="ut-drag-name">' + escapeHtml(sName) + '</span>';

            oListSettingsCustomList.appendChild(oRow);
        });

        setupDragAndDrop();
    };

    const setupDragAndDrop = () => {

        let oDragRow = null;

        const aRows = oListSettingsCustomList.querySelectorAll('.ut-drag-row');

        aRows.forEach((pRow) => {

            pRow.addEventListener('dragstart', (pEvent) => {

                oDragRow = pRow;
                pRow.classList.add('dragging');
                pEvent.dataTransfer.effectAllowed = 'move';
            });

            pRow.addEventListener('dragend', () => {

                pRow.classList.remove('dragging');

                oListSettingsCustomList.querySelectorAll('.drag-over').forEach(
                    (pEl) => pEl.classList.remove('drag-over')
                );

                oDragRow = null;
            });

            pRow.addEventListener('dragover', (pEvent) => {

                pEvent.preventDefault();
                pEvent.dataTransfer.dropEffect = 'move';

                if (pRow !== oDragRow) {
                    pRow.classList.add('drag-over');
                }
            });

            pRow.addEventListener('dragleave', () => {

                pRow.classList.remove('drag-over');
            });

            pRow.addEventListener('drop', (pEvent) => {

                pEvent.preventDefault();
                pRow.classList.remove('drag-over');

                if (!oDragRow || oDragRow === pRow) return;

                const oRect = pRow.getBoundingClientRect();
                const nMidY = oRect.top + oRect.height / 2;

                if (pEvent.clientY < nMidY) {
                    oListSettingsCustomList.insertBefore(oDragRow, pRow);
                } else {
                    oListSettingsCustomList.insertBefore(oDragRow, pRow.nextSibling);
                }
            });
        });
    };

    const readCustomOrderFromDOM = () => {

        const aIds = [];

        oListSettingsCustomList.querySelectorAll('.ut-drag-row').forEach((pRow) => {

            aIds.push(pRow.dataset.id);
        });

        return aIds;
    };

    const saveListSettings = () => {

        if (!sListSettingsCardType) return;

        const sCardType = sListSettingsCardType;
        const oLS = oSettings.listSettings[sCardType];

        oLS.sortMode = oListSettingsSort.value;
        oLS.visibleCount = parseInt(oListSettingsCount.value, 10);

        if (oLS.sortMode === 'custom') {
            oLS.customOrder = readCustomOrderFromDOM();
        }

        closeListSettingsModal();
        saveStorage();

        if (sCardType === 'docker') {
            bDockerExpanded = false;
            renderDockerCard();
        } else {
            bVMsExpanded = false;
            renderVMsCard();
        }

        setupCollapsibleCards();
    };

    const renderDockerCard = () => {

        const bDockerAvailable = oCurrentData.docker !== null && oCurrentData.docker !== undefined;
        const aContainers = oCurrentData.docker?.containers || [];
        const nRunning = aContainers.filter((pC) => pC.state === 'RUNNING').length;
        const nTotal = aContainers.length;

        const aSorted = sortListItems(aContainers, 'docker', getContainerName);
        const nMaxVisible = getVisibleCount('docker', aSorted.length);
        const nVisible = bDockerExpanded ? aSorted.length : Math.min(aSorted.length, nMaxVisible);

        let sRows = '';

        for (let i = 0; i < nVisible; i++) {
            sRows += renderContainerRow(aSorted[i]);
        }

        const bShowMore = aSorted.length > nMaxVisible;

        let sBody;

        if (!bDockerAvailable) {
            sBody = '<div class="ut-detail-row"><span class="ut-detail-label">Docker service not enabled on this server</span></div>';
        } else if (nTotal === 0) {
            sBody = '<div class="ut-detail-row"><span class="ut-detail-label">No containers found</span></div>';
        } else {
            sBody = sRows +
                (bShowMore ? '<button class="ut-show-more" data-target="docker">' +
                    (bDockerExpanded ? 'Show less' : 'Show all ' + nTotal + '...') +
                '</button>' : '');
        }

        const sDockerGear = (bDockerAvailable && nTotal > 0)
            ? '<button class="ut-card-gear" data-action="openListSettings" data-card-type="docker" title="List settings">' +
                '<svg class="ut-icon"><use href="#ico-settings"/></svg>' +
              '</button>'
            : '';

        oCardDocker.innerHTML =
            '<div class="ut-card-header">' +
                '<div class="ut-card-header-left">' +
                    '<svg class="ut-icon"><use href="#ico-docker"/></svg>' +
                    '<span class="ut-card-title">Docker</span>' +
                '</div>' +
                '<div class="ut-card-header-right">' +
                    '<span class="ut-card-badge">' +
                        (bDockerAvailable ? nRunning + ' running / ' + nTotal + ' total' : 'unavailable') +
                    '</span>' +
                    sDockerGear +
                '</div>' +
            '</div>' +
            '<div class="ut-card-body">' + sBody + '</div>';

        const oShowMore = oCardDocker.querySelector('.ut-show-more');

        if (oShowMore) {

            oShowMore.addEventListener('click', () => {

                bDockerExpanded = !bDockerExpanded;
                renderDockerCard();
            });
        }

        if (bDockerAvailable) {
            bindContainerActions(oCardDocker);
        }

        const oDockerGearBtn = oCardDocker.querySelector('[data-action="openListSettings"]');

        if (oDockerGearBtn) {

            oDockerGearBtn.addEventListener('click', () => {

                openListSettingsModal('docker');
            });
        }

    };

    const getContainerName = (pContainer) => {

        if (pContainer.names && pContainer.names.length > 0) {
            return pContainer.names[0].replace(/^\//, '');
        }

        return pContainer.id ? pContainer.id.substring(0, 12) : '?';
    };

    const getAutoDetectedUrl = (pContainer) => {

        const aPorts = pContainer.ports || [];
        const oPort = aPorts.find((pP) => pP.publicPort && pP.type === 'TCP');

        if (!oPort) {
            return '';
        }

        const oServer = aServers.find((pS) => pS.id === sActiveServerId);

        if (!oServer) {
            return '';
        }

        try {

            const oUrl = new URL(oServer.url);
            const nPort = oPort.publicPort;
            const sProtocol = (nPort === 443 || nPort === 8443) ? 'https:' : 'http:';

            return sProtocol + '//' + oUrl.hostname + ':' + nPort;

        } catch (_) {
            return '';
        }
    };

    const getContainerUrl = (pContainer) => {

        const sKey = getOverrideKey(pContainer.id);
        const sOverride = oDockerUrlOverrides[sKey];

        if (sOverride) {
            return sOverride;
        }

        return getAutoDetectedUrl(pContainer);
    };

    const renderContainerRow = (pContainer) => {

        const sName = getContainerName(pContainer);
        const bRunning = pContainer.state === 'RUNNING';
        const sStatusClass = bRunning ? 'running' : (pContainer.state === 'PAUSED' ? 'paused' : 'stopped');
        const sActionIcon = bRunning ? '#ico-stop' : '#ico-play';
        const sActionTitle = bRunning ? 'Stop' : 'Start';
        const sCommand = bRunning ? 'stop' : 'start';
        const sWebUi = getContainerUrl(pContainer);
        const bHasOverride = !!oDockerUrlOverrides[getOverrideKey(pContainer.id)];

        const sNameHtml = sWebUi
            ? '<a class="ut-item-link" href="' + escapeHtml(sWebUi) + '" target="_blank" rel="noopener">' + escapeHtml(sName) + '</a>'
            : '<span>' + escapeHtml(sName) + '</span>';

        const sGearClass = 'ut-item-action' + (bHasOverride ? ' ut-item-action-url--active' : '');

        return '<div class="ut-item-row">' +
            '<div class="ut-item-name">' +
                '<span class="ut-status-dot ut-status-dot--' + sStatusClass + '"></span>' +
                sNameHtml +
            '</div>' +
            '<div class="ut-item-actions">' +
                '<button class="' + sGearClass + '" title="URL override" ' +
                    'data-action="openUrlOverride" data-id="' + escapeHtml(pContainer.id) + '">' +
                    '<svg class="ut-icon"><use href="#ico-settings"/></svg>' +
                '</button>' +
                '<button class="ut-item-action" title="' + sActionTitle + '" ' +
                    'data-action="controlDocker" data-id="' + escapeHtml(pContainer.id) + '" ' +
                    'data-command="' + sCommand + '">' +
                    '<svg class="ut-icon"><use href="' + sActionIcon + '"/></svg>' +
                '</button>' +
            '</div>' +
        '</div>';
    };

    const bindContainerActions = (pContainer) => {

        pContainer.querySelectorAll('[data-action="controlDocker"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                pBtn.disabled = true;

                chrome.runtime.sendMessage({
                    action: 'controlDocker',
                    serverId: sActiveServerId,
                    containerId: pBtn.dataset.id,
                    command: pBtn.dataset.command
                }, () => {

                    setTimeout(fetchAndRender, 1500);
                });
            });
        });

        pContainer.querySelectorAll('[data-action="openUrlOverride"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                openUrlOverrideModal(pBtn.dataset.id);
            });
        });
    };

    const openUrlOverrideModal = (pContainerId) => {

        sUrlOverrideContainerId = pContainerId;

        const aContainers = oCurrentData?.docker?.containers || [];
        const oContainer = aContainers.find((pC) => pC.id === pContainerId);
        const sName = oContainer ? getContainerName(oContainer) : pContainerId.substring(0, 12);
        const sDetected = oContainer ? getAutoDetectedUrl(oContainer) : '';
        const sKey = getOverrideKey(pContainerId);
        const sOverride = oDockerUrlOverrides[sKey] || '';

        oUrlModalName.textContent = sName;
        oUrlModalDetected.textContent = sDetected || 'No URL detected';
        oUrlModalCheckbox.checked = !!sOverride;
        oUrlModalInput.value = sOverride;
        oUrlModalInput.disabled = !sOverride;
        oUrlModalInput.classList.remove('ut-input--error');

        oUrlModalBackdrop.style.display = 'flex';
    };

    const closeUrlOverrideModal = () => {

        oUrlModalBackdrop.style.display = 'none';
        sUrlOverrideContainerId = null;
    };

    const saveUrlOverride = async () => {

        if (!sUrlOverrideContainerId) {
            return;
        }

        const sKey = getOverrideKey(sUrlOverrideContainerId);

        if (oUrlModalCheckbox.checked) {

            const sUrl = oUrlModalInput.value.trim();

            try {
                new URL(sUrl);
            } catch (_) {
                oUrlModalInput.classList.add('ut-input--error');
                setTimeout(() => oUrlModalInput.classList.remove('ut-input--error'), 600);
                return;
            }

            oDockerUrlOverrides[sKey] = sUrl;

        } else {

            delete oDockerUrlOverrides[sKey];
        }

        await saveOverrides();
        closeUrlOverrideModal();
        renderDockerCard();
    };

    const renderVMsCard = () => {

        const bVMsAvailable = oCurrentData.vms !== null && oCurrentData.vms !== undefined;
        const aVMs = oCurrentData.vms?.domains || [];
        const nRunning = aVMs.filter((pV) => pV.state === 'RUNNING').length;
        const nTotal = aVMs.length;

        const aSorted = sortListItems(aVMs, 'vms', getVMName);
        const nMaxVisible = getVisibleCount('vms', aSorted.length);
        const nVisible = bVMsExpanded ? aSorted.length : Math.min(aSorted.length, nMaxVisible);

        let sRows = '';

        for (let i = 0; i < nVisible; i++) {
            sRows += renderVMRow(aSorted[i]);
        }

        const bShowMore = aSorted.length > nMaxVisible;

        let sBody;

        if (!bVMsAvailable) {
            sBody = '<div class="ut-detail-row"><span class="ut-detail-label">VM service not enabled on this server</span></div>';
        } else if (nTotal === 0) {
            sBody = '<div class="ut-detail-row"><span class="ut-detail-label">No VMs found</span></div>';
        } else {
            sBody = sRows +
                (bShowMore ? '<button class="ut-show-more" data-target="vms">' +
                    (bVMsExpanded ? 'Show less' : 'Show all ' + nTotal + '...') +
                '</button>' : '');
        }

        const sVMGear = (bVMsAvailable && nTotal > 0)
            ? '<button class="ut-card-gear" data-action="openListSettings" data-card-type="vms" title="List settings">' +
                '<svg class="ut-icon"><use href="#ico-settings"/></svg>' +
              '</button>'
            : '';

        oCardVMs.innerHTML =
            '<div class="ut-card-header">' +
                '<div class="ut-card-header-left">' +
                    '<svg class="ut-icon"><use href="#ico-vm"/></svg>' +
                    '<span class="ut-card-title">VMs</span>' +
                '</div>' +
                '<div class="ut-card-header-right">' +
                    '<span class="ut-card-badge">' +
                        (bVMsAvailable ? nRunning + ' running / ' + nTotal + ' total' : 'unavailable') +
                    '</span>' +
                    sVMGear +
                '</div>' +
            '</div>' +
            '<div class="ut-card-body">' + sBody + '</div>';

        const oShowMore = oCardVMs.querySelector('.ut-show-more');

        if (oShowMore) {

            oShowMore.addEventListener('click', () => {

                bVMsExpanded = !bVMsExpanded;
                renderVMsCard();
            });
        }

        bindVMActions(oCardVMs);

        const oVMGearBtn = oCardVMs.querySelector('[data-action="openListSettings"]');

        if (oVMGearBtn) {

            oVMGearBtn.addEventListener('click', () => {

                openListSettingsModal('vms');
            });
        }

    };

    const renderVMRow = (pVM) => {

        const sName = pVM.name || pVM.id || '?';
        const bRunning = pVM.state === 'RUNNING';
        const sStatusClass = bRunning ? 'running' : (pVM.state === 'PAUSED' ? 'paused' : 'stopped');
        const sActionIcon = bRunning ? '#ico-stop' : '#ico-play';
        const sActionTitle = bRunning ? 'Stop' : 'Start';
        const sCommand = bRunning ? 'stop' : 'start';

        return '<div class="ut-item-row">' +
            '<div class="ut-item-name">' +
                '<span class="ut-status-dot ut-status-dot--' + sStatusClass + '"></span>' +
                '<span>' + escapeHtml(sName) + '</span>' +
            '</div>' +
            '<button class="ut-item-action" title="' + sActionTitle + '" ' +
                'data-action="controlVM" data-id="' + escapeHtml(pVM.id) + '" ' +
                'data-command="' + sCommand + '">' +
                '<svg class="ut-icon"><use href="' + sActionIcon + '"/></svg>' +
            '</button>' +
        '</div>';
    };

    const bindVMActions = (pContainer) => {

        pContainer.querySelectorAll('[data-action="controlVM"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                pBtn.disabled = true;

                chrome.runtime.sendMessage({
                    action: 'controlVM',
                    serverId: sActiveServerId,
                    vmId: pBtn.dataset.id,
                    command: pBtn.dataset.command
                }, () => {

                    setTimeout(fetchAndRender, 2000);
                });
            });
        });
    };

    const renderNotificationsCard = () => {

        const oNotifs = oCurrentData.notifications?.overview?.unread || {};
        const nTotal = oNotifs.total || 0;
        const nInfo = oNotifs.info || 0;
        const nWarning = oNotifs.warning || 0;
        const nAlert = oNotifs.alert || 0;

        let sSummary = '';

        if (nTotal === 0) {

            sSummary = '<div class="ut-detail-row"><span class="ut-detail-label">No unread notifications</span></div>';

        } else {

            if (nAlert > 0) {
                sSummary += '<div class="ut-notif-row">' +
                    '<svg class="ut-notif-icon ut-notif-icon--alert"><use href="#ico-warning"/></svg>' +
                    '<span class="ut-notif-count">' + nAlert + '</span>' +
                    '<span class="ut-notif-label">alert' + (nAlert !== 1 ? 's' : '') + '</span>' +
                '</div>';
            }

            if (nWarning > 0) {
                sSummary += '<div class="ut-notif-row">' +
                    '<svg class="ut-notif-icon ut-notif-icon--warning"><use href="#ico-warning"/></svg>' +
                    '<span class="ut-notif-count">' + nWarning + '</span>' +
                    '<span class="ut-notif-label">warning' + (nWarning !== 1 ? 's' : '') + '</span>' +
                '</div>';
            }

            if (nInfo > 0) {
                sSummary += '<div class="ut-notif-row">' +
                    '<svg class="ut-notif-icon ut-notif-icon--info"><use href="#ico-info"/></svg>' +
                    '<span class="ut-notif-count">' + nInfo + '</span>' +
                    '<span class="ut-notif-label">info</span>' +
                '</div>';
            }
        }

        let sListHtml = '';

        if (bNotificationsExpanded) {

            if (bNotificationsLoading) {

                sListHtml = '<div class="ut-notif-list-loading">Loading notifications...</div>';

            } else if (aNotificationItems.length > 0) {

                sListHtml = '<div class="ut-notif-list">';

                aNotificationItems.forEach((pNotif) => {

                    const sImportance = (pNotif.importance || 'INFO').toUpperCase();
                    let sIconClass = 'info';
                    let sIconRef = '#ico-info';

                    if (sImportance === 'ALERT') {
                        sIconClass = 'alert';
                        sIconRef = '#ico-warning';
                    } else if (sImportance === 'WARNING') {
                        sIconClass = 'warning';
                        sIconRef = '#ico-warning';
                    }

                    const sTitle = pNotif.title || pNotif.subject || 'Notification';
                    const sSubject = pNotif.subject && pNotif.title ? pNotif.subject : '';
                    const sTime = formatTimestamp(pNotif.timestamp);

                    sListHtml += '<div class="ut-notif-item">' +
                        '<div class="ut-notif-item-header">' +
                            '<svg class="ut-notif-icon ut-notif-icon--' + sIconClass + '"><use href="' + sIconRef + '"/></svg>' +
                            '<span class="ut-notif-item-title">' + escapeHtml(sTitle) + '</span>' +
                            '<button class="ut-notif-archive-btn" data-action="archiveNotification" ' +
                                'data-id="' + escapeHtml(pNotif.id) + '" title="Archive">' +
                                '<svg class="ut-icon"><use href="#ico-check"/></svg>' +
                            '</button>' +
                        '</div>' +
                        (sSubject ? '<div class="ut-notif-item-subject">' + escapeHtml(sSubject) + '</div>' : '') +
                        (sTime ? '<div class="ut-notif-item-time">' + escapeHtml(sTime) + '</div>' : '') +
                    '</div>';
                });

                sListHtml += '</div>';

            } else {

                sListHtml = '<div class="ut-notif-list-loading">No notification details available</div>';
            }
        }

        oCardNotifications.innerHTML =
            '<div class="ut-card-header">' +
                '<div class="ut-card-header-left">' +
                    '<svg class="ut-icon"><use href="#ico-bell"/></svg>' +
                    '<span class="ut-card-title">Notifications</span>' +
                '</div>' +
                '<div class="ut-card-header-right">' +
                    '<span class="ut-card-badge">' + nTotal + ' unread</span>' +
                    (nTotal > 0 ? '<button class="ut-notif-header-archive" data-action="archiveAll" title="Archive all notifications">' +
                        '<svg class="ut-icon"><use href="#ico-check"/></svg>' +
                        '<span>Archive All</span>' +
                    '</button>' : '') +
                '</div>' +
                '<svg class="ut-icon ut-card-chevron"><use href="#ico-chevron"/></svg>' +
            '</div>' +
            '<div class="ut-card-body">' +
                (nTotal > 0 ? '<div class="ut-notif-summary">' + sSummary + '</div>' : sSummary) +
                sListHtml +
            '</div>';

        if (oSettings.collapsedCards.notifications) {
            oCardNotifications.classList.add('ut-card--collapsed');
        } else {
            oCardNotifications.classList.remove('ut-card--collapsed');
        }

        const oNotifHeader = oCardNotifications.querySelector('.ut-card-header');

        if (oNotifHeader) {

            oNotifHeader.addEventListener('click', (pEvent) => {

                if (pEvent.target.closest('button')) {
                    return;
                }

                toggleCard('notifications', oCardNotifications);
            });
        }

        const oSummary = oCardNotifications.querySelector('.ut-notif-summary');

        if (oSummary) {

            oSummary.addEventListener('click', () => {

                bNotificationsExpanded = !bNotificationsExpanded;

                if (bNotificationsExpanded && aNotificationItems.length === 0) {
                    fetchNotificationList();
                } else {
                    renderNotificationsCard();
                }
            });
        }

        bindNotificationActions(oCardNotifications);

    };

    const fetchNotificationList = () => {

        bNotificationsLoading = true;
        renderNotificationsCard();

        chrome.runtime.sendMessage({
            action: 'fetchNotifications',
            serverId: sActiveServerId,
            filter: {type: 'UNREAD', offset: 0, limit: 50}
        }, (pResponse) => {

            bNotificationsLoading = false;

            if (chrome.runtime.lastError) {
                console.warn('fetchNotifications error:', chrome.runtime.lastError.message);
                renderNotificationsCard();
                return;
            }

            if (pResponse?.data) {
                aNotificationItems = pResponse.data;
            }

            renderNotificationsCard();
        });
    };

    const bindNotificationActions = (pContainer) => {

        pContainer.querySelectorAll('[data-action="archiveNotification"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                pBtn.disabled = true;

                chrome.runtime.sendMessage({
                    action: 'archiveNotification',
                    serverId: sActiveServerId,
                    notificationId: pBtn.dataset.id
                }, (pResponse) => {

                    if (chrome.runtime.lastError) {
                        console.warn('archiveNotification error:', chrome.runtime.lastError.message);
                        pBtn.disabled = false;
                        return;
                    }

                    if (pResponse?.success) {

                        aNotificationItems = aNotificationItems.filter((pN) => pN.id !== pBtn.dataset.id);
                        fetchAndRender();
                    } else {
                        pBtn.disabled = false;
                    }
                });
            });
        });

        const oArchiveAll = pContainer.querySelector('[data-action="archiveAll"]');

        if (oArchiveAll) {

            oArchiveAll.addEventListener('click', () => {

                oArchiveAll.disabled = true;

                const oLabel = oArchiveAll.querySelector('span');

                if (oLabel) {
                    oLabel.textContent = 'Archiving...';
                }

                chrome.runtime.sendMessage({
                    action: 'archiveAll',
                    serverId: sActiveServerId
                }, (pResponse) => {

                    if (chrome.runtime.lastError) {
                        console.warn('archiveAll error:', chrome.runtime.lastError.message);
                        oArchiveAll.disabled = false;
                        if (oLabel) oLabel.textContent = 'Archive All';
                        return;
                    }

                    if (pResponse?.success) {

                        aNotificationItems = [];
                        bNotificationsExpanded = false;
                        fetchAndRender();
                    } else {
                        oArchiveAll.disabled = false;
                        if (oLabel) oLabel.textContent = 'Archive All';
                    }
                });
            });
        }
    };

    const formatTimestamp = (pTimestamp) => {

        if (!pTimestamp) {
            return '';
        }

        try {

            const oDate = new Date(pTimestamp);

            if (isNaN(oDate.getTime())) {
                return '';
            }

            const oNow = new Date();
            const nDiffMs = oNow - oDate;
            const nDiffMins = Math.floor(nDiffMs / 60000);

            if (nDiffMins < 1) return 'just now';
            if (nDiffMins < 60) return nDiffMins + 'm ago';

            const nDiffHours = Math.floor(nDiffMins / 60);
            if (nDiffHours < 24) return nDiffHours + 'h ago';

            const nDiffDays = Math.floor(nDiffHours / 24);
            if (nDiffDays < 7) return nDiffDays + 'd ago';

            return oDate.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});

        } catch (_) {
            return '';
        }
    };

    const renderProgressBar = (pLabel, pPercent, pTooltip) => {

        let sClass = '';

        if (pPercent >= 90) {
            sClass = ' danger';
        } else if (pPercent >= 75) {
            sClass = ' warn';
        }

        return '<div class="ut-progress-row"' + (pTooltip ? ' title="' + escapeHtml(pTooltip) + '"' : '') + '>' +
            '<span class="ut-progress-label">' + escapeHtml(pLabel) + '</span>' +
            '<div class="ut-progress-bar">' +
                '<div class="ut-progress-fill' + sClass + '" style="width:' + pPercent + '%;"></div>' +
            '</div>' +
            '<span class="ut-progress-value">' + pPercent + '%</span>' +
        '</div>';
    };

    /**
     * Accepts either seconds (number) or an ISO boot-time string.
     * Unraid API returns boot time as ISO string, so we calculate
     * elapsed seconds from boot to now.
     */
    const formatUptime = (pUptime) => {

        if (!pUptime) {
            return '—';
        }

        let nSeconds;

        if (typeof pUptime === 'string') {

            const nBootTime = Date.parse(pUptime);

            if (isNaN(nBootTime)) {

                nSeconds = parseInt(pUptime, 10);

                if (isNaN(nSeconds)) {
                    return '—';
                }

            } else {

                nSeconds = Math.floor((Date.now() - nBootTime) / 1000);
            }

        } else {

            nSeconds = pUptime;
        }

        if (nSeconds <= 0) {
            return '—';
        }

        const nDays = Math.floor(nSeconds / 86400);
        const nHours = Math.floor((nSeconds % 86400) / 3600);
        const nMinutes = Math.floor((nSeconds % 3600) / 60);

        const aParts = [];

        if (nDays > 0) aParts.push(nDays + 'd');
        if (nHours > 0) aParts.push(nHours + 'h');
        if (nMinutes > 0 && nDays === 0) aParts.push(nMinutes + 'm');

        return aParts.join(' ') || '< 1m';
    };

    const formatBytes = (pBytes) => {

        if (!pBytes || pBytes <= 0) {
            return '0 B';
        }

        const aUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let nIndex = 0;
        let nValue = pBytes;

        while (nValue >= 1024 && nIndex < aUnits.length - 1) {
            nValue /= 1024;
            nIndex++;
        }

        return nValue.toFixed(nIndex > 0 ? 1 : 0) + ' ' + aUnits[nIndex];
    };

    const escapeHtml = (pStr) => {

        if (pStr == null) {
            return '';
        }

        return String(pStr)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    };

    const openSettings = () => {

        oSettingsPanel.style.display = 'block';
        oServerForm.style.display = 'none';
        renderServerList();
        applySettingsValues();
    };

    const closeSettings = () => {

        oSettingsPanel.style.display = 'none';
        oServerForm.style.display = 'none';

        renderServerTabs();
        fetchAndRender();
        setupAutoRefresh();
    };

    const applySettingsValues = () => {

        oRefreshInterval.value = String(oSettings.refreshInterval);
        oVisSystem.checked = oSettings.visibleCards.system;
        oVisArray.checked = oSettings.visibleCards.array;
        oVisDocker.checked = oSettings.visibleCards.docker;
        oVisVMs.checked = oSettings.visibleCards.vms;
        oVisNotifications.checked = oSettings.visibleCards.notifications;
    };

    const renderServerList = () => {

        if (aServers.length === 0) {

            oServerList.innerHTML = '<div class="ut-server-list-empty">No servers added yet</div>';
            return;
        }

        oServerList.innerHTML = '';

        aServers.forEach((pServer) => {

            const oItem = document.createElement('div');
            oItem.className = 'ut-server-item';
            oItem.innerHTML =
                '<div class="ut-server-item-info">' +
                    '<div class="ut-server-item-name">' + escapeHtml(pServer.name || 'Unnamed') + '</div>' +
                    '<div class="ut-server-item-url">' + escapeHtml(pServer.url) + '</div>' +
                '</div>' +
                '<div class="ut-server-item-actions">' +
                    '<button class="ut-icon-btn edit-server" data-id="' + escapeHtml(pServer.id) + '" title="Edit">' +
                        '<svg class="ut-icon"><use href="#ico-edit"/></svg>' +
                    '</button>' +
                    '<button class="ut-icon-btn delete ut-icon-btn-delete" data-id="' + escapeHtml(pServer.id) + '" title="Delete">' +
                        '<svg class="ut-icon"><use href="#ico-trash"/></svg>' +
                    '</button>' +
                '</div>';

            oServerList.appendChild(oItem);
        });

        oServerList.querySelectorAll('.edit-server').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                const oServer = aServers.find((pS) => pS.id === pBtn.dataset.id);

                if (oServer) {
                    openServerForm(oServer);
                }
            });
        });

        oServerList.querySelectorAll('.ut-icon-btn-delete').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                aServers = aServers.filter((pS) => pS.id !== pBtn.dataset.id);

                if (sActiveServerId === pBtn.dataset.id && aServers.length > 0) {
                    sActiveServerId = aServers[0].id;
                }

                saveStorage();
                renderServerList();
            });
        });
    };

    const openServerForm = (pServer) => {

        oServerForm.style.display = 'block';
        oTestResult.style.display = 'none';

        if (pServer) {

            oServerFormTitle.textContent = 'Edit Server';
            oServerFormId.value = pServer.id;
            oServerFormName.value = pServer.name || '';
            oServerFormUrl.value = pServer.url || '';
            oServerFormKey.value = pServer.apiKey || '';

        } else {

            oServerFormTitle.textContent = 'Add Server';
            oServerFormId.value = '';
            oServerFormName.value = '';
            oServerFormUrl.value = '';
            oServerFormKey.value = '';
        }

        oServerFormName.focus();
    };

    const closeServerForm = () => {

        oServerForm.style.display = 'none';
        oTestResult.style.display = 'none';
    };

    const requestHostPermission = (pUrl) => {

        return new Promise((resolve) => {

            try {

                const oUrl = new URL(pUrl);
                const sOrigin = oUrl.origin + '/*';

                chrome.permissions.request({origins: [sOrigin]}, (pGranted) => {

                    resolve(!!pGranted);
                });

            } catch (_) {

                resolve(false);
            }
        });
    };

    /**
     * Save happens FIRST because chrome.permissions.request() may
     * close the popup, killing any async code that follows.
     */
    const saveServerForm = async () => {

        const sName = oServerFormName.value.trim();
        const sUrl = oServerFormUrl.value.trim().replace(/\/+$/, '');
        const sKey = oServerFormKey.value.trim();

        if (!sName || !sUrl || !sKey) {

            showTestResult('Please fill in all fields.', false);
            return;
        }

        try {
            new URL(sUrl);
        } catch (_) {
            showTestResult('Invalid URL format.', false);
            return;
        }

        const sId = oServerFormId.value || ('server-' + Date.now());
        const nExisting = aServers.findIndex((pS) => pS.id === sId);

        const oServer = {
            id: sId,
            name: sName,
            url: sUrl,
            apiKey: sKey,
            enabled: true
        };

        if (nExisting >= 0) {
            aServers[nExisting] = oServer;
        } else {
            aServers.push(oServer);
        }

        if (!sActiveServerId) {
            sActiveServerId = sId;
        }

        await saveStorage();

        /* Permission prompt may close the popup and kill this function.
           On next open the server will already be saved in storage. */
        const bGranted = await requestHostPermission(sUrl);

        if (!bGranted) {

            aServers = aServers.filter((pS) => pS.id !== sId);

            if (sActiveServerId === sId) {
                sActiveServerId = aServers.length > 0 ? aServers[0].id : null;
            }

            await saveStorage();
            showTestResult('Host permission denied. The extension needs access to connect to this server.', false);
            return;
        }

        closeServerForm();
        renderServerList();
    };

    const showTestResult = (pText, pSuccess) => {

        oTestResult.textContent = pText;
        oTestResult.className = 'ut-test-result ' + (pSuccess ? 'success' : 'error');
        oTestResult.style.display = 'block';
    };

    const setupAutoRefresh = () => {

        if (nRefreshTimer) {
            clearInterval(nRefreshTimer);
            nRefreshTimer = null;
        }

        const nInterval = oSettings.refreshInterval;

        if (nInterval > 0 && aServers.length > 0) {

            nRefreshTimer = setInterval(() => {

                if (oSettingsPanel.style.display === 'none') {
                    fetchAndRender();
                }

            }, nInterval);
        }
    };

    oThemeToggle.addEventListener('click', () => {

        oSettings.theme = oSettings.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        saveStorage();
    });

    oRefreshBtn.addEventListener('click', () => {

        oRefreshBtn.classList.add('spinning');
        fetchAndRender();

        setTimeout(() => {

            oRefreshBtn.classList.remove('spinning');
        }, 800);
    });

    oSettingsBtn.addEventListener('click', openSettings);
    oSettingsBack.addEventListener('click', closeSettings);

    oAddServerBtn.addEventListener('click', () => {

        openServerForm();
    });

    oCancelServerBtn.addEventListener('click', closeServerForm);

    oSaveServerBtn.addEventListener('click', saveServerForm);

    oTestConnectionBtn.addEventListener('click', () => {

        const sUrl = oServerFormUrl.value.trim().replace(/\/+$/, '');
        const sKey = oServerFormKey.value.trim();

        if (!sUrl || !sKey) {

            showTestResult('URL and API key are required.', false);
            return;
        }

        oTestConnectionBtn.disabled = true;
        oTestConnectionBtn.textContent = 'Testing...';

        chrome.runtime.sendMessage({
            action: 'testConnection',
            server: {url: sUrl, apiKey: sKey}
        }, (pResponse) => {

            oTestConnectionBtn.disabled = false;
            oTestConnectionBtn.textContent = 'Test Connection';

            if (pResponse?.success) {

                showTestResult('Connected to ' + pResponse.name + ' (v' + pResponse.version + ')', true);

            } else {

                showTestResult(getErrorMessage(pResponse?.error), false);
            }
        });
    });

    oRefreshInterval.addEventListener('change', () => {

        oSettings.refreshInterval = parseInt(oRefreshInterval.value, 10);
        saveStorage();
        setupAutoRefresh();
    });

    const bindVisibilityToggle = (pCheckbox, pKey) => {

        pCheckbox.addEventListener('change', () => {

            oSettings.visibleCards[pKey] = pCheckbox.checked;
            saveStorage();
        });
    };

    bindVisibilityToggle(oVisSystem, 'system');
    bindVisibilityToggle(oVisArray, 'array');
    bindVisibilityToggle(oVisDocker, 'docker');
    bindVisibilityToggle(oVisVMs, 'vms');
    bindVisibilityToggle(oVisNotifications, 'notifications');

    oUrlModalClose.addEventListener('click', closeUrlOverrideModal);
    oUrlModalCancel.addEventListener('click', closeUrlOverrideModal);
    oUrlModalSave.addEventListener('click', saveUrlOverride);

    oUrlModalBackdrop.addEventListener('click', (pEvent) => {

        if (pEvent.target === oUrlModalBackdrop) {
            closeUrlOverrideModal();
        }
    });

    oUrlModalCheckbox.addEventListener('change', () => {

        oUrlModalInput.disabled = !oUrlModalCheckbox.checked;

        if (oUrlModalCheckbox.checked) {
            oUrlModalInput.focus();
        }
    });

    oListSettingsClose.addEventListener('click', closeListSettingsModal);
    oListSettingsCancel.addEventListener('click', closeListSettingsModal);
    oListSettingsSave.addEventListener('click', saveListSettings);

    oListSettingsBackdrop.addEventListener('click', (pEvent) => {

        if (pEvent.target === oListSettingsBackdrop) {
            closeListSettingsModal();
        }
    });

    oListSettingsSort.addEventListener('change', updateCustomOrderVisibility);

    await loadStorage();
    applyTheme();
    renderServerTabs();
    fetchAndRender();
    setupAutoRefresh();
};

document.addEventListener('DOMContentLoaded', () => {

    runPopupLogic();
});
