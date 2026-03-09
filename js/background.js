const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

const getEncryptionKey = async () => {

    const oResult = await new Promise((resolve) => browserAPI.storage.local.get(['_ek'], resolve));

    if (oResult._ek) {
        return crypto.subtle.importKey('raw', new Uint8Array(oResult._ek), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    const oKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const aRaw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', oKey)));
    await new Promise((resolve) => browserAPI.storage.local.set({_ek: aRaw}, resolve));

    return oKey;
};

const encryptValue = async (pKey, pValue) => {

    const aIv = crypto.getRandomValues(new Uint8Array(12));
    const aData = await crypto.subtle.encrypt({name: 'AES-GCM', iv: aIv}, pKey, new TextEncoder().encode(pValue));

    return {iv: Array.from(aIv), data: Array.from(new Uint8Array(aData))};
};

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

    const oResponse = await fetch(sEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': pApiKey
        },
        body: JSON.stringify(oBody),
        signal: AbortSignal.timeout(15000)
    });

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

    /* GraphQL can return 200 with partial data + errors */
    if (oJson.errors && oJson.errors.length > 0) {

        if (oJson.data) {
            oJson.data._errors = oJson.errors.map((pE) => pE.message);
            return oJson.data;
        }

        throw new Error('GQL_ERROR: ' + oJson.errors[0].message);
    }

    return oJson.data;
};

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
    parities { id name status temp numErrors isSpinning }
    disks { id name status temp numErrors isSpinning }
    caches { id name status temp numErrors isSpinning }
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

const isPermissionMsg = (pMsg) => {

    const sLower = pMsg.toLowerCase();

    return sLower.includes('permission') || sLower.includes('forbidden') ||
           sLower.includes('not allowed') || sLower.includes('authorized') ||
           sLower.includes('access denied') || sLower.includes('auth_error');
};

const isPermissionError = (pErr) => isPermissionMsg(pErr.message || '');

const hasPermissionErrors = (pData) => {

    if (!pData || !pData._errors) {
        return false;
    }

    return pData._errors.some(isPermissionMsg);
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
});

