import {describe, expect, test} from 'bun:test';
import {encryptedServers, fixture, fixtureHandler, loadBackground, respond, respondFixture, waitFor} from './harness.js';

const SERVER_A = {id: 'server-a', name: 'Tower A', url: 'http://tower-a.lan', apiKey: 'admin-key'};
const SERVER_B = {id: 'server-b', name: 'Tower B', url: 'http://tower-b.lan/', apiKey: 'admin-key-b'};

/**
 * Background with encrypted servers, the badge alarm already present and auto-refresh on
 * @param {Object} [pOptions] - {servers, settings, fetch, alarms, extra}
 * @returns {Promise<Object>} Harness
 */
const setup = async (pOptions = {}) => {

    const oStorage = {
        ...(await encryptedServers(pOptions.servers || [SERVER_A])),
        settings: pOptions.settings || {refreshInterval: 60000},
        ...(pOptions.extra || {})
    };

    return loadBackground({
        storage: oStorage,
        alarms: pOptions.alarms || {badgeUpdate: {name: 'badgeUpdate', periodInMinutes: 5}},
        fetch: pOptions.fetch
    });
};

/**
 * Handler that answers one operation differently and everything else from the fixtures
 * @param {Object} pOverrides - {op: (request) => Response}
 * @returns {Function}
 */
const withOverrides = (pOverrides) => (pRequest) => {

    const fnOverride = pOverrides[pRequest.op];
    return fnOverride ? fnOverride(pRequest) : fixtureHandler(pRequest);
};

/**
 * HTTP 200 GraphQL error response
 * @param {string} pMessage - errors[0].message
 * @param {Object|null} [pData] - data next to the error
 * @returns {Response}
 */
const gqlError = (pMessage, pData = null) => respond(200, {
    errors: [{message: pMessage, extensions: {code: 'INTERNAL_SERVER_ERROR'}}],
    data: pData
});

/**
 * Handler answering the ApiVersion query with a version string
 * @param {string} pVersion - info.versions.core.api
 * @returns {Function}
 */
const apiVersion = (pVersion) => () => respond(200, {data: {info: {versions: {core: {api: pVersion}}}}});

/**
 * Pending-update record as the popup sends it
 * @param {number} pStartedAt - Start timestamp, identifies the operation
 * @param {Object} [pExtra] - Fields to override
 * @returns {Object}
 */
const record = (pStartedAt, pExtra = {}) => ({
    bulk: false,
    startedAt: pStartedAt,
    items: {'app-01': {id: 'c1', startState: 'RUNNING'}},
    total: 1,
    done: 0,
    failed: 0,
    unknown: 0,
    ...pExtra
});

describe('executeGraphQL error mapping', () => {

    const run = async (pFetch) => {

        const oBg = await setup({fetch: pFetch});
        return oBg.executeGraphQL('http://tower-a.lan/', 'admin-key', 'query Core { vars { name } }');
    };

    test.each([
        ['Chrome', 'signal timed out'],
        ['Firefox', 'The operation timed out.']
    ])('TimeoutError from %s is TIMEOUT (AC-17)', async (pBrowser, pMessage) => {

        await expect(run(() => {
            throw new DOMException(pMessage, 'TimeoutError');
        })).rejects.toThrow(/^TIMEOUT$/);
    });

    test('requests carry a timeout signal and the API key', async () => {

        const oBg = await setup();
        await oBg.executeGraphQL('http://tower-a.lan/', 'admin-key', 'query Core { vars { name } }');

        expect(oBg.requests[0].url).toBe('http://tower-a.lan/graphql');
        expect(oBg.requests[0].key).toBe('admin-key');
        expect(oBg.requests[0].signal).toBeInstanceOf(AbortSignal);
    });

    test.each([401, 403])('HTTP %i is AUTH_ERROR', async (pStatus) => {

        await expect(run(() => respond(pStatus, {message: 'Unauthorized'}))).rejects.toThrow(/^AUTH_ERROR$/);
    });

    test('HTTP 400 keeps the GraphQL detail', async () => {

        await expect(run(() => respondFixture('Validation_error')))
            .rejects.toThrow('HTTP_400: Cannot query field "notAField" on type "UnraidArray".');
    });

    test('HTTP 502 with an HTML body is HTTP_502', async () => {

        await expect(run(() => respond(502, '<html>Bad Gateway</html>'))).rejects.toThrow(/^HTTP_502$/);
    });

    test('partial data with errors returns the data and the messages', async () => {

        const oData = await run(() => respond(200, {data: {docker: null, vars: {name: 'Tower'}}, errors: [{message: 'Docker down'}]}));

        expect(oData.vars.name).toBe('Tower');
        expect(oData._errors).toEqual(['Docker down']);
    });

    test('a validation error without data is UNSUPPORTED', async () => {

        const oBody = structuredClone(fixture('Validation_error').body);
        await expect(run(() => respond(200, {...oBody, data: null}))).rejects.toThrow(/^UNSUPPORTED: Cannot query field/);
    });

    test('the real invalid-key answer (HTTP 200, UNAUTHENTICATED) is AUTH_ERROR (AC-11)', async () => {

        await expect(run(() => respondFixture('Auth_invalid'))).rejects.toThrow(/^AUTH_ERROR$/);
    });

    test.each([
        ['Chrome', 'Failed to fetch'],
        ['Firefox', 'NetworkError when attempting to fetch resource.']
    ])('a %s network error is UNREACHABLE', async (pBrowser, pMessage) => {

        const oBg = await setup({
            fetch: () => {
                throw new TypeError(pMessage);
            }
        });

        expect(await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).toEqual({error: 'UNREACHABLE'});
    });
});

