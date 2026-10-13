/**
 * Shared helpers for the rig: arguments, the run home, the trezor-suite checkout that provides
 * playwright-core and Electron, run/side resolution, statistics and logging.
 * ES modules written for the latest Node LTS (24); builds use the checkout's .nvmrc Node.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseArgv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const RIG = import.meta.dirname;
export const SKILL = path.dirname(RIG);

// ------------------------------------------------------------------ arguments
// --k=8 --rates=1,4 --cfg.pages=40 --alt-inject=10 --headed
//   -> { k: 8, rates: '1,4', cfg: { pages: 40 }, altInject: 10, headed: true, _: [] }
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const coerce = v => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

    return v;
};
export const parseArgs = (args = process.argv.slice(2)) => {
    const { values, positionals } = parseArgv({ args, strict: false, allowPositionals: true });
    const out = { _: positionals };
    for (const [key, raw] of Object.entries(values)) {
        const val = typeof raw === 'string' ? coerce(raw) : raw;
        const parts = key.split('.');
        let o = out;
        for (const p of parts.slice(0, -1)) {
            o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {};
            o = o[p];
        }
        // scenario cfg keys stay as written, rig flags become camelCase
        o[parts.length > 1 ? parts.at(-1) : camel(key)] = val;
    }

    return out;
};
export const list = v => (v === undefined || v === null || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
export const numbers = v => list(v).map(Number);

// ------------------------------------------------------------------ files
export const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
export const writeJson = (f, o) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n');
};
/** For files other processes poll (progress, status): a tmp file of this writer's own, then rename. */
export const writeJsonAtomic = (f, o) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(o, null, 1) + '\n');
        fs.renameSync(tmp, f);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
};
const unwritable = new Set();
/** writeJsonAtomic for progress, status and timings: never throws, warns once per file. */
export const writeJsonSafe = (f, o) => {
    try {
        writeJsonAtomic(f, o);

        return true;
    } catch (e) {
        if (!unwritable.has(f)) console.warn(`warning: cannot write ${f} (${e.message}); carrying on without it`);
        unwritable.add(f);

        return false;
    }
};
/** JSON of a file, or null when it is missing or unreadable. */
export const tryJson = f => {
    try {
        return readJson(f);
    } catch {
        return null;
    }
};
export const exists = f => fs.existsSync(f);

// ------------------------------------------------------------------ run home
// Runs and clones live outside every worktree, so a worktree cleanup cannot take them.
// ~/.local/share is writable from the Claude Bash sandbox; override with PERF_AB_HOME.
export const home = () => process.env.PERF_AB_HOME || path.join(os.homedir(), '.local', 'share', 'suite-perf-ab');
export const runDir = ref => {
    if (!ref) throw new Error('--run=<name|dir> is required');
    if (path.isAbsolute(ref) || ref.startsWith('.')) return path.resolve(ref);

    return path.join(home(), 'runs', ref);
};
export const loadRun = ref => {
    const dir = runDir(ref);
    const file = path.join(dir, 'run.json');
    if (!exists(file)) throw new Error(`no run.json in ${dir} — copy ${path.join(RIG, 'templates', 'run.json')} there first`);

    return Object.assign(readJson(file), { dir, file });
};
export const saveRun = run => {
    const { dir, file, ...rest } = run;
    writeJson(file, rest);
};
// relative paths in run.json resolve against the run dir, `skill:` against the skill folder
export const resolveIn = (dir, p) => {
    if (!p) return p;
    if (p.startsWith('skill:')) return path.join(SKILL, p.slice(6));

    return path.isAbsolute(p) ? p : path.join(dir, p);
};
/** A scenario module's default export (scenario.mjs). */
export const importScenario = async file => (await import(pathToFileURL(file).href)).default;

// ------------------------------------------------------------------ the checkout
export const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasPlaywright = dir => !!dir && exists(path.join(dir, 'node_modules', 'playwright-core', 'package.json'));
// the main checkout behind a worktree: parent of the common .git dir
export const mainCheckout = cwd => {
    try {
        return path.dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd));
    } catch {
        return null;
    }
};
/**
 * The trezor-suite checkout whose node_modules provide playwright-core and Electron and whose
 * .git has the revisions to build: --repo, $SUITE_REPO, the current checkout, then the main
 * checkout behind the current worktree (app-created worktrees often have no node_modules).
 */
