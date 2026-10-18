/**
 * Summarize a run's session outputs (out/<pass>-<n>-<side>.json) into summary.json and a console
 * table per pass and CPU rate.
 *
 *   node aggregate.mjs --run=<name|dir> [--passes=main,ctl] [--print=main] [--warmup=<n>] [--all]
 *        [--brief] [--allow-mixed-builds] [--allow-mixed-power]
 *
 * --passes limits what is summarized (default: every pass in out/), --print only what is printed.
 * --brief (what plan.mjs prints at its end) changes only the console: per timing pass x rate every
 * headline metric as one line (Δ of the session medians, the session medians, verdict, p), every
 * other separated metric as one line, the drift; per control session its landing (paired with
 * neighbours, the trend fit, the naive one); counts that differ; one env line per side (commit ✓, profile, performance cores,
 * power); the advice and next lines. summary.json and the report keep everything.
 *
 * Power: every session records its power source (run.mjs meta.power / powerEnd). A timing pass
 * whose sessions ran on AC and on battery (or in Low Power Mode, or changed mid-session) is refused
 * (exit 2, no summary) — the cores run at other clocks; --allow-mixed-power pools them with a warning.
 *
 * Paired control: a session's landing pairs every injected iteration with its plain neighbours on
 * the phases the cost was injected into (control[].neighbour: the interpolation between the nearest
 * plain iteration before and after it, the one neighbour at an end; the median of (injected −
 * reference) ÷ injected) — what the verdict reads — next to the plain iterations' linear trend
 * (control[].trend, a cross-check) and the naive median inject − median plain on total.taskMs
 * (control[].landed). Load that climbs inside a session (history-load: +109 to +226 ms an iteration)
 * otherwise lands on whichever iterations run later.
 * Drift: per timing and control session the slope of the headline CPU metric over its kept iterations
 * (ms an iteration, % of its median: sessions[].drift); a pass x rate whose median passes 1 %/it, with
 * most sessions agreeing in sign, is consistent, and flagged (R.drift, advice.drift) only when the
 * climb over a session, |slope| × k/2, reaches a third of the reported Δ (driftMatters).
 *
 * Builds first: every session records the commit its bundle carried (env.build, from the inlined
 * COMMITHASH / release string). A side whose sessions ran more than one commit — a deployed preview
 * that redeployed mid-run, a side rebuilt from another revision between sessions — is refused (exit
 * 2, no summary): those numbers describe two builds. --allow-mixed-builds pools them anyway, with a
 * warning. summary.run.sides carries each side's commit, profile, fingerprint (React Compiler
 * coverage) and summary.run.base the revision check (revs.mjs).
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
import { parseArgs, list, loadRun, resolveIn, readJson, tryJson, writeJson, summarize, median, mean, linearFit, permutationP, separated, importScenario, dur, CALL_P, called, minP, LANDED_PCT, controlVerdict, controlText, naiveLanding, isMs, roleResolver, countKeys, planSessions, timingHistory, etaModel, sideCommit, sessionCommit, powerKey } from './lib.mjs';
import { compilerText } from './fingerprint.mjs';

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
// ------------------------------------------------------------------ in-session trends
// a record's place in its session's time order (n counts every attempt; older records: iter)
const xOf = r => (Number.isInteger(r.n) ? r.n : r.iter);
// the phases an injected iteration's cost went into, and their task time
const injectedPhases = recs => [...new Set(recs.flatMap(r => Object.entries(r.phases || {}).filter(([, ph]) => (ph.injectedMs || 0) > 0).map(([n]) => n)))];
const phaseTask = (r, phases) => phases.reduce((t, n) => t + ((r.phases[n] && r.phases[n].taskMs) || 0), 0);
/**
 * A paired control's landing against its plain neighbours (what the verdict reads): every injected
 * iteration is compared with the plain iterations around it — the line between the nearest plain one
 * before and after it, at its position (with 0 I 0 I their mean; with 0 I I 0 the interpolation at
 * each I), or the one plain neighbour at an end — on the phases the cost went into; the session's
 * landing is the median over its injected iterations of (injected − reference) ÷ what it injected.
 * Slow variation (a climb, warm-up, machine state) cancels pair by pair. Measured: drift-hl-fix
 * ctlnr-1-A / -2-A land at 106 / 109 % this way, where median inject − median plain reads 110 / 132 %.
 * `ok`: the session's measured iterations of one rate, plain and injected.
 */
