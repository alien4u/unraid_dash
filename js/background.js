const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/** Generates or retrieves the AES-256-GCM encryption key from storage */
const getEncryptionKey = async () => {

    const oResult = await new Promise((resolve) => browserAPI.storage.local.get(['_ek'], resolve));

    if (oResult._ek) {
        // extractable: false -- import does not need re-export; raw bytes already persisted in _ek
        return crypto.subtle.importKey('raw', new Uint8Array(oResult._ek), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    const oKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const aRaw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', oKey)));
    await new Promise((resolve) => browserAPI.storage.local.set({_ek: aRaw}, resolve));

    return oKey;
};

/**
 * Encrypts a string value using AES-GCM with a random IV
 * @param {CryptoKey} pKey - The AES-GCM encryption key
 * @param {string} pValue - The plaintext value to encrypt
 * @returns {Object} Object containing iv and data arrays
 */
const encryptValue = async (pKey, pValue) => {

    const aIv = crypto.getRandomValues(new Uint8Array(12));
    const aData = await crypto.subtle.encrypt({name: 'AES-GCM', iv: aIv}, pKey, new TextEncoder().encode(pValue));

    return {iv: Array.from(aIv), data: Array.from(new Uint8Array(aData))};
};

/**
 * Decrypts an AES-GCM encrypted value back to a string
 * @param {CryptoKey} pKey - The AES-GCM encryption key
 * @param {Object} pEncrypted - Object with iv and data arrays from encryptValue
 * @returns {string} The decrypted plaintext value
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
 * @param {string} pUrl       - Base server URL
 * @param {string} pApiKey    - API key for x-api-key header
 * @param {string} pQuery     - GraphQL query string
 * @param {Object} [pVariables]
 * @returns {Promise<Object>}
 */
const executeGraphQL = async (pUrl, pApiKey, pQuery, pVariables) => {

    const sEndpoint = pUrl.replace(/\/+$/, '') + '/graphql';

    const oBody = {query: pQuery};

    if (pVariables) {
        oBody.variables = pVariables;
    }

    let oResponse;

    try {

        oResponse = await fetch(sEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': pApiKey
            },
            body: JSON.stringify(oBody),
            signal: AbortSignal.timeout(15000)
        });

    } catch (pErr) {

        /* The DOMException message differs per browser; only the name is reliable */
        if (pErr.name === 'TimeoutError') {
            throw new Error('TIMEOUT');
        }

        throw pErr;
    }

    if (!oResponse.ok) {

        if (oResponse.status === 401 || oResponse.status === 403) {
            throw new Error('AUTH_ERROR');
        }

        /* GraphQL often returns 400 with error details in the body */
        let sDetail = '';

        try {

            const oErrJson = await oResponse.json();

            if (oErrJson.errors && oErrJson.errors.length > 0) {
                sDetail = oErrJson.errors[0].message;
            } else if (oErrJson.message) {
                sDetail = oErrJson.message;
            }

        } catch (_) {
            /* Body not JSON */
        }

        throw new Error('HTTP_' + oResponse.status + (sDetail ? ': ' + sDetail : ''));
    }

    const oJson = await oResponse.json();

    /* GraphQL can return 200 with partial data + errors; extensions.code decides the class, never the message */
    if (oJson.errors && oJson.errors.length > 0) {

        const aErrors = oJson.errors.map((pE) => ({message: pE.message || '', code: pE.extensions?.code || null}));

        /* API 4.37 answers an invalid key with HTTP 200 instead of 401 */
        if (aErrors.some((pE) => pE.code === 'UNAUTHENTICATED')) {
            throw new Error('AUTH_ERROR');
        }

        if (oJson.data) {
            oJson.data._errors = aErrors;
            return oJson.data;
        }

        if (aErrors.some((pE) => pE.code === 'FORBIDDEN')) {
            throw new Error('PERMISSION_DENIED');
        }

        const oFirstError = aErrors[0];

        if (oFirstError.code === 'GRAPHQL_VALIDATION_FAILED' || isUnsupportedMsg(oFirstError.message)) {
            throw new Error('UNSUPPORTED: ' + oFirstError.message);
        }

        throw new Error('GQL_ERROR: ' + oFirstError.message);
    }

    return oJson.data;
};

/** Retrieves all servers from storage with their decrypted API keys attached */
const getServersWithKeys = async () => {

    const oLocal = await new Promise((resolve) => {
        browserAPI.storage.local.get(['servers', 'encryptedKeys'], resolve);
    });

    const aServers = oLocal.servers || [];
    const oEncKeys = oLocal.encryptedKeys || {};
    const aIds = Object.keys(oEncKeys);

    if (aIds.length === 0) {
        return aServers;
    }

    let oCryptoKey;

    try {
        oCryptoKey = await getEncryptionKey();
    } catch (_) {
        return aServers;
    }

    const oDecrypted = {};

    for (const sId of aIds) {

        try {
            oDecrypted[sId] = await decryptValue(oCryptoKey, oEncKeys[sId]);
        } catch (_) {
            /* Key corrupted or encryption key changed */
        }
    }

    return aServers.map((pS) => ({
        ...pS,
        apiKey: oDecrypted[pS.id] || pS.apiKey || null
    }));
};

/**
 * Retrieves a single server by ID with its decrypted API key
 * @param {string} pServerId - The server identifier
 * @returns {Object|null} The server object or null if not found
 */
const getServerById = async (pServerId) => {

    const aServers = await getServersWithKeys();
    return aServers.find((pS) => pS.id === pServerId) || null;
};

/* Each dashboard section is a separate query so that an unavailable
   service or schema difference on one server never kills the whole
   dashboard. Results are merged by handleFetchDashboard. */

