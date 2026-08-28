/**
 * Adapter: Trezor Suite web.
 *
 * Concatenate after harness-core.js and pass the result as `navigate_page --initScript`.
 * Supplies the app knowledge the core primitives need: how to reach the store, what state to
 * seed, which elements the scenarios drive, and the concrete scenarios themselves.
 *
 * Everything here is synthetic — a remembered, disconnected, no-passphrase wallet and fabricated
 * accounts. Nothing real, nothing sensitive, nothing persisted (state goes into the Redux store,
 * not IndexedDB), and byte-identical on both branches, which is what makes the A/B fair.
 *
 * See references/seeding.md for why each field is shaped the way it is.
 */
(() => {
    const H = window.__H;
    const DS = '1stTestnetAddress@device_id:0';

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
        remember: true, connected: false, available: false, instance: undefined, ts: 1,
        buttonRequests: [], metadata: { status: 'disabled' },
        authenticityChecks: { firmwareRevision: { success: true }, firmwareHash: { success: true } },
        error: undefined, passwords: {},
    };

    const SPECS = [
        ['btc', 'bitcoin', 'normal', "m/84'/0'/"],
        ['btc', 'bitcoin', 'segwit', "m/49'/0'/"],
        ['btc', 'bitcoin', 'legacy', "m/44'/0'/"],
        ['eth', 'ethereum', 'normal', "m/44'/60'/0'/0/"],
        ['ltc', 'bitcoin', 'normal', "m/84'/2'/"],
        ['bch', 'bitcoin', 'normal', "m/44'/145'/"],
    ];

    // An account key is `${descriptor}-${symbol}-${deviceState}`, so none of the three may contain
    // a dash — createAccountKey throws otherwise. `bump` shifts balances so an update scenario
    // changes data without mounting anything new.
    const mkAccount = (symbol, networkType, accountType, pathPrefix, i, withTokens, bump) => {
        const d = symbol + accountType + 'xpubDESCRIPTOR' + String(i).padStart(4, '0');
        const b = 100000 + i * 137 + (bump || 0);

        return {
            deviceState: DS, key: d + '-' + symbol + '-' + DS, index: i,
            path: pathPrefix + i + "'", descriptor: d, accountType, symbol,
            empty: false, visible: true,
            balance: String(b), availableBalance: String(b),
            formattedBalance: (0.001 + i / 1000 + (bump || 0) / 1e8).toFixed(8),
            tokens: withTokens ? [0, 1, 2].map(t => ({
                type: 'ERC20', contract: '0xToken' + t + i, name: 'Token ' + t + '-' + i,
                symbol: 'TK' + t, decimals: 18, balance: String((t + 1) * 1000 * (i + 1)),
            })) : [],
            addresses: undefined, utxo: [],
            history: { total: 3 + (i % 7), unconfirmed: 0, tokens: 0 },
            metadata: { key: d }, page: { index: 1, size: 25, total: 1 },
            marker: undefined, stellarCursor: undefined,
            misc: networkType === 'ethereum' ? { nonce: '3' } : undefined,
            networkType, accountLabel: undefined,
        };
    };

    const makeAccounts = (n, withTokens, bump) => {
        const out = [];
        let i = 0;
        while (out.length < n) {
            for (const s of SPECS) {
                if (out.length >= n) break;
                out.push(mkAccount(s[0], s[1], s[2], s[3], i, withTokens && s[0] === 'eth', bump));
            }
            i++;
        }

        return out;
    };

    // `@storage/load` is the action the app dispatches at boot, so every slice already knows how
    // to read it — one dispatch installs a whole wallet. Keys read with getItemsExtended /
    // getItemsWithKeys must be arrays; the rest may be undefined.
    const basePayload = accounts => ({
        suiteSettings: {
            settings: { language: 'en' },
            flags: { initialRun: false, discreetModeCompleted: true, securityStepsHidden: true },
            evmSettings: undefined, seenDisconnectNotificationForDeviceIds: [],
        },
        devices: [device], thp: undefined, bluetooth: undefined, accounts,
        walletSettings: { enabledNetworks: ['btc', 'eth', 'ltc', 'bch'] },
        tradingTrades: [], historicRates: [], graph: [],
        analytics: { enabled: false, confirmed: true, instanceId: 'perf', sessionId: 'perf', sessionStart: 1 },
        metadata: undefined, txs: [], phishing: [], phishingMetadata: undefined,
        messageSystem: undefined, backendSettings: [], sendFormDrafts: [], receive: [],
        formDrafts: [], coinjoinAccounts: [], coinjoinDebugSettings: undefined,
        tokenManagement: [], persistentDeviceData: [], connect: undefined, explorer: [],
        bioAuth: undefined, firmware: undefined, suiteSyncSettings: undefined,
        suiteSyncOwners: [], suiteSyncQuotaManager: undefined, featureFeedback: undefined,
        discreetMode: undefined, debug: undefined,
    });

    const A = {
        name: 'suite-web',
        seeded: false,
        device, makeAccounts, basePayload,
        sizes: { small: 60, large: 200 },
        cache: null,

        // usePlaywright only exposes the store when window.Playwright was truthy at mount time,
        // which is why the core must be an init script.
        ready() { return !!window.store; },

        seed() {
            A.set([]);
            window.store.dispatch({ type: '@suite/device/updateSelectedDevice', payload: device });

            return window.store.getState().wallet.accounts.length;
        },

        // One dispatch, one render cascade. Suite reads the store through useSyncExternalStore,
        // so a change from outside React renders synchronously ONCE PER DISPATCH — sixty
        // individual createAccount dispatches produce ~39 commits and measure a list being built
        // incrementally rather than a mount.
        set(accounts) {
            window.store.dispatch({ type: '@storage/load', payload: basePayload(accounts) });
        },

        prepare(n, withTokens, bump) { A.cache = makeAccounts(n, withTokens, bump); return A.cache.length; },

        selectors: {
            rows() { return document.querySelectorAll('[data-testid^="@account-menu/"]').length; },
            // Innermost scroller holding account rows: develop scrolls the AccountsMenu container,
            // a virtualized branch scrolls the list's own container.
            scroller() {
                const cands = [];
                document.querySelectorAll('div').forEach(el => {
                    const cs = getComputedStyle(el);
                    if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20
                        && el.querySelector('[data-testid^="@account-menu/"]')) cands.push(el);
                });

                return cands.length ? cands[cands.length - 1] : null;
            },
            searchInput() {
                return document.querySelector('input[data-testid="@account-menu/search-input"]')
                    || document.querySelector('[data-testid^="@account-menu/search-input"] input')
                    || Array.from(document.querySelectorAll('input'))
                        .find(i => /search/i.test(i.getAttribute('data-testid') || ''));
            },
        },

        // Native setter bypasses React's value tracker. Use this for state SETUP only: synthetic
        // events are untrusted, so they produce no Event Timing entries at all and any interaction
        // latency from them is an absence, not a speed. Drive real input with the MCP's
        // click / type_text / press_key tools when you need INP.
        setInputValue(el, v) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        },

        scenarios: {
            // first render of the accounts list with N accounts
            mount({ k = 15, n = 60, tokens = true } = {}) {
                A.prepare(n, tokens);

                return H.repeat('S1', {
                    k,
                    reset: () => A.set([]),
                    act: () => { A.set(A.cache); return { rows: A.selectors.rows() }; },
                });
            },

            // re-render with mounting already paid for: same accounts, different balances
            update({ k = 15, n = 60, tokens = true } = {}) {
                A.prepare(n, tokens);
                let bump = 0;

                return H.repeat('S4', {
                    k,
                    setup: () => A.set(A.cache),
                    reset: null,
                    resetSettleMs: 0,
                    act: () => {
                        bump += 1000;
                        A.set(makeAccounts(n, tokens, bump));

                        return { rows: A.selectors.rows() };
                    },
                });
            },

            // typing in the account filter. interactionsValid will be false — see setInputValue.
            search({ k = 15, n = 60, tokens = true, word = 'bitcoin' } = {}) {
                A.prepare(n, tokens);
                A.set(A.cache);
                const input = A.selectors.searchInput();
                if (!input) return Promise.resolve({ error: 'no search input' });

                return H.repeat('S3', {
                    k,
                    reset: () => A.setInputValue(input, ''),
                    resetSettleMs: 160,
                    act: async () => {
                        for (let c = 1; c <= word.length; c++) {
                            A.setInputValue(input, word.slice(0, c));
                            await H.nextFrame();
                            await H.sleep(60);
                        }

                        return { rows: A.selectors.rows() };
                    },
                });
            },

            // fast flick; pass oneWay+frames for a slow drag. Run BOTH before believing a scroll
            // result — a regression seen with one gesture shape is a hypothesis.
            scroll({ k = 15, n = 60, tokens = true, frames = 60, oneWay = false } = {}) {
                A.prepare(n, tokens);

                return H.scroll('S2', {
                    k, frames, oneWay,
                    setup: async () => { A.set(A.cache); await H.settle(500); },
                    el: A.selectors.scroller,
                });
            },

            // teardown plus rebuild of a route subtree — catches cleanup cost the mount misses.
            //
            // `@router/goto` is a thunk, so dispatching it as a plain action silently does
            // nothing. `router/routerLocationChange` is the plain slice action the thunk
            // ultimately produces, and Object.assign-es its payload onto the route state.
            async navigate({ k = 12, n = 60, tokens = true } = {}) {
                A.prepare(n, tokens);
                A.set(A.cache);
                await H.settle(500);

                const wallet = { ...window.store.getState().router };
                if (wallet.app !== 'wallet') {
                    return { error: `expected to start on the wallet route, got app=${wallet.app}` };
                }
                const settings = {
                    ...wallet,
                    pathname: '/settings',
                    search: '',
                    app: 'settings',
                    route: { name: 'settings-index', pattern: '/settings', app: 'settings', params: undefined },
                    params: undefined,
                };
                const go = where => window.store.dispatch({
                    type: 'router/routerLocationChange',
                    payload: where,
                });

                // Prove the toggle actually moves the app before measuring it, so a route change
                // that no-ops reports an error instead of a suspiciously fast zero.
                go(settings);
                await H.settle(300);
                const rowsOnSettings = A.selectors.rows();
                go(wallet);
                await H.settle(300);
                const rowsOnWallet = A.selectors.rows();
                if (!(rowsOnWallet > 0 && rowsOnSettings < rowsOnWallet)) {
                    return { error: `route toggle had no effect (settings=${rowsOnSettings}, wallet=${rowsOnWallet})` };
                }

                return H.repeat('S5', {
                    k,
                    reset: () => go(settings),
                    resetSettleMs: 200,
                    act: () => { go(wallet); return { rows: A.selectors.rows() }; },
                });
            },

            // the only scenario that finds leaks
            cycle({ cycles = 24, n = 60, tokens = true } = {}) {
                A.prepare(n, tokens);

                return H.cycle({
                    cycles,
                    mount: () => A.set(A.cache),
                    unmount: () => A.set([]),
                });
            },
        },
    };

    window.__A = A;
})();
