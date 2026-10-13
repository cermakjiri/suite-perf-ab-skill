/**
 * Where a run stands, at once: what is running (pass, session, side, stage and how long it has
 * run, rate, iteration, phase), sessions done, failed and to go, elapsed time, ETA and finish
 * time, the last finished session, and the build while one is going. It flags a plan or session
 * whose pid is gone while its state says running (crashed or killed) and a session snapshot older
 * than 2 min (stuck: run.mjs writes one at least every 30 s while it lives). With no plan running:
 * the last plan's final state and whether summary.json is newer than the last session; sessions
 * run without a plan: their records and the newest progress file. A plan-status.json from before
 * pids were recorded reads as finished or unknown, never running.
 *
 *   node status.mjs --run=<name|dir> [--json] [--watch[=<s>]]
 *
 * Reads run.json, out/plan-status.json, out/progress/<session>.json and build-status.json, prints
 * at most 8 lines and exits. --watch re-prints every <s> seconds (default 5) until the plan ends:
 * for your own terminal, never as an agent's foreground wait. Runs inside the sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadRun, tryJson, exists, sleep, dur, clock, alive, progressText, estText, SESSION_FILE } from './lib.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const OUT = path.join(run.dir, 'out');
const STALE_MS = 120000;
const at = iso => (iso ? Date.parse(iso) : null);
const mtime = f => {
    try {
        return fs.statSync(f).mtimeMs;
    } catch {
        return null;
    }
};
const iso = t => (t ? new Date(t).toISOString() : null);
const ENDED = ['done', 'failed', 'interrupted'];

const snapshot = () => {
    const now = Date.now();
    const ps = tryJson(path.join(OUT, 'plan-status.json'));
    const build = tryJson(path.join(run.dir, 'build-status.json'));
    const progDir = path.join(OUT, 'progress');
    const progress = id => tryJson(path.join(progDir, `${id}.json`));
    const newest = (exists(progDir) ? fs.readdirSync(progDir).filter(f => f.endsWith('.json')).map(f => tryJson(path.join(progDir, f))).filter(Boolean) : [])
        .toSorted((a, b) => at(b.updatedAt) - at(a.updatedAt))[0] || null;
    const sessionFiles = exists(OUT) ? fs.readdirSync(OUT).filter(f => SESSION_FILE.test(f)) : [];
    const lastSessionAt = Math.max(0, ...sessionFiles.map(f => mtime(path.join(OUT, f)) || 0)) || null;
    const summaryAt = mtime(path.join(run.dir, 'summary.json'));
    const s = {
        run: run.id || path.basename(run.dir), at: iso(now), plan: null, current: null, last: null, latest: null, build: null, problems: [],
        summary: { at: iso(summaryAt), lastSessionAt: iso(lastSessionAt), newer: summaryAt && lastSessionAt ? summaryAt >= lastSessionAt : null },
    };
    // a session writes its snapshot at least every 30 s while it lives: stuck = stale or its pid gone
    const stale = (t, what) => {
        if (t && now - t > STALE_MS) s.problems.push(`no update for ${dur(now - t)} (${what}) — stuck?`);
    };
    const session = (p, what) => {
        if (!p || ENDED.includes(p.stage)) return;
        if (alive(p.pid) === false) s.problems.push(`session ${p.session} pid ${p.pid} is gone at stage ${p.stage} — it crashed or was killed; see out/${p.session}.log`);
        else stale(at(p.updatedAt), what);
    };

    if (ps) {
        // plan-status.json from before pid/state existed: finished, or unknown — never running
        const state = ps.pid ? ps.state || 'running' : ps.finished ? ((ps.failed || []).length ? 'failed' : 'finished') : 'unknown';
        const totals = ps.totals || { toRun: ps.total - (ps.skipped || 0), done: ps.done || 0, failed: (ps.failed || []).length, skipped: ps.skipped || 0 };
        const started = at(ps.startedAt || ps.started);
        const running = state === 'running';
        s.plan = {
            state, file: ps.plan, pid: ps.pid || null, alive: alive(ps.pid), startedAt: iso(started), updatedAt: ps.updatedAt || null, finishedAt: ps.finished || null,
            elapsedMs: running ? now - started : ps.elapsedMs ?? (ps.finished ? at(ps.finished) - started : null),
            totals, total: ps.total, toGo: totals.toRun - totals.done - totals.failed, failed: ps.failed || [],
            interrupted: (ps.sessions || []).filter(x => x.state === 'interrupted').map(x => x.id),
            // the performance-core gate: discarded iterations and the wait, finished sessions plus the running one
            discards: (ps.discards || 0) + ((ps.current && ps.current.discards) || 0), gateWaitMs: ps.gateWaitMs || 0,
            etaMs: running ? (ps.etaAt ? Math.max(0, at(ps.etaAt) - now) : null) : null, etaAt: running ? ps.etaAt || null : null, etaRough: !!ps.etaRough,
        };
        const cur = ps.current;
        if (cur && cur.id) {
            // the progress file is fresher than the plan's copy of it
            s.current = Object.assign({}, cur, progress(cur.id) || {});
            s.current.elapsedMs = now - at(cur.startedAt);
        } else if (cur && cur.waiting) {
            s.current = cur;
        }
        const ended = (ps.sessions || []).filter(x => x.endedAt).toSorted((a, b) => at(b.endedAt) - at(a.endedAt))[0];
        if (ended) s.last = ended;
        if (running && s.plan.alive === false) s.problems.push(`plan pid ${ps.pid} is gone but its state says running — it crashed or was killed; run plan.mjs again to resume`);
        else if (running && s.current && s.current.session) session(s.current, `${s.current.id} ${progressText(s.current)}; see out/${s.current.id}.log`);
        else if (running) stale(at(ps.updatedAt), s.current && s.current.id ? `${s.current.id} starting` : 'between sessions');
        // a session run by hand after the plan
        if (!running && newest && at(newest.startedAt) > (at(ps.updatedAt) || 0)) s.latest = newest;
    } else {
        s.latest = newest;
        // sessions without a plan: what their records say
        const recs = sessionFiles.map(f => tryJson(path.join(OUT, f))).filter(Boolean);
        s.records = { total: sessionFiles.length, complete: recs.filter(d => d.complete === true).length };
    }
    if (s.latest) session(s.latest, `${s.latest.session} ${progressText(s.latest)}`);
    if (!s.last && !(ps && ps.sessions)) {
        // older plans and sessions without a plan: the newest session record
        const f = sessionFiles.toSorted((a, b) => mtime(path.join(OUT, b)) - mtime(path.join(OUT, a)))[0];
        if (f) s.last = { id: f.slice(0, -5), endedAt: iso(mtime(path.join(OUT, f))), complete: (tryJson(path.join(OUT, f)) || {}).complete === true };
    }
    if (build && (build.state !== 'finished' || now - at(build.updatedAt) < 15 * 60000)) {
        // a build only runs while its pid lives (build.mjs marks Ctrl+C / SIGTERM as interrupted)
        s.build = Object.assign({}, build, { running: build.state === 'running' && alive(build.pid) !== false });
        if (build.state === 'running' && !s.build.running) s.problems.push(`build pid ${build.pid} is gone but its state says running — it crashed or was killed`);
        else if (s.build.running) stale(at(build.updatedAt), `build ${build.side} ${build.step ? build.step.name : ''}`);
    }

    return s;
};

const lines = s => {
    const out = [];
    const P = s.plan;
    const c = s.current;
    if (P) {
        const name = path.basename(P.file || 'plan.json');
        if (P.state === 'running') {
            out.push(`plan ${s.run} · running · pid ${P.pid ?? '?'} · ${name} · started ${P.startedAt ? clock(P.startedAt) : '?'}`);
            if (c && c.id) out.push(`now  ${c.pass} · ${c.id} (${c.side}) · ${progressText(c)}${c.stageAt && !c.gate ? ` · stage ${dur(Date.now() - at(c.stageAt))}` : ''} · ${dur(c.elapsedMs)} of est ${estText(c.estMs === null || c.estMs === undefined ? null : { ms: c.estMs, rough: c.estRough })}${c.discards ? ` · ${c.discards} discarded` : ''}`);
            else if (c && c.waiting) out.push(`now  waiting for load ${c.load} ≤ ${c.maxLoad} since ${clock(c.since)}`);
            else out.push('now  between sessions');
            out.push(`sessions ${P.totals.done} done, ${P.totals.failed} failed, ${P.toGo} to go (of ${P.totals.toRun}; ${P.totals.skipped} complete before)${P.discards ? ` · ${P.discards} iteration${P.discards === 1 ? '' : 's'} discarded` : ''}`);
            out.push(`time ${dur(P.elapsedMs, true)} elapsed · ${P.etaMs === null ? 'ETA after the first session' : `ETA ${estText({ ms: P.etaMs, rough: P.etaRough }, true)} · finish ≈ ${clock(P.etaAt)}`}`);
        } else if (P.state === 'unknown') {
            out.push(`plan ${s.run} · state unknown (plan-status.json from an older rig, no pid) · started ${P.startedAt ? clock(P.startedAt) : '?'} · ${name}`);
        } else {
            out.push(`plan ${s.run} · ${P.state}${P.finishedAt || P.updatedAt ? ` ${clock(P.finishedAt || P.updatedAt)}` : ''} · took ${dur(P.elapsedMs, true)} · ${name}`);
            out.push(`sessions ${P.totals.done} done, ${P.totals.failed} failed${P.failed.length ? ` (${P.failed.join(', ')})` : ''}, ${P.totals.skipped} complete before${P.toGo > 0 ? `, ${P.toGo} not run` : ''}${P.interrupted.length ? ` (interrupted in ${P.interrupted.join(', ')}: run the plan again to resume)` : ''}${P.discards || P.gateWaitMs >= 1000 ? ` · ${P.discards} discarded, waited ${dur(P.gateWaitMs)} for performance cores` : ''}`);
        }
    } else if (s.records && s.records.total) {
        out.push(`run ${s.run} · no plan has run here · ${s.records.total} session records, ${s.records.complete} complete`);
    } else {
        out.push(`run ${s.run} · ${s.latest ? 'no plan and no session record yet' : 'nothing has run here yet'}`);
    }
    if (s.last) out.push(`last ${s.last.id}${s.last.exit !== undefined ? ` exit ${s.last.exit} in ${dur(s.last.durationMs)}${s.last.iterations !== undefined ? ` · ${s.last.iterations} iterations` : ''}` : s.last.complete ? ' complete' : ' incomplete'} · ${clock(s.last.endedAt)}`);
    if (s.latest) {
        const l = s.latest;
        const live = !ENDED.includes(l.stage) && l.stageAt ? ` · stage ${dur(Date.now() - at(l.stageAt))}` : '';
        out.push(`${P ? 'since the plan' : 'session'} ${l.session} (${l.side}) · ${progressText(l)}${live} · ${l.unitsDone}/${l.unitsTotal} iterations${l.discards ? `, ${l.discards} discarded` : ''} · updated ${clock(l.updatedAt)}`);
    }
    if ((!P || P.state !== 'running') && s.summary.lastSessionAt) {
        const m = s.summary;
        out.push(!m.at ? 'summary.json missing — run aggregate.mjs' : m.newer === false ? `summary.json ${clock(m.at)} is older than the last session (${clock(m.lastSessionAt)}) — run aggregate.mjs` : `summary.json ${clock(m.at)}, newer than the last session`);
    }
    const b = s.build;
    if (b) {
        out.push(b.running && b.step
            ? `build ${b.side} ${b.step.i}/${b.step.n} ${b.step.name} · ${dur(Date.now() - at(b.step.startedAt))}${b.step.estMs ? ` of ≈ ${dur(b.step.estMs)}` : ''}${b.etaMs !== null && b.etaMs !== undefined ? ` · build ETA ≈ ${clock(b.etaAt)}` : ''}`
            : `build ${b.state === 'running' ? 'stopped (pid gone)' : b.state}${b.updatedAt ? ` ${clock(b.updatedAt)}` : ''}${b.error ? `: ${b.error.split('\n')[0].slice(0, 120)}` : ''}`);
    }
    for (const p of s.problems) out.push(`! ${p}`);

    return out.slice(0, 8);
};

const print = s => console.log(args.json ? JSON.stringify(s, null, 1) : lines(s).join('\n'));

if (args.watch === undefined) {
    print(snapshot());
} else {
    const every = (typeof args.watch === 'number' && args.watch > 0 ? args.watch : 5) * 1000;
    for (;;) {
        const s = snapshot();
        if (process.stdout.isTTY && !args.json) process.stdout.write('\x1b[2J\x1b[H');
        print(s);
        const going = (s.plan && s.plan.state === 'running' && s.plan.alive !== false) || (s.build && s.build.running);
        if (!going) break;
        await sleep(every);
    }
}