const QUERY_CORE = `
query Core {
  vars { version name }
  info {
    os { platform distro release uptime hostname }
    cpu { manufacturer brand cores threads }
  }
  metrics {
    cpu { percentTotal }
    memory { total used free available percentTotal }
  }
  notifications {
    overview { unread { info warning alert total } }
  }
}`;

const QUERY_ARRAY = `
query Array {
  array {
    state
    capacity {
      kilobytes { free used total }
      disks { free used total }
    }
    parities { id name status temp numErrors isSpinning rotational }
    disks { id name status temp numErrors isSpinning rotational }
    caches { id name status temp numErrors isSpinning rotational }
  }
}`;

const QUERY_NETWORK = `
query Network {
  network { accessUrls { type name ipv4 } }
}`;

const QUERY_DOCKER = `
query Docker {
  docker { containers { id names state status autoStart ports { publicPort type } } }
}`;

const QUERY_DOCKER_BASIC = `
query DockerBasic {
  docker { containers { id names state status autoStart } }
}`;

const QUERY_DOCKER_UPDATES = `
query DockerUpdates {
  docker { containerUpdateStatuses { name updateStatus } }
}`;

const QUERY_VMS = `
query VMs {
  vms { domains { id name state } }
}`;

const QUERY_TEST_CONNECTION = `
query TestConnection {
  vars { version name }
}`;

const QUERY_ME = `
query Me {
  me { roles permissions { resource actions } }
}`;

const QUERY_API_VERSION = `
query ApiVersion {
  info { versions { core { api } } }
}`;

/* Feature queries below are separate operations so that a server without
   one of the fields only loses that feature */

const QUERY_DOCKER_WEBUI = `
query DockerWebUi {
  docker { containers { id webUiUrl } }
}`;

const QUERY_PARITY = `
query ParityStatus {
  array { parityCheckStatus { status progress speed errors correcting date } }
}`;

const QUERY_DISK_TEMP_THRESHOLDS = `
query DiskTempThresholds {
  info { display { hot max } }
}`;

const QUERY_TEMPERATURE = `
query Temperature {
  metrics {
    temperature {
      sensors { id current { value unit status } }
    }
  }
}`;

const QUERY_DOCKER_STATUS = `
query DockerStatus {
  docker { containers { id names state } }
}`;

const QUERY_DOCKER_UPDATE_STATUS = `
query DockerUpdateStatus {
  docker {
    containers { id names state }
    containerUpdateStatuses { name updateStatus }
  }
}`;

const QUERY_VM_STATUS = `
query VMStatus {
  vms { domains { id state } }
}`;

const MUTATION_DOCKER_START = `
mutation DockerStart($id: PrefixedID!) {
  docker { start(id: $id) { id state status } }
}`;

const MUTATION_DOCKER_STOP = `
mutation DockerStop($id: PrefixedID!) {
  docker { stop(id: $id) { id state status } }
}`;

const MUTATION_VM_START = `
mutation VMStart($id: PrefixedID!) {
  vm { start(id: $id) }
}`;

const MUTATION_VM_STOP = `
mutation VMStop($id: PrefixedID!) {
  vm { stop(id: $id) }
}`;

const MUTATION_DOCKER_RESTART = `
mutation DockerRestart($id: PrefixedID!) {
  docker { restart(id: $id) { id state status } }
}`;

const MUTATION_DOCKER_PAUSE = `
mutation DockerPause($id: PrefixedID!) {
  docker { pause(id: $id) { id state status } }
}`;

const MUTATION_DOCKER_UNPAUSE = `
mutation DockerUnpause($id: PrefixedID!) {
  docker { unpause(id: $id) { id state status } }
}`;

const MUTATION_DOCKER_UPDATE = `
mutation DockerUpdate($ids: [PrefixedID!]!) {
  docker { updateContainers(ids: $ids) { id state } }
}`;

const MUTATION_VM_RESUME = `
mutation VMResume($id: PrefixedID!) {
  vm { resume(id: $id) }
}`;

const DOCKER_COMMANDS = {
    start: MUTATION_DOCKER_START,
    stop: MUTATION_DOCKER_STOP,
    restart: MUTATION_DOCKER_RESTART,
    pause: MUTATION_DOCKER_PAUSE,
    resume: MUTATION_DOCKER_UNPAUSE
};

/* VM restart is not here: restartVM runs stop and start (vm.reboot gives up after 10 s of shutdown) */
const VM_COMMANDS = {
    start: MUTATION_VM_START,
    stop: MUTATION_VM_STOP,
    resume: MUTATION_VM_RESUME
};

const STATUS_QUERIES = {
    docker: QUERY_DOCKER_STATUS,
    vm: QUERY_VM_STATUS,
    update: QUERY_DOCKER_UPDATE_STATUS
};

const QUERY_BADGE_COUNT = `
query BadgeCount {
  notifications { overview { unread { total } } }
}`;

const QUERY_NOTIFICATIONS = `
query NotificationList($filter: NotificationFilter!) {
  notifications {
    list(filter: $filter) {
      id
      title
      subject
      importance
      timestamp
    }
  }
}`;

const MUTATION_ARCHIVE_NOTIFICATION = `
mutation ArchiveNotification($id: PrefixedID!) {
  archiveNotification(id: $id) { id }
}`;

const MUTATION_ARCHIVE_ALL = `
mutation ArchiveAll {
  archiveAll { unread { total } }
}`;

/**
 * Determines the API key permission level from the Me query response
 * @param {Object} pMeData - The response from the QUERY_ME GraphQL query
 * @returns {string} Either 'admin' or 'readonly'
 */