const neighbourLanding = ok => {
    const recs = ok.toSorted((a, b) => xOf(a) - xOf(b));
    const phases = injectedPhases(recs.filter(r => r.inject));
    if (!phases.length) return null;
    const pcts = [];
    for (const [i, r] of recs.entries()) {
        if (!r.inject) continue;
        const before = recs.slice(0, i).findLast(x => !x.inject);
        const after = recs.slice(i + 1).find(x => !x.inject);
        if (!before && !after) continue;
        const ref = !before ? phaseTask(after, phases) : !after ? phaseTask(before, phases)
            : phaseTask(before, phases) + ((phaseTask(after, phases) - phaseTask(before, phases)) * (xOf(r) - xOf(before))) / (xOf(after) - xOf(before));
        const injected = phases.reduce((t, n) => t + ((r.phases[n] && r.phases[n].injectedMs) || 0), 0);
        if (injected) pcts.push(((phaseTask(r, phases) - ref) / injected) * 100);
    }

    return pcts.length ? { metric: `${phases.join('+')}.taskMs`, phases, landedPct: Math.round(median(pcts)), pairs: pcts.length, pcts: pcts.map(p => Math.round(p)) } : null;
};
/**
 * The cross-check: the plain iterations' linear trend — a line through the plain iterations' task
 * time on the phases the cost went into, the injected iterations' residuals from it averaged, as a %
 * of what they injected. Load that climbs from one iteration to the next lands on an injected
 * iteration that runs a step later than its plain partner; the naive landing (median inject − median
 * plain, total.taskMs) counts that climb as landed cost. null under 2 plain iterations.
 */
const trendLanding = (plain, injected) => {
    const phases = injectedPhases(injected);
    if (!phases.length || plain.length < 2 || !injected.length) return null;
    const fit = linearFit(plain.map(xOf), plain.map(r => phaseTask(r, phases)));
    if (!fit) return null;
    const deltaMs = mean(injected.map(r => phaseTask(r, phases) - (fit.intercept + fit.slope * xOf(r))));
    const expectedMs = mean(injected.map(r => phases.reduce((t, n) => t + ((r.phases[n] && r.phases[n].injectedMs) || 0), 0)));
    const naive = median(injected.map(r => phaseTask(r, phases))) - median(plain.map(r => phaseTask(r, phases)));
    const pctOf = v => (expectedMs ? Math.round((v / expectedMs) * 100) : null);

    return { metric: `${phases.join('+')}.taskMs`, phases, deltaMs: +deltaMs.toFixed(1), expectedMs: +expectedMs.toFixed(1), landedPct: pctOf(deltaMs), naivePct: pctOf(naive), slopeMsPerIter: +fit.slope.toFixed(1) };
};
// in-session drift: the slope of the headline CPU metric over a session's kept iterations (ms per
// iteration and % of the session's median); a pass x rate whose sessions' median drift passes
// DRIFT_PCT per iteration is flagged — state that builds up inside a session (a control's pairing
// and a verdict at another k depend on it)
const DRIFT_PCT = 1;
const DRIFT_KEY = ((scenario.headline || []).map(h => h.key).find(k => /(taskMs|taskCorrMs|cpuMs|CpuMs)$/.test(k))) || 'total.taskMs';
/**
 * Whether a consistent drift can matter: the climb over a session, |median slope| × k/2 (how far the
 * session median sits from where the session started), reaches a third of what the pass reports —
 * for a timing pass the largest |Δ| (ms, between the sides' session medians) among its called
 * headline metrics, or the drift metric's own Δ when none is called; for a control pass the injected
 * cost. Below that the slope is information only (R.drift.flagged false, matters false).
 * coinjoin-address-stats main @ 1x: +0.2 ms/it × 4 = 0.8 ms against info.ms −92 ms: information.
 * pr33507 h40 @ 4x: +155 ms/it × 4 = 620 ms against load.ms −430 ms: flagged.
 */
