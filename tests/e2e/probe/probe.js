/* Test-only page added to the test build: storage seeding, badge reads, permission checks */
const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/**
 * Stores servers the way the popup does: AES-GCM encrypted API keys plus the raw key in _ek
 * @param {Object[]} pServers - [{id, name, url, apiKey, enabled}]
 * @param {Object} pSettings - Settings object merged over the popup defaults
 * @param {Object} [pExtra] - Additional storage keys
 */
const seed = async (pServers, pSettings, pExtra) => {

    const oKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const aRaw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', oKey)));
    const oEncKeys = {};

    for (const oServer of pServers) {

        const aIv = crypto.getRandomValues(new Uint8Array(12));
        const aData = await crypto.subtle.encrypt({name: 'AES-GCM', iv: aIv}, oKey, new TextEncoder().encode(oServer.apiKey));
        oEncKeys[oServer.id] = {iv: Array.from(aIv), data: Array.from(new Uint8Array(aData))};
    }

    await browserAPI.storage.local.clear();
    await browserAPI.storage.local.set({
        _ek: aRaw,
        servers: pServers.map(({apiKey, ...pRest}) => pRest),
        encryptedKeys: oEncKeys,
        settings: pSettings,
        ...(pExtra || {})
    });

    return true;
};

/**
 * Decrypts the stored API keys so tests can compare them
 * @returns {Object} {serverId: apiKey}
 */
const storedKeys = async () => {

    const oStore = await browserAPI.storage.local.get(['_ek', 'encryptedKeys']);
    const oResult = {};

    if (!oStore._ek) {
        return oResult;
    }

    const oKey = await crypto.subtle.importKey('raw', new Uint8Array(oStore._ek), 'AES-GCM', false, ['decrypt']);

    for (const [sId, oEnc] of Object.entries(oStore.encryptedKeys || {})) {

        const aPlain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(oEnc.iv)}, oKey, new Uint8Array(oEnc.data));
        oResult[sId] = new TextDecoder().decode(aPlain);
    }

    return oResult;
};

window.probe = {
    seed,
    storedKeys,
    clear: () => Promise.all([browserAPI.storage.local.clear(), browserAPI.storage.session.clear()]),
    clearBadge: () => browserAPI.action.setBadgeText({text: ''}),
    get: (pKeys) => browserAPI.storage.local.get(pKeys),
    badge: () => browserAPI.action.getBadgeText({}),
    alarm: (pName) => browserAPI.alarms.get(pName).then((pAlarm) => pAlarm || null),
    fireAlarm: (pName) => Promise.resolve(browserAPI.alarms.create(pName, {when: Date.now() + 100})),
    contains: (pOrigin) => browserAPI.permissions.contains({origins: [pOrigin]}),
    origins: () => browserAPI.permissions.getAll().then((pPermissions) => pPermissions.origins),
    revoke: (pOrigins) => browserAPI.permissions.remove({origins: pOrigins}),
    send: (pMessage) => browserAPI.runtime.sendMessage(pMessage),
    request: (pOrigin) => browserAPI.permissions.request({origins: [pOrigin]})
};

document.getElementById('grant').addEventListener('click', () => {

    const oOut = document.getElementById('result');

    browserAPI.permissions.request({origins: [document.getElementById('origin').value]}).then(
        (pGranted) => { oOut.textContent = 'granted:' + pGranted; },
        (pErr) => { oOut.textContent = 'error:' + pErr.message; }
    );
});
