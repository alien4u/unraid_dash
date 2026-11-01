/* Loads js/background.js (a classic script) into a node:vm context with stubbed extension APIs and fetch */
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const BACKGROUND_SOURCE = readFileSync(new URL('../../js/background.js', import.meta.url), 'utf8');
const FIXTURE_DIR = new URL('../fixtures/mock/', import.meta.url);

/**
 * Reads a captured fixture ({status, body})
 * @param {string} pName - Fixture file name without .json
 * @returns {Object}
 */
export const fixture = (pName) => JSON.parse(readFileSync(new URL(pName + '.json', FIXTURE_DIR), 'utf8'));

/**
 * Builds a fetch Response
 * @param {number} pStatus - HTTP status
 * @param {Object|string} pBody - JSON body, or raw text
 * @returns {Response}
 */
export const respond = (pStatus, pBody) => new Response(
    typeof pBody === 'string' ? pBody : JSON.stringify(pBody),
    {status: pStatus, headers: {'Content-Type': typeof pBody === 'string' ? 'text/html' : 'application/json'}}
);

/**
 * Response for a captured fixture
 * @param {string} pName - Fixture file name without .json
 * @returns {Response}
 */
export const respondFixture = (pName) => {

    const oFixture = fixture(pName);
    return respond(oFixture.status, oFixture.body);
};

/**
 * Default handler: answers every query with its captured fixture, and mutations with a plain success
 * @param {Object} pRequest - {op, variables, key}
 * @returns {Response}
 */
export const fixtureHandler = (pRequest) => {

    const oMutations = {
        DockerStart: {docker: {start: {id: 'c1', state: 'RUNNING', status: 'Up'}}},
        DockerStop: {docker: {stop: {id: 'c1', state: 'EXITED', status: 'Exited'}}},
        DockerRestart: {docker: {restart: {id: 'c1', state: 'RUNNING', status: 'Up'}}},
        DockerPause: {docker: {pause: {id: 'c1', state: 'PAUSED', status: 'Paused'}}},
        DockerUnpause: {docker: {unpause: {id: 'c1', state: 'RUNNING', status: 'Up'}}},
        DockerUpdate: {docker: {updateContainers: [{id: 'c1', state: 'RUNNING'}]}},
        VMStart: {vm: {start: true}},
        VMStop: {vm: {stop: true}},
        VMResume: {vm: {resume: true}},
        VMReboot: {vm: {reboot: true}},
        ArchiveNotification: {archiveNotification: {id: 'n1'}},
        ArchiveAll: {archiveAll: {unread: {total: 0}}}
    };

    if (oMutations[pRequest.op]) {
        return respond(200, {data: oMutations[pRequest.op]});
    }

    if (pRequest.op === 'NotificationList') {
        return respondFixture(pRequest.variables.filter.type === 'ARCHIVE' ? 'NotificationListArchive' : 'NotificationListUnread');
    }

    return respondFixture(pRequest.op);
};

/**
 * Encrypts API keys the way the popup stores them
 * @param {Object[]} pServers - [{id, name, url, apiKey}]
 * @returns {Promise<Object>} Storage items: _ek, servers, encryptedKeys
 */
export const encryptedServers = async (pServers) => {

    const oKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const oEncKeys = {};

    for (const oServer of pServers) {

        const aIv = crypto.getRandomValues(new Uint8Array(12));
        const aData = await crypto.subtle.encrypt({name: 'AES-GCM', iv: aIv}, oKey, new TextEncoder().encode(oServer.apiKey));
        oEncKeys[oServer.id] = {iv: Array.from(aIv), data: Array.from(new Uint8Array(aData))};
    }

    return {
        _ek: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', oKey))),
        servers: pServers.map(({apiKey, ...pRest}) => pRest),
        encryptedKeys: oEncKeys
    };
};

/**
 * Polls until pFn returns a truthy value
 * @param {Function} pFn - Condition
 * @param {number} [pTimeout] - Milliseconds
 * @returns {Promise<*>}
 */
export const waitFor = async (pFn, pTimeout = 2000) => {

    const nEnd = Date.now() + pTimeout;

    while (Date.now() < nEnd) {

        const oResult = await pFn();

        if (oResult) {
            return oResult;
        }

        await new Promise((pFnResolve) => setTimeout(pFnResolve, 5));
    }

    throw new Error('waitFor timed out: ' + pFn.toString());
};

