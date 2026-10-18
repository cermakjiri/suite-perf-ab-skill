/**
 * Execute a run's plan: every pass's sessions in the given side order (ABBA by default), one
 * process per session, sequentially. Resumable — a session whose output is complete is skipped —
 * so a failed or interrupted plan is continued by running the same command again. Aggregates at
 * the end (aggregate.mjs --brief; the full tables: aggregate.mjs --run=<id>).
 *
 *   node plan.mjs --run=<name|dir> [--plan=<file>] [--only=pass1,pass2] [--dry]
 *        [--retries=1] [--heartbeat=30] [--repo=<checkout>] [--size-pilot=off] [--first-iter-x=5]
 *        [--pcore=auto|off] [--pcore-free=2] [--pcore-max-wait-s=900] [--max-ecore-ms=15]
 *        [--max-ecore-pct=2] [--pcore-retries=5]        (passed to every session: run.mjs)
 *        [--max-load=6] [--max-wait-s=900]                (superseded by the performance-core gate)
 *
 * Every measured iteration of a timing, control or trial pass waits for a performance core and
 * is discarded and retried when contention or a demotion pushes its renderer thread onto
 * efficiency cores (rig/pcore.mjs), so a busy machine mostly costs waiting (contention under
 * ~100 ms goes unseen: quieter is still cleaner); --max-load (wait for a low load average before
 * each session) stays for machines without the gate. A session whose gate cannot be met fails;
 * --retries runs it again.
 *
 * Power: before every timing or control session the plan checks the power source (lib.mjs
 * powerState: pmset). On battery or in Low Power Mode it waits instead of measuring — stage
 * `power-wait` in out/plan-status.json, status.mjs and the heartbeat line; counts and trial passes
 * still run. Each session records its power source (meta.power), and aggregate never pools AC and
 * battery sessions in one timing pass. PERF_AB_POWER=ac|battery|lowpower overrides the reading.
 *
 * Fail fast, never at the cost of precision:
 *   size pilot  before timing, one AB pair (k 1, 4x, warm-up 0, role trial: never pooled into a
 *               verdict) for every distinct cfg + target of the selected timing and control passes
 *               that no trial pass of the plan and no finished session has measured (`pilot-<pass>`).
 *               Its iteration time sizes those passes' ETAs. --size-pilot=off skips it.
 *   timeout     a session that ended on run.mjs's phase timeout (exit 3: "drain > 10:00") is not run
 *               again with the same configuration: its pass is marked failed with the reason — and
 *               when a trial stood in for other passes' workload (a size pilot), those passes too —
 *               and the plan goes on with the other passes, then reports it at the end.
 *   first       the first iteration of a pass that runs past --first-iter-x (5) times the iteration
 *               time of its size pilot (waits for performance cores not counted) stops: its pass is
 *               marked failed the same way. Single iterations are never dropped or trimmed.
 *
 * plan.json: { "passes": [ { "name": "main", "order": "ABBA", "args": { "k": 8, "rates": "1,4",
 *   "altInject": 10, "target": "desktop", "cfg": { "pages": 40 } } },
 *   { "name": "more", "extends": "main", "order": "ABBA", "optional": true } ] }
 * An optional pass runs only when --only names it. A pass that extends another runs with that
 * pass's args (its own merged over them) and continues its session numbers (main-5-A …), so
 * aggregate pools its sessions into that pass.
 *
 * Builds: a session made from another commit than its side's current build (re-pinned or rebuilt
 * since) is stale and runs again. A deployed preview (side.url) that serves another commit than the
 * side's earlier sessions (develop redeployed mid-run) stops the plan: those numbers cannot pool.
 * A target build.mjs found code-identical between the sides (run.json bundles) is flagged: timing it
 * measures nothing the change does.
 *
 * Parallel runs: every session waits for the machine slot (rig/locks.mjs) — sessions of several runs
 * interleave, one at a time — and the wait shows as stage `queued`; --slot=off goes to every session.
 *
 * Logs: the plan's whole output is appended to out/plan.log (a header per start) whatever stdout is
 * redirected to; every attempt of a session logs to out/<session>.attempt<n>.log, the latest copied
 * to out/<session>.log; plan-status.json keeps each failed attempt's error.
 *
 * Progress, in the log and in out/plan-status.json (written atomically): the estimate up front, a
 * line per session start and end, and a heartbeat every --heartbeat seconds and on every stage or
 * rate change of the running session (read from its out/progress/<session>.json), each with the
 * plan's done/total and ETA; per pass (plan-status `passes`) its sessions, state, failure reason and
 * expected finish. Estimates come from finished sessions of the same workload (lib.mjs etaModel; the
 * size pilot's for a pass not run yet), re-estimated from the running session's own iterations; one
 * from another workload is marked rough (~). Until a session has finished the ETA says so.
 * `node status.mjs --run=<id>` reads the same files at once; `--events` prints a line per pass change
 * and on the end state (for the Monitor tool).
 *
 * Start it with run_in_background (sandbox off) and wait for the completion notification instead
 * of polling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RIG, parseArgs, list, numbers, loadRun, resolveIn, importScenario, readJson, writeJsonSafe, tryJson, exists, home, log, loadavg, sleep, dur, clock, alive, progressText, timingHistory, etaModel, estText, roleResolver, planSessions, cfgKey, SPARES, passArgv, sideCommit, sessionCommit, SESSION_FILE, powerState } from './lib.mjs';
import { queue, holderText } from './locks.mjs';
import { identicalTargets } from './bundlediff.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const RUN_ID = run.id || path.basename(run.dir);
const OUT = path.join(run.dir, 'out');
fs.mkdirSync(OUT, { recursive: true });
// the whole output also goes to out/plan.log (appended, a header per start), wherever stdout is redirected
if (!args.dry) {
    const fd = fs.openSync(path.join(OUT, 'plan.log'), 'a');
    for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => {
            try {
                fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
            } catch {
                // the log is a copy: it never fails the plan
            }

            return write(chunk, ...rest);
        };
    }
    fs.writeSync(fd, `\n===== plan.mjs ${new Date().toISOString()} · pid ${process.pid} · ${process.argv.slice(2).join(' ')}\n`);
}
const planFile = path.resolve(args.plan || path.join(run.dir, 'plan.json'));
if (!exists(planFile)) throw new Error(`no plan at ${planFile} — copy ${path.join(RIG, 'templates', 'plan.json')}`);
const plan = readJson(planFile);
const only = list(args.only);
const MAX_LOAD = args.maxLoad === undefined ? null : Number(args.maxLoad);
const MAX_WAIT_S = Number(args.maxWaitS ?? 900);
const RETRIES = Number(args.retries ?? 1);
const HEARTBEAT_MS = Number(args.heartbeat ?? 30) * 1000;
const SIZE_PILOT = !['off', 'false', false].includes(args.sizePilot);
const FIRST_ITER_X = Number(args.firstIterX ?? 5);
// run.mjs's exit code for a phase timeout
const PHASE_TIMEOUT_EXIT = 3;
const POWER_POLL_MS = 10000;
const FAILED_FILE = path.join(OUT, 'failed-passes.json');
const POWER_ASK_MS = 600000;
const GATED_BY_POWER = ['timing', 'control'];
// the performance-core gate's flags go to every session as they are
const PCORE_FLAGS = ['pcore', 'pcoreFree', 'pcoreMaxWaitS', 'maxEcoreMs', 'maxEcorePct', 'pcoreRetries', 'slot']
    .filter(k => args[k] !== undefined).map(k => `--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}=${args[k]}`);
// more free performance cores than the machine has would only time out: refuse before any session runs
const nP = ((tryJson(path.join(home(), 'machine.json')) || {}).pIndices || []).length;
if (args.pcoreFree !== undefined && nP && Number(args.pcoreFree) > nP) {
    console.error(`--pcore-free=${args.pcoreFree}, but this machine has ${nP} performance cores`);
    process.exit(2);
}
// for the estimates: what a pass leaves out comes from the scenario, as in run.mjs
let scenario = {};
try {
    scenario = await importScenario(resolveIn(run.dir, run.scenario));
} catch {
    // run.mjs's defaults then
}

const flags = (o, prefix = '') => Object.entries(o || {}).flatMap(([k, v]) => {
    if (v === undefined) return [];
    if (v && typeof v === 'object' && !Array.isArray(v)) return flags(v, `${prefix}${k}.`);
    const name = prefix ? `${prefix}${k}` : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

    return [`--${name}=${Array.isArray(v) ? v.join(',') : v}`];
});

// the session list: pass x position in the side order; numbering per side inside a pass (A1 B1 B2 A2)
const passes = plan.passes || [];
const byName = Object.fromEntries(passes.map(p => [p.name, p]));
for (const p of passes) if (p.extends && !byName[p.extends]) throw new Error(`pass ${p.name} extends ${p.extends}, which ${path.basename(planFile)} does not have`);
const unknown = only.filter(name => !byName[name]);
if (unknown.length) {
    console.error(`--only: ${path.basename(planFile)} has no pass ${unknown.join(', ')} (passes: ${passes.map(p => p.name).join(', ')})`);
    process.exit(2);
}
const argsOf = p => (p.sizePilot ? p.args : (p.extends ? Object.assign({}, byName[p.extends].args, p.args) : p.args) || {});
const selected = p => (only.length ? only.includes(p.name) : !p.optional);
const roleOf = roleResolver(passes);
/** What the estimate, the resume check and the size pilots need, resolved as run.mjs will resolve it. */
const shapeOf = p => {
    const base = p.extends || p.name;
    const a = argsOf(p);
    const cfg = Object.assign({}, scenario.cfg, run.cfg, a.cfg);

    return { pass: base, role: p.sizePilot ? 'trial' : roleOf(base, { cfg, altInject: a.altInject }), cfg, k: Number(a.k ?? scenario.k ?? 8), rates: numbers(a.rates ?? scenario.rates ?? '1,4'), warmup: Number(a.warmup ?? scenario.warmup ?? 2), target: a.target || run.target || 'web' };
};
// the same workload: cfg and target (k, rates and the injected cost aside)
const workKey = sh => `${sh.target || 'web'}|${cfgKey(sh.cfg)}`;
const MEASURED = ['timing', 'control'];