const detectKeyType = (pMeData) => {

    if (!pMeData || !pMeData.me) {
        return 'readonly';
    }

    const oMe = pMeData.me;

    if (Array.isArray(oMe.roles) && oMe.roles.includes('ADMIN')) {
        return 'admin';
    }

    const aPerms = oMe.permissions || [];
    const bCanMutate = aPerms.some((pP) => {
        const aActions = pP.actions || [];
        return aActions.includes('UPDATE_ANY') || aActions.includes('DELETE_ANY');
    });

    return bCanMutate ? 'admin' : 'readonly';
};

/**
 * Checks whether partial GraphQL data carries a FORBIDDEN error (the key lacks the permission). Message text
 * is never used: Docker errors such as "permission denied" are server failures, not key problems.
 * @param {Object} pData - The GraphQL response data (may contain _errors [{message, code}])
 * @returns {boolean}
 */
const hasForbiddenError = (pData) => !!pData?._errors?.some((pE) => pE.code === 'FORBIDDEN');

/**
 * Checks whether an error code or GraphQL message means the server's schema lacks the requested field
 * @param {string} pMsg - Error code (HTTP_400, UNSUPPORTED) or GraphQL error message
 * @returns {boolean}
 */
const isUnsupportedMsg = (pMsg) => {

    const oPattern = /^(HTTP_400|UNSUPPORTED)|GRAPHQL_VALIDATION_FAILED|Cannot query field|Unknown (argument|type)/;
    return oPattern.test(pMsg);
};

/**
 * Compares a parsed API version against a minimum; an unknown version is below every minimum
 * @param {number[]|null} pVersion - [major, minor, patch], or null when unknown
 * @param {number[]} pMin - [major, minor, patch]
 * @returns {boolean}
 */
const isVersionAtLeast = (pVersion, pMin) => {

    if (!pVersion) {
        return false;
    }

    for (let nI = 0; nI < 3; nI++) {

        if (pVersion[nI] !== pMin[nI]) {
            return pVersion[nI] > pMin[nI];
        }
    }

    return true;
};

/* lm-sensors channels outside these ranges are unconnected (the reference server reports -63) or not temperatures */
const TEMP_RANGES = {CELSIUS: [-40, 150], FAHRENHEIT: [-40, 302]};

/**
 * Builds the temperature summary from the sensor list. The API's own summary is not used: it reports every
 * lm-sensors *_input key (fans, voltages, power, energy) as a CELSIUS temperature.
 * @param {Object[]} pSensors - metrics.temperature.sensors [{id, current: {value, unit, status}}]
 * @returns {Object|null} {summary: {average, warningCount, criticalCount, hottest: {current: {value, unit}}}},
 *                        or null when no reading qualifies or the readings do not share one unit
 */
const summarizeTemperatures = (pSensors) => {

    const oUnits = {};
    let nCount = 0;
    let nSum = 0;
    let oHottest = null;
    let nWarning = 0;
    let nCritical = 0;

    (pSensors || []).forEach((pSensor) => {

        const sChannel = String(pSensor.id || '').split(':').pop();
        const oCurrent = pSensor.current || {};
        const aRange = TEMP_RANGES[oCurrent.unit];

        /* Among lm-sensors keys only temp<N>_input is a temperature; disk: and ipmi: ids have no _input key */
        if (sChannel.endsWith('_input') && !/^temp\d+_input$/.test(sChannel)) {
            return;
        }

        const bOutOfRange = aRange && (oCurrent.value < aRange[0] || oCurrent.value > aRange[1]);

        if (typeof oCurrent.value !== 'number' || bOutOfRange) {
            return;
        }

        oUnits[oCurrent.unit] = true;
        nCount++;
        nSum += oCurrent.value;

        if (!oHottest || oCurrent.value > oHottest.value) {
            oHottest = oCurrent;
        }

        if (oCurrent.status === 'WARNING') {
            nWarning++;
        } else if (oCurrent.status === 'CRITICAL') {
            nCritical++;
        }
    });

    const aUnits = Object.keys(oUnits);

    /* Readings are shown without conversion, so they must all be CELSIUS or all FAHRENHEIT */
    if (nCount === 0 || aUnits.length !== 1 || !TEMP_RANGES[aUnits[0]]) {
        return null;
    }

    return {
        summary: {
            average: nSum / nCount,
            warningCount: nWarning,
            criticalCount: nCritical,
            hottest: {current: {value: oHottest.value, unit: oHottest.unit}}
        }
    };
};

