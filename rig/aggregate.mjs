/**
 * Summarize a run's session outputs (out/<pass>-<n>-<side>.json) into summary.json and a console
 * table per pass and CPU rate.
 *
 *   node aggregate.mjs --run=<name|dir> [--passes=main,ctl] [--print=main] [--warmup=<n>] [--all]
 *
 * --passes limits what is summarized (default: every pass in out/), --print only what is printed.
 *
 * The page session is the unit: iterations inside one session are correlated, so next to the
 * pooled p50/p75 of kept iterations every metric gets one median per session, a separation check
 * (every session median of B beyond every one of A) and a permutation p-value over the session
 * medians. Call a timing difference only when the sessions separate; counts need no such care.
 *
 * Metrics are flattened from the records: <phase>.<field> for every numeric field a phase
 * returned (in-page probes, CDP thread time, the scenario's own fields), total.<field> summed over
 * phases, after.<field>, and <phase>.taskCorrMs for the scenario's idleCorrect phases (task time
 * minus the session's idle CPU rate x window length). Iterations with a problem or inside the
 * warm-up are dropped; alt-inject (control) passes are summarized on their inject=0 iterations,
 * and the injected cost's landing is reported per session. Numbers nested in a phase's objects
 * (a scenario's counts) become <phase>.<field>.<key>. A counting pass prints its counts, not timing.
 * Gated iterations add pcore.eSharePct and pcore.eJudgedSharePct: the share of the main thread's CPU
 * that ran on efficiency cores (macOS's own placement, which the gate keeps), shown in every table.
 *
 * Then the advice (also in summary.json): could more sessions change a verdict? Per timing pass x
 * rate, every timing headline metric is called, underpowered (these session counts cannot reach
 * the call at all), borderline (not called, p <= 0.25 — overlapping sessions with p <= 0.1
 * included) or settled; the paired control is landed, inconclusive, underpowered or failed
 * (lib.mjs controlVerdict). `next:` lines say whether one more block could call something, that
 * the draft is stable, or that a failed control must be fixed first. Trial passes are never judged.
 * `flag:` lines name a timing or control pass x rate whose sides' efficiency shares differ by 5
 * points or more with separate sessions: part of a time difference can come from the placement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, loadRun, resolveIn, readJson, tryJson, writeJson, summarize, median, permutationP, separated, importScenario, dur, CALL_P, called, minP, LANDED_PCT, controlVerdict, controlText, isMs, roleResolver, countKeys, planSessions, timingHistory, etaModel } from './lib.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const OUT = path.join(run.dir, 'out');
let scenario = {};
try {
    scenario = await importScenario(resolveIn(run.dir, run.scenario));
} catch {
    // summaries still work without the scenario module (no headline, no idle correction)
}
const IDLE_CORRECT = new Set(scenario.idleCorrect || []);
const ADDITIVE = ['ms', 'taskMs', 'scriptMs', 'layoutMs', 'styleMs', 'otherMs', 'longTasks', 'longTaskMs', 'tbtMs', 'commits', 'framesOver50', 'jankMs', 'layouts', 'styleRecalcs', 'loafBlockingMs', 'forcedLayoutMs', 'taskCorrMs', 'fibers', 'fibersRendered', 'fibersMounted'];
const SKIP = new Set(['heapPeak']);
// numbers inside a phase's objects, two levels deep: { counts: { put: { txs: 3 } } } -> counts.put.txs
const leaves = (obj, prefix, o, depth = 0) => {
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'number' && Number.isFinite(v)) o[`${prefix}.${k}`] = v;
        else if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v)) leaves(v, `${prefix}.${k}`, o, depth + 1);
    }
};

const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter(f => /^.+-\d+-[A-Za-z0-9]+\.json$/.test(f)) : [];
const parse = f => {
    const m = f.match(/^(.+)-(\d+)-([A-Za-z0-9]+)\.json$/);

    return { file: f, pass: m[1], n: Number(m[2]), side: m[3] };
};
const all = files.map(parse);
// plan order first (the main pass leads the report), then anything else found in out/
const planPasses = (() => {
    try {
        return readJson(path.join(run.dir, 'plan.json')).passes || [];
    } catch {
        return [];
    }
})();
const planOrder = planPasses.map(p => p.name);
// a pass's role: plan.json's `role`, else inferred from its sessions' meta and its name
const roleOf = roleResolver(planPasses);
const found = [...new Set(all.map(s => s.pass))];
const passes = list(args.passes).length ? list(args.passes) : planOrder.filter(p => found.includes(p)).concat(found.filter(p => !planOrder.includes(p)).sort());
const idleRate = (d, rate) => {
    const i = d.idle && d.idle[rate];

    return i && i.ms ? i.taskMs / (i.ms / 1000) : null;
};
// one record -> { metricKey: number }
const flatten = (rec, d) => {
    const o = {};
    const rate = idleRate(d, rec.rate);
    const total = {};
    for (const [p, ph] of Object.entries(rec.phases || {})) {
        for (const [k, v] of Object.entries(ph)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, `${p}.${k}`, o);
            if (typeof v !== 'number' || !Number.isFinite(v) || SKIP.has(k)) continue;
            o[`${p}.${k}`] = v;
        }
        if (IDLE_CORRECT.has(p) && typeof ph.taskMs === 'number' && rate !== null) o[`${p}.taskCorrMs`] = +(ph.taskMs - (rate * ph.ms) / 1000).toFixed(1);
        else if (typeof ph.taskMs === 'number') o[`${p}.taskCorrMs`] = ph.taskMs;
        for (const k of ADDITIVE) {
            const v = o[`${p}.${k}`];
            if (typeof v === 'number') total[k] = (total[k] || 0) + v;
        }
        if (typeof ph.heapPeak === 'number') o[`${p}.heapPeakMiB`] = +(ph.heapPeak / 1048576).toFixed(1);
    }
    for (const [k, v] of Object.entries(total)) o[`total.${k}`] = +v.toFixed(1);
    if (!IDLE_CORRECT.size) delete o['total.taskCorrMs'];
    for (const [k, v] of Object.entries(rec.after || {})) if (typeof v === 'number' && Number.isFinite(v)) o[`after.${k}`] = v;
    // the main thread's efficiency-core share (macOS's own placement, kept by the gate): pcore.eSharePct
    for (const [k, v] of Object.entries(rec.pcore || {})) if (typeof v === 'number' && Number.isFinite(v)) o[`pcore.${k}`] = v;

    return o;
};
// shown in every table next to the headline: how much of the main thread's CPU ran on efficiency cores
const PLACEMENT = 'pcore.eSharePct';
// the advice flags a placement difference between the sides of at least this many points (sessions separate)
const PLACEMENT_PP = 5;
const pct = (a, b) => (typeof a === 'number' && typeof b === 'number' && a !== 0 ? +(((b - a) / Math.abs(a)) * 100).toFixed(1) : null);

// sessions' meta.pcore (the performance-core gate, rig/pcore.mjs) of gated passes (timing, control,
// trial), summed per side after the passes; warnings print after the tables
const gated = [];
const warnings = [];
const GATED_ROLES = ['timing', 'control', 'trial'];
const summary = {
    run: { id: run.id, title: run.title, pr: run.pr, target: run.target || 'web', device: run.device || 'synthetic', scenario: scenario.name || run.scenario, sides: Object.fromEntries(Object.entries(run.sides).map(([k, s]) => [k, { label: s.label, rev: s.rev, sha: s.sha, variant: s.variant || null }])) },
    generated: new Date().toISOString(),
    headline: scenario.headline || null,
    passes: {},
};

for (const passName of passes) {
    const sess = all.filter(s => s.pass === passName).sort((a, b) => a.n - b.n);
    const sides = [...new Set(sess.map(s => s.side))].sort();
    const P = { sessions: {}, meta: null, rates: {} };
    const loaded = [];
    for (const s of sess) {
        const d = readJson(path.join(OUT, s.file));
        if (!d.runs || !d.runs.length) continue;
        loaded.push(Object.assign({ d }, s));
        (P.sessions[s.side] = P.sessions[s.side] || []).push({ id: s.file.replace(/\.json$/, ''), complete: !!d.complete, iterations: d.runs.length, started: d.meta.started, load: d.meta.host && d.meta.host.load, browser: d.meta.browser, env: d.env && { markers: d.env.markers, coverageFiles: d.env.coverageFiles, renderers: d.env.renderers, canary: d.env.canary, desktopLaunches: d.env.desktopLaunches }, calib: d.calib, idle: Object.fromEntries(Object.entries(d.idle || {}).map(([r, i]) => [r, { taskPerS: i.ms ? +(i.taskMs / (i.ms / 1000)).toFixed(1) : null, commits: i.commits }])), pcore: d.meta.pcore ? { enabled: d.meta.pcore.enabled, reason: d.meta.pcore.reason, waitMs: d.meta.pcore.gateWaitMs, discards: d.meta.pcore.discards.length, kept: d.meta.pcore.kept.length } : null, error: d.error || null });
        if (!P.meta) P.meta = { k: d.meta.k, rates: d.meta.rates, warmup: d.meta.warmup, idleMs: d.meta.idleMs, cfg: d.meta.cfg, altInject: d.meta.altInject, target: d.meta.target, device: d.meta.device, scenario: d.meta.scenario };
    }
    P.role = roleOf(passName, P.meta);
    if (GATED_ROLES.includes(P.role)) {
        for (const s of loaded) {
            if (!s.d.meta.pcore) continue;
            const timedOut = new Set(s.d.runs.filter(r => r.gate === 'timeout').map(r => `${r.rate}:${r.iter}`));
            gated.push({ side: s.side, id: s.file, pc: s.d.meta.pcore, kept: s.d.meta.pcore.kept.filter(k => !timedOut.has(`${k.rate}:${k.iter}`)), ungated: s.d.runs.filter(r => r.gate === 'off').length });
        }
    }
    // sessions seeded with different spare targets pool data from differently seeded wallets
    const spares = [...new Set(loaded.map(s => s.d.meta.spares ?? 'none'))];
    if (spares.length > 1) warnings.push(`${passName} pools sessions seeded with different spare targets (meta.spares ${spares.join(' / ')}) — plan.mjs reruns the stale ones`);
    // iterations an earlier rig measured after a gate timeout (off the performance cores): never pooled
    const timedOut = loaded.reduce((t, s) => t + s.d.runs.filter(r => r.gate === 'timeout').length, 0);
    if (timedOut) warnings.push(`${passName}: left out ${timedOut} iterations measured after a performance-core gate timeout (older records)`);
    const rates = [...new Set(loaded.flatMap(s => s.d.runs.map(r => r.rate)))].sort((a, b) => a - b);
    for (const rate of rates) {
        const R = { sides: {}, metrics: {}, control: null };
        const perSide = {};
        for (const side of sides) {
            const S = loaded.filter(s => s.side === side);
            const kept = [];
            const problems = [];
            let total = 0;
            const sessionsVals = [];
            const control = [];
            for (const s of S) {
                const warm = args.warmup === undefined ? Number(s.d.meta.warmup ?? 2) : Number(args.warmup);
                const recs = s.d.runs.filter(r => r.rate === rate);
                total += recs.length;
                for (const r of recs) if (r.problem) problems.push(`${s.file}#${r.iter}: ${r.problem}`);
                const ok = recs.filter(r => r.iter >= warm && !r.problem && r.gate !== 'timeout');
                const base = ok.filter(r => !r.inject);
                const flat = base.map(r => flatten(r, s.d));
                kept.push(...flat);
                sessionsVals.push({ id: s.file.replace(/\.json$/, ''), flat, load1m: median(recs.map(r => r.load1m)) });
                if (s.d.meta.altInject) {
                    const inj = ok.filter(r => r.inject).map(r => ({ f: flatten(r, s.d), r }));
                    const keys = Object.keys(flat[0] || {}).filter(k => /\.taskMs$/.test(k) || k === 'total.taskMs');
                    const expected = median(inj.map(x => Object.values(x.r.phases).reduce((t, ph) => t + (ph.injectedMs || 0), 0)));
                    const landed = {};
                    for (const k of keys) {
                        const dlt = median(inj.map(x => x.f[k])) - median(flat.map(x => x[k]));
                        landed[k] = { deltaMs: +dlt.toFixed(1), landedPct: expected ? +((dlt / expected) * 100).toFixed(0) : null };
                    }
                    // pairs: inject / no-inject iterations; under 3 a session's landing is mostly noise
                    control.push({ session: s.file.replace(/\.json$/, ''), injectMs: s.d.meta.altInject, expectedMs: expected, pairs: Math.min(inj.length, flat.length), landed });
                }
            }
            perSide[side] = { kept, sessionsVals };
            R.sides[side] = { n: kept.length, total, problems, sessions: sessionsVals.map(v => ({ id: v.id, kept: v.flat.length, load1m: v.load1m })) };
            if (control.length) (R.control = R.control || {})[side] = control;
        }
        const keys = [...new Set(sides.flatMap(side => perSide[side].kept.flatMap(o => Object.keys(o))))].sort();
        for (const k of keys) {
            const m = {};
            for (const side of sides) {
                const vals = perSide[side].kept.map(o => o[k]);
                const sessMed = perSide[side].sessionsVals.map(v => median(v.flat.map(o => o[k]))).filter(x => x !== null);
                m[side] = { stats: summarize(vals), sessions: sessMed.map(x => +x.toFixed(2)) };
            }
            if (sides.length >= 2) {
                const [a, b] = sides;
                const A = m[a];
                const B = m[b];
                if (A.stats && B.stats) {
                    m.delta = {
                        p75Pct: pct(A.stats.p75, B.stats.p75),
                        medPct: pct(median(A.sessions), median(B.sessions)),
                        separated: separated(A.sessions, B.sessions),
                        p: permutationP(A.sessions, B.sessions),
                    };
                }
            }
            R.metrics[k] = m;
        }
        P.rates[rate] = R;
    }
    summary.passes[passName] = P;
}

// ------------------------------------------------------------------ advice
// Could more sessions change a verdict? Per timing pass x rate (2+ sessions a side), every timing
// headline metric (without a headline: every phase's ms, taskMs and inpMs, and the totals); counts
// and zero-variance metrics are left out. Counting, trial and control passes are never judged.
//   called        sessions separate with p <= CALL_P: what the report calls
//   underpowered  these session counts cannot reach p <= CALL_P at all (2 v 2: 0.333)
//   borderline    not called, p <= 0.25 (overlapping sessions with p <= 0.1 too)
//   settled       the rest
const BORDER_P = 0.25;
const RUN_ID = run.id || path.basename(run.dir);
const names = Object.keys(summary.passes);
const role = name => summary.passes[name].role;
const judgeable = name => Object.values(summary.passes[name].rates).some(R => Object.keys(R.sides).length >= 2 && Object.values(R.sides).every(s => s.sessions.filter(x => x.kept).length >= 2));
const judged = names.filter(p => role(p) === 'timing' && judgeable(p));
const model = etaModel(timingHistory(OUT, roleOf));
const slots = planSessions(planPasses);
const complete = id => (tryJson(path.join(OUT, `${id}.json`)) || {}).complete === true;
const sgn = v => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v}%`);
const advice = { callP: CALL_P, borderlineP: BORDER_P, landedPct: LANDED_PCT, passes: {}, controls: [], next: [] };
const blocks = [];
for (const name of judged) {
    const P = summary.passes[name];
    // one more block: a pass that extends this one while it has sessions to run, else a new one
    const ext = planPasses.filter(p => p.extends === name);
    const pending = ext.find(p => slots[p.name].some(x => !complete(x.id)));
    const order = (pending || ext.at(-1) || {}).order || 'ABBA';
    const fresh = ['more', 'more2', 'more3', 'more4', 'more5'].find(n => !planPasses.some(p => p.name === n)) || `more-${name}`;
    const how = pending
        ? `plan.mjs --run=${RUN_ID} --only=${pending.name}`
        : `add { "name": "${fresh}", "extends": "${name}", "order": "${order}", "optional": true, "role": "timing" } to plan.json, then plan.mjs --run=${RUN_ID} --only=${fresh}`;
    const one = P.meta ? model.sessionEst({ pass: name, role: P.role, cfg: P.meta.cfg, k: P.meta.k, rates: P.meta.rates }) : null;
    for (const [rate, R] of Object.entries(P.rates)) {
        const [a, b] = Object.keys(R.sides);
        if (!b) continue;
        const pick = (summary.headline || []).map(h => h.key);
        const keys = (pick.length ? pick : Object.keys(R.metrics).filter(k => /^[^.]+\.(ms|taskMs|inpMs)$/.test(k))).filter(k => R.metrics[k] && isMs(k));
        const c = { called: [], underpowered: [], borderline: [], settled: [] };
        let sizes = null;
        for (const k of keys) {
            const m = R.metrics[k];
            const A = (m[a] && m[a].sessions) || [];
            const B = (m[b] && m[b].sessions) || [];
            if (A.length < 2 || B.length < 2 || new Set(A.concat(B)).size === 1) continue;
            const d = m.delta || {};
            const row = { key: k, p: d.p ?? null, medPct: d.medPct ?? null };
            sizes = [A.length, B.length];
            if (called(d)) c.called.push(row);
            else if (minP(A.length, B.length) > CALL_P) c.underpowered.push(row);
            else if (row.p !== null && row.p <= BORDER_P) c.borderline.push(row);
            else c.settled.push(row);
        }
        if (!sizes) continue;
        (advice.passes[name] ||= {})[rate] = Object.assign({ sessions: sizes }, c);
        const rows = c.underpowered.concat(c.borderline).toSorted((x, y) => Math.abs(y.medPct ?? 0) - Math.abs(x.medPct ?? 0));
        if (!rows.length) continue;
        const what = [c.underpowered.length && `${c.underpowered.length} underpowered`, c.borderline.length && `${c.borderline.length} borderline`].filter(Boolean).join(', ');
        const listed = rows.slice(0, 4).map(r => `${r.key} ${sgn(r.medPct)} p ${r.p === null ? '–' : +r.p.toFixed(3)}`).join(', ') + (rows.length > 4 ? `, +${rows.length - 4} more` : '');
        const floor = c.underpowered.length ? ` · ${sizes[0]} v ${sizes[1]} sessions cannot reach p ≤ ${CALL_P}` : '';
        const time = one ? `, ${one.rough ? '~' : '≈ '}${Math.max(1, Math.round((one.ms * order.length) / 60000))} min` : '';
        blocks.push(`${what} at ${rate}x (${listed}${floor}) — one more ${order} block of ${name} (${order.length} sessions${time}) could call ${rows.length > 1 ? 'them' : 'it'}: ${how}`);
    }
}
for (const name of names.filter(p => role(p) === 'control')) {
    for (const [rate, R] of Object.entries(summary.passes[name].rates)) {
        const v = controlVerdict(R.control);
        if (v) advice.controls.push(Object.assign({ pass: name, rate: Number(rate) }, v));
    }
}
// macOS's own efficiency-core placement differing between the sides: part of a time difference can
// come from it (timing and control passes, 2+ sessions a side, separated by PLACEMENT_PP points)
advice.placement = [];
for (const name of names.filter(p => ['timing', 'control'].includes(role(p)))) {
    for (const [rate, R] of Object.entries(summary.passes[name].rates)) {
        const m = R.metrics[PLACEMENT];
        const [a, b] = Object.keys(R.sides);
        if (!m || !b || !m[a] || !m[b] || !m.delta || !m.delta.separated || m.delta.separated === 'overlap') continue;
        const pa = median(m[a].sessions);
        const pb = median(m[b].sessions);
        if (pa === null || pb === null || Math.abs(pb - pa) < PLACEMENT_PP) continue;
        const [hi, lo] = pb > pa ? [[b, pb], [a, pa]] : [[a, pa], [b, pb]];
        const r1 = v => +v.toFixed(1);
        advice.placement.push({
            pass: name, rate: Number(rate), [a]: r1(pa), [b]: r1(pb), diffPp: r1(pb - pa),
            text: `${hi[0]} ran ${r1(hi[1])} % of its main-thread CPU on efficiency cores vs ${lo[0]} ${r1(lo[1])} % (macOS placement with performance cores free) — part of a ${rate}x time difference can come from that`,
        });
    }
}
// only a control that missed the same way in every session blocks the advice
const failedCtl = advice.controls.filter(c => c.state === 'failed');
advice.next.push(...failedCtl.map(c => `fix the rig before adding sessions — the paired control ${c.pass} @ ${c.rate}x did not land (sessions ${c.range[0]}–${c.range[1]} %, median ${c.median} %; want ${LANDED_PCT[0]}–${LANDED_PCT[1]} %)`), ...blocks);
if (!judged.length) advice.next.push(names.some(p => role(p) === 'timing') ? 'no timing pass has 2+ sessions a side yet — run a session block before judging' : `run the timing passes (plan.mjs --run=${RUN_ID})`);
else if (!blocks.length && !failedCtl.length) advice.next.push('the draft is stable — more sessions would not change any verdict');
summary.advice = advice;
summary.warnings = warnings;
// the performance-core gate per side (gated passes only): wait, discards (by cause), per CPU rate the
// median of the sessions' median efficiency shares of kept iterations (macOS's own placement, as the
// placement flag reads it) and the largest, the most efficiency time that counted (contention or
// demotion, under the limit) and the median P clock. "gated" counts sessions whose measured
// iterations all passed the gate; a session that ran some ungated (the gate turned off mid-session:
// records with gate: 'off') is "partly", one without it says why
summary.pcore = {};
// earlier records: no eSharePct (from eMs, thread scope only), no eCountedMs (all judged time counted)
const shareOf = k => k.eSharePct ?? (k.scope !== 'process' && k.cpuMs ? (100 * k.eMs) / k.cpuMs : null);
const countedOf = k => k.eCountedMs ?? k.eJudgedMs ?? k.eMs;
for (const side of [...new Set(gated.map(g => g.side))].sort()) {
    const list = gated.filter(g => g.side === side);
    const ran = list.filter(g => g.pc.enabled || g.kept.length || g.ungated);
    const full = ran.filter(g => g.pc.enabled && !g.ungated);
    const kept = ran.flatMap(g => g.kept);
    const rates = Object.fromEntries([...new Set(kept.map(k => k.rate))].sort((a, b) => a - b).map(r => {
        const at = kept.filter(k => k.rate === r);
        const shares = at.map(shareOf).filter(v => v !== null);
        const med = median(ran.map(g => median(g.kept.filter(k => k.rate === r).map(shareOf).filter(v => v !== null))).filter(v => v !== null));
        const ghz = median(at.map(k => k.pGHz));

        return [r, { kept: at.length, medianEPct: med === null ? null : +med.toFixed(2), maxEPct: shares.length ? +Math.max(...shares).toFixed(2) : null, maxCountedMs: +Math.max(0, ...at.map(countedOf)).toFixed(1), medianGHz: ghz === null ? null : +ghz.toFixed(2) }];
    }));
    const causes = {};
    for (const d of ran.flatMap(g => g.pc.discards)) causes[d.cause || 'efficiency cores'] = (causes[d.cause || 'efficiency cores'] || 0) + 1;
    summary.pcore[side] = {
        sessions: list.length, gated: full.length, partly: ran.length - full.length, ungatedIterations: ran.reduce((t, g) => t + g.ungated, 0),
        off: [...new Set(list.filter(g => !g.pc.enabled).map(g => g.pc.reason).filter(Boolean))],
        waitMs: ran.reduce((t, g) => t + (g.pc.gateWaitMs || 0), 0), readyAttempts: ran.reduce((t, g) => t + (g.pc.readyAttempts || 0), 0),
        timeouts: ran.reduce((t, g) => t + (g.pc.timeouts || 0), 0), discards: ran.reduce((t, g) => t + g.pc.discards.length, 0), causes, rates,
        // process scope (no per-thread counters) records no main-thread share
        scopes: [...new Set(ran.map(g => g.pc.scope).filter(Boolean))],
    };
}

const outFile = path.join(run.dir, 'summary.json');
writeJson(outFile, summary);

// ------------------------------------------------------------------ console
const fmt = v => (v === null || v === undefined ? '–' : typeof v === 'number' ? (Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toFixed(1))) : String(v));
const cell = x => (x && x.stats ? `${fmt(x.stats.p50)}/${fmt(x.stats.p75)} [${fmt(x.stats.min)}–${fmt(x.stats.max)}]` : '–');
const sessStr = x => (x && x.sessions ? x.sessions.map(fmt).join(' ') : '');
const headKeys = (summary.headline || []).map(h => h.key);
const printOnly = list(args.print);
for (const [name, P] of Object.entries(summary.passes)) {
    if (printOnly.length && !printOnly.includes(name)) continue;
    const counts = P.role === 'counts';
    for (const [rate, R] of Object.entries(P.rates)) {
        const sides = Object.keys(R.sides);
        console.log(`\n### ${name} @ ${rate}x — kept ${sides.map(s => `${s} ${R.sides[s].n}/${R.sides[s].total} in ${R.sides[s].sessions.length} sessions`).join(', ')}${counts ? ' — counts (instrumented: no timing claims)' : ''}`);
        const shown = args.all ? Object.keys(R.metrics) : counts ? countKeys(R, summary.headline) : headKeys.length ? headKeys.filter(k => R.metrics[k]) : Object.keys(R.metrics).filter(k => k.startsWith('total.'));
        const show = shown.concat(!shown.includes(PLACEMENT) && R.metrics[PLACEMENT] ? [PLACEMENT] : []);
        // anything else whose sessions separate (p <= 0.1 needs 5+ sessions in total) by 5% or more
        const extra = args.all || counts ? [] : Object.keys(R.metrics).filter(k => {
            const d = R.metrics[k].delta;

            return !show.includes(k) && !k.startsWith('pcore.') && d && d.separated && d.separated !== 'overlap' && d.p !== null && d.p <= 0.1 && Math.abs(d.medPct || 0) >= 5;
        });
        console.log('metric'.padEnd(26), `${sides[0]} p50/p75 [min–max]`.padEnd(30), `${sides[1] || ''} p50/p75 [min–max]`.padEnd(30), 'Δp75'.padEnd(8), 'Δmed'.padEnd(8), 'sessions (A | B)  verdict p');
        for (const k of show.concat(extra.length ? ['—', ...extra] : [])) {
            if (k === '—') {
                console.log('  also separated (p <= 0.1, |Δmed| >= 5%):');
                continue;
            }
            const m = R.metrics[k];
            const d = m.delta || {};
            const sgn = v => (v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${v}%`);
            console.log(k.padEnd(26), cell(m[sides[0]]).padEnd(30), cell(m[sides[1]]).padEnd(30), sgn(d.p75Pct).padEnd(8), sgn(d.medPct).padEnd(8), `${sessStr(m[sides[0]])} | ${sessStr(m[sides[1]])}  ${d.separated || ''} ${d.p ?? ''}`);
        }
        if (R.control) {
            for (const [side, list_] of Object.entries(R.control)) {
                for (const c of list_) {
                    const t = c.landed['total.taskMs'] || Object.values(c.landed)[0] || {};
                    console.log(`  control ${side} ${c.session}: +${c.injectMs} ms x calls = ${fmt(c.expectedMs)} ms expected, total.taskMs moved ${fmt(t.deltaMs)} ms = ${t.landedPct ?? '–'}%`);
                }
            }
        }
        for (const side of sides) for (const p of R.sides[side].problems.slice(0, 5)) console.log('  problem', p);
    }
}
console.log(`\n### advice — could more sessions change a verdict? (called: sessions separate, p ≤ ${CALL_P}; borderline: p ≤ ${BORDER_P})`);
for (const [name, rates] of Object.entries(advice.passes)) {
    console.log(Object.entries(rates).map(([rate, c]) => `${name} @ ${rate}x (${c.sessions.join(' v ')}): ${['called', 'underpowered', 'borderline', 'settled'].filter(x => c[x].length).map(x => `${c[x].length} ${x}`).join(', ')}`).join(' · '));
}
for (const c of advice.controls) console.log(controlText(c, `${c.pass} @ ${c.rate}x`));
for (const f of advice.placement) console.log(`flag: ${f.pass} @ ${f.rate}x: ${f.text}`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const l of advice.next) console.log(`next: ${l}`);
for (const [side, g] of Object.entries(summary.pcore)) {
    const perRate = Object.entries(g.rates).map(([r, x]) => `${r}x E share ${x.medianEPct ?? '–'} % median (≤ ${x.maxEPct ?? '–'} %; counted ≤ ${x.maxCountedMs} ms), P ${x.medianGHz ?? '–'} GHz`).join('; ');
    const partly = g.partly ? ` · ${g.partly} partly gated (${g.ungatedIterations} measured iterations ran ungated)` : '';
    const why = Object.entries(g.causes || {}).map(([c, n]) => `${n} ${c}`).join(', ');
    console.log(`pcore ${side}: ${g.gated || g.partly ? `${g.gated}/${g.sessions} sessions gated${partly} · waited ${dur(g.waitMs)} · ${g.discards} discarded${why ? ` (${why})` : ''}${g.timeouts ? ` · ${g.timeouts} gates not met` : ''}${perRate ? ` · ${perRate}` : ''}${(g.scopes || []).includes('process') ? ' · process scope: no main-thread share' : ''}` : 'off'}${g.off.length ? ` · off: ${g.off.join('; ')}` : ''}`);
}
console.log(`\nsummary: ${outFile}`);