// size pilots: one per workload of the selected timing and control passes that nothing has measured
const sizePilots = [];
if (SIZE_PILOT) {
    const done = new Set(timingHistory(OUT, roleOf).filter(h => h.role !== 'counts').map(workKey));
    const trialKeys = new Set(passes.filter(p => selected(p) && shapeOf(p).role === 'trial').map(p => workKey(shapeOf(p))));
    const byKey = new Map();
    for (const p of passes.filter(selected)) {
        const sh = shapeOf(p);
        const key = workKey(sh);
        if (!MEASURED.includes(sh.role) || done.has(key) || trialKeys.has(key)) continue;
        if (byKey.has(key)) {
            byKey.get(key).for.push(sh.pass);
            continue;
        }
        const { k, rates, warmup, altInject, profileAt, ...rest } = argsOf(p);
        let name = `pilot-${sh.pass}`;
        while (byName[name] || sizePilots.some(x => x.name === name)) name += '-size';
        const pilot = { name, role: 'trial', order: Object.keys(run.sides).join(''), sizePilot: true, for: [sh.pass], args: Object.assign(rest, { k: 1, rates: '4', warmup: 0 }) };
        byKey.set(key, pilot);
        sizePilots.push(pilot);
    }
}
const slots = Object.assign(planSessions(passes), ...sizePilots.map(p => planSessions([p])));
const sessionsOf = p => {
    const shape = shapeOf(p);
    const a = argsOf(p);

    return slots[p.name].map(({ id, side }) => ({ id, pass: p.name, base: shape.pass, side, shape, out: path.join(OUT, `${id}.json`), log: path.join(OUT, `${id}.log`), progress: path.join(OUT, 'progress', `${id}.json`), args: flags(a), sizePilot: !!p.sizePilot }));
};
const ordered = passes.filter(selected).flatMap(sessionsOf);
// the size pilots run right before the first timing or control session
const firstMeasured = ordered.findIndex(s => MEASURED.includes(s.shape.role));
const sessions = firstMeasured < 0 ? ordered : [...ordered.slice(0, firstMeasured), ...sizePilots.flatMap(sessionsOf), ...ordered.slice(firstMeasured)];
// complete AND made with this pass's arguments (an edited plan reruns the sessions it changed) AND
// seeded with today's spare targets (SPARES; a record from before meta.spares seeded fewer accounts);
// a record from before meta.argv counts as made with them when k, rates, warmup and cfg match.
// Gate flags are not the pass's configuration: stripped from both sides (passArgv)
const state = s => {
    try {
        const d = readJson(s.out);
        if (d.complete !== true) return 'todo';
        const m = d.meta;
        if (m.spares !== SPARES) return 'stale';
        // built from another commit than the side's current build (re-pinned or rebuilt since)
        const want = sideCommit(run.sides[s.side]);
        const got = sessionCommit(d);
        if (want && got && got !== want) return 'stale';
        if (!m.argv) return m.k === s.shape.k && JSON.stringify(m.rates) === JSON.stringify(s.shape.rates) && m.warmup === s.shape.warmup && cfgKey(m.cfg) === cfgKey(s.shape.cfg) ? 'done' : 'stale';

        return JSON.stringify(passArgv(m.argv)) === JSON.stringify(passArgv(s.args)) ? 'done' : 'stale';
    } catch {
        return 'todo';
    }
};
const isComplete = s => state(s) === 'done';
// a pass that extends another pools with its sessions: refuse while those are stale (made with other
// arguments or spare targets), or the pooled numbers would mix two configurations
for (const p of passes.filter(x => selected(x) && x.extends)) {
    const stale = sessionsOf(byName[p.extends]).filter(s => state(s) === 'stale').map(s => s.id);
    if (stale.length && !args.dry) {
        console.error(`pass ${p.name} extends ${p.extends}, whose sessions ${stale.join(', ')} are stale (made with other arguments or spare targets) — run ${p.extends} again first: plan.mjs --run=${RUN_ID} --only=${p.extends}`);
        process.exit(2);
    }
}

