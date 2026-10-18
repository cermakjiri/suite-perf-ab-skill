/**
 * desktop-ipc-backend — in-page part (desktop only; scenario.mjs says when to use it and how to read
 * the numbers). A template for code that Suite desktop runs outside the renderer and the renderer
 * reaches over the preload's window.ipcProxy, the way the app's own createIpcProxy(<channel>, …)
 * does. Worked instance: CoinjoinBackend.getAccountInfo, as fetchAndUpdateAccountThunk calls it after
 * a scan.
 *
 *   spawn  ipcProxy.create(CHANNEL, id, [SETTINGS]): main constructs the backend — for
 *          CoinjoinBackend a ThreadProxy that forks an Electron utility process
 *          (suite/desktop-app-main/src/modules/coinjoin.ts → libs/thread-proxy.ts →
 *          threads/coinjoin-backend.ts) — and resolves once it is up
 *   call   ipcProxy.request(CHANNEL, id, METHOD, args(it.n)): the method under test. Its wall time
 *          is the app's own round trip: the renderer's structured-clone copy of the arguments, main
 *          relaying it, the utility process's work, the result copied back. getAccountInfo is pure
 *          CPU; nothing is fetched.
 *
 * Each iteration gets a fresh backend, so `call` is the first call into a new process (cold JIT), and
 * its own data, args(it.n), so nothing a backend caches carries over. --cfg.warm=<N> times a warm
 * backend instead, the way the app keeps one alive (CoinjoinService: one per network): before()
 * spawns it and makes N untimed calls on other data, so `call` is call N+1 and `spawn` reads ~0
 * (not timed in that pass). after() hashes the result, disposes the backend and runs a full GC (the
 * desktop launch exposes gc()), so no timed call collects the last iteration's ~1 MB of copies;
 * reset() disposes what a discarded attempt left behind.
 *
 * To adapt it, change the block marked ADAPT and nothing else:
 *   CHANNEL, METHOD, DISPOSE, SETTINGS  from the app code that drives the backend (here
 *                     suite/coinjoin/src/coinjoinService.ts and suite/coinjoin/src/config.ts)
 *   SIZES             the size knob (cfg.size) for a second size pass
 *   prepare(request)  once per session, on a backend of its own: what the backend derives itself and
 *                     the app caches and passes back (here the account's addresses, from a call with
 *                     no transactions: the prederived cache the app builds in getAccountCache,
 *                     suite/coinjoin/src/coinjoinAccountActions.ts)
 *   args(n)           the call's arguments as a pure function of n: both sides get the same data at
 *                     the same n
 *   units(a)          H.injectCost() calls per call: one per unit of work the paired control taxes
 *   isResult(r)       true when the call returned what it should
 *   describe(r)       the result fields the record keeps next to the hash
 */
