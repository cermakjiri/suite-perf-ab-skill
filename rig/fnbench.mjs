/**
 * Function-level A/B of two revisions of Suite code in Node, for what the page rig cannot see: code
 * outside the renderer (the coinjoin backend in its Electron utility process, the main process, a
 * worker) or a pure function whose cost the app hides behind I/O, rendering or a timer.
 *
 *   node fnbench.mjs --config=<file> [--run=<name|dir>] [--repo=<checkout>] [--sizes=S,M]
 *        [--only=build,plan,run,aggregate] [--dry] [--fresh] [--rebuild] [--sessions=<n>]
 *        [--rounds=<n>] [--budget=<minutes per size>] [--inputs=settled|fresh] [--slot=off] [--pcore=off]
 *
 * build      One esbuild bundle per variant from the checkout's real paths (ESM, Node target, native
 *            addons external, NODE_ENV=production). Every tracked repo file the bundle pulls in is
 *            served from git at the variant's revision, so the checkout's branch and edits do not
 *            leak in; node_modules and untracked (generated) files come from disk. A variant is a
 *            base revision plus per-file overrides, so a hybrid attributes a win to one file. Every
 *            override must land in the bundle, and A and B must bundle different code.
 * plan       One short process per variant and size times a cold and a few warm calls (a variant
 *            over the size's per-call cap is stopped, or skipped where it was too slow at a smaller
 *            size or the config's cost model predicts so). The plan then fits sessions x rounds x
 *            items into the size's time budget: fewer rounds (down to 2), fewer sessions (down to
 *            4), no hybrids or A/A copy, then without the slow side (which the cost model
 *            extrapolates).
 * run        One process per session, the first side alternating; each waits for AC power, holds the
 *            machine slot (locks.mjs) and starts with 2 performance cores free (pcore.mjs). A
 *            sacrificial instance of the fastest variant's bundle is imported first and builds the
 *            inputs; then every item gets its own module instance (import('<bundle>?<item>'):
 *            separate JIT feedback) and its own compiled call glue. Inputs: every item its own copy
 *            (variants never share data), all settled by two full GCs before any call — or, with
 *            inputs: 'fresh', a new one per call built just before its block. Before timing, every
 *            instance's output must equal the reference's (isDeepStrictEqual), the reference must be
 *            deterministic, and settled inputs must come back unchanged and unfrozen. Rounds run in
 *            ABBA order; every block is timed as thread CPU (process.threadCpuUsage) and wall time
 *            per call (reps keep a block >= minBlockMs). Controls: an A/A copy (a second instance of
 *            one bundle with its own input, ~1.00) and a 2x block (one variant called twice, ~2.0).
 *            On macOS arm64 a block whose main thread provably ran on efficiency cores runs again.
 * aggregate  Per size, item and metric the session medians; every comparison as a ratio with its
 *            session range, the rig's Δ%, separation and permutation p (lib.mjs) — called when the
 *            sessions separate and p <= 0.1 — plus the controls and the cost-model fit.
 *
 * Output in <run>/fnbench/: build.json, bundles/, calibration.json, plan.json, sessions/<size>-<n>.json,
 * summary.json, table.txt, status.json. Rerunning resumes: finished sessions of an unchanged plan stay.
 * Config, controls and traps: references/fnbench.md. Worked example: examples/fnbench-coinjoin/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { parseArgs, list, runDir, repoRoot, importFromRepo, git, readJson, writeJson, writeJsonSafe, tryJson, exists } from './lib.mjs';
import { log, dur, clock, sleep, loadavg, powerState, powerKey, median, permutationP, separated, called, minP, CALL_P } from './lib.mjs';

const SELF = import.meta.filename;
const TASKPOLICY = '/usr/sbin/taskpolicy';
// the measuring protocol, part of every plan key: bump it when a session would measure differently
const PROTOCOL = 4;

// what a config leaves out (references/fnbench.md has the whole schema)
const DEFAULTS = { sessions: 6, rounds: 8, budgetMin: 10, minBlockMs: 1, warmupMs: 200, warmupCalls: 100, gc: false, metric: 'cpu', inputs: 'settled', external: [], esbuild: {}, nodeArgs: [] };
// the smallest plan the budget may cut to: 4 v 4 separated is p 0.029; one forward and one reversed round
const MIN_SESSIONS = 4;
const MIN_ROUNDS = 2;
// a size's per-call cap: the smallest plan (4 sessions x (2 rounds + the check + a warm-up call)) must fit its budget
const CAP_CALLS = MIN_SESSIONS * (MIN_ROUNDS + 2);
// a session's fixed cost besides calls: node start, the config and the sacrificial import
const START_MS = 400;
// controls: [in range] and [worth a look]; outside both they are off
const AA_OK = [0.98, 1.02];
const AA_LOOK = [0.95, 1.05];
const TWICE_OK = [1.9, 2.1];
const TWICE_LOOK = [1.8, 2.2];
const WALL_CPU_LOOK = 1.05;
const BORDER_P = 0.25;
// a block whose main thread ran on efficiency cores for more than max(E_MS, E_PCT % of its CPU) is run again, E_RETRIES times
const E_MS = 0.5;
const E_PCT = 2;
const E_RETRIES = 3;
// a block shorter than this is primed with one untimed block of the same item: its first call would
// otherwise refill the caches after whatever ran before it (~14 % of a 2 ms call), and that differs
// with the item's place in the round
const PRIME_MS = 50;
const PCORE_NEED = 2;
const PCORE_WAIT_MS = 900000;
const HEARTBEAT_MS = 30000;
// sessions measure on AC power without Low Power Mode, as plan.mjs's: they wait, and past 10 min say to ask the user
const POWER_POLL_MS = 5000;
const POWER_ASK_MS = 600000;
const LOADERS = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json' };
// esbuild's resolve order, for imports resolved against a variant's tree
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const pct = (a, b) => (a ? +(((b - a) / Math.abs(a)) * 100).toFixed(1) : null);
const sig = (v, d = 5) => (typeof v === 'number' && Number.isFinite(v) ? +v.toPrecision(d) : v);
const rangeOf = v => (v.length ? [Math.min(...v), Math.max(...v)] : null);
const unitOf = ms => (ms >= 1000 ? [1000, 's'] : ms >= 1 ? [1, 'ms'] : ms >= 0.001 ? [0.001, 'µs'] : [1e-6, 'ns']);
const fmtMs = ms => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–';
    if (ms >= 100000) return dur(ms, ms >= 3600000);
    const [k, u] = unitOf(ms);

    return `${(ms / k).toPrecision(4)} ${u}`;
};
// a median with its session range, both in the median's unit
const fmtMed = (med, r) => {
    if (typeof med !== 'number' || !Number.isFinite(med)) return '–';
    const [k, u] = unitOf(med);

    return `${(med / k).toPrecision(4)} ${u}${r ? ` [${(r[0] / k).toPrecision(4)}–${(r[1] / k).toPrecision(4)}]` : ''}`;
};
const fmtX = r => (typeof r !== 'number' || !Number.isFinite(r) ? '–' : r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(3));
const even = x => Math.max(2, 2 * Math.floor(x / 2));
const blocks = n => `${n} block${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ config
/**
 * Cache and resume keys hash only what a phase depends on, so a new budget, session count or model
 * keeps the bundles and the finished sessions. Functions count by their source; the config's
 * sibling modules (the data module and its helpers) by their content.
 */
const keyOf = o => sha256(JSON.stringify(o, (k, v) => (typeof v === 'function' ? v.toString() : v))).slice(0, 16);
/** The files the config imports by path (relative or absolute), transitively: its data module and helpers. */
const localImports = (file, seen = new Set()) => {
    const re = /(?:\bfrom|\bimport)\s*\(?\s*['"]((?:\.{1,2})?\/[^'"]+)['"]/g;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (!seen.has(target) && exists(target) && fs.statSync(target).isFile()) {
            seen.add(target);
            localImports(target, seen);
        }
    }

    return seen;
};
const importsHash = file => {
    const h = crypto.createHash('sha256');
    for (const f of [...localImports(file)].sort()) h.update(f).update(fs.readFileSync(f));

    return h.digest('hex').slice(0, 16);
};
const buildKeyOf = cfg => keyOf({ revs: cfg.revs, variants: cfg.variants, entry: cfg.entry, external: cfg.external, esbuild: cfg.esbuild });
// what a session measures: the bundles' recipe, the config's functions (by source) and settings, the
// modules it imports (by content); a size's shape, items, reps and rounds are in that size's plan key,
// and the budget, session count, model and describe() change no session's numbers
const measureKeyOf = cfg =>
    keyOf({
        build: buildKeyOf(cfg),
        imports: importsHash(cfg.file),
        ...Object.fromEntries(['ref', 'controls', 'makeInput', 'call', 'normalize', 'inputs', 'gc', 'minBlockMs', 'warmupMs', 'warmupCalls', 'nodeArgs'].map(k => [k, cfg[k] ?? null])),
    });
// 'A' or 'B' for a plain revision, 'H' for a hybrid (per-file overrides, or another base)
const sideOf = v => (v.files && Object.keys(v.files).length) || !['A', 'B'].includes(v.base) ? 'H' : v.base;

const loadConfig = async file => {
    if (!file) throw new Error('--config=<file> is required (references/fnbench.md)');
    const abs = path.resolve(String(file));
    const c = (await import(pathToFileURL(abs).href)).default;
    const fail = msg => {
        throw new Error(`${abs}: ${msg}`);
    };
    if (!c || typeof c !== 'object') fail('export default a config object');
    if (!c.revs || !c.revs.A || !c.revs.B) fail('revs: { A: <before>, B: <after> } is required');
    for (const k of ['call', 'makeInput']) if (typeof c[k] !== 'function') fail(`${k} must be a function`);
    if (!c.entry) fail('entry: { <export>: <repo path or package> } is required');
    if (!c.sizes || !Object.keys(c.sizes).length) fail('sizes: { <name>: { shape: {…} } } needs a size');
    for (const [s, z] of Object.entries(c.sizes)) if (!z || !z.shape || typeof z.shape !== 'object') fail(`sizes.${s}.shape is required`);
    const variants = c.variants ?? { A: { base: 'A' }, B: { base: 'B' } };
    for (const [name, v] of Object.entries(variants)) {
        if (!/^[A-Za-z]\w*$/.test(name)) fail(`variant name '${name}': a letter, then letters, digits or _`);
        if (!v || !v.base) fail(`variants.${name}.base is required ('A', 'B' or a revision)`);
    }
    const pure = side => Object.keys(variants).find(n => sideOf(variants[n]) === side);
    if (!pure('A') || !pure('B')) fail('variants need a plain A (base A, no files) and a plain B');
    const ref = c.ref ?? pure('B');
    if (!variants[ref]) fail(`ref '${ref}' is not a variant`);
    const controls = { aa: pure('A'), twice: ref, ...c.controls };
    for (const [k, v] of Object.entries(controls)) if (v && !variants[v]) fail(`controls.${k}: '${v}' is not a variant`);
    if (c.metric && !['cpu', 'wall'].includes(c.metric)) fail("metric: 'cpu' or 'wall'");
    if (c.inputs && !['settled', 'fresh'].includes(c.inputs)) fail("inputs: 'settled' or 'fresh'");
    if (c.model && typeof c.model.cost !== 'function') fail('model.cost must be a function of the shape');

    return { ...DEFAULTS, ...c, variants, ref, controls, pureA: pure('A'), pureB: pure('B'), file: abs, dir: path.dirname(abs), name: c.name ?? path.basename(path.dirname(abs)) };
};

