/**
 * Execute a run's plan: every pass's sessions in the given side order (ABBA by default), one
 * process per session, sequentially. Resumable — a session whose output is complete is skipped —
 * so a failed or interrupted plan is continued by running the same command again. Aggregates at
 * the end.
 *
 *   node plan.mjs --run=<name|dir> [--plan=<file>] [--only=pass1,pass2] [--dry]
 *        [--retries=1] [--heartbeat=30] [--repo=<checkout>]
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
 *
 * Parallel runs: every session waits for the machine slot (rig/locks.mjs) — sessions of several runs
 * interleave, one at a time — and the wait shows as stage `queued`; --slot=off goes to every session.
 *
 * Progress, in the log and in out/plan-status.json (written atomically): the estimate up front, a
 * line per session start and end, and a heartbeat every --heartbeat seconds and on every stage or
 * rate change of the running session (read from its out/progress/<session>.json), each with the
 * plan's done/total and ETA. Estimates come from finished sessions (lib.mjs etaModel); until one
 * has finished the ETA says so. `node status.mjs --run=<id>` reads the same files at once.
 *
 * Start it with run_in_background (sandbox off) and wait for the completion notification instead
 * of polling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RIG, parseArgs, list, numbers, loadRun, resolveIn, importScenario, readJson, writeJsonSafe, tryJson, exists, home, log, loadavg, sleep, dur, clock, alive, progressText, timingHistory, etaModel, estText, roleResolver, planSessions, cfgKey, SPARES, passArgv, sideCommit, sessionCommit, SESSION_FILE } from './lib.mjs';
import { queue, holderText } from './locks.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const planFile = path.resolve(args.plan || path.join(run.dir, 'plan.json'));
if (!exists(planFile)) throw new Error(`no plan at ${planFile} — copy ${path.join(RIG, 'templates', 'plan.json')}`);
const plan = readJson(planFile);
const only = list(args.only);
const OUT = path.join(run.dir, 'out');
const MAX_LOAD = args.maxLoad === undefined ? null : Number(args.maxLoad);
const MAX_WAIT_S = Number(args.maxWaitS ?? 900);
const RETRIES = Number(args.retries ?? 1);
const HEARTBEAT_MS = Number(args.heartbeat ?? 30) * 1000;
// the performance-core gate's flags go to every session as they are
const PCORE_FLAGS = ['pcore', 'pcoreFree', 'pcoreMaxWaitS', 'maxEcoreMs', 'maxEcorePct', 'pcoreRetries', 'slot']
    .filter(k => args[k] !== undefined).map(k => `--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}=${args[k]}`);
// more free performance cores than the machine has would only time out: refuse before any session runs
const nP = ((tryJson(path.join(home(), 'machine.json')) || {}).pIndices || []).length;
if (args.pcoreFree !== undefined && nP && Number(args.pcoreFree) > nP) {
    console.error(`--pcore-free=${args.pcoreFree}, but this machine has ${nP} performance cores`);
    process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
// for the estimates: what a pass leaves out comes from the scenario, as in run.mjs
let scenario = {};
try {
    scenario = await importScenario(resolveIn(run.dir, run.scenario));
} catch {
    // run.mjs's defaults then
}

const flags = (o, prefix = '') => Object.entries(o || {}).flatMap(([k, v]) => {
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
const argsOf = p => (p.extends ? Object.assign({}, byName[p.extends].args, p.args) : p.args) || {};
const selected = p => (only.length ? only.includes(p.name) : !p.optional);
const roleOf = roleResolver(passes);
// a pass that extends another continues its numbers, wherever it stands in the plan
const slots = planSessions(passes);
const sessionsOf = p => {
    const base = p.extends || p.name;
    const a = argsOf(p);
    // what the estimate and the resume check need, resolved as run.mjs will resolve it
    const cfg = Object.assign({}, scenario.cfg, run.cfg, a.cfg);
    const shape = { pass: base, role: roleOf(base, { cfg, altInject: a.altInject }), cfg, k: Number(a.k ?? scenario.k ?? 8), rates: numbers(a.rates ?? scenario.rates ?? '1,4'), warmup: Number(a.warmup ?? scenario.warmup ?? 2) };

    return slots[p.name].map(({ id, side }) => ({ id, pass: p.name, base, side, shape, out: path.join(OUT, `${id}.json`), log: path.join(OUT, `${id}.log`), progress: path.join(OUT, 'progress', `${id}.json`), args: flags(a) }));
};
const sessions = passes.filter(selected).flatMap(sessionsOf);
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
        console.error(`pass ${p.name} extends ${p.extends}, whose sessions ${stale.join(', ')} are stale (made with other arguments or spare targets) — run ${p.extends} again first: plan.mjs --run=${run.id || path.basename(run.dir)} --only=${p.extends}`);
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

let child = null;
const runSession = s => new Promise(resolve => {
    fs.rmSync(s.progress, { force: true });
    const argv = [path.join(RIG, 'run.mjs'), `--run=${run.dir}`, `--side=${s.side}`, `--out=${s.out}`, `--progress=${s.progress}`, `--role=${s.shape.role}`, ...PCORE_FLAGS, ...s.args];
    if (args.repo) argv.push(`--repo=${args.repo}`);
    const fd = fs.openSync(s.log, 'w');
    child = spawn(process.execPath, argv, { stdio: ['ignore', fd, fd] });
    child.on('exit', (code, signal) => {
        child = null;
        fs.closeSync(fd);
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
    // plan, started, total, done, skipped, failed, current, etaS, durationsS, finished: the earlier schema
    status = {
        run: run.id || path.basename(run.dir), plan: planFile, pid: process.pid, state: 'running',
        startedAt: new Date(T0).toISOString(), started: new Date(T0).toISOString(), updatedAt: null, elapsedMs: 0,
        totals: { toRun: todo.length, done: 0, failed: 0, skipped },
        total: sessions.length, done: 0, skipped, failed: [], durationsS: [],
        current: null,
        sessions: sessions.map(s => ({ id: s.id, pass: s.pass, side: s.side, state: todo.includes(s) ? 'todo' : 'skipped', startedAt: null, durationMs: null, exit: null })),
        etaMs: null, etaAt: null, etaRough: false, etaS: null,
    };
    const entry = s => status.sessions.find(x => x.id === s.id);
    let running = null;
    // { ms, rough } of what is left, or null until a session has finished
    const eta = () => {
        const e = { ms: 0, rough: false };
        for (const s of todo) {
            if (entry(s).state !== 'todo') continue;
            const one = model.sessionEst(s.shape);
            if (!one) return null;
            e.ms += one.ms;
            e.rough ||= one.rough;
        }
        const left = running ? model.leftEst(running.s.shape, running.p, running.t0) : { ms: 0, rough: false };
        if (!left) return null;

        return { ms: e.ms + left.ms, rough: e.rough || left.rough };
    };
    const etaText = (e = eta()) => (e ? `ETA ${estText(e, true)} ≈ ${clock(Date.now() + e.ms)}` : 'ETA after the first session');
    const planText = () => `plan ${status.totals.skipped + status.totals.done}/${sessions.length}${status.totals.failed ? ` (${status.totals.failed} failed)` : ''}`;
    saveStatus = () => {
        const now = Date.now();
        const e = status.state === 'running' ? eta() : status.state === 'interrupted' ? null : { ms: 0, rough: false };
        Object.assign(status, { updatedAt: new Date(now).toISOString(), elapsedMs: now - T0, etaMs: e && e.ms, etaAt: e && new Date(now + e.ms).toISOString(), etaRough: !!(e && e.rough), etaS: e && Math.round(e.ms / 1000) });
        writeJsonSafe(path.join(OUT, 'plan-status.json'), status);
    };

    const perPass = Object.entries(Object.groupBy(todo, s => s.pass)).map(([p, l]) => `${p} ${l.length}`).join(', ');
    const optional = passes.filter(p => p.optional && !selected(p));
    const est = eta();
    const estimate = !todo.length ? '' : est ? ` · est ${estText(est, true)}, ≈ ${clock(Date.now() + est.ms)}` : ' · ETA after the first session';
    log(`plan ${path.basename(planFile)} · to run: ${perPass || 'nothing'} · ${skipped} done (skipped)${estimate}${optional.length ? ` · optional, not run: ${optional.map(p => p.name).join(', ')}` : ''}`);
    const others = queue('machine').filter(t => t.run !== (run.id || path.basename(run.dir)));
    if (others.length && todo.length) log(`machine: ${holderText(others[0])}${others.length > 1 ? ` and ${others.length - 1} more waiting` : ''} — this plan's sessions queue behind them and interleave (one session or build step at a time per machine)`);
    if (args.dry) {
        for (const s of sessions) log(state(s).padEnd(5), s.id, s.args.join(' '));
        if (model.empty) {
            log('estimate: no finished session with timing in out/ yet — ETA after the first session');

            return;
        }
        for (const p of passes.filter(x => selected(x) || x.optional)) {
            const l = sessionsOf(p).filter(s => !isComplete(s));
            const one = model.sessionEst(sessionsOf(p)[0].shape);
            log(`est ${p.name}: ${l.length} to run × ${one && one.rough ? '' : '≈ '}${estText(one)} = ${one ? estText({ ms: one.ms * l.length, rough: one.rough }, true) : '–'}${selected(p) ? '' : ` (optional: --only=${p.name})`}`);
        }
        log(`est total ${est ? `${estText(est, true)}, ≈ ${clock(Date.now() + est.ms)}` : '–'}${est && est.rough ? ' (~ rough: from other passes)' : ''}`);

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
    // one attempt of a session: a heartbeat every HEARTBEAT_MS and on every stage or rate change
    const watch = async (s, e) => {
        const done = runSession(s);
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
            const k = p ? `${p.stage}|${p.rate}` : key;
            const now = Date.now();
            if ((k !== key && !['done', 'failed'].includes(p && p.stage)) || now - beat >= HEARTBEAT_MS) {
                const est = model.sessionEst(s.shape, (p && p.iterMs) || {});
                log(`   ${s.id} ${progressText(p)} · ${dur(now - running.t0)}/${estText(est)} · ${planText()} · ${etaText()}`);
                beat = now;
            }
            key = k;
            // a session queued for the machine has not started: its clock starts when it gets it
            const queuedMs = p ? (p.stage === 'queued' && p.queue && p.queue.since ? Date.now() - Date.parse(p.queue.since) : p.queueMs || 0) : 0;
            const left = model.leftEst(s.shape, p, running.t0 + queuedMs);
            status.current = Object.assign({}, p, { id: s.id, pass: s.pass, side: s.side, attempt: e.attempt, startedAt: e.startedAt, estMs: e.estMs, estRough: e.estRough, leftMs: left && left.ms, log: s.log });
            saveStatus();
        };
        const timer = setInterval(tick, 1000);
        const code = await done;
        clearInterval(timer);
        status.current = null;

        return code;
    };

    saveStatus();
    for (const s of todo) {
        if (state(s) === 'stale') log(`${s.id}: complete but made with other arguments — running it again`);
        if (MAX_LOAD !== null) await waitForLoad();
        const e = entry(s);
        let code = null;
        for (let attempt = 0; attempt <= RETRIES && code !== 0; attempt++) {
            const t0 = Date.now();
            running = { s, t0, p: null };
            const est = model.sessionEst(s.shape);
            Object.assign(e, { state: 'running', startedAt: new Date(t0).toISOString(), estMs: est && est.ms, estRough: !!(est && est.rough), attempt });
            log(`== [${sessions.indexOf(s) + 1}/${sessions.length}] ${s.pass} · ${s.id} (${s.side}) · k${s.shape.k} · rates ${s.shape.rates.join(',')} · est ${estText(est)} · load ${loadavg()[0]}${attempt ? ` · retry ${attempt}/${RETRIES}` : ''}`);
            saveStatus();
            code = await watch(s, e);
            const ms = Date.now() - t0;
            const lines = fs.readFileSync(s.log, 'utf8').trim().split('\n');
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
            if (code === 0) {
                e.state = 'done';
                status.totals.done += 1;
                status.done += 1;
                status.durationsS.push(Math.round(ms / 1000));
                model = etaModel(history());
            } else if (attempt === RETRIES) {
                e.state = 'failed';
                status.totals.failed += 1;
                status.failed.push(s.id);
            } else {
                e.state = 'todo';
            }
            saveStatus();
            const gated = e.discards || e.gateWaitMs >= 1000 ? ` · ${e.discards} discarded, waited ${dur(e.gateWaitMs)} for performance cores` : '';
            log(`   ${s.id} exit ${code} in ${dur(ms)} · ${iters} iterations${problems ? `, ${problems} PROBLEM` : ''}${gated} · ${planText()} · ${etaText()}${code ? ' — ' + lines.slice(-3).join(' / ').slice(0, 400) : ''}`);
            if (e.state === 'todo') log(`   ${s.id}: retry ${attempt + 1}/${RETRIES} next`);
        }
    }
    status.state = status.totals.failed ? 'failed' : 'finished';
    status.finished = new Date().toISOString();
    saveStatus();
    log(`plan finished in ${dur(Date.now() - T0, true)}: ${status.totals.done} run, ${skipped} skipped, ${status.totals.failed} failed${status.failed.length ? ' (' + status.failed.join(', ') + ')' : ''}`);
    const printed = [...new Set(sessions.map(s => s.base))];
    await new Promise(resolve => {
        // summary.json always covers every pass in out/; the console shows this plan's passes
        const agg = spawn(process.execPath, [path.join(RIG, 'aggregate.mjs'), `--run=${run.dir}`, `--print=${printed.join(',')}`], { stdio: 'inherit' });
        agg.on('exit', resolve);
    });
    if (status.failed.length) process.exitCode = 1;
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