describe('detectKeyType', () => {

    test.each([
        ['real admin key', fixture('Me').body.data, 'admin'],
        ['real viewer key', fixture('Me_viewer').body.data, 'readonly'],
        ['custom role with UPDATE_ANY', {me: {roles: [], permissions: [{resource: 'DOCKER', actions: ['UPDATE_ANY']}]}}, 'admin'],
        ['custom role with DELETE_ANY', {me: {roles: [], permissions: [{resource: 'VMS', actions: ['DELETE_ANY']}]}}, 'admin'],
        ['read-only permissions', {me: {roles: [], permissions: [{resource: 'DOCKER', actions: ['READ_ANY']}]}}, 'readonly'],
        ['no data', null, 'readonly']
    ])('%s', async (pName, pData, pExpected) => {

        const oBg = await setup();
        expect(oBg.detectKeyType(pData)).toBe(pExpected);
    });

    test('fetchDashboard reports a viewer key as readonly', async () => {

        const oBg = await setup({servers: [{...SERVER_A, apiKey: 'viewer-key'}], fetch: withOverrides({Me: () => respondFixture('Me_viewer')})});
        expect((await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).keyType).toBe('readonly');
    });
});

describe('version gating (section 2)', () => {

    const BASE_OPS = ['Me', 'ApiVersion', 'Core', 'Array', 'Network', 'Docker', 'VMs', 'ParityStatus', 'DiskTempThresholds'];
    const NONE = {webUiUrl: false, updates: false, pause: false, restart: false, temperature: false};
    const V430 = {webUiUrl: true, updates: true, pause: true, restart: false, temperature: false};

    test.each([
        ['4.25.0', [], NONE],
        ['4.29.2', [], NONE],
        ['4.30.0', ['DockerUpdates', 'DockerWebUi'], V430],
        ['4.35.9', ['DockerUpdates', 'DockerWebUi'], V430],
        ['4.36.0', ['DockerUpdates', 'DockerWebUi'], {...V430, restart: true}],
        ['4.37.5', ['DockerUpdates', 'DockerWebUi'], {...V430, restart: true}],
        ['4.37.6', ['DockerUpdates', 'DockerWebUi', 'Temperature'], {...V430, restart: true, temperature: true}],
        ['4.37.9+bedd403a', ['DockerUpdates', 'DockerWebUi', 'Temperature'], {...V430, restart: true, temperature: true}],
        ['5.0.0', ['DockerUpdates', 'DockerWebUi', 'Temperature'], {...V430, restart: true, temperature: true}],
        ['not-a-version', [], NONE]
    ])('API %s', async (pVersion, pExtraOps, pFeatures) => {

        const oBg = await setup({fetch: withOverrides({ApiVersion: apiVersion(pVersion)})});
        const oResponse = await oBg.send({action: 'fetchDashboard', serverId: 'server-a'});

        expect(oResponse.features).toEqual(pFeatures);
        expect(oResponse.apiVersion).toBe(pVersion);
        expect(oBg.ops().sort()).toEqual([...BASE_OPS, ...pExtraOps].sort());
    });

    test('a failing version query counts as unknown: no gated query is sent', async () => {

        const oBg = await setup({fetch: withOverrides({ApiVersion: () => gqlError('Internal server error')})});
        const oResponse = await oBg.send({action: 'fetchDashboard', serverId: 'server-a'});

        expect(oResponse.apiVersion).toBeNull();
        expect(oResponse.features).toEqual(NONE);
        expect(oBg.ops().sort()).toEqual([...BASE_OPS].sort());
    });
});