browserAPI.runtime.onMessage.addListener((pMessage, pSender, pFnSendResponse) => {

    const sAction = pMessage.action;

    if (sAction === 'fetchDashboard') {

        handleFetchDashboard(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'fetchAllServers') {

        handleFetchAllServers().then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'testConnection') {

        handleTestConnection(pMessage.server).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'controlDocker') {

        handleControlDocker(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'controlVM') {

        handleControlVM(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'restartVM') {

        handleRestartVM(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'clearVMRestart') {

        /* A finished restart is kept until the popup has shown its outcome once */
        changePendingRestarts((pAll) => {

            const sKey = pMessage.serverId + '::' + pMessage.vmId;

            if (pAll[sKey]?.phase === 'done') {
                delete pAll[sKey];
            }

        }).then(() => pFnSendResponse({success: true}), () => pFnSendResponse({success: false}));

        return true;
    }

    if (sAction === 'fetchNotifications') {

        handleFetchNotifications(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'archiveNotification') {

        handleArchiveNotification(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'archiveAll') {

        handleArchiveAll(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'updateContainers') {

        handleUpdateContainers(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'fetchStatus') {

        handleFetchStatus(pMessage).then(pFnSendResponse).catch((pErr) => {

            pFnSendResponse({error: categorizeError(pErr)});
        });

        return true;
    }

    if (sAction === 'refreshBadge') {

        updateBadge().then(() => pFnSendResponse({success: true}));

        return true;
    }

    if (sAction === 'savePendingUpdate') {

        /* The popup's record replaces the stored one, keeping a failure the background
           recorded for the same operation before the popup saw it */
        changePendingUpdate(pMessage.serverId, (pStored) => {

            const oRecord = pMessage.record;

            if (oRecord && !oRecord.failMessage && pStored?.startedAt === oRecord.startedAt && pStored.failMessage) {
                return {...oRecord, failMessage: pStored.failMessage};
            }

            return oRecord;

        }).then(() => pFnSendResponse({success: true}), () => pFnSendResponse({success: false}));

        return true;
    }
});

/**
 * Fetches all dashboard data sections for a single server via parallel GraphQL queries
 * @param {Object} pServer - Server object with url and apiKey properties
 * @param {Object} [pFeatures] - Version-gated features (see handleFetchDashboard); omitted = none
 * @returns {Object} Merged dashboard data from all query sections
 */
const fetchServerDashboard = async (pServer, pFeatures) => {

    const oFeatures = pFeatures || {};

    const fnDockerQuery = async () => {

        try {
            return await executeGraphQL(pServer.url, pServer.apiKey, QUERY_DOCKER);
        } catch (_) {
            return await executeGraphQL(pServer.url, pServer.apiKey, QUERY_DOCKER_BASIC);
        }
    };

    /* Entries marked extra are merged into their sections after the main ones */
    const aQueries = [
        {key: 'core', query: QUERY_CORE},
        {key: 'array', query: QUERY_ARRAY},
        {key: 'network', query: QUERY_NETWORK},
        {key: 'docker', query: null},
        {key: 'vms', query: QUERY_VMS},
        {key: 'parity', query: QUERY_PARITY, extra: true},
        {key: 'diskTemps', query: QUERY_DISK_TEMP_THRESHOLDS, extra: true}
    ];

    /* Flagged Docker fields fail validation below API 4.30, and temperature reads
       before 4.37.6 can spin up sleeping disks, so these are never sent there */
    if (oFeatures.updates) {
        aQueries.push({key: 'dockerUpdates', query: QUERY_DOCKER_UPDATES, extra: true});
    }

    if (oFeatures.webUiUrl) {
        aQueries.push({key: 'dockerWebUi', query: QUERY_DOCKER_WEBUI, extra: true});
    }

    if (oFeatures.temperature) {
        aQueries.push({key: 'temperature', query: QUERY_TEMPERATURE, extra: true});
    }

    const aResults = await Promise.allSettled(
        aQueries.map((pQ) => {

            if (pQ.key === 'docker') {
                return fnDockerQuery();
            }

            return executeGraphQL(pServer.url, pServer.apiKey, pQ.query);
        })
    );

    const oData = {};
    const oExtras = {};
    let bAnyCoreData = false;

    aResults.forEach((pResult, pIndex) => {

        if (pResult.status === 'fulfilled' && pResult.value) {

            if (aQueries[pIndex].extra) {
                oExtras[aQueries[pIndex].key] = pResult.value;
                return;
            }

            Object.assign(oData, pResult.value);

            if (aQueries[pIndex].key === 'core') {
                bAnyCoreData = true;
            }
        } else {

            /* Mark failed optional sections as null so the UI
               can show "unavailable" instead of hiding the card */
            const sKey = aQueries[pIndex].key;

            if (sKey === 'docker') {
                oData.docker = null;
            } else if (sKey === 'vms') {
                oData.vms = null;
            } else if (sKey === 'array') {
                oData.array = null;
            } else if (sKey === 'network') {

                if (!oData.network) oData.network = null;
            }
        }
    });

    if (oData.docker) {

        const aUpdateStatuses = oExtras.dockerUpdates?.docker?.containerUpdateStatuses;
        const oWebUiById = {};

        if (aUpdateStatuses) {
            oData.docker.updateStatuses = aUpdateStatuses;
        }

        (oExtras.dockerWebUi?.docker?.containers || []).forEach((pC) => {

            oWebUiById[pC.id] = pC.webUiUrl;
        });

        (oData.docker.containers || []).forEach((pC) => {

            if (oWebUiById[pC.id]) {
                pC.webUiUrl = oWebUiById[pC.id];
            }
        });
    }

    if (oData.array) {
        oData.array.parityCheckStatus = oExtras.parity?.array?.parityCheckStatus || null;
    }

    /* Unraid's default HDD temperature thresholds (Display Settings), stored in degrees C whatever the
       display unit. SSD/NVMe and per-disk thresholds are not in the API, so only rotational disks use them. */
    const oDisplay = oExtras.diskTemps?.info?.display;

    if (oDisplay) {
        oData.diskTempThresholds = {warning: oDisplay.hot, critical: oDisplay.max};
    }

    oData.temperature = summarizeTemperatures(oExtras.temperature?.metrics?.temperature?.sensors);

    if (!bAnyCoreData) {

        const sCoreErr = aResults[0].status === 'rejected'
            ? aResults[0].reason?.message || 'Unknown error'
            : 'No data returned';

        throw new Error(sCoreErr);
    }

    return oData;
};

/**
 * Handles the fetchDashboard message -- resolves server, detects key type and API version, returns dashboard data
 * @param {Object} pMessage - Message object with serverId property
 * @returns {Object} Response with data, serverId, keyType, apiVersion, and features
 */
const handleFetchDashboard = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer || !oServer.apiKey) {
        return {error: oServer ? 'KEY_MISSING' : 'NO_SERVER'};
    }

    const [oMeResult, oVersionResult] = await Promise.allSettled([
        executeGraphQL(oServer.url, oServer.apiKey, QUERY_ME),
        executeGraphQL(oServer.url, oServer.apiKey, QUERY_API_VERSION)
    ]);

    let sKeyType = 'admin';

    if (oMeResult.status === 'fulfilled') {
        sKeyType = hasForbiddenError(oMeResult.value) ? 'readonly' : detectKeyType(oMeResult.value);
    } else {
        sKeyType = oMeResult.reason?.message === 'PERMISSION_DENIED' ? 'readonly' : 'admin';
    }

    /* A failed or unparsable version counts as unknown: no gated feature is used */
    const sApiVersion = oVersionResult.status === 'fulfilled'
        ? oVersionResult.value?.info?.versions?.core?.api || null
        : null;
    const aVersionMatch = /(\d+)\.(\d+)\.(\d+)/.exec(sApiVersion || '');
    const aVersion = aVersionMatch ? aVersionMatch.slice(1).map(Number) : null;
    const bApi430 = isVersionAtLeast(aVersion, [4, 30, 0]);

    const oFeatures = {
        webUiUrl: bApi430,
        updates: bApi430,
        pause: bApi430,
        restart: isVersionAtLeast(aVersion, [4, 36, 0]),
        temperature: isVersionAtLeast(aVersion, [4, 37, 6])
    };

    const oData = await fetchServerDashboard(oServer, oFeatures);

    return {data: oData, serverId: oServer.id, keyType: sKeyType, apiVersion: sApiVersion, features: oFeatures};
};

/** Fetches dashboard data for all enabled servers in parallel */
const handleFetchAllServers = async () => {

    const aServers = (await getServersWithKeys()).filter((pS) => pS.enabled !== false && pS.apiKey);

    if (aServers.length === 0) {
        return {results: []};
    }

    const aPromises = aServers.map(async (pServer) => {

        try {

            const oData = await fetchServerDashboard(pServer);
            return {serverId: pServer.id, data: oData, error: null};

        } catch (pErr) {

            return {serverId: pServer.id, data: null, error: categorizeError(pErr)};
        }
    });

    const aResults = await Promise.all(aPromises);

    return {results: aResults};
};

/**
 * Tests connectivity to a server and detects the API key permission level
 * @param {Object} pServer - Server object with url and apiKey properties
 * @returns {Object} Response with success, name, version, and keyType
 */
const handleTestConnection = async (pServer) => {

    if (!pServer || !pServer.url || !pServer.apiKey) {
        return {error: 'INVALID_CONFIG'};
    }

    const oData = await executeGraphQL(pServer.url, pServer.apiKey, QUERY_TEST_CONNECTION);

    let sKeyType = 'admin';

    try {

        const oMeData = await executeGraphQL(pServer.url, pServer.apiKey, QUERY_ME);

        if (hasForbiddenError(oMeData)) {
            sKeyType = 'readonly';
        } else {
            sKeyType = detectKeyType(oMeData);
        }

    } catch (pErr) {
        if (pErr.message === 'PERMISSION_DENIED') {
            sKeyType = 'readonly';
        }
    }

    return {
        success: true,
        name: oData.vars?.name || 'Unknown',
        version: oData.vars?.version || 'Unknown',
        keyType: sKeyType
    };
};

/**
 * Runs a mutation and classifies a failure as 'unsupported' (the schema rejects it),
 * 'failed' (the server reported an error) or 'unknown' (no answer, the action may still run)
 * @param {Object} pServer - Server object with url and apiKey properties
 * @param {string} pQuery - GraphQL mutation
 * @param {Object} [pVariables]
 * @returns {Object} {success, data}, {error: 'PERMISSION_DENIED'}, or {error, outcome}
 */
const runMutation = async (pServer, pQuery, pVariables) => {

    try {

        const oData = await executeGraphQL(pServer.url, pServer.apiKey, pQuery, pVariables);

        if (hasForbiddenError(oData)) {
            return {error: 'PERMISSION_DENIED'};
        }

        /* Partial data with errors (e.g. {docker: null}) is still a failed mutation */
        if (oData?._errors) {

            const oFirstError = oData._errors[0];
            const bUnsupported = oFirstError.code === 'GRAPHQL_VALIDATION_FAILED' ||
                isUnsupportedMsg(oFirstError.message);

            return {error: oFirstError.message, outcome: bUnsupported ? 'unsupported' : 'failed'};
        }

        return {success: true, data: oData};

    } catch (pErr) {

        const sError = categorizeError(pErr);

        if (sError === 'PERMISSION_DENIED') {
            return {error: sError};
        }

        let sOutcome = 'failed';

        if (isUnsupportedMsg(sError)) {
            sOutcome = 'unsupported';
        } else if (sError === 'TIMEOUT' || sError === 'UNREACHABLE' || sError.startsWith('UNKNOWN')) {
            sOutcome = 'unknown';
        }

        return {error: sError, outcome: sOutcome};
    }
};

/**
 * Runs a Docker container command (start, stop, restart, pause, resume) via GraphQL mutation
 * @param {Object} pMessage - Message with serverId, containerId, and command
 * @returns {Object} Response from runMutation
 */
const handleControlDocker = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);
    const sQuery = DOCKER_COMMANDS[pMessage.command];

    if (!oServer || !sQuery) {
        return {error: oServer ? 'INVALID_CONFIG' : 'NO_SERVER', outcome: 'failed'};
    }

    return runMutation(oServer, sQuery, {id: pMessage.containerId});
};

/**
 * Runs a VM command (start, stop, resume, restart) via GraphQL mutation
 * @param {Object} pMessage - Message with serverId, vmId, and command
 * @returns {Object} Response from runMutation
 */
const handleControlVM = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);
    const sQuery = VM_COMMANDS[pMessage.command];

    if (!oServer || !sQuery) {
        return {error: oServer ? 'INVALID_CONFIG' : 'NO_SERVER', outcome: 'failed'};
    }

    const oResult = await runMutation(oServer, sQuery, {id: pMessage.vmId});

    /* VM mutations return a Boolean; false means the command was not accepted */
    if (oResult.success && Object.values(oResult.data?.vm || {}).includes(false)) {
        return {error: 'The server did not accept the command.', outcome: 'failed'};
    }

    return oResult;
};

let pPendingUpdateWrite = Promise.resolve();

/**
 * Applies a change to the stored pending-update record of one server. The background is the only
 * writer of pendingUpdates, and changes are chained so two read-modify-write cycles never interleave.
 * @param {string} pServerId - The server ID
 * @param {Function} pFnChange - Receives the current record (or undefined);
 *                              returns the new record, or null to remove it
 * @returns {Promise} Resolves once this change is stored
 */
const changePendingUpdate = (pServerId, pFnChange) => {

    pPendingUpdateWrite = pPendingUpdateWrite.catch(() => null).then(async () => {

        const oResult = await new Promise((pFnResolve) => browserAPI.storage.local.get(['pendingUpdates'], pFnResolve));
        const oAll = oResult.pendingUpdates || {};
        const oNext = pFnChange(oAll[pServerId]);

        if (oNext) {
            oAll[pServerId] = oNext;
        } else {
            delete oAll[pServerId];
        }

        await new Promise((pFnResolve) => browserAPI.storage.local.set({pendingUpdates: oAll}, pFnResolve));
    });

    return pPendingUpdateWrite;
};

/**
 * Stores the update operation, then runs the update mutation. The server answers only after every
 * image is pulled and recreated, usually after the 15 s timeout, so completion is decided by the
 * popup's status checks against the stored record; only a server-reported error is recorded here.
 * @param {Object} pMessage - Message with serverId and record {bulk, startedAt, items: {name: {id, startState}}, ...}
 * @returns {Object} Response from runMutation
 */
const handleUpdateContainers = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER', outcome: 'failed'};
    }

    await changePendingUpdate(pMessage.serverId, () => pMessage.record);

    const aIds = Object.values(pMessage.record.items).map((pItem) => pItem.id);
    const oResult = await runMutation(oServer, MUTATION_DOCKER_UPDATE, {ids: aIds});

    if (oResult.outcome === 'unsupported') {

        await changePendingUpdate(pMessage.serverId, () => null);

    } else if (oResult.outcome === 'failed' || oResult.error === 'PERMISSION_DENIED') {

        await changePendingUpdate(pMessage.serverId, (pRecord) => pRecord && {...pRecord, failMessage: oResult.error});
    }

    return oResult;
};

