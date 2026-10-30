/** Initializes the popup UI, loads settings, and starts the dashboard */
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
        compactMode: false,
        refreshInterval: 60000,
        activeServerId: null,
        popupWidth: 420,
        popupHeight: 0,
        cardOrder: ['system', 'array', 'docker', 'vms', 'notifications'],
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
        },
        customOrders: {}
    };

    const oFooterVersion = document.getElementById('footerVersion');
    if (oFooterVersion) {
        oFooterVersion.textContent = 'Unraid Dash v' + chrome.runtime.getManifest().version;
    }

    const ERROR_MESSAGES = {
        AUTH_ERROR: 'Authentication failed. Check your API key in Settings, then try Refresh.',
        UNREACHABLE: 'Server is unreachable. Verify the URL is correct and the server is online, then try Refresh.',
        TIMEOUT: 'Connection timed out. The server may be busy or offline. Try clicking Refresh.',
        NO_SERVER: 'No server configured.',
        KEY_MISSING: 'API key is missing. Add one in Settings for this server.',
        INVALID_CONFIG: 'Invalid server configuration. Edit the server in Settings.',
        PERMISSION_DENIED: 'This API key does not have permission. Use an admin API key for full control.'
    };

    const PENDING_LABELS = {
        start: 'Starting...',
        stop: 'Stopping...',
        pause: 'Pausing...',
        resume: 'Resuming...',
        restart: 'Restarting...',
        update: 'Updating...'
    };

    /* A polled action is done once a status check reports one of these states.
       Restart and update are resolved differently (runItemAction, runStatusCheck). */
    const TARGET_STATES = {
        start: ['RUNNING'],
        resume: ['RUNNING'],
        pause: ['PAUSED'],
        stop: ['EXITED', 'SHUTOFF', 'SHUTDOWN']
    };

    const TOGGLE_BUTTONS = {
        start: {sTitle: 'Start', sIcon: '#ico-play'},
        stop: {sTitle: 'Stop', sIcon: '#ico-stop'},
        resume: {sTitle: 'Resume', sIcon: '#ico-resume'}
    };

    const MENU_ITEMS = {
        restart: {sTitle: 'Restart', sIcon: '#ico-restart'},
        pause: {sTitle: 'Pause', sIcon: '#ico-pause'}
    };

    const TEMP_UNITS = {CELSIUS: '\u00B0C', FAHRENHEIT: '\u00B0F'};
    const UPDATE_STATUSES = ['UPDATE_AVAILABLE', 'REBUILD_READY'];

    const POLL_ACTION_MS = 3000;
    const POLL_ACTION_MAX = 20;
    const POLL_UPDATE_MS = 10000;
    const UPDATE_CAP_MS = 600000;
    const RESTART_CAP_MS = 60000;
    const NOTE_ERROR_MS = 8000;
    const NOTE_SUCCESS_MS = 5000;
    const SUMMARY_MS = 8000;

    const oSpinner = document.getElementById('spinner');
    const oMessage = document.getElementById('message');
    const oDashboard = document.getElementById('dashboard');
    const oStaleStrip = document.getElementById('staleStrip');
    const oServerTabs = document.getElementById('serverTabs');
    const oSettingsPanel = document.getElementById('settingsPanel');

    const oThemeToggle = document.getElementById('themeToggle');
    const oCompactToggle = document.getElementById('compactToggle');
    const oRefreshBtn = document.getElementById('refreshBtn');
    const oSettingsBtn = document.getElementById('settingsBtn');
    const oSettingsBack = document.getElementById('settingsBack');
    const oResizeHandle = document.getElementById('resizeHandle');

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

    const oItemNameInput = document.getElementById('itemNameInput');
    const oUrlSection = document.getElementById('urlSection');

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
    let oItemNameOverrides = {};
    let sUrlOverrideItemKey = null;
    let sItemModalType = null;
    let sListSettingsCardType = null;
    let sCurrentKeyType = null;
    let bOverridesMigrated = false;

    /* Async callbacks and timers compare these with the values captured at dispatch
       and drop their UI effect when the view or request has moved on */
    let nViewGen = 0;
    let nFetchGen = 0;
    let nNotifGen = 0;

    let nLastDataTime = 0;
    let oFeatures = {};

    /* Keyed by server ID: row actions in progress, inline row messages, update operations
       (mirror of storage pendingUpdates), Update all summaries, features the server rejected */
    let oPending = {};
    let oRowNotes = {};
    let oUpdateOps = {};
    let oUpdateSummary = {};
    let oUnsupported = {};
    let oPollTimers = {};
    let oPollBusy = {};
    let bUpdateAllConfirm = false;
    let oOpenMenu = null;

    /**
     * Migrates override keys from container IDs to container names
     * @param {Array} pContainers - Docker containers from the API response
     */
    const migrateOverrideKeys = (pContainers) => {

        if (bOverridesMigrated || !pContainers || pContainers.length === 0) {
            return;
        }

        bOverridesMigrated = true;

        const oIdToName = new Map();
        pContainers.forEach((pC) => {

            const sName = getContainerName(pC);
            oIdToName.set(pC.id, sName);
        });

        let bChanged = false;

        [oDockerUrlOverrides, oItemNameOverrides].forEach((pOverrides) => {

            Object.keys(pOverrides).forEach((pKey) => {

                const nSep = pKey.indexOf('::');
                if (nSep === -1) return;

                const sServerId = pKey.substring(0, nSep);
                const sItemKey = pKey.substring(nSep + 2);
                const sName = oIdToName.get(sItemKey);

                if (sName) {
                    const sNewKey = sServerId + '::' + sName;
                    if (!pOverrides[sNewKey]) {
                        pOverrides[sNewKey] = pOverrides[pKey];
                    }
                    delete pOverrides[pKey];
                    bChanged = true;
                }
            });
        });

        /* Only the pre-1.3.0 shared order can still hold container IDs */
        const aDockerOrder = oSettings.listSettings?.docker?.customOrder || [];
        if (aDockerOrder.length > 0) {
            const aMigrated = aDockerOrder.map((pId) => oIdToName.get(pId) || pId);
            if (aMigrated.some((pVal, pIdx) => pVal !== aDockerOrder[pIdx])) {
                oSettings.listSettings.docker.customOrder = aMigrated;
                bChanged = true;
            }
        }

        if (bChanged) {
            saveOverrides();
            saveStorage();
        }
    };

    /**
     * Retrieves the AES-GCM encryption key from storage
     * @returns {Promise<CryptoKey|null>} The imported crypto key, or null if not found
     */
    const getEncryptionKey = async () => {

        const oResult = await new Promise((resolve) => chrome.storage.local.get(['_ek'], resolve));

        if (oResult._ek) {
            return crypto.subtle.importKey('raw', new Uint8Array(oResult._ek), 'AES-GCM', false, ['encrypt', 'decrypt']);
        }

        return null;
    };

    /**
     * Encrypts a string value using AES-GCM
     * @param {CryptoKey} pKey - The AES-GCM crypto key
     * @param {string} pValue - The plaintext value to encrypt
     * @returns {Promise<{iv: number[], data: number[]}>} The encrypted payload
     */
    const encryptValue = async (pKey, pValue) => {

        const aIv = crypto.getRandomValues(new Uint8Array(12));
        const aData = await crypto.subtle.encrypt({name: 'AES-GCM', iv: aIv}, pKey, new TextEncoder().encode(pValue));

        return {iv: Array.from(aIv), data: Array.from(new Uint8Array(aData))};
    };

    /**
     * Decrypts an AES-GCM encrypted payload back to a string
     * @param {CryptoKey} pKey - The AES-GCM crypto key
     * @param {{iv: number[], data: number[]}} pEncrypted - The encrypted payload
     * @returns {Promise<string>} The decrypted plaintext
     */
    const decryptValue = async (pKey, pEncrypted) => {

        const aDecrypted = await crypto.subtle.decrypt(
            {name: 'AES-GCM', iv: new Uint8Array(pEncrypted.iv)},
            pKey,
            new Uint8Array(pEncrypted.data)
        );

        return new TextDecoder().decode(aDecrypted);
    };

    /**
     * Loads all settings, servers, and overrides from chrome.storage.local
     * @returns {Promise<boolean>} True if API key decryption failed
     */
    const loadStorage = async () => {

        const oResult = await new Promise((resolve) => {
            chrome.storage.local.get(
                ['servers', 'settings', 'dockerUrlOverrides', 'itemNameOverrides', 'encryptedKeys', 'pendingUpdates'],
                resolve
            );
        });

        const oEncKeys = oResult.encryptedKeys || {};
        const aEncIds = Object.keys(oEncKeys);
        const oDecrypted = {};
        let bDecryptionFailed = false;

        if (aEncIds.length > 0) {

            try {

                const oCryptoKey = await getEncryptionKey();

                if (!oCryptoKey) {
                    bDecryptionFailed = true;
                } else {

                    for (const sId of aEncIds) {

                        try {
                            oDecrypted[sId] = await decryptValue(oCryptoKey, oEncKeys[sId]);
                        } catch (_) {
                            /* Corrupted entry */
                        }
                    }

                    if (Object.keys(oDecrypted).length === 0) {
                        bDecryptionFailed = true;
                    }
                }

            } catch (_) {
                bDecryptionFailed = true;
            }
        }

        aServers = (oResult.servers || []).map((pS) => {

            const oServer = {...pS, apiKey: oDecrypted[pS.id] || pS.apiKey || null};

            if (pS.prev) {
                oServer.prev = {...pS.prev, apiKey: oDecrypted[pS.id + '::prev'] || pS.prev.apiKey || null};
            }

            return oServer;
        });
        oSettings = {...DEFAULT_SETTINGS, ...oResult.settings};
        oSettings.customOrders = {...(oResult.settings?.customOrders || {})};
        oUpdateOps = oResult.pendingUpdates || {};

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
        oItemNameOverrides = oResult.itemNameOverrides || {};
        sActiveServerId = oSettings.activeServerId;

        if (aServers.length > 0 && !aServers.find((pS) => pS.id === sActiveServerId)) {
            sActiveServerId = aServers[0].id;
        }

        if (!Array.isArray(oSettings.cardOrder) || oSettings.cardOrder.length === 0) {
            oSettings.cardOrder = [...DEFAULT_SETTINGS.cardOrder];
        }

        if (typeof oSettings.compactMode !== 'boolean') {
            oSettings.compactMode = DEFAULT_SETTINGS.compactMode;
        }

        if (typeof oSettings.popupWidth !== 'number' || oSettings.popupWidth <= 0) {
            oSettings.popupWidth = DEFAULT_SETTINGS.popupWidth;
        }

        if (typeof oSettings.popupHeight !== 'number') {
            oSettings.popupHeight = DEFAULT_SETTINGS.popupHeight;
        }

        return bDecryptionFailed;
    };

    /** Persists servers, encrypted API keys, and settings to chrome.storage.local */
    const saveStorage = async () => {

        const oPlainKeys = {};
        const aCleaned = aServers.map((pS) => {

            if (pS.apiKey) {
                oPlainKeys[pS.id] = pS.apiKey;
            }

            const {apiKey, ...oRest} = pS;

            /* Snapshot kept while a save waits for its host permission (resolveStagedServer) */
            if (pS.prev) {

                const {apiKey: sPrevKey, ...oPrevRest} = pS.prev;

                if (sPrevKey) {
                    oPlainKeys[pS.id + '::prev'] = sPrevKey;
                }

                oRest.prev = oPrevRest;
            }

            return oRest;
        });

        const oEncKeys = {};
        const aIds = Object.keys(oPlainKeys);

        if (aIds.length > 0) {

            let oCryptoKey = await getEncryptionKey();

            if (!oCryptoKey) {
                const oKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
                const aRaw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', oKey)));
                await new Promise((resolve) => chrome.storage.local.set({_ek: aRaw}, resolve));
                oCryptoKey = oKey;
            }

            for (const sId of aIds) {
                oEncKeys[sId] = await encryptValue(oCryptoKey, oPlainKeys[sId]);
            }
        }

        return new Promise((resolve) => chrome.storage.local.set({
            servers: aCleaned,
            encryptedKeys: oEncKeys,
            settings: {
                ...oSettings,
                activeServerId: sActiveServerId
            }
        }, resolve));
    };

    /**
     * Builds a scoped override key by prefixing the active server ID
     * @param {string} pItemKey - The item identifier (container name or VM id)
     * @returns {string} The scoped key in the form "serverId::itemKey"
     */
    const getOverrideKey = (pItemKey) => {

        return sActiveServerId + '::' + pItemKey;
    };

    /** Persists URL and name overrides to chrome.storage.local */
    const saveOverrides = () => {

        return new Promise((resolve) => {

            chrome.storage.local.set({
                dockerUrlOverrides: oDockerUrlOverrides,
                itemNameOverrides: oItemNameOverrides
            }, resolve);
        });
    };

    /** Applies the current theme (light/dark) to the document body */
    const applyTheme = () => {

        if (oSettings.theme === 'dark') {
            document.body.classList.add('theme-dark');
        } else {
            document.body.classList.remove('theme-dark');
        }
    };

    /** Applies or removes compact mode styling on the document body */
    const applyCompact = () => {

        if (oSettings.compactMode) {
            document.body.classList.add('ut-compact');
            oCompactToggle.classList.add('active');
        } else {
            document.body.classList.remove('ut-compact');
            oCompactToggle.classList.remove('active');
        }
    };

    /** Sets the popup body width and height from saved settings */
    const applyPopupDimensions = () => {

        if (oSettings.popupWidth > 0) {
            document.body.style.width = oSettings.popupWidth + 'px';
        }

        if (oSettings.popupHeight > 0) {
            document.body.style.minHeight = oSettings.popupHeight + 'px';
            document.body.style.maxHeight = oSettings.popupHeight + 'px';
        }
    };

    /**
     * Creates an SVG element with a <use> reference to a sprite icon
     * @param {string} pHref - The sprite icon reference (e.g. '#ico-settings')
     * @param {string} [pClass] - CSS class name, defaults to 'ut-icon'
     * @returns {SVGSVGElement} The constructed SVG element
     */
    const createSvgIcon = (pHref, pClass) => {

        const oSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        oSvg.setAttribute('class', pClass || 'ut-icon');

        const oUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        oUse.setAttribute('href', pHref);
        oSvg.appendChild(oUse);

        return oSvg;
    };

    /**
     * Creates a DOM element with optional class and text content
     * @param {string} pTag - HTML tag name
     * @param {string} [pClass] - CSS class name
     * @param {string} [pText] - Text content
     * @returns {HTMLElement} The constructed element
     */
    const buildEl = (pTag, pClass, pText) => {

        const oEl = document.createElement(pTag);
        if (pClass) oEl.className = pClass;
        if (pText != null) oEl.textContent = pText;
        return oEl;
    };

    const CARD_LABELS = {
        system: 'System',
        array: 'Array',
        docker: 'Docker',
        vms: 'VMs',
        notifications: 'Notifications'
    };

    /**
     * Retrieves the display name for an item, falling back to the original name
     * @param {string} pItemId - The item identifier used as the override key
     * @param {string} pFallbackName - Name to return if no override exists
     * @returns {string} The overridden name or the fallback
     */
    const getItemDisplayName = (pItemId, pFallbackName) => {

        const sKey = getOverrideKey(pItemId);
        return oItemNameOverrides[sKey] || pFallbackName;
    };

    /** Shows the loading spinner and hides the message and dashboard */
    const showSpinner = () => {

        oSpinner.classList.remove('hidden');
        oSpinner.style.display = '';
        oMessage.style.display = 'none';
        oDashboard.style.display = 'none';
    };

    /**
     * Displays a DOM element as the main message, hiding spinner and dashboard
     * @param {HTMLElement} pElement - The element to display in the message area
     */
    const showMessageEl = (pElement) => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oDashboard.style.display = 'none';
        oMessage.textContent = '';
        oMessage.appendChild(pElement);
        oMessage.className = 'ut-message';
        oMessage.style.display = 'block';
    };

    /**
     * Displays a text message, hiding spinner and dashboard
     * @param {string} pText - The message text
     * @param {boolean} pIsError - If true, applies error styling
     */
    const showMessageText = (pText, pIsError) => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oDashboard.style.display = 'none';
        oMessage.textContent = pText;
        oMessage.className = 'ut-message' + (pIsError ? ' ut-message-error' : '');
        oMessage.style.display = 'block';
    };

    /** Shows the dashboard container, hiding the spinner and message */
    const showDashboard = () => {

        oSpinner.classList.add('hidden');
        oSpinner.style.display = 'none';
        oMessage.style.display = 'none';
        oDashboard.style.display = 'flex';
    };

    /**
     * Maps an error code to a human-readable message
     * @param {string} pError - The error code or raw message
     * @returns {string} The user-facing error message
     */
    const getErrorMessage = (pError) => {

        if (!pError) {
            return 'An unknown error occurred.';
        }

        if (ERROR_MESSAGES[pError]) {
            return ERROR_MESSAGES[pError];
        }

        const aHttp = /^HTTP_(\d{3})/.exec(pError);

        if ((aHttp && aHttp[1] === '400') || pError.startsWith('UNSUPPORTED')) {
            return 'The server rejected the request (API version mismatch?).';
        }

        if (aHttp && aHttp[1].startsWith('5')) {
            return 'Server error (' + aHttp[1] + '). Try again later.';
        }

        if (aHttp) {
            return 'Unexpected server response (' + aHttp[1] + ').';
        }

        if (pError.startsWith('GQL_ERROR: ')) {
            return pError.substring('GQL_ERROR: '.length);
        }

        return pError;
    };

    /** Renders the server tab bar, hidden when only one server is enabled */
    const renderServerTabs = () => {

        const aEnabled = aServers.filter((pS) => pS.enabled !== false);

        if (aEnabled.length <= 1) {
            oServerTabs.style.display = 'none';
            return;
        }

        oServerTabs.style.display = 'flex';
        oServerTabs.textContent = '';

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

    /**
     * Switches the active server and refreshes the dashboard
     * @param {string} pServerId - The server ID to activate
     */
    const switchServer = (pServerId) => {

        sActiveServerId = pServerId;
        oSettings.activeServerId = pServerId;
        resetServerView();

        saveStorage();
        renderServerTabs();
        fetchAndRender();
    };

    /**
     * Clears the per-view state when the active server changes, so late responses,
     * status checks and timers of the previous server cannot touch the new view
     */
    const resetServerView = () => {

        nViewGen++;
        nNotifGen++;

        Object.values(oPollTimers).forEach((pTimer) => clearTimeout(pTimer));
        oPollTimers = {};
        oPollBusy = {};

        oCurrentData = null;
        oFeatures = {};
        bDockerExpanded = false;
        bVMsExpanded = false;
        bNotificationsExpanded = false;
        bNotificationsLoading = false;
        bUpdateAllConfirm = false;
        aNotificationItems = [];
        oStaleStrip.style.display = 'none';
        closeMoreMenu(false);
    };

    /**
     * Fetches dashboard data from the active server and renders the UI. Errors show the full-panel
     * message when no data is loaded for this server yet, otherwise a strip above the kept cards.
     * @param {boolean} [pSilent] - If true, suppresses the loading spinner when data is already shown
     */
    const fetchAndRender = (pSilent) => {

        if (aServers.length === 0) {

            const oFrag = document.createDocumentFragment();
            oFrag.appendChild(createSvgIcon('#ico-settings', 'ut-message-icon'));
            oFrag.appendChild(document.createTextNode('No servers configured. '));

            const oLink = document.createElement('a');
            oLink.textContent = 'Open Settings';
            oLink.addEventListener('click', openSettings);
            oFrag.appendChild(oLink);

            oFrag.appendChild(document.createTextNode(' to add your Unraid server.'));
            showMessageEl(oFrag);

            return;
        }

        if (!pSilent || !oCurrentData) {
            showSpinner();
        }

        nFetchGen++;
        const nGen = nFetchGen;
        const sReqServerId = sActiveServerId;

        chrome.runtime.sendMessage({
            action: 'fetchDashboard',
            serverId: sReqServerId
        }, (pResponse) => {

            const sLastError = chrome.runtime.lastError?.message;

            if (nGen !== nFetchGen || sReqServerId !== sActiveServerId) {
                return;
            }

            let sError = pResponse?.error;

            if (sLastError) {
                sError = 'Extension error: ' + sLastError;
            } else if (!pResponse) {
                sError = 'No response from background service.';
            }

            if (sError) {

                if (oCurrentData && sError !== 'KEY_MISSING') {

                    const oTime = new Date(nLastDataTime);
                    const sTime = String(oTime.getHours()).padStart(2, '0') + ':' +
                        String(oTime.getMinutes()).padStart(2, '0');

                    oStaleStrip.textContent = 'Last refresh failed: ' + getErrorMessage(sError).replace(/\.$/, '') +
                        '. Showing data from ' + sTime + '.';
                    oStaleStrip.style.display = '';

                    if (oSettingsPanel.style.display === 'none') {
                        showDashboard();
                    }

                    return;
                }

                showMessageText(getErrorMessage(sError), true);
                return;
            }

            oCurrentData = pResponse.data;
            sCurrentKeyType = pResponse.keyType || 'admin';
            oFeatures = pResponse.features || {};
            nLastDataTime = Date.now();
            oStaleStrip.style.display = 'none';
            migrateOverrideKeys(oCurrentData?.docker?.containers);
            renderDashboard();

            ['docker', 'vm', 'update'].forEach((pKind) => scheduleStatusCheck(pKind));
        });
    };

    /** Renders all visible dashboard cards in the configured order */
    const renderDashboard = () => {

        if (!oCurrentData) {
            return;
        }

        if (oSettingsPanel.style.display !== 'none') {
            return;
        }

        showDashboard();

        const oVis = oSettings.visibleCards;
        const oCardMap = {
            system: oCardSystem,
            array: oCardArray,
            docker: oCardDocker,
            vms: oCardVMs,
            notifications: oCardNotifications
        };
        const oRenderMap = {
            system: renderSystemCard,
            array: renderArrayCard,
            docker: renderDockerCard,
            vms: renderVMsCard,
            notifications: renderNotificationsCard
        };

        const aOrder = oSettings.cardOrder || DEFAULT_SETTINGS.cardOrder;

        aOrder.forEach((pKey) => {

            const oCard = oCardMap[pKey];

            if (!oCard) {
                return;
            }

            oCard.style.display = oVis[pKey] ? '' : 'none';
            oDashboard.appendChild(oCard);

            if (oVis[pKey] && oRenderMap[pKey]) {
                oRenderMap[pKey]();
            }
        });

        setupCollapsibleCards();
    };

    /**
     * Attaches collapse/expand behavior to card headers.
     * Notifications card handles its own collapse (see renderNotificationsCard)
     * because it re-renders itself when expanding/collapsing the list.
     */
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

    /**
     * Toggles a card's collapsed state and persists the change
     * @param {string} pKey - The card key (e.g. 'system', 'docker')
     * @param {HTMLElement} pCardEl - The card DOM element
     */
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

    /**
     * Builds a label/value detail row for card bodies
     * @param {string} pLabel - The label text
     * @param {string} pValue - The value text
     * @returns {HTMLElement} The detail row element
     */
    const buildDetailRow = (pLabel, pValue) => {

        const oRow = buildEl('div', 'ut-detail-row');
        oRow.appendChild(buildEl('span', 'ut-detail-label', pLabel));
        oRow.appendChild(buildEl('span', 'ut-detail-value', pValue));
        return oRow;
    };

    /**
     * Builds a card header with icon, title, and optional badge or right-side content
     * @param {string} pIconRef - Sprite icon reference for the header icon
     * @param {string} pTitle - Card title text
     * @param {string} [pBadgeText] - Optional badge text (ignored if pRightContent is provided)
     * @param {HTMLElement} [pRightContent] - Optional right-side element (takes priority over badge)
     * @returns {HTMLElement} The card header element
     */
    const buildCardHeader = (pIconRef, pTitle, pBadgeText, pRightContent) => {

        const oHeader = buildEl('div', 'ut-card-header');

        const oLeft = buildEl('div', 'ut-card-header-left');
        oLeft.appendChild(createSvgIcon(pIconRef));
        oLeft.appendChild(buildEl('span', 'ut-card-title', pTitle));
        oHeader.appendChild(oLeft);

        if (pRightContent) {
            oHeader.appendChild(pRightContent);
        } else if (pBadgeText != null) {
            oHeader.appendChild(buildEl('span', 'ut-card-badge', pBadgeText));
        }

        return oHeader;
    };

    /** Renders the System card with server info, CPU, memory, and network */
    const renderSystemCard = () => {

        const oVars = oCurrentData.vars || {};
        const oInfo = oCurrentData.info || {};
        const oMetrics = oCurrentData.metrics || {};
        const oOS = oInfo.os || {};
        const oCPU = oInfo.cpu || {};
        const oMemMetrics = oMetrics.memory || {};

        const aAccessUrls = oCurrentData.network?.accessUrls || [];
        const oNet = aAccessUrls.find((pU) => pU.type === 'LAN') || aAccessUrls[0] || {};

        const oActiveServer = aServers.find((pS) => pS.id === sActiveServerId);
        const sServerUrl = oActiveServer?.url || '';
        const sVersion = oVars.version || '?';
        const sName = oVars.name || 'Unraid';
        const sUptime = formatUptime(oOS.uptime);
        const sCPUBrand = oCPU.brand || 'Unknown CPU';
        const nCPUPercent = Math.round(oMetrics.cpu?.percentTotal || 0);

        const nMemTotal = Number(oMemMetrics.total) || 0;
        const nMemUsed = Number(oMemMetrics.used) || 0;
        const nMemPercent = Math.round(oMemMetrics.percentTotal || 0);

        oCardSystem.textContent = '';
        oCardSystem.appendChild(buildCardHeader('#ico-system', 'System', 'v' + sVersion));

        const oBody = buildEl('div', 'ut-card-body');

        const oServerRow = buildEl('div', 'ut-detail-row');
        oServerRow.appendChild(buildEl('span', 'ut-detail-label', 'Server'));
        const oServerVal = buildEl('span', 'ut-detail-value');

        if (sServerUrl) {

            const oLink = document.createElement('a');
            oLink.className = 'ut-server-link';
            oLink.href = sServerUrl;
            oLink.target = '_blank';
            oLink.rel = 'noopener';
            oLink.textContent = sName + ' ';
            oLink.appendChild(createSvgIcon('#ico-external', 'ut-icon ut-server-link-icon'));
            oServerVal.appendChild(oLink);

        } else {
            oServerVal.textContent = sName;
        }

        oServerRow.appendChild(oServerVal);
        oBody.appendChild(oServerRow);

        oBody.appendChild(buildDetailRow('Uptime', sUptime));
        oBody.appendChild(buildDetailRow('CPU', sCPUBrand));
        oBody.appendChild(buildDetailRow('Cores', (oCPU.cores || '?') + 'C / ' + (oCPU.threads || '?') + 'T'));
        oBody.appendChild(buildDetailRow('Memory', formatBytes(nMemTotal)));

        if (oNet.ipv4) {
            oBody.appendChild(buildDetailRow('Network', oNet.ipv4));
        }

        /* Values are shown in the unit the API reports; Kelvin/Rankine or a missing unit hide the row */
        const oTempSummary = oCurrentData.temperature?.summary;
        const sTempUnit = TEMP_UNITS[oTempSummary?.hottest?.current?.unit];

        if (sTempUnit) {

            const oTempRow = buildEl('div', 'ut-detail-row');
            oTempRow.appendChild(buildEl('span', 'ut-detail-label', 'Temp'));

            const oTempVal = buildEl('span', 'ut-detail-value',
                'avg ' + Math.round(oTempSummary.average) + sTempUnit +
                ' - hottest ' + Math.round(oTempSummary.hottest.current.value) + sTempUnit);

            if (oTempSummary.warningCount > 0) {
                oTempVal.appendChild(document.createTextNode(', '));
                oTempVal.appendChild(buildEl('span', 'ut-text-warning', oTempSummary.warningCount + ' warning'));
            }

            if (oTempSummary.criticalCount > 0) {
                oTempVal.appendChild(document.createTextNode(', '));
                oTempVal.appendChild(buildEl('span', 'ut-text-error', oTempSummary.criticalCount + ' critical'));
            }

            oTempRow.appendChild(oTempVal);
            oBody.appendChild(oTempRow);
        }

        const oMetricsDiv = document.createElement('div');
        oMetricsDiv.style.marginTop = '8px';
        oMetricsDiv.appendChild(renderProgressBar('CPU', nCPUPercent));
        oMetricsDiv.appendChild(renderProgressBar('RAM', nMemPercent,
            formatBytes(nMemUsed) + ' / ' + formatBytes(nMemTotal)));
        oBody.appendChild(oMetricsDiv);

        oCardSystem.appendChild(oBody);
    };

    /** Renders the Array card with disk status, parity, cache, and capacity */
    const renderArrayCard = () => {

        const bArrayAvailable = oCurrentData.array !== null && oCurrentData.array !== undefined;

        oCardArray.textContent = '';

        if (!bArrayAvailable) {

            oCardArray.appendChild(buildCardHeader('#ico-array', 'Array', 'unavailable'));
            const oBody = buildEl('div', 'ut-card-body');
            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'Array data not available on this server')
            );
            oCardArray.appendChild(oBody);
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

        const oBadge = buildEl('span', 'ut-card-badge');
        const oDot = buildEl('span', 'ut-status-dot ut-status-dot--' + sStateClass);
        oBadge.appendChild(oDot);
        oBadge.appendChild(document.createTextNode(sState));

        oCardArray.appendChild(buildCardHeader('#ico-array', 'Array', null, oBadge));

        const oBody = buildEl('div', 'ut-card-body');

        if (nTotalKB > 0) {
            oBody.appendChild(buildDetailRow('Capacity',
                formatBytes(nUsedKB * 1024) + ' / ' + formatBytes(nTotalKB * 1024)));
            oBody.appendChild(renderProgressBar('Used', nPercent));
        }

        const oDiskRow = buildEl('div', 'ut-detail-row');
        oDiskRow.style.marginTop = '4px';
        oDiskRow.appendChild(buildEl('span', 'ut-detail-label', 'Disks'));
        const oDiskVal = buildEl('span', 'ut-detail-value');
        oDiskVal.textContent = nDiskOk + ' active';

        if (nDiskErrors > 0) {
            oDiskVal.appendChild(document.createTextNode(', '));
            const oErrSpan = document.createElement('span');
            oErrSpan.style.color = 'var(--ut-status-error)';
            oErrSpan.textContent = nDiskErrors + ' with errors';
            oDiskVal.appendChild(oErrSpan);
        }

        oDiskRow.appendChild(oDiskVal);
        oBody.appendChild(oDiskRow);

        oBody.appendChild(buildDetailRow('Parity', nParityOk + ' active'));

        /* The API fills status, progress, speed and date; errors/correcting may be null */
        const oParity = oArray.parityCheckStatus;

        if (oParity && sState === 'STARTED') {

            const nProgress = oParity.progress || 0;
            const sCorrecting = oParity.correcting ? ' (correcting)' : '';

            if (oParity.status === 'RUNNING') {

                const oCheckRow = buildEl('div', 'ut-detail-row');
                oCheckRow.appendChild(buildEl('span', 'ut-detail-label', 'Parity check'));

                const oCheckVal = buildEl('span', 'ut-detail-value',
                    nProgress + '%' + (oParity.speed ? ' - ' + oParity.speed + ' MB/s' : '') + sCorrecting);

                if (oParity.errors > 0) {
                    oCheckVal.appendChild(document.createTextNode(', '));
                    oCheckVal.appendChild(buildEl('span', 'ut-text-error',
                        oParity.errors + ' error' + (oParity.errors !== 1 ? 's' : '')));
                }

                oCheckRow.appendChild(oCheckVal);
                oBody.appendChild(oCheckRow);
                oBody.appendChild(renderProgressBar('', nProgress, null, true));

            } else if (oParity.status === 'PAUSED') {

                oBody.appendChild(buildDetailRow('Parity check', 'paused at ' + nProgress + '%' + sCorrecting));

            } else if (oParity.status === 'NEVER_RUN') {

                oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                    buildEl('span', 'ut-detail-label', 'No parity check run yet')
                );

            } else {

                const oResults = {COMPLETED: 'Completed', CANCELLED: 'Cancelled', FAILED: 'Failed'};
                let sResult = oResults[oParity.status] || oParity.status;

                if (oParity.status === 'COMPLETED' && typeof oParity.errors === 'number') {
                    sResult += ', ' + oParity.errors + ' error' + (oParity.errors !== 1 ? 's' : '');
                }

                const sDate = formatTimestamp(oParity.date);
                oBody.appendChild(buildDetailRow('Last check', (sDate ? sDate + ' - ' : '') + sResult));
            }
        }

        const oParitySection = renderDiskSection('Parity', aParities);
        if (oParitySection) oBody.appendChild(oParitySection);

        const oDiskSection = renderDiskSection('Disks', aDisks);
        if (oDiskSection) oBody.appendChild(oDiskSection);

        const oCacheSection = renderDiskSection('Cache', aCaches);
        if (oCacheSection) oBody.appendChild(oCacheSection);

        oCardArray.appendChild(oBody);
    };

    /**
     * Renders a disk section (parity, disks, or cache) with status chips
     * @param {string} pTitle - Section title
     * @param {Array} pDisks - Array of disk objects from the API
     * @returns {HTMLElement|null} The section element, or null if no active disks
     */
    const renderDiskSection = (pTitle, pDisks) => {

        const aActive = pDisks.filter((pD) => pD.status && pD.status !== 'DISK_NP');

        if (aActive.length === 0) {
            return null;
        }

        const oSection = buildEl('div', 'ut-disk-section');
        oSection.appendChild(buildEl('div', 'ut-disk-section-title', pTitle));

        const oGrid = buildEl('div', 'ut-disk-grid');
        const oThresholds = oCurrentData.diskTempThresholds || {};

        aActive.forEach((pDisk) => {

            let sStatus = getDiskStatusClass(pDisk);
            let sTempClass = '';
            const sName = pDisk.name || '?';

            /* Thresholds are the HDD defaults, so SSD/NVMe chips keep the plain coloring */
            const bRotational = pDisk.rotational !== false;
            const bWarnSet = bRotational && typeof oThresholds.warning === 'number';
            const bCritSet = bRotational && typeof oThresholds.critical === 'number';

            /* An existing error (red) outranks temperature; a sleeping disk (no temp) keeps its color */
            if (sStatus !== 'error' && pDisk.temp != null) {

                if (bCritSet && pDisk.temp >= oThresholds.critical) {
                    sStatus = 'error';
                    sTempClass = ' ut-text-error';
                } else if (bWarnSet && pDisk.temp >= oThresholds.warning) {
                    sStatus = 'warning';
                    sTempClass = ' ut-text-warning';
                }
            }

            let sTooltip = pDisk.temp != null ? pDisk.temp + '\u00B0C' : '';

            if (sTooltip && (bWarnSet || bCritSet)) {

                const aLimits = [];

                if (bWarnSet) aLimits.push('warn ' + oThresholds.warning + '\u00B0');
                if (bCritSet) aLimits.push('crit ' + oThresholds.critical + '\u00B0');

                sTooltip += ' (' + aLimits.join(', ') + ')';
            }

            if (pDisk.temp == null && pDisk.isSpinning === false) {
                sTooltip = 'Standby';
            }

            if (pDisk.numErrors > 0) {
                sTooltip += (sTooltip ? ' \u00B7 ' : '') + pDisk.numErrors + ' error' + (pDisk.numErrors !== 1 ? 's' : '');
            }

            const oChip = buildEl('span', 'ut-disk-chip');
            if (sTooltip) oChip.dataset.tooltip = sTooltip;

            oChip.appendChild(buildEl('span', 'ut-status-dot ut-status-dot--' + sStatus));
            oChip.appendChild(document.createTextNode(sName));

            if (pDisk.temp != null) {
                oChip.appendChild(buildEl('span', 'ut-disk-chip-temp' + sTempClass, pDisk.temp + '\u00B0C'));
            }

            oGrid.appendChild(oChip);
        });

        oSection.appendChild(oGrid);

        return oSection;
    };

    /**
     * Returns the CSS status class for a disk based on its state
     * @param {Object} pDisk - The disk object from the API
     * @returns {string} Status class name (running, standby, stopped, warning, error)
     */
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

    /**
     * Returns the custom order of a card for the active server. A server without its own order
     * starts from the shared pre-1.3.0 order; keys of items it does not have are ignored when sorting.
     * @param {string} pCardType - The card type ('docker' or 'vms')
     * @returns {string[]} Item keys in custom order
     */
    const getCustomOrder = (pCardType) => {

        return oSettings.customOrders[sActiveServerId]?.[pCardType] ||
            oSettings.listSettings[pCardType].customOrder || [];
    };

    /**
     * Sorts list items (containers or VMs) according to the card's sort mode
     * @param {Array} pItems - The items to sort
     * @param {string} pCardType - The card type ('docker' or 'vms')
     * @param {Function} pFnName - Function that extracts a display name from an item
     * @returns {Array} A new sorted array
     */
    const sortListItems = (pItems, pCardType, pFnName) => {

        const oLS = oSettings.listSettings[pCardType];
        const sSortMode = oLS.sortMode;

        const aSorted = [...pItems];

        if (sSortMode === 'az') {

            aSorted.sort((pA, pB) => pFnName(pA).localeCompare(pFnName(pB)));

        } else if (sSortMode === 'za') {

            aSorted.sort((pA, pB) => pFnName(pB).localeCompare(pFnName(pA)));

        } else if (sSortMode === 'custom') {

            const aOrder = getCustomOrder(pCardType);
            const oIndexMap = new Map();
            aOrder.forEach((pKey, pIdx) => oIndexMap.set(pKey, pIdx));

            aSorted.sort((pA, pB) => {

                const sKeyA = getItemSortKey(pA, pCardType);
                const sKeyB = getItemSortKey(pB, pCardType);
                const nIdxA = oIndexMap.has(sKeyA) ? oIndexMap.get(sKeyA) : Infinity;
                const nIdxB = oIndexMap.has(sKeyB) ? oIndexMap.get(sKeyB) : Infinity;

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

    /**
     * Returns the number of items to show before the "Show more" button
     * @param {string} pCardType - The card type ('docker' or 'vms')
     * @param {number} pTotalCount - Total number of items available
     * @returns {number} The visible count (0 means show all)
     */
    const getVisibleCount = (pCardType, pTotalCount) => {

        const nSetting = oSettings.listSettings[pCardType].visibleCount;

        return nSetting === 0 ? pTotalCount : nSetting;
    };

    /**
     * Extracts the display name from a VM object
     * @param {Object} pVM - The VM domain object
     * @returns {string} The VM name, ID, or '?'
     */
    const getVMName = (pVM) => pVM.name || pVM.id || '?';

    /**
     * Opens the list settings modal for a given card type
     * @param {string} pCardType - The card type ('docker' or 'vms')
     */
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

    /** Closes the list settings modal and clears the active card type */
    const closeListSettingsModal = () => {

        oListSettingsBackdrop.style.display = 'none';
        sListSettingsCardType = null;
    };

    /** Shows or hides the custom order section based on the selected sort mode */
    const updateCustomOrderVisibility = () => {

        const bCustom = oListSettingsSort.value === 'custom';
        oListSettingsCustomSection.style.display = bCustom ? '' : 'none';

        if (bCustom && sListSettingsCardType) {
            renderCustomOrderList(sListSettingsCardType);
        }
    };

    /**
     * Returns the sort key for a list item based on card type
     * @param {Object} pItem - The container or VM object
     * @param {string} pCardType - The card type ('docker' or 'vms')
     * @returns {string} The sort key (container name or VM id)
     */
    const getItemSortKey = (pItem, pCardType) => {

        return pCardType === 'docker' ? getContainerName(pItem) : pItem.id;
    };

    /**
     * Renders the draggable custom order list for containers or VMs
     * @param {string} pCardType - The card type ('docker' or 'vms')
     */
    const renderCustomOrderList = (pCardType) => {

        let aItems = [];
        let fnName;

        if (pCardType === 'docker') {
            aItems = oCurrentData?.docker?.containers || [];
            fnName = (pC) => getItemDisplayName(getContainerName(pC), getContainerName(pC));
        } else {
            aItems = oCurrentData?.vms?.domains || [];
            fnName = (pV) => getItemDisplayName(pV.id, getVMName(pV));
        }

        const aExistingOrder = getCustomOrder(pCardType);
        const oKeySet = new Set(aItems.map((pI) => getItemSortKey(pI, pCardType)));

        const aOrdered = [];
        const aUsed = new Set();

        aExistingOrder.forEach((pKey) => {

            if (oKeySet.has(pKey)) {
                aOrdered.push(pKey);
                aUsed.add(pKey);
            }
        });

        const aNew = aItems.filter((pI) => !aUsed.has(getItemSortKey(pI, pCardType)));
        aNew.sort((pA, pB) => fnName(pA).localeCompare(fnName(pB)));
        aNew.forEach((pI) => aOrdered.push(getItemSortKey(pI, pCardType)));

        const oKeyMap = new Map();
        aItems.forEach((pI) => oKeyMap.set(getItemSortKey(pI, pCardType), pI));

        oListSettingsCustomList.textContent = '';

        aOrdered.forEach((pKey) => {

            const oItem = oKeyMap.get(pKey);

            if (!oItem) return;

            const sName = fnName(oItem);
            const bRunning = oItem.state === 'RUNNING';
            const sStatusClass = bRunning ? 'running' : (oItem.state === 'PAUSED' ? 'paused' : 'stopped');

            const oRow = buildEl('div', 'ut-drag-row');
            oRow.draggable = true;
            oRow.dataset.id = pKey;

            const oHandle = buildEl('span', 'ut-drag-handle');
            oHandle.appendChild(createSvgIcon('#ico-drag'));
            oRow.appendChild(oHandle);

            oRow.appendChild(buildEl('span', 'ut-status-dot ut-status-dot--' + sStatusClass));
            oRow.appendChild(buildEl('span', 'ut-drag-name', sName));

            oListSettingsCustomList.appendChild(oRow);
        });

        setupDragAndDrop();
    };

    /** Attaches drag-and-drop event listeners to the custom order list rows */
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

    /**
     * Reads the current custom order from the DOM drag list
     * @returns {string[]} Array of item keys in their current DOM order
     */
    const readCustomOrderFromDOM = () => {

        const aIds = [];

        oListSettingsCustomList.querySelectorAll('.ut-drag-row').forEach((pRow) => {

            aIds.push(pRow.dataset.id);
        });

        return aIds;
    };

    /** Saves the list settings modal values and re-renders the affected card */
    const saveListSettings = () => {

        if (!sListSettingsCardType) return;

        const sCardType = sListSettingsCardType;
        const oLS = oSettings.listSettings[sCardType];

        oLS.sortMode = oListSettingsSort.value;
        oLS.visibleCount = parseInt(oListSettingsCount.value, 10);

        if (oLS.sortMode === 'custom') {
            oSettings.customOrders[sActiveServerId] = {
                ...oSettings.customOrders[sActiveServerId],
                [sCardType]: readCustomOrderFromDOM()
            };
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

    /** Renders the Docker card with container list, status, and update badges */
    const renderDockerCard = () => {

        closeMoreMenu(false);

        const sServerId = sActiveServerId;
        const bDockerAvailable = oCurrentData.docker !== null && oCurrentData.docker !== undefined;
        const aContainers = oCurrentData.docker?.containers || [];
        const nRunning = aContainers.filter((pC) => pC.state === 'RUNNING').length;
        const nTotal = aContainers.length;

        const fnDisplayName = (pC) => getItemDisplayName(getContainerName(pC), getContainerName(pC));
        const aSorted = sortListItems(aContainers, 'docker', fnDisplayName);
        const nMaxVisible = getVisibleCount('docker', aSorted.length);
        const nVisible = bDockerExpanded ? aSorted.length : Math.min(aSorted.length, nMaxVisible);
        const bShowMore = aSorted.length > nMaxVisible;

        const aUpdateStatuses = oCurrentData.docker?.updateStatuses || [];
        const oUpdateMap = {};

        aUpdateStatuses.forEach((pS) => {
            oUpdateMap[pS.name] = pS.updateStatus;
        });

        const aUpdatable = aContainers.filter((pC) => UPDATE_STATUSES.includes(oUpdateMap[getContainerName(pC)]));
        const nUpdatable = aUpdatable.length;
        const oUpdateOp = oUpdateOps[sServerId];
        const sUpdateSummary = oUpdateSummary[sServerId];
        const bCanUpdate = sCurrentKeyType !== 'readonly' && oFeatures.updates && !oUnsupported[sServerId]?.update;

        const sBadgeText = bDockerAvailable
            ? nRunning + ' running / ' + nTotal + ' total' + (nUpdatable > 0 ? ' / ' + nUpdatable + ' update' + (nUpdatable > 1 ? 's' : '') : '')
            : 'unavailable';

        const oRight = buildEl('div', 'ut-card-header-right');
        oRight.appendChild(buildEl('span', 'ut-card-badge', sBadgeText));

        if (sUpdateSummary) {

            oRight.appendChild(buildEl('span', 'ut-card-badge', sUpdateSummary));

        } else if (oUpdateOp) {

            const nUpdating = Object.keys(oUpdateOp.items).length;
            const oUpdatingBtn = buildEl('button', 'ut-btn-sm', 'Updating ' + nUpdating + '...');
            oUpdatingBtn.disabled = true;
            oRight.appendChild(oUpdatingBtn);

        } else if (bCanUpdate && nUpdatable > 0) {

            const oUpdateAllBtn = buildEl('button', 'ut-btn-sm');
            oUpdateAllBtn.title = 'Update all containers with an update';
            oUpdateAllBtn.appendChild(createSvgIcon('#ico-update'));
            oUpdateAllBtn.appendChild(buildEl('span', null, 'Update all (' + nUpdatable + ')'));

            oUpdateAllBtn.addEventListener('click', () => {

                bUpdateAllConfirm = true;
                rerenderCard(sServerId, 'docker');
            });

            oRight.appendChild(oUpdateAllBtn);
        }

        if (bDockerAvailable && nTotal > 0) {

            const oGear = buildEl('button', 'ut-card-gear');
            oGear.dataset.action = 'openListSettings';
            oGear.dataset.cardType = 'docker';
            oGear.title = 'List settings';
            oGear.appendChild(createSvgIcon('#ico-settings'));
            oRight.appendChild(oGear);
        }

        oCardDocker.textContent = '';
        oCardDocker.appendChild(buildCardHeader('#ico-docker', 'Docker', null, oRight));

        const oBody = buildEl('div', 'ut-card-body');
        oCardDocker.appendChild(oBody);

        if (!bDockerAvailable) {

            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'Docker service not enabled on this server')
            );

        } else if (nTotal === 0) {

            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'No containers found')
            );

        } else {

            if (bUpdateAllConfirm && bCanUpdate && !oUpdateOp && nUpdatable > 0) {

                const oConfirm = buildEl('div', 'ut-confirm');
                oConfirm.appendChild(buildEl('span', 'ut-confirm-text',
                    'Update ' + nUpdatable + ' container' + (nUpdatable !== 1 ? 's' : '') + '? They will restart.'));

                const oConfirmBtn = buildEl('button', 'ut-btn ut-btn-primary', 'Update');
                const oCancelBtn = buildEl('button', 'ut-btn ut-btn-ghost', 'Cancel');

                oConfirmBtn.addEventListener('click', () => {

                    bUpdateAllConfirm = false;
                    startUpdate(aUpdatable, true);
                });

                oCancelBtn.addEventListener('click', () => {

                    bUpdateAllConfirm = false;
                    rerenderCard(sServerId, 'docker');
                });

                oConfirm.appendChild(oConfirmBtn);
                oConfirm.appendChild(oCancelBtn);
                oBody.appendChild(oConfirm);
            }

            const oFrag = document.createDocumentFragment();

            for (let i = 0; i < nVisible; i++) {
                oFrag.appendChild(renderContainerRow(aSorted[i], oUpdateMap));
            }

            oBody.appendChild(oFrag);

            if (bShowMore) {

                const oShowMoreBtn = document.createElement('button');
                oShowMoreBtn.className = 'ut-show-more';
                oShowMoreBtn.dataset.target = 'docker';
                oShowMoreBtn.textContent = bDockerExpanded ? 'Show less' : 'Show all ' + nTotal + '...';

                oShowMoreBtn.addEventListener('click', () => {

                    bDockerExpanded = !bDockerExpanded;
                    renderDockerCard();
                    setupCollapsibleCards();
                });

                oBody.appendChild(oShowMoreBtn);
            }
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

    /**
     * Extracts the display name from a Docker container object
     * @param {Object} pContainer - The container object from the API
     * @returns {string} The container name or truncated ID
     */
    const getContainerName = (pContainer) => {

        if (pContainer.names && pContainer.names.length > 0) {
            return pContainer.names[0].replace(/^\//, '');
        }

        return pContainer.id ? pContainer.id.substring(0, 12) : '?';
    };

    /**
     * Auto-detects the web UI URL for a container from its published ports
     * @param {Object} pContainer - The container object from the API
     * @returns {string} The detected URL, or empty string if none found
     */
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

    /**
     * Returns the container WebUI URL resolved by the server from the template (API 4.30+),
     * falling back to port detection
     * @param {Object} pContainer - The container object from the API
     * @returns {string} The detected URL, or empty string if none found
     */
    const getDetectedUrl = (pContainer) => {

        if (pContainer.webUiUrl && /^https?:\/\//i.test(pContainer.webUiUrl)) {
            return pContainer.webUiUrl;
        }

        return getAutoDetectedUrl(pContainer);
    };

    /**
     * Returns the URL for a container: user override, then template WebUI, then port detection
     * @param {Object} pContainer - The container object from the API
     * @returns {string} The container URL, or empty string if none
     */
    const getContainerUrl = (pContainer) => {

        const sKey = getOverrideKey(getContainerName(pContainer));
        const sOverride = oDockerUrlOverrides[sKey];

        if (sOverride) {
            return sOverride;
        }

        return getDetectedUrl(pContainer);
    };

    /**
     * Renders a single Docker container row with status, actions, and web UI link
     * @param {Object} pContainer - The container object from the API
     * @param {Object} pUpdateMap - Map of container name to update status
     * @returns {HTMLElement} The container row element
     */
    const renderContainerRow = (pContainer, pUpdateMap) => {

        const sOriginalName = getContainerName(pContainer);
        const sName = getItemDisplayName(sOriginalName, sOriginalName);
        const bRunning = pContainer.state === 'RUNNING';
        const bPaused = pContainer.state === 'PAUSED';
        const sStatusClass = bRunning ? 'running' : (bPaused ? 'paused' : 'stopped');
        const sCommand = bRunning ? 'stop' : (bPaused ? 'resume' : 'start');
        const sWebUi = getContainerUrl(pContainer);
        const bHasUrlOverride = !!oDockerUrlOverrides[getOverrideKey(sOriginalName)];
        const bHasNameOverride = !!oItemNameOverrides[getOverrideKey(sOriginalName)];
        const bGearActive = bHasUrlOverride || bHasNameOverride;
        const sUpdateStatus = pUpdateMap ? pUpdateMap[sOriginalName] : null;
        const bHasUpdate = UPDATE_STATUSES.includes(sUpdateStatus);
        const oServerUnsupported = oUnsupported[sActiveServerId] || {};
        const oUpdateOp = oUpdateOps[sActiveServerId];
        const sPending = oPending[sActiveServerId]?.['docker::' + sOriginalName]?.sAction ||
            (oUpdateOp?.items[sOriginalName] ? 'update' : null);
        const aMenu = [];

        if ((bRunning || bPaused) && oFeatures.restart && !oServerUnsupported.restart) {
            aMenu.push('restart');
        }

        if (bRunning && oFeatures.pause && !oServerUnsupported.pause) {
            aMenu.push('pause');
        }

        const oRow = document.createElement('div');
        oRow.className = 'ut-item-row';

        const oNameDiv = document.createElement('div');
        oNameDiv.className = 'ut-item-name';

        const oDot = document.createElement('span');
        oDot.className = 'ut-status-dot ut-status-dot--' + sStatusClass;
        oNameDiv.appendChild(oDot);

        if (sWebUi) {

            const oLink = document.createElement('a');
            oLink.className = 'ut-item-link';
            oLink.href = sWebUi;
            oLink.target = '_blank';
            oLink.rel = 'noopener';
            oLink.textContent = sName;
            oNameDiv.appendChild(oLink);

        } else {

            const oSpan = document.createElement('span');
            oSpan.textContent = sName;
            oNameDiv.appendChild(oSpan);
        }

        if (bHasUpdate) {

            const oBadge = document.createElement('span');
            oBadge.className = 'ut-update-badge';
            oBadge.title = 'Update available';
            oNameDiv.appendChild(oBadge);
        }

        oRow.appendChild(oNameDiv);

        const oActions = document.createElement('div');
        oActions.className = 'ut-item-actions';

        const oGearBtn = document.createElement('button');
        oGearBtn.className = 'ut-item-action' + (bGearActive ? ' ut-item-action-url--active' : '');
        oGearBtn.title = 'Container settings';
        oGearBtn.dataset.action = 'openUrlOverride';
        oGearBtn.dataset.id = sOriginalName;
        oGearBtn.appendChild(createSvgIcon('#ico-settings'));
        oActions.appendChild(oGearBtn);

        /* Shown while its own update is pending even if the status no longer lists the update */
        if ((bHasUpdate && sCurrentKeyType !== 'readonly' && oFeatures.updates && !oServerUnsupported.update) ||
            sPending === 'update') {

            const oUpdateBtn = buildEl('button', 'ut-item-action');
            oUpdateBtn.dataset.action = 'updateDocker';
            oUpdateBtn.dataset.name = sOriginalName;
            oUpdateBtn.title = sPending === 'update' ? PENDING_LABELS.update : 'Update';
            oUpdateBtn.disabled = !!sPending || !!oUpdateOp;
            oUpdateBtn.appendChild(sPending === 'update'
                ? buildEl('span', 'ut-btn-spinner')
                : createSvgIcon('#ico-update'));
            oActions.appendChild(oUpdateBtn);
        }

        appendItemControls(oRow, oActions, {
            sKind: 'docker',
            sId: pContainer.id,
            sKey: sOriginalName,
            sLabel: sName,
            sCommand: sCommand,
            aMenu: aMenu,
            sPending: sPending
        });

        return oRow;
    };

    /**
     * Adds the controls shared by container and VM rows: pending label, More menu button,
     * the rightmost Start/Stop/Resume toggle, and the inline note under the row
     * @param {HTMLElement} pRow - The row element; pActions is appended to it
     * @param {HTMLElement} pActions - The row's action container, already holding the item-specific buttons
     * @param {Object} pItem - {sKind, sId, sKey, sLabel, sCommand, aMenu, sPending}
     */
    const appendItemControls = (pRow, pActions, pItem) => {

        const bReadOnly = sCurrentKeyType === 'readonly';
        const oNote = oRowNotes[sActiveServerId]?.[pItem.sKind + '::' + pItem.sKey];
        const oToggleDef = TOGGLE_BUTTONS[pItem.sCommand];

        if (pItem.sPending) {
            pRow.appendChild(buildEl('span', 'ut-item-status', PENDING_LABELS[pItem.sPending]));
        }

        if (pItem.aMenu.length > 0) {

            const oMoreBtn = buildEl('button', 'ut-item-action');
            oMoreBtn.dataset.action = 'itemMore';
            oMoreBtn.dataset.kind = pItem.sKind;
            oMoreBtn.dataset.id = pItem.sId;
            oMoreBtn.dataset.key = pItem.sKey;
            oMoreBtn.dataset.label = pItem.sLabel;
            oMoreBtn.dataset.items = pItem.aMenu.join(',');
            oMoreBtn.title = bReadOnly ? 'View-only API key' : 'More actions';
            oMoreBtn.disabled = bReadOnly || !!pItem.sPending;
            oMoreBtn.setAttribute('aria-label', 'More actions');
            oMoreBtn.setAttribute('aria-haspopup', 'menu');
            oMoreBtn.setAttribute('aria-expanded', 'false');
            oMoreBtn.appendChild(createSvgIcon('#ico-more'));
            pActions.appendChild(oMoreBtn);
        }

        const oToggleBtn = buildEl('button', 'ut-item-action');
        oToggleBtn.dataset.action = 'itemControl';
        oToggleBtn.dataset.kind = pItem.sKind;
        oToggleBtn.dataset.id = pItem.sId;
        oToggleBtn.dataset.key = pItem.sKey;
        oToggleBtn.dataset.label = pItem.sLabel;
        oToggleBtn.dataset.command = pItem.sCommand;

        if (bReadOnly) {
            oToggleBtn.disabled = true;
            oToggleBtn.title = 'View-only API key';
        } else if (pItem.sPending) {
            oToggleBtn.disabled = true;
            oToggleBtn.title = PENDING_LABELS[pItem.sPending];
        } else {
            oToggleBtn.title = oToggleDef.sTitle;
        }

        if (pItem.sPending && pItem.sPending !== 'update') {
            oToggleBtn.appendChild(buildEl('span', 'ut-btn-spinner'));
        } else {
            oToggleBtn.appendChild(createSvgIcon(oToggleDef.sIcon));
        }

        pActions.appendChild(oToggleBtn);
        pRow.appendChild(pActions);

        if (oNote) {
            pRow.classList.add('ut-item-row--note');
            pRow.appendChild(buildEl('div', 'ut-item-note ut-item-note--' + oNote.sType, oNote.sText));
        }
    };

    /**
     * Binds the shared row toggles and More menu buttons of the Docker or VMs card
     * @param {HTMLElement} pCard - The card element
     */
    const bindItemControls = (pCard) => {

        pCard.querySelectorAll('[data-action="itemControl"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                if (!pBtn.disabled) {
                    const oSet = pBtn.dataset;
                    runItemAction(oSet.kind, oSet.command, oSet.id, oSet.key, oSet.label);
                }
            });
        });

        pCard.querySelectorAll('[data-action="itemMore"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                toggleMoreMenu(pBtn);
            });
        });
    };

    /**
     * Opens the More menu of a row (closing any other), or closes it when it is already open
     * @param {HTMLElement} pBtn - The row's More button
     */
    const toggleMoreMenu = (pBtn) => {

        const bWasOpen = oOpenMenu?.oAnchor === pBtn;
        closeMoreMenu(false);

        if (bWasOpen || pBtn.disabled) {
            return;
        }

        /* Lives on <body> with fixed position because cards clip overflowing content */
        const oMenu = buildEl('div', 'ut-menu');
        oMenu.setAttribute('role', 'menu');

        pBtn.dataset.items.split(',').forEach((pAction) => {

            const oItem = buildEl('button', 'ut-menu-item');
            oItem.type = 'button';
            oItem.setAttribute('role', 'menuitem');
            oItem.appendChild(createSvgIcon(MENU_ITEMS[pAction].sIcon));
            oItem.appendChild(buildEl('span', null, MENU_ITEMS[pAction].sTitle));

            oItem.addEventListener('click', () => {

                closeMoreMenu(false);
                runItemAction(pBtn.dataset.kind, pAction, pBtn.dataset.id, pBtn.dataset.key, pBtn.dataset.label);
            });

            oMenu.appendChild(oItem);
        });

        document.body.appendChild(oMenu);

        /* Open below the button, or above it when the popup has no room below */
        const oRect = pBtn.getBoundingClientRect();
        const nBelowTop = oRect.bottom + 2;
        const nAboveTop = oRect.top - oMenu.offsetHeight - 2;
        const bFitsBelow = nBelowTop + oMenu.offsetHeight <= window.innerHeight;

        oMenu.style.top = Math.max(0, bFitsBelow ? nBelowTop : nAboveTop) + 'px';
        oMenu.style.right = (window.innerWidth - oRect.right) + 'px';

        pBtn.setAttribute('aria-expanded', 'true');
        oOpenMenu = {oMenu: oMenu, oAnchor: pBtn};
        oMenu.firstChild.focus();
    };

    /**
     * Closes the open More menu, if any
     * @param {boolean} pRestoreFocus - Move focus back to the More button (Escape)
     */
    const closeMoreMenu = (pRestoreFocus) => {

        if (!oOpenMenu) {
            return;
        }

        const oAnchor = oOpenMenu.oAnchor;
        oOpenMenu.oMenu.remove();
        oOpenMenu = null;
        oAnchor.setAttribute('aria-expanded', 'false');

        if (pRestoreFocus && oAnchor.isConnected) {
            oAnchor.focus();
        }
    };

    /**
     * Re-renders the Docker or VMs card when the given server is still the one on screen
     * @param {string} pServerId - Server the change belongs to
     * @param {string} pKind - 'docker', 'update' or 'vm'
     */
    const rerenderCard = (pServerId, pKind) => {

        if (pServerId !== sActiveServerId || !oCurrentData) {
            return;
        }

        if (pKind === 'vm') {
            renderVMsCard();
        } else {
            renderDockerCard();
        }

        setupCollapsibleCards();
    };

    /**
     * Shows a one-line message under a list row for a limited time
     * @param {string} pServerId - Server the row belongs to
     * @param {string} pItemKey - Row key ('docker::name' or 'vm::id')
     * @param {string} pText - Message text
     * @param {string} pType - 'error', 'success' or 'info'
     * @param {number} pDuration - Milliseconds before the note is removed
     */
    const setRowNote = (pServerId, pItemKey, pText, pType, pDuration) => {

        if (!oRowNotes[pServerId]) {
            oRowNotes[pServerId] = {};
        }

        const oNote = {sText: pText, sType: pType};
        oRowNotes[pServerId][pItemKey] = oNote;

        setTimeout(() => {

            if (oRowNotes[pServerId][pItemKey] === oNote) {
                delete oRowNotes[pServerId][pItemKey];
                rerenderCard(pServerId, pItemKey.split('::')[0]);
            }
        }, pDuration);
    };

    /**
     * Sends a start/stop/pause/resume/restart command and tracks the row until the outcome is known.
     * The state is kept per server; UI effects only apply while that server is on screen.
     * @param {string} pKind - 'docker' or 'vm'
     * @param {string} pAction - start, stop, pause, resume or restart
     * @param {string} pId - Container or VM id
     * @param {string} pKey - Row key (container name or VM id)
     * @param {string} pLabel - Display name used in messages
     */
    const runItemAction = (pKind, pAction, pId, pKey, pLabel) => {

        const sServerId = sActiveServerId;
        const sItemKey = pKind + '::' + pKey;

        if (!oPending[sServerId]) {
            oPending[sServerId] = {};
        }

        const oServerPending = oPending[sServerId];

        if (oServerPending[sItemKey]) {
            return;
        }

        const oEntry = {sKind: pKind, sAction: pAction, sKey: pKey, nStarted: Date.now(), nChecks: 0, bPoll: false};
        oServerPending[sItemKey] = oEntry;
        rerenderCard(sServerId, pKind);

        const oMessage = pKind === 'docker'
            ? {action: 'controlDocker', serverId: sServerId, containerId: pId, command: pAction}
            : {action: 'controlVM', serverId: sServerId, vmId: pId, command: pAction};

        chrome.runtime.sendMessage(oMessage, (pResponse) => {

            const bNoAnswer = !!chrome.runtime.lastError || !pResponse;

            if (oServerPending[sItemKey] !== oEntry) {
                return;
            }

            if (pResponse?.error === 'PERMISSION_DENIED') {

                delete oServerPending[sItemKey];

                if (sServerId === sActiveServerId) {
                    sCurrentKeyType = 'readonly';
                    renderDashboard();
                }

                return;
            }

            let sOutcome = 'unknown';

            if (!bNoAnswer) {
                sOutcome = pResponse.success ? 'success' : (pResponse.outcome || 'failed');
            }

            /* Container pause/resume/restart can be missing from the server's schema;
               VM actions exist on every supported version */
            const sFeature = pKind === 'docker' ? {pause: 'pause', resume: 'pause', restart: 'restart'}[pAction] : null;

            if (sOutcome === 'unsupported' && sFeature) {

                delete oServerPending[sItemKey];
                oUnsupported[sServerId] = {...oUnsupported[sServerId], [sFeature]: true};

            } else if (sOutcome === 'unsupported' || sOutcome === 'failed') {

                delete oServerPending[sItemKey];
                const sText = 'Could not ' + pAction + ' ' + pLabel + ': ' + getErrorMessage(pResponse.error);
                setRowNote(sServerId, sItemKey, sText, 'error', NOTE_ERROR_MS);

            } else if (pAction === 'restart' && sOutcome === 'success') {

                /* The server answers a restart only after the new state settled */
                delete oServerPending[sItemKey];

                if (oRowNotes[sServerId]) {
                    delete oRowNotes[sServerId][sItemKey];
                }

                if (sServerId === sActiveServerId) {
                    fetchAndRender(true);
                }

            } else if (pAction === 'restart') {

                /* No answer: polls cannot tell a finished restart from one that never happened */
                setTimeout(() => {

                    if (oServerPending[sItemKey] === oEntry) {
                        delete oServerPending[sItemKey];
                        setRowNote(sServerId, sItemKey, 'Status unknown, refresh to check', 'info', NOTE_ERROR_MS);
                        rerenderCard(sServerId, pKind);
                    }
                }, Math.max(0, oEntry.nStarted + RESTART_CAP_MS - Date.now()));

            } else {

                oEntry.bPoll = true;
                scheduleStatusCheck(pKind);
            }

            rerenderCard(sServerId, pKind);
        });
    };

    /**
     * Starts an update for one container, or for every container with an update (Update all).
     * The background stores the operation so it survives a closed popup; status checks decide the result.
     * @param {Array} pContainers - Container objects to update
     * @param {boolean} pBulk - True for Update all (a summary is shown when every container is resolved)
     */
    const startUpdate = (pContainers, pBulk) => {

        const sServerId = sActiveServerId;

        if (oUpdateOps[sServerId] || pContainers.length === 0) {
            return;
        }

        const oItems = {};

        pContainers.forEach((pC) => {

            oItems[getContainerName(pC)] = {id: pC.id, startState: pC.state};
        });

        const oOp = {
            bulk: pBulk,
            startedAt: Date.now(),
            items: oItems,
            total: pContainers.length,
            done: 0,
            failed: 0,
            unknown: 0
        };

        oUpdateOps[sServerId] = oOp;
        rerenderCard(sServerId, 'docker');
        scheduleStatusCheck('update');

        chrome.runtime.sendMessage({action: 'updateContainers', serverId: sServerId, record: oOp}, (pResponse) => {

            const bNoAnswer = !!chrome.runtime.lastError || !pResponse;

            /* Success or no answer: status checks decide the result */
            if (oUpdateOps[sServerId] !== oOp || bNoAnswer || pResponse.success || pResponse.outcome === 'unknown') {
                return;
            }

            if (pResponse.outcome === 'unsupported') {

                delete oUpdateOps[sServerId];
                oUnsupported[sServerId] = {...oUnsupported[sServerId], update: true};

            } else {

                /* The next status check marks every container that is not updated yet as failed */
                oOp.failMessage = pResponse.error;

                if (sServerId === sActiveServerId && !oPollBusy.update) {
                    clearTimeout(oPollTimers.update);
                    runStatusCheck('update');
                }
            }

            persistUpdateOp(sServerId);
            rerenderCard(sServerId, 'docker');
        });
    };

    /**
     * Writes the update operation of a server to storage, or removes it once it is finished
     * @param {string} pServerId - The server ID
     */
    const persistUpdateOp = (pServerId) => {

        chrome.storage.local.get(['pendingUpdates'], (pResult) => {

            const oAll = pResult.pendingUpdates || {};

            if (oUpdateOps[pServerId]) {
                oAll[pServerId] = oUpdateOps[pServerId];
            } else {
                delete oAll[pServerId];
            }

            chrome.storage.local.set({pendingUpdates: oAll});
        });
    };

    /**
     * Returns the pending items of the active server that a status check of this kind resolves
     * @param {string} pKind - 'docker', 'vm' or 'update'
     * @returns {Array} [rowKey, entry] pairs, or [containerName, item] pairs for 'update'
     */
    const getCheckEntries = (pKind) => {

        if (pKind === 'update') {
            return Object.entries(oUpdateOps[sActiveServerId]?.items || {});
        }

        return Object.entries(oPending[sActiveServerId] || {}).filter(([, pEntry]) => {

            return pEntry.sKind === pKind && pEntry.bPoll;
        });
    };

    /**
     * Schedules the next status check of one kind for the active server while it has pending items
     * @param {string} pKind - 'docker', 'vm' or 'update'
     */
    const scheduleStatusCheck = (pKind) => {

        if (oPollTimers[pKind] || oPollBusy[pKind] || getCheckEntries(pKind).length === 0) {
            return;
        }

        const nDelay = pKind === 'update' ? POLL_UPDATE_MS : POLL_ACTION_MS;
        oPollTimers[pKind] = setTimeout(() => runStatusCheck(pKind), nDelay);
    };

    /**
     * Runs one narrow status query for the active server, refreshes the row states from it,
     * and resolves pending items: target state reached, poll cap hit, or update finished/failed/capped
     * @param {string} pKind - 'docker', 'vm' or 'update'
     */
    const runStatusCheck = (pKind) => {

        oPollTimers[pKind] = null;

        const sServerId = sActiveServerId;
        const nGen = nViewGen;

        if (getCheckEntries(pKind).length === 0) {
            return;
        }

        oPollBusy[pKind] = true;

        chrome.runtime.sendMessage({action: 'fetchStatus', serverId: sServerId, kind: pKind}, (pResponse) => {

            const oData = chrome.runtime.lastError ? null : pResponse?.data;

            if (nGen !== nViewGen) {
                return;
            }

            oPollBusy[pKind] = false;

            const bVm = pKind === 'vm';
            const oFreshByKey = {};

            ((bVm ? oData?.vms?.domains : oData?.docker?.containers) || []).forEach((pItem) => {

                oFreshByKey[bVm ? pItem.id : getContainerName(pItem)] = pItem;
            });

            ((bVm ? oCurrentData?.vms?.domains : oCurrentData?.docker?.containers) || []).forEach((pItem) => {

                const oFresh = oFreshByKey[bVm ? pItem.id : getContainerName(pItem)];

                if (oFresh) {
                    pItem.state = oFresh.state;
                    pItem.id = oFresh.id;
                }
            });

            if (pKind !== 'update') {

                getCheckEntries(pKind).forEach(([pItemKey, pEntry]) => {

                    pEntry.nChecks++;

                    const oFresh = oFreshByKey[pEntry.sKey];

                    if (oFresh && TARGET_STATES[pEntry.sAction].includes(oFresh.state)) {

                        delete oPending[sServerId][pItemKey];

                        if (oRowNotes[sServerId]) {
                            delete oRowNotes[sServerId][pItemKey];
                        }

                    } else if (pEntry.nChecks >= POLL_ACTION_MAX) {

                        delete oPending[sServerId][pItemKey];
                        setRowNote(sServerId, pItemKey, 'Status unknown, refresh to check', 'info', NOTE_ERROR_MS);
                    }
                });

            } else if (oUpdateOps[sServerId]) {

                const oOp = oUpdateOps[sServerId];
                const aStatuses = oData?.docker?.containerUpdateStatuses;
                const oUpdateByName = {};
                const bCapped = Date.now() - oOp.startedAt >= UPDATE_CAP_MS;
                let bChanged = false;

                (aStatuses || []).forEach((pS) => {

                    oUpdateByName[pS.name] = pS.updateStatus;
                });

                if (aStatuses && oCurrentData?.docker) {
                    oCurrentData.docker.updateStatuses = aStatuses;
                }

                Object.entries(oOp.items).forEach(([pName, pItem]) => {

                    const oFresh = oFreshByKey[pName];

                    /* A container that was stopped before its update stays stopped after it */
                    const bDone = !!aStatuses && !!oFresh && !UPDATE_STATUSES.includes(oUpdateByName[pName]) &&
                        (oFresh.state === 'RUNNING' || pItem.startState !== 'RUNNING');
                    const sItemKey = 'docker::' + pName;
                    const sLabel = getItemDisplayName(pName, pName);

                    if (bDone) {
                        oOp.done++;
                        setRowNote(sServerId, sItemKey, sLabel + ' updated', 'success', NOTE_SUCCESS_MS);
                    } else if (oOp.failMessage) {
                        oOp.failed++;
                        const sText = 'Update failed for ' + sLabel + ': ' + getErrorMessage(oOp.failMessage);
                        setRowNote(sServerId, sItemKey, sText, 'error', NOTE_ERROR_MS);
                    } else if (bCapped) {
                        oOp.unknown++;
                        const sText = 'Update status unknown. Refresh to check.';
                        setRowNote(sServerId, sItemKey, sText, 'info', NOTE_ERROR_MS);
                    } else {
                        return;
                    }

                    delete oOp.items[pName];
                    bChanged = true;
                });

                if (Object.keys(oOp.items).length === 0) {

                    if (oOp.bulk) {

                        const sSummary = 'Updated ' + oOp.done + ' of ' + oOp.total +
                            (oOp.failed > 0 ? ', ' + oOp.failed + ' failed' : '') +
                            (oOp.unknown > 0 ? ', ' + oOp.unknown + ' unknown' : '');

                        oUpdateSummary[sServerId] = sSummary;

                        setTimeout(() => {

                            if (oUpdateSummary[sServerId] === sSummary) {
                                delete oUpdateSummary[sServerId];
                                rerenderCard(sServerId, 'docker');
                            }
                        }, SUMMARY_MS);
                    }

                    delete oUpdateOps[sServerId];
                    fetchAndRender(true);
                }

                if (bChanged) {
                    persistUpdateOp(sServerId);
                }
            }

            rerenderCard(sServerId, pKind);
            scheduleStatusCheck(pKind);
        });
    };

    /**
     * Binds click handlers to container control and settings buttons
     * @param {HTMLElement} pContainer - The card element containing the action buttons
     */
    const bindContainerActions = (pContainer) => {

        bindItemControls(pContainer);

        pContainer.querySelectorAll('[data-action="updateDocker"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                const oContainer = (oCurrentData?.docker?.containers || []).find(
                    (pC) => getContainerName(pC) === pBtn.dataset.name
                );

                if (!pBtn.disabled && oContainer) {
                    startUpdate([oContainer], false);
                }
            });
        });

        pContainer.querySelectorAll('[data-action="openUrlOverride"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                openUrlOverrideModal(pBtn.dataset.id, 'docker');
            });
        });
    };

    /**
     * Opens the item settings modal for URL override and name customization
     * @param {string} pItemId - The item identifier (container name or VM id)
     * @param {string} pType - The item type ('docker' or 'vm')
     */
    const openUrlOverrideModal = (pItemId, pType) => {

        sUrlOverrideItemKey = pItemId;
        sItemModalType = pType || 'docker';

        const sKey = getOverrideKey(pItemId);
        const sNameOverride = oItemNameOverrides[sKey] || '';
        let sOriginalName = pItemId;

        if (sItemModalType === 'docker') {

            const aContainers = oCurrentData?.docker?.containers || [];
            const oContainer = aContainers.find((pC) => getContainerName(pC) === pItemId);
            sOriginalName = oContainer ? getContainerName(oContainer) : pItemId;
            const sDetected = oContainer ? getDetectedUrl(oContainer) : '';
            const sOverride = oDockerUrlOverrides[sKey] || '';

            oUrlModalDetected.textContent = sDetected || 'No URL detected';
            oUrlModalCheckbox.checked = !!sOverride;
            oUrlModalInput.value = sOverride;
            oUrlModalInput.disabled = !sOverride;
            oUrlModalInput.classList.remove('ut-input--error');
            oUrlSection.style.display = '';

        } else {

            const aVMs = oCurrentData?.vms?.domains || [];
            const oVM = aVMs.find((pV) => pV.id === pItemId);
            sOriginalName = oVM ? (oVM.name || oVM.id || '?') : sOriginalName;
            oUrlSection.style.display = 'none';
        }

        oUrlModalName.textContent = sOriginalName;
        oItemNameInput.value = sNameOverride;
        oItemNameInput.placeholder = sOriginalName;

        oUrlModalBackdrop.style.display = 'flex';
    };

    /** Closes the item settings modal and clears modal state */
    const closeUrlOverrideModal = () => {

        oUrlModalBackdrop.style.display = 'none';
        sUrlOverrideItemKey = null;
        sItemModalType = null;
    };

    /** Saves the URL override and name customization from the modal, then re-renders */
    const saveUrlOverride = async () => {

        if (!sUrlOverrideItemKey) {
            return;
        }

        const sKey = getOverrideKey(sUrlOverrideItemKey);

        const sCustomName = oItemNameInput.value.trim();

        if (sCustomName) {
            oItemNameOverrides[sKey] = sCustomName;
        } else {
            delete oItemNameOverrides[sKey];
        }

        if (sItemModalType === 'docker') {

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
        }

        const sType = sItemModalType;
        await saveOverrides();
        closeUrlOverrideModal();

        if (sType === 'docker') {
            renderDockerCard();
        }

        if (sType === 'vm') {
            renderVMsCard();
        }

        setupCollapsibleCards();
    };

    /** Renders the VMs card with VM list, status dots, and control buttons */
    const renderVMsCard = () => {

        closeMoreMenu(false);

        const bVMsAvailable = oCurrentData.vms !== null && oCurrentData.vms !== undefined;
        const aVMs = oCurrentData.vms?.domains || [];
        const nRunning = aVMs.filter((pV) => pV.state === 'RUNNING').length;
        const nTotal = aVMs.length;

        const fnDisplayName = (pV) => getItemDisplayName(pV.id, getVMName(pV));
        const aSorted = sortListItems(aVMs, 'vms', fnDisplayName);
        const nMaxVisible = getVisibleCount('vms', aSorted.length);
        const nVisible = bVMsExpanded ? aSorted.length : Math.min(aSorted.length, nMaxVisible);
        const bShowMore = aSorted.length > nMaxVisible;

        const sVMBadge = bVMsAvailable
            ? nRunning + ' running / ' + nTotal + ' total'
            : 'unavailable';

        const oVMRight = buildEl('div', 'ut-card-header-right');
        oVMRight.appendChild(buildEl('span', 'ut-card-badge', sVMBadge));

        if (bVMsAvailable && nTotal > 0) {

            const oGear = buildEl('button', 'ut-card-gear');
            oGear.dataset.action = 'openListSettings';
            oGear.dataset.cardType = 'vms';
            oGear.title = 'List settings';
            oGear.appendChild(createSvgIcon('#ico-settings'));
            oVMRight.appendChild(oGear);
        }

        oCardVMs.textContent = '';
        oCardVMs.appendChild(buildCardHeader('#ico-vm', 'VMs', null, oVMRight));

        const oBody = buildEl('div', 'ut-card-body');
        oCardVMs.appendChild(oBody);

        if (!bVMsAvailable) {

            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'VM service not enabled on this server')
            );

        } else if (nTotal === 0) {

            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'No VMs found')
            );

        } else {

            const oFrag = document.createDocumentFragment();

            for (let i = 0; i < nVisible; i++) {
                oFrag.appendChild(renderVMRow(aSorted[i]));
            }

            oBody.appendChild(oFrag);

            if (bShowMore) {

                const oShowMoreBtn = document.createElement('button');
                oShowMoreBtn.className = 'ut-show-more';
                oShowMoreBtn.dataset.target = 'vms';
                oShowMoreBtn.textContent = bVMsExpanded ? 'Show less' : 'Show all ' + nTotal + '...';

                oShowMoreBtn.addEventListener('click', () => {

                    bVMsExpanded = !bVMsExpanded;
                    renderVMsCard();
                    setupCollapsibleCards();
                });

                oBody.appendChild(oShowMoreBtn);
            }
        }

        if (bVMsAvailable) {
            bindVMActions(oCardVMs);
        }

        const oVMGearBtn = oCardVMs.querySelector('[data-action="openListSettings"]');

        if (oVMGearBtn) {

            oVMGearBtn.addEventListener('click', () => {

                openListSettingsModal('vms');
            });
        }

    };

    /**
     * Renders a single VM row with status, name, and action buttons
     * @param {Object} pVM - The VM domain object from the API
     * @returns {HTMLElement} The VM row element
     */
    const renderVMRow = (pVM) => {

        const sOriginalName = pVM.name || pVM.id || '?';
        const sName = getItemDisplayName(pVM.id, sOriginalName);
        const bRunning = pVM.state === 'RUNNING';
        const bPaused = pVM.state === 'PAUSED';
        const sStatusClass = bRunning ? 'running' : (bPaused ? 'paused' : 'stopped');
        const sCommand = bRunning ? 'stop' : (bPaused ? 'resume' : 'start');
        const bHasNameOverride = !!oItemNameOverrides[getOverrideKey(pVM.id)];

        const oRow = document.createElement('div');
        oRow.className = 'ut-item-row';

        const oNameDiv = document.createElement('div');
        oNameDiv.className = 'ut-item-name';

        const oDot = document.createElement('span');
        oDot.className = 'ut-status-dot ut-status-dot--' + sStatusClass;
        oNameDiv.appendChild(oDot);

        const oSpan = document.createElement('span');
        oSpan.textContent = sName;
        oNameDiv.appendChild(oSpan);

        oRow.appendChild(oNameDiv);

        const oActions = document.createElement('div');
        oActions.className = 'ut-item-actions';

        const oGearBtn = document.createElement('button');
        oGearBtn.className = 'ut-item-action' + (bHasNameOverride ? ' ut-item-action-url--active' : '');
        oGearBtn.title = 'VM settings';
        oGearBtn.dataset.action = 'openVmSettings';
        oGearBtn.dataset.id = pVM.id;
        oGearBtn.appendChild(createSvgIcon('#ico-settings'));
        oActions.appendChild(oGearBtn);

        appendItemControls(oRow, oActions, {
            sKind: 'vm',
            sId: pVM.id,
            sKey: pVM.id,
            sLabel: sName,
            sCommand: sCommand,
            aMenu: bRunning || bPaused ? ['restart'] : [],
            sPending: oPending[sActiveServerId]?.['vm::' + pVM.id]?.sAction || null
        });

        return oRow;
    };

    /**
     * Binds click handlers to VM control and settings buttons
     * @param {HTMLElement} pContainer - The card element containing the action buttons
     */
    const bindVMActions = (pContainer) => {

        pContainer.querySelectorAll('[data-action="openVmSettings"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                openUrlOverrideModal(pBtn.dataset.id, 'vm');
            });
        });

        bindItemControls(pContainer);
    };

    /**
     * Builds a notification summary row with icon, count, and label
     * @param {string} pIconRef - Sprite icon reference
     * @param {string} pIconClass - CSS modifier class for the icon
     * @param {number} pCount - Notification count
     * @param {string} pLabel - Description label
     * @returns {HTMLElement} The notification row element
     */
    const buildNotifRow = (pIconRef, pIconClass, pCount, pLabel) => {

        const oRow = buildEl('div', 'ut-notif-row');
        oRow.appendChild(createSvgIcon(pIconRef, 'ut-notif-icon ut-notif-icon--' + pIconClass));
        oRow.appendChild(buildEl('span', 'ut-notif-count', String(pCount)));
        oRow.appendChild(buildEl('span', 'ut-notif-label', pLabel));
        return oRow;
    };

    /** Renders the Notifications card with summary counts and expandable detail list */
    const renderNotificationsCard = () => {

        const oNotifs = oCurrentData.notifications?.overview?.unread || {};
        const nTotal = oNotifs.total || 0;
        const nInfo = oNotifs.info || 0;
        const nWarning = oNotifs.warning || 0;
        const nAlert = oNotifs.alert || 0;

        oCardNotifications.textContent = '';

        const oRight = buildEl('div', 'ut-card-header-right');
        oRight.appendChild(buildEl('span', 'ut-card-badge', nTotal + ' unread'));

        if (nTotal > 0) {

            const oArchiveBtn = buildEl('button', 'ut-notif-header-archive');
            oArchiveBtn.dataset.action = 'archiveAll';

            if (sCurrentKeyType === 'readonly') {
                oArchiveBtn.disabled = true;
                oArchiveBtn.title = 'View-only API key';
            } else {
                oArchiveBtn.title = 'Archive all notifications';
            }

            oArchiveBtn.appendChild(createSvgIcon('#ico-check'));
            oArchiveBtn.appendChild(buildEl('span', null, 'Archive All'));
            oRight.appendChild(oArchiveBtn);
        }

        const oHeader = buildCardHeader('#ico-bell', 'Notifications', null, oRight);
        oHeader.appendChild(createSvgIcon('#ico-chevron', 'ut-icon ut-card-chevron'));
        oCardNotifications.appendChild(oHeader);

        const oBody = buildEl('div', 'ut-card-body');

        if (nTotal === 0) {

            oBody.appendChild(buildEl('div', 'ut-detail-row')).appendChild(
                buildEl('span', 'ut-detail-label', 'No unread notifications')
            );

        } else {

            const oSummary = buildEl('div', 'ut-notif-summary');

            if (nAlert > 0) oSummary.appendChild(buildNotifRow('#ico-warning', 'alert', nAlert, 'alert' + (nAlert !== 1 ? 's' : '')));
            if (nWarning > 0) oSummary.appendChild(buildNotifRow('#ico-warning', 'warning', nWarning, 'warning' + (nWarning !== 1 ? 's' : '')));
            if (nInfo > 0) oSummary.appendChild(buildNotifRow('#ico-info', 'info', nInfo, 'info'));

            oBody.appendChild(oSummary);
        }

        oCardNotifications.appendChild(oBody);

        if (bNotificationsExpanded) {

            const oBody = oCardNotifications.querySelector('.ut-card-body');

            if (bNotificationsLoading) {

                const oLoading = document.createElement('div');
                oLoading.className = 'ut-notif-list-loading';
                oLoading.textContent = 'Loading notifications...';
                oBody.appendChild(oLoading);

            } else if (aNotificationItems.length > 0) {

                const oListDiv = document.createElement('div');
                oListDiv.className = 'ut-notif-list';

                const oFrag = document.createDocumentFragment();

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

                    const oItem = document.createElement('div');
                    oItem.className = 'ut-notif-item';

                    const oHeader = document.createElement('div');
                    oHeader.className = 'ut-notif-item-header';

                    oHeader.appendChild(createSvgIcon(sIconRef, 'ut-notif-icon ut-notif-icon--' + sIconClass));

                    const oTitle = document.createElement('span');
                    oTitle.className = 'ut-notif-item-title';
                    oTitle.textContent = pNotif.title || pNotif.subject || 'Notification';
                    oHeader.appendChild(oTitle);

                    const oArchiveBtn = document.createElement('button');
                    oArchiveBtn.className = 'ut-notif-archive-btn';
                    oArchiveBtn.dataset.action = 'archiveNotification';
                    oArchiveBtn.dataset.id = pNotif.id;

                    if (sCurrentKeyType === 'readonly') {
                        oArchiveBtn.disabled = true;
                        oArchiveBtn.title = 'View-only API key';
                    } else {
                        oArchiveBtn.title = 'Archive';
                    }

                    oArchiveBtn.appendChild(createSvgIcon('#ico-check'));
                    oHeader.appendChild(oArchiveBtn);

                    oItem.appendChild(oHeader);

                    const sSubject = pNotif.subject && pNotif.title ? pNotif.subject : '';

                    if (sSubject) {

                        const oSubject = document.createElement('div');
                        oSubject.className = 'ut-notif-item-subject';
                        oSubject.textContent = sSubject;
                        oItem.appendChild(oSubject);
                    }

                    const sTime = formatTimestamp(pNotif.timestamp);

                    if (sTime) {

                        const oTime = document.createElement('div');
                        oTime.className = 'ut-notif-item-time';
                        oTime.textContent = sTime;
                        oItem.appendChild(oTime);
                    }

                    oFrag.appendChild(oItem);
                });

                oListDiv.appendChild(oFrag);
                oBody.appendChild(oListDiv);

            } else {

                const oEmpty = document.createElement('div');
                oEmpty.className = 'ut-notif-list-loading';
                oEmpty.textContent = 'No notification details available';
                oBody.appendChild(oEmpty);
            }
        }

        if (oSettings.collapsedCards.notifications) {
            oCardNotifications.classList.add('ut-card--collapsed');
        } else {
            oCardNotifications.classList.remove('ut-card--collapsed');
        }

        /* No collapseBound guard needed -- textContent='' above destroys
           the old header and its listeners on every render. */
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

    /** Fetches the unread notification list from the server and re-renders the card */
    const fetchNotificationList = () => {

        nNotifGen++;
        const nGen = nNotifGen;
        const sServerId = sActiveServerId;

        bNotificationsLoading = true;
        renderNotificationsCard();

        chrome.runtime.sendMessage({
            action: 'fetchNotifications',
            serverId: sServerId,
            filter: {type: 'UNREAD', offset: 0, limit: 50}
        }, (pResponse) => {

            const sLastError = chrome.runtime.lastError?.message;

            if (nGen !== nNotifGen || sServerId !== sActiveServerId) {
                return;
            }

            bNotificationsLoading = false;

            if (sLastError) {
                console.warn('fetchNotifications error:', sLastError);
                renderNotificationsCard();
                return;
            }

            if (pResponse?.data) {
                aNotificationItems = pResponse.data;
            }

            renderNotificationsCard();
        });
    };

    /**
     * Binds click handlers to notification archive buttons (individual and bulk)
     * @param {HTMLElement} pContainer - The card element containing the action buttons
     */
    const bindNotificationActions = (pContainer) => {

        pContainer.querySelectorAll('[data-action="archiveNotification"]').forEach((pBtn) => {

            pBtn.addEventListener('click', () => {

                if (pBtn.disabled) {
                    return;
                }

                pBtn.disabled = true;

                const sServerId = sActiveServerId;

                chrome.runtime.sendMessage({
                    action: 'archiveNotification',
                    serverId: sServerId,
                    notificationId: pBtn.dataset.id
                }, (pResponse) => {

                    const sLastError = chrome.runtime.lastError?.message;

                    if (pResponse?.success) {
                        requestBadgeRefresh();
                    }

                    if (sServerId !== sActiveServerId) {
                        return;
                    }

                    if (sLastError) {
                        console.warn('archiveNotification error:', sLastError);
                        pBtn.disabled = false;
                        return;
                    }

                    if (pResponse?.error === 'PERMISSION_DENIED') {
                        sCurrentKeyType = 'readonly';
                        renderDashboard();
                        return;
                    }

                    if (pResponse?.success) {

                        aNotificationItems = aNotificationItems.filter((pN) => pN.id !== pBtn.dataset.id);
                        fetchAndRender(true);
                    } else {
                        pBtn.disabled = false;
                    }
                });
            });
        });

        const oArchiveAll = pContainer.querySelector('[data-action="archiveAll"]');

        if (oArchiveAll) {

            oArchiveAll.addEventListener('click', () => {

                if (oArchiveAll.disabled) {
                    return;
                }

                oArchiveAll.disabled = true;

                const oLabel = oArchiveAll.querySelector('span');

                if (oLabel) {
                    oLabel.textContent = 'Archiving...';
                }

                const sServerId = sActiveServerId;

                chrome.runtime.sendMessage({
                    action: 'archiveAll',
                    serverId: sServerId
                }, (pResponse) => {

                    const sLastError = chrome.runtime.lastError?.message;

                    if (pResponse?.success) {
                        requestBadgeRefresh();
                    }

                    if (sServerId !== sActiveServerId) {
                        return;
                    }

                    if (sLastError) {
                        console.warn('archiveAll error:', sLastError);
                        oArchiveAll.disabled = false;
                        if (oLabel) oLabel.textContent = 'Archive All';
                        return;
                    }

                    if (pResponse?.error === 'PERMISSION_DENIED') {
                        sCurrentKeyType = 'readonly';
                        renderDashboard();
                        return;
                    }

                    if (pResponse?.success) {

                        aNotificationItems = [];
                        bNotificationsExpanded = false;
                        fetchAndRender(true);
                    } else {
                        oArchiveAll.disabled = false;
                        if (oLabel) oLabel.textContent = 'Archive All';
                    }
                });
            });
        }
    };

    /**
     * Formats a timestamp into a relative time string (e.g. '5m ago', '2d ago')
     * @param {string|number} pTimestamp - ISO string or millisecond timestamp
     * @returns {string} Relative time string, or empty if invalid
     */
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

    /**
     * Renders a labeled progress bar with percentage and optional tooltip
     * @param {string} pLabel - The progress bar label
     * @param {number} pPercent - The fill percentage (0-100)
     * @param {string} [pTooltip] - Optional tooltip text for the row
     * @param {boolean} [pPlain] - If true, no warn/danger colors (progress, not usage)
     * @returns {HTMLElement} The progress bar row element
     */
    const renderProgressBar = (pLabel, pPercent, pTooltip, pPlain) => {

        const oRow = buildEl('div', 'ut-progress-row');
        if (pTooltip) oRow.title = pTooltip;

        oRow.appendChild(buildEl('span', 'ut-progress-label', pLabel));

        const oBar = buildEl('div', 'ut-progress-bar');
        const oFill = buildEl('div', 'ut-progress-fill');
        if (!pPlain && pPercent >= 90) oFill.classList.add('danger');
        else if (!pPlain && pPercent >= 75) oFill.classList.add('warn');
        oFill.style.width = pPercent + '%';
        oBar.appendChild(oFill);
        oRow.appendChild(oBar);

        oRow.appendChild(buildEl('span', 'ut-progress-value', pPercent + '%'));

        return oRow;
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

    /**
     * Formats a byte count into a human-readable string (e.g. '1.5 GB')
     * @param {number} pBytes - The byte count
     * @returns {string} Formatted string with appropriate unit
     */
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

    /** Renders the card order list in settings with checkboxes and drag handles */
    const renderCardOrderList = () => {

        const oList = document.getElementById('cardOrderList');
        oList.textContent = '';

        const aOrder = oSettings.cardOrder || DEFAULT_SETTINGS.cardOrder;
        const oVis = oSettings.visibleCards;

        aOrder.forEach((pKey) => {

            const oRow = document.createElement('div');
            oRow.className = 'ut-card-order-row';
            oRow.draggable = true;
            oRow.dataset.card = pKey;

            const oHandle = document.createElement('span');
            oHandle.className = 'ut-drag-handle';
            oHandle.appendChild(createSvgIcon('#ico-drag'));
            oRow.appendChild(oHandle);

            const oCheckbox = document.createElement('input');
            oCheckbox.type = 'checkbox';
            oCheckbox.checked = oVis[pKey] !== false;
            oCheckbox.dataset.card = pKey;
            oCheckbox.addEventListener('change', () => {

                oSettings.visibleCards[pKey] = oCheckbox.checked;
                saveStorage();
            });
            oRow.appendChild(oCheckbox);

            const oLabel = document.createElement('span');
            oLabel.textContent = CARD_LABELS[pKey] || pKey;
            oRow.appendChild(oLabel);

            oList.appendChild(oRow);
        });

        setupCardOrderDrag(oList);
    };

    /**
     * Attaches drag-and-drop event listeners to the card order list rows
     * @param {HTMLElement} pList - The card order list container element
     */
    const setupCardOrderDrag = (pList) => {

        let oDragRow = null;

        const aRows = pList.querySelectorAll('.ut-card-order-row');

        aRows.forEach((pRow) => {

            pRow.addEventListener('dragstart', (pEvent) => {

                oDragRow = pRow;
                pRow.classList.add('dragging');
                pEvent.dataTransfer.effectAllowed = 'move';
            });

            pRow.addEventListener('dragend', () => {

                pRow.classList.remove('dragging');

                pList.querySelectorAll('.drag-over').forEach(
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
                    pList.insertBefore(oDragRow, pRow);
                } else {
                    pList.insertBefore(oDragRow, pRow.nextSibling);
                }
            });
        });
    };

    /**
     * Reads the current card order from the settings DOM
     * @returns {string[]} Array of card keys in their current DOM order
     */
    const readCardOrderFromDOM = () => {

        const oList = document.getElementById('cardOrderList');
        const aRows = oList.querySelectorAll('.ut-card-order-row');
        const aOrder = [];

        aRows.forEach((pRow) => {

            aOrder.push(pRow.dataset.card);
        });

        return aOrder;
    };

    /** Opens the settings panel and renders the server list and settings values */
    const openSettings = () => {

        oSettingsPanel.style.display = 'block';
        oServerForm.style.display = 'none';
        renderServerList();
        applySettingsValues();
    };

    /** Closes the settings panel, saves card order, and resumes auto-refresh */
    const closeSettings = () => {

        oSettings.cardOrder = readCardOrderFromDOM();
        saveStorage();

        oSettingsPanel.style.display = 'none';
        oServerForm.style.display = 'none';

        renderServerTabs();
        fetchAndRender(true);
        setupAutoRefresh();
    };

    /** Populates the settings form controls with current setting values */
    const applySettingsValues = () => {

        oRefreshInterval.value = String(oSettings.refreshInterval);
        renderCardOrderList();
    };

    /** Renders the server list in the settings panel with edit and delete buttons */
    const renderServerList = () => {

        oServerList.textContent = '';

        if (aServers.length === 0) {

            oServerList.appendChild(buildEl('div', 'ut-server-list-empty', 'No servers added yet'));
            return;
        }

        aServers.forEach((pServer) => {

            const oItem = buildEl('div', 'ut-server-item');

            const oInfo = buildEl('div', 'ut-server-item-info');
            oInfo.appendChild(buildEl('div', 'ut-server-item-name', pServer.name || 'Unnamed'));
            oInfo.appendChild(buildEl('div', 'ut-server-item-url', pServer.url));
            oItem.appendChild(oInfo);

            const oActions = buildEl('div', 'ut-server-item-actions');

            const oEditBtn = buildEl('button', 'ut-icon-btn edit-server');
            oEditBtn.title = 'Edit';
            oEditBtn.appendChild(createSvgIcon('#ico-edit'));
            oEditBtn.addEventListener('click', () => {

                const oServer = aServers.find((pS) => pS.id === pServer.id);
                if (oServer) openServerForm(oServer);
            });
            oActions.appendChild(oEditBtn);

            const oDeleteBtn = buildEl('button', 'ut-icon-btn delete');
            oDeleteBtn.title = 'Delete';
            oDeleteBtn.appendChild(createSvgIcon('#ico-trash'));
            oDeleteBtn.addEventListener('click', () => {

                if (!confirm('Delete server "' + (pServer.name || 'Unnamed') + '"? This cannot be undone.')) {
                    return;
                }

                const sDeletedId = pServer.id;
                aServers = aServers.filter((pS) => pS.id !== sDeletedId);

                const sPrefix = sDeletedId + '::';
                [oDockerUrlOverrides, oItemNameOverrides].forEach((pOverrides) => {

                    Object.keys(pOverrides).forEach((pKey) => {

                        if (pKey.startsWith(sPrefix)) {
                            delete pOverrides[pKey];
                        }
                    });
                });

                chrome.storage.local.get('encryptedKeys', (pResult) => {

                    const oKeys = pResult.encryptedKeys || {};
                    if (oKeys[sDeletedId]) {
                        delete oKeys[sDeletedId];
                        chrome.storage.local.set({encryptedKeys: oKeys});
                    }
                });

                if (sActiveServerId === sDeletedId && aServers.length > 0) {
                    sActiveServerId = aServers[0].id;
                    resetServerView();
                }

                delete oSettings.customOrders[sDeletedId];
                delete oPending[sDeletedId];
                delete oUpdateOps[sDeletedId];
                persistUpdateOp(sDeletedId);

                saveOverrides();
                saveStorage().then(requestBadgeRefresh);
                renderServerList();
            });
            oActions.appendChild(oDeleteBtn);

            oItem.appendChild(oActions);
            oServerList.appendChild(oItem);
        });
    };

    /**
     * Opens the server add/edit form, pre-filling fields if editing
     * @param {Object} [pServer] - Server object to edit, or undefined for new
     */
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

    /** Closes the server form and hides the test result */
    const closeServerForm = () => {

        oServerForm.style.display = 'none';
        oTestResult.style.display = 'none';
    };

    /**
     * Requests host permission for the given server URL origin. permissions.request() runs before the
     * first await here, so a caller must invoke this before its own first await: Firefox only accepts the
     * request synchronously inside the click handler.
     * @param {string} pUrl - The server URL to request permission for
     * @returns {Promise<boolean>} True if permission was granted
     */
    const requestHostPermission = async (pUrl) => {

        try {

            const oUrl = new URL(pUrl);
            const sOrigin = oUrl.origin + '/*';
            const bGranted = await chrome.permissions.request({origins: [sOrigin]});
            return !!bGranted;

        } catch (_) {

            return false;
        }
    };

    /**
     * Saves the server form as a staged record: it is stored with a pending-permission marker (plus a
     * snapshot of the previous record on edit) before the permission answer, because the prompt may
     * close the popup and end this function. The marker is settled here, or on the next popup open.
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

        const pGrant = requestHostPermission(sUrl);

        const sId = oServerFormId.value || ('server-' + Date.now());
        const nExisting = aServers.findIndex((pS) => pS.id === sId);

        const oServer = {
            id: sId,
            name: sName,
            url: sUrl,
            apiKey: sKey,
            enabled: true,
            pendingPermission: true
        };

        if (nExisting >= 0) {

            const oExisting = aServers[nExisting];
            const oSnapshot = {...oExisting};

            delete oSnapshot.pendingPermission;
            delete oSnapshot.prev;

            /* A record still staged by an unsettled earlier save keeps its original snapshot */
            const oPrev = oExisting.pendingPermission ? oExisting.prev : oSnapshot;

            if (oPrev) {
                oServer.prev = oPrev;
            }

            aServers[nExisting] = oServer;

        } else {
            aServers.push(oServer);
        }

        if (!sActiveServerId) {
            sActiveServerId = sId;
        }

        await saveStorage();

        const bGranted = await pGrant;
        resolveStagedServer(sId, bGranted);

        if (!aServers.find((pS) => pS.id === sActiveServerId)) {
            sActiveServerId = aServers.length > 0 ? aServers[0].id : null;
        }

        if (bGranted && nExisting < 0 && sActiveServerId !== sId) {
            sActiveServerId = sId;
            resetServerView();
        }

        await saveStorage();

        if (!bGranted) {
            showTestResult('Host permission denied. The extension needs access to connect to this server.', false);
            return;
        }

        closeServerForm();
        renderServerList();
        requestBadgeRefresh();
    };

    /**
     * Settles a staged server save: keeps the record when the host permission is granted,
     * otherwise restores the previous record (edit) or removes the server (add)
     * @param {string} pServerId - The staged server ID
     * @param {boolean} pGranted - Whether the host permission is granted
     */
    const resolveStagedServer = (pServerId, pGranted) => {

        const nIdx = aServers.findIndex((pS) => pS.id === pServerId);

        if (nIdx === -1) {
            return;
        }

        const oServer = {...aServers[nIdx]};
        const oPrev = oServer.prev;

        delete oServer.pendingPermission;
        delete oServer.prev;

        if (pGranted) {
            aServers[nIdx] = oServer;
        } else if (oPrev) {
            aServers[nIdx] = {...oPrev, id: pServerId};
        } else {
            aServers.splice(nIdx, 1);
        }
    };

    /** Asks the background to recount unread notifications for the toolbar badge */
    const requestBadgeRefresh = () => {

        chrome.runtime.sendMessage({action: 'refreshBadge'}, () => {

            void chrome.runtime.lastError;
        });
    };

    /**
     * Displays a test connection result message
     * @param {string} pText - The result message
     * @param {boolean} pSuccess - If true, applies success styling; otherwise error
     */
    const showTestResult = (pText, pSuccess) => {

        oTestResult.textContent = pText;
        oTestResult.className = 'ut-test-result ' + (pSuccess ? 'success' : 'error');
        oTestResult.style.display = 'block';
    };

    /** Sets up the auto-refresh interval timer based on current settings */
    const setupAutoRefresh = () => {

        if (nRefreshTimer) {
            clearInterval(nRefreshTimer);
            nRefreshTimer = null;
        }

        const nInterval = oSettings.refreshInterval;

        if (nInterval > 0 && aServers.length > 0) {

            nRefreshTimer = setInterval(() => {

                if (oSettingsPanel.style.display === 'none') {
                    fetchAndRender(true);
                }

            }, nInterval);
        }
    };

    window.addEventListener('beforeunload', () => {

        if (nRefreshTimer) {
            clearInterval(nRefreshTimer);
        }
    });

    oThemeToggle.addEventListener('click', () => {

        oSettings.theme = oSettings.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        saveStorage();
    });

    oCompactToggle.addEventListener('click', () => {

        oSettings.compactMode = !oSettings.compactMode;
        applyCompact();
        saveStorage();
    });

    oRefreshBtn.addEventListener('click', () => {

        oRefreshBtn.classList.add('spinning');
        fetchAndRender(!!oCurrentData);

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

    oTestConnectionBtn.addEventListener('click', async () => {

        const sUrl = oServerFormUrl.value.trim().replace(/\/+$/, '');
        const sKey = oServerFormKey.value.trim();

        if (!sUrl || !sKey) {

            showTestResult('URL and API key are required.', false);
            return;
        }

        const bGranted = await requestHostPermission(sUrl);

        if (!bGranted) {

            showTestResult('Host permission is required to test this connection.', false);
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

                const sKeyLabel = pResponse.keyType === 'readonly' ? ' - view-only' : '';
                showTestResult('Connected to ' + pResponse.name + ' (v' + pResponse.version + ')' + sKeyLabel, true);

            } else {

                showTestResult(getErrorMessage(pResponse?.error), false);
            }
        });
    });

    oRefreshInterval.addEventListener('change', () => {

        oSettings.refreshInterval = parseInt(oRefreshInterval.value, 10);
        saveStorage().then(requestBadgeRefresh);
        setupAutoRefresh();
    });

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

    let bResizing = false;
    let nResizeStartX = 0;
    let nResizeStartY = 0;
    let nResizeStartW = 0;
    let nResizeStartH = 0;

    oResizeHandle.addEventListener('mousedown', (pEvent) => {

        bResizing = true;
        nResizeStartX = pEvent.screenX;
        nResizeStartY = pEvent.screenY;
        nResizeStartW = document.body.offsetWidth;
        nResizeStartH = document.body.offsetHeight;
        pEvent.preventDefault();
    });

    document.addEventListener('mousemove', (pEvent) => {

        if (!bResizing) {
            return;
        }

        const nDeltaX = pEvent.screenX - nResizeStartX;
        const nDeltaY = pEvent.screenY - nResizeStartY;

        const nNewW = Math.min(700, Math.max(380, nResizeStartW - nDeltaX));
        const nNewH = Math.min(800, Math.max(300, nResizeStartH + nDeltaY));

        document.body.style.width = nNewW + 'px';
        document.body.style.minHeight = nNewH + 'px';
        document.body.style.maxHeight = nNewH + 'px';
    });

    document.addEventListener('mouseup', () => {

        if (!bResizing) {
            return;
        }

        bResizing = false;

        oSettings.popupWidth = document.body.offsetWidth;
        oSettings.popupHeight = document.body.offsetHeight;
        saveStorage();
    });

    document.addEventListener('click', (pEvent) => {

        if (oOpenMenu && !oOpenMenu.oMenu.contains(pEvent.target) && !oOpenMenu.oAnchor.contains(pEvent.target)) {
            closeMoreMenu(false);
        }
    });

    document.addEventListener('focusin', (pEvent) => {

        if (oOpenMenu && !oOpenMenu.oMenu.contains(pEvent.target) && pEvent.target !== oOpenMenu.oAnchor) {
            closeMoreMenu(false);
        }
    });

    document.addEventListener('keydown', (pEvent) => {

        if (pEvent.key === 'Escape' && oOpenMenu) {
            pEvent.preventDefault();
            closeMoreMenu(true);
        }
    });

    /* The menu is positioned once; scrolling would detach it from its button */
    document.addEventListener('scroll', () => closeMoreMenu(false), true);

    const bKeyError = await loadStorage();

    /* Saves whose permission prompt closed the popup are settled from the actual grant */
    const aStaged = bKeyError ? [] : aServers.filter((pS) => pS.pendingPermission);

    for (const oStaged of aStaged) {

        let bGranted = false;

        try {
            bGranted = await chrome.permissions.contains({origins: [new URL(oStaged.url).origin + '/*']});
        } catch (_) {
            /* Unparsable URL: not granted */
        }

        resolveStagedServer(oStaged.id, bGranted);
    }

    if (aStaged.length > 0) {

        if (!aServers.find((pS) => pS.id === sActiveServerId)) {
            sActiveServerId = aServers.length > 0 ? aServers[0].id : null;
        }

        await saveStorage();
    }

    applyTheme();
    applyCompact();
    applyPopupDimensions();
    renderServerTabs();

    if (bKeyError) {
        showMessageText('Encryption key mismatch -- API keys could not be decrypted. Re-enter your API keys in Settings.', true);
    } else {
        fetchAndRender();
    }

    setupAutoRefresh();
};

runPopupLogic();