/** The timed items: every variant, the A/A copy (a second instance of controls.aa's bundle) and the 2x block of controls.twice. */
const itemsOf = cfg => {
    const items = Object.entries(cfg.variants).map(([name, v]) => ({ name, variant: name, role: 'variant', side: sideOf(v) }));
    if (cfg.controls.aa) items.push({ name: `${cfg.controls.aa}2`, variant: cfg.controls.aa, role: 'aa', side: sideOf(cfg.variants[cfg.controls.aa]) });
    if (cfg.controls.twice) items.push({ name: `${cfg.controls.twice}2x`, variant: cfg.controls.twice, role: 'twice', side: sideOf(cfg.variants[cfg.controls.twice]) });
    const names = items.map(i => i.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`item name ${dup} is taken twice: rename the variant (controls add <aa>2 and <twice>2x)`);

    return items;
};
/** A session's forward order: the first side's items, the hybrids, the other side's; rounds run it ABBA. */
const forwardOrder = (items, first) => {
    const rank = { variant: 0, aa: 1, twice: 2 };
    const sides = first === 'A' ? ['A', 'H', 'B'] : ['B', 'H', 'A'];

    return sides.flatMap(s => items.filter(i => i.side === s).toSorted((a, b) => rank[a.role] - rank[b.role])).map(i => i.name);
};

// ------------------------------------------------------------------ build
const gitBuf = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const resolveRev = (repo, rev) => {
    try {
        return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], repo);
    } catch {
        throw new Error(`revision ${rev} is not in ${repo}: fetch it first`);
    }
};
/** Tracked files at a commit: repo path -> blob id. */
const lsTree = (repo, sha) => {
    const tree = new Map();
    for (const e of gitBuf(repo, ['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
        const tab = e.indexOf('\t');
        if (tab < 0) continue;
        const [, type, id] = e.slice(0, tab).split(' ');
        if (type === 'blob') tree.set(e.slice(tab + 1), id);
    }

    return tree;
};
/**
 * Packages with a compiled addon: bundled, their loaders look for the binary next to their own file
 * and crash (__dirname). Workspace links are skipped: a workspace package must be bundled.
 */
const nativeAddons = repo => {
    const nm = path.join(repo, 'node_modules');
    const found = [];
    const check = (name, e, dir) => {
        if (!e.isSymbolicLink() && (exists(path.join(dir, 'binding.gyp')) || exists(path.join(dir, 'prebuilds')))) found.push(name);
    };
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (!e.name.startsWith('@')) check(e.name, e, path.join(nm, e.name));
        else if (e.isDirectory()) for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) check(`${e.name}/${s.name}`, s, path.join(nm, e.name, s.name));
    }

    return found;
};
/** A specifier's package name: 'bcrypto/lib/x' → 'bcrypto', '@scope/pkg/x' → '@scope/pkg'. */
const packageOf = spec => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
/** The installed versions of the packages a bundle loads at run time from the checkout's node_modules. */
const externalVersions = (repo, names) => Object.fromEntries([...names].filter(n => !isBuiltin(n)).sort().map(n => [n, tryJson(path.join(repo, 'node_modules', n, 'package.json'))?.version ?? null]));
/** The bundles import externals from their own folder: a node_modules link to the checkout's. */
const linkNodeModules = (repo, out) => {
    const link = path.join(out, 'node_modules');
    const target = path.join(repo, 'node_modules');
    let current = null;
    try {
        current = fs.readlinkSync(link);
    } catch {
        // none yet
    }
    if (current === target) return;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, 'dir');
};
/** entry: { name: 'repo/path.ts' | 'package' | 'spec#original' | 'spec#*' } (or ESM source, resolved from the checkout). */
const entrySource = (cfg, repo, isRepoPath) => {
    if (typeof cfg.entry === 'string') return cfg.entry;

    return Object.entries(cfg.entry)
        .map(([name, spec]) => {
            const [from, orig = name] = String(spec).split('#');
            const target = JSON.stringify(isRepoPath(from) ? path.join(repo, from) : from);
            if (orig === '*') return `export * as ${name} from ${target};`;

            return `export { ${orig === name ? name : `${orig} as ${name}`} } from ${target};`;
        })
        .join('\n');
};

/** The bundles, unless build.json already has them for these revisions, config and esbuild; the machine slot only while building. */
const build = async (cfg, repo, dir, { rebuild, slot }) => {
    const esbuild = await importFromRepo(repo, 'esbuild');
    const names = new Set(['A', 'B']);
    for (const v of Object.values(cfg.variants)) {
        names.add(v.base);
        for (const r of Object.values(v.files ?? {})) names.add(r);
    }
    const revs = {};
    for (const n of names) {
        const rev = n === 'A' || n === 'B' ? String(cfg.revs[n]) : n;
        const sha = resolveRev(repo, rev);
        revs[n] = { rev, sha, subject: git(['log', '-1', '--format=%s', sha], repo) };
    }
    const key = keyOf({ cfg: cfg.buildKey, revs: Object.values(revs).map(r => r.sha), esbuild: esbuild.version, node: process.versions.node.split('.')[0] });
    const prev = tryJson(path.join(dir, 'build.json'));
    if (!rebuild && prev?.key === key) {
        // the cache holds only when the files on disk are the ones recorded and the externals did not move
        const changedFile = Object.entries(prev.variants).find(([, v]) => !exists(path.join(dir, v.bundle)) || sha256(fs.readFileSync(path.join(dir, v.bundle))) !== v.sha256)?.[0];
        const moved = JSON.stringify(externalVersions(repo, Object.keys(prev.externals ?? {}))) !== JSON.stringify(prev.externals ?? {});
        if (!changedFile && !moved) {
            log(`build: cached (${Object.keys(prev.variants).join(', ')}; --rebuild to redo)`);

            return prev;
        }
        log(`build: ${changedFile ? `${changedFile}.mjs is not the bundle build.json recorded` : 'an external package changed its version'}, rebuilding`);
    }
    const h = await slot('build', 'build');
    try {
        return await bundle(cfg, repo, dir, esbuild, revs, key);
    } finally {
        h.release();
    }
};

const bundle = async (cfg, repo, dir, esbuild, revs, key) => {
    const out = path.join(dir, 'bundles');
    const t0 = Date.now();
    const trees = Object.fromEntries(Object.entries(revs).map(([n, r]) => [n, lsTree(repo, r.sha)]));
    const changed = new Set([...trees.A.keys(), ...trees.B.keys()].filter(p => trees.A.get(p) !== trees.B.get(p)));
    const blobs = new Map();
    const blob = id => {
        if (!blobs.has(id)) blobs.set(id, gitBuf(repo, ['cat-file', 'blob', id]));

        return blobs.get(id);
    };
    const external = [...new Set([...nativeAddons(repo), ...cfg.external])];
    fs.mkdirSync(out, { recursive: true });
    linkNodeModules(repo, out);
    const contents = entrySource(cfg, repo, rel => Object.values(trees).some(t => t.has(rel)) || exists(path.join(repo, rel)));
    const repoRel = p => {
        const rel = path.relative(repo, p);

        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules') ? rel : null;
    };
    const result = { key, at: new Date().toISOString(), repo, head: git(['rev-parse', 'HEAD'], repo), esbuild: esbuild.version, node: process.version, revs, external, entry: contents, changed: [], variants: {}, warnings: [] };
    const inputsOf = {};
    const usedExternals = new Set();
    for (const f of fs.readdirSync(out)) if (f.endsWith('.tmp')) fs.rmSync(path.join(out, f), { force: true });
    for (const [name, v] of Object.entries(cfg.variants)) {
        const served = new Map();
        const disk = new Set();
        // a relative import (or the entry's repo path) resolves against the variant's own tree when the
        // checkout would resolve it to another file or to none: a file added, moved or deleted between
        // the revisions then resolves for the side that has it, whatever the checkout holds
        const isFile = c => {
            try {
                return fs.statSync(path.join(repo, c)).isFile();
            } catch {
                return false;
            }
        };
        // force: the importer's folder exists only in the variant's tree, where esbuild cannot resolve
        // from, so a disk file that agrees with the tree is returned too (and a disk-only one as well)
        const fromTree = (rel, force) => {
            const stem = rel.replace(/\.(m|c)?jsx?$/, '');
            const candidates = [rel, ...RESOLVE_EXTS.map(e => rel + e), ...(stem !== rel ? RESOLVE_EXTS.map(e => stem + e) : []), ...RESOLVE_EXTS.map(e => `${rel}/index${e}`)];
            const at = candidates.findIndex(c => trees[v.files?.[c] ?? v.base].has(c));
            if (at < 0) {
                const disk = force && candidates.find(isFile);

                return disk ? path.join(repo, disk) : null;
            }
            const onDisk = candidates.slice(0, at + 1).find(isFile);

            return !force && onDisk === candidates[at] ? null : path.join(repo, candidates[at]);
        };
        const nearestFolder = dir => {
            while (!exists(dir)) dir = path.dirname(dir);

            return dir;
        };
        const plugin = {
            name: 'fnbench-revision',
            setup(b) {
                b.onResolve({ filter: /^(\.\.?(\/|$)|\/)/ }, args => {
                    const absolute = args.path.startsWith('/');
                    // the entry's imports come from <repo>/fnbench-entry.ts, a repo path too
                    if (!absolute && !repoRel(args.importer)) return undefined;
                    const rel = repoRel(absolute ? args.path : path.resolve(args.resolveDir, args.path));
                    const hit = rel && fromTree(rel, !absolute && !exists(args.resolveDir));

                    return hit ? { path: hit } : undefined;
                });
                // a package import from a file whose folder exists only in the tree: esbuild's own
                // resolution from the nearest folder that exists
                b.onResolve({ filter: /^[^./]/ }, async args => {
                    if (args.pluginData?.fnbench || !args.resolveDir || exists(args.resolveDir) || !repoRel(args.importer)) return undefined;
                    const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: nearestFolder(args.resolveDir), pluginData: { fnbench: true } });
                    if (r.errors.length) return { errors: r.errors };

                    return { path: r.path, external: r.external, namespace: r.namespace, sideEffects: r.sideEffects, suffix: r.suffix };
                });
                b.onLoad({ filter: /.*/ }, args => {
                    if (args.namespace !== 'file') return undefined;
                    const rel = repoRel(args.path);
                    if (!rel) return undefined;
                    const at = v.files?.[rel] ?? v.base;
                    const id = trees[at].get(rel);
                    if (!id) {
                        const elsewhere = Object.keys(trees).filter(n => trees[n].has(rel));
                        if (elsewhere.length) throw new Error(`${name}: ${rel} is imported, but it does not exist at ${at} (it does at ${elsewhere.join(', ')}): add it to variants.${name}.files`);
                        disk.add(rel);

                        return undefined;
                    }
                    const loader = LOADERS[path.extname(rel)];
                    const text = loader && blob(id);
                    if (!loader || text.subarray(0, 40).toString().startsWith('version https://git-lfs')) {
                        if (changed.has(rel)) result.warnings.push(`${name}: ${rel} changed between A and B but is read from disk (no loader, or an LFS pointer)`);
                        disk.add(rel);

                        return undefined;
                    }
                    served.set(rel, at);

                    return { contents: text, loader, resolveDir: path.dirname(args.path) };
                });
            },
        };
        // written under a temporary name, renamed once every check has passed (with build.json after them)
        const outfile = path.join(out, `${name}.mjs`);
        const tmpfile = `${outfile}.tmp`;
        const extra = cfg.esbuild ?? {};
        const r = await esbuild.build({
            stdin: { contents, resolveDir: repo, sourcefile: 'fnbench-entry.ts', loader: 'ts' },
            absWorkingDir: repo,
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: `node${process.versions.node.split('.')[0]}`,
            outfile: tmpfile,
            metafile: true,
            logLevel: 'error',
            legalComments: 'none',
            // a bundled CommonJS module's require(), and the externals', from the bundle's own folder
            banner: { js: "import { createRequire as __fnbenchRequire } from 'node:module'; const require = __fnbenchRequire(import.meta.url);" },
            ...extra,
            external: [...external, ...(extra.external ?? [])],
            define: { 'process.env.NODE_ENV': '"production"', ...extra.define },
            plugins: [plugin, ...(extra.plugins ?? [])],
        });
        for (const rel of Object.keys(v.files ?? {})) {
            if (!served.has(rel)) throw new Error(`variants.${name}.files: ${rel} is not in the bundle (a wrong path, or the entry does not reach it)`);
        }
        const inputs = Object.keys(r.metafile.inputs).filter(p => p !== 'fnbench-entry.ts');
        inputsOf[name] = new Set(inputs);
        for (const o of Object.values(r.metafile.outputs)) for (const i of o.imports ?? []) if (i.external) usedExternals.add(packageOf(i.path));
        const buf = fs.readFileSync(tmpfile);
        const byRev = {};
        for (const at of served.values()) byRev[at] = (byRev[at] ?? 0) + 1;
        result.variants[name] = {
            base: v.base,
            files: v.files ?? {},
            side: sideOf(v),
            bundle: path.relative(dir, outfile),
            sha256: sha256(buf),
            bytes: buf.length,
            modules: inputs.length,
            fromGit: byRev,
            nodeModules: inputs.filter(p => p.split('/').includes('node_modules')).length,
            untracked: [...disk].sort(),
            changed: Object.fromEntries([...served].filter(([rel]) => changed.has(rel)).sort()),
        };
    }
    const A = result.variants[cfg.pureA];
    const B = result.variants[cfg.pureB];
    if (A.sha256 === B.sha256) throw new Error(`${cfg.pureA} and ${cfg.pureB} bundle byte-identical code: nothing the entry reaches changed between ${revs.A.rev} and ${revs.B.rev}`);
    result.changed = [...new Set(Object.values(result.variants).flatMap(v => Object.keys(v.changed)))].sort();
    result.changedNotBundled = [...changed].filter(p => !result.changed.includes(p)).sort();
    // what the sessions run: the bundles' bytes and the externals they load from node_modules; a
    // rebuild or a reinstall that changes either makes the finished sessions stale
    result.externals = externalVersions(repo, [...usedExternals].filter(n => exists(path.join(repo, 'node_modules', n, 'package.json'))));
    result.bundlesKey = keyOf({ bundles: Object.fromEntries(Object.entries(result.variants).map(([n, v]) => [n, v.sha256])), externals: result.externals });
    for (const [name, v] of Object.entries(result.variants)) {
        if (v.side === 'H' && (v.sha256 === A.sha256 || v.sha256 === B.sha256)) result.warnings.push(`hybrid ${name} is byte-identical to ${v.sha256 === A.sha256 ? cfg.pureA : cfg.pureB}`);
        if (name === cfg.ref) continue;
        v.onlyHere = [...inputsOf[name]].filter(p => !inputsOf[cfg.ref].has(p)).sort();
        v.missingHere = [...inputsOf[cfg.ref]].filter(p => !inputsOf[name].has(p)).sort();
    }
    const untracked = [...new Set(Object.values(result.variants).flatMap(v => v.untracked))];
    if (untracked.length) result.warnings.push(`${untracked.length} untracked repo files come from disk, the same for every variant: ${untracked.slice(0, 3).join(', ')}${untracked.length > 3 ? ', …' : ''}`);
    for (const v of Object.values(result.variants)) fs.renameSync(`${path.join(dir, v.bundle)}.tmp`, path.join(dir, v.bundle));
    writeJson(path.join(dir, 'build.json'), result);
    const text = n => {
        const v = result.variants[n];

        return `${n} ${v.modules} modules (${Object.entries(v.fromGit).map(([at, k]) => `${k} at ${at}`).join(', ')}, ${v.nodeModules} node_modules) ${Math.round(v.bytes / 1024)} KB`;
    };
    log(`build in ${dur(Date.now() - t0)}: ${Object.keys(result.variants).map(text).join(' · ')}`);
    log(`build: changed and bundled: ${result.changed.join(', ')}${result.changedNotBundled.length ? ` · changed, not bundled: ${result.changedNotBundled.length}` : ''}`);
    for (const [n, v] of Object.entries(result.variants)) {
        if (v.onlyHere?.length || v.missingHere?.length) log(`build: ${n} vs ${cfg.ref}: ${v.onlyHere.length} module${v.onlyHere.length === 1 ? '' : 's'} only in ${n}${v.onlyHere.length ? ` (${v.onlyHere.slice(0, 2).join(', ')}${v.onlyHere.length > 2 ? ', …' : ''})` : ''}, ${v.missingHere.length} only in ${cfg.ref}`);
    }
    for (const w of result.warnings) log(`build: warning: ${w}`);

    return result;
};