/* VM restart = vm.stop, wait for SHUTOFF, vm.start, wait for RUNNING, coordinated here so that it survives a
   closed popup. Records live in pendingRestarts keyed serverId::vmId with phase stopping, starting or done. */
const RESTART_ALARM = 'vmRestart';
const RESTART_PHASE_MS = 300000;

let pPendingRestartWrite = Promise.resolve();

/**
 * Reads the stored VM restart records
 * @returns {Promise<Object>} Records keyed serverId::vmId
 */
const readPendingRestarts = async () => {

    const oResult = await new Promise((pFnResolve) => browserAPI.storage.local.get(['pendingRestarts'], pFnResolve));
    return oResult.pendingRestarts || {};
};

/**
 * Applies a change to the VM restart records. Like changePendingUpdate, changes are chained so they never
 * interleave; a phase change is stored before its request is sent, so two callers cannot both send vm.start.
 * Afterwards the restart alarm is kept only while a record is stopping or starting.
 * @param {Function} pFnChange - Receives all records to modify in place; its return value is passed on
 * @returns {Promise<*>} Resolves with the change's return value once it is stored
 */
const changePendingRestarts = (pFnChange) => {

    const pWrite = pPendingRestartWrite.catch(() => null).then(async () => {

        const oAll = await readPendingRestarts();
        const oChangeResult = pFnChange(oAll);

        await new Promise((pFnResolve) => browserAPI.storage.local.set({pendingRestarts: oAll}, pFnResolve));

        const bActive = Object.values(oAll).some((pRecord) => pRecord.phase !== 'done');
        const oAlarm = await browserAPI.alarms.get(RESTART_ALARM);

        if (bActive && !oAlarm) {
            browserAPI.alarms.create(RESTART_ALARM, {periodInMinutes: 1});
        } else if (!bActive && oAlarm) {
            await browserAPI.alarms.clear(RESTART_ALARM);
        }

        return oChangeResult;
    });

    pPendingRestartWrite = pWrite;

    return pWrite;
};

