/**
 * Production builds of every side of a run, each in its own copy-on-write clone of the checkout,
 * cached by commit (+ variant): a second run against the same base reuses its build.
 *
 *   node build.mjs --run=<name|dir> [--targets=web|desktop|web,desktop] [--sides=A,B]
 *        [--rebuild] [--network-install] [--repo=<checkout>]
 *
 * Per side: resolve `rev` to a full SHA in the checkout (fetch it first if it is not there:
 * `git fetch origin <branch>` or `git fetch origin pull/<n>/head`), clone (clone.py, ~20 s),
 * `git checkout --force --detach`, apply `patch` if the side has one (a variant: reverted hunk,
 * tweaked constant), offline `yarn install --immutable --mode=skip-build` (~3 s; --network-install
 * lets yarn fetch when the lockfile moved further), then the same build command on every side:
 *   web      yarn workspace @suite/web-app build                       (~35-60 s)
 *   desktop  yarn workspace @suite/desktop-app clean, build:ui, build:app   (~80 s)
 * with SENTRY_AUTH_TOKEN='' and INSTRUMENT_CODE unset (no Istanbul), run by the Node the revision's
 * .nvmrc pins when nvm has it (else the running Node, with a warning; --node=<binary> overrides).
 * Writes sha/web/desktop back
 * into run.json. Clones live in $PERF_AB_HOME/clones (~1-2 GiB of real blocks each once built);
 * cleanup.mjs removes them.
 *
 * Progress: steps are numbered per side ("[A 3/4] web build … (last 0:52)", then "… done in
 * 0:53"), with a heartbeat line every 30 s of a step (every step's output goes to its log file,
 * never to stdout). $PERF_AB_HOME/timings.json keeps the last durations of every step for the
 * estimates; <run dir>/build-status.json has the side, step, its estimate and the state for
 * status.mjs.
 *
 * Runs inside the Bash sandbox (the clone dir is under ~/.local/share).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { RIG, parseArgs, list, loadRun, saveRun, resolveIn, readJson, writeJson, writeJsonSafe, tryJson, exists, home, git, mainCheckout, repoRoot, log, nvmrcNode, median, dur, clock } from './lib.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const TARGETS = list(args.targets || run.target || 'web');
const sides = list(args.sides).length ? list(args.sides) : Object.keys(run.sides);
// the checkout to clone: the main one has node_modules, .yarn/cache and every fetched object
const repo = mainCheckout(repoRoot(args.repo || run.repo)) || repoRoot(args.repo || run.repo);

// a child's output goes to its log file, or is collected when it has none — never to stdout
let current = null;
const sh = (cmd, argv, opts = {}) => new Promise(resolve => {
    const t0 = Date.now();
    const fd = opts.logFile ? fs.openSync(opts.logFile, 'w') : null;
    let buf = '';
    let settled = false;
    const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe'] });
    current = child;
    if (fd === null) for (const st of [child.stdout, child.stderr]) st.on('data', d => { buf += d; });
    const done = code => {
        if (settled) return;
        settled = true;
        current = null;
        if (fd !== null) fs.closeSync(fd);
        const out = fd === null ? buf : `${fs.readFileSync(opts.logFile, 'utf8')}${buf}`;
        resolve({ code, out, s: Math.round((Date.now() - t0) / 100) / 10 });
    };
    child.on('error', e => {
        buf += String(e);
        done(-1);
    });
    child.on('close', done);
});
const yarnOf = dir => {
    const rc = fs.readFileSync(path.join(dir, '.yarnrc.yml'), 'utf8');
    const m = rc.match(/^yarnPath:\s*(\S+)/m);
    if (!m) throw new Error(`${dir}/.yarnrc.yml has no yarnPath`);

    return path.join(dir, m[1]);
};
const buildEnv = extra => {
    const env = Object.assign({}, process.env, { SENTRY_AUTH_TOKEN: '' }, extra || {});
    delete env.INSTRUMENT_CODE;
    delete env.NODE_ENV;

    return env;
};
const jsFiles = dir => {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) out.push(p);
        }
    };
    if (exists(dir)) walk(dir);

    return out;
};

// ------------------------------------------------------------------ progress
// the steps a target adds; every step's duration is kept in timings.json under its name
const STEPS = { web: ['web build'], desktop: ['desktop clean', 'desktop build:ui', 'desktop build:app'] };
for (const t of TARGETS) if (!STEPS[t]) throw new Error(`unknown target ${t}`);
const TIMINGS = path.join(home(), 'timings.json');
const timings = (tryJson(TIMINGS) || {}).steps || {};
const typical = name => (timings[name] && timings[name].length ? median(timings[name]) : null);
const estOf = names => names.reduce((t, n) => (t === null || typical(n) === null ? null : t + typical(n)), 0);
const record = (name, ms) => {
    // re-read: a build of another run may have written meanwhile
    const steps = (tryJson(TIMINGS) || {}).steps || {};
    steps[name] = [...(steps[name] || []), Math.round(ms)].slice(-5);
    timings[name] = steps[name];
    // timings and status never fail a build
    writeJsonSafe(TIMINGS, { steps, updatedAt: new Date().toISOString() });
};
const status = { pid: process.pid, state: 'running', startedAt: new Date().toISOString(), updatedAt: null, targets: TARGETS, sides: {}, side: null, step: null, etaMs: null, etaAt: null, error: null };
const saveStatus = () => {
    status.updatedAt = new Date().toISOString();
    writeJsonSafe(path.join(run.dir, 'build-status.json'), status);
};
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
        Object.assign(status, { state: 'interrupted', error: sig });
        saveStatus();
        log(`build interrupted by ${sig}${status.step ? ` in [${status.side} ${status.step.i}/${status.step.n}] ${status.step.name}` : ''} — run it again; finished targets are cached`);
        if (current) current.kill(sig);
        process.exit(code);
    });
}

// targets this invocation built: another side on the same clone (an A/A run) reuses them, --rebuild or not
const builtNow = new Set();
// what a side needs: computed up front for the estimate, and again when its turn comes
const jobOf = key => {
    const side = run.sides[key];
    if (!side) throw new Error(`run.json has no side ${key}`);
    if (side.url && !side.rev) return { key, side, steps: [] };
    let sha;
    try {
        sha = git(['rev-parse', '--verify', `${side.rev}^{commit}`], repo);
    } catch {
        throw new Error(`side ${key}: ${side.rev} is not in ${repo} — fetch it first (git fetch origin <branch> or pull/<n>/head)`);
    }
    const patch = side.patch ? resolveIn(run.dir, side.patch) : null;
    const patchHash = patch ? crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex').slice(0, 8) : null;
    const variant = side.variant || (patch ? `patch-${patchHash}` : null);
    const name = sha.slice(0, 12) + (variant ? `-${variant}` : '');
    const clone = path.join(home(), 'clones', name);
    const stateFile = path.join(clone, '.perf-ab-build.json');
    const state = exists(stateFile) ? readJson(stateFile) : { sha, variant, patch, patchHash, targets: {} };
    const todo = TARGETS.filter(t => !builtNow.has(`${clone}:${t}`) && (args.rebuild || !(state.targets[t] && state.targets[t].ok)));
    const steps = todo.length ? [...(exists(clone) ? [] : ['clone']), 'checkout', 'yarn install', ...todo.flatMap(t => STEPS[t])] : [];

    return { key, side, sha, patch, variant, clone, stateFile, logs: path.join(clone, '.perf-ab-logs'), state, todo, steps };
};

try {
    const jobs = sides.map(jobOf);
    const all = jobs.flatMap(j => j.steps);
    const total = estOf(all);
    log(`build ${TARGETS.join(',')} · ${jobs.map(j => `${j.key} ${j.side.url && !j.side.rev ? 'preview' : j.steps.length ? `${j.steps.length} steps` : 'cached'}`).join(', ')}${all.length ? ` · ${total === null ? 'no estimate yet (a step has never run here)' : `est ${dur(total)}, ≈ ${clock(Date.now() + total)}`}` : ''}`);
    saveStatus();
    for (const [ji, planned] of jobs.entries()) {
        // read again when the job starts: an earlier job may have built this very clone (an A/A run)
        const job = jobOf(planned.key);
        const { key, side, sha, patch, variant, clone, stateFile, logs, state, todo } = job;
        if (side.url && !side.rev) {
            log(key, 'deployed preview, nothing to build:', side.url);
            status.sides[key] = 'preview';
            continue;
        }
        log(`${key} ${side.rev} = ${sha.slice(0, 12)}${variant ? ` + ${variant}` : ''}: ${todo.length ? 'build ' + todo.join(', ') : 'cached'} (${clone})`);
        status.sides[key] = todo.length ? 'building' : 'cached';
        if (todo.length) {
            const later = jobs.slice(ji + 1).flatMap(j => j.steps);
            let i = 0;
            // one numbered step: "[A 2/4] yarn install … (last 0:03)" … "[A 2/4] yarn install done in 0:03"
            const step = async (name, fn) => {
                i += 1;
                const tag = `[${key} ${i}/${job.steps.length}]`;
                const t0 = Date.now();
                const est = typical(name);
                const rest = estOf(job.steps.slice(i).concat(later));
                const eta = () => {
                    const left = est === null || rest === null ? null : Math.max(0, est - (Date.now() - t0)) + rest;
                    Object.assign(status, { etaMs: left, etaAt: left === null ? null : new Date(Date.now() + left).toISOString() });
                    saveStatus();

                    return left;
                };
                Object.assign(status, { side: key, step: { i, n: job.steps.length, name, startedAt: new Date(t0).toISOString(), estMs: est } });
                eta();
                log(`${tag} ${name} …${timings[name] ? ` (last ${dur(timings[name].at(-1))})` : ''}`);
                const beat = setInterval(() => {
                    const left = eta();
                    log(`${tag} ${name} · ${dur(Date.now() - t0)}${est === null ? '' : ` of ≈ ${dur(est)}`}${left === null ? '' : ` · build ETA ${dur(left)} ≈ ${clock(Date.now() + left)}`}`);
                }, 30000);
                try {
                    const r = await fn();
                    record(name, Date.now() - t0);
                    log(`${tag} ${name} done in ${dur(Date.now() - t0)}`);

                    return r;
                } catch (e) {
                    log(`${tag} ${name} failed after ${dur(Date.now() - t0)}`);
                    throw e;
                } finally {
                    clearInterval(beat);
                }
            };
            if (!exists(clone)) {
                await step('clone', async () => {
                    const c = await sh('python3', [path.join(RIG, 'clone.py'), repo, clone]);
                    if (c.code !== 0) throw new Error(`clone failed: ${c.out}`);
                    log(`   ${c.out.trim()}`);
                    git(['config', 'core.fsmonitor', 'false'], clone);
                });
            }
            fs.mkdirSync(logs, { recursive: true });
            await step('checkout', async () => {
                git(['-c', 'core.fsmonitor=false', 'checkout', '--quiet', '--force', '--detach', sha], clone);
                if (git(['rev-parse', 'HEAD'], clone) !== sha) throw new Error(`checkout of ${sha} did not land in ${clone}`);
                if (patch) {
                    const a = await sh('git', ['-c', 'core.fsmonitor=false', 'apply', '--whitespace=nowarn', patch], { cwd: clone });
                    if (a.code !== 0) throw new Error(`patch ${patch} does not apply on ${sha.slice(0, 12)}: ${a.out}`);
                }
                const dirt = git(['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=no'], clone).split('\n').filter(Boolean);
                log(`   tree: ${dirt.length ? dirt.length + ' changed — ' + dirt.slice(0, 4).join(', ') : 'clean'}`);
            });
            const yarn = yarnOf(clone);
            // the revision's own .nvmrc (a PR can bump Node), the same binary for install and build
            const node = args.node ? { version: 'from --node', bin: String(args.node), exact: true } : nvmrcNode(clone);
            state.node = node.version;
            log(`   node ${node.version} (${node.bin})${node.exact ? '' : ` — .nvmrc wants ${node.want}, not installed (nvm install ${node.want}); both sides use this one`}`);
            await step('yarn install', async () => {
                const inst = await sh(node.bin, [yarn, 'install', '--immutable', '--mode=skip-build'], {
                    cwd: clone, env: buildEnv(args.networkInstall ? {} : { YARN_ENABLE_NETWORK: '0' }), logFile: path.join(logs, 'install.log'),
                });
                if (inst.code !== 0) throw new Error(`yarn install failed (exit ${inst.code}, see ${logs}/install.log)${args.networkInstall ? '' : ' — the offline cache may lack new packages: retry with --network-install'}`);
                state.install = { s: inst.s, at: new Date().toISOString() };
            });
            const yarnRun = (target, name, argv, extraEnv) => step(`${target} ${name}`, async () => {
                const logFile = path.join(logs, `${target}-${name.replace(':', '-')}.log`);
                const r = await sh(node.bin, [yarn, ...argv], { cwd: clone, env: buildEnv(extraEnv), logFile });
                if (r.code !== 0) throw new Error(`${target} ${name} failed (exit ${r.code}, see ${logFile}):\n${r.out.split('\n').slice(-25).join('\n')}`);

                return r.s;
            });
            for (const t of todo) {
                if (t === 'web') {
                    const s = await yarnRun('web', 'build', ['workspace', '@suite/web-app', 'build']);
                    const dir = path.join(clone, 'suite', 'web-app', 'build');
                    const js = jsFiles(path.join(dir, 'js'));
                    const main = js.find(f => /\/main\.[0-9a-f]{8,}\.js$/.test(f));
                    if (!main) throw new Error(`web build in ${dir} has no hashed js/main.<hash>.js — a dev build?`);
                    state.targets.web = { ok: true, dir, s, jsFiles: js.length, at: new Date().toISOString() };
                } else if (t === 'desktop') {
                    let s = await yarnRun('desktop', 'clean', ['workspace', '@suite/desktop-app', 'clean']);
                    s += await yarnRun('desktop', 'build:ui', ['workspace', '@suite/desktop-app', 'build:ui']);
                    s += await yarnRun('desktop', 'build:app', ['workspace', '@suite/desktop-app', 'build:app']);
                    const dir = path.join(clone, 'suite', 'desktop-app');
                    if (!exists(path.join(dir, 'dist', 'app.js')) || !exists(path.join(dir, 'build', 'index.html'))) throw new Error(`desktop build in ${dir} lacks dist/app.js or build/index.html`);
                    state.targets.desktop = { ok: true, dir, s: +s.toFixed(1), jsFiles: jsFiles(path.join(dir, 'build')).length, at: new Date().toISOString() };
                }
                writeJson(stateFile, state);
                builtNow.add(`${clone}:${t}`);
            }
            status.sides[key] = 'built';
        }
        side.sha = sha;
        if (state.targets.web && state.targets.web.ok) side.web = state.targets.web.dir;
        if (state.targets.desktop && state.targets.desktop.ok) side.desktop = state.targets.desktop.dir;
        saveRun(run);
    }
    Object.assign(status, { state: 'finished', side: null, step: null, etaMs: 0, etaAt: new Date().toISOString() });
    saveStatus();
} catch (e) {
    Object.assign(status, { state: 'failed', error: String(e?.message ?? e).slice(0, 2000) });
    saveStatus();
    throw e;
}
log('run.json updated:', Object.entries(run.sides).map(([k, s]) => `${k}=${(s.sha || '').slice(0, 10)}${s.web ? ' web' : ''}${s.desktop ? ' desktop' : ''}`).join(', '));