describe('fetchDashboard', () => {

    test('merges the feature queries into the dashboard data', async () => {

        const oBg = await setup();
        const oResponse = await oBg.send({action: 'fetchDashboard', serverId: 'server-a'});
        const oData = oResponse.data;
        const oFirstWebUi = fixture('DockerWebUi').body.data.docker.containers[0];

        expect(oResponse.serverId).toBe('server-a');
        expect(oResponse.keyType).toBe('admin');
        expect(oData.docker.containers.find((pC) => pC.id === oFirstWebUi.id).webUiUrl).toBe(oFirstWebUi.webUiUrl);
        expect(oData.docker.updateStatuses).toEqual(fixture('DockerUpdates').body.data.docker.containerUpdateStatuses);
        expect(oData.array.parityCheckStatus).toEqual(fixture('ParityStatus').body.data.array.parityCheckStatus);
        expect(oData.diskTempThresholds).toEqual({warning: 45, critical: 55});
        expect(oData.temperature).toEqual(fixture('Temperature').body.data.metrics.temperature);
    });

    test('failing feature queries leave the rest of the dashboard (AC-43, AC-46, AC-49)', async () => {

        const fnInvalid = () => respondFixture('Validation_error');
        const oBg = await setup({
            fetch: withOverrides({DockerWebUi: fnInvalid, ParityStatus: fnInvalid, Temperature: fnInvalid, DiskTempThresholds: fnInvalid})
        });
        const oData = (await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).data;

        expect(oData.docker.containers.length).toBe(31);
        expect(oData.docker.containers.every((pC) => pC.webUiUrl === undefined)).toBe(true);
        expect(oData.array.parityCheckStatus).toBeNull();
        expect(oData.temperature).toBeNull();
        expect(oData.diskTempThresholds).toBeUndefined();
        expect(oData.vars.name).toBe('Tower');
    });

    test('a Docker query rejected by the schema falls back to the basic query', async () => {

        const oBg = await setup({fetch: withOverrides({Docker: () => respondFixture('Validation_error')})});
        const oData = (await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).data;

        expect(oBg.ops()).toContain('DockerBasic');
        expect(oData.docker.containers.length).toBe(31);
    });

    test('the real invalid-key answer reaches the popup as AUTH_ERROR (AC-11)', async () => {

        const oBg = await setup({servers: [{...SERVER_A, apiKey: 'wrong-key'}], fetch: () => respondFixture('Auth_invalid')});
        expect(await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).toEqual({error: 'AUTH_ERROR'});
    });

    test('a Core timeout is TIMEOUT', async () => {

        const oBg = await setup({
            fetch: withOverrides({
                Core: () => {
                    throw new DOMException('signal timed out', 'TimeoutError');
                }
            })
        });

        expect(await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).toEqual({error: 'TIMEOUT'});
    });

    test('unknown server and missing key', async () => {

        const oBg = await setup({extra: {servers: [{id: 'server-a', url: 'http://x'}, {id: 'server-k', url: 'http://y'}]}});

        expect(await oBg.send({action: 'fetchDashboard', serverId: 'nope'})).toEqual({error: 'NO_SERVER'});
        expect(await oBg.send({action: 'fetchDashboard', serverId: 'server-k'})).toEqual({error: 'KEY_MISSING'});
    });
});