/**
 * Sends vm.stop (phase stopping) or vm.start (phase starting) for a restart and ends the record when the server
 * rejects the command. No answer (timeout, network) is not a failure: the state checks decide.
 * @param {Object} pServer - Server object with id, url and apiKey
 * @param {string} pVmId - The VM id
 * @param {string} pPhase - 'stopping' or 'starting'
 */
const sendRestartCommand = async (pServer, pVmId, pPhase) => {

    const sMutation = pPhase === 'stopping' ? MUTATION_VM_STOP : MUTATION_VM_START;
    const oResult = await runMutation(pServer, sMutation, {id: pVmId});
    let sError = null;

    if (oResult.success && Object.values(oResult.data?.vm || {}).includes(false)) {
        sError = 'The server did not accept the command.';
    } else if (!oResult.success && oResult.outcome !== 'unknown') {
        sError = oResult.error;
    }

    if (sError) {

        await changePendingRestarts((pAll) => {

            const sKey = pServer.id + '::' + pVmId;

            if (pAll[sKey]?.phase === pPhase) {
                pAll[sKey] = {...pAll[sKey], phase: 'done', outcome: {result: 'failed', error: sError}};
            }
        });
    }
};

/**
 * Moves the server's restarts on from the VM states of a fresh status query: SHUTOFF while stopping starts the
 * VM, RUNNING while starting ends the restart. The 5-minute phase limit is checked only after the current state,
 * so a late check starts a VM that is already off instead of expiring it. A popup check and the alarm can overlap,
 * so records whose phase began after the query was sent are left alone: that answer may predate vm.start.
 * @param {Object} pServer - Server object with id, url and apiKey
 * @param {Object[]} pDomains - vms.domains [{id, state}] from the status query
 * @param {number} pQueriedAt - Date.now() taken before the status query was sent
 */
