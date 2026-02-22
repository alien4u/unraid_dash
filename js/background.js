const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

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

const getServerByIndex = (pIndex) => {

    return new Promise((resolve) => {

        browserAPI.storage.local.get(['servers'], (pResult) => {

            const aServers = pResult.servers || [];
            resolve(aServers[pIndex] || null);
        });
    });
};

const getServerById = (pServerId) => {

    return new Promise((resolve) => {

        browserAPI.storage.local.get(['servers'], (pResult) => {

            const aServers = pResult.servers || [];
            resolve(aServers.find((pS) => pS.id === pServerId) || null);
        });
    });
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

    /* Try full Docker query first, fall back to basic if schema lacks ports */
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
        {key: 'vms', query: QUERY_VMS}
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

    if (!bAnyCoreData) {

        const sCoreErr = aResults[0].status === 'rejected'
            ? aResults[0].reason?.message || 'Unknown error'
            : 'No data returned';

        throw new Error(sCoreErr);
    }

    return oData;
};

const handleFetchDashboard = async (pMessage) => {

    let oServer;

    if (pMessage.serverId) {
        oServer = await getServerById(pMessage.serverId);
    } else {
        oServer = await getServerByIndex(pMessage.serverIndex || 0);
    }

    if (!oServer) {
        return {error: 'NO_SERVER'};
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

    const oResult = await new Promise((resolve) => {

        browserAPI.storage.local.get(['servers'], resolve);
    });

    const aServers = (oResult.servers || []).filter((pS) => pS.enabled !== false);

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

        const oResult = await new Promise((resolve) => {

            browserAPI.storage.local.get(['servers', 'settings'], resolve);
        });

        const aServers = (oResult.servers || []).filter((pS) => pS.enabled !== false);
        const oSettings = oResult.settings || {};

        if (aServers.length === 0 || !oSettings.refreshInterval) {
            browserAPI.action.setBadgeText({text: ''});
            return;
        }

        let nTotal = 0;

        for (const oServer of aServers) {

            try {

                const oData = await executeGraphQL(oServer.url, oServer.apiKey, QUERY_BADGE_COUNT);
                const nUnread = oData.notifications?.overview?.unread?.total || 0;
                nTotal += nUnread;

            } catch (_) {
                /* Skip unreachable servers */
            }
        }

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

browserAPI.runtime.onInstalled.addListener(() => {

    browserAPI.alarms.create('badgeUpdate', {periodInMinutes: 5});
});

browserAPI.alarms.onAlarm.addListener((pAlarm) => {

    if (pAlarm.name === 'badgeUpdate') {
        updateBadge();
    }
});
