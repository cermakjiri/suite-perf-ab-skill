/**
 * SPA performance A/B harness — app-agnostic core.
 *
 * Concatenate this with an adapter from assets/adapters/ and pass the result as the `initScript`
 * argument of the Chrome DevTools MCP `navigate_page` tool:
 *
 *   cat harness-core.js adapters/suite-web.js
 *
 * It must be an init script, not `evaluate_script`: the React DevTools hook has to exist before
 * react-dom's module body evaluates, because that is when React looks for it. Install it late and
 * every commit count reads zero, silently.
 *
 * ---------------------------------------------------------------------------
 * ADAPTER CONTRACT
 * ---------------------------------------------------------------------------
 * An adapter assigns `window.__A` with:
 *
 *   name           string, e.g. 'suite-web'
 *   seed()         put the app in its baseline state; called once when the app is ready
 *   ready()        boolean — has the app booted far enough to drive
 *   scenarios      { [name]: (opts) => Promise<record[]> }
 *   selectors      { scroller(): Element|null, ... } — whatever its scenarios need
 *   sizes          optional { small, large } data sizes for size-sensitivity runs
 *
 * Scenarios are normally built from the primitives on `window.__H` (mount/update/interact/scroll/
 * navigate/cycle), which handle iteration, warm-up, marks and aggregation, so an adapter only
 * supplies {setup, act, reset} callbacks.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAFE TO MEASURE, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Anything that taxes the code path under test biases the A/B. The rules this file follows, each
 * of which was verified empirically rather than assumed (see references/pitfalls.md):
 *
 *  - Timing runs use `mode: 'count'` for React. `mode: 'stats'` walks the fiber tree INSIDE the
 *    commit task, before paint, so it lengthens the very task it is measuring. Diagnostic only.
 *  - Event Timing only records TRUSTED events. A native-value-setter + dispatchEvent produces
 *    ZERO entries — not noisy, empty. Interaction latency is therefore only valid when the input
 *    came from the MCP's own click/type_text/press_key tools. `interactionsValid` says which.
 *  - `longtask` and `long-animation-frame` both have a hard 50ms floor that cannot be lowered.
 *  - rAF deltas are a threshold detector at the frame budget, not a linear measure of work, and
 *    the budget depends on the display's refresh rate. Opt-in, and never compared across machines.
 *  - Memory is read via `performance.memory`, whose precision is real but whose meaning is not:
 *    it tracks allocation and GC history, not live data. Only block minima over many cycles mean
 *    anything, and detached DOM is nearly invisible to it (it lives in Blink, not the V8 heap).
 */