const fetchServerDashboard = async (pServer) => {

    const fnDockerQuery = async () => {

        try {
            return await executeGraphQL(pServer.url, pServer.apiKey, QUERY_DOCKER);
        } catch (_) {
            return await executeGraphQL(pServer.url, pServer.apiKey, QUERY_DOCKER_BASIC);
        }
    };

    const aQueries = [
        {key: 'core', query: QUERY_CORE},
        {key: 'array', query: QUERY_ARRAY},
        {key: 'network', query: QUERY_NETWORK},
        {key: 'docker', query: null},
        {key: 'vms', query: QUERY_VMS},
        {key: 'dockerUpdates', query: QUERY_DOCKER_UPDATES}
    ];

    const aResults = await Promise.allSettled(
        aQueries.map((pQ) => {

            if (pQ.key === 'docker') {
                return fnDockerQuery();
            }

            return executeGraphQL(pServer.url, pServer.apiKey, pQ.query);
        })
    );

    const oData = {};
    let bAnyCoreData = false;

    aResults.forEach((pResult, pIndex) => {

        if (pResult.status === 'fulfilled' && pResult.value) {

            if (aQueries[pIndex].key === 'dockerUpdates') {
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

    const nUpdateIdx = aQueries.findIndex((pQ) => pQ.key === 'dockerUpdates');
    const oUpdateResult = aResults[nUpdateIdx];

    if (oUpdateResult?.status === 'fulfilled' && oUpdateResult.value?.docker?.containerUpdateStatuses && oData.docker) {
        oData.docker.updateStatuses = oUpdateResult.value.docker.containerUpdateStatuses;
    }

    if (!bAnyCoreData) {

        const sCoreErr = aResults[0].status === 'rejected'
            ? aResults[0].reason?.message || 'Unknown error'
            : 'No data returned';

        throw new Error(sCoreErr);
    }

    return oData;
};

const handleFetchDashboard = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer || !oServer.apiKey) {
        return {error: oServer ? 'KEY_MISSING' : 'NO_SERVER'};
    }

    let sKeyType = 'admin';

    try {

        const oMeData = await executeGraphQL(oServer.url, oServer.apiKey, QUERY_ME);

        if (hasPermissionErrors(oMeData)) {
            sKeyType = 'readonly';
        } else {
            sKeyType = detectKeyType(oMeData);
        }

    } catch (pErr) {
        sKeyType = isPermissionError(pErr) ? 'readonly' : 'admin';
    }

    const oData = await fetchServerDashboard(oServer);

    return {data: oData, serverId: oServer.id, keyType: sKeyType};
};

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

const handleTestConnection = async (pServer) => {

    if (!pServer || !pServer.url || !pServer.apiKey) {
        return {error: 'INVALID_CONFIG'};
    }

    const oData = await executeGraphQL(pServer.url, pServer.apiKey, QUERY_TEST_CONNECTION);

    let sKeyType = 'admin';

    try {

        const oMeData = await executeGraphQL(pServer.url, pServer.apiKey, QUERY_ME);

        if (hasPermissionErrors(oMeData)) {
            sKeyType = 'readonly';
        } else {
            sKeyType = detectKeyType(oMeData);
        }

    } catch (pErr) {
        if (isPermissionError(pErr)) {
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

const handleControlDocker = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    const sQuery = pMessage.command === 'start' ? MUTATION_DOCKER_START : MUTATION_DOCKER_STOP;

    try {

        const oData = await executeGraphQL(oServer.url, oServer.apiKey, sQuery, {id: pMessage.containerId});

        if (hasPermissionErrors(oData)) {
            return {error: 'PERMISSION_DENIED'};
        }

        return {success: true, data: oData};

    } catch (pErr) {

        if (isPermissionError(pErr)) {
            return {error: 'PERMISSION_DENIED'};
        }

        throw pErr;
    }
};

const handleControlVM = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    const sQuery = pMessage.command === 'start' ? MUTATION_VM_START : MUTATION_VM_STOP;

    try {

        const oData = await executeGraphQL(oServer.url, oServer.apiKey, sQuery, {id: pMessage.vmId});

        if (hasPermissionErrors(oData)) {
            return {error: 'PERMISSION_DENIED'};
        }

        return {success: true, data: oData};

    } catch (pErr) {

        if (isPermissionError(pErr)) {
            return {error: 'PERMISSION_DENIED'};
        }

        throw pErr;
    }
};

const handleFetchNotifications = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    const oFilter = pMessage.filter || {type: 'UNREAD', offset: 0, limit: 50};
    const oData = await executeGraphQL(oServer.url, oServer.apiKey, QUERY_NOTIFICATIONS, {filter: oFilter});

    return {success: true, data: oData.notifications?.list || []};
};

const handleArchiveNotification = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    try {

        const oData = await executeGraphQL(oServer.url, oServer.apiKey, MUTATION_ARCHIVE_NOTIFICATION, {id: pMessage.notificationId});

        if (hasPermissionErrors(oData)) {
            return {error: 'PERMISSION_DENIED'};
        }

        return {success: true};

    } catch (pErr) {

        if (isPermissionError(pErr)) {
            return {error: 'PERMISSION_DENIED'};
        }

        throw pErr;
    }
};

const handleArchiveAll = async (pMessage) => {

    const oServer = await getServerById(pMessage.serverId);

    if (!oServer) {
        return {error: 'NO_SERVER'};
    }

    try {

        const oData = await executeGraphQL(oServer.url, oServer.apiKey, MUTATION_ARCHIVE_ALL);

        if (hasPermissionErrors(oData)) {
            return {error: 'PERMISSION_DENIED'};
        }

        return {success: true};

    } catch (pErr) {

        if (isPermissionError(pErr)) {
            return {error: 'PERMISSION_DENIED'};
        }

        throw pErr;
    }
};

const categorizeError = (pErr) => {

    const sMsg = pErr.message || '';

    if (sMsg === 'AUTH_ERROR') {
        return 'AUTH_ERROR';
    }

    if (sMsg.startsWith('HTTP_')) {
        return sMsg;
    }

    if (sMsg.startsWith('GQL_ERROR')) {
        return sMsg;
    }

    if (sMsg.includes('Failed to fetch') || sMsg.includes('NetworkError') || sMsg.includes('net::')) {
        return 'UNREACHABLE';
    }

    if (sMsg.includes('TimeoutError') || sMsg.includes('abort')) {
        return 'TIMEOUT';
    }

    return 'UNKNOWN: ' + sMsg;
};

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

browserAPI.runtime.onInstalled.addListener(async () => {

    browserAPI.alarms.create('badgeUpdate', {periodInMinutes: 5});

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
    }
});
