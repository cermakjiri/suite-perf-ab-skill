/**
 * One page session of one side — the unit of a perf A/B. Iterations inside a session are
 * correlated (same-build sessions differ up to 2x at 4x), so plan.mjs runs several sessions per
 * side in ABBA order and aggregate.mjs compares session medians.
 *
 *   node run.mjs --run=<name|dir> --side=A --out=<file.json>
 *        [--k=8] [--rates=1,4] [--warmup=2] [--cfg.<key>=<value> ...] [--alt-inject=10]
 *        [--target=web|desktop] [--profile-at=<iter>] [--idle-ms=10000] [--headed]
 *        [--phase-timeout-ms=600000] [--allow-coverage] [--progress=<file>|false] [--repo=<checkout>]
 *        [--role=timing|control|trial|counts] [--pcore=auto|off] [--pcore-free=2] [--pcore-max-wait-s=900]
 *        [--max-ecore-ms=15] [--max-ecore-pct=2] [--pcore-retries=5]
 *
 * Performance cores (rig/pcore.mjs; macOS arm64, on by default for timing, control and trial
 * passes): every measured iteration first waits for free performance cores and a ready check (a
 * short spin of the renderer main thread on a performance core at full clock). If other programs'
 * load (contention) or a demotion of that thread then pushes its work onto efficiency cores, the
 * iteration is discarded at once, the app brought back to the scenario's start (page.js reset(),
 * else after() and the route; checked) and the iteration retried with fresh data (the next it.n).
 * The session fails after --pcore-retries retries of one iteration, or past SPARES (8, RUN.spares
 * in the page) discards in all. Efficiency-core time with performance cores free at normal priority
 * is macOS's own placement: kept, and recorded per iteration (rec.pcore.eSharePct).
 *
 * Per rate: throttle, calibration loop, an idle window (background CPU per second, for
 * idle-correcting long windows), then k iterations of warm-up spin -> before -> measured phases ->
 * after. CDP Performance.getMetrics (thread ticks) is read at every phase boundary, so each phase
 * gets main-thread task/script/layout/style time next to the in-page probe stats.
 *
 * Progress: a JSON snapshot (--progress, default <out dir>/progress/<session>.json) of the stage
 * (queued, emulator, launch, seed, checks, calibrate, idle, warm-up, pcore-wait, ready, measure,
 * profile, done | failed | interrupted), rate, iteration, phase and the wall time of every finished
 * iteration; the same timing lands in the record as meta.timing for later estimates.
 *
 * Parallel runs (rig/locks.mjs): a session first takes the machine slot — one page session or build
 * step per machine, whichever run it belongs to (stage `queued` while another holds it; --slot=off
 * skips it) — and, with device=emulator, the emulator before that. It registers as a user of the
 * clone it serves, so no other run can --rebuild it underneath.
 *
 * Which build ran, without a marker: every bundle inlines its commit (COMMITHASH and the release
 * string). The env check scans the loaded modules for this side's commit (build.mjs's buildSha / sha)
 * and every other side's: another side's commit, or a release string naming another commit, fails
 * the session; neither found yet (the module not loaded) leaves it to the build's offline fingerprint
 * (env.build.verified = 'offline'). A deployed preview (side.url) records the commit it served,
 * which aggregate.mjs uses to refuse pooling sessions from two deployments. run.json `markers` are
 * optional extra proof that a given piece of code is in the bundle.
 *
 * Run with the Bash sandbox off (Chromium/Electron cannot start inside it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RIG, parseArgs, numbers, loadRun, sideOf, resolveIn, repoRoot, readJson, writeJson, writeJsonSafe, log, loadavg, sleep, dur, importScenario, roleResolver, SESSION_FILE, SPARES, passArgv, PROFILES } from './lib.mjs';
import { launch } from './launch.mjs';
import { Pcore } from './pcore.mjs';
import { acquire, holderText, slotOff, cloneOf, useClone } from './locks.mjs';

const T0 = Date.now();
const args = parseArgs();
const run = loadRun(args.run);
const side = sideOf(run, args.side);
if (!args.out) throw new Error('--out=<file.json> is required');
const outFile = path.resolve(args.out);
const repo = repoRoot(args.repo || run.repo);
const scenarioFile = resolveIn(run.dir, run.scenario);
const scenario = await importScenario(scenarioFile);
const target = args.target || run.target || 'web';
const device = run.device || 'synthetic';
const network = run.network || (device === 'synthetic' ? 'none' : 'live');
const cfg = Object.assign({}, scenario.cfg, run.cfg, args.cfg);
const K = Number(args.k ?? scenario.k ?? 8);
const RATES = numbers(args.rates ?? scenario.rates ?? '1,4');
const WARMUP = Number(args.warmup ?? scenario.warmup ?? 2);
const ALT_INJECT = Number(args.altInject || 0);
const PROFILE_AT = args.profileAt === undefined ? -1 : Number(args.profileAt);
const IDLE_MS = Number(args.idleMs ?? scenario.idleMs ?? 10000);
const PHASE_TIMEOUT = Number(args.phaseTimeoutMs ?? 600000);
const phases = (scenario.phases || []).map(p => (typeof p === 'string' ? { name: p } : p));
if (!phases.length) throw new Error(`${scenarioFile}: scenario.phases is empty`);
const RUN_ID = run.id || path.basename(run.dir);
const markerNeedles = Object.keys(side.markers || {});
// the automatic proof: the commit this side's bundle carries (build.mjs), and every other side's
const commitOf = s => (s && (s.buildSha || s.sha)) || null;
const OWN = commitOf(side);
const FOREIGN = [...new Set(Object.entries(run.sides).filter(([k]) => k !== side.key).map(([, s]) => commitOf(s)).filter(c => c && c !== OWN))];
const needles = [...new Set([...markerNeedles, ...(OWN ? [OWN] : []), ...FOREIGN])];
const short = s => (s ? String(s).slice(0, 10) : '–');
// the pass's role (plan.mjs passes it; by hand it is read from the run's plan.json and the out file name)
const ROLE = args.role || (() => {
    let passes = [];
    try {
        passes = readJson(path.join(run.dir, 'plan.json')).passes || [];
    } catch {
        // no plan: inferred from the name and the arguments
    }
    const m = path.basename(outFile).match(SESSION_FILE);

    return roleResolver(passes)(m ? m[1] : path.basename(outFile, '.json'), { cfg, altInject: ALT_INJECT });
})();
// performance-core gate and watchdog (rig/pcore.mjs). The E limit is on efficiency-core time while
// busy; quiet runs showed 0-0.8 ms at 4x and up to 12 ms (2 %) at 1x, a real migration 169 ms
const PCORE = {
    mode: args.pcore === false || args.pcore === 'off' ? 'off' : 'auto',
    need: Number(args.pcoreFree ?? 2),
    maxWaitMs: Number(args.pcoreMaxWaitS ?? 900) * 1000,
    maxEcoreMs: Number(args.maxEcoreMs ?? 15),
    maxEcorePct: Number(args.maxEcorePct ?? 2),
    retries: Number(args.pcoreRetries ?? 5),
};
// a retried iteration takes fresh data (the next it.n): scenarios seed RUN.iterations + RUN.spares + 1
// targets, SPARES (lib.mjs) whatever the flags, so the seeded wallet never depends on them; it is
// also the session's discard budget (--pcore-retries caps one iteration)

// ------------------------------------------------------------------ progress
// Written at once on every stage change and iteration boundary, anything else at most once a
// second, and at least every 30 s as a keepalive (a stale snapshot means a frozen session).
const SESSION = path.basename(outFile, '.json');
const progressFile = args.progress === false ? null : path.resolve(typeof args.progress === 'string' ? args.progress : path.join(path.dirname(outFile), 'progress', `${SESSION}.json`));
const P = {
    session: SESSION, side: side.key, pid: process.pid, startedAt: new Date(T0).toISOString(), updatedAt: null,
    stage: 'start', stageAt: new Date(T0).toISOString(), rate: null, rates: RATES, rateIndex: null, iteration: null, k: K, warmup: WARMUP, phase: null,
    unitsDone: 0, unitsTotal: K * RATES.length, iterMs: {},
};
let lastWrite = 0;
let trailing = null;
const writeProgress = () => {
    clearTimeout(trailing);
    trailing = null;
    lastWrite = Date.now();
    P.updatedAt = new Date(lastWrite).toISOString();
    // never fails the session: the record is what counts
    writeJsonSafe(progressFile, P);
};
const progress = (patch, now = false) => {
    // once interrupted, the snapshot keeps saying so while the session winds down
    if (P.stage === 'interrupted') return;
    if (patch.stage !== undefined && patch.stage !== P.stage) {
        now = true;
        P.stageAt = new Date().toISOString();
    }
    Object.assign(P, patch);
    if (!progressFile) return;
    const wait = 1000 - (Date.now() - lastWrite);
    if (now || wait <= 0) writeProgress();
    else trailing ??= setTimeout(writeProgress, wait).unref();
};
if (progressFile) {
    setInterval(() => {
        if (Date.now() - lastWrite >= 25000) writeProgress();
    }, 5000).unref();
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
        progress({ stage: 'interrupted', error: sig }, true);
        // Playwright's own handler closes the browser and exits; before the launch nothing else listens
        if (!process.listenerCount(sig)) process.exit(code);
    });
}
// meta.timing: what plan.mjs and later estimates learn from (overhead = everything but iterations and
// the wait for the machine slot, which depends on other runs)
let QUEUE_MS = 0;
const timing = () => {
    const durationMs = Date.now() - T0;
    const iterTotal = Object.values(P.iterMs).flat().reduce((s, x) => s + x, 0);

    return { startedAt: P.startedAt, durationMs, queueMs: QUEUE_MS, overheadMs: durationMs - QUEUE_MS - iterTotal, iterMs: P.iterMs };
};
// a lock wait as the progress snapshot's `queued` stage
const queued = (lock, what) => w => progress({ stage: 'queued', queue: { lock, what, holder: holderText(w.holder), ahead: w.ahead, since: new Date(Date.now() - w.waitedMs).toISOString() } });

const pageFile = path.resolve(path.dirname(scenarioFile), scenario.page || 'page.js');
const initScript = [
    'window.Playwright = true;',
    `window.__CFG = ${JSON.stringify(cfg)};`,
    `window.__RUN = ${JSON.stringify({ k: K, rates: RATES, iterations: K * RATES.length, spares: SPARES, side: side.key, target, device })};`,
    fs.readFileSync(path.join(RIG, 'page', 'core.js'), 'utf8'),
    fs.readFileSync(pageFile, 'utf8'),
].join('\n');

const sideLog = (...a) => log(side.key, ...a);
const withTimeout = (p, ms, what) => {
    let t;

    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
};
const PERF = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize'];
const diffMetrics = (a, b) => {
    const ms = k => +((b[k] - a[k]) * 1000).toFixed(1);
    const task = ms('TaskDuration');
    const script = ms('ScriptDuration');
    const layout = ms('LayoutDuration');
    const style = ms('RecalcStyleDuration');

    return {
        taskMs: task, scriptMs: script, layoutMs: layout, styleMs: style,
        otherMs: +(task - script - layout - style).toFixed(1),
        layouts: b.LayoutCount - a.LayoutCount, styleRecalcs: b.RecalcStyleCount - a.RecalcStyleCount,
        heapEndMiB: +(b.JSHeapUsedSize / 1048576).toFixed(1),
    };
};

// emulator.prepare: false = use whatever is on the bridge (a prepared emulator, a physical device)
const USES_EMULATOR = device === 'emulator' && !(run.emulator && run.emulator.prepare === false);

/** The locks a session holds (rig/locks.mjs), then the session itself. */
const main = async () => {
    const held = [];
    const t0 = Date.now();
    const who = { kind: 'session', run: RUN_ID, label: `${SESSION} (${side.key})`, role: ROLE };
    try {
        // no other run may --rebuild the clone this session serves — from the moment it is queued
        held.push({ release: useClone(cloneOf(target === 'desktop' ? side.desktop : side.web), who) });
        // the emulator before the machine: nobody holds the machine while waiting for the emulator
        if (USES_EMULATOR) held.push(await acquire('emulator', who, { onWait: queued('emulator') }));
        if (!slotOff(args.slot)) held.push(await acquire('machine', who, { onWait: queued('machine') }));
        QUEUE_MS = Date.now() - t0;
        if (QUEUE_MS >= 1000) sideLog(`waited ${dur(QUEUE_MS)} for the ${USES_EMULATOR ? 'emulator and the machine' : 'machine'}`);
        progress({ queueMs: QUEUE_MS });
        await session();
    } finally {
        for (const h of held.reverse()) h.release();
    }
};