/** For a deployed-preview side: the session just finished served another commit than the side's earlier ones. */
const previewMoved = s => {
    const side = run.sides[s.side];
    if (!side || !side.url || sideCommit(side)) return null;
    const mine = sessionCommit(tryJson(s.out));
    if (!mine) return null;
    for (const f of fs.readdirSync(OUT).filter(x => SESSION_FILE.test(x) && x !== path.basename(s.out))) {
        const m = f.match(SESSION_FILE);
        const d = m[3] === s.side ? tryJson(path.join(OUT, f)) : null;
        const c = d && d.complete === true ? sessionCommit(d) : null;
        if (c && c !== mine) return `side ${s.side} (${side.url}) served ${mine.slice(0, 10)}, its earlier session ${f.slice(0, -5)} ${c.slice(0, 10)}`;
    }

    return null;
};

/** The next attempt's log: out/<session>.attempt<n>.log (a log from before attempt logs is kept as attempt 1). */
const attemptLog = s => {
    const re = new RegExp(`^${s.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.attempt(\\d+)\\.log$`);
    const ns = fs.readdirSync(OUT).map(f => f.match(re)).filter(Boolean).map(m => Number(m[1]));
    if (!ns.length && exists(s.log)) {
        fs.renameSync(s.log, path.join(OUT, `${s.id}.attempt1.log`));
        ns.push(1);
    }

    return path.join(OUT, `${s.id}.attempt${Math.max(0, ...ns) + 1}.log`);
};