(() => {
    const H = window.__H;
    const CFG = Object.assign({ size: 'S', warm: 0 }, H.CFG);
    const WARM = Number(CFG.warm) || 0;

    // ------------------------------------------------------------------ ADAPT: the backend under test
    const CHANNEL = 'CoinjoinBackend';
    const METHOD = 'getAccountInfo';
    // the request that frees the backend in main (null when there is none)
    const DISPOSE = 'disable';
    // the regtest values of suite/coinjoin/src/config.ts; the URLs are never fetched
    const SETTINGS = {
        network: 'regtest',
        wabisabiBackendUrl: 'http://127.0.0.1:1/',
        blockbookUrls: ['http://127.0.0.1:1'],
        baseBlockHeight: 0,
        baseBlockHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
        filtersBatchSize: 5000,
    };
    // T txs of V inputs + outputs each; receive and change: the account's address counts
    const SIZES = {
        S: { T: 30, V: 100, receive: 40, change: 120 },
        M: { T: 60, V: 200, receive: 60, change: 240 },
    };
    const SIZE = SIZES[CFG.size];
    if (!SIZE) throw new Error(`cfg.size ${CFG.size}: one of ${Object.keys(SIZES).join(', ')}`);
    // packages/coinjoin/src/__fixtures__/methods.fixture.ts SEGWIT_XPUB (regtest)
    const XPUB =
        'vpub5YX1yJFY8E236pH3iNvCpThsXLxoQoC4nwraaS5h4TZwaSp1Gg9SQoxCsrumxjh7nZRQQkNfH29TEDeMvAZVmD3rpmsDnFc5Sj4JgJG6m4b';
    const checkpoint = () => ({ blockHash: SETTINGS.baseBlockHash, blockHeight: SIZE.T, receiveCount: SIZE.receive, changeCount: SIZE.change });
    let prepared = null; // { receivePrederived, changePrederived }

    const prepare = async request => {
        const info = await request(METHOD, [XPUB, [], checkpoint()]);
        const strip = list => list.map(({ address, path }) => ({ address, path }));
        prepared = { receivePrederived: strip(info.addresses.unused.concat(info.addresses.used)), changePrederived: strip(info.addresses.change) };
        if (prepared.receivePrederived.length !== SIZE.receive || prepared.changePrederived.length !== SIZE.change) {
            throw new Error(`derived ${prepared.receivePrederived.length}/${prepared.changePrederived.length} addresses, expected ${SIZE.receive}/${SIZE.change}`);
        }

        return { addresses: SIZE.receive + SIZE.change, firstReceive: prepared.receivePrederived[0].address.slice(0, 12) };
    };

    const rng = seed => () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;

        return seed / 2 ** 32;
    };
    // a synthetic regtest coinjoin account: wide `joint` txs, half inputs and half outputs, mostly
    // foreign, 1–2 owned inputs and 2–4 owned change outputs each, all confirmed
    const makeTxs = n => {
        const { T, V } = SIZE;
        const rand = rng(n * 7919 + T * 31 + V);
        let foreign = 0;
        const foreignAddress = () => `bcrt1qforeign${n.toString(36)}x${(foreign++).toString(36).padStart(24, '0')}`;
        const vv = (i, address, value, owned, extra) =>
            Object.assign({ n: i, addresses: [address], isAddress: true, isAccountOwned: owned || undefined, value: String(value) }, extra);
        const unspent = [];
        const txs = [];
        for (let t = 0; t < T; t++) {
            const txid = (n * 100000 + t).toString(16).padStart(64, '0');
            const nIn = V / 2;
            const vin = [];
            const vout = [];
            const ownedIn = Math.min(unspent.length, 1 + Math.floor(rand() * 2));
            let sent = 0;
            for (let i = 0; i < ownedIn; i++) {
                const u = unspent.splice(Math.floor(rand() * unspent.length), 1)[0];
                sent += u.value;
                vin.push(vv(vin.length, u.address, u.value, true, { txid: u.txid, vout: u.vout }));
            }
            if (!ownedIn) {
                const a = prepared.receivePrederived[t % prepared.receivePrederived.length].address;
                vin.push(vv(0, foreignAddress(), 500000, false, { txid: 'f'.repeat(64), vout: t }));
                vout.push(vv(0, a, 400000, true));
                unspent.push({ txid, vout: 0, value: 400000, address: a });
            }
            while (vin.length < nIn) vin.push(vv(vin.length, foreignAddress(), 100000 + Math.floor(rand() * 900000), false, { txid: 'e'.repeat(64), vout: vin.length }));
            const ownedOut = 2 + Math.floor(rand() * 3);
            let received = 0;
            for (let i = 0; i < ownedOut; i++) {
                const a = prepared.changePrederived[(t * 4 + i) % prepared.changePrederived.length].address;
                const value = 50000 + Math.floor(rand() * 200000);
                received += value;
                unspent.push({ txid, vout: vout.length, value, address: a });
                vout.push(vv(vout.length, a, value, true));
            }
            while (vout.length < V - nIn) vout.push(vv(vout.length, foreignAddress(), 50000 + Math.floor(rand() * 200000), false));
            txs.push({
                type: 'joint', txid, blockHeight: t + 1, blockTime: 1700000000 + t * 600, amount: String(received - sent), fee: '0',
                targets: [], tokens: [], internalTransfers: [],
                details: { vin, vout, size: V * 60, totalInput: '0', totalOutput: '0' },
            });
        }

        return txs;
    };
    const args = n => [XPUB, makeTxs(n), checkpoint(), prepared];
    // one tax per 10 txs: 3 per call at size S, 30 ms at --alt-inject=10
    const units = a => Math.ceil(a[1].length / 10);
    const isResult = r => !!(r && r.addresses && r.utxo);
    const describe = r => ({ balance: r.balance, used: r.addresses.used.length, utxo: r.utxo.length });
    // ------------------------------------------------------------------ end of ADAPT

    const proxy = () => window.ipcProxy;
    // renderer garbage of one call (the copies out and back) must not be collected inside the next timed one
    const collect = () => (typeof globalThis.gc === 'function' ? globalThis.gc() : undefined);
    let instances = 0;
    const newId = () => `perfab${Date.now().toString(36)}${(instances++).toString(36)}`;
    const dispose = id => (DISPOSE ? proxy().request(CHANNEL, id, DISPOSE, []).catch(() => undefined) : Promise.resolve());
    // JSON with sorted object keys (and the values JSON drops spelled out): equal results serialize
    // equally even when the new code builds them in another key order. Arrays keep their order.
    const canonical = value =>
        JSON.stringify(value, (_, v) => {
            if (typeof v === 'bigint') return `${v}n`;
            if (v instanceof Map) return { $map: [...v] };
            if (v instanceof Set) return { $set: [...v] };
            if (v instanceof ArrayBuffer) return { $bytes: [...new Uint8Array(v)] };
            if (ArrayBuffer.isView(v)) return { $bytes: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] };
            if (!v || typeof v !== 'object' || Array.isArray(v)) return v;

            return Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]));
        });
    // FNV-1a, as 8 hex digits: a string, so the aggregate does not average it as a metric
    const fnv = s => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;

        return h.toString(16).padStart(8, '0');
    };
    const summarize = r => {
        if (!isResult(r)) return { hash: null };
        const json = canonical(r);

        return Object.assign({ hash: fnv(json), resultKiB: +(json.length / 1024).toFixed(1) }, describe(r));
    };

    let current = null; // { id, args, result }
    let lastHash = null;

    window.__A = {
        name: 'desktop-ipc-backend',
        ready: () => !!H.store(),

        // settings only: Suite boots to the dashboard with no device and no accounts (the backend needs none)
        async seed() {
            H.dispatch({
                type: '@storage/load',
                payload: {
                    supportedNetworks: ['btc'],
                    suiteSettings: {
                        settings: { language: 'en-US', theme: { variant: 'light' }, autodetect: { language: false, theme: false } },
                        flags: { initialRun: false, discreetModeCompleted: true, securityStepsHidden: true },
                        evmSettings: undefined, seenDisconnectNotificationForDeviceIds: [],
                    },
                    devices: [], thp: undefined, bluetooth: undefined, accounts: [], walletSettings: { enabledNetworks: ['btc'] },
                    tradingTrades: [], historicRates: [], graph: [], analytics: { enabled: false, confirmed: true, instanceId: 'perf', sessionId: 'perf', sessionStart: 1 },
                    metadata: undefined, txs: [], phishing: [], phishingMetadata: undefined, messageSystem: undefined, backendSettings: [], sendFormDrafts: [], receive: [],
                    formDrafts: [], coinjoinAccounts: [], coinjoinDebugSettings: undefined, tokenManagement: [], stellarContractTokens: [], persistentDeviceData: [], connect: undefined, explorer: [],
                    bioAuth: undefined, firmware: undefined, suiteSyncSettings: undefined, suiteSyncOwners: [], suiteSyncQuotaManager: undefined, featureFeedback: undefined,
                    discreetMode: { isActive: false }, debug: undefined, earnOnboarding: [],
                },
            });

            return { size: CFG.size };
        },

        async postInit() {
            if (!proxy()) throw new Error('window.ipcProxy missing: not the desktop app (this scenario is desktop only)');
            const id = newId();
            await proxy().create(CHANNEL, id, [SETTINGS]);
            let prep;
            try {
                prep = await prepare((method, a) => proxy().request(CHANNEL, id, method, a));
            } finally {
                await dispose(id);
            }

            // the size of what the renderer copies out per call, for reading call.taskMs
            return { channel: CHANNEL, method: METHOD, size: CFG.size, ...SIZE, ...prep, argKiB: +(canonical(args(0)).length / 1024).toFixed(1) };
        },

        async before(it) {
            current = { id: newId(), args: args(it.n), result: null, spawned: false };
            if (!WARM) return;
            // a warm backend: spawned here, then WARM calls on data no timed iteration uses
            await proxy().create(CHANNEL, current.id, [SETTINGS]);
            current.spawned = true;
            for (let w = 1; w <= WARM; w++) await proxy().request(CHANNEL, current.id, METHOD, args(100000 + it.n * WARM + w));
            collect();
        },

        phases: {
            // fork + load + construct the backend in a fresh utility process (with cfg.warm: done in before())
            async spawn() {
                if (current.spawned) return { ok: true };
                await proxy().create(CHANNEL, current.id, [SETTINGS]);

                return { ok: true };
            },
            async call() {
                // the rig's control: a fixed renderer cost per unit of work (0 outside the ctl pass)
                for (let u = units(current.args); u > 0; u--) H.injectCost();
                current.result = await proxy().request(CHANNEL, current.id, METHOD, current.args);

                return { ok: isResult(current.result) };
            },
        },

        async after() {
            if (!current) return { hash: null };
            // a call of its own, so no local here still holds the result or its JSON when collect() runs
            const out = summarize(current.result);
            lastHash = out.hash;
            await dispose(current.id);
            current = null;
            collect();

            return out;
        },

        // after a discarded attempt; the runner has drained the aborted phase, so a create() or request() in flight has settled
        async reset() {
            if (current) await dispose(current.id);
            current = null;

            return true;
        },

        verify() {
            const s = H.state();

            return { route: s.router && s.router.route && s.router.route.name, size: CFG.size, warm: WARM, lastHash };
        },
    };
})();
