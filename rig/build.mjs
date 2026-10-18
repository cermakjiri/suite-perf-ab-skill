/**
 * Production builds of every side of a run, each in its own copy-on-write clone of the checkout,
 * cached by commit, variant and build profile: a second run against the same base reuses its build.
 *
 *   node build.mjs --run=<name|dir> [--targets=web|desktop|web,desktop] [--sides=A,B]
 *        [--profile=release|preview] [--rebuild] [--network-install] [--node=<binary>] [--slot=off]
 *        [--repo=<checkout>]
 *
 * First the revisions: run.json `base` (revs.mjs) must say the feature branch is up to date with its
 * target branch, or that being behind was accepted. Without a `base` (sides written by hand: an A/A
 * run, a variant) it says so and goes on.
 *
 * Per side, CI's recipe (.github/workflows/build-suite-web.yml, build-suite-desktop-e2e.yml) in a
 * clone of the main checkout:
 *   clone         clone.py: APFS clonefile of the checkout, ~20 s
 *   checkout      git checkout --force --detach <sha>. A `patch` (a variant: a reverted hunk, a tweaked
 *                 constant) is applied and committed with a fixed author and date, so the variant has a
 *                 deterministic commit of its own, and that is what its bundle carries. .env.local
 *                 (inherited from the checkout, read by the webpack config through dotenv) is set
 *                 aside: a build sees the rig's environment only
 *   yarn install  offline, --immutable --mode=skip-build, ~3 s (--network-install lets yarn fetch)
 *   prep          what CI regenerates before every build, instead of whatever the checkout had when it
 *                 was cloned: the message-system config (sign-config, development key),
 *                 @suite/app-assets browser-detection + favicon, and for desktop @trezor/transport-bridge
 *                 build:lib. The guide content (guide-pull-content clones a repo over the network) stays
 *                 as inherited; its hash is recorded and preflight compares the sides
 *   web           yarn workspace @suite/web-app build                                (~35-60 s)
 *   desktop       yarn workspace @suite/desktop-app clean, build:ui, build:app       (~80 s)
 *   fingerprint   the bundle must carry the clone's HEAD commit, the profile's codesign flag and no
 *                 coverage (rig/fingerprint.mjs); its React Compiler coverage is recorded
 * with SENTRY_AUTH_TOKEN='', every knob a shell or .env.local could leak scrubbed (INSTRUMENT_CODE,
 * NODE_ENV, IS_CODESIGN_BUILD, TANSTACK_REACT_QUERY_DEV_TOOLS, TRANSPORT_BROWSER_PING, ASSET_PREFIX,
 * TEST_BUILD, …), the profile's variables set (lib.mjs PROFILES: release = IS_CODESIGN_BUILD=true, the
 * default; preview = unset), by the Node the revision's .nvmrc pins when nvm has it (else the running
 * Node, with a warning; --node=<binary> overrides).
 *
 * Parallel runs: one build per clone at a time (another run that needs the same commit waits, then
 * finds it built), and every yarn step after the install holds the machine slot (rig/locks.mjs), so no
 * build runs next to another run's page session. --rebuild refuses a clone that a live session or
 * exploration is serving. --slot=off skips the slot.
 *
 * Writes sha, buildSha, profile, clone, web, desktop, fingerprint and guide into run.json's sides —
 * a merge-write: the file is read again right before writing and nothing else changes, so edits
 * made while it builds (title, pr, device, scenario, cfg, …) survive; a side re-pinned meanwhile gets
 * no record of the old build. Then, for every target both sides have built, the bundle comparison
 * (rig/bundlediff.mjs): code-identical apart from mangled names, hashes, commit and signed config,
 * or the differing files — run.json `bundles`; a code-identical target is unaffected by the change.
 * --profile with --sides builds just those sides another way: a build-config A/B (the same commit in
 * two profiles); run.json's build.profile then stays the run's, and preflight and the report say the
 * sides differ.
 * Clones live in $PERF_AB_HOME/clones/<sha12>[-<variant>].<profile> (~1-2 GiB of real blocks each once
 * built); cleanup.mjs removes them.
 *
 * Progress: steps are numbered per side ("[A 3/7] web build … (last 0:52)", then "… done in 0:53"),
 * a heartbeat line every 30 s of a step (every step's output goes to its log file, never to stdout).
 * $PERF_AB_HOME/timings.json keeps the last durations of every step for the estimates;
 * <run dir>/build-status.json has the side, step, its estimate, any wait and the state for status.mjs.
 *
 * Adding a target (suite-native later): an entry in TARGET below — its prep, its yarn steps, its output
 * dir and check — plus a fingerprint part (fingerprint.mjs partsOf) and a launcher (launch.mjs).
 *
 * Runs inside the Bash sandbox (the clone dir is under ~/.local/share).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { RIG, parseArgs, list, loadRun, updateRun, resolveIn, readJson, writeJson, writeJsonSafe, tryJson, exists, home, git, mainCheckout, repoRoot, log, nvmrcNode, median, dur, clock, PROFILES, profileOf } from './lib.mjs';
import { acquire, holderText, slotOff, cloneUsers } from './locks.mjs';
import { fingerprint, fingerprintText, FP_VERSION } from './fingerprint.mjs';
import { compareRun } from './bundlediff.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const RUN_ID = run.id || path.basename(run.dir);
const TARGETS = list(args.targets || run.target || 'web');
const sides = list(args.sides).length ? list(args.sides) : Object.keys(run.sides);
// the checkout to clone: the main one has node_modules, .yarn/cache and every fetched object
const repo = mainCheckout(repoRoot(args.repo || run.repo)) || repoRoot(args.repo || run.repo);
const PROFILE = profileOf(run, args.profile);
const SLOT = !slotOff(args.slot);
const short = s => (s ? String(s).slice(0, 10) : '–');

// ------------------------------------------------------------------ what a target is
// Generated libs first (CI's order), then the target's own yarn steps, then what the output must hold.
// A step: [name, yarn argv, env overrides (null deletes), workspace dir whose package.json must have the script].
const PREP = {
    // the production signing key never leaves CI: always the development key (sign-config throws on IS_CODESIGN_BUILD without it)
    'message-system': [['prep message-system config', ['workspace', '@suite-common/message-system', 'sign-config'], { IS_CODESIGN_BUILD: null }, 'suite-common/message-system']],
    // build:lib minus guide-pull-content, which clones the guide repo over the network
    'app-assets': [
        ['prep app-assets browser-detection', ['workspace', '@suite/app-assets', 'browser-detection'], {}, 'suite/app-assets'],
        ['prep app-assets favicon', ['workspace', '@suite/app-assets', 'favicon'], {}, 'suite/app-assets'],
    ],
    'transport-bridge': [['prep transport-bridge', ['workspace', '@trezor/transport-bridge', 'build:lib'], {}, 'packages/transport-bridge']],
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
const TARGET = {
    web: {
        prep: ['message-system', 'app-assets'],
        steps: [['web build', ['workspace', '@suite/web-app', 'build']]],
        out: clone => path.join(clone, 'suite', 'web-app', 'build'),
        check: dir => {
            const js = jsFiles(path.join(dir, 'js'));
            if (!js.some(f => /\/main\.[0-9a-f]{8,}\.js$/.test(f))) throw new Error(`web build in ${dir} has no hashed js/main.<hash>.js — a dev build?`);

            return js.length;
        },
    },
    desktop: {
        prep: ['message-system', 'app-assets', 'transport-bridge'],
        // the desktop build never cleans its own output: stale chunks with other hashes would mix two builds
        steps: [
            ['desktop clean', ['workspace', '@suite/desktop-app', 'clean']],
            ['desktop build:ui', ['workspace', '@suite/desktop-app', 'build:ui']],
            ['desktop build:app', ['workspace', '@suite/desktop-app', 'build:app']],
        ],
        out: clone => path.join(clone, 'suite', 'desktop-app'),
        check: dir => {
            if (!exists(path.join(dir, 'dist', 'app.js')) || !exists(path.join(dir, 'build', 'index.html'))) throw new Error(`desktop build in ${dir} lacks dist/app.js or build/index.html`);

            return jsFiles(path.join(dir, 'build')).length;
        },
    },
};
for (const t of TARGETS) if (!TARGET[t]) throw new Error(`unknown target ${t} (${Object.keys(TARGET).join(', ')})`);
// the fields of a run.json side this script writes (and nothing else)
const BUILD_OWNED = ['sha', 'buildSha', 'profile', 'clone', ...Object.keys(TARGET), 'fingerprint', 'guide'];

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
// knobs a developer shell or .env.local can carry that change what gets built
const SCRUB = ['INSTRUMENT_CODE', 'NODE_ENV', 'IS_CODESIGN_BUILD', 'TANSTACK_REACT_QUERY_DEV_TOOLS', 'TRANSPORT_BROWSER_PING', 'ASSET_PREFIX', 'TEST_BUILD', 'LAUNCH_ELECTRON', 'ANALYZE', 'JWS_PRIVATE_KEY_ENV', 'DESKTOP_APP_NAME'];
const buildEnv = (...extras) => {
    const env = Object.assign({}, process.env, { SENTRY_AUTH_TOKEN: '' });
    for (const k of SCRUB) delete env[k];
    for (const extra of [PROFILES[PROFILE].env, ...extras]) {
        for (const [k, v] of Object.entries(extra || {})) {
            if (v === null) delete env[k];
            else env[k] = v;
        }
    }

    return env;
};
const hasScript = (clone, dir, argv) => {
    const pkg = tryJson(path.join(clone, dir, 'package.json'));

    return !!(pkg && pkg.scripts && pkg.scripts[argv.at(-1)]);
};
const fileHash = f => (exists(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : null);
// Packages a revision locks that the checkout's offline cache lacks (the target branch moved on since
// the checkout's last install) are fetched once and kept in $PERF_AB_HOME/yarn-cache: yarn's cache
// files are content-addressed (name + checksum), so any clone can take them. Copies are APFS clones.
const SHARED_CACHE = path.join(home(), 'yarn-cache');
const zips = dir => new Set(exists(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.zip')) : []);
const seedCache = clone => {
    const have = zips(path.join(clone, '.yarn', 'cache'));
    let n = 0;
    for (const f of zips(SHARED_CACHE)) {
        if (have.has(f)) continue;
        fs.copyFileSync(path.join(SHARED_CACHE, f), path.join(clone, '.yarn', 'cache', f), fs.constants.COPYFILE_FICLONE);
        n += 1;
    }

    return n;
};
const keepFetched = clone => {
    const base = zips(path.join(repo, '.yarn', 'cache'));
    const shared = zips(SHARED_CACHE);
    fs.mkdirSync(SHARED_CACHE, { recursive: true });
    let n = 0;
    for (const f of zips(path.join(clone, '.yarn', 'cache'))) {
        if (base.has(f) || shared.has(f)) continue;
        fs.copyFileSync(path.join(clone, '.yarn', 'cache', f), path.join(SHARED_CACHE, f), fs.constants.COPYFILE_FICLONE);
        n += 1;
    }

    return n;
};
// what run.json keeps of a fingerprint (the clone's state file has all of it)
const compact = fp => ({
    v: fp.v, commit: fp.commit, verified: fp.verified, release: fp.release, files: fp.files, coverageFiles: fp.coverageFiles, mixed: fp.mixed, at: fp.at,
    compiler: Object.assign({}, fp.compiler, { areas: fp.compiler.areas.slice(0, 15), moreAreas: Math.max(0, fp.compiler.areas.length - 15) }),
    parts: Object.fromEntries(Object.entries(fp.parts).map(([k, p]) => [k, { commit: p.commit, files: p.files, bytes: p.bytes, sentinels: p.sentinels }])),
});

// ------------------------------------------------------------------ the revisions
const b = run.base;
if (!b) {
    log('note: the revisions were not pinned by revs.mjs — no up-to-date check (fine for an A/A run or hand-picked SHAs)');
} else if (b.state === 'behind') {
    throw new Error(`the feature branch is ${b.behind} commits behind origin/${b.branch} (revs.mjs, ${b.checkedAt}): rebase it and pin again, or pin with --accept-behind=merge-base|merge-ref`);
} else {
    log(`revisions: ${b.state === 'up-to-date' ? `B up to date with origin/${b.branch}` : `B ${b.behind} commits behind origin/${b.branch}, accepted as ${b.mode}`} (pinned ${String(b.checkedAt).slice(0, 16).replace('T', ' ')})`);
}

// ------------------------------------------------------------------ progress
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
const status = { pid: process.pid, state: 'running', startedAt: new Date().toISOString(), updatedAt: null, targets: TARGETS, profile: PROFILE, sides: {}, side: null, step: null, waiting: null, etaMs: null, etaAt: null, error: null };
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
        // the exit handlers drop this process's lock tickets
        process.exit(code);
    });
}
// a lock wait, logged every 30 s and shown by status.mjs
const waitFor = async (lock, info, what) => {
    let next = 0;
    const h = await acquire(lock, Object.assign({ kind: 'build', run: RUN_ID }, info), {
        onWait: w => {
            status.waiting = { lock, what, holder: holderText(w.holder), ahead: w.ahead, since: new Date(Date.now() - w.waitedMs).toISOString() };
            if (Date.now() >= next) {
                next = Date.now() + 30000;
                saveStatus();
                log(`${what}: waiting for ${lock === 'machine' ? 'the machine' : 'the clone'} · ${holderText(w.holder)}${w.ahead > 1 ? ` · ${w.ahead} ahead` : ''} · ${dur(w.waitedMs)}`);
            }
        },
    });
    if (status.waiting) {
        log(`${what}: waited ${dur(h.waitedMs)} for ${lock === 'machine' ? 'the machine' : 'the clone'}`);
        status.waiting = null;
        saveStatus();
    }

    return h;
};

// targets this invocation built: another side on the same clone (an A/A run) reuses them, --rebuild or not
const builtNow = new Set();
// what a side needs: computed up front for the estimate, and again when its turn comes (under the clone lock)
const jobOf = key => {
    const side = run.sides[key];
    if (!side) throw new Error(`run.json has no side ${key}`);
    if (side.url && !side.rev) return { key, side, steps: [] };
    if (!side.rev || String(side.rev).startsWith('<')) throw new Error(`side ${key} has no revision yet — pin the sides with revs.mjs first`);
    let sha;
    try {
        sha = git(['rev-parse', '--verify', `${side.rev}^{commit}`], repo);
    } catch {
        throw new Error(`side ${key}: ${side.rev} is not in ${repo} — pin it with revs.mjs (or git fetch origin <branch> / pull/<n>/head)`);
    }
    const patch = side.patch ? resolveIn(run.dir, side.patch) : null;
    const patchHash = patch ? crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex').slice(0, 8) : null;
    const variant = side.variant || (patch ? `patch-${patchHash}` : null);
    const name = `${sha.slice(0, 12)}${variant ? `-${variant}` : ''}.${PROFILE}`;
    const clone = path.join(home(), 'clones', name);
    const stateFile = path.join(clone, '.perf-ab-build.json');
    const state = Object.assign({ sha, variant, patch, patchHash, profile: PROFILE, prep: {}, targets: {} }, exists(stateFile) ? readJson(stateFile) : {});
    state.prep ||= {};
    const todo = TARGETS.filter(t => !builtNow.has(`${clone}:${t}`) && (args.rebuild || !(state.targets[t] && state.targets[t].ok)));
    const prep = [...new Set(todo.flatMap(t => TARGET[t].prep))].filter(p => !builtNow.has(`${clone}:prep:${p}`) && (args.rebuild || !(state.prep[p] && state.prep[p].ok)));
    const steps = todo.length
        ? [...(exists(clone) ? [] : ['clone']), 'checkout', 'yarn install', ...prep.flatMap(p => PREP[p].map(s => s[0])), ...todo.flatMap(t => TARGET[t].steps.map(s => s[0]))]
        : [];

    return { key, side, sha, patch, patchHash, variant, name, clone, stateFile, logs: path.join(clone, '.perf-ab-logs'), state, todo, prep, steps };
};

const buildSide = async (job, later) => {
    const { key, side, sha, patch, variant, name, clone, stateFile, logs, state, todo, prep } = job;
    log(`${key} ${short(side.rev)} = ${sha.slice(0, 12)}${variant ? ` + ${variant}` : ''} · ${PROFILE}: ${todo.length ? `build ${todo.join(', ')}` : 'cached'} (${clone})`);
    status.sides[key] = todo.length ? 'building' : 'cached';
    if (todo.length) {
        if (args.rebuild) {
            const users = cloneUsers(clone);
            if (users.length) throw new Error(`--rebuild: ${name} is being served by ${users.map(u => `${u.label || u.kind || 'a session'}${u.run ? ` of ${u.run}` : ''} (pid ${u.pid})`).join(', ')} — wait for it, or build under another variant`);
        }
        let i = 0;
        // one numbered step: "[A 2/7] yarn install … (last 0:03)" … "[A 2/7] yarn install done in 0:03"
        const step = async (stepName, fn) => {
            i += 1;
            const tag = `[${key} ${i}/${job.steps.length}]`;
            const t0 = Date.now();
            const est = typical(stepName);
            const rest = estOf(job.steps.slice(i).concat(later));
            const eta = () => {
                const left = est === null || rest === null ? null : Math.max(0, est - (Date.now() - t0)) + rest;
                Object.assign(status, { etaMs: left, etaAt: left === null ? null : new Date(Date.now() + left).toISOString() });
                saveStatus();

                return left;
            };
            Object.assign(status, { side: key, step: { i, n: job.steps.length, name: stepName, startedAt: new Date(t0).toISOString(), estMs: est } });
            eta();
            log(`${tag} ${stepName} …${timings[stepName] ? ` (last ${dur(timings[stepName].at(-1))})` : ''}`);
            const beat = setInterval(() => {
                const left = eta();
                log(`${tag} ${stepName} · ${dur(Date.now() - t0)}${est === null ? '' : ` of ≈ ${dur(est)}`}${left === null ? '' : ` · build ETA ${dur(left)} ≈ ${clock(Date.now() + left)}`}`);
            }, 30000);
            try {
                const r = await fn();
                record(stepName, Date.now() - t0);
                log(`${tag} ${stepName} done in ${dur(Date.now() - t0)}`);

                return r;
            } catch (e) {
                log(`${tag} ${stepName} failed after ${dur(Date.now() - t0)}`);
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
            // the clone copies the main checkout's untracked files too: a stray workspace (package.json)
            // breaks the locked install and stray sources can reach the bundle. Ignored files stay
            // (node_modules, caches, the rig's own .perf-ab-* files).
            const stray = git(['-c', 'core.fsmonitor=false', 'clean', '-fd', '-e', '.perf-ab-*', '-e', '.env.local*'], clone).split('\n').filter(Boolean);
            if (stray.length) log(`   removed ${stray.length} untracked path${stray.length === 1 ? '' : 's'} inherited from the checkout (${stray.slice(0, 3).map(l => l.replace(/^Removing /, '')).join(', ')}${stray.length > 3 ? ', …' : ''})`);
            if (patch) {
                // the variant gets its own commit: deterministic (fixed identity, the base's date), and inlined in its bundle
                const a = await sh('git', ['-c', 'core.fsmonitor=false', 'apply', '--index', '--whitespace=nowarn', patch], { cwd: clone });
                if (a.code !== 0) throw new Error(`patch ${patch} does not apply on ${sha.slice(0, 12)}: ${a.out}`);
                const date = git(['show', '-s', '--format=%cI', sha], clone);
                const who = { GIT_AUTHOR_NAME: 'suite-perf-ab', GIT_AUTHOR_EMAIL: 'perf-ab@localhost', GIT_COMMITTER_NAME: 'suite-perf-ab', GIT_COMMITTER_EMAIL: 'perf-ab@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
                const c = await sh('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', `suite-perf-ab variant ${variant}`], { cwd: clone, env: Object.assign({}, process.env, who) });
                if (c.code !== 0) throw new Error(`committing the variant ${variant} failed: ${c.out}`);
            }
            state.buildSha = git(['rev-parse', 'HEAD'], clone);
            const dirt = git(['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=no'], clone).split('\n').filter(Boolean);
            log(`   tree: ${dirt.length ? `${dirt.length} changed — ${dirt.slice(0, 4).join(', ')}` : 'clean'}${patch ? ` · variant commit ${short(state.buildSha)}` : ''}`);
            // dotenv in the webpack config reads <repo>/.env.local: the developer's settings must not reach a build
            const envLocal = path.join(clone, '.env.local');
            if (exists(envLocal)) {
                fs.renameSync(envLocal, `${envLocal}.perf-ab-ignored`);
                state.envLocalIgnored = true;
                log('   .env.local inherited from the checkout: set aside (.env.local.perf-ab-ignored) — builds see the rig\'s environment only');
            }
        });
        const yarn = yarnOf(clone);
        // the revision's own .nvmrc (a PR can bump Node), the same binary for install and build
        const node = args.node ? { version: 'from --node', bin: String(args.node), exact: true } : nvmrcNode(clone);
        state.node = node.version;
        log(`   node ${node.version} (${node.bin})${node.exact ? '' : ` — .nvmrc wants ${node.want}, not installed (nvm install ${node.want}); both sides use this one`}`);
        log(`   profile ${PROFILE}: ${PROFILES[PROFILE].about}`);
        await step('yarn install', async () => {
            // packages another clone fetched (a target branch newer than the checkout's cache): no network for them
            const seeded = seedCache(clone);
            if (seeded) log(`   ${seeded} packages from $PERF_AB_HOME/yarn-cache (fetched by earlier builds)`);
            // yarn berry ignores HTTP(S)_PROXY (an agent sandbox's egress proxy): hand it over explicitly, with
            // 8 downloads at a time instead of 50 (a proxy aborts the burst: "The server aborted pending
            // request"). The mirror stays on, moved from ~/.yarn (not writable from the sandbox) to
            // $PERF_AB_HOME/yarn-global: with the mirror off yarn names cache files by cache key
            // (`<pkg>-10.zip`) instead of checksum, finds none of the checkout's zips and fetches all ~3,600 again
            const proxy = Object.fromEntries([['YARN_HTTPS_PROXY', process.env.HTTPS_PROXY || process.env.https_proxy], ['YARN_HTTP_PROXY', process.env.HTTP_PROXY || process.env.http_proxy]].filter(([k, v]) => v && !process.env[k]));
            const online = Object.assign({ YARN_GLOBAL_FOLDER: process.env.YARN_GLOBAL_FOLDER || path.join(home(), 'yarn-global'), YARN_NETWORK_CONCURRENCY: process.env.YARN_NETWORK_CONCURRENCY || '8' }, proxy);
            const install = network => sh(node.bin, [yarn, 'install', '--immutable', '--mode=skip-build'], {
                cwd: clone, env: buildEnv(network ? online : { YARN_ENABLE_NETWORK: '0' }), logFile: path.join(logs, network ? 'install-network.log' : 'install.log'),
            });
            let network = !!args.networkInstall;
            let inst = await install(network);
            // a target branch newer than the checkout needs packages its offline cache never saw (YN0080: fetch blocked)
            if (inst.code !== 0 && !network && /YN0080/.test(inst.out)) {
                log('   the offline cache lacks packages this revision locks — installing again with the network (registry.yarnpkg.com)');
                network = true;
                inst = await install(true);
            }
            if (inst.code !== 0) throw new Error(`yarn install failed (exit ${inst.code}, see ${logs}/${network ? 'install-network.log' : 'install.log'})${network ? ' — inside an agent sandbox, registry.yarnpkg.com must be allowed (or run build.mjs with the sandbox off)' : ''}`);
            if (network) {
                const kept = keepFetched(clone);
                if (kept) log(`   kept ${kept} fetched packages in $PERF_AB_HOME/yarn-cache for the next clones`);
            }
            state.install = { s: inst.s, network, seeded, at: new Date().toISOString() };
        });
        // a yarn step holds the machine slot: no build runs next to another run's page session
        const yarnRun = async ([stepName, argv, env, wsDir]) => {
            if (wsDir && !hasScript(clone, wsDir, argv)) {
                log(`   ${stepName}: no "${argv.at(-1)}" script at this revision — skipped`);
                i += 1;

                return 0;
            }
            const slot = SLOT ? await waitFor('machine', { label: `build ${key} · ${stepName}` }, `[${key}] ${stepName}`) : null;
            try {
                return await step(stepName, async () => {
                    const logFile = path.join(logs, `${stepName.replace(/[^\w.-]+/g, '-')}.log`);
                    const r = await sh(node.bin, [yarn, ...argv], { cwd: clone, env: buildEnv(env), logFile });
                    if (r.code !== 0) throw new Error(`${stepName} failed (exit ${r.code}, see ${logFile}):\n${r.out.split('\n').slice(-25).join('\n')}`);

                    return r.s;
                });
            } finally {
                if (slot) slot.release();
            }
        };
        for (const p of prep) {
            for (const s of PREP[p]) await yarnRun(s);
            state.prep[p] = { ok: true, at: new Date().toISOString() };
            builtNow.add(`${clone}:prep:${p}`);
        }
        state.guide = fileHash(path.join(clone, 'suite', 'app-assets', 'files', 'guide', 'index.json'));
        for (const t of todo) {
            let s = 0;
            for (const st of TARGET[t].steps) s += await yarnRun(st);
            const dir = TARGET[t].out(clone);
            const files = TARGET[t].check(dir);
            // the bundle proves the build: its commit is the clone's HEAD, its release string the profile's
            const fp = await fingerprint({ target: t, dir, expect: state.buildSha, repo: clone, rev: state.buildSha });
            log(`   ${t} fingerprint: ${fingerprintText(fp)}`);
            if (fp.verified !== true) throw new Error(`${t} bundle carries ${fp.mixed ? `several commits (${fp.mixed.map(short).join(', ')})` : short(fp.commit) || 'no commit'}, but the clone is at ${short(state.buildSha)} — not this revision's build`);
            if (!fp.release || fp.release.codesign !== PROFILES[PROFILE].codesign) throw new Error(`${t} bundle is ${fp.release && fp.release.codesign ? '' : 'not '}a codesign build, the ${PROFILE} profile wants ${PROFILES[PROFILE].codesign ? 'one' : 'none'} — the build did not get its environment`);
            if (fp.coverageFiles) throw new Error(`${t} bundle is coverage-instrumented (${fp.coverageFiles} files) — INSTRUMENT_CODE leaked into the build`);
            state.targets[t] = { ok: true, dir, s: +s.toFixed(1), jsFiles: files, at: new Date().toISOString(), fingerprint: fp };
            writeJson(stateFile, state);
            builtNow.add(`${clone}:${t}`);
        }
        status.sides[key] = 'built';
    }
    // a cached build fingerprinted by an older rig: read it again (no rebuild, ~1 s)
    for (const t of Object.keys(TARGET)) {
        const st = state.targets[t];
        if (!st || !st.ok || (st.fingerprint && st.fingerprint.v === FP_VERSION) || !exists(st.dir)) continue;
        st.fingerprint = await fingerprint({ target: t, dir: st.dir, expect: state.buildSha || sha, repo: clone, rev: state.buildSha || sha });
        log(`   ${t} fingerprint refreshed: ${fingerprintText(st.fingerprint)}`);
        writeJson(stateFile, state);
    }
    // run.json: this profile's clone only — a target this clone has not built is not taken from another profile
    const owned = { sha, profile: PROFILE, clone, fingerprint: {}, guide: state.guide ?? null };
    if (state.buildSha && state.buildSha !== sha) owned.buildSha = state.buildSha;
    for (const t of Object.keys(TARGET)) {
        const st = state.targets[t];
        if (!st || !st.ok) continue;
        owned[t] = st.dir;
        if (st.fingerprint) owned.fingerprint[t] = compact(st.fingerprint);
    }
    // the run's profile follows a build of every side; --profile with --sides builds those sides another
    // way on purpose (a build-config A/B: the same commit in two profiles)
    const setProfile = !list(args.sides).length || !run.build || !run.build.profile;
    // merge-write: run.json is read again right before writing and only what the build owns changes, so
    // edits made while it built (title, pr, device, scenario, cfg, …) survive. A side re-pinned meanwhile
    // keeps its new revision and gets no build record: this build is of the old one
    let skipped = null;
    const fresh = updateRun(run, r => {
        const s = r.sides && r.sides[key];
        if (!s || s.rev !== side.rev) {
            skipped = !s ? `side ${key} is no longer in run.json` : `side ${key} was re-pinned while it built (${short(side.rev)} → ${short(s.rev)})`;

            return false;
        }
        for (const f of BUILD_OWNED) {
            if (owned[f] !== undefined) s[f] = owned[f];
            else delete s[f];
        }
        if (setProfile) r.build = Object.assign({}, r.build, { profile: PROFILE });
    });
    if (skipped) log(`   ${skipped} — this build is not recorded in run.json; run build.mjs again for the new revision`);
    // later sides and the last line read the file as it is now
    for (const k of Object.keys(run)) if (!['dir', 'file'].includes(k)) delete run[k];
    Object.assign(run, fresh);
};

try {
    const jobs = sides.map(jobOf);
    const all = jobs.flatMap(j => j.steps);
    const total = estOf(all);
    log(`build ${TARGETS.join(',')} · ${PROFILE} · ${jobs.map(j => `${j.key} ${j.side.url && !j.side.rev ? 'preview' : j.steps.length ? `${j.steps.length} steps` : 'cached'}`).join(', ')}${all.length ? ` · ${total === null ? 'no estimate yet (a step has never run here)' : `est ${dur(total)}, ≈ ${clock(Date.now() + total)}`}` : ''}${SLOT ? '' : ' · machine slot off'}`);
    saveStatus();
    for (const [ji, planned] of jobs.entries()) {
        if (planned.side.url && !planned.side.rev) {
            log(planned.key, 'deployed preview, nothing to build:', planned.side.url);
            status.sides[planned.key] = 'preview';
            continue;
        }
        // one build per clone: a parallel run that needs the same commit waits here, then finds it built
        const lock = await waitFor(`clone-${planned.name}`, { label: `build ${planned.key} ${planned.name}` }, `[${planned.key}] ${planned.name}`);
        try {
            // read again: an earlier job (an A/A run) or another run may have built this very clone
            await buildSide(jobOf(planned.key), jobs.slice(ji + 1).flatMap(j => j.steps));
        } finally {
            lock.release();
        }
    }
    // both sides of a target built: is their code the same? (masked JS comparison, rig/bundlediff.mjs)
    status.step = { name: 'bundle comparison' };
    saveStatus();
    const t0 = Date.now();
    const compared = compareRun(run, TARGETS);
    for (const l of compared) log(l);
    if (compared.length) log(`   bundle comparison in ${dur(Date.now() - t0)} → run.json bundles${compared.some(l => / code-identical between sides/.test(l)) ? ' · a code-identical target is unaffected by the change: report it so, do not time it' : ''}`);
    Object.assign(status, { state: 'finished', side: null, step: null, waiting: null, etaMs: 0, etaAt: new Date().toISOString() });
    saveStatus();
} catch (e) {
    Object.assign(status, { state: 'failed', error: String(e?.message ?? e).slice(0, 2000) });
    saveStatus();
    throw e;
}
log('run.json updated:', Object.entries(run.sides).map(([k, s]) => `${k}=${short(s.buildSha || s.sha)}${s.web ? ' web' : ''}${s.desktop ? ' desktop' : ''}`).join(', '));