export const repoRoot = (explicit, cwd = process.cwd()) => {
    const candidates = [explicit, process.env.SUITE_REPO];
    try {
        candidates.push(git(['rev-parse', '--show-toplevel'], cwd));
    } catch {
        // not inside a checkout
    }
    candidates.push(mainCheckout(cwd));
    for (const c of candidates) if (hasPlaywright(c)) return path.resolve(c);
    throw new Error(`no trezor-suite checkout with node_modules/playwright-core (tried ${candidates.filter(Boolean).join(', ') || 'nothing'}); pass --repo or set SUITE_REPO`);
};
/** Resolve a package file from the checkout's node_modules (resolution only, nothing is executed). */
export const resolveFromRepo = (repo, specifier) => createRequire(path.join(repo, 'package.json')).resolve(specifier);
/** Import a package from the checkout (playwright-core, electron, source-map): its default export or namespace. */
export const importFromRepo = async (repo, specifier) => {
    const mod = await import(pathToFileURL(resolveFromRepo(repo, specifier)).href);

    return mod.default ?? mod;
};
export const playwright = repo => importFromRepo(repo, 'playwright-core');
/**
 * The Node binary for builds: the version in <dir>/.nvmrc when nvm has it (CI and the repo docs
 * build with it), else the running Node — `exact` says which, and both sides of an A/B get the same.
 */
export const nvmrcNode = dir => {
    const want = fs.readFileSync(path.join(dir, '.nvmrc'), 'utf8').match(/^\s*v?(\d+\.\d+\.\d+)/m)?.[1] ?? null;
    if (want && process.version === `v${want}`) return { version: want, bin: process.execPath, exact: true, want };
    const bin = want && path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node', `v${want}`, 'bin', 'node');
    if (bin && exists(bin)) return { version: want, bin, exact: true, want };

    return { version: process.versions.node, bin: process.execPath, exact: false, want };
};

// ------------------------------------------------------------------ sides
/**
 * A side is { label, rev, sha, web, desktop, url, variant, patch, markers }: `web` is a production
 * web build dir, `desktop` a built suite/desktop-app dir, `url` a deployed preview.
 * build.mjs fills sha/web/desktop.
 */
export const sideOf = (run, key) => {
    const s = run.sides && run.sides[key];
    if (!s) throw new Error(`run.json has no side "${key}" (sides: ${Object.keys(run.sides || {}).join(', ')})`);

    return { key, ...s, web: resolveIn(run.dir, s.web), desktop: resolveIn(run.dir, s.desktop) };
};