describe('badge alarm (MJ-001)', () => {

    const unread = (pTotal) => withOverrides({
        BadgeCount: () => respond(200, {data: {notifications: {overview: {unread: {total: pTotal}}}}})
    });

    test('script load without the alarm creates it and refreshes the badge (Firefox restart)', async () => {

        const oBg = await setup({alarms: {}, fetch: unread(4)});

        await waitFor(() => oBg.badge.text === '4');
        expect(oBg.alarmsCreated).toEqual([{name: 'badgeUpdate', periodInMinutes: 5}]);
        expect(oBg.badge.color).toBe('#FF8C2F');
    });

    test('script load with the alarm present does not recreate it', async () => {

        const oBg = await setup({fetch: unread(4)});

        await new Promise((pFnResolve) => setTimeout(pFnResolve, 50));
        expect(oBg.alarmsCreated).toEqual([]);
        expect(oBg.ops()).not.toContain('BadgeCount');
    });

    test.each(['startup', 'installed'])('on%s refreshes the badge even when the alarm exists', async (pEvent) => {

        const oBg = await setup({fetch: unread(2)});

        oBg.listeners[pEvent][0]({reason: 'update'});
        await waitFor(() => oBg.badge.text === '2');
        expect(oBg.alarmsCreated).toEqual([]);
    });

    test('onStartup recreates a missing alarm', async () => {

        const oBg = await setup({alarms: {}, fetch: unread(1)});

        await waitFor(() => oBg.alarmsCreated.length === 1);
        delete oBg.alarms.badgeUpdate;
        oBg.listeners.startup[0]();
        await waitFor(() => oBg.alarmsCreated.length === 2);
    });

    test('the alarm refreshes the badge', async () => {

        const oBg = await setup({fetch: unread(7)});

        oBg.listeners.alarm[0]({name: 'badgeUpdate'});
        await waitFor(() => oBg.badge.text === '7');
    });

    test('totals all servers and ignores one that fails', async () => {

        const oBg = await setup({
            servers: [SERVER_A, SERVER_B, {id: 'server-c', name: 'C', url: 'http://c.lan', apiKey: 'k'}],
            fetch: (pRequest) => {

                if (pRequest.url.startsWith('http://c.lan')) {
                    throw new TypeError('Failed to fetch');
                }

                return respond(200, {data: {notifications: {overview: {unread: {total: pRequest.url.includes('tower-a') ? 3 : 2}}}}});
            }
        });

        expect(await oBg.send({action: 'refreshBadge'})).toEqual({success: true});
        expect(oBg.badge.text).toBe('5');
    });

    test('auto-refresh Off hides the badge (existing gating)', async () => {

        const oBg = await setup({settings: {refreshInterval: 0}, fetch: unread(3)});

        await oBg.send({action: 'refreshBadge'});
        expect(oBg.badge.text).toBe('');
        expect(oBg.ops()).not.toContain('BadgeCount');
    });

    test('no servers clears the badge', async () => {

        const oBg = loadBackground({storage: {settings: {refreshInterval: 60000}}, alarms: {badgeUpdate: {}}});

        await oBg.send({action: 'refreshBadge'});
        expect(oBg.badge.text).toBe('');
    });
});

describe('mutation outcomes (MJ-004)', () => {

    const control = async (pFetch, pMessage = {action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'start'}) => {

        const oBg = await setup({fetch: withOverrides({DockerStart: pFetch, VMStart: pFetch})});
        return oBg.send(pMessage);
    };

    test('GraphQL error with partial data is a failure with the server message', async () => {

        expect(await control(() => gqlError('port is already allocated', {docker: null})))
            .toEqual({error: 'port is already allocated', outcome: 'failed'});
    });

    test('GraphQL error without data is a failure', async () => {

        expect(await control(() => gqlError('port is already allocated')))
            .toEqual({error: 'GQL_ERROR: port is already allocated', outcome: 'failed'});
    });

    test('HTTP 400 is unsupported', async () => {

        expect((await control(() => respondFixture('Validation_error'))).outcome).toBe('unsupported');
    });

    test.each([
        ['timeout', () => {
            throw new DOMException('signal timed out', 'TimeoutError');
        }, 'TIMEOUT'],
        ['network error', () => {
            throw new TypeError('Failed to fetch');
        }, 'UNREACHABLE']
    ])('%s is unknown', async (pName, pFetch, pError) => {

        expect(await control(pFetch)).toEqual({error: pError, outcome: 'unknown'});
    });

    test('the real viewer-key answer (HTTP 200, FORBIDDEN) is PERMISSION_DENIED', async () => {

        expect(await control(() => respondFixture('Mutation_viewer_forbidden'))).toEqual({error: 'PERMISSION_DENIED'});
    });

    test('a server message that contains "denied" is still the server failure, not a key permission problem (AC-15, AC-27)', async () => {

        const sMessage = "error while creating mount source path '/mnt/user/appdata/app': mkdir /mnt/user/appdata/app: permission denied";
        expect(await control(() => gqlError(sMessage, {docker: null}))).toEqual({error: sMessage, outcome: 'failed'});
    });

    test('a VM command answered with false is a failure', async () => {

        const oResult = await control(() => respond(200, {data: {vm: {start: false}}}),
            {action: 'controlVM', serverId: 'server-a', vmId: 'v1', command: 'start'});
        expect(oResult).toEqual({error: 'The server did not accept the command.', outcome: 'failed'});
    });

    test('success returns the data', async () => {

        const oResult = await control(fixtureHandler);
        expect(oResult.success).toBe(true);
        expect(oResult.data.docker.start.state).toBe('RUNNING');
    });
});

