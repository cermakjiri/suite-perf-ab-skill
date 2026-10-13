/**
 * account-switch — in-page part. A cross-platform worked example (web and desktop): the user opens
 * one account after another from the account menu and goes back to the dashboard.
 *
 * Seeded (store only, byte-identical on both sides): CFG.accounts BTC accounts, each with CFG.txs
 * stored transactions (the @storage/load `txs` rows Suite reads from IndexedDB at boot). The
 * phases are driven from Node with trusted clicks (scenario.mjs), so Event Timing records them and
 * inpMs is real; this file only seeds, mocks the backend and answers "is it rendered yet".
 */
(() => {
    const H = window.__H;
    const CFG = Object.assign({ accounts: 6, txs: 200, remember: true }, H.CFG);
    const DS = '1stTestnetAddress@device_id:0';
    const TX_PER_PAGE = 25;
    const st = () => H.state();
    const dispatch = a => H.dispatch(a);
    const { settle } = H;

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
    // CFG.accounts BTC native segwit accounts with CFG.txs transactions each, plus a few unrelated ones
    const makeAccounts = () => {
        const out = [];
        for (let i = 0; i < CFG.accounts; i++) out.push(mkAccount('btc', 'bitcoin', 'normal', "m/84'/0'/", i, CFG.txs));
        out.push(mkAccount('btc', 'bitcoin', 'segwit', "m/49'/0'/", 0, 4));
        out.push(mkAccount('eth', 'ethereum', 'normal', "m/44'/60'/0'/0/", 0, 6));
        out.push(mkAccount('ltc', 'bitcoin', 'normal', "m/84'/2'/", 0, 5));

        return out;
    };
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
            blockTime: 1759000000 - i * 43200,
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
        metadata: undefined, txs: storedTxs(accounts), phishing: [], phishingMetadata: undefined,
        messageSystem: undefined, backendSettings: [], sendFormDrafts: [], receive: [],
        formDrafts: [], coinjoinAccounts: [], coinjoinDebugSettings: undefined,
        tokenManagement: [], stellarContractTokens: [], persistentDeviceData: [], connect: undefined, explorer: [],
        bioAuth: undefined, firmware: undefined, suiteSyncSettings: undefined,
        suiteSyncOwners: [], suiteSyncQuotaManager: undefined, featureFeedback: undefined,
        discreetMode: { isActive: false }, debug: undefined, earnOnboarding: [],
    });

    // stored rows as the txs object store holds them: { tx: <WalletAccountTransaction>, order }
    const storedTxs = accounts => accounts.filter(a => a.symbol === 'btc' && a.accountType === 'normal').flatMap(a => {
        const rows = [];
        for (let i = 0; i < CFG.txs; i++) rows.push({ order: i, tx: Object.assign(mkTx(a.index, i), { descriptor: a.descriptor, symbol: a.symbol, deviceState: DS }) });

        return rows;
    });

    const calls = {};
    // no backend: every connect call answers at once, the same way on both sides
    const installConnectMocks = () => {
        const tc = H.connect();
        if (!tc || tc.__perfMocked) return false;
        const offline = name => async () => {
            calls[name] = (calls[name] || 0) + 1;

            return { success: false, payload: { error: 'perf: offline' } };
        };
        for (const m of ['getAccountInfo', 'blockchainGetFiatRatesForTimestamps', 'blockchainGetAccountBalanceHistory', 'blockchainSubscribe', 'blockchainEstimateFee']) tc[m] = offline(m);
        tc.blockchainGetCurrentFiatRates = async ({ currencies }) => ({ success: true, payload: { ts: Math.floor(Date.now() / 1000), rates: { [(currencies && currencies[0]) || 'usd']: 61000 } } });
        tc.__perfMocked = true;

        return true;
    };
    let transportFrozen = false;
    const fakeTransport = () => {
        const tc = H.connect();
        if (!transportFrozen && tc && typeof tc.removeAllListeners === 'function') {
            try {
                tc.removeAllListeners('TRANSPORT_EVENT');
            } catch {
                // desktop: the IPC proxy may not be up yet; the dispatch below is what matters
            }
            transportFrozen = true;
        }
        const t = st().suite.transport;
        if (t && t.transports && t.transports.length) return false;
        dispatch({ type: 'transport-start', payload: { apiType: 'usb', type: 'BridgeTransport', version: '3.0.0' } });

        return true;
    };

    window.__A = {
        name: 'account-switch',
        ready: () => !!H.store() && !!H.connect(),

        async seed() {
            const accounts = makeAccounts();
            dispatch({ type: '@storage/load', payload: basePayload(accounts) });
            dispatch({ type: '@suite/device/updateSelectedDevice', payload: device });
            await settle(200);

            return { accounts: st().wallet.accounts.length, txsPerAccount: CFG.txs };
        },

        async postInit() {
            fakeTransport();

            return { mocks: installConnectMocks(), stored: Object.values(st().wallet.transactions.transactions || {}).map(a => a.length) };
        },

        /** Called from scenario.mjs after the click: resolves when the account's list is on screen. */
        async accountShown(index) {
            const rows = await H.waitFor(() => {
                const r = st().router;
                const p = r && r.params;
                if (!(r && r.route && r.route.name === 'wallet-index' && p && Number(p.accountIndex) === index && p.symbol === 'btc')) return 0;

                return document.querySelectorAll('[data-testid="@wallet/transaction-item"]').length;
            }, { timeout: 20000, label: `account ${index} transactions` });
            await H.settle(0);

            return { rows, domNodes: document.getElementsByTagName('*').length };
        },

        async dashboardShown() {
            await H.waitFor(() => H.routeName() === 'suite-index', { timeout: 20000, label: 'dashboard' });
            await H.settle(0);

            return { domNodes: document.getElementsByTagName('*').length };
        },

        // after a discarded attempt the app may be left on an account: every iteration starts on the dashboard
        async reset() {
            if (H.routeName() !== 'suite-index') await H.goto('suite-index');
            await this.dashboardShown();

            return H.routeName() === 'suite-index';
        },

        verify() {
            const s = st();

            return { accounts: s.wallet.accounts.length, route: H.routeName(), calls: Object.assign({}, calls) };
        },
    };
})();