// ------------------------------------------------------------------ statistics
export const finite = a => a.filter(x => typeof x === 'number' && Number.isFinite(x));
const nearestRank = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
export const summarize = values => {
    const v = finite(values).toSorted((a, b) => a - b);
    if (!v.length) return null;
    const mean = v.reduce((s, x) => s + x, 0) / v.length;

    return { n: v.length, p50: nearestRank(v, 50), p75: nearestRank(v, 75), p90: nearestRank(v, 90), min: v[0], max: v.at(-1), mean: +mean.toFixed(3) };
};
export const median = values => {
    const v = finite(values).toSorted((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;

    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
export const mean = v => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
const binom = (n, k) => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;

    return Math.round(r);
};
/**
 * Two-sided permutation p-value for the difference of means of two small samples (here: one
 * value per page session). Exact up to 200k splits, Monte Carlo (fixed seed) beyond.
 */
export const permutationP = (a, b) => {
    a = finite(a);
    b = finite(b);
    if (a.length < 2 || b.length < 2) return null;
    const all = a.concat(b);
    const n = all.length;
    const k = a.length;
    const total = all.reduce((s, x) => s + x, 0);
    const obs = Math.abs(mean(a) - mean(b));
    const diff = s => Math.abs(s / k - (total - s) / (n - k));
    let extreme = 0;
    let count = 0;
    if (binom(n, k) <= 200000) {
        const idx = Array.from({ length: k }, (_, i) => i);
        for (;;) {
            const s = idx.reduce((t, i) => t + all[i], 0);
            if (diff(s) >= obs - 1e-9) extreme += 1;
            count += 1;
            let i = k - 1;
            while (i >= 0 && idx[i] === n - k + i) i -= 1;
            if (i < 0) break;
            idx[i] += 1;
            for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
        }
    } else {
        let seed = 12345;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;

            return seed / 0x7fffffff;
        };
        for (; count < 20000; count++) {
            const pool = all.slice();
            let s = 0;
            for (let j = 0; j < k; j++) {
                const r = j + Math.floor(rnd() * (n - j));
                [pool[j], pool[r]] = [pool[r], pool[j]];
                s += pool[j];
            }
            if (diff(s) >= obs - 1e-9) extreme += 1;
        }
    }

    return +(extreme / count).toFixed(4);
};
// every session median of one side beyond every session median of the other (needs >= 2 a side)
export const separated = (a, b) => {
    a = finite(a);
    b = finite(b);
    if (a.length < 2 || b.length < 2) return null;
    if (Math.max(...b) < Math.min(...a)) return 'B lower';
    if (Math.min(...b) > Math.max(...a)) return 'B higher';

    return 'overlap';
};
// a direction is called only when every session separates and that is unlikely by chance
// (p <= 0.1 needs at least 5 sessions in total: 2 v 3 reaches 0.1, 4 v 4 separated is p 0.029)
export const CALL_P = 0.1;
export const called = d => !!d && !!d.separated && d.separated !== 'overlap' && d.p !== null && d.p !== undefined && d.p <= CALL_P;
/** The smallest p permutationP can give these session counts (2 v 2: 0.333, 2 v 3: 0.1, 4 v 4: 0.029). */
export const minP = (nA, nB) => (nA < 2 || nB < 2 ? 1 : permutationP(Array.from({ length: nA }, (_, i) => i), Array.from({ length: nB }, (_, i) => 1e6 + i)));
// a paired control lands when the metric moves by roughly this share of the injected cost
export const LANDED_PCT = [70, 110];
/**
 * A paired control's verdict over its sessions (R.control of a pass x rate; a session's landing is
 * the % of the injected cost its total.taskMs moved, `pairs` its inject / no-inject iterations).
 * One session swings about ±30 points, so only a consistent miss reads as a broken rig:
 *   underpowered  a session has fewer than 3 pairs — raise ctl k; not a failure
 *   failed        every session misses LANDED_PCT on the same side
 *   inconclusive  the sessions straddle the band, or their median is outside it
 *   landed        every session inside the band
 */
export const controlVerdict = control => {
    const rows = Object.values(control || {}).flat().map(c => ({ pct: (c.landed['total.taskMs'] || Object.values(c.landed)[0] || {}).landedPct, pairs: c.pairs }));
    const pcts = finite(rows.map(r => r.pct));
    if (!pcts.length) return null;
    const [lo, hi] = LANDED_PCT;
    const pairs = finite(rows.map(r => r.pairs));
    const med = Math.round(median(pcts));
    const v = { range: [Math.min(...pcts), Math.max(...pcts)], median: med, sessions: pcts.length, pairs: pairs.length ? Math.min(...pairs) : null };
    if (v.pairs !== null && v.pairs < 3) v.state = 'underpowered';
    else if (pcts.every(x => x < lo) || pcts.every(x => x > hi)) v.state = 'failed';
    else if (pcts.some(x => x < lo || x > hi) || med < lo || med > hi) v.state = 'inconclusive';
    else v.state = 'landed';

    return v;
};
/** "control inconclusive (sessions 66–125 %, median 110 %) — …", the same words in aggregate and report. */
export const controlText = (v, where = '') => {
    const nums = `sessions ${v.range[0]}–${v.range[1]} %, median ${v.median} %`;
    const at = where ? ` ${where}` : '';

    return {
        underpowered: `control${at} underpowered (${v.pairs} pairs a session; ${nums}) — raise ctl k`,
        failed: `control${at} did not land (${nums}; want ${LANDED_PCT[0]}–${LANDED_PCT[1]} %) — fix the rig before adding sessions`,
        inconclusive: `control${at} inconclusive (${nums}) — add ctl sessions if a verdict depends on the rig's resolution`,
        landed: `control${at} landed (${nums})`,
    }[v.state];
};

// ------------------------------------------------------------------ metrics
export const isMs = k => /(Ms|\.ms)$/.test(k) || /lag|frame(P|Max)/.test(k);
// probe counts that follow timing, so not deterministic
const TIMING_COUNTS = new Set(['frames', 'framesOver50', 'framesOver100', 'lagOver50', 'longTasks', 'loafs', 'interactions']);
/** Deterministic counts: commits, layouts, fibers, the scenario's own numbers. */
export const isCount = k => !isMs(k) && !/MiB$|\.cls$/.test(k) && !TIMING_COUNTS.has(k.split('.').at(-1));
/** The headline metrics the report's automatic verdict cards use. */
export const verdictMetrics = headline => (headline || []).slice(0, 4);
export const ROLES = ['counts', 'trial', 'timing', 'control'];
/**
 * What a pass is for: plan.json's `role` (counts | trial | timing | control), else inferred from
 * the session meta (cfg.fiberStats -> counts, altInject -> control) and the name (counts?…,
 * pilot/smoke/trial…). Only a timing pass can carry a verdict.
 */
export const passRole = (name, meta, planPass) => {
    if (planPass && ROLES.includes(planPass.role)) return planPass.role;
    if (meta && meta.cfg && meta.cfg.fiberStats) return 'counts';
    if (meta && meta.altInject) return 'control';
    if (/^counts?\b/i.test(name)) return 'counts';
    if (/^(pilot|smoke|trial)\b/i.test(name)) return 'trial';

    return 'timing';
};
/** Role lookup for a run's file passes, explicit roles from the plan's passes first. */
export const roleResolver = planPasses => (name, meta) => passRole(name, meta, (planPasses || []).find(p => p.name === name && !p.extends));
/** Rows for a counting pass: the headline's counts, then any other count whose sides differ. */
export const countKeys = (R, headline) => {
    const sides = Object.keys(R.sides);
    const differs = k => new Set(sides.map(s => (R.metrics[k][s] && R.metrics[k][s].stats ? R.metrics[k][s].stats.p50 : null))).size > 1;
    const head = (headline || []).map(h => h.key).filter(k => R.metrics[k] && isCount(k));

    return head.concat(Object.keys(R.metrics).filter(k => !head.includes(k) && isCount(k) && differs(k))).slice(0, 20);
};

// ------------------------------------------------------------------ sessions
export const SESSION_FILE = /^(.+)-(\d+)-([A-Za-z0-9]+)\.json$/;
/**
 * Spare targets every session seeds (RUN.spares) for iterations the performance-core watchdog
 * discards and retries with the next it.n — and the session's discard budget. A constant: the
 * seeded wallet must not depend on any flag. Sessions record it as meta.spares.
 */
export const SPARES = 8;
// run.mjs flags that are not the pass's configuration: never in meta.argv, never compared
const NOT_PASS = /^--(run|side|out|repo|progress|role|pcore[\w-]*|max-ecore-[\w-]+)=/;
/** The arguments that identify a pass's configuration (meta.argv; plan.mjs compares them). */
export const passArgv = argv => argv.filter(a => !NOT_PASS.test(a));

// ------------------------------------------------------------------ progress and ETA
/**
 * One session's position from its progress snapshot: "measure 4x it 5/8 load", or while the
 * performance-core gate waits "pcore-wait 4x it 5/8 · waiting for a performance core · 1 of 4 free · 0:40".
 */
export const progressText = (p, now = Date.now()) => {
    if (!p) return 'starting';
    const perRate = ['calibrate', 'idle', 'warm-up', 'measure', 'profile', 'pcore-wait', 'ready'].includes(p.stage);
    const iter = perRate && Number.isInteger(p.iteration) ? `it ${p.iteration + 1}/${p.k}` : null;
    const g = p.gate;
    const waited = g && g.since ? dur(now - Date.parse(g.since)) : null;
    const gate = p.stage === 'pcore-wait' && g ? `· waiting for a performance core · ${g.free ?? '–'} of ${g.total} free · ${waited}`
        : p.stage === 'ready' && g ? `· ready check, attempt ${g.attempts + 1} (last ${Math.round((g.share || 0) * 100)} % on P, ${g.ghz} GHz${g.ref ? ` of ${g.ref}` : ''}) · ${waited}` : null;

    return [p.stage, perRate && p.rate ? `${p.rate}x` : null, iter, iter && !gate && p.phase, gate].filter(Boolean).join(' ');
};
/**
 * A plan's sessions per pass name: [{ id, base, side, n }], numbered per side inside the file pass
 * (A1 B1 B2 A2); a pass that extends another continues that pass's numbers wherever it stands.
 */
export const planSessions = passes => {
    const counters = {};
    const out = {};
    for (const p of passes.filter(x => !x.extends).concat(passes.filter(x => x.extends))) {
        const base = p.extends || p.name;
        const seen = (counters[base] ||= {});
        out[p.name] = (p.order || 'ABBA').split('').map(side => {
            const n = (seen[side] = (seen[side] || 0) + 1);

            return { id: `${base}-${n}-${side}`, base, side, n };
        });
    }

    return out;
};
/** A cfg as a comparable string (key order does not matter). */
export const cfgKey = cfg => JSON.stringify(Object.keys(cfg || {}).sort().map(k => [k, cfg[k]]));
/**
 * meta.timing of every complete session in out/ (run.mjs writes it): what the ETA learns from.
 * `pass` is the file's pass, so a pass that extends main counts as main; `roleOf(name, meta)`
 * gives its role (roleResolver of the plan's passes).
 */
export const timingHistory = (outDir, roleOf = passRole) => {
    const out = [];
    for (const f of exists(outDir) ? fs.readdirSync(outDir) : []) {
        const m = f.match(SESSION_FILE);
        const d = m && tryJson(path.join(outDir, f));
        const t = d && d.complete === true && d.meta && d.meta.timing;
        if (t && Number.isFinite(t.durationMs)) out.push({ id: f.slice(0, -5), pass: m[1], role: roleOf(m[1], d.meta), cfg: d.meta.cfg, side: m[3], k: d.meta.k, rates: d.meta.rates, finished: d.meta.finished, ...t });
    }

    return out;
};
/**
 * Session duration: overhead (fixed + per rate) + per rate, k x the wall time of one iteration at
 * that rate (the warm-up iterations are part of k). Learned from finished sessions in pools, in
 * order: the same pass; the same role and cfg; any timing or trial pass; counts and controls last.
 * An estimate that needs one of the last two pools, or a rate ratio never measured, is `rough`.
 * A rate a pool has not run scales a rate it has by their ratio in sessions that ran both (1 if
 * none: wall time per iteration barely follows the throttle, 3.0-4.0 s at 1x vs 3.7-4.1 s at 4x).
 * Without history every estimate is null: say "ETA after the first session" instead of guessing.
 * s = { pass, role, cfg, k, rates }; estimates are { ms, rough } or null.
 */
export const etaModel = history => {
    const pools = s => [
        history.filter(h => h.pass === s.pass),
        history.filter(h => h.role === s.role && cfgKey(h.cfg) === cfgKey(s.cfg)),
        history.filter(h => h.role === 'timing' || h.role === 'trial'),
        history,
    ];
    const samples = (pool, rate) => pool.flatMap(h => (h.iterMs && h.iterMs[rate]) || []);
    // per-iteration time at rate a / at rate b, from sessions that ran both
    const ratio = (a, b) => {
        const r = finite(history.filter(h => h.iterMs && (h.iterMs[a] || []).length && (h.iterMs[b] || []).length).map(h => median(h.iterMs[a]) / median(h.iterMs[b])));

        return r.length ? { x: median(r), known: true } : { x: 1, known: false };
    };
    const iterAt = (s, rate) => {
        for (const [i, pool] of pools(s).entries()) {
            const v = samples(pool, rate);
            if (v.length) return { ms: median(v), rough: i >= 2 };
            const seen = [...new Set(pool.flatMap(h => Object.keys(h.iterMs || {}).filter(r => h.iterMs[r].length)))].map(Number);
            if (!seen.length) continue;
            const near = seen.toSorted((a, b) => Math.abs(Math.log(a / rate)) - Math.abs(Math.log(b / rate)))[0];
            const r = ratio(rate, near);

            return { ms: median(samples(pool, near)) * r.x, rough: i >= 2 || !r.known };
        }

        return null;
    };
    // overhead = fixed + per rate x rates, from the medians of sessions with the fewest and the most
    // rates; with one rate count only, all of it is per rate
    const overheadAt = s => {
        for (const [i, pool] of pools(s).entries()) {
            const by = Object.groupBy(pool.filter(h => Number.isFinite(h.overheadMs) && h.rates && h.rates.length), h => h.rates.length);
            const ns = Object.keys(by).map(Number).sort((a, b) => a - b);
            if (!ns.length) continue;
            const med = n => median(by[n].map(h => h.overheadMs));
            const [n1, n2] = [ns[0], ns.at(-1)];
            const perRate = n1 === n2 ? med(n1) / n1 : Math.max(0, (med(n2) - med(n1)) / (n2 - n1));
            const fixed = n1 === n2 ? 0 : Math.max(0, med(n1) - perRate * n1);

            return { ms: fixed + perRate * s.rates.length, rough: i >= 2 };
        }

        return null;
    };
    const perIter = (s, own, r) => (own[r] && own[r].length ? { ms: median(own[r]), rough: false } : iterAt(s, r));
    /** own = a running session's iterMs, preferred where it has them */
    const sessionEst = (s, own = {}) => {
        const o = overheadAt(s);
        if (!o) return null;
        let { ms, rough } = o;
        for (const r of s.rates) {
            const it = perIter(s, own, r);
            if (!it) return null;
            ms += s.k * it.ms;
            rough ||= it.rough;
        }

        return { ms: Math.round(ms), rough };
    };
    /** What is left of a running session (p = its progress): never less than its iterations left. */
    const leftEst = (s, p, startedMs, now = Date.now()) => {
        const own = (p && p.iterMs) || {};
        const est = sessionEst(s, own);
        let iters = { ms: 0, rough: false };
        for (const r of s.rates) {
            const left = Math.max(0, s.k - (own[r] || []).length);
            const it = left ? perIter(s, own, r) : { ms: 0, rough: false };
            if (!it) {
                iters = null;
                break;
            }
            iters.ms += left * it.ms;
            iters.rough ||= it.rough;
        }
        if (!est) return iters && { ms: Math.round(iters.ms), rough: iters.rough };

        return { ms: Math.round(Math.max(est.ms - (now - startedMs), iters ? iters.ms : 0)), rough: est.rough };
    };

    return { empty: !history.length, iterAt, overheadAt, sessionEst, leftEst };
};
/** An estimate as text: '2:31', '~2:31' when rough, '–' when unknown. */
export const estText = (e, hours = false) => (e ? `${e.rough ? '~' : ''}${dur(e.ms, hours)}` : '–');

// ------------------------------------------------------------------ misc
export const sleep = ms => delay(ms);
export const hhmmss = () => new Date().toTimeString().slice(0, 8);
export const log = (...a) => console.log(hhmmss(), ...a);
export const loadavg = () => os.loadavg().map(x => +x.toFixed(2));
/** A duration as m:ss, h:mm:ss from an hour on (or always with `hours`); '–' when unknown. */
export const dur = (ms, hours = false) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–';
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');

    return h || hours ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
/** Time of day as HH:MM. */
export const clock = t => new Date(t).toTimeString().slice(0, 5);
/** Whether a pid still runs: null without a pid; EPERM means it runs but the sandbox may not signal it. */
export const alive = pid => {
    if (!pid) return null;
    try {
        process.kill(pid, 0);

        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
};