describe('message handlers by action', () => {

    test.each([
        ['start', 'DockerStart'],
        ['stop', 'DockerStop'],
        ['restart', 'DockerRestart'],
        ['pause', 'DockerPause'],
        ['resume', 'DockerUnpause']
    ])('controlDocker %s sends %s', async (pCommand, pOp) => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: pCommand});

        expect(oResult.success).toBe(true);
        expect(oBg.requests.map((pR) => [pR.op, pR.variables])).toEqual([[pOp, {id: 'c1'}]]);
    });

    test.each([
        ['start', 'VMStart'],
        ['stop', 'VMStop'],
        ['resume', 'VMResume'],
        ['restart', 'VMReboot']
    ])('controlVM %s sends %s', async (pCommand, pOp) => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'controlVM', serverId: 'server-a', vmId: 'v1', command: pCommand});

        expect(oResult.success).toBe(true);
        expect(oBg.requests.map((pR) => [pR.op, pR.variables])).toEqual([[pOp, {id: 'v1'}]]);
    });

    test('control commands reject unknown commands and servers', async () => {

        const oBg = await setup();

        expect(await oBg.send({action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'kill'}))
            .toEqual({error: 'INVALID_CONFIG', outcome: 'failed'});
        expect(await oBg.send({action: 'controlVM', serverId: 'nope', vmId: 'v1', command: 'start'}))
            .toEqual({error: 'NO_SERVER', outcome: 'failed'});
        expect(oBg.requests).toEqual([]);
    });

    test('archiveNotification', async () => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'archiveNotification', serverId: 'server-a', notificationId: 'n1'});

        expect(oResult.success).toBe(true);
        expect(oBg.requests.map((pR) => [pR.op, pR.variables])).toEqual([['ArchiveNotification', {id: 'n1'}]]);
    });

    test('archiveAll', async () => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'archiveAll', serverId: 'server-a'});

        expect(oResult.success).toBe(true);
        expect(oBg.ops()).toEqual(['ArchiveAll']);
    });

    test('fetchNotifications uses the unread filter by default and returns the list', async () => {

        const oBg = await setup();
        const oDefault = await oBg.send({action: 'fetchNotifications', serverId: 'server-a'});
        const oArchive = await oBg.send({action: 'fetchNotifications', serverId: 'server-a', filter: {type: 'ARCHIVE', offset: 0, limit: 20}});

        expect(oDefault).toEqual({success: true, data: []});
        expect(oArchive.data).toEqual(fixture('NotificationListArchive').body.data.notifications.list);
        expect(oBg.requests.map((pR) => pR.variables.filter)).toEqual([
            {type: 'UNREAD', offset: 0, limit: 50},
            {type: 'ARCHIVE', offset: 0, limit: 20}
        ]);
    });

    test.each([
        ['docker', 'DockerStatus'],
        ['vm', 'VMStatus'],
        ['update', 'DockerUpdateStatus']
    ])('fetchStatus %s uses only the narrow %s query (AC-62)', async (pKind, pOp) => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'fetchStatus', serverId: 'server-a', kind: pKind});

        expect(oResult).toEqual({success: true, data: fixture(pOp).body.data});
        expect(oBg.ops()).toEqual([pOp]);
    });

    test('fetchStatus rejects an unknown kind', async () => {

        const oBg = await setup();
        expect(await oBg.send({action: 'fetchStatus', serverId: 'server-a', kind: 'all'})).toEqual({error: 'INVALID_CONFIG'});
    });

    test('testConnection', async () => {

        const oBg = await setup();

        expect(await oBg.send({action: 'testConnection', server: {url: 'http://tower-a.lan', apiKey: 'admin-key'}}))
            .toEqual({success: true, name: 'Tower', version: '7.3.4', keyType: 'admin'});
        expect(await oBg.send({action: 'testConnection', server: {url: 'http://tower-a.lan'}})).toEqual({error: 'INVALID_CONFIG'});
    });

    test('testConnection with a viewer key', async () => {

        const oBg = await setup({fetch: withOverrides({Me: () => respondFixture('Me_viewer')})});
        const oResult = await oBg.send({action: 'testConnection', server: {url: 'http://tower-a.lan', apiKey: 'viewer-key'}});

        expect(oResult.keyType).toBe('readonly');
    });

    test('savePendingUpdate stores and removes the record', async () => {

        const oBg = await setup();

        expect(await oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(1)})).toEqual({success: true});
        expect(oBg.storage.pendingUpdates).toEqual({'server-a': record(1)});
        await oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: null});
        expect(oBg.storage.pendingUpdates).toEqual({});
    });
});