// ------------------------------------------------------------------ child processes: calibration and sessions
/**
 * A copy of fn compiled from its source for one item, so items share no call-site feedback: every
 * `new Function` is a function of its own, while closures one factory hands out share theirs (Node
 * 24: a sibling of an optimized closure runs optimized code on its first call). The item's name in
 * the source names it in profiles. A fn that needs its module's scope throws a ReferenceError on its
 * first call; the item then falls back to fn itself (recorded as isolated: false).
 */
const isolate = (fn, name) => {
    let src = fn.toString();
    // method shorthand: call(mod, input) { … }
    const m = /^(async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(src);
    if (m && m[2] !== 'function' && m[2] !== 'async') src = `${m[1] ?? ''}function ${src.slice((m[1] ?? '').length)}`;
    try {
        const copy = new Function(`/* fnbench ${name} */ return (${src});`)();

        return typeof copy === 'function' ? copy : fn;
    } catch {
        return fn;
    }
};
/** A timed block's loop, compiled per item too: n calls, every result stored (no call is dead code). */
const makeLoop = (name, isAsync) =>
    new Function(
        'call',
        'mod',
        'inputs',
        'input',
        'n',
        'keep',
        isAsync
            ? `/* fnbench ${name} */ return (async () => { for (let i = 0; i < n; i++) keep[i & 3] = await call(mod, inputs === null ? input : inputs[i]); })();`
            : `/* fnbench ${name} */ for (let i = 0; i < n; i++) keep[i & 3] = call(mod, inputs === null ? input : inputs[i]);`,
    );
/** Frozen objects reachable from an input: Immer and friends freeze what they are handed. */
const countFrozen = (root, limit = 2e6) => {
    const seen = new Set();
    const stack = [root];
    let frozen = 0;
    while (stack.length && seen.size < limit) {
        const o = stack.pop();
        if (o === null || typeof o !== 'object' || seen.has(o)) continue;
        seen.add(o);
        if (Object.isFrozen(o)) frozen++;
        if (ArrayBuffer.isView(o)) continue;
        if (o instanceof Map) for (const [k, v] of o) stack.push(k, v);
        else if (o instanceof Set) for (const v of o) stack.push(v);
        for (const k of Object.keys(o)) stack.push(o[k]);
    }

    return frozen;
};
const preview = v => {
    try {
        return (JSON.stringify(v) ?? String(v)).slice(0, 80);
    } catch {
        return String(v).slice(0, 80);
    }
};
/** Where two values first differ, as a path. */
const firstDiff = (a, b, at = '$', depth = 0) => {
    if (isDeepStrictEqual(a, b)) return null;
    if (depth > 40 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${at}: ${preview(a)} vs ${preview(b)}`;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${at}: a ${a.constructor?.name} vs a ${b.constructor?.name}`;
    if (a instanceof Map || a instanceof Set) return `${at}: ${a.constructor.name} contents differ (${a.size} vs ${b.size} entries)`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!isDeepStrictEqual(a[k], b[k])) return firstDiff(a[k], b[k], `${at}.${k}`, depth + 1);
    }

    return `${at}: same keys and values, another difference (symbols, descriptors)`;
};
/** pcore.c's watcher on this process (process scope): read() returns its cumulative P/E milliseconds now. */
const startWatch = bin => {
    const argv = ['watch', '--pid', String(process.pid), '--tid', '0', '--scope', 'process', '--interval-ms', '10000'];
    const proc = exists(TASKPOLICY) ? spawn(TASKPOLICY, ['-c', 'utility', bin, ...argv], { stdio: ['pipe', 'pipe', 'ignore'] }) : spawn(bin, argv, { stdio: ['pipe', 'pipe', 'ignore'] });
    const waiters = [];
    let error = null;
    let buf = '';
    proc.stdout.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
            let s;
            try {
                s = JSON.parse(buf.slice(0, i));
            } catch {
                continue;
            }
            if (s.error) error ??= s.error;
            else if (s.r && waiters.length) waiters.shift().resolve(s);
        }
    });
    proc.stdin.on('error', () => {});
    proc.on('exit', code => {
        error ??= `the counter watcher exited (${code})`;
        for (const w of waiters.splice(0)) w.reject(new Error(error));
    });

    return {
        read() {
            if (error) return Promise.reject(new Error(error));
            const { promise, resolve, reject } = Promise.withResolvers();
            const w = {};
            const timer = setTimeout(() => {
                const at = waiters.indexOf(w);
                if (at >= 0) waiters.splice(at, 1);
                error ??= 'the counter watcher did not answer within 3 s';
                reject(new Error(error));
            }, 3000);
            w.resolve = s => {
                clearTimeout(timer);
                resolve(s);
            };
            w.reject = e => {
                clearTimeout(timer);
                reject(e);
            };
            waiters.push(w);
            proc.stdin.write('r\n');

            return promise;
        },
        close() {
            proc.stdin.end();
            setTimeout(() => proc.kill(), 1000).unref();
        },
    };
};

const child = async specFile => {
    const spec = readJson(specFile);
    const cfg = await loadConfig(spec.config);
    cfg.inputs = spec.inputs ?? cfg.inputs;
    // an edit to the config or its modules during a run would otherwise land under the old plan key
    if (spec.measureKey && measureKeyOf(cfg) !== spec.measureKey) throw new Error(`the config or a module it imports changed since ${spec.id} was planned: run the plan phase again`);
    const emit = o => process.stdout.write(`${JSON.stringify(o)}\n`);
    const url = variant => pathToFileURL(spec.bundles[variant]).href;
    // the sacrificial instance: imported first (the first instance in a process runs slower), it builds the inputs
    // tags with a '-' cannot collide with an item's name (letters, digits, _)
    const sac = await import(`${url(spec.sac)}?fnbench-sac`);
    const ctx = { mod: sac, size: spec.size, cacheDir: spec.cacheDir };
    const makeInput = async () => cfg.makeInput(spec.shape, ctx);
    const result = spec.mode === 'calibrate' ? await calibrateOne(spec, cfg, makeInput, url, emit) : await session(spec, cfg, sac, makeInput, url, emit);
    writeJson(spec.out, result);
    // the code under test may leave timers or handles behind
    process.exit(0);
};

/** One variant at one size: a cold call, then warm calls for ~warmupMs — estimates for the plan, not results. */
const calibrateOne = async (spec, cfg, makeInput, url, emit) => {
    let t = performance.now();
    const input = await makeInput();
    const inputMs = performance.now() - t;
    t = performance.now();
    const mod = await import(`${url(spec.variant)}?fnbench-cal`);
    const importMs = performance.now() - t;
    // settled like a session's own input (a young input can run several times faster)
    if (!spec.fresh) {
        globalThis.gc();
        globalThis.gc();
    }
    let call = isolate(cfg.call, 'cal');
    const once = async () => {
        const t0 = performance.now();
        const r = call(mod, input);
        if (r && typeof r.then === 'function') await r;

        return performance.now() - t0;
    };
    emit({ ev: 'call' });
    let coldMs;
    try {
        coldMs = await once();
    } catch (e) {
        if (!(e instanceof ReferenceError) || call === cfg.call) throw e;
        call = cfg.call;
        coldMs = await once();
    }
    emit({ ev: 'cold', ms: coldMs });
    // warm calls in batches of >= 1 ms (doubling): one sub-µs call can read 0 on this clock
    const batch = async k => {
        const inputs = [];
        if (spec.fresh) for (let i = 0; i < k; i++) inputs.push(await makeInput());
        const t0 = performance.now();
        for (let i = 0; i < k; i++) {
            const r = call(mod, spec.fresh ? inputs[i] : input);
            if (r && typeof r.then === 'function') await r;
        }

        return performance.now() - t0;
    };
    const warm = [];
    let spent = coldMs;
    let calls = 1;
    for (let k = 1; spent < spec.warmupMs && k <= 1e6; ) {
        const ms = await batch(k);
        spent += ms;
        calls += k;
        if (ms < 1) k *= 2;
        else warm.push(ms / k);
    }
    let gcMs = null;
    if (globalThis.gc) {
        t = performance.now();
        globalThis.gc();
        gcMs = performance.now() - t;
    }

    return { variant: spec.variant, inputMs: sig(inputMs), importMs: sig(importMs), coldMs: sig(coldMs), warmMs: warm.length ? sig(median(warm.slice(warm.length >> 1))) : null, calls, gcMs: sig(gcMs) };
};