const DRIFT_SHARE = 1 / 3;
const driftMatters = (R, P) => {
    const d = R.drift;
    const sides = Object.keys(R.sides);
    const deltaMs = key => {
        const m = R.metrics[key];
        const [a, b] = sides;
        const A = m && m[a] && median(m[a].sessions);
        const B = m && m[b] && median(m[b].sessions);

        return typeof A === 'number' && typeof B === 'number' ? Math.abs(B - A) : null;
    };
    const k = Number((P.meta && P.meta.k) || 0);
    d.climbMs = +((Math.abs(d.medianMsPerIter) * k) / 2).toFixed(1);
    if (P.role === 'control') {
        const exp = median(Object.values(R.control || {}).flat().map(c => c.expectedMs).filter(Number.isFinite));
        d.ref = exp === null ? null : { key: 'injected cost', ms: +exp.toFixed(1) };
    } else {
        const heads = (scenario.headline || []).map(h => h.key);
        const keys = (heads.length ? heads : Object.keys(R.metrics).filter(x => /^[^.]+\.(ms|taskMs)$|^total\.taskMs$/.test(x))).filter(x => isMs(x) && R.metrics[x] && called(R.metrics[x].delta));
        const best = keys.map(key => ({ key, ms: deltaMs(key) })).filter(x => x.ms !== null).toSorted((x, y) => y.ms - x.ms)[0];
        const own = deltaMs(d.key);
        d.ref = best ? { key: best.key, ms: +best.ms.toFixed(1), called: true } : own === null ? null : { key: d.key, ms: +own.toFixed(1), called: false };
    }
    d.share = DRIFT_SHARE;
    d.matters = !d.ref || d.climbMs >= d.ref.ms * DRIFT_SHARE;
    d.flagged = d.consistent && d.matters;
};
const driftOf = (recs, flat) => {
    const pts = recs.map((r, i) => [xOf(r), flat[i][DRIFT_KEY]]).filter(([x, y]) => Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y));
    // two points make a difference, not a slope
    if (pts.length < 3) return null;
    const fit = linearFit(pts.map(p => p[0]), pts.map(p => p[1]));
    const med = median(pts.map(p => p[1]));
    if (!fit || !med) return null;

    return { slopeMs: +fit.slope.toFixed(1), pctPerIter: +((fit.slope / med) * 100).toFixed(2), n: pts.length };
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
const TARGET = run.target || 'web';
// the revision check revs.mjs recorded, without its file lists
const baseOf = b => (b ? { branch: b.branch, tip: b.tip, mergeBase: b.mergeBase, behind: b.behind, ahead: b.ahead, mode: b.mode || null, state: b.state || null, checkedAt: b.checkedAt, pr: b.pr || null, mergeRefLag: b.mergeRefLag ?? null, overlap: (b.overlap || []).length } : null);
const summary = {
    run: {
        id: run.id, title: run.title, pr: run.pr, target: TARGET, device: run.device || 'synthetic', scenario: scenario.name || run.scenario,
        profile: (run.build && run.build.profile) || null,
        base: baseOf(run.base),
        sides: Object.fromEntries(Object.entries(run.sides).map(([k, s]) => [k, {
            label: s.label, rev: s.rev, sha: s.sha, buildSha: s.buildSha || null, variant: s.variant || null, url: s.url || null, profile: s.profile || null,
            fingerprint: (s.fingerprint && s.fingerprint[TARGET]) || null, guide: s.guide || null, commit: null, commits: {},
        }])),
    },
    generated: new Date().toISOString(),
    headline: scenario.headline || null,
    passes: {},
};
// the commit every session ran, per side (all passes): one build per side, or no summary
const ranOn = {};
// a session's power source: 'ac', 'battery', '+lowpower', 'mixed' when it changed during the session, null when unrecorded
const powerOf = meta => {
    const a = powerKey(meta && meta.power);
    const b = meta && meta.powerEnd ? powerKey(meta.powerEnd) : a;

    return a && b && a !== b ? 'mixed' : a || b || null;
};
// timing passes whose sessions ran on different power sources: refused below, like mixed builds
const mixedPower = [];