/**
 * Creates a fresh background context
 * @param {Object} [pOptions] - {storage, alarms, fetch: (request) => Response | Promise<Response>}
 * @returns {Object} Harness with send(), requests, storage, alarms, badge and the script's functions
 */
export const loadBackground = (pOptions = {}) => {

    const oLocal = structuredClone(pOptions.storage || {});
    const oAlarms = {...(pOptions.alarms || {})};
    const oListeners = {message: [], installed: [], startup: [], alarm: []};
    const oBadge = {text: null, color: null, calls: []};
    const aCreated = [];
    const aRequests = [];
    const oHarness = {fetch: pOptions.fetch || fixtureHandler};

    /* Storage callbacks run asynchronously, like the real API */
    const fnLater = (pFn) => setTimeout(pFn, 0);

    const oStorageArea = (pStore) => ({
        get: (pKeys, pFnCallback) => {

            const aKeys = pKeys === null ? Object.keys(pStore) : [].concat(pKeys);
            const oResult = {};

            aKeys.forEach((pKey) => {

                if (pKey in pStore) {
                    oResult[pKey] = structuredClone(pStore[pKey]);
                }
            });

            fnLater(() => pFnCallback(oResult));
        },
        set: (pItems, pFnCallback) => {

            fnLater(() => {

                Object.assign(pStore, structuredClone(pItems));

                if (pFnCallback) {
                    pFnCallback();
                }
            });
        }
    });

    const oChrome = {
        storage: {local: oStorageArea(oLocal), session: oStorageArea({})},
        alarms: {
            get: async (pName) => oAlarms[pName],
            create: (pName, pInfo) => {

                aCreated.push({name: pName, ...pInfo});
                oAlarms[pName] = {name: pName, ...pInfo};
            },
            onAlarm: {addListener: (pFn) => oListeners.alarm.push(pFn)}
        },
        action: {
            setBadgeText: (pDetails) => {

                oBadge.text = pDetails.text;
                oBadge.calls.push(pDetails.text);
            },
            setBadgeBackgroundColor: (pDetails) => {

                oBadge.color = pDetails.color;
            }
        },
        runtime: {
            onMessage: {addListener: (pFn) => oListeners.message.push(pFn)},
            onInstalled: {addListener: (pFn) => oListeners.installed.push(pFn)},
            onStartup: {addListener: (pFn) => oListeners.startup.push(pFn)}
        }
    };

    const fnFetch = async (pUrl, pInit) => {

        const oBody = JSON.parse(pInit.body);
        const aMatch = /(query|mutation)\s+(\w+)/.exec(oBody.query);
        const oRequest = {
            url: pUrl,
            op: aMatch ? aMatch[2] : null,
            kind: aMatch ? aMatch[1] : null,
            variables: oBody.variables || null,
            key: pInit.headers['x-api-key'],
            signal: pInit.signal
        };

        aRequests.push(oRequest);

        return oHarness.fetch(oRequest);
    };

    const oContext = vm.createContext({
        chrome: oChrome,
        fetch: fnFetch,
        crypto,
        TextEncoder,
        TextDecoder,
        AbortSignal,
        Response,
        console,
        setTimeout,
        clearTimeout
    });

    vm.runInContext(BACKGROUND_SOURCE, oContext, {filename: 'js/background.js'});

    const oFns = vm.runInContext(`({
        executeGraphQL, detectKeyType, categorizeError, isVersionAtLeast, isUnsupportedMsg, updateBadge, ensureBadgeAlarm
    })`, oContext);

    /**
     * Dispatches a runtime message to the background listener and resolves with its response
     * @param {Object} pMessage - The message
     * @returns {Promise<Object>}
     */
    const send = (pMessage) => new Promise((pFnResolve, pFnReject) => {

        const bAsync = oListeners.message[0](pMessage, {}, pFnResolve);

        if (bAsync !== true) {
            pFnReject(new Error('No async response for action ' + pMessage.action));
        }
    });

    return Object.assign(oHarness, oFns, {
        send,
        requests: aRequests,
        ops: () => aRequests.map((pR) => pR.op),
        storage: oLocal,
        alarms: oAlarms,
        alarmsCreated: aCreated,
        badge: oBadge,
        listeners: oListeners
    });
};