const session = async () => {
    const started = new Date().toISOString();
    if (USES_EMULATOR) {
        progress({ stage: 'emulator' });
        const tenv = await import('./tenv.mjs');
        sideLog('emulator', JSON.stringify(await tenv.prepare(run.emulator || {})));
    }
    progress({ stage: 'launch' });
    const L = await launch(target, { repo, side, initScript, headed: !!args.headed, device, network, tag: `${run.id || path.basename(run.dir)}-${side.key}` });
    const { page, cdp } = L;
    const diag = [];
    page.on('console', m => {
        if ((m.type() === 'error' || m.type() === 'warning') && diag.length < 200) diag.push(`${m.type()}: ${m.text().slice(0, 240)}`);
    });
    page.on('pageerror', e => {
        if (diag.length < 200) diag.push(`pageerror: ${String(e).slice(0, 300)}`);
    });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const out = {
        meta: {
            run: RUN_ID, side: side.key, label: side.label, rev: side.rev, sha: side.sha, buildSha: OWN, variant: side.variant || null, profile: side.profile || null,
            build: target === 'desktop' ? side.desktop : side.web || side.url, target, device, network, slot: slotOff(args.slot) ? 'off' : 'machine',
            scenario: scenario.name, cfg, k: K, rates: RATES, warmup: WARMUP, idleMs: IDLE_MS, altInject: ALT_INJECT, started,
            // the pass arguments, so plan.mjs can tell a finished session of another configuration from this one
            argv: passArgv(process.argv.slice(2)),
            // the spare targets the scenario seeded: plan.mjs never pools sessions seeded differently
            spares: SPARES,
            host: { cpu: os.cpus()[0] && os.cpus()[0].model, ncpu: os.cpus().length, memGiB: Math.round(os.totalmem() / 1073741824), os: `${os.platform()} ${os.release()}`, node: process.version, load: loadavg() },
            browser: L.version,
        },
        complete: false,
        env: null, seed: null, post: null, calib: {}, idle: {}, runs: [], end: null, hits: L.hits, diag,
    };
    const save = () => {
        out.meta.timing = timing();
        writeJson(outFile, out);
    };
    const fail = msg => {
        out.error = msg;
        save();
        throw new Error(msg);
    };
    let pc = null;

    try {
        sideLog('open', L.base, out.meta.build, JSON.stringify(cfg));
        await L.open();
        await page.waitForFunction(() => window.__A && window.__H && (window.__A.ready ? window.__A.ready() : !!window.__H.store()), null, { timeout: 90000 });
        progress({ stage: 'seed' });
        out.seed = await ev(() => (window.__A.seed ? window.__A.seed() : null));
        sideLog('seed', JSON.stringify(out.seed));
        const t0 = Date.now();
        try {
            await page.waitForFunction(() => (window.__A.isReady ? window.__A.isReady() : window.__H.suiteReady()), null, { timeout: 180000, polling: 250 });
        } catch (e) {
            const s = await ev(() => ({ lifecycle: window.__H.store() && window.__H.state().suite.lifecycle, text: document.body.innerText.slice(0, 300) })).catch(() => null);
            fail(`app did not get ready: ${JSON.stringify(s)}\n${diag.slice(0, 15).join('\n')}`);
        }
        sideLog(`ready ${Date.now() - t0} ms after seeding${L.launches && L.launches() > 1 ? ` (desktop: ${L.launches()} launches until the probes caught the first load)` : ''}`);
        out.post = await ev(() => (window.__A.postInit ? window.__A.postInit() : null));
        sideLog('postInit', JSON.stringify(out.post).slice(0, 400));
        const ctxBase = { page, cdp, context: L.context, cfg, side, target, ev };
        if (scenario.nodeSetup) await scenario.nodeSetup(ctxBase);
        if (scenario.route) sideLog('route', await ev(r => window.__H.goto(r.name, r.params), typeof scenario.route === 'string' ? { name: scenario.route } : scenario.route));
        await ev(() => window.__H.settle(1000));

        progress({ stage: 'checks' });
        out.env = await ev(n => Object.assign(window.__H.env(n), { verify: window.__A.verify ? window.__A.verify() : null }), needles);
        out.env.desktopLaunches = L.launches ? L.launches() : null;
        sideLog('env', JSON.stringify(Object.assign({}, out.env, { verify: undefined, support: undefined, build: undefined })));
        if (out.env.coverageFiles !== 0 && !args.allowCoverage) fail(`build is coverage-instrumented (${out.env.coverageFiles} files) — not comparable; rebuild without INSTRUMENT_CODE`);
        if (!out.env.hook || out.env.renderers < 1) fail('React hook did not install before react-dom (commit counts would read 0)');
        // which build ran: this side's commit in the loaded modules, and no other side's
        const b = out.env.build || {};
        const foreign = FOREIGN.filter(c => out.env.markers[c] > 0 || b.commit === c);
        if (foreign.length) fail(`side ${side.key}: the running bundle carries the commit of ${foreign.map(c => `side ${Object.keys(run.sides).find(k => commitOf(run.sides[k]) === c)} (${short(c)})`).join(', ')} — wrong build`);
        if (OWN && b.commit && b.commit !== OWN) fail(`side ${side.key}: the running bundle was built from ${short(b.commit)}, this side is ${short(OWN)} — a stale or wrong build`);
        const verified = !OWN ? null : out.env.markers[OWN] > 0 || b.commit === OWN ? true : 'offline';
        out.env.build = Object.assign({}, b, { expected: OWN, verified });
        const codesign = side.profile && PROFILES[side.profile] ? PROFILES[side.profile].codesign : null;
        if (codesign !== null && b.release && b.release.codesign !== codesign) fail(`side ${side.key}: the running bundle is ${b.release.codesign ? '' : 'not '}a codesign build, its ${side.profile} profile says otherwise — a stale build`);
        sideLog(`build ${b.commit ? short(b.commit) : 'commit not seen'}${b.release ? ` (${b.release.version}.${b.release.suiteType}${b.release.codesign ? '.codesign' : ''})` : ''} · ${verified === true ? "this side's commit ✓" : verified === 'offline' ? 'not in a loaded module yet: the build fingerprint vouches for it' : 'recorded (no expected commit: a deployed preview)'} · compiler output in ${b.sentinelModules ?? '–'} of ${b.modules ?? '–'} loaded modules`);
        for (const [needle, want] of Object.entries(side.markers || {})) {
            if (out.env.markers[needle] !== want) fail(`side ${side.key}: marker ${JSON.stringify(needle)} found in ${out.env.markers[needle]} modules, expected ${want} — wrong build?`);
        }
        if (scenario.check) {
            const problem = scenario.check(out.env, out);
            if (problem) fail(`scenario check: ${problem}`);
        }

        await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }).catch(() => cdp.send('Performance.enable'));
        const metrics = async () => {
            const { metrics: listed } = await cdp.send('Performance.getMetrics');
            const o = {};
            for (const m of listed) if (PERF.includes(m.name)) o[m.name] = m.value;

            return o;
        };

        // performance cores (rig/pcore.mjs): timing, control and trial passes on macOS arm64
        pc = new Pcore(Object.assign({ role: ROLE, target, root: process.pid, log: (...a) => sideLog(...a) }, PCORE));
        if (await pc.init()) {
            sideLog(`pcore: on (${ROLE} pass) — ${pc.meta.machine.pIndices ? `performance cores are os.cpus() ${pc.meta.machine.pIndices.join(',')}${pc.meta.machine.verified ? '' : ' (assumed)'}, ` : ''}need ${PCORE.need} free, efficiency time under contention or demotion (priority < ${pc.basePri()}) ≤ max(${PCORE.maxEcoreMs} ms, ${PCORE.maxEcorePct} %), ${PCORE.retries} retries`);
        } else {
            sideLog(`pcore: off (${pc.meta.reason})`);
        }
        out.meta.pcore = pc.meta;
        // the gate was meant to run: measured iterations it misses later are flagged `gate: 'off'`
        const gatedSession = pc.on;
        Object.assign(P, { discards: 0, discardLog: [], gateWaitMs: 0, gate: null });
        const gateFor = async (rate, budgetMs) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    const gate = await pc.gate({
                        ev, rate, budgetMs,
                        onWait: w => progress(w.stage === 'pcore-wait'
                            ? { stage: 'pcore-wait', gate: { free: w.free, total: w.total, need: w.need, since: new Date(w.since).toISOString() } }
                            : { stage: 'ready', gate: { attempts: w.attempts, since: new Date(w.since).toISOString(), share: w.share, ghz: w.ghz, ref: w.ref } }),
                    });
                    // the watched renderer, for status and for anyone who wants to check it by hand
                    if (pc.meta.renderer && (!P.renderer || P.renderer.pid !== pc.meta.renderer.pid)) progress({ renderer: pc.meta.renderer });

                    return gate;
                } catch (e) {
                    const why = String(e.message || e).split('\n')[0];
                    // a watcher that died or stopped answering: the gate finds the renderer again, once
                    if (attempt === 0) {
                        sideLog(`pcore: ${why} — trying the gate once more`);
                        continue;
                    }
                    pc.meta.enabled = false;
                    pc.meta.reason = `off mid-session: ${why}`;
                    sideLog(`pcore: ${pc.meta.reason} — the remaining measured iterations are flagged gate: off`);

                    return null;
                }
            }
        };
        // after a discarded attempt: the aborted work finishes, then the app goes back to the scenario's
        // start — its reset(), else after() and the start route — and the runner checks it got there;
        // nothing of the attempt is recorded, and an iteration that would start elsewhere never runs
        const START = scenario.route ? (typeof scenario.route === 'string' ? { name: scenario.route } : scenario.route) : null;
        const settleDiscarded = async (it, pending) => {
            if (pending) await Promise.race([pending.catch(() => {}), sleep(15000)]);
            await ev(ms => window.__H.drainAborted(ms), 60000).catch(() => null);
            await ev(() => window.__H.clearAbort()).catch(() => {});
            const from = await ev(() => window.__H.routeName()).catch(() => null);
            const how = await ev(async ([x, route]) => {
                const A = window.__A;
                const H = window.__H;
                if (A.reset) return { by: 'reset()', ok: (await A.reset(x)) !== false };
                if (A.after) await A.after(x);
                if (route && H.routeName() !== route.name) await H.goto(route.name, route.params);

                return { by: A.after ? 'after() + goto' : 'goto', ok: true };
            }, [it, START]).catch(e => ({ by: 'reset', ok: false, error: String(e.message || e).split('\n')[0] }));
            const back = how.ok && (await page.waitForFunction(r => (!r || window.__H.routeName() === r) && window.__H.suiteReady(), START && START.name, { timeout: 30000, polling: 100 }).then(() => true, () => false));
            const to = await ev(() => window.__H.routeName()).catch(() => null);
            sideLog(`reset after the discard by ${how.by}: route ${from} → ${to}${START ? ` (start ${START.name})` : ''}${back ? '' : ' — NOT at the start'}`);
            if (!back) throw new Error(`after a discarded attempt the app could not be brought back to its start (${how.error || `on ${to}${START ? `, start ${START.name}` : ''}, Suite ${back === false ? 'not ready' : 'unknown'}`}) — the session stops rather than measure an iteration that starts elsewhere`);
            await ev(() => window.__H.settle(200)).catch(() => {});
        };
        // what pushed a discarded attempt onto efficiency cores: other programs' load (contention, with
        // the performance capacity free meanwhile, this renderer left out) or a demotion of the thread
        const nP = pc.meta.machine && pc.meta.machine.pIndices ? pc.meta.machine.pIndices.length : null;
        const freeText = f => (typeof f === 'number' ? `${f} of ${nP} performance cores free` : 'free performance capacity unknown');
        const discardOf = x => {
            if (x.watcher) return { cause: 'watcher', why: `the counter watcher failed (${x.watcher})` };
            const how = [x.eDemotionMs > 0 && `while demoted (priority ${x.basePri} → ${x.minPri})`, x.eContentionMs > 0 && `under contention (${freeText(x.contentionFreeP)})`].filter(Boolean).join(' and ');

            return { cause: x.eDemotionMs >= x.eContentionMs ? 'demotion' : 'contention', why: `main thread ran ${x.eCountedMs} ms on efficiency cores ${how} (${x.eJudgedMs} ms judged of ${x.cpuMs} ms CPU)` };
        };
        const eCause = ds => {
            const demoted = ds.filter(d => d.cause === 'demotion');
            const contended = ds.filter(d => d.cause === 'contention');
            const failed = ds.filter(d => d.cause === 'watcher');
            const known = contended.filter(d => typeof d.contentionFreeP === 'number');
            const w = known.reduce((s, d) => s + Math.max(d.eContentionMs || 0, 0.1), 0);
            const free = known.length ? +(known.reduce((s, d) => s + d.contentionFreeP * Math.max(d.eContentionMs || 0, 0.1), 0) / w).toFixed(1) : null;

            return [
                demoted.length && `${demoted.length} demoted (priority ${Math.max(...demoted.map(d => d.basePri ?? -1))} → ${Math.min(...demoted.map(d => d.minPri ?? 99))}): a hidden or occluded window, App Nap or a background policy`,
                contended.length && `${contended.length} under contention (${freeText(free)} meanwhile): other programs' load`,
                failed.length && `${failed.length} with a failed counter watcher`,
            ].filter(Boolean).join('; ') || 'unknown cause';
        };

        let n = 0;
        for (const [rateIndex, rate] of RATES.entries()) {
            progress({ stage: 'calibrate', rate, rateIndex, iteration: null, phase: null });
            await cdp.send('Emulation.setCPUThrottlingRate', { rate });
            out.calib[rate] = await ev(() => window.__H.calib());
            progress({ stage: 'idle' });
            const mi0 = await metrics();
            const idle = await ev(ms => window.__H.idleWindow(ms), IDLE_MS);
            out.idle[rate] = Object.assign(idle, diffMetrics(mi0, await metrics()));
            sideLog(`${rate}x calib ${out.calib[rate].join('/')} ms; idle ${IDLE_MS} ms: task ${out.idle[rate].taskMs} ms, commits ${idle.commits}`);
            P.iterMs[rate] ??= [];
            for (let i = 0; i < K; i++) {
                const ti = Date.now();
                const profiling = PROFILE_AT === i && rate === RATES[0];
                // warm-up = the iterations aggregate discards; the measured ones wait for a performance core
                const stage = profiling ? 'profile' : i < WARMUP ? 'warm-up' : 'measure';
                const inject = ALT_INJECT ? (i % 2 ? ALT_INJECT : 0) : Number(cfg.inject || 0);
                let budgetMs = PCORE.maxWaitMs;
                let waitMs = 0;
                let ready = 0;
                let retry = 0;
                let kept = null;
                let it;
                let rec;
                const measured = i >= WARMUP || profiling;
                for (;;) {
                    progress({ stage, iteration: i, phase: 'before' }, true);
                    const gate = pc.on && measured ? await gateFor(rate, budgetMs) : null;
                    if (gate) {
                        budgetMs = Math.max(0, budgetMs - gate.waitMs);
                        waitMs += gate.waitMs;
                        ready += gate.attempts;
                        P.gateWaitMs += gate.waitMs;
                        progress({ stage, gate: null });
                        // no measurement off the performance cores: a gate that cannot be met ends the session
                        if (gate.timeout) throw new Error(`no performance core for ${SESSION} ${rate}x it ${i + 1}/${K}: ${gate.reason} — the session stops rather than measure there (plan.mjs --retries runs it again)`);
                        if (gate.waitMs >= 1000) sideLog(`${rate}x it ${i + 1}/${K}: waited ${dur(gate.waitMs)} for a performance core · ${gate.attempts} ready checks, the last ${Math.round(gate.check.share * 100)} % on P at ${gate.check.ghz} GHz`);
                    }
                    await ev(v => { window.__H.CFG.inject = v; }, inject);
                    it = { i, n: n++, rate };
                    rec = { rate, iter: i, n: it.n, inject, load1m: loadavg()[0], phases: {} };
                    // meant to be gated, but the gate turned off mid-session: aggregate leaves it out of "gated"
                    if (!gate && measured && gatedSession) rec.gate = 'off';
                    // the watchdog: too much efficiency-core time ends the attempt at once
                    let hit = null;
                    let pending = null;
                    let profiler = false;
                    const stopped = Promise.withResolvers();
                    stopped.promise.catch(() => {});
                    if (gate) {
                        pc.arm(gate.base, rate, x => {
                            hit = x;
                            stopped.reject(new Error('discarded'));
                            ev(reason => window.__H.abort(reason), 'main thread on efficiency cores').catch(() => {});
                        });
                    }
                    try {
                        rec.before = await ev(x => (window.__A.before ? window.__A.before(x) : null), it);
                        progress({ phase: 'spin' });
                        await ev(() => window.__H.warm());
                        if (profiling && !hit) {
                            await cdp.send('Profiler.enable');
                            await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
                            await cdp.send('Profiler.start');
                            profiler = true;
                        }
                        for (const ph of phases) {
                            if (hit) break;
                            progress({ phase: ph.name });
                            const m0 = await metrics();
                            let r;
                            if (ph.node) {
                                await ev(() => window.__H.windowStart());
                                pending = ph.node(Object.assign({ it }, ctxBase));
                                const own = await withTimeout(Promise.race([pending, stopped.promise]), PHASE_TIMEOUT, `phase ${ph.name}`);
                                r = Object.assign(await ev(() => window.__H.windowEnd()), own || {});
                            } else {
                                r = await withTimeout(ev(([name, x]) => window.__H.runPhase(name, x), [ph.name, it]), PHASE_TIMEOUT, `phase ${ph.name}`);
                            }
                            if (hit) break;
                            rec.phases[ph.name] = Object.assign(r, diffMetrics(m0, await metrics()));
                            if (r.error) break;
                        }
                    } catch (e) {
                        if (!hit) throw e;
                    }
                    // the measured part is over: an exact reading decides between keeping and discarding; a
                    // watcher that failed cannot vouch for the iteration, so it is discarded too
                    if (gate && !hit) {
                        try {
                            kept = await pc.disarm();
                            if (kept.breach) hit = kept;
                        } catch (e) {
                            hit = { watcher: String(e.message || e).split('\n')[0] };
                        }
                    }
                    if (profiler) {
                        progress({ phase: 'write profile' });
                        const { profile } = await cdp.send('Profiler.stop');
                        await cdp.send('Profiler.disable');
                        if (!hit) {
                            const pf = outFile.replace(/\.json$/, `.r${rate}i${i}.cpuprofile`);
                            fs.writeFileSync(pf, JSON.stringify(profile));
                            sideLog('profile written', pf);
                        }
                    }
                    if (!hit) break;
                    retry += 1;
                    // eMs: the efficiency-core time that counted (under contention or demoted); eJudgedMs: all
                    // the watchdog judged; eTotalMs: all of it, isolated wake-ups too
                    const { cause, why } = discardOf(hit);
                    const d = {
                        rate, iter: i, n: it.n, cause, eMs: hit.eCountedMs ?? null, eJudgedMs: hit.eJudgedMs ?? null, eTotalMs: hit.eMs ?? null, cpuMs: hit.cpuMs ?? null,
                        eContentionMs: hit.eContentionMs ?? null, contentionFreeP: hit.contentionFreeP ?? null, eDemotionMs: hit.eDemotionMs ?? null, basePri: hit.basePri ?? null, minPri: hit.minPri ?? null,
                        freeP: hit.freeP ?? null, eFreeP: hit.eFreeP ?? null, eFreeMinP: hit.eFreeMinP ?? null, watcher: hit.watcher || undefined, why, retry, at: new Date().toISOString(),
                    };
                    pc.meta.discards.push(d);
                    P.discards += 1;
                    P.discardLog = P.discardLog.concat(Object.assign({ iteration: i, retries: PCORE.retries }, d)).slice(-20);
                    sideLog(`${rate}x it ${i + 1}/${K} discarded — ${why} · ${retry > PCORE.retries ? 'no retries left' : `retry ${retry}/${PCORE.retries}`}`);
                    progress({ phase: 'settle' }, true);
                    await settleDiscarded(it, pending);
                    if (retry > PCORE.retries) {
                        const mine = pc.meta.discards.filter(x => x.rate === rate && x.iter === i);
                        throw new Error(`renderer main thread keeps landing on efficiency cores (${SESSION} ${rate}x it ${i + 1}/${K}: ${retry} discards, the last: ${why}) — ${eCause(mine)}`);
                    }
                    // every retry takes a spare target (the next it.n): past the spares, the session stops
                    if (P.discards > SPARES) {
                        throw new Error(`too many discarded iterations: ${P.discards} in this session, more than its ${SPARES} spare targets — ${eCause(pc.meta.discards)} (plan.mjs --retries runs the session again)`);
                    }
                    kept = null;
                }
                if (kept) {
                    // the shares are the main thread's only in thread scope; process scope counts the whole renderer
                    const thread = pc.meta.scope === 'thread';
                    pc.meta.kept.push({
                        rate, iter: i, scope: pc.meta.scope, pMs: kept.pMs, eMs: kept.eMs, eJudgedMs: kept.eJudgedMs, eCountedMs: kept.eCountedMs, eHeadMs: kept.eHeadMs, cpuMs: kept.cpuMs,
                        eSharePct: thread ? kept.eSharePct : null, eJudgedSharePct: thread ? kept.eJudgedSharePct : null, eContentionMs: kept.eContentionMs, eDemotionMs: kept.eDemotionMs, basePri: kept.basePri, minPri: kept.minPri,
                        pGHz: kept.pGHz, freeP: kept.freeP, eFreeP: kept.eFreeP, eFreeMinP: kept.eFreeMinP, eSamples: kept.eSamples, waitMs, ready, retries: retry,
                    });
                    // macOS's own placement, kept: aggregate reports it per side like any metric (pcore.eSharePct)
                    if (thread) rec.pcore = { eSharePct: kept.eSharePct, eJudgedSharePct: kept.eJudgedSharePct };
                }
                progress({ phase: 'after' });
                rec.after = await ev(x => (window.__A.after ? window.__A.after(x) : null), it);
                const errors = Object.entries(rec.phases).filter(([, p]) => p.error).map(([n, p]) => `${n}: ${p.error.split('\n')[0]}`);
                const verdict = scenario.valid ? scenario.valid(rec, cfg) : true;
                rec.problem = errors.length ? errors.join('; ') : verdict === true || verdict === undefined ? null : String(verdict || 'invalid');
                out.runs.push(rec);
                P.iterMs[rate].push(Date.now() - ti);
                P.unitsDone += 1;
                save();
                progress({ phase: null }, true);
                const phaseLine = Object.entries(rec.phases).map(([n, p]) => `${n} ${p.ms} ms task ${p.taskMs}`).join(' | ');
                sideLog(`${rate}x #${i}${inject ? ` +${inject}ms` : ''}: ${phaseLine}${scenario.line ? ' ' + scenario.line(rec) : ''}${kept ? ` · E ${kept.eSharePct} % of ${kept.cpuMs} ms CPU (${kept.eMs} ms; judged ${kept.eJudgedMs}, counted ${kept.eCountedMs}${kept.eJudgedMs > kept.eCountedMs ? ' — the rest macOS placement' : ''}${kept.eSamples ? `, ${kept.eFreeP} P free next to it` : ''}), P ${kept.pGHz} GHz` : ''}${rec.gate ? ` · gate: ${rec.gate}` : ''}${rec.problem ? ' PROBLEM ' + rec.problem : ''}`);
            }
        }
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        out.end = await ev(() => (window.__A.verify ? window.__A.verify() : null));
        out.complete = true;
        out.meta.finished = new Date().toISOString();
        save();
        progress({ stage: 'done', rate: null, rateIndex: null, iteration: null, phase: null });
        sideLog('written', outFile);
    } catch (e) {
        // the record keeps why the session failed (e.g. a renderer that keeps landing on efficiency cores)
        if (!out.error) {
            out.error = String(e.message || e).split('\n')[0];
            save();
        }
        throw e;
    } finally {
        if (pc) pc.close();
        await L.close();
    }
};

await main().catch(e => {
    // an interrupted session fails on the closed browser next: keep the cause
    if (P.stage !== 'interrupted') progress({ stage: 'failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
    console.error(e?.stack ?? e);
    process.exit(1);
});
