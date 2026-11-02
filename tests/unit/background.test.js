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

    test('partial data with errors returns the data with each message and code', async () => {

        const oData = await run(() => respond(200, {
            data: {docker: null, vars: {name: 'Tower'}},
            errors: [{message: 'Docker down'}, {message: 'Forbidden resource', extensions: {code: 'FORBIDDEN'}}]
        }));

        expect(oData.vars.name).toBe('Tower');
        expect(oData._errors).toEqual([
            {message: 'Docker down', code: null},
            {message: 'Forbidden resource', code: 'FORBIDDEN'}
        ]);
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
        expect(oData.temperature.summary.hottest.current).toEqual({value: 68.38, unit: 'CELSIUS'});
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
        ['resume', 'VMResume']
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
        expect(await oBg.send({action: 'controlVM', serverId: 'server-a', vmId: 'v1', command: 'restart'}))
            .toEqual({error: 'INVALID_CONFIG', outcome: 'failed'});
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
        ['docker', 'DockerStatus', {}],
        ['vm', 'VMStatus', {restarts: {}}],
        ['update', 'DockerUpdateStatus', {}]
    ])('fetchStatus %s uses only the narrow %s query (AC-62)', async (pKind, pOp, pExtra) => {

        const oBg = await setup();
        const oResult = await oBg.send({action: 'fetchStatus', serverId: 'server-a', kind: pKind});

        expect(oResult).toEqual({success: true, data: fixture(pOp).body.data, ...pExtra});
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

describe('error classification (section 2, AC-68, AC-69)', () => {

    test('a partial answer with UNAUTHENTICATED is AUTH_ERROR', async () => {

        const oBg = await setup({
            fetch: () => respond(200, {data: {vars: null}, errors: [{message: 'API key validation failed', extensions: {code: 'UNAUTHENTICATED'}}]})
        });

        await expect(oBg.executeGraphQL('http://tower-a.lan', 'k', 'query Core { vars { name } }')).rejects.toThrow(/^AUTH_ERROR$/);
    });

    test.each([
        ['testConnection', {action: 'testConnection', server: {url: 'http://tower-a.lan', apiKey: 'wrong'}}, {error: 'AUTH_ERROR'}],
        ['fetchNotifications', {action: 'fetchNotifications', serverId: 'server-a'}, {error: 'AUTH_ERROR'}],
        ['fetchStatus', {action: 'fetchStatus', serverId: 'server-a', kind: 'docker'}, {error: 'AUTH_ERROR'}],
        ['controlDocker', {action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'start'},
            {error: 'AUTH_ERROR', outcome: 'failed'}]
    ])('the real invalid-key answer is AUTH_ERROR in %s', async (pName, pMessage, pExpected) => {

        const oBg = await setup({fetch: () => respondFixture('Auth_invalid')});
        expect(await oBg.send(pMessage)).toEqual(pExpected);
    });

    test('FORBIDDEN in a partial mutation answer is PERMISSION_DENIED', async () => {

        const oBody = structuredClone(fixture('Mutation_viewer_forbidden').body);
        const oBg = await setup({fetch: withOverrides({DockerStart: () => respond(200, {...oBody, data: {docker: null}})})});

        expect(await oBg.send({action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'start'}))
            .toEqual({error: 'PERMISSION_DENIED'});
    });

    test('the message "Forbidden resource" without the FORBIDDEN code is a failure', async () => {

        const oBg = await setup({fetch: withOverrides({DockerStart: () => respond(200, {errors: [{message: 'Forbidden resource'}], data: null})})});

        expect(await oBg.send({action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'start'}))
            .toEqual({error: 'GQL_ERROR: Forbidden resource', outcome: 'failed'});
    });

    test('a partial Core with FORBIDDEN on notifications still renders the rest; the key type comes from Me', async () => {

        const oCore = structuredClone(fixture('Core').body.data);

        oCore.notifications = null;

        const oBg = await setup({
            fetch: withOverrides({
                Core: () => respond(200, {
                    data: oCore,
                    errors: [{message: 'Forbidden resource', path: ['notifications'], extensions: {code: 'FORBIDDEN'}}]
                })
            })
        });
        const oResponse = await oBg.send({action: 'fetchDashboard', serverId: 'server-a'});

        expect(oResponse.error).toBeUndefined();
        expect(oResponse.keyType).toBe('admin');
        expect(oResponse.data.vars).toEqual(oCore.vars);
        expect(oResponse.data.metrics).toEqual(oCore.metrics);
        expect(oResponse.data.notifications).toBeNull();
        expect(oResponse.data.docker.containers.length).toBe(31);
    });

    test('a partial status answer with FORBIDDEN reports PERMISSION_DENIED, not success', async () => {

        const oBg = await setup({
            fetch: withOverrides({
                DockerStatus: () => respond(200, {
                    data: {docker: null},
                    errors: [{message: 'Forbidden resource', path: ['docker'], extensions: {code: 'FORBIDDEN'}}]
                })
            })
        });

        expect(await oBg.send({action: 'fetchStatus', serverId: 'server-a', kind: 'docker'})).toEqual({error: 'PERMISSION_DENIED'});
    });

    test.each([
        [500, 'UNAUTHENTICATED', /^AUTH_ERROR$/],
        [400, 'UNAUTHENTICATED', /^AUTH_ERROR$/],
        [400, 'FORBIDDEN', /^PERMISSION_DENIED$/],
        [500, 'FORBIDDEN', /^PERMISSION_DENIED$/],
        [500, 'INTERNAL_SERVER_ERROR', /^HTTP_500: boom$/]
    ])('HTTP %i with extensions.code %s is classified by the code', async (pStatus, pCode, pExpected) => {

        const oBg = await setup({fetch: () => respond(pStatus, {errors: [{message: 'boom', extensions: {code: pCode}}], data: null})});

        await expect(oBg.executeGraphQL('http://tower-a.lan', 'k', 'query Core { vars { name } }')).rejects.toThrow(pExpected);
    });

    test('HTTP 400 without an auth or permission code stays unsupported for mutations', async () => {

        const oBg = await setup({fetch: withOverrides({DockerPause: () => respondFixture('Validation_error')})});
        const oResult = await oBg.send({action: 'controlDocker', serverId: 'server-a', containerId: 'c1', command: 'pause'});

        expect(oResult.outcome).toBe('unsupported');
        expect(oResult.error).toStartWith('HTTP_400: Cannot query field');
    });

    test('a status query answered FORBIDDEN reports PERMISSION_DENIED', async () => {

        const oBg = await setup({fetch: withOverrides({DockerStatus: () => respondFixture('Mutation_viewer_forbidden')})});
        expect(await oBg.send({action: 'fetchStatus', serverId: 'server-a', kind: 'docker'})).toEqual({error: 'PERMISSION_DENIED'});
    });

    test.each([
        ['without data', () => respondFixture('Mutation_viewer_forbidden')],
        ['with partial data', () => respond(200, {
            data: {me: null}, errors: [{message: 'Forbidden resource', extensions: {code: 'FORBIDDEN'}}]
        })]
    ])('a FORBIDDEN Me answer %s means a read-only key', async (pName, pFetch) => {

        const oBg = await setup({fetch: withOverrides({Me: pFetch})});
        expect((await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).keyType).toBe('readonly');
    });

    test('a Me error without a code keeps the admin controls', async () => {

        const oBg = await setup({fetch: withOverrides({Me: () => gqlError('permission denied while reading roles')})});
        expect((await oBg.send({action: 'fetchDashboard', serverId: 'server-a'})).keyType).toBe('admin');
    });
});

describe('temperature summary (AC-67)', () => {

    const sensor = (pId, pValue, pUnit = 'CELSIUS', pStatus = 'NORMAL') => ({id: pId, current: {value: pValue, unit: pUnit, status: pStatus}});

    test('the captured sensor list gives avg 43, hottest 68, 4 warning', async () => {

        const oBg = await setup();
        const oSummary = oBg.summarizeTemperatures(fixture('TemperatureSensors').body.data.metrics.temperature.sensors).summary;

        expect(oSummary.average).toBeCloseTo(43.399375, 6);
        expect(oSummary.hottest.current).toEqual({value: 68.38, unit: 'CELSIUS'});
        expect([oSummary.warningCount, oSummary.criticalCount]).toEqual([4, 0]);
    });

    test('only temp<N>_input among lm-sensors keys, plus disk: and ipmi: ids, inside the range', async () => {

        const oBg = await setup();
        const oSummary = oBg.summarizeTemperatures([
            sensor('nct6687-isa-0a20:fan1:fan1_input', 1237, 'CELSIUS', 'CRITICAL'),
            sensor('nct6687-isa-0a20:VIN0:in0_input', 0.99),
            sensor('amdgpu-pci-1800:PPT:power1_input', 0.02),
            sensor('i915-pci-0400:energy1:energy1_input', 10857457.28, 'CELSIUS', 'CRITICAL'),
            sensor('nct6687-isa-0a20:SMBus 0:temp7_input', -63),
            sensor('k10temp-pci-00c3:CPU Temp:temp1_input', 60),
            sensor('disk:SERIAL01', 30, 'CELSIUS', 'WARNING'),
            sensor('ipmi:System Temp', 45, 'CELSIUS', 'CRITICAL')
        ]).summary;

        expect(oSummary).toEqual({average: 45, warningCount: 1, criticalCount: 1, hottest: {current: {value: 60, unit: 'CELSIUS'}}});
    });

    test('FAHRENHEIT readings use the -40..302 range', async () => {

        const oBg = await setup();
        const oSummary = oBg.summarizeTemperatures([
            sensor('disk:A', 302, 'FAHRENHEIT'),
            sensor('disk:B', 98, 'FAHRENHEIT'),
            sensor('disk:C', 303, 'FAHRENHEIT'),
            sensor('disk:D', -41, 'FAHRENHEIT')
        ]).summary;

        expect(oSummary.average).toBe(200);
        expect(oSummary.hottest.current).toEqual({value: 302, unit: 'FAHRENHEIT'});
    });

    test.each([
        ['mixed units', [sensor('disk:A', 40), sensor('disk:B', 100, 'FAHRENHEIT')]],
        ['another unit', [sensor('disk:A', 310, 'KELVIN')]],
        ['no temperature sensor', [sensor('nct:fan1:fan1_input', 900)]],
        ['no sensors', []],
        ['no data', null]
    ])('%s gives no summary (AC-46)', async (pName, pSensors) => {

        const oBg = await setup();
        expect(oBg.summarizeTemperatures(pSensors)).toBeNull();
    });
});

describe('VM restart coordinator (AC-70 to AC-72)', () => {

    const VM_ID = fixture('VMs').body.data.vms.domains[1].id;
    const KEY = 'server-a::' + VM_ID;
    const MINUTE = 60000;

    /**
     * Handler for one VM whose state the test controls; stop moves it to SHUTDOWN, start does not change it
     * @param {Object} pVm - {state}
     * @param {Object} [pOverrides] - {op: (request) => Response}
     * @returns {Function}
     */
    const vmHandler = (pVm, pOverrides = {}) => withOverrides({
        VMStatus: () => respond(200, {data: {vms: {domains: [{id: VM_ID, state: pVm.state}]}}}),
        VMStop: () => {

            pVm.state = 'SHUTDOWN';
            return respond(200, {data: {vm: {stop: true}}});
        },
        VMStart: () => respond(200, {data: {vm: {start: true}}}),
        ...pOverrides
    });

    /**
     * Background with one RUNNING VM, a restart already requested at pStartedAt
     * @param {Object} pVm - {state}
     * @param {Object} [pOverrides] - Handler overrides
     * @param {number} [pStartedAt] - Clock at the restart request
     * @returns {Promise<Object>} Harness
     */
    const restarted = async (pVm, pOverrides, pStartedAt = 1000) => {

        const oBg = await setup({fetch: vmHandler(pVm, pOverrides)});

        oBg.setNow(pStartedAt);
        await oBg.send({action: 'restartVM', serverId: 'server-a', vmId: VM_ID, name: 'vm-2'});

        return oBg;
    };

    /* The clock is fixed: a check only sees a phase that began before it, so tests move the clock between steps */
    const check = (pBg) => pBg.send({action: 'fetchStatus', serverId: 'server-a', kind: 'vm'});

    test('restartVM stores the record before vm.stop and starts the one-minute alarm', async () => {

        let oAtStop = null;
        const oBg = await setup({
            fetch: withOverrides({
                VMStop: () => {

                    oAtStop = structuredClone(oBg.storage.pendingRestarts);
                    return respond(200, {data: {vm: {stop: true}}});
                }
            })
        });

        oBg.setNow(1000);
        await oBg.send({action: 'restartVM', serverId: 'server-a', vmId: VM_ID, name: 'vm-2'});

        const oRecord = {serverId: 'server-a', vmId: VM_ID, name: 'vm-2', phase: 'stopping', phaseStartedAt: 1000, outcome: null};

        expect(oAtStop).toEqual({[KEY]: oRecord});
        expect(oBg.ops()).toEqual(['VMStop']);
        expect(oBg.alarms.vmRestart).toEqual({name: 'vmRestart', periodInMinutes: 1});
        expect(oBg.ops()).not.toContain('VMReboot');
    });

    test('a second request while the restart runs sends nothing', async () => {

        const oBg = await restarted({state: 'RUNNING'});
        const oResult = await oBg.send({action: 'restartVM', serverId: 'server-a', vmId: VM_ID, name: 'vm-2'});

        expect(oResult.record.phase).toBe('stopping');
        expect(oBg.ops()).toEqual(['VMStop']);
    });

    test('SHUTDOWN keeps stopping; SHUTOFF sends vm.start once even when popup checks and the alarm overlap', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        expect((await check(oBg)).restarts[VM_ID].phase).toBe('stopping');

        oVm.state = 'SHUTOFF';
        oBg.setNow(1000 + MINUTE);
        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await Promise.all([check(oBg), check(oBg)]);
        await waitFor(() => oBg.ops().filter((pOp) => pOp === 'VMStatus').length === 4);
        await new Promise((pFnResolve) => setTimeout(pFnResolve, 50));

        expect(oBg.ops().filter((pOp) => pOp === 'VMStart')).toEqual(['VMStart']);
        expect(oBg.storage.pendingRestarts[KEY]).toMatchObject({phase: 'starting', phaseStartedAt: 1000 + MINUTE});
    });

    test('a status answer sent before the phase changed does not end a starting restart (NP-501)', async () => {

        const oVm = {state: 'RUNNING'};
        let fnAnswerStale = null;
        let nStatusCalls = 0;
        const oBg = await restarted(oVm, {
            VMStatus: () => {

                nStatusCalls++;

                if (nStatusCalls === 1) {
                    return new Promise((pFnResolve) => {
                        fnAnswerStale = () => pFnResolve(respond(200, {data: {vms: {domains: [{id: VM_ID, state: 'RUNNING'}]}}}));
                    });
                }

                return respond(200, {data: {vms: {domains: [{id: VM_ID, state: oVm.state}]}}});
            }
        });

        oBg.setNow(2000);
        const pStale = check(oBg);
        await waitFor(() => fnAnswerStale);

        oVm.state = 'SHUTOFF';
        oBg.setNow(3000);
        expect((await check(oBg)).restarts[VM_ID]).toMatchObject({phase: 'starting', phaseStartedAt: 3000});

        fnAnswerStale();

        expect((await pStale).restarts[VM_ID].phase).toBe('starting');
        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('starting');
        expect(oBg.ops().filter((pOp) => pOp === 'VMStart')).toEqual(['VMStart']);
    });

    test('a stale answer from the same millisecond as the phase change is ignored, so a failed start stays recorded', async () => {

        const oVm = {state: 'RUNNING'};
        let nStatusCalls = 0;
        let fnAnswerStale = null;
        let fnAnswerStart = null;
        const oBg = await restarted(oVm, {
            VMStatus: () => {

                nStatusCalls++;

                if (nStatusCalls === 1) {
                    return new Promise((pFnResolve) => {
                        fnAnswerStale = () => pFnResolve(respond(200, {data: {vms: {domains: [{id: VM_ID, state: 'RUNNING'}]}}}));
                    });
                }

                return respond(200, {data: {vms: {domains: [{id: VM_ID, state: oVm.state}]}}});
            },
            VMStart: () => new Promise((pFnResolve) => {
                fnAnswerStart = () => pFnResolve(gqlError('internal error: process exited while connecting to monitor'));
            })
        });

        oBg.setNow(2000);
        const pStale = check(oBg);
        await waitFor(() => fnAnswerStale);

        oVm.state = 'SHUTOFF';
        const pStarting = check(oBg);
        await waitFor(() => fnAnswerStart);
        expect(oBg.storage.pendingRestarts[KEY]).toMatchObject({phase: 'starting', phaseStartedAt: 2000});

        fnAnswerStale();
        await pStale;
        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('starting');

        fnAnswerStart();
        await pStarting;
        expect(oBg.storage.pendingRestarts[KEY]).toMatchObject({
            phase: 'done',
            outcome: {result: 'failed', error: 'GQL_ERROR: internal error: process exited while connecting to monitor'}
        });
    });

    test('RUNNING while starting ends the restart and stops the alarm', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        oVm.state = 'SHUTOFF';
        oBg.setNow(2000);
        await check(oBg);
        oVm.state = 'RUNNING';
        oBg.setNow(3000);
        const oResponse = await check(oBg);

        expect(oResponse.restarts).toEqual({});
        expect(oBg.storage.pendingRestarts).toEqual({});
        expect(oBg.alarms.vmRestart).toBeUndefined();
    });

    test.each([
        ['stop', 'a GraphQL error', {VMStop: () => gqlError('Requested operation is not valid: domain is not running')},
            'GQL_ERROR: Requested operation is not valid: domain is not running'],
        ['stop', 'false', {VMStop: () => respond(200, {data: {vm: {stop: false}}})}, 'The server did not accept the command.'],
        ['start', 'a GraphQL error', {VMStart: () => gqlError('internal error: process exited while connecting to monitor')},
            'GQL_ERROR: internal error: process exited while connecting to monitor'],
        ['start', 'false', {VMStart: () => respond(200, {data: {vm: {start: false}}})}, 'The server did not accept the command.']
    ])('%s answered with %s ends the restart as failed', async (pStep, pName, pOverrides, pError) => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm, pOverrides);

        if (pStep === 'start') {
            oVm.state = 'SHUTOFF';
            oBg.setNow(2000);
            await check(oBg);
        }

        const oRecord = (await check(oBg)).restarts[VM_ID];

        expect(oRecord).toMatchObject({phase: 'done', outcome: {result: 'failed', error: pError}});
        expect(oBg.ops().filter((pOp) => pOp === 'VMStart').length).toBe(pStep === 'start' ? 1 : 0);
        expect(oBg.alarms.vmRestart).toBeUndefined();
    });

    test('no answer to vm.stop is not a failure', async () => {

        const oBg = await restarted({state: 'RUNNING'}, {
            VMStop: () => {
                throw new DOMException('signal timed out', 'TimeoutError');
            }
        });

        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('stopping');
    });

    test('stopping past 5 minutes without SHUTOFF ends as did-not-shut-down and sends nothing more', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        oVm.state = 'SHUTDOWN';
        oBg.setNow(1000 + 5 * MINUTE);
        const oRecord = (await check(oBg)).restarts[VM_ID];

        expect(oRecord).toMatchObject({phase: 'done', outcome: {result: 'failed', error: 'the VM did not shut down'}});
        expect(oBg.ops()).not.toContain('VMStart');
    });

    test('a late check starts a VM that is already SHUTOFF instead of expiring it', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        oVm.state = 'SHUTOFF';
        oBg.setNow(1000 + 9 * MINUTE);
        expect((await check(oBg)).restarts[VM_ID].phase).toBe('starting');
        expect(oBg.ops()).toContain('VMStart');
    });

    test('starting past 5 minutes without RUNNING ends as unknown', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        oVm.state = 'SHUTOFF';
        oBg.setNow(2000);
        await check(oBg);
        oBg.setNow(2000 + 5 * MINUTE);

        expect((await check(oBg)).restarts[VM_ID]).toMatchObject({phase: 'done', outcome: {result: 'unknown'}});
    });

    test('the alarm finishes a restart without the popup', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm);

        oVm.state = 'SHUTOFF';
        oBg.setNow(2000);
        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await waitFor(() => oBg.storage.pendingRestarts[KEY]?.phase === 'starting' && oBg.ops().includes('VMStart'));

        oVm.state = 'RUNNING';
        oBg.setNow(3000);
        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await waitFor(() => !oBg.storage.pendingRestarts[KEY] && !oBg.alarms.vmRestart);
    });

    test('a partial VMStatus with FORBIDDEN is no current state for the coordinator', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm, {
            VMStatus: () => respond(200, {
                data: {vms: {domains: [{id: VM_ID, state: 'SHUTOFF'}]}},
                errors: [{message: 'Forbidden resource', path: ['vms', 'domains', 0], extensions: {code: 'FORBIDDEN'}}]
            })
        });

        oBg.setNow(1000 + 10 * MINUTE);
        expect(await check(oBg)).toEqual({error: 'PERMISSION_DENIED'});
        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await waitFor(() => oBg.ops().filter((pOp) => pOp === 'VMStatus').length === 2);
        await new Promise((pFnResolve) => setTimeout(pFnResolve, 50));

        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('stopping');
        expect(oBg.ops()).not.toContain('VMStart');
    });

    test('without a current state the alarm applies no limit', async () => {

        const oVm = {state: 'RUNNING'};
        const oBg = await restarted(oVm, {
            VMStatus: () => {
                throw new TypeError('Failed to fetch');
            }
        });

        oBg.setNow(1000 + 10 * MINUTE);
        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await waitFor(() => oBg.ops().includes('VMStatus'));
        await new Promise((pFnResolve) => setTimeout(pFnResolve, 50));

        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('stopping');
    });

    test('a finished record stays until the popup clears it, and only finished records can be cleared', async () => {

        const oBg = await restarted({state: 'RUNNING'}, {VMStop: () => respond(200, {data: {vm: {stop: false}}})});

        await oBg.send({action: 'restartVM', serverId: 'server-a', vmId: 'other', name: 'other'});
        expect(oBg.storage.pendingRestarts[KEY].phase).toBe('done');

        await oBg.send({action: 'clearVMRestart', serverId: 'server-a', vmId: VM_ID});
        await oBg.send({action: 'clearVMRestart', serverId: 'server-a', vmId: 'other'});

        expect(Object.keys(oBg.storage.pendingRestarts)).toEqual([]);
        expect(oBg.ops()).toEqual(['VMStop', 'VMStop']);
    });

    test('loading with a restart in progress re-creates the alarm (browser restart)', async () => {

        const oRecord = {serverId: 'server-a', vmId: VM_ID, name: 'vm-2', phase: 'starting', phaseStartedAt: 1, outcome: null};
        const oBg = await setup({extra: {pendingRestarts: {[KEY]: oRecord}}});

        await waitFor(() => oBg.alarms.vmRestart);
        expect(oBg.alarms.vmRestart.periodInMinutes).toBe(1);
    });

    test('restarts of a deleted server are dropped by the alarm', async () => {

        const oRecord = {serverId: 'gone', vmId: VM_ID, name: 'vm-2', phase: 'stopping', phaseStartedAt: 1, outcome: null};
        const oBg = await setup({extra: {pendingRestarts: {['gone::' + VM_ID]: oRecord}}});

        oBg.listeners.alarm[0]({name: 'vmRestart'});
        await waitFor(() => Object.keys(oBg.storage.pendingRestarts || {}).length === 0 && !oBg.alarms.vmRestart);
        expect(oBg.ops()).toEqual([]);
    });
});