const session = async (spec, cfg, sac, makeInput, url, emit) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const loadBefore = loadavg();
    const stage = (name, extra = {}) => emit({ ev: 'stage', stage: name, ...extra });
    const items = spec.items.map(i => ({ ...i, reps: spec.reps[i.name], n: spec.reps[i.name] * (i.role === 'twice' ? 2 : 1), call: isolate(cfg.call, i.name), isolated: true, keep: [null, null, null, null] }));
    const byName = Object.fromEntries(items.map(i => [i.name, i]));
    // one module instance per item, in this session's order, the 2x block's too: an instance it
    // shared would get extra calls and warm code that its variant's rival never gets
    const instances = spec.order;
    stage('import');
    const mods = {};
    for (const name of instances) mods[name] = await import(`${url(byName[name].variant)}?${name}`);
    for (const it of items) it.mod = mods[it.name];

    // inputs: every item its own copy (one variant's side effects on shared data, such as the hashes
    // its Map lookups leave in strings, would speed up another), a pristine copy and the sacrificial
    // instance's own; two full GCs then settle them all before any call, the same way in every session
    stage('input');
    const fresh = !!spec.fresh;
    const own = {};
    if (!fresh) for (const name of spec.order) own[name] = await makeInput();
    const pristine = fresh ? null : await makeInput();
    const sacInput = await makeInput();
    // objects only: equal primitives (a string or a number input) are fine
    const built = [...Object.values(own), pristine ?? (await makeInput()), sacInput].filter(x => x !== null && (typeof x === 'object' || typeof x === 'function'));
    if (new Set(built).size !== built.length) throw new Error('makeInput returned the same object twice: it must build a new input on every call');
    const frozenBefore = Object.fromEntries(Object.entries(own).map(([n, x]) => [n, countFrozen(x)]));
    globalThis.gc();
    globalThis.gc();

    // the check: same output as the reference, a deterministic reference, reused inputs untouched
    stage('check');
    const inputFor = async it => (fresh ? makeInput() : own[it.name]);
    const unchanged = () => {
        for (const [name, input] of Object.entries(own)) {
            if (!isDeepStrictEqual(input, pristine)) throw new Error(`${name}'s call changed its input (${firstDiff(input, pristine)}): a reused input differs between calls — set inputs: 'fresh'`);
            const frozen = countFrozen(input) - frozenBefore[name];
            if (frozen > 0) throw new Error(`${name}'s call froze ${frozen} objects of its input (Immer auto-freeze?): calls on a frozen input get cheaper — set inputs: 'fresh'`);
        }
    };
    let isAsync = null;
    const callOnce = async (it, input) => {
        const r = it.call(it.mod, input);
        const thenable = !!r && typeof r.then === 'function';
        if (isAsync === null) isAsync = thenable;
        else if (thenable !== isAsync) throw new Error('call returns a promise for some items and not for others');

        return thenable ? await r : r;
    };
    const firstCall = async (it, input) => {
        try {
            return await callOnce(it, input);
        } catch (e) {
            if (!(e instanceof ReferenceError) || it.call === cfg.call) throw e;
            // the copy cannot see the config module's scope: this item shares the config's call
            it.call = cfg.call;
            it.isolated = false;

            return callOnce(it, input);
        }
    };
    {
        const r = cfg.call(sac, sacInput);
        if (r && typeof r.then === 'function') await r;
    }
    const outputs = {};
    const firstMs = {};
    for (const name of instances) {
        const input = await inputFor(byName[name]);
        const t = performance.now();
        outputs[name] = await firstCall(byName[name], input);
        firstMs[name] = sig(performance.now() - t);
    }
    const refName = instances.includes(spec.ref) ? spec.ref : instances.find(n => byName[n].role === 'variant');
    const norm = cfg.normalize ?? (x => x);
    const ref = norm(outputs[refName]);
    for (const name of instances) {
        if (name === refName) continue;
        const out = norm(outputs[name]);
        if (!isDeepStrictEqual(out, ref)) throw new Error(`${name} returns something else than ${refName} on size ${spec.size}: ${firstDiff(out, ref)}`);
    }
    const again = norm(await callOnce(byName[refName], await inputFor(byName[refName])));
    if (!isDeepStrictEqual(again, ref)) throw new Error(`${refName} is not deterministic on size ${spec.size} (${firstDiff(again, ref)}): normalize() its output in the config`);
    unchanged();
    const describe = cfg.describe ? cfg.describe(pristine ?? (await makeInput()), outputs[refName]) : null;
    for (const k of Object.keys(outputs)) outputs[k] = null;

    // warm-up: every item's own loop, until warmupMs or warmupCalls blocks
    stage('warm-up');
    const inputsFor = async it => {
        if (!fresh) return null;
        const a = [];
        for (let i = 0; i < it.n; i++) a.push(await makeInput());

        return a;
    };
    for (const name of spec.order) {
        const it = byName[name];
        it.loop = makeLoop(name, isAsync);
        let spent = firstMs[name] ?? 0;
        let warm = 0;
        // the first round's priming goes by the last warm-up block, else by the check's (compiling) first call
        it.lastMs = (firstMs[name] ?? 0) * it.n;
        while (warm < spec.warmupCalls && spent < spec.warmupMs) {
            const inputs = await inputsFor(it);
            const t = performance.now();
            const r = it.loop(it.call, it.mod, inputs, own[name] ?? null, it.n, it.keep);
            if (isAsync) await r;
            it.lastMs = performance.now() - t;
            spent += it.lastMs;
            warm++;
        }
        it.keep.fill(null);
        it.warm = warm;
        it.primed = 0;
    }

    // rounds
    const watch = spec.pcore ? startWatch(spec.pcore.bin) : null;
    const placement = { scope: watch ? 'process' : null, eMs: 0, cpuMs: 0, retried: 0, offP: 0, error: watch ? null : 'off' };
    const read = async () => {
        if (!watch || placement.error) return null;
        try {
            return await watch.read();
        } catch (e) {
            placement.error = e.message;

            return null;
        }
    };
    const gcs = [];
    const obs = new PerformanceObserver(l => {
        for (const e of l.getEntries()) gcs.push([e.startTime, e.duration]);
    });
    obs.observe({ type: 'gc' });
    const block = async (it, round) => {
        for (let attempt = 0; ; attempt++) {
            if (spec.gc) globalThis.gc();
            const primeInputs = it.lastMs < PRIME_MS ? await inputsFor(it) : undefined;
            // the placement read first: then only the priming block runs before the timed one, and with
            // fresh inputs their building, after the priming so they do not live through its GCs
            const before = await read();
            const cp = process.threadCpuUsage();
            if (primeInputs !== undefined) {
                const p = it.loop(it.call, it.mod, primeInputs, own[it.name] ?? null, it.n, it.keep);
                if (isAsync) await p;
                it.keep.fill(null);
                it.primed++;
            }
            const inputs = fresh ? await inputsFor(it) : null;
            const c0 = process.threadCpuUsage();
            const w0 = performance.now();
            const r = it.loop(it.call, it.mod, inputs, own[it.name] ?? null, it.n, it.keep);
            if (isAsync) await r;
            const w1 = performance.now();
            const c1 = process.threadCpuUsage();
            const after = before && (await read());
            it.keep.fill(null);
            it.lastMs = w1 - w0;
            const cpuMs = (c1.user - c0.user + (c1.system - c0.system)) / 1000;
            const s = { round, cpu: cpuMs / it.reps, wall: (w1 - w0) / it.reps, w0, w1 };
            if (after) {
                // the main thread's efficiency-core time over priming and block, at least: the process's
                // E time beyond all its other threads' CPU
                const mainMs = (c1.user - cp.user + (c1.system - cp.system)) / 1000;
                const p = after.p - before.p;
                const e = after.e - before.e;
                const eMain = Math.max(0, e - Math.max(0, p + e - mainMs));
                s.e = eMain;
                if (eMain > Math.max(spec.pcore.ms, (spec.pcore.pct / 100) * cpuMs)) {
                    if (attempt < spec.pcore.retries) {
                        placement.retried++;
                        continue;
                    }
                    s.offP = true;
                    placement.offP++;
                }
                placement.eMs += eMain;
                placement.cpuMs += mainMs;
            }
            if (attempt) s.retries = attempt;

            return s;
        }
    };
    const samples = Object.fromEntries(spec.order.map(n => [n, []]));
    for (let r = 0; r < spec.rounds; r++) {
        stage('round', { i: r + 1, n: spec.rounds });
        const order = r % 4 === 0 || r % 4 === 3 ? spec.order : spec.order.toReversed();
        for (const name of order) samples[name].push(await block(byName[name], r));
        await new Promise(resolve => setImmediate(resolve));
    }
    for (const e of obs.takeRecords()) gcs.push([e.startTime, e.duration]);
    obs.disconnect();
    watch?.close();
    // main-thread GC pauses inside each block, per call
    for (const [name, list] of Object.entries(samples)) {
        for (const s of list) {
            let g = 0;
            for (const [start, d] of gcs) g += Math.max(0, Math.min(start + d, s.w1) - Math.max(start, s.w0));
            s.gc = sig(g / byName[name].reps, 4);
            s.cpu = sig(s.cpu);
            s.wall = sig(s.wall);
            if (s.e !== undefined) s.e = sig(s.e, 3);
            delete s.w0;
            delete s.w1;
        }
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([n, l]) => [n, { cpu: median(l.map(s => s.cpu)), wall: median(l.map(s => s.wall)), gc: median(l.map(s => s.gc)) }]));

    return {
        id: spec.id,
        mode: 'session',
        planKey: spec.planKey,
        size: spec.size,
        n: spec.n,
        first: spec.first,
        pid: process.pid,
        node: process.version,
        startedAt,
        ms: Date.now() - t0,
        load: [loadBefore, loadavg()],
        power: spec.power,
        rounds: spec.rounds,
        reps: spec.reps,
        order: spec.order,
        instances,
        sac: spec.sac,
        async: isAsync,
        isolated: Object.fromEntries(items.map(i => [i.name, i.isolated])),
        check: { equalTo: refName, instances, deterministic: true, input: fresh ? 'fresh per call' : 'settled, one per item, unchanged and unfrozen', describe },
        firstMs,
        warm: Object.fromEntries(items.map(i => [i.name, i.warm])),
        primed: Object.fromEntries(items.map(i => [i.name, i.primed])),
        medians,
        placement: { ...placement, eMs: sig(placement.eMs, 4), cpuMs: sig(placement.cpuMs), eSharePct: placement.cpuMs ? +((100 * placement.eMs) / placement.cpuMs).toFixed(2) : null },
        samples,
    };
};

