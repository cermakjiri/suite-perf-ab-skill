/**
 * emulator-history-load — in-page part. A full transaction-history load on a real device with real
 * data: trezor-user-env's emulator (wiped and seeded per session by run.mjs, default seed
 * "all all … all"), Suite's own connect → authorize → discovery through the bridge, live backends
 * (run.json network: live). The seed is settings only, as in examples/emulator-accounts.
 *
 * postInit remembers the device (only remembered devices persist anything), then the measured
 * iteration dispatches the REAL fetchAllTransactionsForAccountThunk for the account with the most
 * history (at most cfg.maxTxs) and pages it through the live backend, fiat rates included:
 *
 *   load   dispatch -> the thunk settles (every page in Redux)
 *   drain  -> IndexedDB holds the account's rows (as many as Redux) and a historicRates row with
 *             every rate the live rate map has for its transactions, plus 300 ms of quiet
 *
 * One load per session: a second load of the same account pages by 5 (Suite marks it fully loaded)
 * and finds its fiat rates already in the global map, so `valid` drops anything but a first load.
 */
(() => {
    const H = window.__H;
    const CFG = Object.assign({ networks: ['btc'], maxTxs: 1000, remember: true, countIdb: false, stableMs: 3000, persistTimeoutMs: 120000, ratesTimeoutMs: 20000 }, H.CFG);
    const st = () => H.state();
    const dispatch = a => H.dispatch(a);
    const { sleep } = H;
    const t0 = performance.now();

    const settingsPayload = () => ({
        supportedNetworks: CFG.networks,
        suiteSettings: {
            settings: { language: 'en-US', theme: { variant: 'light' }, autodetect: { language: false, theme: false } },
            flags: { initialRun: false, discreetModeCompleted: true, securityStepsHidden: true },
            evmSettings: undefined, seenDisconnectNotificationForDeviceIds: [],
        },
        devices: [], thp: undefined, bluetooth: undefined, accounts: [], walletSettings: { enabledNetworks: CFG.networks },
        tradingTrades: [], historicRates: [], graph: [], analytics: { enabled: false, confirmed: true, instanceId: 'perf', sessionId: 'perf', sessionStart: 1 },
        metadata: undefined, txs: [], phishing: [], phishingMetadata: undefined, messageSystem: undefined, backendSettings: [], sendFormDrafts: [], receive: [],
        formDrafts: [], coinjoinAccounts: [], coinjoinDebugSettings: undefined, tokenManagement: [], stellarContractTokens: [], persistentDeviceData: [], connect: undefined, explorer: [],
        bioAuth: undefined, firmware: undefined, suiteSyncSettings: undefined, suiteSyncOwners: [], suiteSyncQuotaManager: undefined, featureFeedback: undefined,
        discreetMode: { isActive: false }, debug: undefined, earnOnboarding: [],
    });

    // accounts with history the load can page through in a session, the most history first
    const candidates = () => st().wallet.accounts
        .filter(a => CFG.networks.includes(a.symbol) && a.history && a.history.total > 0 && a.history.total <= CFG.maxTxs)
        .sort((x, y) => y.history.total - x.history.total);
    const label = a => `${a.symbol}/${a.accountType}/${a.index}`;
    const txsOf = acc => ((st().wallet.transactions.transactions || {})[acc.key] || []).filter(Boolean);
    const fullyLoaded = acc => {
        const f = (st().wallet.transactions.fetchStatusDetail || {})[acc.key];

        return !!(f && f.areAllTransactionsLoaded);
    };
    // what selectHistoricRatesByTransactions (suite-common/wallet-utils fiatRatesUtils) puts in the
    // account's row from the global map right now: per rate key, the rounded hours of its transactions
    const expectedRatePoints = acc => {
        const historic = (st().wallet.fiat && st().wallet.fiat.historic) || {};
        const keys = Object.keys(historic);
        const hours = {};
        for (const tx of txsOf(acc)) {
            const ts = Math.floor((tx.blockTime || 0) / 3600) * 3600;
            for (const k of keys) {
                const matches = k.startsWith(tx.symbol) || (tx.tokens || []).some(t => k.startsWith(`[${tx.symbol}-${t.contract}]`));
                if (matches && historic[k] && historic[k][ts]) (hours[k] = hours[k] || new Set()).add(ts);
            }
        }

        return Object.values(hours).reduce((s, set) => s + set.size, 0);
    };

    // ------------------------------------------------------------ IndexedDB operation counts
    // counting pass only (cfg.countIdb): patched prototypes tax every IDB call — never in a timing pass
    const IDBC = { on: false, put: {}, add: {}, del: {}, cursorDel: {}, rwTx: {} };
    let probeDb = null;
    if (CFG.countIdb) {
        const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
        const OS = IDBObjectStore.prototype;
        for (const [m, bucket] of [['put', 'put'], ['add', 'add'], ['delete', 'del']]) {
            const orig = OS[m];
            OS[m] = function (...a) { if (IDBC.on) inc(IDBC[bucket], this.name); return orig.apply(this, a); };
        }
        const cdel = IDBCursor.prototype.delete;
        IDBCursor.prototype.delete = function () {
            if (IDBC.on) { const s = this.source; inc(IDBC.cursorDel, s.objectStore ? s.objectStore.name : s.name); }

            return cdel.call(this);
        };
        const tr = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
            if (IDBC.on && this !== probeDb && mode === 'readwrite') {
                for (const n of typeof names === 'string' ? [names] : Array.from(names)) inc(IDBC.rwTx, n);
            }

            return tr.call(this, names, mode, ...rest);
        };
    }

    // ------------------------------------------------------------ IndexedDB probe (own connection)
    // A readonly transaction is scheduled after every earlier readwrite transaction on an overlapping
    // scope, so a count is a consistent snapshot. Poll sequentially: one pending request at a time.
    const openProbe = () => new Promise((res, rej) => {
        const r = indexedDB.open('trezor-suite');
        r.onsuccess = () => { probeDb = r.result; probeDb.onversionchange = () => probeDb.close(); res(probeDb); };
        r.onerror = () => rej(r.error);
    });
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const keyOf = acc => IDBKeyRange.only([acc.descriptor, acc.symbol, acc.deviceState]);
    const idbCount = async acc => {
        if (!probeDb) await openProbe();

        return req(probeDb.transaction('txs', 'readonly').objectStore('txs').index('accountKey').count(keyOf(acc)));
    };
    const idbRatePoints = async acc => {
        if (!probeDb) await openProbe();
        const rates = await req(probeDb.transaction('historicRates', 'readonly').objectStore('historicRates').get(acc.key));

        return rates ? Object.values(rates).reduce((s, v) => s + (v && typeof v === 'object' ? Object.keys(v).length : 1), 0) : 0;
    };
    const idbSnapshot = async acc => {
        if (!probeDb) await openProbe();
        const rows = await req(probeDb.transaction('txs', 'readonly').objectStore('txs').index('accountKey').getAll(keyOf(acc)));
        const orders = rows.map(r => r.order).sort((a, b) => a - b);
        const red = (st().wallet.transactions.transactions || {})[acc.key] || [];
        let matchesRedux = rows.length === red.filter(Boolean).length;
        if (matchesRedux) for (const r of rows) if (!red[r.order] || red[r.order].txid !== r.tx.txid) { matchesRedux = false; break; }

        return { rows: rows.length, contiguous: orders.every((o, k) => o === k), matchesRedux };
    };
    // until fn() (async) is true or the time is up; one call at a time
    const until = async (fn, timeoutMs) => {
        const start = performance.now();
        for (;;) {
            if (await fn()) return true;
            if (performance.now() - start > timeoutMs) return false;
            await sleep(25);
        }
    };

    let stable = { count: -1, since: 0 };
    let readyAt = null;
    let fetchAll = null;
    let targetKey = null;
    let cur = null;
    const target = () => st().wallet.accounts.find(a => a.key === targetKey);

    window.__A = {
        name: 'emulator-history-load',
        ready: () => !!H.store(),

        async seed() {
            dispatch({ type: '@storage/load', payload: settingsPayload() });
            for (const t of ['suiteSettings/toggleFirmwareHashCheck', 'suiteSettings/toggleFirmwareRevisionCheck', 'suiteSettings/toggleDeviceAuthenticityCheck']) dispatch({ type: t, payload: false });

            return { networks: CFG.networks, maxTxs: CFG.maxTxs };
        },

        // Suite up, the emulator acquired and authorized, discovery finished, an account to load
        isReady() {
            if (!H.suiteReady()) return false;
            const d = st().device.selectedDevice;
            if (!d || !d.connected || d.type !== 'acquired' || !d.state) return false;
            const n = st().wallet.accounts.length;
            const now = performance.now();
            if (n !== stable.count) stable = { count: n, since: now };
            const disc = Object.values(st().wallet.discovery || {});
            const complete = disc.length > 0 && disc.every(x => x.status === 'complete');
            const done = n > 0 && candidates().length > 0 && (complete || now - stable.since > CFG.stableMs);
            if (done && readyAt === null) readyAt = now;

            return done;
        },

        async postInit() {
            const d = st().device.selectedDevice;
            const acc = candidates()[0];
            targetKey = acc.key;
            fetchAll = H.findThunk('@common/wallet-core/transactions/fetchAllTransactionsForAccount');
            // web bundles export it; desktop bundles keep it module-internal
            if (!fetchAll) throw new Error('fetchAllTransactionsForAccountThunk not found in the bundle — emulator-history-load runs on web only');
            await openProbe();
            // remembering saves the device, its accounts and their first pages: wait for the target's rows
            if (CFG.remember) dispatch({ type: '@suite/device/setRememberDevice', payload: { device: d, remember: true } });
            const firstPage = txsOf(acc).length;
            const saved = CFG.remember ? await until(async () => (await idbCount(acc)) === firstPage, 20000) : null;
            await H.settle(500);
            const disc = Object.values(st().wallet.discovery || {});

            return {
                device: d && d.features && d.features.internal_model,
                firmware: d && d.features && [d.features.major_version, d.features.minor_version, d.features.patch_version].join('.'),
                remembered: (st().device.devices || []).some(x => x.remember),
                accounts: st().wallet.accounts.length,
                withHistory: st().wallet.accounts.filter(a => CFG.networks.includes(a.symbol) && a.history && a.history.total > 0).map(a => `${label(a)}:${a.history.total}`),
                target: `${label(acc)}:${acc.history.total}`,
                firstPage,
                firstPageSaved: saved,
                rateKeys: Object.keys((st().wallet.fiat && st().wallet.fiat.historic) || {}).length,
                discovery: disc.map(x => ({ status: x.status, loaded: x.loaded, total: x.total })),
                readyMs: readyAt === null ? null : Math.round(readyAt - t0),
            };
        },

        phases: {
            async load() {
                const acc = target();
                if (!acc) throw new Error('target account gone');
                const firstLoad = !fullyLoaded(acc);
                const txsBefore = txsOf(acc).length;
                const pre = await idbCount(acc);
                if (CFG.countIdb) { for (const k of ['put', 'add', 'del', 'cursorDel', 'rwTx']) IDBC[k] = {}; IDBC.on = true; }
                let loadError = null;
                try {
                    const res = await dispatch(fetchAll({ accountKey: acc.key }));
                    if (res && res.error) loadError = String(res.error.message || res.error);
                } catch (e) {
                    loadError = String(e);
                }
                cur = { acc, tLoaded: performance.now() };

                return { firstLoad: firstLoad ? 1 : 0, historyTotal: acc.history.total, txsBefore, txs: txsOf(acc).length, pre, loadError };
            },
            async drain() {
                const { acc, tLoaded } = cur;
                const expected = CFG.remember ? txsOf(acc).length : 0;
                let rows = -1;
                let polls = 0;
                await until(async () => { rows = await idbCount(acc); polls += 1; return rows === expected; }, CFG.persistTimeoutMs);
                const persistMs = +(performance.now() - tLoaded).toFixed(1);
                // the live rate map can still be filling: compare against what it holds at each poll
                let ratePoints = -1;
                let expectedRates = -1;
                await until(async () => {
                    ratePoints = await idbRatePoints(acc);
                    expectedRates = CFG.remember ? expectedRatePoints(acc) : 0;
                    polls += 1;

                    return ratePoints === expectedRates;
                }, CFG.ratesTimeoutMs);
                const ratesMs = +(performance.now() - tLoaded).toFixed(1);
                await sleep(300);
                if (CFG.countIdb) IDBC.on = false;

                return {
                    expected, rows, polls, persisted: rows === expected, persistMs,
                    expectedRates, ratePoints, ratesComplete: ratePoints === expectedRates ? 1 : 0, ratesMs,
                    counts: CFG.countIdb ? JSON.parse(JSON.stringify(IDBC)) : undefined,
                };
            },
        },

        // what a restart would load against what Redux holds; nothing to reset: one load per session
        async after() {
            const acc = target();

            return acc ? { snap: await idbSnapshot(acc) } : null;
        },

        verify() {
            const d = st().device.selectedDevice;

            return { device: d && d.features && d.features.internal_model, connected: !!(d && d.connected), remembered: (st().device.devices || []).some(x => x.remember), accounts: st().wallet.accounts.length, route: H.routeName() };
        },
    };
})();