describe('updateContainers', () => {

    test('stores the operation before the mutation and sends every id', async () => {

        let oStoredAtCall = null;
        const oBg = await setup({
            fetch: withOverrides({
                DockerUpdate: () => {

                    oStoredAtCall = structuredClone(oBg.storage.pendingUpdates);
                    return fixtureHandler({op: 'DockerUpdate'});
                }
            })
        });
        const oRecord = record(10, {items: {a: {id: 'c1', startState: 'RUNNING'}, b: {id: 'c2', startState: 'EXITED'}}});

        expect((await oBg.send({action: 'updateContainers', serverId: 'server-a', record: oRecord})).success).toBe(true);
        expect(oStoredAtCall).toEqual({'server-a': oRecord});
        expect(oBg.requests[0].variables).toEqual({ids: ['c1', 'c2']});
        expect(oBg.storage.pendingUpdates).toEqual({'server-a': oRecord});
    });

    test.each([
        ['server error', () => gqlError('manifest unknown'), {error: 'GQL_ERROR: manifest unknown', outcome: 'failed'}, 'GQL_ERROR: manifest unknown'],
        ['viewer key', () => respondFixture('Mutation_viewer_forbidden'), {error: 'PERMISSION_DENIED'}, 'PERMISSION_DENIED']
    ])('%s is recorded as the failure (AC-27)', async (pName, pFetch, pResult, pFail) => {

        const oBg = await setup({fetch: withOverrides({DockerUpdate: pFetch})});

        expect(await oBg.send({action: 'updateContainers', serverId: 'server-a', record: record(20)})).toEqual(pResult);
        expect(oBg.storage.pendingUpdates['server-a']).toEqual(record(20, {failMessage: pFail}));
    });

    test('unsupported removes the record (AC-58)', async () => {

        const oBg = await setup({fetch: withOverrides({DockerUpdate: () => respondFixture('Validation_error')})});

        expect((await oBg.send({action: 'updateContainers', serverId: 'server-a', record: record(30)})).outcome).toBe('unsupported');
        expect(oBg.storage.pendingUpdates).toEqual({});
    });

    test('no answer keeps the record without a failure (AC-59)', async () => {

        const oBg = await setup({
            fetch: withOverrides({
                DockerUpdate: () => {
                    throw new DOMException('signal timed out', 'TimeoutError');
                }
            })
        });

        expect(await oBg.send({action: 'updateContainers', serverId: 'server-a', record: record(40)}))
            .toEqual({error: 'TIMEOUT', outcome: 'unknown'});
        expect(oBg.storage.pendingUpdates).toEqual({'server-a': record(40)});
    });
});

describe('pendingUpdates single writer', () => {

    test('concurrent writes for two servers both persist', async () => {

        const oBg = await setup();

        await Promise.all([
            oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(1)}),
            oBg.send({action: 'savePendingUpdate', serverId: 'server-b', record: record(2)})
        ]);

        expect(oBg.storage.pendingUpdates).toEqual({'server-a': record(1), 'server-b': record(2)});
    });

    test('writes for one server apply in the order they were sent', async () => {

        const oBg = await setup();

        await Promise.all([
            oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(1, {done: 1})}),
            oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(1, {done: 2})}),
            oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: null}),
            oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(1, {done: 3})})
        ]);

        expect(oBg.storage.pendingUpdates).toEqual({'server-a': record(1, {done: 3})});
    });

    test('the popup record keeps a failure the background recorded for the same operation', async () => {

        const oBg = await setup({fetch: withOverrides({DockerUpdate: () => gqlError('manifest unknown')})});

        await oBg.send({action: 'updateContainers', serverId: 'server-a', record: record(50)});
        await oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(50, {done: 0})});

        expect(oBg.storage.pendingUpdates['server-a'].failMessage).toBe('GQL_ERROR: manifest unknown');

        await oBg.send({action: 'savePendingUpdate', serverId: 'server-a', record: record(60)});
        expect(oBg.storage.pendingUpdates['server-a']).toEqual(record(60));
    });
});