// ------------------------------------------------------------------ the parent: children, calibration, plan, sessions
let running = null;
const runChild = (cfg, spec, { timeoutMs, capMs = null, onEvent = null } = {}) =>
    new Promise((resolve, reject) => {
        fs.rmSync(spec.out, { force: true });
        writeJson(spec.specFile, spec);
        const env = { ...process.env, NODE_ENV: 'production' };
        delete env.NODE_OPTIONS;
        const proc = spawn(process.execPath, ['--expose-gc', ...cfg.nodeArgs, SELF, `--child=${spec.specFile}`], { stdio: ['ignore', 'pipe', 'pipe'], env });
        running = proc;
        let killed = null;
        let cap = null;
        let err = '';
        let buf = '';
        const kill = why => {
            killed = why;
            proc.kill('SIGKILL');
        };
        const total = setTimeout(() => kill('timeout'), timeoutMs);
        proc.stdout.on('data', d => {
            buf += d;
            for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
                let ev;
                try {
                    ev = JSON.parse(buf.slice(0, i));
                } catch {
                    continue;
                }
                if (!ev || typeof ev.ev !== 'string') continue;
                if (ev.ev === 'call' && capMs) cap = setTimeout(() => kill('cap'), capMs);
                if (ev.ev === 'cold') clearTimeout(cap);
                if (onEvent) onEvent(ev);
            }
        });
        proc.stderr.on('data', d => {
            err = (err + d).slice(-8000);
        });
        proc.on('exit', (code, signal) => {
            running = null;
            clearTimeout(total);
            clearTimeout(cap);
            if (killed === 'cap') return resolve({ cap: true });
            if (killed === 'timeout') return reject(new Error(`${spec.id}: no result after ${dur(timeoutMs)}, killed`));
            if (code === 0 && exists(spec.out)) return resolve(readJson(spec.out));
            const lines = err.trim().split('\n');
            const tail = lines.filter((l, i) => !/^\s+at /.test(l) || (i > 0 && !/^\s+at /.test(lines[i - 1]))).slice(-8).join('\n');
            reject(new Error(`${spec.id}: exit ${code ?? signal}${tail ? `\n${tail}` : ''}`));
        });
    });

const bundlePaths = (b, dir) => Object.fromEntries(Object.entries(b.variants).map(([n, v]) => [n, path.join(dir, v.bundle)]));
const budgetMsOf = (cfg, size, o) => 60000 * (o.budget ?? cfg.sizes[size].budgetMin ?? cfg.budgetMin);
const estOf = c => (c && !c.cap && !c.skipped && Number.isFinite(c.warmMs ?? c.coldMs) ? (c.warmMs ?? c.coldMs) : null);
const calText = c => (c.cap ? 'over the cap' : c.skipped ? `skipped (${c.skipped})` : `${fmtMs(estOf(c))}${c.warmMs === null ? ' (cold)' : ''}`);

/** Per-call estimates per size and variant, cached in calibration.json. */
const calibrate = async (cfg, b, dir, sizes, o, slot) => {
    const file = path.join(dir, 'calibration.json');
    const order = Object.keys(cfg.sizes);
    // per size: the bundles, what a call measures, the size's shape and cap, the model (its skips);
    // a size calibrated again takes the larger ones after it along (their skips build on it)
    const keyFor = size => keyOf({ b: b.bundlesKey, cfg: cfg.measureKey, size, shape: cfg.sizes[size].shape, model: cfg.model ?? null });
    const capFor = size => budgetMsOf(cfg, size, o) / CAP_CALLS;
    // another budget keeps a size's estimates unless its new cap could change who runs (fresh
    // estimates would shift reps and the sacrificial pick, and with them the finished sessions' key)
    const usable = (s, e) => e && e.key === keyFor(s) && (e.capMs === capFor(s) || Object.values(e.variants).every(c => estOf(c) !== null && 2 * estOf(c) < capFor(s)));
    const prev = tryJson(file)?.sizes ?? {};
    const cal = {};
    for (const s of order) if (usable(s, prev[s])) cal[s] = prev[s];
    const first = order.findIndex(s => sizes.includes(s) && !cal[s]);
    const todo = sizes.filter(s => !cal[s] || (first >= 0 && order.indexOf(s) > first));
    for (const s of todo) delete cal[s];
    if (!todo.length) {
        log(`calibrate: cached (${sizes.join(', ')})`);

        return cal;
    }
    const variants = [cfg.ref, ...Object.keys(cfg.variants).filter(v => v !== cfg.ref)];
    const h = await slot('calibrate', 'trial');
    try {
        for (const size of todo) {
            const z = cfg.sizes[size];
            const capMs = budgetMsOf(cfg, size, o) / CAP_CALLS;
            const entry = { key: keyFor(size), capMs, variants: {} };
            const earlier = order.slice(0, order.indexOf(size)).filter(s => cal[s]);
            for (const v of variants) {
                // too slow at a smaller size, or predicted too slow by the cost model fitted on the smaller sizes
                const before = earlier.find(s => cal[s].variants[v]?.cap || cal[s].variants[v]?.skipped);
                if (before) {
                    entry.variants[v] = { skipped: `too slow at ${before}` };
                    continue;
                }
                if (cfg.model && (cfg.model.variant ?? cfg.pureA) === v) {
                    const pts = earlier.filter(s => estOf(cal[s].variants[v]) !== null).map(s => [cfg.model.cost(cfg.sizes[s].shape), estOf(cal[s].variants[v])]);
                    if (pts.length) {
                        const k = pts.reduce((a, [c, t]) => a + c * t, 0) / pts.reduce((a, [c]) => a + c * c, 0);
                        const predicted = k * cfg.model.cost(z.shape);
                        if (predicted > 2 * capMs) {
                            entry.variants[v] = { skipped: `the model predicts ${fmtMs(predicted)} a call`, predictedMs: sig(predicted) };
                            continue;
                        }
                    }
                }
                const id = `calibrate-${size}-${v}`;
                const spec = { mode: 'calibrate', id, config: cfg.file, measureKey: cfg.measureKey, inputs: cfg.inputs, size, shape: z.shape, variant: v, sac: cfg.ref, bundles: bundlePaths(b, dir), fresh: cfg.inputs === 'fresh', warmupMs: cfg.warmupMs, warmupCalls: cfg.warmupCalls, cacheDir: path.join(dir, 'cache'), out: path.join(dir, 'specs', `${id}.out.json`), specFile: path.join(dir, 'specs', `${id}.json`) };
                entry.variants[v] = await runChild(cfg, spec, { timeoutMs: Math.max(600000, 3 * capMs), capMs: 1.25 * capMs });
            }
            entry.inputMs = Math.max(0, ...Object.values(entry.variants).map(c => c.inputMs ?? 0));
            cal[size] = entry;
            // sizes outside this --sizes keep their entries
            writeJson(file, { sizes: { ...prev, ...cal } });
            log(`calibrate ${size}: ${variants.map(v => `${v} ${calText(entry.variants[v])}`).join(' · ')} · input ${fmtMs(entry.inputMs)} · cap ${fmtMs(capMs)} a call`);
        }
    } finally {
        h.release();
    }

    return cal;
};

/** Sessions x rounds x items for one size, within its time budget. */
const planSize = (cfg, b, cal, size, o) => {
    const all = itemsOf(cfg);
    const z = cfg.sizes[size];
    const budgetMs = budgetMsOf(cfg, size, o);
    const est = v => estOf(cal.variants[v]);
    const dropped = [];
    // a control runs next to its variant, after every cut too
    const withControls = items => items.filter(i => i.role === 'variant' || items.some(x => x.role === 'variant' && x.name === i.variant));
    let pool = all.filter(i => !z.items || z.items.includes(i.name));
    for (const i of all) if (!pool.includes(i)) dropped.push({ item: i.name, reason: `not in sizes.${size}.items` });
    for (const i of pool) {
        const c = cal.variants[i.variant];
        if (est(i.variant) === null) dropped.push({ item: i.name, reason: !c ? 'not calibrated' : c.cap ? `a call takes over the ${fmtMs(cal.capMs)} cap` : c.skipped });
    }
    pool = pool.filter(i => est(i.variant) !== null);
    for (const i of pool) if (!withControls(pool).includes(i)) dropped.push({ item: i.name, reason: `${i.variant} does not run` });
    pool = withControls(pool);
    if (!pool.length) throw new Error(`size ${size}: nothing left to run (${dropped.map(d => `${d.item}: ${d.reason}`).join('; ')})`);
    const reps = Object.fromEntries(pool.map(i => [i.name, Number.isInteger(z.reps) ? z.reps : Math.min(1e6, Math.max(1, Math.ceil(cfg.minBlockMs / Math.max(est(i.variant), 1e-6))))]));
    const inputMs = cal.inputMs ?? 0;
    const importMs = Math.max(0, ...Object.values(cal.variants).map(c => c.importMs ?? 0));
    const gcMs = cfg.gc ? Math.max(0, ...Object.values(cal.variants).map(c => c.gcMs ?? 0)) : 0;
    const cold = v => cal.variants[v].coldMs ?? est(v);
    const blockMs = i => {
        const one = reps[i.name] * (i.role === 'twice' ? 2 : 1) * (est(i.variant) + (cfg.inputs === 'fresh' ? inputMs : 0));

        return (one < PRIME_MS ? 2 * one : one) + gcMs;
    };
    const sacOf = items => [...new Set(items.map(i => i.variant))].toSorted((x, y) => est(x) - est(y))[0];
    const sessionMs = (items, rounds) => {
        // the sacrificial call, every instance's first call and the reference's second one
        const ref = items.some(i => i.name === cfg.ref) ? cfg.ref : items.find(i => i.role === 'variant').variant;
        const check = est(sacOf(items)) + items.reduce((a, i) => a + cold(i.variant), 0) + est(ref);
        const warm = items.reduce((a, i) => a + Math.min(Math.max(0, cfg.warmupMs - cold(i.variant)), cfg.warmupCalls * blockMs(i)), 0);
        // one input per item, a pristine (or a probe) and the sacrificial one
        const inputs = items.length + 2;

        return START_MS + inputMs * inputs + importMs * items.length + check + warm + rounds * items.reduce((a, i) => a + blockMs(i), 0);
    };
    const want = { sessions: o.sessions ?? z.sessions ?? cfg.sessions, rounds: o.rounds ?? z.rounds ?? cfg.rounds };
    const shapes = [];
    for (let r = want.rounds; ; r = Math.max(MIN_ROUNDS, even(r / 2))) {
        shapes.push({ sessions: want.sessions, rounds: r });
        if (r <= MIN_ROUNDS) break;
    }
    for (let s = even(want.sessions - 1); s >= MIN_SESSIONS && s < want.sessions; s -= 2) shapes.push({ sessions: s, rounds: Math.min(MIN_ROUNDS, want.rounds) });
    // item sets, cheapest cut first: the optional items (hybrids, the A/A copy; the most expensive
    // first), then the 2x block; last, only the fast side (with its own controls)
    const optional = pool.filter(i => i.side === 'H' || i.role === 'aa').toSorted((x, y) => blockMs(y) - blockMs(x));
    const sets = [{ items: pool }];
    for (const i of [...optional, ...pool.filter(x => x.role === 'twice')]) if (sets.at(-1).items.includes(i)) sets.push({ items: withControls(sets.at(-1).items.filter(x => x !== i)) });
    const slow = est(cfg.pureA) !== null && est(cfg.pureB) !== null ? (est(cfg.pureA) >= est(cfg.pureB) ? 'A' : 'B') : null;
    const fastOnly = slow && withControls(pool.filter(i => i.side !== slow && i.side !== 'H'));
    if (fastOnly?.length) sets.push({ items: fastOnly, slowCut: true });
    let chosen = null;
    for (const set of sets) {
        for (const sh of shapes) {
            const ms = sh.sessions * sessionMs(set.items, sh.rounds);
            if (ms <= budgetMs) {
                chosen = { ...set, ...sh, ms };
                break;
            }
        }
        if (chosen) break;
    }
    const over = !chosen;
    if (!chosen) chosen = { ...sets.at(-1), ...shapes.at(-1), ms: shapes.at(-1).sessions * sessionMs(sets.at(-1).items, shapes.at(-1).rounds) };
    for (const i of pool) if (!chosen.items.includes(i)) dropped.push({ item: i.name, reason: chosen.slowCut && i.side === slow ? 'the time budget (the slow side)' : 'the time budget' });
    const items = all.filter(i => chosen.items.includes(i));
    const sac = sacOf(items);
    const keep = Object.fromEntries(items.map(i => [i.name, reps[i.name]]));
    // everything a session's numbers depend on: the protocol, the bundles' bytes, the config, the placement watch
    const pcore = o.pcoreMode ?? 'off';
    const key = keyOf({ protocol: PROTOCOL, bundles: b.bundlesKey, cfg: cfg.measureKey, pcore, size, shape: z.shape, items: items.map(i => i.name), reps: keep, rounds: chosen.rounds, sac });
    const sessionEst = sessionMs(items, chosen.rounds);

    return { key, bundlesKey: b.bundlesKey, measureKey: cfg.measureKey, pcore, shape: z.shape, sessions: chosen.sessions, rounds: chosen.rounds, items: items.map(i => i.name), reps: keep, sac, dropped, estSessionMs: Math.round(sessionEst), estMs: Math.round(chosen.ms), budgetMs, over, wanted: want };
};