for (const passName of passes) {
    const sess = all.filter(s => s.pass === passName).sort((a, b) => a.n - b.n);
    const sides = [...new Set(sess.map(s => s.side))].sort();
    const P = { sessions: {}, meta: null, rates: {} };
    const loaded = [];
    for (const s of sess) {
        const d = readJson(path.join(OUT, s.file));
        if (!d.runs || !d.runs.length) continue;
        loaded.push(Object.assign({ d }, s));
        const c = sessionCommit(d);
        if (c) ((ranOn[s.side] ||= {})[c] ||= []).push(s.file.replace(/\.json$/, ''));
        (P.sessions[s.side] = P.sessions[s.side] || []).push({ id: s.file.replace(/\.json$/, ''), complete: !!d.complete, iterations: d.runs.length, started: d.meta.started, load: d.meta.host && d.meta.host.load, power: powerOf(d.meta), browser: d.meta.browser, env: d.env && { markers: Object.fromEntries(Object.entries(d.env.markers || {}).filter(([n]) => !/^[0-9a-f]{40}$/.test(n))), coverageFiles: d.env.coverageFiles, renderers: d.env.renderers, canary: d.env.canary, desktopLaunches: d.env.desktopLaunches, build: d.env.build || null, discovery: d.env.discovery || null, pageHook: d.env.pageHook || null }, commit: sessionCommit(d), calib: d.calib, idle: Object.fromEntries(Object.entries(d.idle || {}).map(([r, i]) => [r, { taskPerS: i.ms ? +(i.taskMs / (i.ms / 1000)).toFixed(1) : null, commits: i.commits }])), pcore: d.meta.pcore ? { enabled: d.meta.pcore.enabled, reason: d.meta.pcore.reason, waitMs: d.meta.pcore.gateWaitMs, discards: d.meta.pcore.discards.length, kept: d.meta.pcore.kept.length } : null, error: d.error || null });
        if (!P.meta) P.meta = { k: d.meta.k, rates: d.meta.rates, warmup: d.meta.warmup, idleMs: d.meta.idleMs, cfg: d.meta.cfg, altInject: d.meta.altInject, target: d.meta.target, device: d.meta.device, scenario: d.meta.scenario };
    }
    P.role = roleOf(passName, P.meta);
    // AC and battery (or Low Power Mode) clock the cores differently: one timing pass, one power source
    if (P.role === 'timing') {
        const by = Object.groupBy(Object.values(P.sessions).flat().filter(x => x.power), x => x.power);
        if (Object.keys(by).length > 1) mixedPower.push(`${passName} ran on ${Object.entries(by).map(([k, l]) => `${k} (${l.map(x => x.id).join(', ')})`).join(' and ')}`);
        else if (by.battery || Object.keys(by).some(k => k.includes('lowpower'))) warnings.push(`${passName} ran ${by.battery ? 'on battery' : 'in Low Power Mode'} — not how the cores run on AC power; measure on AC (plan.mjs waits for it)`);
    }
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
                sessionsVals.push({ id: s.file.replace(/\.json$/, ''), flat, load1m: median(recs.map(r => r.load1m)), drift: ['timing', 'control'].includes(P.role) ? driftOf(base, flat) : null });
                if (s.d.meta.altInject) {
                    const injRecs = ok.filter(r => r.inject);
                    const inj = injRecs.map(r => ({ f: flatten(r, s.d), r }));
                    const keys = Object.keys(flat[0] || {}).filter(k => /\.taskMs$/.test(k) || k === 'total.taskMs');
                    const expected = median(inj.map(x => Object.values(x.r.phases).reduce((t, ph) => t + (ph.injectedMs || 0), 0)));
                    const landed = {};
                    for (const k of keys) {
                        const dlt = median(inj.map(x => x.f[k])) - median(flat.map(x => x[k]));
                        landed[k] = { deltaMs: +dlt.toFixed(1), landedPct: expected ? +((dlt / expected) * 100).toFixed(0) : null };
                    }
                    // pairs: inject / no-inject iterations; under 3 a session's landing is mostly noise. `landed`:
                    // the naive landing per phase; `trend`: against the plain iterations' line (the verdict's)
                    // seq: the measured iterations' order, 0 plain / I injected (ABBA since the rig paired them so: 0II00II0)
                    control.push({ session: s.file.replace(/\.json$/, ''), injectMs: s.d.meta.altInject, expectedMs: expected, pairs: Math.min(inj.length, flat.length), seq: ok.map(r => (r.inject ? 'I' : '0')).join(''), landed, neighbour: neighbourLanding(ok), trend: trendLanding(base, injRecs) });
                }
            }
            perSide[side] = { kept, sessionsVals };
            R.sides[side] = { n: kept.length, total, problems, sessions: sessionsVals.map(v => ({ id: v.id, kept: v.flat.length, load1m: v.load1m, drift: v.drift })) };
            if (control.length) (R.control = R.control || {})[side] = control;
        }
        // drift of the headline CPU metric inside the sessions of a timing or control pass
        const drifts = sides.flatMap(side => perSide[side].sessionsVals.filter(v => v.drift).map(v => Object.assign({ id: v.id, side }, v.drift)));
        if (drifts.length) {
            const med = median(drifts.map(d => d.pctPerIter));
            // one session's slope over 3-6 points is noisy: flag a median past the threshold that most sessions share in sign
            const along = drifts.filter(d => Math.sign(d.pctPerIter) === Math.sign(med)).length / drifts.length;
            // consistent: past DRIFT_PCT a iteration, most sessions agreeing; flagged below only when it can matter
            R.drift = { key: DRIFT_KEY, thresholdPct: DRIFT_PCT, medianPctPerIter: +med.toFixed(2), medianMsPerIter: +median(drifts.map(d => d.slopeMs)).toFixed(1), sameSign: +along.toFixed(2), consistent: Math.abs(med) > DRIFT_PCT && along >= 0.75, flagged: false, over: drifts.filter(d => Math.abs(d.pctPerIter) > DRIFT_PCT).map(d => d.id) };
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
        if (R.drift) driftMatters(R, P);
        P.rates[rate] = R;
    }
    summary.passes[passName] = P;
}