const advanceVMRestarts = async (pServer, pDomains, pQueriedAt) => {

    const oStates = {};

    pDomains.forEach((pDomain) => {

        oStates[pDomain.id] = pDomain.state;
    });

    const aStartIds = await changePendingRestarts((pAll) => {

        const nNow = Date.now();
        const aIds = [];

        Object.entries(pAll).forEach(([pKey, pRecord]) => {

            if (pRecord.serverId !== pServer.id || pRecord.phase === 'done' || pRecord.phaseStartedAt > pQueriedAt) {
                return;
            }

            const sState = oStates[pRecord.vmId];

            if (pRecord.phase === 'stopping' && sState === 'SHUTOFF') {

                pAll[pKey] = {...pRecord, phase: 'starting', phaseStartedAt: nNow};
                aIds.push(pRecord.vmId);

            } else if (pRecord.phase === 'starting' && sState === 'RUNNING') {

                delete pAll[pKey];

            } else if (nNow - pRecord.phaseStartedAt >= RESTART_PHASE_MS) {

                pAll[pKey] = {
                    ...pRecord,
                    phase: 'done',
                    outcome: pRecord.phase === 'stopping'
                        ? {result: 'failed', error: 'the VM did not shut down'}
                        : {result: 'unknown'}
                };
            }
        });

        return aIds;
    });

    for (const sVmId of aStartIds) {
        await sendRestartCommand(pServer, sVmId, 'starting');
    }
};

/**
 * Checks every server that has a restart in progress; runs on the restart alarm, also while the popup is closed
 */
const processVMRestarts = async () => {

    const oAll = await readPendingRestarts();
    const aServers = await getServersWithKeys();
    const oServerIds = {};

    Object.values(oAll).forEach((pRecord) => {

        if (pRecord.phase !== 'done') {
            oServerIds[pRecord.serverId] = true;
        }
    });

    for (const sServerId of Object.keys(oServerIds)) {

        const oServer = aServers.find((pS) => pS.id === sServerId);

        if (!oServer) {

            /* The server was deleted, so its restarts can no longer be checked */
            await changePendingRestarts((pRecords) => {

                Object.keys(pRecords).forEach((pKey) => {

                    if (pRecords[pKey].serverId === sServerId) {
                        delete pRecords[pKey];
                    }
                });
            });

            continue;
        }

        try {

            const nQueriedAt = Date.now();
            const oData = await executeGraphQL(oServer.url, oServer.apiKey, QUERY_VM_STATUS);

            /* Without a current state no limit is applied */
            if (oData?.vms) {
                await advanceVMRestarts(oServer, oData.vms.domains || [], nQueriedAt);
            }

        } catch (_) {
            /* Unreachable now; the next alarm checks again */
        }
    }
};

/**
 * Starts a coordinated VM restart: stores the record, then sends vm.stop. A VM with a restart in progress is
 * not stopped again.
 * @param {Object} pMessage - Message with serverId, vmId and name
 * @returns {Object} {success, record}: the stored record, or null once the restart has ended
 */
const handleRestartVM = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER', outcome: 'failed'};
    }

    const sKey = oServer.id + '::' + pMessage.vmId;

    const bCreated = await changePendingRestarts((pAll) => {

        if (pAll[sKey] && pAll[sKey].phase !== 'done') {
            return false;
        }

        pAll[sKey] = {
            serverId: oServer.id,
            vmId: pMessage.vmId,
            name: pMessage.name,
            phase: 'stopping',
            phaseStartedAt: Date.now(),
            outcome: null
        };

        return true;
    });

    if (bCreated) {
        await sendRestartCommand(oServer, pMessage.vmId, 'stopping');
    }

    return {success: true, record: (await readPendingRestarts())[sKey] || null};
};

/**
 * Runs one narrow status query used while an action is pending. A VM check also moves the server's
 * restarts on and returns their records.
 * @param {Object} pMessage - Message with serverId and kind ('docker', 'vm' or 'update')
 * @returns {Object} Response with the query data, plus restarts {vmId: record} for kind 'vm'
 */
const handleFetchStatus = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);
    const sQuery = STATUS_QUERIES[pMessage.kind];

    if (!oServer || !sQuery) {
        return {error: oServer ? 'INVALID_CONFIG' : 'NO_SERVER'};
    }

    const nQueriedAt = Date.now();
    const oData = await executeGraphQL(oServer.url, oServer.apiKey, sQuery);

    if (pMessage.kind !== 'vm') {
        return {success: true, data: oData};
    }

    if (oData?.vms) {
        await advanceVMRestarts(oServer, oData.vms.domains || [], nQueriedAt);
    }

    const oRestarts = {};

    Object.values(await readPendingRestarts()).forEach((pRecord) => {

        if (pRecord.serverId === oServer.id) {
            oRestarts[pRecord.vmId] = pRecord;
        }
    });

    return {success: true, data: oData, restarts: oRestarts};
};