const planText = (size, p) =>
    `plan ${size}: ${p.sessions} sessions × ${p.rounds} rounds · ${p.items.join(' ')}${Object.values(p.reps).some(r => r > 1) ? ` · reps ${Object.entries(p.reps).map(([n, r]) => `${n} ${r}`).join(', ')}` : ''} · est ${dur(p.estMs, true)} of ${dur(p.budgetMs, true)}${p.over ? ' (OVER the budget even at the smallest plan)' : ''}${p.dropped.length ? ` · without ${p.dropped.map(d => `${d.item} (${d.reason})`).join(', ')}` : ''}`;

const sessionFile = (dir, id) => path.join(dir, 'sessions', `${id}.json`);
const sessionsOf = plan =>
    Object.entries(plan.sizes).flatMap(([size, p]) => Array.from({ length: p.sessions }, (_, k) => ({ id: `${size}-${k + 1}`, size, n: k + 1, first: k % 2 ? 'B' : 'A', estMs: p.estSessionMs })));
const isDone = (dir, s, plan) => tryJson(sessionFile(dir, s.id))?.planKey === plan.sizes[s.size].key;

/** Wait for PCORE_NEED performance cores >= 90 % idle (pcore.mjs's machine gate). */
const pcoreGate = async o => {
    if (o.pcore === 'off') return { reason: '--pcore=off' };
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return { reason: `${process.platform}/${process.arch}: core types are told apart on macOS arm64 only` };
    try {
        const { Pcore, helper } = await import('./pcore.mjs');
        const pcore = new Pcore({ mode: 'auto', role: 'timing', target: 'fnbench', need: PCORE_NEED, maxWaitMs: PCORE_WAIT_MS, maxEcoreMs: 15, maxEcorePct: 2, retries: 5, root: process.pid, log });
        if (!(await pcore.init())) return { reason: pcore.meta.reason };

        return { pcore, bin: helper(), total: pcore.machine.pIndices?.length ?? null };
    } catch (e) {
        return { reason: e.message };
    }
};
const waitForCores = async gate => {
    if (!gate.pcore?.sampler) return null;
    const t0 = Date.now();
    let said = t0;
    for (;;) {
        const free = gate.pcore.freeCores();
        if (free !== null && free >= PCORE_NEED) return { free, waitMs: Date.now() - t0 };
        if (Date.now() - t0 > PCORE_WAIT_MS) throw new Error(`performance cores busy for ${dur(PCORE_WAIT_MS)} (${free} of ${gate.total} free, ${PCORE_NEED} needed): run again later, or --pcore=off (the numbers are then not comparable)`);
        if (Date.now() - said >= HEARTBEAT_MS) {
            said = Date.now();
            log(`   waiting for performance cores: ${free ?? '?'} of ${gate.total} free, ${PCORE_NEED} needed, for ${dur(Date.now() - t0)}`);
        }
        await sleep(250);
    }
};

const waitForPower = async (id, status) => {
    let p = powerState();
    if (p.ok) return p;
    const t0 = Date.now();
    let next = t0;
    while (!p.ok) {
        status.update({ current: { id, stage: 'power-wait', power: p.text, since: new Date(t0).toISOString() } });
        if (Date.now() >= next) {
            const waited = Date.now() - t0;
            log(`   power-wait before ${id}: ${p.text} — sessions need AC power without Low Power Mode · ${dur(waited)}${waited >= POWER_ASK_MS ? ' — over 10 min: ask the user to plug in' : ''}`);
            next = Date.now() + HEARTBEAT_MS;
        }
        await sleep(POWER_POLL_MS);
        p = powerState();
    }
    log(`   ${p.text} after ${dur(Date.now() - t0)} of power-wait — ${id} starts`);

    return p;
};

const ratioText = (num, den, res) => {
    const a = res.medians[num];
    const b = res.medians[den];

    return a && b ? `${num}/${den} ${fmtX(a.cpu / b.cpu)}` : null;
};
const sessionText = (cfg, res) => {
    const m = res.medians;
    const parts = Object.entries(m).filter(([n]) => cfg.variants[n]).map(([n, v]) => `${n} ${fmtMs(v.cpu)}`);
    const ratios = [ratioText(cfg.pureA, cfg.pureB, res), cfg.controls.aa && ratioText(`${cfg.controls.aa}2`, cfg.controls.aa, res), cfg.controls.twice && ratioText(`${cfg.controls.twice}2x`, cfg.controls.twice, res)].filter(Boolean);

    return `cpu ${parts.join(' · ')} · ${ratios.join(' · ')}${res.placement.eSharePct !== null ? ` · E ${res.placement.eSharePct} %${res.placement.retried ? ` (${blocks(res.placement.retried)} again)` : ''}` : ''}`;
};

const runSessions = async (cfg, b, dir, plan, o, slot, status, gate) => {
    const all = sessionsOf(plan);
    const todo = all.filter(s => !isDone(dir, s, plan));
    if (!todo.length) {
        log(`run: all ${all.length} sessions done`);

        return;
    }
    let estDone = 0;
    let msDone = 0;
    const left = from => ({ ms: (msDone && estDone ? msDone / estDone : 1) * todo.slice(from).reduce((a, s) => a + s.estMs, 0), rough: !msDone });
    const eta = from => {
        const l = left(from);

        return `ETA ${l.rough ? '~' : ''}${dur(l.ms, true)} ≈ ${clock(Date.now() + l.ms)}`;
    };
    log(`run: ${todo.length} of ${all.length} sessions to go${all.length > todo.length ? ` (${all.length - todo.length} done)` : ''} · ${eta(0)}`);
    status.update({ phase: 'run', total: all.length, done: all.length - todo.length });
    try {
        for (const [k, s] of todo.entries()) {
            const p = plan.sizes[s.size];
            // not holding the machine slot while waiting for power
            const power = await waitForPower(s.id, status);
            const h = await slot(s.id, 'timing');
            try {
                const w = await waitForCores(gate);
                log(`== [${all.indexOf(s) + 1}/${all.length}] ${s.id} · first ${s.first} · est ${dur(s.estMs)} · load ${loadavg()[0]}${w ? ` · ${w.free} of ${gate.total} P free${w.waitMs >= 1000 ? ` after ${dur(w.waitMs)}` : ''}` : ''}`);
                const id = s.id;
                const spec = {
                    mode: 'session',
                    id,
                    planKey: p.key,
                    config: cfg.file,
                    size: s.size,
                    shape: p.shape,
                    n: s.n,
                    first: s.first,
                    bundles: bundlePaths(b, dir),
                    sac: p.sac,
                    ref: cfg.ref,
                    items: itemsOf(cfg).filter(i => p.items.includes(i.name)),
                    order: forwardOrder(itemsOf(cfg).filter(i => p.items.includes(i.name)), s.first),
                    reps: p.reps,
                    rounds: p.rounds,
                    fresh: cfg.inputs === 'fresh',
                    inputs: cfg.inputs,
                    measureKey: cfg.measureKey,
                    gc: !!cfg.gc,
                    warmupMs: cfg.warmupMs,
                    warmupCalls: cfg.warmupCalls,
                    cacheDir: path.join(dir, 'cache'),
                    pcore: gate.bin ? { bin: gate.bin, ms: E_MS, pct: E_PCT, retries: E_RETRIES } : null,
                    power,
                    out: sessionFile(dir, id),
                    specFile: path.join(dir, 'specs', `${id}.json`),
                };
                const started = Date.now();
                let stageText = 'starting';
                const current = { id, size: s.size, startedAt: new Date(started).toISOString(), estMs: s.estMs, stage: stageText };
                status.update({ current });
                const beat = setInterval(() => log(`   ${id} ${stageText} · ${dur(Date.now() - started)} of ~${dur(s.estMs)} · ${eta(k)}`), HEARTBEAT_MS);
                let res;
                try {
                    res = await runChild(cfg, spec, {
                        timeoutMs: Math.max(600000, 4 * s.estMs),
                        onEvent: ev => {
                            if (ev.ev !== 'stage') return;
                            stageText = ev.stage === 'round' ? `round ${ev.i}/${ev.n}` : ev.stage;
                            status.update({ current: { ...current, stage: stageText } });
                        },
                    });
                } finally {
                    clearInterval(beat);
                }
                msDone += Date.now() - started;
                estDone += s.estMs;
                status.update({ done: all.length - todo.length + k + 1, current: null, etaMs: Math.round(left(k + 1).ms) });
                log(`   ${id} done in ${dur(Date.now() - started)} · ${sessionText(cfg, res)} · ${k + 1}/${todo.length} · ${eta(k + 1)}`);
            } finally {
                h.release();
            }
        }
    } finally {
        gate.pcore?.close();
    }
};

// ------------------------------------------------------------------ aggregate
const band = (r, ok, look) => (!Number.isFinite(r) ? null : r >= ok[0] && r <= ok[1] ? 'ok' : r >= look[0] && r <= look[1] ? 'look' : 'off');
const verdictOf = (d, nA, nB) => (called(d) ? 'called' : minP(nA, nB) > CALL_P ? 'underpowered' : d.p !== null && d.p <= BORDER_P ? 'borderline' : 'settled');

/**
 * Exact sign-flip test on per-session log ratios, two-sided on |mean| — the paired view of a
 * comparison (both sides ran in every session). It cannot go below 2 / 2^n: 0.125 for 4 sessions,
 * 0.031 for 6, 0.0078 for 8.
 */
const signFlipP = ratios => {
    const logs = ratios.filter(r => r > 0 && Number.isFinite(r)).map(Math.log);
    const n = logs.length;
    if (n < 2 || n > 20) return null;
    const obs = Math.abs(logs.reduce((a, x) => a + x, 0));
    let extreme = 0;
    for (let mask = 0; mask < 2 ** n; mask++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += mask & (1 << i) ? -logs[i] : logs[i];
        if (Math.abs(s) >= obs - 1e-12) extreme++;
    }

    return +(extreme / 2 ** n).toFixed(4);
};
/**
 * One comparison over the sessions, both metrics. Both sides ran in every session, so the effect
 * is paired: the ratio num/den is the median of the per-session ratios (with their range), and Δ%
 * is the paired change from `from` to `to`. Separation and the permutation p (the verdict) are the
 * rig's, over the two sides' session medians; pairedP is the sign-flip test next to them.
 */
