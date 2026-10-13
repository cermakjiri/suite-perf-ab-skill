/**
 * emulator-accounts — in-page part. Real device, real data: trezor-user-env's emulator (wiped and
 * seeded per session by run.mjs, default seed "all all … all"), Suite's own connect → authorize →
 * discovery through the bridge on 127.0.0.1:21328, live backends (run.json network: live).
 *
 * The seed is settings only (no onboarding, analytics answered, the enabled networks, device
 * authenticity/hash/revision checks off — production builds otherwise block an emulator); devices,
 * accounts and transactions come from the device and the backend like for a user.
 */
(() => {
    const H = window.__H;
    const CFG = Object.assign({ networks: ['btc'], stableMs: 3000, cycle: false }, H.CFG);
    const st = () => H.state();
    const dispatch = a => H.dispatch(a);
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
    // accounts that have history and sit in the always-expanded "normal" group of the account menu
    const withHistory = () => st().wallet.accounts.filter(a => CFG.networks.includes(a.symbol) && a.accountType === 'normal' && a.history && a.history.total > 0);
    let stable = { count: -1, since: 0 };
    let readyAt = null;

    window.__A = {
        name: 'emulator-accounts',
        ready: () => !!H.store(),

        async seed() {
            dispatch({ type: '@storage/load', payload: settingsPayload() });
            for (const t of ['suiteSettings/toggleFirmwareHashCheck', 'suiteSettings/toggleFirmwareRevisionCheck', 'suiteSettings/toggleDeviceAuthenticityCheck']) dispatch({ type: t, payload: false });

            return { networks: CFG.networks };
        },

        // Suite up, the emulator acquired and authorized, discovery finished: the account list has
        // stopped growing for stableMs and at least one account has history
        isReady() {
            if (!H.suiteReady()) return false;
            const d = st().device.selectedDevice;
            if (!d || !d.connected || d.type !== 'acquired' || !d.state) return false;
            const n = st().wallet.accounts.length;
            const now = performance.now();
            if (n !== stable.count) stable = { count: n, since: now };
            // wallet.discovery maps device -> { status: 'complete' | … }; fall back to "no new account for stableMs"
            const disc = Object.values(st().wallet.discovery || {});
            const complete = disc.length > 0 && disc.every(x => x.status === 'complete');
            const done = n > 0 && withHistory().length > 0 && (complete || now - stable.since > CFG.stableMs);
            if (done && readyAt === null) readyAt = now;

            return done;
        },

        async postInit() {
            const d = st().device.selectedDevice;
            const disc = Object.values(st().wallet.discovery || {});

            return {
                device: d && d.features && d.features.internal_model,
                firmware: d && d.features && [d.features.major_version, d.features.minor_version, d.features.patch_version].join('.'),
                accounts: st().wallet.accounts.length,
                withHistory: withHistory().map(a => `${a.index}:${a.history.total}`),
                discovery: disc.map(x => ({ status: x.status, loaded: x.loaded, total: x.total })),
                readyMs: readyAt === null ? null : Math.round(readyAt - t0),
            };
        },

        /**
         * The account iteration n opens: the one with the most history every time (a stable
         * workload), or with cfg.cycle every account that has history in turn (real-data variety,
         * more variance; both sides still open the same account at the same n).
         */
        pick(n) {
            const list = withHistory().sort((x, y) => y.history.total - x.history.total);
            const a = CFG.cycle ? list[n % list.length] : list[0];

            return { testid: `@account-menu/${a.symbol}/${a.accountType}/${a.index}`, index: a.index, symbol: a.symbol, txs: a.history.total };
        },

        async accountShown(p) {
            const rows = await H.waitFor(() => {
                const r = st().router;
                const q = r && r.params;
                if (!(r && r.route && r.route.name === 'wallet-index' && q && Number(q.accountIndex) === p.index && q.symbol === p.symbol)) return 0;

                return document.querySelectorAll('[data-testid="@wallet/transaction-item"]').length;
            }, { timeout: 30000, label: `account ${p.index} transactions` });
            await H.settle(0);

            return { rows, historyTotal: p.txs };
        },

        async dashboardShown() {
            await H.waitFor(() => H.routeName() === 'suite-index', { timeout: 20000, label: 'dashboard' });
            await H.settle(0);

            return {};
        },

        // after a discarded attempt the app may be left on an account: every iteration starts on the dashboard
        async reset() {
            if (H.routeName() !== 'suite-index') await H.goto('suite-index');
            await this.dashboardShown();

            return H.routeName() === 'suite-index';
        },

        verify() {
            const d = st().device.selectedDevice;

            return { device: d && d.features && d.features.internal_model, connected: !!(d && d.connected), accounts: st().wallet.accounts.length, route: H.routeName() };
        },
    };
})();