let child = null;
const runSession = (s, logFile) => new Promise(resolve => {
    fs.rmSync(s.progress, { force: true });
    const argv = [path.join(RIG, 'run.mjs'), `--run=${run.dir}`, `--side=${s.side}`, `--out=${s.out}`, `--progress=${s.progress}`, `--role=${s.shape.role}`, ...PCORE_FLAGS, ...s.args];
    if (args.repo) argv.push(`--repo=${args.repo}`);
    const fd = fs.openSync(logFile, 'w');
    child = spawn(process.execPath, argv, { stdio: ['ignore', fd, fd] });
    child.on('exit', (code, signal) => {
        child = null;
        fs.closeSync(fd);
        // the latest attempt is also <session>.log
        fs.copyFileSync(logFile, s.log);
        resolve(code ?? signal);
    });
});

let status = null;
let saveStatus = () => {};
const main = async () => {
    const T0 = Date.now();
    // one plan per run: another live plan would interleave sessions and fight over plan-status.json
    const other = tryJson(path.join(OUT, 'plan-status.json'));
    if (!args.dry && other && other.state === 'running' && other.pid && other.pid !== process.pid && alive(other.pid)) {
        console.error(`another plan is running on this run: pid ${other.pid} (${path.basename(other.plan || 'plan.json')}, started ${other.startedAt}) — wait for it or stop it first`);
        process.exit(1);
    }
    const history = () => timingHistory(OUT, roleOf);
    let model = etaModel(history());
    const todo = sessions.filter(s => !isComplete(s));
    const skipped = sessions.length - todo.length;
    // passes marked failed: base pass -> { reason, session }; their sessions left are skipped
    const failedPasses = new Map();
    // plan, started, total, done, skipped, failed, current, etaS, durationsS, finished: the earlier schema
    status = {
        run: RUN_ID, plan: planFile, pid: process.pid, state: 'running',
        startedAt: new Date(T0).toISOString(), started: new Date(T0).toISOString(), updatedAt: null, elapsedMs: 0,
        totals: { toRun: todo.length, done: 0, failed: 0, skipped, notRun: 0 },
        total: sessions.length, done: 0, skipped, failed: [], durationsS: [],
        current: null, passes: [], failedPasses: {}, powerWaitMs: 0, log: path.join(OUT, 'plan.log'),
        sessions: sessions.map(s => ({ id: s.id, pass: s.pass, side: s.side, state: todo.includes(s) ? 'todo' : 'skipped', startedAt: null, durationMs: null, exit: null, attempts: [] })),
        etaMs: null, etaAt: null, etaRough: false, etaS: null,
    };
    const entry = s => status.sessions.find(x => x.id === s.id);
    let running = null;
    // the running session's own iterations size the rest of its pass (same workload)
    const ownOf = s => (running && running.p && running.p.iterMs && running.s.base === s.base && workKey(running.s.shape) === workKey(s.shape) ? running.p.iterMs : {});
    // what is left of each session still to run, in plan order: { s, ms, rough } (ms null: unknown)
    const left = () => todo.filter(s => ['todo', 'running'].includes(entry(s).state)).map(s => {
        if (running && running.s === s) {
            const l = model.leftEst(s.shape, running.p, running.t0);

            return { s, ms: l ? l.ms : null, rough: !!(l && l.rough) };
        }
        const one = model.sessionEst(s.shape, ownOf(s));

        return { s, ms: one ? one.ms : null, rough: !!(one && one.rough) };
    });
    // { ms, rough } of what is left, or null until a session has finished
    const eta = () => {
        const l = left();
        if (l.some(x => x.ms === null)) return null;

        return { ms: l.reduce((t, x) => t + x.ms, 0), rough: l.some(x => x.rough) };
    };
    const etaText = (e = eta()) => (e ? `ETA ${estText(e, true)} ≈ ${clock(Date.now() + e.ms)}` : 'ETA after the first session');
    const planText = () => `plan ${status.totals.skipped + status.totals.done}/${sessions.length}${status.totals.failed ? ` (${status.totals.failed} failed)` : ''}`;
    // per pass, in plan order: sessions, state, failure, and when it should end at today's estimates
    const passRows = () => {
        const now = Date.now();
        let t = now;
        const ends = {};
        let known = true;
        for (const x of left()) {
            if (x.ms === null) known = false;
            t += x.ms || 0;
            const e = (ends[x.s.pass] ||= { ms: 0, rough: false, known: true });
            e.at = t;
            e.ms += x.ms || 0;
            e.rough ||= x.rough;
            e.known &&= known;
        }

        return [...new Set(sessions.map(s => s.pass))].map(name => {
            const list_ = sessions.filter(s => s.pass === name);
            const st = list_.map(s => entry(s).state);
            const base = list_[0].base;
            const f = failedPasses.get(base);
            const e = ends[name];
            const ended = !st.some(x => ['todo', 'running'].includes(x));
            const state_ = f || (ended && st.every(x => ['failed', 'not-run'].includes(x))) ? 'failed' : st.includes('running') ? 'running' : ended ? 'done' : 'todo';

            return {
                name, base, role: list_[0].shape.role, sizePilot: list_[0].sizePilot || undefined, sessions: list_.length,
                done: st.filter(x => x === 'done').length, completeBefore: st.filter(x => x === 'skipped').length, failed: st.filter(x => x === 'failed').length,
                notRun: st.filter(x => x === 'not-run').length, state: state_, reason: f ? f.reason : null,
                leftMs: e && e.known ? e.ms : null, rough: !!(e && e.rough), finishAt: e && e.known ? new Date(e.at).toISOString() : null,
            };
        });
    };
    saveStatus = () => {
        const now = Date.now();
        const e = status.state === 'running' ? eta() : status.state === 'interrupted' ? null : { ms: 0, rough: false };
        Object.assign(status, { updatedAt: new Date(now).toISOString(), elapsedMs: now - T0, etaMs: e && e.ms, etaAt: e && new Date(now + e.ms).toISOString(), etaRough: !!(e && e.rough), etaS: e && Math.round(e.ms / 1000) });
        status.passes = passRows();
        status.failedPasses = Object.fromEntries(failedPasses);
        writeJsonSafe(path.join(OUT, 'plan-status.json'), status);
    };
    /** Mark a pass failed (and, for a trial that stood in for other passes' workload, those too); their sessions left are not run. */
    const failPass = (s, why) => {
        const bases = new Set([s.base]);
        if (s.shape.role === 'trial') for (const p of passes.filter(selected)) if (MEASURED.includes(shapeOf(p).role) && workKey(shapeOf(p)) === workKey(s.shape)) bases.add(shapeOf(p).pass);
        for (const b of bases) if (!failedPasses.has(b)) failedPasses.set(b, { reason: why, session: s.id, via: b === s.base ? null : s.base });
        // kept across plans (the report lists them): out/failed-passes.json, until a later plan completes the pass
        const kept = tryJson(FAILED_FILE) || {};
        for (const b of bases) kept[b] = Object.assign({}, failedPasses.get(b), { at: new Date().toISOString() });
        writeJsonSafe(FAILED_FILE, kept);
        const notRun = todo.filter(x => bases.has(x.base) && entry(x).state === 'todo');
        for (const x of notRun) Object.assign(entry(x), { state: 'not-run', reason: `pass ${x.base} failed: ${why}` });
        status.totals.notRun += notRun.length;
        log(`   pass ${[...bases].join(', ')} failed: ${why} (${s.id}) — not run again with this configuration${notRun.length ? `; not run: ${notRun.map(x => x.id).join(', ')}` : ''}; the plan goes on with the other passes`);
    };

    const perPass = Object.entries(Object.groupBy(todo, s => s.pass)).map(([p, l]) => `${p} ${l.length}`).join(', ');
    const optional = passes.filter(p => p.optional && !selected(p));
    const est = eta();
    const estimate = !todo.length ? '' : est ? ` · est ${estText(est, true)}, ≈ ${clock(Date.now() + est.ms)}` : ' · ETA after the first session';
    log(`plan ${path.basename(planFile)} · to run: ${perPass || 'nothing'} · ${skipped} done (skipped)${estimate}${optional.length ? ` · optional, not run: ${optional.map(p => p.name).join(', ')}` : ''}`);
    const pilots = sizePilots.filter(p => todo.some(s => s.pass === p.name));
    if (pilots.length) log(`size pilots (k 1 at 4x, trial: never pooled into a verdict) before timing: ${pilots.map(p => `${p.name} for ${p.for.join(', ')}`).join('; ')} — they size the ETAs and the first-iteration check (--size-pilot=off skips them)`);
    const same = identicalTargets(run);
    const onSame = [...new Set(todo.filter(s => MEASURED.includes(s.shape.role) && same.includes(s.shape.target)).map(s => s.base))];
    if (onSame.length) log(`warning: ${same.join(', ')} is code-identical between the sides (run.json bundles): ${onSame.join(', ')} time${onSame.length === 1 ? 's' : ''} a target the change does not reach — report it as unaffected instead of timing it`);
    const others = queue('machine').filter(t => t.run !== RUN_ID);
    if (others.length && todo.length) log(`machine: ${holderText(others[0])}${others.length > 1 ? ` and ${others.length - 1} more waiting` : ''} — this plan's sessions queue behind them and interleave (one session or build step at a time per machine)`);
    if (todo.some(s => GATED_BY_POWER.includes(s.shape.role))) {
        const pw = powerState();
        if (!pw.ok) log(`power: ${pw.text} — timing and control sessions wait for AC power without Low Power Mode (stage power-wait)`);
    }
    if (args.dry) {
        for (const s of sessions) log(state(s).padEnd(5), s.id, s.args.join(' '));
        if (model.empty) {
            log('estimate: no finished session with timing in out/ yet — ETA after the first session');

            return;
        }
        for (const p of passes.filter(x => selected(x) || x.optional).concat(pilots)) {
            const l = sessionsOf(p).filter(s => !isComplete(s));
            const one = model.sessionEst(sessionsOf(p)[0].shape);
            log(`est ${p.name}: ${l.length} to run × ${one && one.rough ? '' : '≈ '}${estText(one)} = ${one ? estText({ ms: one.ms * l.length, rough: one.rough }, true) : '–'}${selected(p) || p.sizePilot ? '' : ` (optional: --only=${p.name})`}${one && one.rough ? ' (~ rough: from another workload until its size pilot ran)' : ''}`);
        }
        log(`est total ${est ? `${estText(est, true)}, ≈ ${clock(Date.now() + est.ms)}` : '–'}${est && est.rough ? ' (~ rough: from other workloads)' : ''}`);

        return;
    }

    const stop = (sig, code) => {
        status.state = 'interrupted';
        status.signal = sig;
        if (running) entry(running.s).state = 'interrupted';
        saveStatus();
        log(`plan interrupted by ${sig}${running ? ` during ${running.s.id}` : ''} — run the same command again to resume`);
        if (child) child.kill(sig);
        process.exit(code);
    };
    process.once('SIGINT', () => stop('SIGINT', 130));
    process.once('SIGTERM', () => stop('SIGTERM', 143));

    const waitForLoad = async () => {
        const t0 = Date.now();
        let next = t0;
        while (loadavg()[0] > MAX_LOAD && Date.now() - t0 < MAX_WAIT_S * 1000) {
            status.current = { waiting: 'load', load: loadavg()[0], maxLoad: MAX_LOAD, since: new Date(t0).toISOString() };
            saveStatus();
            if (Date.now() >= next) {
                log(`   waiting for load ${loadavg()[0]} ≤ ${MAX_LOAD} · ${dur(Date.now() - t0)} of max ${dur(MAX_WAIT_S * 1000)} · ${planText()}`);
                next = Date.now() + HEARTBEAT_MS;
            }
            await sleep(5000);
        }
        status.current = null;
        if (Date.now() - t0 > 1000) log(`   waited ${dur(Date.now() - t0)} for load ${loadavg()[0]} ≤ ${MAX_LOAD}`);
    };
    // timing and control measure on AC power only: on battery or in Low Power Mode the plan waits (no limit;
    // past 10 minutes the heartbeat says to ask the user)
    const waitForPower = async s => {
        let p = powerState();
        if (p.ok) return;
        const t0 = Date.now();
        let next = t0;
        while (!p.ok) {
            status.current = { stage: 'power-wait', waiting: 'power', next: s.id, pass: s.pass, side: s.side, power: { source: p.source, lowPower: p.lowPower, text: p.text }, since: new Date(t0).toISOString() };
            saveStatus();
            if (Date.now() >= next) {
                const waited = Date.now() - t0;
                log(`   power-wait before ${s.id}: ${p.text} — timing and control sessions need AC power without Low Power Mode · ${dur(waited)}${waited >= POWER_ASK_MS ? ' — over 10 min: ask the user to plug in' : ''} · ${planText()} · ${etaText()}`);
                next = Date.now() + HEARTBEAT_MS;
            }
            await sleep(POWER_POLL_MS);
            p = powerState();
        }
        status.powerWaitMs += Date.now() - t0;
        status.current = null;
        log(`   ${p.text} after ${dur(Date.now() - t0)} of power-wait — ${s.id} starts`);
    };
    // the first iteration of a pass against its size pilot's (or earlier sessions') iteration time
    const firstOfPass = s => !history().some(h => h.pass === s.base);
    // one attempt of a session: a heartbeat every HEARTBEAT_MS and on every stage or rate change
    const watch = async (s, e, logFile) => {
        const done = runSession(s, logFile);
        const check = FIRST_ITER_X > 0 && firstOfPass(s);
        let key = 'launch|null';
        let beat = Date.now();
        let shown = 0;
        const tick = () => {
            const p = tryJson(s.progress);
            if (p) running.p = p;
            // iterations the performance-core watchdog discarded: one line each
            if (p && p.discards > shown) {
                for (const d of (p.discardLog || []).slice(-(p.discards - shown))) {
                    log(`   ${s.id} ${d.rate}x it ${d.iteration + 1}/${p.k} discarded — ${d.why || `main thread ran ${d.eMs} ms on efficiency cores (of ${d.cpuMs} ms)`} · ${d.retry > d.retries ? 'no retries left' : `retry ${d.retry}/${d.retries}`}`);
                }
                shown = p.discards;
            }
            const now = Date.now();
            // a first iteration far beyond its workload's iteration time: stop the pass (waits for performance cores not counted)
            if (check && p && !s.stopped && p.rateIndex === 0 && p.iteration === 0 && p.iterStartedAt && ['warm-up', 'measure', 'profile', 'pcore-wait', 'ready'].includes(p.stage)) {
                const ref = model.refIter(s.shape, p.rate);
                const waiting = ['pcore-wait', 'ready'].includes(p.stage) && p.gate && p.gate.since ? now - Date.parse(p.gate.since) : 0;
                const active = now - Date.parse(p.iterStartedAt) - (p.iterGateMs || 0) - waiting;
                if (ref && active > FIRST_ITER_X * ref) {
                    s.stopped = `first iteration ran past ${FIRST_ITER_X} × the ${dur(ref)} an iteration of this workload took at ${p.rate}x in its size pilot or earlier sessions (${dur(active)} and counting)`;
                    log(`   ${s.id}: ${s.stopped} — stopping it`);
                    if (child) child.kill('SIGTERM');
                }
            }
            const k = p ? `${p.stage}|${p.rate}` : key;
            if ((k !== key && !['done', 'failed'].includes(p && p.stage)) || now - beat >= HEARTBEAT_MS) {
                const est = model.sessionEst(s.shape, (p && p.iterMs) || {});
                log(`   ${s.id} ${progressText(p)} · ${dur(now - running.t0)}/${estText(est)} · ${planText()} · ${etaText()}`);
                beat = now;
            }
            key = k;
            // a session queued for the machine has not started: its clock starts when it gets it
            const queuedMs = p ? (p.stage === 'queued' && p.queue && p.queue.since ? Date.now() - Date.parse(p.queue.since) : p.queueMs || 0) : 0;
            const l = model.leftEst(s.shape, p, running.t0 + queuedMs);
            status.current = Object.assign({}, p, { id: s.id, pass: s.pass, side: s.side, attempt: e.attempt, startedAt: e.startedAt, estMs: e.estMs, estRough: e.estRough, leftMs: l && l.ms, log: logFile });
            saveStatus();
        };
        const timer = setInterval(tick, 1000);
        const code = await done;
        clearInterval(timer);
        status.current = null;

        return code;
    };
    /** Why an attempt failed, from its progress snapshot, its record or its log's last lines. */
    const failureOf = (s, code, logFile) => {
        const fin = tryJson(s.progress) || {};
        const rec = tryJson(s.out) || {};
        const lines = exists(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
        const f = fin.failure || rec.failure || null;
        const timeout = code === PHASE_TIMEOUT_EXIT || (f && f.kind === 'phase-timeout');
        const error = s.stopped || fin.error || rec.error || lines.slice(-3).join(' / ').slice(0, 400) || `exit ${code}`;
        const reason = s.stopped ? s.stopped : timeout ? (f && f.phase ? `${f.phase} > ${dur(f.ms)}${f.detail ? ` (${f.detail})` : ''}` : String(error).slice(0, 160)) : null;

        return { error: String(error).slice(0, 500), failure: s.stopped ? { kind: 'first-iteration' } : timeout ? Object.assign({ kind: 'phase-timeout' }, f || {}) : null, reason };
    };

    saveStatus();
    for (const s of todo) {
        const e = entry(s);
        if (e.state === 'not-run') continue;
        if (state(s) === 'stale') log(`${s.id}: complete but made with other arguments — running it again`);
        if (MAX_LOAD !== null) await waitForLoad();
        let code = null;
        for (let attempt = 0; attempt <= RETRIES && code !== 0; attempt++) {
            if (GATED_BY_POWER.includes(s.shape.role)) await waitForPower(s);
            const t0 = Date.now();
            running = { s, t0, p: null };
            const est = model.sessionEst(s.shape, ownOf(s));
            const logFile = attemptLog(s);
            Object.assign(e, { state: 'running', startedAt: new Date(t0).toISOString(), estMs: est && est.ms, estRough: !!(est && est.rough), attempt, log: logFile });
            log(`== [${sessions.indexOf(s) + 1}/${sessions.length}] ${s.pass} · ${s.id} (${s.side}) · k${s.shape.k} · rates ${s.shape.rates.join(',')} · est ${estText(est)}${est && est.rough ? ' (another workload: re-estimated from its first iterations)' : ''} · load ${loadavg()[0]}${attempt ? ` · retry ${attempt}/${RETRIES}` : ''} · log ${path.basename(logFile)}`);
            saveStatus();
            code = await watch(s, e, logFile);
            const ms = Date.now() - t0;
            const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
            const iters = lines.filter(l => / #\d+/.test(l)).length;
            const problems = lines.filter(l => l.includes(' PROBLEM ')).length;
            running = null;
            const fin = tryJson(s.progress) || {};
            // discards and gate waits add up over the session's attempts (a retry starts its own counts)
            Object.assign(e, { durationMs: ms, exit: code, endedAt: new Date().toISOString(), iterations: iters, discards: (e.discards || 0) + (fin.discards || 0), gateWaitMs: (e.gateWaitMs || 0) + (fin.gateWaitMs || 0) });
            status.discards = status.sessions.reduce((t, x) => t + (x.discards || 0), 0);
            status.gateWaitMs = status.sessions.reduce((t, x) => t + (x.gateWaitMs || 0), 0);
            // a deployed preview serving another commit than this side's earlier sessions: develop redeployed
            const moved = code === 0 ? previewMoved(s) : null;
            if (moved) {
                log(`   ${s.id}: ${moved} — stopping the plan: sessions from two deployments cannot pool (aggregate refuses them). Keep one deployment's sessions (move the others out of out/), or pin local builds`);
                Object.assign(e, { state: 'failed', durationMs: Date.now() - t0, exit: code, endedAt: new Date().toISOString() });
                status.totals.failed += 1;
                status.failed.push(s.id);
                status.state = 'failed';
                status.error = moved;
                saveStatus();
                process.exit(1);
            }
            let fail = null;
            if (code === 0) {
                e.state = 'done';
                status.totals.done += 1;
                status.done += 1;
                status.durationsS.push(Math.round(ms / 1000));
                const wasRough = e.estRough && firstOfPass(s) === false && history().filter(h => h.pass === s.base).length === 1;
                model = etaModel(history());
                if (wasRough) {
                    const next = model.sessionEst(s.shape);
                    const rest = todo.filter(x => x.base === s.base && entry(x).state === 'todo').length;
                    if (next && rest) log(`   ${s.pass}: re-estimated from ${s.id} — ${rest} session${rest === 1 ? '' : 's'} left × ${estText(next)} (was ${estText({ ms: e.estMs, rough: true })} from another workload)`);
                }
            } else {
                fail = failureOf(s, code, logFile);
                e.attempts.push({ attempt, exit: code, error: fail.error, failure: fail.failure, log: path.basename(logFile), endedAt: e.endedAt });
                // a phase timeout or a runaway first iteration would repeat with the same configuration: no retry
                if (attempt === RETRIES || fail.reason) {
                    e.state = 'failed';
                    status.totals.failed += 1;
                    status.failed.push(s.id);
                } else {
                    e.state = 'todo';
                }
            }
            saveStatus();
            const gated = e.discards || e.gateWaitMs >= 1000 ? ` · ${e.discards} discarded, waited ${dur(e.gateWaitMs)} for performance cores` : '';
            log(`   ${s.id} exit ${code} in ${dur(ms)} · ${iters} iterations${problems ? `, ${problems} PROBLEM` : ''}${gated} · ${planText()} · ${etaText()}${fail ? ` — ${fail.error.slice(0, 300)}` : ''}`);
            if (fail && fail.reason) {
                failPass(s, fail.reason);
                saveStatus();
                break;
            }
            if (e.state === 'todo') log(`   ${s.id}: retry ${attempt + 1}/${RETRIES} next`);
        }
    }
    status.state = status.totals.failed || failedPasses.size ? 'failed' : 'finished';
    status.finished = new Date().toISOString();
    saveStatus();
    // a pass marked failed by an earlier plan whose sessions are all complete now is no longer failed
    const kept = tryJson(FAILED_FILE);
    if (kept) {
        for (const b of Object.keys(kept)) {
            const mine = sessions.filter(s => s.base === b);
            if (!failedPasses.has(b) && mine.length && mine.every(isComplete)) delete kept[b];
        }
        writeJsonSafe(FAILED_FILE, kept);
    }
    log(`plan finished in ${dur(Date.now() - T0, true)}: ${status.totals.done} run, ${skipped} skipped, ${status.totals.failed} failed${status.failed.length ? ' (' + status.failed.join(', ') + ')' : ''}${status.totals.notRun ? `, ${status.totals.notRun} not run (failed passes)` : ''}${status.powerWaitMs >= 1000 ? ` · waited ${dur(status.powerWaitMs)} for AC power` : ''}`);
    for (const [name, f] of failedPasses) log(`FAILED pass ${name}: ${f.reason} (${f.session}${f.via ? `, the trial run for its workload` : ''}) — see out/${f.session}.log; change the configuration (a smaller size, a longer --phase-timeout-ms) before running it again`);
    for (const x of status.sessions.filter(y => y.attempts && y.attempts.length)) for (const a of x.attempts) log(`attempt ${x.id} exit ${a.exit}: ${a.error.slice(0, 200)} (out/${a.log})`);
    const printed = [...new Set(sessions.map(s => s.base))];
    log(`aggregate --brief (the full tables: node ${path.join(RIG, 'aggregate.mjs')} --run=${RUN_ID}; this output is in out/plan.log)`);
    await new Promise(resolve => {
        // summary.json always covers every pass in out/; the console shows this plan's passes, briefly
        const agg = spawn(process.execPath, [path.join(RIG, 'aggregate.mjs'), `--run=${run.dir}`, `--print=${printed.join(',')}`, '--brief'], { stdio: ['ignore', 'pipe', 'pipe'] });
        agg.stdout.on('data', d => process.stdout.write(d));
        agg.stderr.on('data', d => process.stderr.write(d));
        agg.on('exit', resolve);
    });
    if (status.failed.length || failedPasses.size) process.exitCode = 1;
};

await main().catch(e => {
    if (status) {
        status.state = 'failed';
        status.error = String(e?.message ?? e).slice(0, 500);
        saveStatus();
    }
    console.error(e?.stack ?? e);
    process.exit(1);
});