const compare = (ss, num, den, kind, from, to) => {
    const out = { label: `${num}/${den}`, num, den, kind, from, to };
    for (const m of ['cpu', 'wall']) {
        const f = ss.map(s => s.medians[from][m]);
        const t = ss.map(s => s.medians[to][m]);
        const ratios = ss.map(s => s.medians[num][m] / s.medians[den][m]);
        const changes = ss.map(s => s.medians[to][m] / s.medians[from][m]);
        const d = {
            ratio: sig(median(ratios), 4),
            sessions: ratios.map(r => sig(r, 4)),
            range: rangeOf(ratios).map(r => sig(r, 4)),
            ratioOfMedians: sig(median(ss.map(s => s.medians[num][m])) / median(ss.map(s => s.medians[den][m])), 4),
            deltaPct: +((median(changes) - 1) * 100).toFixed(1),
            separated: null,
            p: permutationP(f, t),
            pairedP: signFlipP(changes),
        };
        const sep = separated(f, t);
        d.separated = sep === 'B lower' ? `${to} lower` : sep === 'B higher' ? `${to} higher` : sep;
        d.verdict = verdictOf({ separated: sep, p: d.p }, f.length, t.length);
        if (kind === 'aa') d.control = band(d.ratio, AA_OK, AA_LOOK);
        if (kind === 'twice') d.control = band(d.ratio, TWICE_OK, TWICE_LOOK);
        out[m] = d;
    }

    return out;
};

const fitModel = (cfg, sizes) => {
    const m = cfg.model;
    if (!m) return null;
    const v = m.variant ?? cfg.pureA;
    const metric = cfg.metric;
    const fit = m.fit ?? [Object.keys(cfg.sizes)[0]];
    const pts = fit.filter(s => sizes[s]?.items[v]).map(s => [m.cost(cfg.sizes[s].shape), sizes[s].items[v][metric].median]);
    const model = { variant: v, metric, fit, cost: m.cost.toString(), k: null, sizes: {} };
    if (!pts.length) return { ...model, error: `${v} was not measured on ${fit.join(', ')}` };
    model.k = pts.reduce((a, [c, t]) => a + c * t, 0) / pts.reduce((a, [c]) => a + c * c, 0);
    for (const s of Object.keys(cfg.sizes)) {
        const predicted = model.k * m.cost(cfg.sizes[s].shape);
        const measured = sizes[s]?.items[v]?.[metric].median ?? null;
        const ref = sizes[s]?.items[cfg.ref]?.[metric].median ?? null;
        model.sizes[s] = { predicted: sig(predicted, 4), measured, errorPct: measured ? pct(measured, predicted) : null, fit: fit.includes(s), ratio: measured === null && ref ? sig(predicted / ref, 4) : null };
    }

    return model;
};

const aggregate = (cfg, b, dir, plan, notes = []) => {
    const sizes = {};
    const warnings = [...b.warnings, ...notes];
    const loads = [];
    const powers = new Map();
    let node = null;
    for (const [size, p] of Object.entries(plan.sizes)) {
        let ss = sessionsOf({ sizes: { [size]: p } })
            .map(s => tryJson(sessionFile(dir, s.id)))
            .filter(s => s && s.planKey === p.key);
        if (!ss.length) continue;
        // never pooled across power sources, as aggregate.mjs: the AC sessions, else the most
        const keys = ss.map(s => powerKey(s.power) ?? 'unknown');
        if (new Set(keys).size > 1) {
            const count = k => keys.filter(x => x === k).length;
            const keep = keys.includes('ac') ? 'ac' : [...new Set(keys)].toSorted((x, y) => count(y) - count(x))[0];
            warnings.push(`${size}: sessions on ${[...new Set(keys)].join(' and ')} power are not pooled: ${count(keep)} on ${keep} kept, ${keys.length - count(keep)} left out`);
            ss = ss.filter((_, i) => keys[i] === keep);
        }
        for (const s of ss) powers.set(s.power?.text ?? 'power source unknown', s.power?.ok ?? null);
        node = ss[0].node;
        for (const s of ss) loads.push(...s.load.map(l => l[0]));
        const items = {};
        for (const name of p.items) {
            items[name] = {};
            for (const m of ['cpu', 'wall']) {
                const v = ss.map(s => s.medians[name][m]);
                items[name][m] = { median: sig(median(v)), range: rangeOf(v).map(x => sig(x)), sessions: v.map(x => sig(x)) };
            }
            items[name].gcMs = sig(median(ss.map(s => s.medians[name].gc)), 4);
            // the GC an item's allocations cause, averaged over all its blocks: a median of short blocks skips
            // pauses that land in fewer than half of them (the 2x block of the same code then reads over 2)
            const blocksOf = ss.flatMap(s => s.samples[name]);
            items[name].gcMeanMs = sig(blocksOf.reduce((a, x) => a + x.gc, 0) / blocksOf.length, 4);
            items[name].gcBlockPct = Math.round((100 * blocksOf.filter(x => x.gc > 0).length) / blocksOf.length);
            items[name].wallPerCpu = sig(median(ss.map(s => s.medians[name].wall / s.medians[name].cpu)), 4);
            // pauses in some blocks only: the median counts them when they land in over half, else skips them
            if (items[name].gcBlockPct > 0 && items[name].gcBlockPct < 90 && items[name].gcMeanMs > 0.02 * items[name].cpu.median) warnings.push(`${size} ${name}: GC pauses worth ${pct(items[name].cpu.median, items[name].cpu.median + items[name].gcMeanMs)} % of a call land in ${items[name].gcBlockPct} % of its blocks, which its median ${items[name].gcBlockPct > 50 ? 'counts' : 'skips'}: raise minBlockMs so a block holds several GC cycles`);
        }
        const has = n => p.items.includes(n);
        const comparisons = [];
        if (has(cfg.pureA) && has(cfg.pureB)) comparisons.push(compare(ss, cfg.pureA, cfg.pureB, 'main', cfg.pureA, cfg.pureB));
        for (const [n, v] of Object.entries(cfg.variants)) {
            const base = v.base === 'A' ? cfg.pureA : v.base === 'B' ? cfg.pureB : null;
            if (sideOf(v) === 'H' && has(n) && base && has(base)) comparisons.push(compare(ss, n, base, 'hybrid', base, n));
        }
        const aa = cfg.controls.aa && `${cfg.controls.aa}2`;
        const twice = cfg.controls.twice && `${cfg.controls.twice}2x`;
        if (aa && has(aa) && has(cfg.controls.aa)) comparisons.push(compare(ss, aa, cfg.controls.aa, 'aa', cfg.controls.aa, aa));
        if (twice && has(twice) && has(cfg.controls.twice)) comparisons.push(compare(ss, twice, cfg.controls.twice, 'twice', cfg.controls.twice, twice));
        const e = ss.map(s => s.placement.eSharePct).filter(x => x !== null);
        sizes[size] = {
            shape: p.shape,
            describe: ss[0].check.describe,
            sessions: ss.length,
            planned: p.sessions,
            rounds: p.rounds,
            reps: p.reps,
            items,
            dropped: p.dropped,
            input: ss[0].check.input,
            async: ss[0].async,
            isolated: Object.values(ss[0].isolated).every(Boolean),
            comparisons,
            placement: { eSharePct: e, max: e.length ? Math.max(...e) : null, retried: ss.reduce((a, s) => a + s.placement.retried, 0), offP: ss.reduce((a, s) => a + s.placement.offP, 0), errors: [...new Set(ss.map(s => s.placement.error).filter(x => x && x !== 'off'))] },
        };
        if (ss.length < p.sessions) warnings.push(`${size}: ${ss.length} of ${p.sessions} sessions done`);
        if (!sizes[size].isolated) warnings.push(`${size}: the config's call needs its module scope, so the items share its call-site feedback (references/fnbench.md)`);
    }
    const model = fitModel(cfg, sizes);
    // the controls over all sizes
    const controls = { aa: [], twice: [], wallPerCpu: [], placement: [] };
    for (const [size, z] of Object.entries(sizes)) {
        for (const c of z.comparisons) {
            if (c.kind === 'aa' || c.kind === 'twice') {
                const d = c[cfg.metric];
                controls[c.kind].push({ size, ratio: d.ratio, range: d.range, control: d.control, verdict: d.verdict });
                if (d.control !== 'ok') warnings.push(`${size}: the ${c.kind === 'aa' ? 'A/A' : '2x'} control reads ${fmtX(d.ratio)} [${d.range.map(fmtX).join('–')}] (${d.control}): see "Reading the controls" in references/fnbench.md`);
                if (c.kind === 'aa' && d.verdict === 'called') warnings.push(`${size}: the A/A copy separates from ${c.den} (p ${d.p}): differences that small are not real`);
            }
        }
        for (const [n, it] of Object.entries(z.items)) {
            controls.wallPerCpu.push({ size, item: n, ratio: it.wallPerCpu });
            if (it.wallPerCpu > WALL_CPU_LOOK) warnings.push(`${size} ${n}: wall is ${fmtX(it.wallPerCpu)}x the thread CPU — the process was descheduled (a loaded machine) or waits for other threads; trust the CPU numbers`);
        }
        controls.placement.push({ size, max: z.placement.max, retried: z.placement.retried, offP: z.placement.offP });
        if (z.placement.offP) warnings.push(`${size}: ${blocks(z.placement.offP)} stayed on efficiency cores after ${E_RETRIES} tries`);
        for (const err of z.placement.errors) warnings.push(`${size}: placement watch failed: ${err}`);
    }
    const power = [...powers.keys()];
    for (const [text, ok] of powers) if (ok === false) warnings.push(`sessions ran on ${text}: not comparable with AC-power runs`);
    const summary = {
        tool: 'fnbench',
        name: cfg.name,
        config: cfg.file,
        generated: new Date().toISOString(),
        repo: { path: b.repo, head: b.head },
        revs: b.revs,
        node,
        esbuild: b.esbuild,
        metric: cfg.metric,
        power,
        load: loads.length ? [Math.min(...loads), Math.max(...loads)] : null,
        variants: Object.fromEntries(Object.entries(b.variants).map(([n, v]) => [n, { base: v.base, files: v.files, side: v.side, sha256: v.sha256, modules: v.modules }])),
        changed: b.changed,
        controls: { ...cfg.controls, ...controls },
        sizes,
        model,
        callP: CALL_P,
        warnings,
    };
    writeJson(path.join(dir, 'summary.json'), summary);
    const lines = table(cfg, summary);
    fs.writeFileSync(path.join(dir, 'table.txt'), `${lines.join('\n')}\n`);
    for (const l of lines) console.log(l);
    console.log(`summary: ${path.join(dir, 'summary.json')} · table: ${path.join(dir, 'table.txt')}`);

    return summary;
};

const pad = rows => {
    const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i] ?? '').length)));

    return rows.map(r => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd());
};

