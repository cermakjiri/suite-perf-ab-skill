/**
 * history-load — in-page part. Worked example of a scenario, ported from the PR #33320 A/B
 * (storageMiddleware coalescing per-page IndexedDB rewrites).
 *
 * One iteration = one full transaction-history load of a remembered wallet's BTC account: the REAL
 * fetchAllTransactionsForAccountThunk (found in the bundle by its type prefix) pages through
 * TrezorConnect.getAccountInfo, replaced by a deterministic backend: `pages` pages of 25 synthetic
 * transactions, each answered after `latency` ms. Historic fiat rates for every page answer after
 * `rateLatency` ms, so both persisted paths (txs rows, the historicRates row) run.
 *
 *   load   dispatch -> the thunk settles (all pages in Redux): what the user waits for
 *   drain  -> every row of the account is in IndexedDB, plus 300 ms of quiet
 *
 * Every iteration loads a different, never-loaded account: after a completed fetchAll Suite marks
 * the account areAllTransactionsLoaded and a reload would page by 5 — a different workload.
 * Synthetic state, byte-identical on both sides; real IndexedDB, real persistence.
 */
(() => {
    const H = window.__H;
    const CFG = Object.assign({ remember: true, countIdb: false, pages: 20, latency: 100, rateLatency: 40, timeoutMs: 240000 }, H.CFG);
    const RUN = H.RUN;
    // one per iteration, plus spares for iterations the runner discards and retries with fresh data
    const TARGETS = (RUN.iterations || 16) + (RUN.spares || 0) + 1;
    const DS = '1stTestnetAddress@device_id:0';
    const TX_PER_PAGE = 25;
    const st = () => H.state();
    const dispatch = a => H.dispatch(a);
    const { sleep, settle } = H;

    const features = {
        vendor: 'trezor.io', major_version: 2, minor_version: 8, patch_version: 7,
        bootloader_mode: null, device_id: 'device_id', pin_protection: true,
        passphrase_protection: false, language: 'en-US', label: 'Perf Trezor',
        initialized: true, revision: 'df0963ec', bootloader_hash: null, imported: null,
        unlocked: true, firmware_present: null, backup_availability: 'NotAvailable', flags: 0,
        model: 'T', internal_model: 'T2T1', fw_major: null, fw_minor: null, fw_patch: null,
        fw_vendor: null, unfinished_backup: false, no_backup: false, recovery_status: 'Nothing',
        capabilities: ['Capability_Bitcoin', 'Capability_Bitcoin_like', 'Capability_Binance',
            'Capability_Cardano', 'Capability_Crypto', 'Capability_EOS', 'Capability_Ethereum',
            'Capability_Monero', 'Capability_NEM', 'Capability_Ripple', 'Capability_Stellar',
            'Capability_Tezos', 'Capability_U2F', 'Capability_Shamir', 'Capability_ShamirGroups',
            'Capability_PassphraseEntry', 'Capability_Solana', 'Capability_Translations'],
        backup_type: 'Bip39', sd_card_present: false, sd_protection: false,
        wipe_code_protection: false, session_id: 'session_id',
        passphrase_always_on_device: false, safety_checks: 'Strict',
        auto_lock_delay_ms: 60000, display_rotation: 'North', experimental_features: false,
    };
    const device = {
        descriptor: { apiType: 'usb', id: 'device_id' },
        id: 'device_id', path: '', label: 'Perf Trezor', firmware: 'valid',
        status: 'available', mode: 'normal', type: 'acquired',
        state: { staticSessionId: DS, sessionId: 'session_id', useEmptyPassphrase: true },
        features, unavailableCapabilities: {}, firmwareType: 'Universal',
        name: 'Trezor Model T', availableTranslations: [], useEmptyPassphrase: true,
        remember: !!CFG.remember, connected: false, available: false, instance: undefined, ts: 1,
        buttonRequests: [], metadata: { status: 'disabled' },
        authenticityChecks: { firmwareRevision: { success: true }, firmwareHash: { success: true } },
        error: undefined, passwords: {},
    };

    const RATES = { btc: 61000, eth: 3100, ltc: 85 };
    // An account key is `${descriptor}-${symbol}-${deviceState}`: no dashes in the parts.
    const descriptorOf = (symbol, accountType, i) => symbol + accountType + 'xpubDESCRIPTOR' + String(i).padStart(4, '0');
    const addr = (tag, i) => ('bc1q' + tag + String(i).padStart(6, '0') + 'perfaddressxxxxxxxxxxxxxxx').slice(0, 42);
    const hex = (prefix, i, len) => (prefix + String(i).padStart(len - prefix.length, '0')).slice(0, len);

    const mkAccount = (symbol, networkType, accountType, pathPrefix, i, txTotal) => {
        const d = descriptorOf(symbol, accountType, i);
        const b = 100000 + i * 137;
        const path = pathPrefix + i + "'";

        return {
            deviceState: DS, key: d + '-' + symbol + '-' + DS, index: i, path,
            descriptor: d, accountType, symbol, empty: false, visible: true,
            balance: String(b * 1000), availableBalance: String(b * 1000),
            formattedBalance: ((b * 1000) / 1e8).toFixed(8),
            tokens: [], utxo: [],
            addresses: networkType === 'bitcoin' ? {
                change: [{ address: addr('chg', i), path: path + '/1/0', transfers: 3 }],
                used: [{ address: addr('rcv', i), path: path + '/0/0', transfers: 4 }],
                unused: [{ address: addr('new', i), path: path + '/0/1', transfers: 0 }],
            } : undefined,
            history: { total: txTotal, unconfirmed: 0, tokens: 0 },
            metadata: { key: d },
            page: { index: 1, size: TX_PER_PAGE, total: Math.max(1, Math.ceil(txTotal / TX_PER_PAGE)) },
            marker: undefined, stellarCursor: undefined,
            misc: networkType === 'ethereum' ? { nonce: '3' } : undefined,
            networkType, accountLabel: undefined,
        };
    };
    // targets: BTC native segwit accounts 0..TARGETS-1, each loaded once; plus a few unrelated ones
    const makeAccounts = () => {
        const total = CFG.pages * TX_PER_PAGE;
        const out = [];
        for (let i = 0; i < TARGETS; i++) out.push(mkAccount('btc', 'bitcoin', 'normal', "m/84'/0'/", i, total));
        out.push(mkAccount('btc', 'bitcoin', 'segwit', "m/49'/0'/", 0, 4));
        out.push(mkAccount('eth', 'ethereum', 'normal', "m/44'/60'/0'/0/", 0, 6));
        out.push(mkAccount('ltc', 'bitcoin', 'normal', "m/84'/2'/", 0, 5));

        return out;
    };
    // Every account has hours of its own (one transaction per hour, one block of hours per account).
    // Suite keeps historic fiat rates in one map keyed by the rounded hour: with timestamps shared
    // between accounts, every load after the first finds its rates fetched by an earlier load, and the
    // map never grows. 12 h apart, 25 targets x 1,000 transactions would reach back before 2009.
    const HOUR = 3600;
    const T0 = 1759000000 - (1759000000 % HOUR);
    const blockTimeOf = (acc, i) => T0 - (acc * CFG.pages * TX_PER_PAGE + i) * HOUR;
    // a realistic BTC transaction as connect returns it: 2 inputs, 2 outputs, ~1.3 KB of JSON
    const mkTx = (acc, i) => {
        const recv = i % 3 !== 0;
        const amount = 10000 + ((i * 7919) % 900000);
        const fee = 141 + (i % 50) * 3;
        const prevValue = amount + fee + 54321 + (i % 1000);
        const change = prevValue - amount - fee;
        const own = addr('rcv', acc);
        const other = addr('ext', i);
        const outOwn = recv ? [true, false] : [false, true];

        return {
            type: recv ? 'recv' : 'sent',
            txid: hex('a' + String(acc).padStart(3, '0') + 'f', i, 64),
            blockTime: blockTimeOf(acc, i),
            blockHeight: 915000 - i,
            blockHash: hex('00000000000000000001b', i, 64),
            lockTime: 914999 - i,
            amount: String(amount),
            fee: String(fee),
            totalSpent: String(recv ? amount : amount + fee),
            targets: [{ n: 0, addresses: [recv ? own : other], isAddress: true, amount: String(amount), isAccountTarget: recv ? true : undefined }],
            tokens: [], internalTransfers: [],
            rbf: false, feeRate: (fee / 141).toFixed(2), size: 222, vsize: 141,
            details: {
                vin: [
                    { txid: hex('b' + String(acc).padStart(3, '0') + 'e', i, 64), vout: 1, sequence: 4294967293, n: 0, addresses: [recv ? other : own], isAddress: true, isOwn: recv ? undefined : true, value: String(prevValue - 20000) },
                    { txid: hex('c' + String(acc).padStart(3, '0') + 'd', i, 64), vout: 0, sequence: 4294967293, n: 1, addresses: [recv ? other : own], isAddress: true, isOwn: recv ? undefined : true, value: '20000' },
                ],
                vout: [
                    { value: String(amount), n: 0, hex: '0014' + hex('d', i, 40), addresses: [recv ? own : other], isAddress: true, isOwn: outOwn[0] || undefined },
                    { value: String(change), n: 1, hex: '0014' + hex('e', i, 40), addresses: [recv ? other : addr('chg', acc)], isAddress: true, isOwn: outOwn[1] || undefined },
                ],
                size: 222, totalInput: String(prevValue), totalOutput: String(amount + change),
            },
        };
    };
    // balance history in the stored (formatted) shape, so the dashboard graph renders from the seed
    const mkGraph = accounts => accounts.map((a, idx) => {
        const now = new Date();
        const data = [];
        let balance = 0;
        for (let m = 11; m >= 0; m--) {
            const time = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1) / 1000;
            const received = ((idx % 5) + 1) * ((m % 3) + 1) * 0.02;
            const sent = m % 2 ? 0.01 * ((idx % 3) + 1) : 0;
            balance += received - sent;
            const rate = RATES[a.symbol] * (1 + 0.15 * Math.sin(m / 2));
            data.push({ time, txs: 1 + (m % 3), received: received.toFixed(8), sent: sent.toFixed(8), sentToSelf: '0', rates: { usd: rate, eur: rate * 0.92 }, balance: balance.toFixed(8) });
        }

        return { account: { descriptor: a.descriptor, deviceState: DS, symbol: a.symbol }, isLoading: false, error: false, data };
    });
    // Keys follow packages/suite/src/storage/loadStoragePayload.ts. supportedNetworks, earnOnboarding,
    // stellarContractTokens and language 'en-US' are required, or a storage-load reducer throws inside
    // createMiddleware's try/catch and the whole seed silently no-ops. Re-check against the
    // revisions under test: a new slice in the payload means a new key here.
    const basePayload = accounts => ({
        supportedNetworks: ['btc', 'ltc', 'eth'],
        suiteSettings: {
            settings: { language: 'en-US', theme: { variant: 'light' }, autodetect: { language: false, theme: false } },
            flags: { initialRun: false, discreetModeCompleted: true, securityStepsHidden: true },
            evmSettings: undefined, seenDisconnectNotificationForDeviceIds: [],
        },
        devices: [device], thp: undefined, bluetooth: undefined, accounts,
        walletSettings: { enabledNetworks: ['btc', 'eth', 'ltc'] },
        tradingTrades: [], historicRates: [], graph: mkGraph(accounts),
        analytics: { enabled: false, confirmed: true, instanceId: 'perf', sessionId: 'perf', sessionStart: 1 },
        metadata: undefined, txs: [], phishing: [], phishingMetadata: undefined,
        messageSystem: undefined, backendSettings: [], sendFormDrafts: [], receive: [],
        formDrafts: [], coinjoinAccounts: [], coinjoinDebugSettings: undefined,
        tokenManagement: [], stellarContractTokens: [], persistentDeviceData: [], connect: undefined, explorer: [],
        bioAuth: undefined, firmware: undefined, suiteSyncSettings: undefined,
        suiteSyncOwners: [], suiteSyncQuotaManager: undefined, featureFeedback: undefined,
        discreetMode: { isActive: false }, debug: undefined, earnOnboarding: [],
    });

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
    const resetCounts = () => { for (const k of ['put', 'add', 'del', 'cursorDel', 'rwTx']) IDBC[k] = {}; };

    // ------------------------------------------------------------ IndexedDB probe (own connection)
    // A readonly transaction is scheduled after every earlier readwrite transaction on an overlapping
    // scope, so a count is a consistent snapshot. Poll sequentially: one pending count at a time.
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
    const idbSnapshot = async acc => {
        if (!probeDb) await openProbe();
        const tx = probeDb.transaction(['txs', 'historicRates'], 'readonly');
        const rows = await req(tx.objectStore('txs').index('accountKey').getAll(keyOf(acc)));
        const rates = await req(tx.objectStore('historicRates').get(acc.key));
        const orders = rows.map(r => r.order).sort((a, b) => a - b);
        const contiguous = orders.every((o, k) => o === k);
        // what a restart would load (arr[order] = tx) against what Redux holds right now
        const red = (st().wallet.transactions.transactions || {})[acc.key] || [];
        let matchesRedux = rows.length === red.filter(Boolean).length;
        if (matchesRedux) for (const r of rows) if (!red[r.order] || red[r.order].txid !== r.tx.txid) { matchesRedux = false; break; }
        const ratePoints = rates ? Object.values(rates).reduce((s, v) => s + (v && typeof v === 'object' ? Object.keys(v).length : 1), 0) : 0;

        return { rows: rows.length, contiguous, matchesRedux, ratesRow: !!rates, ratePoints };
    };

    // ------------------------------------------------------------ backend replaced
    const calls = {};
    const count = name => { calls[name] = (calls[name] || 0) + 1; };
    const installConnectMocks = () => {
        const tc = H.connect();
        if (!tc || tc.__perfMocked) return Object.keys(calls);
        const targets = new Set(st().wallet.accounts.filter(a => a.symbol === 'btc' && a.accountType === 'normal').map(a => a.descriptor));
        tc.getAccountInfo = async params => {
            count('getAccountInfo');
            const acc = st().wallet.accounts.find(a => a.descriptor === params.descriptor);
            if (!acc || !targets.has(params.descriptor) || params.details !== 'txs') {
                count('getAccountInfo:other');

                return { success: false, payload: { error: 'perf: offline' } };
            }
            await sleep(CFG.latency);
            H.injectCost(); // the rig control: a known cost per page
            const page = params.page || 1;
            const size = params.pageSize || TX_PER_PAGE;
            const total = CFG.pages * TX_PER_PAGE;
            const from = (page - 1) * size;
            const transactions = [];
            for (let i = from; i < Math.min(from + size, total); i++) transactions.push(mkTx(acc.index, i));
            count('getAccountInfo:page');

            return {
                success: true,
                payload: {
                    descriptor: acc.descriptor, balance: acc.balance, availableBalance: acc.availableBalance, empty: false,
                    history: { total, unconfirmed: 0, transactions },
                    page: { index: page, size, total: Math.ceil(total / size) },
                    addresses: acc.addresses, utxo: [], tokens: [], misc: undefined,
                },
            };
        };
        tc.blockchainGetFiatRatesForTimestamps = async ({ timestamps, currencies }) => {
            count('fiatRatesForTimestamps');
            await sleep(CFG.rateLatency);
            const cur = (currencies && currencies[0]) || 'usd';

            return { success: true, payload: { tickers: timestamps.map(ts => ({ ts, rates: { [cur]: 60000 + (ts % 997) } })) } };
        };
        tc.blockchainGetCurrentFiatRates = async ({ currencies }) => {
            count('currentFiatRates');
            const cur = (currencies && currencies[0]) || 'usd';

            return { success: true, payload: { ts: Math.floor(Date.now() / 1000), rates: { [cur]: 61000 } } };
        };
        tc.blockchainGetAccountBalanceHistory = async () => { count('balanceHistory'); return { success: true, payload: [] }; };
        tc.__perfMocked = true;

        return ['getAccountInfo', 'blockchainGetFiatRatesForTimestamps', 'blockchainGetCurrentFiatRates', 'blockchainGetAccountBalanceHistory'];
    };
    // No WebUSB and no bridge: one synthetic transport-start clears the 'no-transport' screen;
    // removing connect's TRANSPORT_EVENT listeners keeps it cleared.
    let transportFrozen = false;
    const fakeTransport = () => {
        const tc = H.connect();
        if (!transportFrozen && tc && typeof tc.removeAllListeners === 'function') {
            tc.removeAllListeners('TRANSPORT_EVENT');
            transportFrozen = true;
        }
        const t = st().suite.transport;
        if (t && t.transports && t.transports.length) return false;
        dispatch({ type: 'transport-start', payload: { apiType: 'usb', type: 'BridgeTransport', version: '3.0.0' } });

        return true;
    };
    const seedRates = () => {
        const fiat = (st().wallet.settings && st().wallet.settings.localCurrency) || 'usd';
        const tickers = Object.keys(RATES).map(symbol => ({ symbol }));
        dispatch({
            type: '@common/wallet-core/fiat-rates/updateFiatRates/fulfilled',
            payload: tickers.map(t => ({ status: 'fulfilled', value: { ticker: t, rate: RATES[t.symbol], lastTickerTimestamp: Math.floor(Date.now() / 1000) } })),
            meta: { arg: { tickers, baseCurrencyCode: fiat, rateType: 'current', fetchAttemptTimestamp: Date.now() }, requestId: 'perf', requestStatus: 'fulfilled' },
        });

        return Object.keys(st().wallet.fiat.current);
    };

    const targetAccount = n => st().wallet.accounts.find(a => a.symbol === 'btc' && a.accountType === 'normal' && a.index === n);
    const reduxTxs = acc => ((st().wallet.transactions.transactions || {})[acc.key] || []).filter(Boolean).length;
    let fetchAll = null;
    let cur = null;

    window.__A = {
        name: 'history-load',
        ready: () => !!H.store() && !!H.connect(),

        async seed() {
            const accounts = makeAccounts();
            dispatch({ type: '@storage/load', payload: basePayload(accounts) });
            dispatch({ type: '@suite/device/updateSelectedDevice', payload: device });
            await settle(200);

            return { accounts: st().wallet.accounts.length, targets: TARGETS, remember: device.remember };
        },

        async postInit() {
            fakeTransport();
            const mocks = installConnectMocks();
            const fiat = seedRates();
            fetchAll = H.findThunk('@common/wallet-core/transactions/fetchAllTransactionsForAccount');
            await settle(400);
            await openProbe();
            // web bundles export it; desktop bundles keep it module-internal (use a UI-driven scenario there)
            if (!fetchAll) throw new Error('fetchAllTransactionsForAccountThunk not found in the bundle — history-load runs on web only');

            return { mocks, fiat, thunk: !!fetchAll };
        },

        phases: {
            async load({ n }) {
                const acc = targetAccount(n);
                if (!acc) throw new Error('no target account ' + n);
                const pre = await idbCount(acc);
                const pagesBefore = calls['getAccountInfo:page'] || 0;
                if (CFG.countIdb) { resetCounts(); IDBC.on = true; }
                let loadError = null;
                try {
                    const res = await dispatch(fetchAll({ accountKey: acc.key }));
                    if (res && res.error) loadError = String(res.error.message || res.error);
                } catch (e) {
                    loadError = String(e);
                }
                cur = { acc, tLoaded: performance.now() };

                return { pre, loadError, pages: (calls['getAccountInfo:page'] || 0) - pagesBefore };
            },
            async drain() {
                const { acc, tLoaded } = cur;
                // a device that is not remembered persists no transaction rows on either side
                const expected = CFG.remember ? CFG.pages * TX_PER_PAGE : 0;
                let rows = -1;
                let polls = 0;
                for (;;) {
                    rows = await idbCount(acc);
                    polls += 1;
                    if (rows === expected || performance.now() - tLoaded > CFG.timeoutMs) break;
                    await sleep(25);
                }
                const persistMs = +(performance.now() - tLoaded).toFixed(1);
                await sleep(300);
                if (CFG.countIdb) IDBC.on = false;

                return { expected, rows, polls, persisted: rows === expected, persistMs, reduxTxs: reduxTxs(acc), counts: CFG.countIdb ? JSON.parse(JSON.stringify(IDBC)) : undefined };
            },
        },

        // verify what is persisted, reset the account (Redux + IDB), check nothing writes its rows back
        async after({ n }) {
            const acc = targetAccount(n);
            if (!acc) return null;
            const snap = await idbSnapshot(acc);
            dispatch({ type: '@common/wallet-core/transactions/resetTransaction', payload: { account: acc } });
            let emptyAfterMs = null;
            const t0 = performance.now();
            for (let k = 0; k < 800; k++) {
                if ((await idbCount(acc)) === 0) { emptyAfterMs = +(performance.now() - t0).toFixed(1); break; }
                await sleep(25);
            }
            await sleep(1300);
            const rowsAfterQuiet = await idbCount(acc);
            let heapAfterGcMiB = null;
            if (typeof globalThis.gc === 'function' && performance.memory) {
                globalThis.gc();
                globalThis.gc();
                heapAfterGcMiB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
            }

            return { snap, emptyAfterMs, resurrected: rowsAfterQuiet !== 0, heapAfterGcMiB };
        },

        verify() {
            const s = st();

            return {
                accounts: s.wallet.accounts.length,
                remembered: !!(s.device.devices[0] && s.device.devices[0].remember),
                lifecycle: s.suite.lifecycle && s.suite.lifecycle.status,
                route: s.router && s.router.route && s.router.route.name,
                transports: ((s.suite.transport || {}).transports || []).length,
                calls: Object.assign({}, calls),
            };
        },
    };
})();
