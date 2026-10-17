/**
 * suite-perf-ab in-page core. run.mjs and open.mjs install it as an init script, before any app
 * code, concatenated as:
 *
 *   window.Playwright = true; window.__CFG = {...}; <core.js>; <the scenario's page.js>
 *
 * It must run before react-dom's module body evaluates: that is when React looks for the DevTools
 * hook, and a late hook reads every commit count as zero, silently.
 *
 * window.__perf  raw probe data (commits, long tasks, LoAF entries)
 * window.__H     helpers for the scenario (store, webpack lookups, routing, waiting, warm-up), the
 *                page's own tools when Suite answers devtoolstooldiscovery (discover, tool, thunk —
 *                references/discovery.md) and the measurement wrappers the runner calls
 *                (runPhase, idleWindow, calib, env)
 *
 * Probes that stay on for the whole session are cheap and identical on both sides: one timestamp
 * per React commit, buffered long-task / long-animation-frame observers. The rAF frame and 10 ms
 * timer-lag probes run only inside measured windows. Nothing here walks fibers or patches layout
 * getters during timing (set CFG.fiberStats for a diagnostic, non-timing pass).
 */
(() => {
    if (window.__H) return;
    const CFG = window.__CFG || {};
    const P = { commits: [], fibers: [], longtasks: [], loaf: [], events: [], shifts: [], installed: false, wrapped: false, renderers: 0, support: {} };
    window.__perf = P;

    // ------------------------------------------------------------ React commits
    // Production react-dom only reads isDisabled/supportsFiber, calls inject, and afterwards the
    // typeof-guarded, try/catch-wrapped onCommitFiberRoot / onPostCommitFiberRoot /
    // onCommitFiberUnmount / setStrictMode, so this minimal hook cannot break the app.
    const walkFibers = root => {
        // React's own bailout predicate: alternate.child === child means the subtree did not render
        let fibers = 0;
        let rendered = 0;
        let mounted = 0;
        let node = root.current;
        if (!node) return null;
        const start = node;
        for (;;) {
            fibers += 1;
            const alt = node.alternate;
            const bailed = alt !== null && alt !== undefined && alt.child === node.child;
            if (!bailed) {
                rendered += 1;
                if (alt === null || alt === undefined) mounted += 1;
            }
            if (node.child && !bailed) {
                node = node.child;
                continue;
            }
            while (node && node !== start && !node.sibling) node = node.return;
            if (!node || node === start || !node.sibling) break;
            node = node.sibling;
        }

        return { fibers, rendered, mounted };
    };
    const onCommit = (_id, root) => {
        const t = performance.now();
        P.commits.push(t);
        if (CFG.fiberStats) {
            try {
                P.fibers.push(Object.assign({ t }, walkFibers(root)));
            } catch {
                // diagnostic only
            }
        }
    };
    const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (existing === undefined) {
        let nextId = 1;
        const renderers = new Map();
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers,
            supportsFiber: true,
            isDisabled: false,
            inject(renderer) {
                const id = nextId++;
                renderers.set(id, renderer);
                P.renderers = renderers.size;

                return id;
            },
            onCommitFiberRoot: onCommit,
            onPostCommitFiberRoot() {},
            onCommitFiberUnmount() {},
            setStrictMode() {},
            checkDCE() {},
            getFiberRoots: () => new Set(),
            on() {},
            off() {},
            sub: () => () => {},
            emit() {},
        };
        P.installed = true;
    } else if (existing && typeof existing.onCommitFiberRoot === 'function') {
        const prev = existing.onCommitFiberRoot.bind(existing);
        existing.onCommitFiberRoot = (id, root, ...rest) => {
            onCommit(id, root);

            return prev(id, root, ...rest);
        };
        P.installed = true;
        P.wrapped = true;
    }

    // ------------------------------------------------------------ observers
    const observe = (type, onEntries, extra) => {
        try {
            const supported = (PerformanceObserver.supportedEntryTypes || []).includes(type);
            P.support[type] = supported;
            if (!supported) return;
            new PerformanceObserver(list => onEntries(list.getEntries())).observe(Object.assign({ type, buffered: true }, extra || {}));
        } catch {
            P.support[type] = false;
        }
    };
    observe('longtask', es => {
        for (const e of es) P.longtasks.push([e.startTime, e.duration]);
    });
    observe('long-animation-frame', es => {
        for (const e of es) {
            let script = 0;
            let forced = 0;
            for (const s of e.scripts || []) {
                script += s.duration || 0;
                forced += s.forcedStyleAndLayoutDuration || 0;
            }
            P.loaf.push([e.startTime, e.duration, e.blockingDuration || 0, script, forced]);
        }
    });
    // Event Timing records TRUSTED input only (Playwright page.mouse/keyboard, MCP click/type):
    // a dispatchEvent from page code produces no entry at all.
    observe('event', es => {
        for (const e of es) if (e.interactionId) P.events.push([e.startTime, e.duration, e.name]);
    }, { durationThreshold: 16 });
    observe('layout-shift', es => {
        for (const e of es) if (!e.hadRecentInput) P.shifts.push([e.startTime, e.value]);
    });

    // ------------------------------------------------------------ abort (the runner's watchdog)
    // H.abort(reason) ends the running phase at once, and every rig wait (sleep, settle, waitFor,
    // injectCost) throws at its next step; the app's own in-flight work may still finish, and the
    // runner never records it. H.drainAborted() waits for it, H.clearAbort() re-arms.
    const abort = { reason: null, reject: null, inflight: null };
    const checkAbort = () => {
        if (abort.reason) throw new Error(`aborted: ${abort.reason}`);
    };

    // ------------------------------------------------------------ small helpers
    const rawSleep = ms => new Promise(r => setTimeout(r, ms));
    const sleep = ms => rawSleep(ms).then(checkAbort);
    const nextFrame = () => new Promise(r => requestAnimationFrame(t => r(t)));
    const settle = async ms => {
        await nextFrame();
        await nextFrame();
        await sleep(ms == null ? 40 : ms);
    };
    const spin = ms => {
        const t = performance.now();
        while (performance.now() - t < ms) {
            // busy
        }
    };
    const round = v => (v === null || v === undefined ? v : +v.toFixed(1));
    const pct = (arr, p) => {
        if (!arr.length) return null;
        const s = arr.slice().sort((a, b) => a - b);

        return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
    };
    const waitFor = async (fn, { timeout = 30000, interval = 50, label = 'condition' } = {}) => {
        const t0 = performance.now();
        for (;;) {
            checkAbort();
            let v;
            try {
                v = await fn();
            } catch {
                v = undefined;
            }
            if (v) return v;
            if (performance.now() - t0 > timeout) throw new Error(`waitFor(${label}) timed out after ${timeout} ms`);
            await sleep(interval);
        }
    };

    // ------------------------------------------------------------ page-provided tools
    // Suite can answer chrome-devtools-mcp's `devtoolstooldiscovery` event with tool groups
    // (references/discovery.md). The rig asks exactly as the MCP does — a CustomEvent on window
    // with a respondWith callback — so one app-side contract serves MCP exploration and Playwright
    // measurement alike. A page without the listener (an ungated build, a Suite without the tools)
    // answers nothing, and every helper that prefers a tool falls back to the rig's own way.
    const disc = { groups: [], exec: new Map(), found: false };
    const takeGroups = groups => {
        disc.groups = groups;
        disc.exec = new Map();
        for (const g of groups) for (const t of g.tools || []) if (t && typeof t.name === 'string' && typeof t.execute === 'function' && !disc.exec.has(t.name)) disc.exec.set(t.name, t);
        disc.found = groups.length > 0;
    };
    const ask = () => {
        const groups = [];
        const event = new CustomEvent('devtoolstooldiscovery');
        event.respondWith = group => {
            if (group && typeof group.name === 'string' && Array.isArray(group.tools)) groups.push(group);
        };
        try {
            window.dispatchEvent(event);
        } catch {
            // a listener threw: no answer
        }

        return groups;
    };
    // synchronous answers only; asks again on later calls while nothing has answered (Suite registers
    // its listener during init, after this script ran)
    const ensureDiscovered = () => {
        if (disc.found) return;
        const groups = ask();
        if (groups.length) takeGroups(groups);
    };
    const discoverySummary = () => ({
        found: disc.found,
        groups: disc.groups.map(g => ({ name: g.name, description: typeof g.description === 'string' ? g.description : null, tools: (g.tools || []).map(t => t && t.name).filter(Boolean) })),
    });
    /** Ask the page for its tools (with the MCP's one tick of grace for asynchronous answers). */
    const discover = async opts => {
        const refresh = !!(opts && opts.refresh);
        if (disc.found && !refresh) return discoverySummary();
        const groups = ask();
        if (!groups.length) await rawSleep(0);
        if (groups.length || refresh) takeGroups(groups);

        return discoverySummary();
    };
    const hasTool = name => {
        ensureDiscovered();

        return disc.exec.has(name);
    };
    /** Run a page tool in-page: live objects come back live, a promise is awaited. Throws when the page does not offer it. */
    const tool = async (name, args) => {
        checkAbort();
        if (!hasTool(name)) await discover();
        const t = disc.exec.get(name);
        if (!t) throw new Error(`page tool ${name} not found${disc.found ? ` (the page offers: ${[...disc.exec.keys()].join(', ')})` : ' (the page answered no devtoolstooldiscovery: an ungated build, or a Suite without the tools)'}`);

        return t.execute(args || {});
    };
    /** A tool whose contract is a synchronous answer: undefined when absent, when it threw, or when it answered with a promise. */
    const syncTool = (name, args) => {
        if (!hasTool(name)) return undefined;
        let r;
        try {
            r = disc.exec.get(name).execute(args || {});
        } catch {
            return undefined;
        }

        return r && typeof r.then === 'function' ? undefined : r;
    };
    // The rig's hook sees commits when react-dom registered with it (renderers ≥ 1) or when it wrapped a
    // hook that was already there (the page's early hook, after a late injection): from then on every
    // commit passes through it. Otherwise the page's own count (suite.perf), when Suite offers one.
    const ownHookCounts = () => P.renderers >= 1 || P.wrapped;
    /** React commits in a window: the rig's own hook, else the page's early hook (suite.perf). */
    const commitsIn = (from, to) => {
        if (ownHookCounts()) return P.commits.filter(t => t >= from && t < to).length;
        const r = syncTool('suite.perf', Number.isFinite(from) && Number.isFinite(to) ? { action: 'read', from, to } : { action: 'read' });

        return r && typeof r.commits === 'number' ? r.commits : 0;
    };
    const pageHook = () => {
        const r = syncTool('suite.perf', { action: 'read' });

        return r && typeof r === 'object' ? { installed: !!r.installed, renderers: r.renderers ?? null, commits: r.commits ?? null } : null;
    };

    // ------------------------------------------------------------ window probes
    // rAF deltas (frames over budget) and the lateness of a 10 ms timer chain (how long input would
    // have waited at a random moment). On only inside measured windows, alike on both sides.
    const probes = { on: false, frames: [], lags: [], heapPeak: 0 };
    const startProbes = () => {
        probes.on = true;
        probes.frames = [];
        probes.lags = [];
        probes.heapPeak = 0;
        let last = null;
        let n = 0;
        const raf = t => {
            if (!probes.on) return;
            if (last !== null) probes.frames.push([t, t - last]);
            last = t;
            n += 1;
            if (n % 15 === 0 && performance.memory) probes.heapPeak = Math.max(probes.heapPeak, performance.memory.usedJSHeapSize);
            requestAnimationFrame(raf);
        };
        requestAnimationFrame(raf);
        let expected = performance.now() + 10;
        const tick = () => {
            if (!probes.on) return;
            const now = performance.now();
            probes.lags.push([now, now - expected]);
            expected = now + 10;
            setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
    };
    const stopProbes = () => {
        probes.on = false;
    };
    const inRange = (arr, from, to) => arr.filter(x => x[0] >= from && x[0] < to);
    /** Everything the probes saw between two performance.now() timestamps. */
    const windowStats = (from, to) => {
        const f = inRange(probes.frames, from, to).map(x => x[1]);
        const l = inRange(probes.lags, from, to).map(x => x[1]);
        const lt = inRange(P.longtasks, from, to);
        const lf = inRange(P.loaf, from, to);
        const ev = inRange(P.events, from, to);
        const sh = inRange(P.shifts, from, to);

        return {
            commits: commitsIn(from, to),
            frames: f.length,
            frameP50: pct(f, 50),
            frameP95: pct(f, 95),
            frameP99: pct(f, 99),
            frameMax: f.length ? round(Math.max(...f)) : null,
            framesOver50: f.filter(x => x > 50).length,
            framesOver100: f.filter(x => x > 100).length,
            jankMs: round(f.filter(x => x > 16.7).reduce((s, x) => s + (x - 16.7), 0)),
            lagP95: pct(l, 95),
            lagP99: pct(l, 99),
            lagMax: l.length ? round(Math.max(...l)) : null,
            lagOver50: l.filter(x => x > 50).length,
            longTasks: lt.length,
            longTaskMs: round(lt.reduce((s, x) => s + x[1], 0)),
            longestTaskMs: lt.length ? round(Math.max(...lt.map(x => x[1]))) : 0,
            tbtMs: round(lt.reduce((s, x) => s + Math.max(0, x[1] - 50), 0)),
            loafs: lf.length,
            loafBlockingMs: round(lf.reduce((s, x) => s + x[2], 0)),
            loafScriptMs: round(lf.reduce((s, x) => s + x[3], 0)),
            forcedLayoutMs: round(lf.reduce((s, x) => s + x[4], 0)),
            interactions: ev.length,
            inpMs: ev.length ? round(Math.max(...ev.map(x => x[1]))) : null,
            cls: +sh.reduce((s, x) => s + x[1], 0).toFixed(4),
            heapPeak: probes.heapPeak || null,
            ...(CFG.fiberStats ? fiberTotals(from, to) : {}),
        };
    };
    // counting passes only (CFG.fiberStats): fibers walked, rendered and mounted, over the window's commits
    const fiberTotals = (from, to) => {
        const f = P.fibers.filter(x => x.t >= from && x.t < to);
        const sum = k => f.reduce((s, x) => s + (x[k] || 0), 0);

        return { fibers: sum('fibers'), fibersRendered: sum('rendered'), fibersMounted: sum('mounted') };
    };

    // ------------------------------------------------------------ app access
    let wrCache = null;
    /** __webpack_require__ of the running bundle (web and desktop renderer are both webpack). */
    const wr = () => {
        if (wrCache) return wrCache;
        const key = Object.keys(self).find(k => k.startsWith('webpackChunk'));
        if (!key) return null;
        self[key].push([[`perf-ab-${Math.random()}`], {}, r => {
            wrCache = r;
        }]);

        return wrCache;
    };
    const src = id => {
        try {
            return Function.prototype.toString.call(wr().m[id]);
        } catch {
            return '';
        }
    };
    /** Ids of webpack modules whose source contains `needle` (a string unique to the code). */
    const findModules = needle => {
        const r = wr();
        if (!r) return [];

        return Object.keys(r.m).filter(id => src(id).includes(needle));
    };
    /**
     * A module's exports without side effects: from webpack's module cache when the bundle exposes
     * it (only executed modules are there), else by requiring it — fine for code that ran at boot.
     */
    const exportsOf = id => {
        const r = wr();
        if (r.c) return r.c[id] ? r.c[id].exports : null;
        try {
            return r(id);
        } catch {
            return null;
        }
    };
    // <version>.<web|desktop>[.codesign].<sha>: the release string every build inlines (process.env.SENTRY_RELEASE)
    const RELEASE = /(\d+\.\d+\.\d+)\.(web|desktop)(\.codesign)?\.([0-9a-f]{40})(?![0-9a-f])/;
    /**
     * One pass over the loaded modules' sources: how many carry each needle, the build's release
     * string (its commit, version, codesign flag) and how many hold React Compiler output
     * (`react.memo_cache_sentinel`; React defines it in one module itself). Only modules of chunks
     * loaded so far are seen.
     */
    const scanModules = needles => {
        const r = wr();
        const counts = Object.fromEntries((needles || []).map(n => [n, 0]));
        if (!r) return { counts, build: null };
        let release = null;
        let modules = 0;
        let sentinelModules = 0;
        for (const id of Object.keys(r.m)) {
            const s = src(id);
            modules += 1;
            for (const n of needles || []) if (s.includes(n)) counts[n] += 1;
            if (!release) {
                const m = s.match(RELEASE);
                if (m) release = { version: m[1], suiteType: m[2], codesign: !!m[3], commit: m[4] };
            }
            if (s.includes('react.memo_cache_sentinel')) sentinelModules += 1;
        }

        return { counts, build: Object.assign({ commit: release ? release.commit : null, release, modules, sentinelModules }) };
    };
    /** How many modules carry each needle — proves which build is running. */
    const markers = needles => scanModules(needles).counts;
    /** The running build: release string, commit, modules loaded, modules with compiler output. */
    const buildInfo = () => scanModules([]).build;
    /**
     * An RTK thunk from the production bundle by its type prefix. Modules already executed at boot
     * are returned from the cache, so requiring them has no side effects.
     */
    const findThunk = (typePrefix, needle) => {
        const r = wr();
        if (!r) return null;
        const probe = needle || typePrefix.slice(typePrefix.lastIndexOf('/'));
        for (const id of findModules(probe)) {
            const mod = exportsOf(id);
            for (const v of Object.values(mod || {})) {
                try {
                    if (typeof v === 'function' && v.typePrefix === typePrefix) return v;
                } catch {
                    // getter threw
                }
            }
        }

        return null;
    };
    let storeCache = null;
    /** The Redux store: window.store (web with window.Playwright, desktop with --expose-store) or the react-redux Provider. */
    const store = () => {
        if (window.store && typeof window.store.getState === 'function') return window.store;
        if (storeCache) return storeCache;
        const rootEl = document.getElementById('app') || document.body.firstElementChild;
        const key = rootEl && Object.keys(rootEl).find(k => k.startsWith('__reactContainer$'));
        if (!key) return null;
        const stack = [rootEl[key]];
        let guard = 0;
        while (stack.length && guard++ < 5000) {
            const f = stack.pop();
            if (!f) continue;
            const p = f.memoizedProps;
            const s = p && (p.store || (p.value && p.value.store));
            if (s && typeof s.getState === 'function' && typeof s.dispatch === 'function') {
                storeCache = s;

                return s;
            }
            if (f.sibling) stack.push(f.sibling);
            if (f.child) stack.push(f.child);
        }

        return null;
    };
    let connectCache = null;
    /**
     * TrezorConnect as the app calls it: window.TrezorConnect on web (window.Playwright), the
     * bundle's instance elsewhere — on desktop @trezor/connect is aliased to @trezor/connect-electron,
     * a factoryPrivileged object (plain methods, replaceable) in the module that defines initIpcProxy.
     */
    const connect = () => {
        if (window.TrezorConnect) return window.TrezorConnect;
        if (connectCache) return connectCache;
        // the page's own tool first: desktop has no window.TrezorConnect and the bundle walk is a heuristic
        const fromPage = syncTool('suite.services', { name: 'connect' });
        if (fromPage && typeof fromPage.getAccountInfo === 'function') {
            connectCache = fromPage;

            return fromPage;
        }
        if (!wr()) return null;
        const ids = findModules('initIpcProxy').concat(findModules('blockchainGetAccountBalanceHistory'));
        for (const id of ids) {
            const mod = exportsOf(id);
            for (const v of [mod, mod && mod.default].concat(Object.values(mod || {}))) {
                if (v && typeof v.getAccountInfo === 'function' && typeof v.blockchainGetAccountBalanceHistory === 'function') {
                    connectCache = v;

                    return v;
                }
            }
        }

        return null;
    };
    const state = () => store().getState();
    const dispatch = a => store().dispatch(a);
    /**
     * Click an element by data-testid (not trusted input: Event Timing ignores it; use a Node-side
     * phase with page.click for INP). The testid is often on a wrapper and the handler on a child —
     * pass `inner` to click a descendant selector instead.
     */
    const click = (testid, inner) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) throw new Error(`no element with data-testid ${testid}`);
        const target = inner ? el.querySelector(inner) || el : el;
        target.click();

        return true;
    };
    // routes the menus can reach with one click: the fallback when the bundle does not export
    // @router/goto (desktop builds keep router thunks module-internal)
    const MENU = {
        'suite-index': () => '@suite/menu/suite-index',
        'settings-index': () => '@suite/menu/settings',
        'wallet-index': p => p && `@account-menu/${p.symbol}/${p.accountType || 'normal'}/${p.accountIndex || 0}`,
    };
    const routeName = () => state().router && state().router.route && state().router.route.name;
    /** Suite navigation: the page's suite.goto tool, else its @router/goto thunk (web), else the matching menu click (desktop). */
    const goto = async (name, params, ms) => {
        await discover();
        if (hasTool('suite.goto')) {
            await tool('suite.goto', { routeName: name, params });
            await waitFor(() => routeName() === name, { timeout: 15000, label: `route ${name}` });
        } else {
            const gotoThunk = findThunk('@router/goto');
            if (gotoThunk) {
                dispatch(gotoThunk({ routeName: name, params }));
            } else {
                const testid = MENU[name] && MENU[name](params);
                if (!testid) throw new Error(`@router/goto is not exported by this bundle and ${name} has no menu fallback — click through the UI in the scenario`);
                click(testid);
                await waitFor(() => routeName() === name, { timeout: 15000, label: `route ${name}` });
            }
        }
        await settle(ms == null ? 300 : ms);

        return routeName();
    };
    /**
     * A callable for an RTK thunk by type prefix: the page's suite.thunk tool when it offers one
     * (desktop bundles keep most thunks module-internal), else the bundle's export. Returns
     * `arg => Promise<resolved action>`, or null when neither finds it.
     */
    const thunk = typePrefix => {
        if (hasTool('suite.thunk')) return arg => tool('suite.thunk', { typePrefix, arg });
        const fn = findThunk(typePrefix);

        return fn ? arg => dispatch(fn(arg)) : null;
    };
    const suiteReady = () => {
        // the page's own answer when it offers one (synchronous by contract), else the store
        const r = syncTool('suite.ready', {});
        if (r && typeof r.ready === 'boolean') return r.ready;
        const s = store();
        if (!s) return false;
        const g = s.getState();

        return !!(g.suite && g.suite.lifecycle && g.suite.lifecycle.status === 'ready' && g.router && g.router.loaded && !document.querySelector('[data-testid="@suite/loading"]'));
    };

    // ------------------------------------------------------------ rig controls
    // After ~300 ms idle the first ~30 ms of renderer work runs 2.5-3x slower on Apple silicon (core
    // clock ramp). Each spin is its own task followed by a rendering update so it never merges into
    // the measured frame.
    const warm = async () => {
        await sleep(0);
        spin(40);
        await nextFrame();
        await sleep(0);
        spin(40);
        await nextFrame();
        await sleep(0);
    };
    const inj = { calls: 0, ms: 0 };
    /** Injected-cost control: the scenario calls this once per unit of work it wants to tax. */
    const injectCost = () => {
        checkAbort();
        const ms = Number(CFG.inject) || 0;
        if (!ms) return;
        inj.calls += 1;
        inj.ms += ms;
        spin(ms);
    };

    let A = null;
    const adapter = () => {
        if (!A) A = window.__A;
        if (!A) throw new Error('window.__A is not defined — the scenario page.js did not load');

        return A;
    };
    let openWindow = null;
    const H = {
        CFG,
        sleep, nextFrame, settle, spin, waitFor, round, pct,
        RUN: window.__RUN || {},
        wr, exportsOf, findModules, findThunk, markers, buildInfo, store, connect, state, dispatch, click, goto, routeName, suiteReady, thunk,
        discover, tool, hasTool, syncTool, tools: discoverySummary,
        warm, injectCost,
        probes: { start: startProbes, stop: stopProbes, stats: windowStats },
        commits: () => (ownHookCounts() ? P.commits.length : commitsIn(-Infinity, Infinity)),

        /** One measured phase: probes on, run __A.phases[name]({ i, n, rate }, CFG), window stats out. */
        async runPhase(name, it) {
            const a = adapter();
            const fn = a.phases && a.phases[name];
            if (typeof fn !== 'function') throw new Error(`__A.phases.${name} is not a function`);
            inj.calls = 0;
            inj.ms = 0;
            startProbes();
            const t0 = performance.now();
            let r = null;
            let error = null;
            // the watchdog's H.abort() rejects this at once; the phase itself may still be running
            const stop = Promise.withResolvers();
            stop.promise.catch(() => {});
            abort.reject = stop.reject;
            abort.inflight = Promise.resolve().then(() => fn.call(a, it, CFG));
            try {
                r = await Promise.race([abort.inflight, stop.promise]);
            } catch (e) {
                error = String((e && e.stack) || e).slice(0, 600);
            }
            abort.reject = null;
            const t1 = performance.now();
            stopProbes();
            const own = r && typeof r === 'object' ? r : r === null || r === undefined ? {} : { value: r };

            return Object.assign({ ms: round(t1 - t0) }, windowStats(t0, t1), own, inj.calls ? { injectedCalls: inj.calls, injectedMs: inj.ms } : {}, error ? { error } : {}, abort.reason ? { aborted: abort.reason } : {});
        },
        /** The runner's watchdog: end the running phase now, and make every rig wait throw. */
        abort(reason) {
            abort.reason = String(reason || 'aborted');
            if (abort.reject) abort.reject(new Error(`aborted: ${abort.reason}`));

            return true;
        },
        /** After an abort: wait (up to ms) for the aborted phase's own work to finish, close the window. */
        async drainAborted(ms = 60000) {
            const t0 = performance.now();
            let settled = true;
            if (abort.inflight) settled = await Promise.race([abort.inflight.then(() => true, () => true), rawSleep(ms).then(() => false)]);
            stopProbes();
            openWindow = null;
            abort.inflight = null;

            return { waitedMs: round(performance.now() - t0), settled };
        },
        clearAbort() {
            abort.reason = null;
            abort.reject = null;
        },
        /** A fixed amount of work (the calibration loop's body), for the runner's performance-core check. */
        busy(n) {
            let x = 0;
            for (let i = 0; i < n; i++) x += i % 7;

            return x;
        },
        /** For phases driven from Node (trusted input): open and close the same window around them. */
        windowStart() {
            inj.calls = 0;
            inj.ms = 0;
            startProbes();
            openWindow = performance.now();

            return openWindow;
        },
        windowEnd() {
            const t1 = performance.now();
            stopProbes();
            const t0 = openWindow;
            openWindow = null;

            return Object.assign({ ms: round(t1 - t0) }, windowStats(t0, t1), inj.calls ? { injectedCalls: inj.calls, injectedMs: inj.ms } : {});
        },
        /** Background activity with the probes on, for idle-correcting long windows. */
        async idleWindow(ms) {
            startProbes();
            const t0 = performance.now();
            await sleep(ms);
            const t1 = performance.now();
            stopProbes();

            return Object.assign({ ms: round(t1 - t0) }, windowStats(t0, t1));
        },
        /** A fixed busy loop, five times: the throttle check (4x should read ~4x the 1x value). */
        calib(iterations = 1.5e8) {
            const r = [];
            for (let k = 0; k < 5; k++) {
                let x = 0;
                const t0 = performance.now();
                for (let i = 0; i < iterations; i++) x += i % 7;
                r.push(round(performance.now() - t0) + (x < 0 ? 1 : 0));
            }

            return r;
        },
        /** Provenance and probe health, checked by the runner before anything is measured. */
        env(needles) {
            const time = (fn, reps) => {
                const r = [];
                for (let k = 0; k < reps; k++) {
                    const t0 = performance.now();
                    fn();
                    r.push(round(performance.now() - t0));
                }

                return r;
            };
            const M = 10000;
            const spread = () => {
                let a = [];
                for (let i = 0; i < M; i++) a = [...a, i];

                return a.length;
            };
            const slice = () => {
                let a = [];
                for (let i = 0; i < M; i++) {
                    a = a.slice();
                    a.push(i);
                }

                return a.length;
            };

            // needles: the scenario's markers and every side's commit (the runner's automatic proof)
            const scan = scanModules(needles);
            ensureDiscovered();

            return {
                coverageFiles: Object.keys(globalThis.__coverage__ || {}).length,
                hook: P.installed,
                hookWrapped: P.wrapped,
                renderers: P.renderers,
                support: P.support,
                gc: typeof globalThis.gc === 'function',
                ua: navigator.userAgent,
                dpr: devicePixelRatio,
                inner: [innerWidth, innerHeight],
                origin: location.origin,
                store: !!store(),
                connect: !!connect(),
                desktopApi: !!window.desktopApi,
                sentry: !!window.__SENTRY__,
                webpack: !!wr(),
                // the page's tools (devtoolstooldiscovery) and its own React hook, when Suite offers them
                discovery: discoverySummary(),
                pageHook: pageHook(),
                // ratio ~1: no debugger attached; ~25: a DevTools debugger is on and spreads are taxed
                canary: { spread: time(spread, 3), slice: time(slice, 3) },
                markers: scan.counts,
                build: scan.build,
                domNodes: document.getElementsByTagName('*').length,
            };
        },
    };
    window.__H = H;
})();