/**
 * Fetches notifications for a server with optional filter
 * @param {Object} pMessage - Message with serverId and optional filter object
 * @returns {Object} Response with notification list data
 */
const handleFetchNotifications = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    const oFilter = pMessage.filter || {type: 'UNREAD', offset: 0, limit: 50};
    const oData = await executeGraphQL(oServer.url, oServer.apiKey, QUERY_NOTIFICATIONS, {filter: oFilter});

    return {success: true, data: oData.notifications?.list || []};
};

/**
 * Archives a single notification by ID
 * @param {Object} pMessage - Message with serverId and notificationId
 * @returns {Object} Response with success flag or error
 */
const handleArchiveNotification = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    return runMutation(oServer, MUTATION_ARCHIVE_NOTIFICATION, {id: pMessage.notificationId});
};

/**
 * Archives all notifications for a server
 * @param {Object} pMessage - Message with serverId
 * @returns {Object} Response with success flag or error
 */
const handleArchiveAll = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    return runMutation(oServer, MUTATION_ARCHIVE_ALL);
};

/**
 * Categorizes an error into a standardized error code string for the UI
 * @param {Error} pErr - The error to categorize
 * @returns {string} A categorized error code (e.g., 'AUTH_ERROR', 'UNREACHABLE', 'TIMEOUT')
 */
const categorizeError = (pErr) => {

    const sMsg = pErr.message || '';

    if (sMsg === 'AUTH_ERROR' || sMsg === 'TIMEOUT' || sMsg === 'PERMISSION_DENIED') {
        return sMsg;
    }

    if (sMsg.startsWith('HTTP_')) {
        return sMsg;
    }

    if (sMsg.startsWith('GQL_ERROR') || sMsg.startsWith('UNSUPPORTED')) {
        return sMsg;
    }

    if (sMsg.includes('Failed to fetch') || sMsg.includes('NetworkError') || sMsg.includes('net::')) {
        return 'UNREACHABLE';
    }

    if (pErr.name === 'TimeoutError' || sMsg.includes('TimeoutError') || sMsg.includes('abort')) {
        return 'TIMEOUT';
    }

    return 'UNKNOWN: ' + sMsg;
};

/** Polls all enabled servers for unread notification counts and updates the extension badge */
const updateBadge = async () => {

    try {

        const aServers = (await getServersWithKeys()).filter((pS) => pS.enabled !== false && pS.apiKey);

        const oSettingsResult = await new Promise((resolve) => {
            browserAPI.storage.local.get(['settings'], resolve);
        });

        const oSettings = oSettingsResult.settings || {};

        if (aServers.length === 0 || !oSettings.refreshInterval) {
            browserAPI.action.setBadgeText({text: ''});
            return;
        }

        const aResults = await Promise.allSettled(
            aServers.map((pS) => executeGraphQL(pS.url, pS.apiKey, QUERY_BADGE_COUNT))
        );

        let nTotal = 0;

        aResults.forEach((pR) => {

            if (pR.status === 'fulfilled') {
                nTotal += pR.value?.notifications?.overview?.unread?.total || 0;
            }
        });

        if (nTotal > 0) {
            browserAPI.action.setBadgeText({text: String(nTotal)});
            browserAPI.action.setBadgeBackgroundColor({color: '#FF8C2F'});
        } else {
            browserAPI.action.setBadgeText({text: ''});
        }

    } catch (_) {
        /* Fail silently */
    }
};

/**
 * Creates the badge alarm when it is missing (Firefox does not keep alarms across browser restarts)
 * and refreshes the badge when the alarm was missing or pRefresh is set. Never recreates an existing
 * alarm, because every worker wake runs this and create() would restart the period.
 * @param {boolean} [pRefresh] - Refresh the badge even when the alarm already exists
 */
const ensureBadgeAlarm = async (pRefresh) => {

    const oAlarm = await browserAPI.alarms.get('badgeUpdate');

    if (!oAlarm) {
        browserAPI.alarms.create('badgeUpdate', {periodInMinutes: 5});
    }

    if (!oAlarm || pRefresh) {
        updateBadge();
    }
};

browserAPI.runtime.onStartup.addListener(() => {

    ensureBadgeAlarm(true);
    changePendingRestarts(() => null);
});

browserAPI.runtime.onInstalled.addListener(async () => {

    ensureBadgeAlarm(true);
    changePendingRestarts(() => null);

    const oResult = await new Promise((resolve) => {
        browserAPI.storage.local.get(['servers'], resolve);
    });

    const aServers = oResult.servers || [];
    const oPlainKeys = {};
    let bNeedsMigration = false;

    const aCleaned = aServers.map((pS) => {

        if (pS.apiKey) {
            oPlainKeys[pS.id] = pS.apiKey;
            bNeedsMigration = true;
            const {apiKey, ...oRest} = pS;
            return oRest;
        }

        return pS;
    });

    if (bNeedsMigration) {

        const oCryptoKey = await getEncryptionKey();
        const oEncKeys = {};

        for (const sId of Object.keys(oPlainKeys)) {
            oEncKeys[sId] = await encryptValue(oCryptoKey, oPlainKeys[sId]);
        }

        await new Promise((resolve) => {
            browserAPI.storage.local.set({servers: aCleaned, encryptedKeys: oEncKeys}, resolve);
        });
    }
});

browserAPI.alarms.onAlarm.addListener((pAlarm) => {

    if (pAlarm.name === 'badgeUpdate') {
        updateBadge();
    } else if (pAlarm.name === RESTART_ALARM) {
        processVMRestarts();
    }
});

ensureBadgeAlarm();

/* An unchanged write re-creates the restart alarm when a restart is in progress (Firefox drops alarms on quit) */
changePendingRestarts(() => null);