// ------------------------------------------------------------------ builds
// one commit per side across every session, or the numbers describe two builds
const mixed = [];
for (const [k, side] of Object.entries(summary.run.sides)) {
    const by = ranOn[k] || {};
    side.commits = Object.fromEntries(Object.entries(by).map(([c, ids]) => [c, ids.length]));
    const commits = Object.keys(by);
    side.commit = commits.length === 1 ? commits[0] : null;
    if (commits.length > 1) mixed.push(`side ${k}${side.url ? ` (${side.url})` : ''} ran ${commits.length} builds: ${commits.map(c => `${c.slice(0, 10)} in ${by[c].length} (${by[c].slice(0, 3).join(', ')}${by[c].length > 3 ? ', …' : ''})`).join('; ')}`);
    const want = sideCommit(run.sides[k]);
    if (commits.length === 1 && want && commits[0] !== want) warnings.push(`side ${k}'s sessions ran ${commits[0].slice(0, 10)}, but run.json now builds ${want.slice(0, 10)} — re-pinned or rebuilt since: plan.mjs reruns them`);
}
const sideCommits = Object.values(summary.run.sides).map(x => x.commit).filter(Boolean);
if (sideCommits.length > 1 && new Set(sideCommits).size === 1) {
    const profiles = new Set(Object.values(summary.run.sides).map(x => x.profile || '–'));
    warnings.push(profiles.size > 1 ? `every side ran the same commit ${sideCommits[0].slice(0, 10)} in another build profile (${Object.entries(summary.run.sides).map(([k, x]) => `${k} ${x.profile}`).join(', ')}): a build-config comparison` : `every side ran the same commit ${sideCommits[0].slice(0, 10)}: an A/A comparison`);
}
if (mixed.length) {
    const why = 'a side whose sessions ran more than one build cannot be pooled: a deployed preview that redeployed mid-run (develop on every push), or a side rebuilt between sessions';
    if (!args.allowMixedBuilds) {
        for (const m of mixed) console.error(`refused: ${m}`);
        console.error(`${why}. Keep one build's sessions (move the others out of out/), or pool them anyway with --allow-mixed-builds (with a warning in the report).`);
        process.exit(2);
    }
    warnings.push(...mixed.map(m => `mixed builds pooled (--allow-mixed-builds): ${m}`));
}
if (mixedPower.length) {
    if (!args.allowMixedPower) {
        for (const m of mixedPower) console.error(`refused: timing pass ${m}`);
        console.error('AC and battery (or Low Power Mode) sessions are not pooled into one timing pass: the cores run at other clocks. Run the minority sessions again on AC power (move their records out of out/; plan.mjs waits for AC before timing), or pool them anyway with --allow-mixed-power (with a warning in the report).');
        process.exit(2);
    }
    warnings.push(...mixedPower.map(m => `mixed power pooled (--allow-mixed-power): ${m}`));
}