/** The compact text table: one row per size, then shapes, the other metric, the model, controls and warnings. */
const table = (cfg, s) => {
    const A = cfg.pureA;
    const B = cfg.pureB;
    const m = s.metric;
    const other = m === 'cpu' ? 'wall' : 'cpu';
    const name = { cpu: 'thread CPU', wall: 'wall time' };
    const L = [];
    L.push(`fnbench ${s.name} · ${A} ${s.revs.A.rev} → ${B} ${s.revs.B.rev} (${s.revs.B.subject})`);
    L.push(`per call, median of session medians [session range] · ${name[m]} (${name[other]} below) · node ${s.node} · ${s.power.join(', ')} · load ${s.load ? s.load.join('–') : '–'}`);
    L.push('');
    const cmp = (z, kind, label) => z.comparisons.find(c => c.kind === kind && (!label || c.label === label));
    const hybrids = Object.keys(cfg.variants).filter(n => sideOf(cfg.variants[n]) === 'H');
    const aa = cfg.controls.aa && `${cfg.controls.aa}2/${cfg.controls.aa}`;
    const twice = cfg.controls.twice && `${cfg.controls.twice}2x/${cfg.controls.twice}`;
    const hyLabel = h => `${h}/${cfg.variants[h].base === 'A' ? A : B}`;
    const rows = [['size', 'n×r', A, B, `${A}/${B}`, 'Δ', 'sep', 'p', 'verdict', ...(aa ? [aa] : []), ...(twice ? [twice] : []), ...hybrids.map(hyLabel), 'E%']];
    for (const [size, z] of Object.entries(s.sizes)) {
        const main = cmp(z, 'main')?.[m];
        const model = s.model?.sizes[size];
        const ctl = (c, digits) => (c ? `${fmtX(c[m].ratio)}${digits && c[m].control && c[m].control !== 'ok' ? ` (${c[m].control})` : ''}` : '–');
        rows.push([
            size,
            `${z.sessions}×${z.rounds}`,
            z.items[A] ? fmtMed(z.items[A][m].median, z.items[A][m].range) : model && s.model.variant === A ? `~${fmtMs(model.predicted)} (model)` : '–',
            z.items[B] ? fmtMed(z.items[B][m].median, z.items[B][m].range) : '–',
            main ? `${fmtX(main.ratio)} [${main.range.map(fmtX).join('–')}]` : model?.ratio ? `~${fmtX(model.ratio)} (model)` : '–',
            main ? `${main.deltaPct > 0 ? '+' : ''}${main.deltaPct}%` : '–',
            main ? main.separated : '–',
            main?.p ?? '–',
            main?.verdict ?? '–',
            ...(aa ? [ctl(cmp(z, 'aa'), true)] : []),
            ...(twice ? [ctl(cmp(z, 'twice'), true)] : []),
            ...hybrids.map(h => ctl(cmp(z, 'hybrid', hyLabel(h)))),
            z.placement.max ?? '–',
        ]);
    }
    L.push(...pad(rows));
    L.push('');
    for (const [size, z] of Object.entries(s.sizes)) {
        const shape = Object.entries(z.shape).map(([k, v]) => `${k}=${v}`).join(' ');
        const desc = z.describe ? ` · ${Object.entries(z.describe).map(([k, v]) => `${k} ${v}`).join(', ')}` : '';
        const reps = Object.values(z.reps).some(r => r > 1) ? ` · reps ${Object.entries(z.reps).map(([n, r]) => `${n} ${r}`).join(', ')}` : '';
        const dropped = z.dropped.length ? ` · not run: ${z.dropped.map(d => `${d.item} (${d.reason})`).join(', ')}` : '';
        L.push(`${size}: ${[shape, ...[desc, reps].map(x => x.slice(3)), `input ${z.input}`, dropped.slice(3)].filter(Boolean).join(' · ')}`);
        const parts = z.comparisons.map(c => `${c.label} ${fmtX(c[other].ratio)} [${c[other].range.map(fmtX).join('–')}]${c.kind === 'main' || c.kind === 'hybrid' ? ` p ${c[other].p ?? '–'} ${c[other].verdict}` : ''}`);
        const gc = Object.entries(z.items).filter(([, it]) => it.gcMeanMs > 0).map(([n, it]) => `${n} ${fmtMs(it.gcMeanMs)} (${it.gcBlockPct} %)`);
        L.push(`    ${other}: ${parts.join(' · ')} · ${other === 'wall' ? 'wall/cpu' : 'cpu/wall'} ≤ ${fmtX(Math.max(...Object.values(z.items).map(it => it.wallPerCpu)))}${gc.length ? ` · GC pauses per call, mean (share of blocks with one): ${gc.join(', ')}` : ''}`);
        const paired = z.comparisons.filter(c => c.kind !== 'twice').map(c => `${c.label} ${c[m].pairedP ?? '–'}`);
        if (paired.length) L.push(`    paired p (sign-flip on per-session ratios, ${m}): ${paired.join(' · ')}`);
    }
    if (s.model) {
        L.push('');
        if (s.model.error) L.push(`model: ${s.model.error}`);
        else {
            const per = Object.entries(s.model.sizes).filter(([, x]) => !x.fit).map(([size, x]) => (x.measured !== null ? `${size} predicted ${fmtMs(x.predicted)}, measured ${fmtMs(x.measured)} (${x.errorPct > 0 ? '+' : ''}${x.errorPct}%)` : `${size} predicted ${fmtMs(x.predicted)}${x.ratio ? ` → ${A}/${B} ~${fmtX(x.ratio)}` : ''} (not run)`));
            L.push(`model: ${s.model.variant} ≈ k · cost(shape), cost = ${s.model.cost.replace(/\s+/g, ' ')}, fitted on ${s.model.fit.join(', ')}`);
            L.push(`    ${per.join(' · ')}`);
        }
    }
    L.push('');
    const ctl = list => list.map(c => `${c.size} ${fmtX(c.ratio)}${c.control !== 'ok' ? ` (${c.control})` : ''}`).join(', ');
    const e = s.controls.placement.filter(p => p.max !== null);
    L.push(`controls: A/A ${s.controls.aa.length ? ctl(s.controls.aa) : '–'} · 2x ${s.controls.twice.length ? ctl(s.controls.twice) : '–'} · wall/cpu ≤ ${fmtX(Math.max(...s.controls.wallPerCpu.map(c => c.ratio)))} · E share ${e.length ? `≤ ${Math.max(...e.map(p => p.max))} % (main thread, lower bound), ${blocks(e.reduce((a, p) => a + p.retried, 0))} run again` : 'not watched'}`);
    for (const w of s.warnings) L.push(`warning: ${w}`);

    return L;
};

// ------------------------------------------------------------------ main
const main = async () => {
    const args = parseArgs();
    if (args.child) return child(String(args.child));
    const cfg = await loadConfig(args.config);
    if (args.inputs !== undefined) {
        if (!['settled', 'fresh'].includes(args.inputs)) throw new Error("--inputs=settled|fresh");
        cfg.inputs = args.inputs;
    }
    cfg.buildKey = buildKeyOf(cfg);
    cfg.measureKey = measureKeyOf(cfg);
    // esbuild hands plugins real paths: a symlinked checkout would match no repo path
    const repo = fs.realpathSync(repoRoot(args.repo ?? cfg.repo));
    const run = runDir(String(args.run ?? cfg.name));
    const dir = path.join(run, 'fnbench');
    const only = args.dry ? ['build', 'plan'] : list(args.only);
    const phase = p => !only.length || only.includes(p);
    const sizes = list(args.sizes).length ? list(args.sizes) : Object.keys(cfg.sizes);
    for (const s of sizes) if (!cfg.sizes[s]) throw new Error(`--sizes: the config has no size ${s} (${Object.keys(cfg.sizes).join(', ')})`);
    const o = { budget: args.budget, sessions: args.sessions, rounds: args.rounds, pcore: args.pcore };
    if (args.fresh) for (const f of ['sessions', 'specs', 'calibration.json', 'plan.json', 'summary.json', 'table.txt']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    const statusFile = path.join(dir, 'status.json');
    const state = { state: 'running', pid: process.pid, startedAt: new Date().toISOString() };
    const status = { update: o2 => writeJsonSafe(statusFile, Object.assign(state, o2, { updatedAt: new Date().toISOString() })) };
    const stop = (signal, code) => {
        if (running) running.kill('SIGKILL');
        status.update({ state: 'interrupted', signal });
        log(`fnbench interrupted by ${signal} — run the same command again to resume`);
        process.exit(code);
    };
    process.once('SIGINT', () => stop('SIGINT', 130));
    process.once('SIGTERM', () => stop('SIGTERM', 143));
    const locks = await import('./locks.mjs');
    const slotIsOff = locks.slotOff(args.slot);
    const slot = async (label, role) => {
        if (slotIsOff) return { release() {} };
        let said = 0;

        return locks.acquire('machine', { kind: 'session', run: path.basename(run), label: `fnbench ${label}`, role }, {
            onWait: w => {
                if (Date.now() - said < HEARTBEAT_MS) return;
                said = Date.now();
                log(`   ${label}: waiting for the machine slot, held by ${locks.holderText(w.holder)} (${w.ahead} ahead)`);
            },
        });
    };
    log(`fnbench ${cfg.name} · ${cfg.pureA} ${cfg.revs.A} → ${cfg.pureB} ${cfg.revs.B} · ${dir}${slotIsOff ? ' · machine slot OFF: not comparable' : ''}`);
    const power = powerState();
    if (!power.ok) log(`warning: ${power.text} — timings on battery or in Low Power Mode are not comparable`);

    status.update({ phase: 'build' });
    let b = tryJson(path.join(dir, 'build.json'));
    if (phase('build') || !b) b = await build(cfg, repo, dir, { rebuild: !!args.rebuild, slot });
    b.bundlesKey ??= keyOf(Object.fromEntries(Object.entries(b.variants).map(([n, v]) => [n, v.sha256])));
    let plan = tryJson(path.join(dir, 'plan.json'));
    // the performance-core gate as it really is (on only when it works): part of the plan's keys
    const gate = phase('plan') || phase('run') ? await pcoreGate(o) : null;
    if (gate && !gate.pcore) log(`pcore: off — ${gate.reason}`);
    const pcoreMode = gate?.pcore ? 'on' : 'off';
    o.pcoreMode = pcoreMode;
    // a size planned for other bundles or another config (an older plan.json, another --sizes) is stale
    const isCurrent = p => p.bundlesKey === b.bundlesKey && p.measureKey === cfg.measureKey;
    if (phase('plan')) {
        status.update({ phase: 'calibrate' });
        const cal = await calibrate(cfg, b, dir, sizes, o, slot);
        const planned = Object.fromEntries(sizes.map(size => [size, planSize(cfg, b, cal[size], size, o)]));
        // sizes planned before (another --sizes) stay, in config order
        const keep = plan?.sizes ?? {};
        plan = { at: new Date().toISOString(), sizes: Object.fromEntries(Object.keys(cfg.sizes).filter(s => planned[s] || keep[s]).map(s => [s, planned[s] ?? keep[s]])) };
        writeJson(path.join(dir, 'plan.json'), plan);
        for (const size of sizes) log(planText(size, plan.sizes[size]));
        const est = sizes.reduce((a, size) => a + plan.sizes[size].estMs, 0);
        log(`plan: ${sizes.reduce((a, size) => a + plan.sizes[size].sessions, 0)} sessions, est ${dur(est, true)} ≈ ${clock(Date.now() + est)}`);
    }
    if (args.dry) {
        gate?.pcore?.close();
        status.update({ state: 'finished', phase: 'dry' });

        return;
    }
    if (phase('run')) {
        if (!plan) throw new Error(`no plan.json in ${dir}: run with --only=build,plan first (or without --only)`);
        const missing = sizes.filter(s => !plan.sizes[s]);
        if (missing.length) throw new Error(`plan.json has no plan for ${missing.join(', ')}: run the plan phase for them`);
        const stale = sizes.filter(s => !isCurrent(plan.sizes[s]) || plan.sizes[s].pcore !== pcoreMode);
        if (stale.length) throw new Error(`plan.json is stale for ${stale.join(', ')} (other bundles, config or --pcore): run the plan phase again (drop --only)`);
        const runPlan = { ...plan, sizes: Object.fromEntries(Object.entries(plan.sizes).filter(([s]) => sizes.includes(s))) };
        await runSessions(cfg, b, dir, runPlan, o, slot, status, gate);
    }
    gate?.pcore?.close();
    if (phase('aggregate')) {
        if (!plan) throw new Error(`no plan.json in ${dir}`);
        status.update({ phase: 'aggregate' });
        const stale = Object.keys(plan.sizes).filter(s => !isCurrent(plan.sizes[s]));
        const notes = stale.map(s => `${s} is left out: planned for other bundles or another config (run --sizes=${s} again)`);
        aggregate(cfg, b, dir, { ...plan, sizes: Object.fromEntries(Object.entries(plan.sizes).filter(([s]) => !stale.includes(s))) }, notes);
    }
    status.update({ state: 'finished', current: null });
};

main().catch(e => {
    // a child's stack goes to the parent, which keeps its first frame
    console.error(process.argv.some(a => a.startsWith('--child=')) ? e.stack : `fnbench: ${e.message}`);
    process.exit(1);
});