(() => {
    const P = {
        commits: [],          // {t, fibers?, rendered?, mounted?, hostRendered?}
        commitMode: 'count',  // 'off' | 'count' | 'stats'
        loaf: [],
        longtasks: [],
        events: [],
        shifts: [],
        installed: false,
        rendererCount: 0,
        profilingBuild: null, // set on first commit; null until then
    };
    window.__perf = P;

    // ---------------------------------------------------------------- react probe
    //
    // Production react-dom 19.2.3 reads only `isDisabled` and `supportsFiber`, then calls
    // `inject`, and afterwards only onCommitFiberRoot / onPostCommitFiberRoot /
    // onCommitFiberUnmount / setStrictMode — all typeof-guarded and try/catch wrapped, so an
    // incomplete hook cannot break the app.
    //
    // Arg 2 of onCommitFiberRoot is the FiberRootNode, not a Fiber. `root.current` is the
    // just-committed tree; `root.current.alternate` is the previous one.
    const walkFibers = root => {
        // React's own bailout predicate, lifted from bubbleProperties in the shipped source:
        //   didBailout = alternate !== null && alternate.child === child
        // createWorkInProgress copies `child` across; if a fiber rendered, reconcileChildren
        // replaced that pointer. So equality means the whole subtree below was untouched, which
        // both prunes this walk and is the honest "did not re-render" signal.
        let fibers = 0;
        let rendered = 0;
        let mounted = 0;
        let hostRendered = 0;
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
                if (node.tag === 5) hostRendered += 1; // HostComponent
            }
            if (node.child && !bailed) {
                node = node.child;
                continue;
            }
            // Climb to the nearest ancestor with a sibling. `node.return` is null at the top, so
            // guard on it — without that a malformed tree walks off the end and throws inside the
            // commit, which React swallows in its try/catch and turns into a silent zero.
            while (node && node !== start && !node.sibling) node = node.return;
            if (!node || node === start || !node.sibling) break;
            node = node.sibling;
        }

        return { fibers, rendered, mounted, hostRendered };
    };

    if (typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') {
        let nextID = 1;
        const renderers = new Map();
        const hook = {
            isDisabled: false,
            supportsFiber: true,
            supportsFlight: true,
            renderers,
            inject(internals) {
                const id = nextID++;
                renderers.set(id, internals);
                P.rendererCount = renderers.size;

                return id;
            },
            onCommitFiberRoot(id, root) {
                if (P.commitMode === 'off') return;
                const t = performance.now();
                // bundleType 0 does NOT prove a production build — the profiling build emits 0 too.
                // The only reliable discriminator is whether fibers carry timing fields.
                if (P.profilingBuild === null && root && root.current) {
                    P.profilingBuild = typeof root.current.actualDuration === 'number';
                }
                if (P.commitMode === 'stats' && root) {
                    let stats = null;
                    try {
                        stats = walkFibers(root);
                    } catch (e) {
                        P.fiberError = String(e && e.message);
                    }
                    P.commits.push(stats ? { t, ...stats } : { t });
                } else {
                    P.commits.push({ t });
                }
            },
            onPostCommitFiberRoot() {},
            onCommitFiberUnmount() {},
            setStrictMode() {},
            checkDCE() {},
            on() {}, off() {}, emit() {},
            sub() { return () => {}; },
            getFiberRoots() { return new Set(); },
            getInternalModuleRanges() { return []; },
            registerInternalModuleStart() {}, registerInternalModuleStop() {},
        };
        Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
            value: hook, configurable: true, writable: true,
        });
        P.installed = true;
    }

    // ---------------------------------------------------------------- observers
    const support = {
        loaf: false, longtask: false, event: false, shift: false,
        memory: typeof performance.memory === 'object' && performance.memory !== null,
        exposedGc: typeof globalThis.gc === 'function',
        measureUAMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
        crossOriginIsolated: !!window.crossOriginIsolated,
    };
    P.support = support;

    const observe = (type, onEntries, extra) => {
        try {
            new PerformanceObserver(list => onEntries(list.getEntries()))
                .observe({ type, buffered: true, ...(extra || {}) });

            return true;
        } catch (e) {
            return false;
        }
    };

    support.loaf = observe('long-animation-frame', entries => {
        for (const e of entries) {
            P.loaf.push({
                s: e.startTime, d: e.duration,
                // blockingDuration derives from the longest constituent task; it is NOT
                // duration - 50, so never reconstruct it arithmetically.
                b: e.blockingDuration,
                rs: e.renderStart, sls: e.styleAndLayoutStart,
                scripts: (e.scripts || []).map(x => ({
                    d: x.duration,
                    f: x.forcedStyleAndLayoutDuration,
                    invoker: x.invoker,
                    fn: x.sourceFunctionName,
                    url: x.sourceURL,
                })),
            });
        }
    });

    support.longtask = observe('longtask', entries => {
        for (const e of entries) P.longtasks.push({ s: e.startTime, d: e.duration });
    });

    // durationThreshold 16 is the spec minimum Chrome honours. This reaches below the 50ms floor
    // that blinds longtask and LoAF — but only for trusted input.
    support.event = observe('event', entries => {
        for (const e of entries) {
            P.events.push({
                name: e.name, s: e.startTime, d: e.duration,
                ps: e.processingStart, pe: e.processingEnd,
                id: e.interactionId || 0,
            });
        }
    }, { durationThreshold: 16 });

    support.shift = observe('layout-shift', entries => {
        for (const e of entries) {
            P.shifts.push({ s: e.startTime, v: e.value, recent: !!e.hadRecentInput });
        }
    });

    // ---------------------------------------------------------------- helpers
    const nextFrame = () => new Promise(r => requestAnimationFrame(t => r(t)));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const settle = async ms => { await nextFrame(); await nextFrame(); await sleep(ms == null ? 40 : ms); };
    const pick = (sorted, p) =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

    // ---------------------------------------------------------------- aggregation
    const agg = (t0, t9) => {
        const inWin = e => e.s >= t0 - 1 && e.s <= t9;
        const loaf = P.loaf.filter(inWin);
        const lt = P.longtasks.filter(inWin);
        const ev = P.events.filter(inWin);
        const sh = P.shifts.filter(inWin);

        // INP-style: group by interactionId, take max duration, break ties on processing time.
        // interactionId is 0 on input/beforeinput and on the compat mouse events — only
        // pointerdown/up/click and keydown/keypress/keyup carry one, so filtering to 'input'
        // events (the instinct for a text harness) finds nothing.
        const groups = new Map();
        for (const e of ev) {
            if (!e.id) continue;
            const g = groups.get(e.id) || [];
            g.push(e);
            groups.set(e.id, g);
        }
        const interactions = [...groups.values()].map(g => {
            const best = g.slice().sort((a, b) => (b.d - a.d) || ((b.pe - b.ps) - (a.pe - a.ps)))[0];

            return {
                name: best.name,
                durationMs: +best.d.toFixed(1),
                inputDelayMs: +(best.ps - best.s).toFixed(1),
                processingMs: +(best.pe - best.ps).toFixed(1),
                presentationDelayMs: +(best.s + best.d - best.pe).toFixed(1),
            };
        });
        const worst = interactions.reduce((m, i) => (m === null || i.durationMs > m.durationMs ? i : m), null);

        const commits = P.commits.filter(c => c.t >= t0 - 1 && c.t <= t9);
        const withStats = commits.filter(c => typeof c.fibers === 'number');

        return {
            commits: commits.length,
            // present only in stats mode
            fibersCommitted: withStats.length ? sum(withStats, c => c.fibers) : null,
            fibersRendered: withStats.length ? sum(withStats, c => c.rendered) : null,
            fibersMounted: withStats.length ? sum(withStats, c => c.mounted) : null,
            hostFibersRendered: withStats.length ? sum(withStats, c => c.hostRendered) : null,

            loafCount: loaf.length,
            loafDurMs: +sum(loaf, e => e.d).toFixed(1),
            loafBlockingMs: +sum(loaf, e => e.b).toFixed(1),
            loafScriptMs: +sum(loaf, e => sum(e.scripts, s => s.d)).toFixed(1),
            loafForcedLayoutMs: +sum(loaf, e => sum(e.scripts, s => s.f || 0)).toFixed(1),

            longTaskCount: lt.length,
            longTaskTotalMs: +sum(lt, e => e.d).toFixed(1),
            longestTaskMs: +(lt.length ? Math.max.apply(null, lt.map(e => e.d)) : 0).toFixed(1),
            tbtMs: +sum(lt, e => Math.max(0, e.d - 50)).toFixed(1),

            // false means the run produced no trusted input, so any latency number here would be
            // an absence rather than a speed. Never let an invalid run read as a fast one.
            interactionsValid: interactions.length > 0,
            interactionCount: interactions.length,
            inpMs: worst ? worst.durationMs : null,
            inpInputDelayMs: worst ? worst.inputDelayMs : null,
            inpProcessingMs: worst ? worst.processingMs : null,
            inpPresentationMs: worst ? worst.presentationDelayMs : null,

            // Trusted input arms hadRecentInput for 500ms, so standard CLS reads 0 in every
            // interaction run. The inclusive sum is the one that means anything here.
            cls: +sum(sh.filter(s => !s.recent), s => s.v).toFixed(5),
            clsIncludingRecentInput: +sum(sh, s => s.v).toFixed(5),
        };
    };

    // ---------------------------------------------------------------- memory
    const heap = () => (support.memory ? performance.memory.usedJSHeapSize : null);

    const mem = {
        // Allocation pressure genuinely provokes a full GC, but leaves its own garbage behind —
        // which is why every consumer samples a MINIMUM over a window rather than one reading.
        async pressure(rounds) {
            if (support.exposedGc) { globalThis.gc(); await sleep(20); return 'exposedGc'; }
            for (let r = 0; r < (rounds || 4); r++) {
                let junk = [];
                for (let i = 0; i < 6; i++) {
                    const a = new Array(60000);
                    for (let j = 0; j < 60000; j++) a[j] = { j };
                    junk.push(a);
                }
                junk = null;
                await sleep(12);
            }

            return 'pressure';
        },
        async blockMin(samples, gapMs) {
            const n = samples || 8;
            let min = Infinity;
            for (let i = 0; i < n; i++) {
                const v = heap();
                if (v !== null && v < min) min = v;
                await sleep(gapMs || 25);
            }

            return Number.isFinite(min) ? min : null;
        },
        // Calibrate on THIS machine before trusting any threshold: the defaults were derived on
        // one Mac and the noise floor is machine-specific.
        async calibrate(cycles) {
            const series = [];
            for (let i = 0; i < (cycles || 6); i++) {
                await mem.pressure(2);
                series.push(await mem.blockMin(6, 20));
            }
            const deltas = series.slice(1).map((v, i) => v - series[i]);
            const sorted = deltas.slice().sort((a, b) => a - b);

            return { series, medianDeltaBytes: sorted.length ? pick(sorted, 50) : null };
        },
    };

    // Counting-run only. Patching these is safe for COUNTS but taxes the paths it wraps, so never
    // enable it during a timing run — `leakCounters.on()` is called by the cycle primitive and
    // turned off again afterwards.
    const PERSISTENT = () => [window, document, document.documentElement, document.body, window.visualViewport];
    const leakCounters = {
        active: false, added: 0, removed: 0, observers: 0, disconnected: 0, intervals: 0, originals: null,
        on() {
            if (leakCounters.active) return;
            const et = EventTarget.prototype;
            const o = { add: et.addEventListener, rm: et.removeEventListener, si: window.setInterval, ci: window.clearInterval };
            leakCounters.originals = o;
            // Only growth on PERSISTENT targets is a leak signal. Listeners bound to throwaway
            // elements are legitimately never removed — the node dies and takes them with it, and
            // counting those reports a leak on a perfectly clean component.
            et.addEventListener = function (...args) {
                if (PERSISTENT().indexOf(this) !== -1 || !(this instanceof Node)) leakCounters.added += 1;

                return o.add.apply(this, args);
            };
            et.removeEventListener = function (...args) {
                if (PERSISTENT().indexOf(this) !== -1 || !(this instanceof Node)) leakCounters.removed += 1;

                return o.rm.apply(this, args);
            };
            window.setInterval = function (...args) { leakCounters.intervals += 1; return o.si.apply(window, args); };
            for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']) {
                const Orig = window[name];
                if (!Orig) continue;
                o[name] = Orig;
                const Wrapped = function (...args) {
                    const inst = new Orig(...args);
                    leakCounters.observers += 1;
                    const disc = inst.disconnect.bind(inst);
                    inst.disconnect = function () { leakCounters.disconnected += 1; return disc(); };

                    return inst;
                };
                Wrapped.prototype = Orig.prototype;
                window[name] = Wrapped;
            }
            leakCounters.active = true;
        },
        off() {
            const o = leakCounters.originals;
            if (!o) return;
            EventTarget.prototype.addEventListener = o.add;
            EventTarget.prototype.removeEventListener = o.rm;
            window.setInterval = o.si;
            for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']) {
                if (o[name]) window[name] = o[name];
            }
            leakCounters.active = false;
        },
        snapshot() {
            let cssRules = 0;
            try {
                for (const sheet of document.styleSheets) {
                    try { cssRules += sheet.cssRules.length; } catch (e) { /* cross-origin sheet */ }
                }
            } catch (e) { /* ignore */ }

            return {
                listenersNet: leakCounters.added - leakCounters.removed,
                observersNet: leakCounters.observers - leakCounters.disconnected,
                intervals: leakCounters.intervals,
                domNodes: document.querySelectorAll('*').length,
                cssRules,
            };
        },
    };

    // ---------------------------------------------------------------- primitives
    //
    // Each takes {setup, act, reset} plus {k, warmup, mark, settleMs}. `act` is the thing being
    // measured; `reset` returns the app to the pre-act state without being measured.
    const H = {
        nextFrame, sleep, settle, pick, agg, mem, heap, leakCounters, support, walkFibers,

        setCommitMode(mode) { P.commitMode = mode; return P.commitMode; },

        // Size the fiber tree once, so the cost of stats mode is known rather than guessed.
        census() {
            const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            const out = { renderers: P.rendererCount, profilingBuild: P.profilingBuild, roots: [] };
            const el = document.querySelector('[id], body > div');
            const key = el && Object.keys(el).find(k => k.startsWith('__reactContainer'));
            if (key) {
                const fiber = el[key];
                const root = fiber && fiber.stateNode;
                if (root && root.current) out.roots.push(walkFibers(root));
            }

            return out;
        },

        async run(name, i, act, settleMs) {
            const c0 = P.commits.length;
            if (typeof performance.mark === 'function') performance.mark(`${name}-${i}-start`);
            const t0 = performance.now();
            const extra = (await act(i)) || {};
            await settle(settleMs == null ? 200 : settleMs);
            const t9 = performance.now();
            if (typeof performance.mark === 'function') {
                performance.mark(`${name}-${i}-end`);
                try { performance.measure(`${name}-${i}`, `${name}-${i}-start`, `${name}-${i}-end`); } catch (e) { /* ignore */ }
            }
            const commits = P.commits.slice(c0);

            return Object.assign(
                {
                    i,
                    windowMs: +(t9 - t0).toFixed(1),
                    latencyMs: commits.length ? +(commits[commits.length - 1].t - t0).toFixed(1) : null,
                    domNodes: document.querySelectorAll('*').length,
                },
                agg(t0, t9),
                extra,
            );
        },

        // mount / update / interact / navigate share one shape: reset, act, measure.
        async repeat(name, { k = 15, setup, act, reset, settleMs, resetSettleMs } = {}) {
            if (setup) await setup();
            const out = [];
            for (let i = 0; i < k; i++) {
                if (reset) { await reset(i); await settle(resetSettleMs == null ? 90 : resetSettleMs); }
                out.push(await H.run(name, i, act, settleMs));
            }

            return out;
        },

        /**
         * Frame-paced scroll. rAF deltas are a THRESHOLD detector at the display's frame budget —
         * they prove "the budget was blown N times" and prove nothing about magnitude below it
         * (4ms of work per frame is indistinguishable from 0). The budget depends on the refresh
         * rate, so never compare frame counts across machines or displays.
         */
        async scroll(name, { k = 15, el, frames = 60, oneWay = false, setup, settleMs } = {}) {
            if (setup) await setup();
            const target = typeof el === 'function' ? el() : el;
            if (!target) return { error: 'no scroll element' };
            const out = [];
            for (let i = 0; i < k; i++) {
                target.scrollTop = 0;
                await settle(120);
                const c0 = P.commits.length;
                const max = target.scrollHeight - target.clientHeight;
                const stamps = [];
                if (typeof performance.mark === 'function') performance.mark(`${name}-${i}-start`);
                const t0 = performance.now();
                let prev = await nextFrame();
                for (let f = 0; f < frames; f++) {
                    const frac = oneWay
                        ? (f + 1) / frames
                        : (f < frames / 2 ? f / (frames / 2 - 1) : (frames - 1 - f) / (frames / 2 - 1));
                    target.scrollTop = Math.round(max * frac);
                    const t = await nextFrame();
                    stamps.push(+(t - prev).toFixed(2));
                    prev = t;
                }
                await settle(settleMs == null ? 150 : settleMs);
                const t9 = performance.now();
                if (typeof performance.mark === 'function') {
                    performance.mark(`${name}-${i}-end`);
                    try { performance.measure(`${name}-${i}`, `${name}-${i}-start`, `${name}-${i}-end`); } catch (e) { /* ignore */ }
                }
                const sorted = stamps.slice().sort((a, b) => a - b);
                out.push(Object.assign({
                    i, frames: stamps.length,
                    frameP50: pick(sorted, 50), frameP75: pick(sorted, 75), frameP95: pick(sorted, 95),
                    frameMax: sorted[sorted.length - 1],
                    framesOver16: stamps.filter(x => x > 16.7).length,
                    framesOver33: stamps.filter(x => x > 33.4).length,
                    wallMs: +(t9 - t0).toFixed(1),
                    scrollMax: max,
                    domNodes: document.querySelectorAll('*').length,
                }, agg(t0, t9), { commits: P.commits.length - c0 }));
                await settle(120);
            }

            return out;
        },

        /**
         * Leak probe. Mount and unmount repeatedly, sampling the heap minimum after provoking a
         * GC, and report a slope. A single before/after heap reading proves nothing: the counter
         * tracks allocation and GC history, not live data, and detached DOM barely shows in it at
         * all. Confirm any suspicion with take_heapsnapshot before calling it a leak.
         */
        async cycle({ cycles = 24, mount, unmount, sampleEvery = 4, counters = true } = {}) {
            const wasMode = P.commitMode;
            P.commitMode = 'off';
            if (counters) leakCounters.on();
            const samples = [];
            const base = counters ? leakCounters.snapshot() : null;
            for (let i = 0; i < cycles; i++) {
                await mount(i);
                await settle(40);
                await unmount(i);
                await settle(40);
                if (i % sampleEvery === sampleEvery - 1) {
                    await mem.pressure(2);
                    samples.push({
                        cycle: i + 1,
                        heapMinBytes: await mem.blockMin(6, 20),
                        counters: counters ? leakCounters.snapshot() : null,
                    });
                }
            }
            if (counters) leakCounters.off();
            P.commitMode = wasMode;

            const valid = samples.filter(s => typeof s.heapMinBytes === 'number');
            let slopePerCycle = null;
            let driftBytes = null;
            if (valid.length >= 3) {
                const first = valid[0];
                const last = valid[valid.length - 1];
                driftBytes = last.heapMinBytes - first.heapMinBytes;
                slopePerCycle = driftBytes / (last.cycle - first.cycle);
            }
            const last = samples.length ? samples[samples.length - 1].counters : null;

            // Thresholds calibrated on one machine — run mem.calibrate() on this one before
            // trusting them, and treat "no" as "no leak this instrument can see".
            const heapLeak = slopePerCycle !== null && slopePerCycle > 64 * 1024 && driftBytes > 8 * 1024 * 1024;
            const counterLeak = !!(base && last && (
                last.observersNet - base.observersNet >= cycles * 0.5 ||
                last.listenersNet - base.listenersNet >= cycles * 0.5 ||
                last.intervals - base.intervals >= cycles * 0.5
            ));

            return {
                cycles, samples, slopePerCycle, driftBytes,
                baseCounters: base, finalCounters: last,
                verdict: heapLeak || counterLeak ? 'suspected' : 'none-detected',
                evidence: { heapLeak, counterLeak },
                confidence: support.exposedGc ? 'high' : 'medium',
                note: support.exposedGc
                    ? 'exposed gc available; heap minima are trustworthy'
                    : 'no --expose-gc: GC provoked by allocation pressure, so heap minima are noisier. take_heapsnapshot also forces a full GC if you need a clean reading.',
            };
        },
    };

    window.__H = H;

    // Let the adapter seed as soon as the app is ready.
    const poll = setInterval(() => {
        const A = window.__A;
        if (!A || A.seeded) return;
        if (A.ready && !A.ready()) return;
        clearInterval(poll);
        try { A.seed(); A.seeded = true; } catch (e) { window.__seedError = String(e && e.message); }
    }, 25);
    setTimeout(() => clearInterval(poll), 60000);
})();