// ------------------------------------------------------------------ page tools
// page-provided tools (devtoolstooldiscovery, references/discovery.md): the sides must offer the same contract
const toolsOf = k => {
    for (const p of Object.values(summary.passes)) for (const s of p.sessions[k] || []) if (s.env && s.env.discovery) return s.env.discovery;

    return null;
};
const toolsText = t => (t && t.found ? t.groups.map(g => `${g.name}${g.description ? ` (${g.description})` : ''}: ${g.tools.slice().sort().join(', ')}`).join('; ') : 'none');
for (const [k, side] of Object.entries(summary.run.sides)) side.tools = toolsOf(k);
const toolTexts = Object.entries(summary.run.sides).map(([k, s]) => [k, toolsText(s.tools)]);
if (toolTexts.length > 1 && new Set(toolTexts.map(x => x[1])).size > 1) warnings.push(`the sides offer different page tools (devtoolstooldiscovery): ${toolTexts.map(([k, v]) => `${k} → ${v}`).join(' | ')} — the change touches Suite's automation tools; where a tool was missing the rig used its own helpers`);

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
// in-session drift past DRIFT_PCT a iteration (median of the sessions): load that builds up inside a session
advice.drift = [];
for (const name of names.filter(p => ['timing', 'control'].includes(role(p)))) {
    for (const [rate, R] of Object.entries(summary.passes[name].rates)) {
        const d = R.drift;
        if (!d || !d.flagged) continue;
        const n = Object.values(R.sides).reduce((t, s) => t + s.sessions.filter(x => x.drift).length, 0);
        advice.drift.push({
            pass: name, rate: Number(rate), key: d.key, medianPctPerIter: d.medianPctPerIter, medianMsPerIter: d.medianMsPerIter,
            climbMs: d.climbMs, ref: d.ref,
            text: `${name} @ ${rate}x: ${d.key} drifts ${d.medianPctPerIter > 0 ? '+' : ''}${d.medianPctPerIter} % a iteration inside the sessions (${d.medianMsPerIter > 0 ? '+' : ''}${d.medianMsPerIter} ms/it, median; ${d.over.length} of ${n} sessions past ${DRIFT_PCT} %), ${d.climbMs} ms over a session${d.ref ? ` against the ${d.ref.key}${d.ref.key === 'injected cost' ? '' : ' Δ'} ${d.ref.ms} ms` : ''} — something builds up per iteration: the session medians hold for this k${role(name) === 'control' ? '; the control verdict pairs each injected iteration with its neighbours' : ''}`,
        });
    }
}
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
const sgnP = v => (v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${v}%`);
const shownKeys = (R, counts) => {
    const shown = args.all ? Object.keys(R.metrics) : counts ? countKeys(R, summary.headline) : headKeys.length ? headKeys.filter(k => R.metrics[k]) : Object.keys(R.metrics).filter(k => k.startsWith('total.'));

    return shown.concat(!shown.includes(PLACEMENT) && R.metrics[PLACEMENT] ? [PLACEMENT] : []);
};
// anything else whose sessions separate (p <= 0.1 needs 5+ sessions in total) by 5% or more
const extraKeys = (R, show) => Object.keys(R.metrics).filter(k => {
    const d = R.metrics[k].delta;

    return !show.includes(k) && !k.startsWith('pcore.') && d && d.separated && d.separated !== 'overlap' && d.p !== null && d.p <= 0.1 && Math.abs(d.medPct || 0) >= 5;
});
const controlLine = (side, c) => {
    const naive = naiveLanding(c);
    const nb = c.neighbour;
    const t = c.trend;
    if (!nb && !t) return `control ${side} ${c.session}: +${c.injectMs} ms x calls = ${fmt(c.expectedMs)} ms expected, total.taskMs moved ${naive ?? '–'}%`;

    return `control ${side} ${c.session}${c.seq ? ` (${c.seq})` : ''}: ${nb ? `${nb.landedPct} % paired with neighbours on ${nb.metric} (${nb.pairs}: ${nb.pcts.join(' ')})` : 'no neighbour pairs'} · trend fit ${t ? `${t.landedPct ?? '–'} % (${fmt(t.deltaMs)} of ${fmt(t.expectedMs)} ms; plain trend ${t.slopeMsPerIter > 0 ? '+' : ''}${t.slopeMsPerIter} ms/it)` : '–'} · naive ${naive ?? '–'} % on total.taskMs`;
};
const signed = v => `${v > 0 ? '+' : ''}${v}`;
const driftLine = (R, short = false) => {
    const d = R.drift;
    if (!d) return null;
    const per = side => R.sides[side].sessions.map(x => (x.drift ? signed(+x.drift.pctPerIter.toFixed(1)) : '–')).join(' ');
    const vs = d.ref ? `${d.climbMs} ms over a session ${d.flagged ? '≥' : '<'} ⅓ of the ${d.ref.key} ${d.ref.key === 'injected cost' ? '' : 'Δ '}${d.ref.ms} ms` : `${d.climbMs} ms over a session`;
    const flag = d.flagged ? (short ? ` FLAG: ${vs}` : ` — FLAG: the load builds up inside the sessions, ${vs}`) : d.consistent ? ` (information: ${vs})` : '';

    const ms = Math.abs(d.medianMsPerIter) >= 10 ? Math.round(d.medianMsPerIter) : d.medianMsPerIter;

    return `drift ${d.key} %/it${short ? '' : ' (slope / session median)'}: ${Object.keys(R.sides).map(s => `${s} ${per(s)}`).join(' | ')} · median ${signed(d.medianPctPerIter)}${short ? '' : ' %/it'} (${signed(ms)} ms/it)${flag}`;
};
const pText = p => (p === null || p === undefined ? '–' : String(+p.toFixed(3)));
const tables = () => {
    for (const [name, P] of Object.entries(summary.passes)) {
        if (printOnly.length && !printOnly.includes(name)) continue;
        const counts = P.role === 'counts';
        for (const [rate, R] of Object.entries(P.rates)) {
            const sides = Object.keys(R.sides);
            console.log(`\n### ${name} @ ${rate}x — kept ${sides.map(s => `${s} ${R.sides[s].n}/${R.sides[s].total} in ${R.sides[s].sessions.length} sessions`).join(', ')}${counts ? ' — counts (instrumented: no timing claims)' : ''}`);
            const show = shownKeys(R, counts);
            const extra = args.all || counts ? [] : extraKeys(R, show);
            console.log('metric'.padEnd(26), `${sides[0]} p50/p75 [min–max]`.padEnd(30), `${sides[1] || ''} p50/p75 [min–max]`.padEnd(30), 'Δp75'.padEnd(8), 'Δmed'.padEnd(8), 'sessions (A | B)  verdict p');
            for (const k of show.concat(extra.length ? ['—', ...extra] : [])) {
                if (k === '—') {
                    console.log('  also separated (p <= 0.1, |Δmed| >= 5%):');
                    continue;
                }
                const m = R.metrics[k];
                const d = m.delta || {};
                console.log(k.padEnd(26), cell(m[sides[0]]).padEnd(30), cell(m[sides[1]]).padEnd(30), sgnP(d.p75Pct).padEnd(8), sgnP(d.medPct).padEnd(8), `${sessStr(m[sides[0]])} | ${sessStr(m[sides[1]])}  ${d.separated || ''} ${d.p ?? ''}`);
            }
            const dl = driftLine(R);
            if (dl) console.log(`  ${dl}`);
            for (const [side, list_] of Object.entries(R.control || {})) for (const c of list_) console.log(`  ${controlLine(side, c)}`);
            for (const side of sides) for (const p of R.sides[side].problems.slice(0, 5)) console.log('  problem', p);
        }
    }
};
// the same verdicts in ~1.5k tokens: per timing pass x rate every headline metric (Δ of the session
// medians, the session medians, verdict, p), every other separated metric, the drift; per control
// session its landing; counts that differ; one env line per side. summary.json keeps everything
const brief = () => {
    const med = x => (x && x.sessions ? x.sessions.map(fmt).join(' ') : '–');
    for (const [name, P] of Object.entries(summary.passes)) {
        if (printOnly.length && !printOnly.includes(name)) continue;
        for (const [rate, R] of Object.entries(P.rates)) {
            const sides = Object.keys(R.sides);
            const kept = sides.map(s => `${s} ${R.sides[s].sessions.length}s ${R.sides[s].n}/${R.sides[s].total}`).join(', ');
            if (P.role === 'counts') {
                const diff = countKeys(R, summary.headline).filter(k => new Set(sides.map(s => (R.metrics[k][s] && R.metrics[k][s].stats ? R.metrics[k][s].stats.p50 : null))).size > 1);
                console.log(`## ${name} @ ${rate}x · counts (${kept}): ${diff.length ? diff.map(k => `${k} ${sides.map(s => fmt(R.metrics[k][s] && R.metrics[k][s].stats && R.metrics[k][s].stats.p50)).join('→')}`).join(', ') : 'every count the same on both sides'}`);
                continue;
            }
            if (P.role === 'trial') {
                const keys = (headKeys.length ? headKeys : ['total.taskMs']).filter(k => R.metrics[k]).slice(0, 2);
                console.log(`## ${name} @ ${rate}x · trial, not judged (${kept}): ${keys.map(k => `${k} ${sides.map(s => `${s} ${med(R.metrics[k][s])}`).join(' | ')}`).join(' · ')}`);
                continue;
            }
            console.log(`## ${name} @ ${rate}x · ${P.role} (${kept})`);
            if (P.role === 'timing') {
                const show = shownKeys(R, false);
                // the placement share stays in the full tables; a difference between the sides is a flag below
                for (const k of show.filter(x => x !== PLACEMENT)) {
                    const m = R.metrics[k];
                    const d = m.delta || {};
                    console.log(`${k} ${sgnP(d.medPct) || '–'} · ${sides.map(s => med(m[s])).join(' | ')} · ${d.separated || '–'} p ${pText(d.p)}`);
                }
                for (const k of extraKeys(R, show)) {
                    const d = R.metrics[k].delta;
                    console.log(`also ${k} ${sgnP(d.medPct)} ${d.separated} p ${pText(d.p)}`);
                }
            }
            const v = R.control ? controlVerdict(R.control) : null;
            if (v) console.log(controlText(v));
            for (const [side, list_] of Object.entries(R.control || {})) {
                console.log(`${side}: ${list_.map(c => `${c.session} ${c.neighbour ? `${c.neighbour.landedPct}%` : '–'} (trend ${c.trend && c.trend.landedPct !== null ? `${c.trend.landedPct}%` : '–'}, naive ${naiveLanding(c) ?? '–'}%)`).join(' · ')}`);
            }
            const dl = driftLine(R, true);
            if (dl) console.log(dl);
            const problems = sides.reduce((t, s) => t + R.sides[s].problems.length, 0);
            if (problems) console.log(`problems: ${problems} iterations dropped (${sides.flatMap(s => R.sides[s].problems).slice(0, 2).join('; ').slice(0, 200)})`);
        }
    }
    // env, one line per side: the commit check, profile, performance cores, power
    for (const [k, side] of Object.entries(summary.run.sides)) {
        const sess = Object.values(summary.passes).flatMap(p => p.sessions[k] || []);
        const withBuild = sess.filter(x => x.env && x.env.build);
        const ok = withBuild.filter(x => x.env.build.verified === true || x.env.build.verified === 'offline').length;
        const c = side.commit || sideCommit(run.sides[k]);
        const g = summary.pcore[k];
        const e4 = g && (g.rates['4'] || Object.values(g.rates)[0]);
        const power = Object.entries(Object.groupBy(sess.filter(x => x.power), x => x.power)).map(([p, l]) => `${p} ${l.length}`).join(', ') || 'unrecorded';
        console.log(`env ${k}: ${c ? c.slice(0, 10) : 'commit unknown'} ${withBuild.length ? (ok === withBuild.length ? `✓ ${ok}/${withBuild.length}` : `✗ ${ok}/${withBuild.length} sessions carried it`) : ''} · ${side.profile || '–'} · pcore ${g ? `${g.gated}/${g.sessions} gated, ${g.discards} discarded${e4 ? `, E ${e4.medianEPct ?? '–'} %` : ''}` : 'off'} · power ${power}`);
    }
};
const adviceLines = (short = false) => {
    console.log(`\n### advice — could more sessions change a verdict? (called: sessions separate, p ≤ ${CALL_P}; borderline: p ≤ ${BORDER_P})`);
    for (const [name, rates] of Object.entries(advice.passes)) {
        console.log(Object.entries(rates).map(([rate, c]) => `${name} @ ${rate}x (${c.sessions.join(' v ')}): ${['called', 'underpowered', 'borderline', 'settled'].filter(x => c[x].length).map(x => `${c[x].length} ${x}`).join(', ')}`).join(' · '));
    }
    // the brief has the control verdicts and the drift per pass above
    if (!short) for (const c of advice.controls) console.log(controlText(c, `${c.pass} @ ${c.rate}x`));
    for (const f of advice.placement) console.log(`flag: ${f.pass} @ ${f.rate}x: ${f.text}`);
    if (!short) for (const d of advice.drift) console.log(`flag: ${d.text}`);
    else if (advice.drift.length) console.log(`flag: in-session drift that can matter (the climb over a session reaches a third of the reported Δ) in ${advice.drift.map(d => `${d.pass} @ ${d.rate}x`).join(', ')} — something builds up per iteration: the session medians hold for this k`);
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const l of advice.next) console.log(`next: ${l}`);
};
if (args.brief) {
    brief();
    adviceLines(true);
    console.log(`\nsummary: ${outFile} · the full tables: aggregate.mjs --run=${RUN_ID}`);
    process.exit(0);
}
tables();
adviceLines();
for (const [side, g] of Object.entries(summary.pcore)) {
    const perRate = Object.entries(g.rates).map(([r, x]) => `${r}x E share ${x.medianEPct ?? '–'} % median (≤ ${x.maxEPct ?? '–'} %; counted ≤ ${x.maxCountedMs} ms), P ${x.medianGHz ?? '–'} GHz`).join('; ');
    const partly = g.partly ? ` · ${g.partly} partly gated (${g.ungatedIterations} measured iterations ran ungated)` : '';
    const why = Object.entries(g.causes || {}).map(([c, n]) => `${n} ${c}`).join(', ');
    console.log(`pcore ${side}: ${g.gated || g.partly ? `${g.gated}/${g.sessions} sessions gated${partly} · waited ${dur(g.waitMs)} · ${g.discards} discarded${why ? ` (${why})` : ''}${g.timeouts ? ` · ${g.timeouts} gates not met` : ''}${perRate ? ` · ${perRate}` : ''}${(g.scopes || []).includes('process') ? ' · process scope: no main-thread share' : ''}` : 'off'}${g.off.length ? ` · off: ${g.off.join('; ')}` : ''}`);
}
for (const [k, side] of Object.entries(summary.run.sides)) {
    const fp = side.fingerprint;
    const c = side.commit || sideCommit(run.sides[k]);
    console.log(`build ${k}: ${c ? c.slice(0, 10) : 'commit unknown'}${side.url ? ` (preview ${side.url})` : ''}${side.profile ? ` · ${side.profile}` : ''}${fp && fp.release ? ` · ${fp.release.version}.${fp.release.suiteType}${fp.release.codesign ? '.codesign' : ''}` : ''} · compiler: ${fp ? compilerText(fp.compiler, 4) : '–'}`);
}
for (const [k, side] of Object.entries(summary.run.sides)) if (side.tools) console.log(`tools ${k}: ${toolsText(side.tools)}`);
if (summary.run.base && summary.run.base.behind) console.log(`base: B was ${summary.run.base.behind} commits behind origin/${summary.run.base.branch} when pinned, measured as ${summary.run.base.mode}`);
console.log(`\nsummary: ${outFile}`);
