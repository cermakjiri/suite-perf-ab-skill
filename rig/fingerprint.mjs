/**
 * What a build is, read from its own bundles — no marker to choose:
 *
 *   commit    the 40-hex revision inlined at build time. Every Suite bundle carries it twice:
 *             process.env.COMMITHASH (getCommitHash) and inside the release string
 *             process.env.SENTRY_RELEASE = <version>.<web|desktop>[.codesign].<sha>, both from
 *             `git rev-parse HEAD` in the tree that was built (packages/suite/webpack/createBaseConfig.ts,
 *             suite/desktop-app-main/webpack/core.webpack.config.ts). Local builds, CI previews and
 *             releases alike — the Sentry plugin is not needed for it.
 *   release   { version, suiteType, codesign } from that string: codesign = IS_CODESIGN_BUILD was on
 *             (the rig's release profile).
 *   compiler  React Compiler output: occurrences of `react.memo_cache_sentinel` — the compiler emits one
 *             per memo block, React itself defines it once — mapped through the source maps to the
 *             files and source areas that were compiled, next to the REACT_COMPILER_PATHS the
 *             revision configures (packages/suite/webpack/reactCompiler.ts; absent = not wired up).
 *   coverage  .js files carrying Istanbul's __coverage__ (must be 0).
 *
 *   node fingerprint.mjs --run=<name|dir> [--sides=A,B] [--target=web|desktop] [--json]
 *   node fingerprint.mjs <web build dir | desktop app dir> [--target=web|desktop] [--expect=<sha>] [--rev=<sha>] [--json]
 *
 * build.mjs fingerprints every target it builds (and refuses a bundle whose commit is not the clone's
 * HEAD); preflight.mjs, aggregate.mjs and report.mjs read the result from run.json. Runs in the sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, loadRun, sideOf, repoRoot, importFromRepo, git, exists, log } from './lib.mjs';

export const SENTINEL = 'react.memo_cache_sentinel';
// bumped when what a fingerprint holds or how it is read changes: build.mjs refreshes older ones of cached builds
export const FP_VERSION = 2;
const COVERAGE = '__coverage__';
// <version>.<web|desktop>[.codesign].<sha>: the release string DefinePlugin inlines in every build
const RELEASE = /(\d+\.\d+\.\d+)\.(web|desktop)(\.codesign)?\.([0-9a-f]{40})(?![0-9a-f])/g;

/** The bundle parts a target's fingerprint scans: [{ part, dir }]. `dir` is side.web or side.desktop. */
export const partsOf = (target, dir) => (target === 'desktop'
    ? [{ part: 'renderer', dir: path.join(dir, 'build', 'js') }, { part: 'main', dir: path.join(dir, 'dist') }]
    : [{ part: 'app', dir: path.join(dir, 'js') }]);

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

    return out.sort();
};
const occurrences = (text, needle) => {
    const at = [];
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) at.push(i);

    return at;
};

/** One part's files: commits from the release strings, the expected sha's hits, sentinels, coverage. */
const scanPart = (files, expect) => {
    const releases = new Map();
    const sentinels = [];
    let bytes = 0;
    let expectHits = 0;
    let coverageFiles = 0;
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        bytes += Buffer.byteLength(text);
        if (expect) expectHits += occurrences(text, expect).length;
        for (const m of text.matchAll(RELEASE)) {
            const key = m[0];
            const r = releases.get(key) || { version: m[1], suiteType: m[2], codesign: !!m[3], commit: m[4], n: 0 };
            r.n += 1;
            releases.set(key, r);
        }
        const at = occurrences(text, SENTINEL);
        if (at.length) sentinels.push({ file, at });
        if (text.includes(COVERAGE)) coverageFiles += 1;
    }

    return { files: files.length, bytes, expectHits, releases: [...releases.values()].sort((a, b) => b.n - a.n), sentinels, coverageFiles };
};

// ------------------------------------------------------------------ source areas
/**
 * A source-map source as a repo path. webpack writes them as `webpack://<namespace>/<path>` with the
 * namespace the app's package (`@suite/web-app`), sometimes as is and sometimes normalized:
 *   webpack://@suite/web-app/../packages/suite/src/views/x.tsx  -> packages/suite/src/views/x.tsx
 *   webpack://@suite/packages/suite/src/views/x.tsx             -> packages/suite/src/views/x.tsx
 *   webpack://@suite/web-app/../app-assets/files/guide/a.md     -> suite/app-assets/files/guide/a.md
 *   webpack://@suite/web-app/src/index.ts                       -> suite/web-app/src/index.ts
 *   anything under node_modules                                 -> npm:<package>/...
 */
export const sourcePath = src => {
    const s = String(src).replace(/^webpack:\/\//, '').split('?')[0];
    const nm = s.lastIndexOf('node_modules/');
    if (nm >= 0) return `npm:${s.slice(nm + 13)}`;
    // the repo's top-level source directories are recognisable wherever they appear
    const root = s.match(/(?:^|\/)((?:packages|suite-common|suite-native|networks)\/.*)$/);
    if (root) return root[1];
    // the rest lives under suite/: the namespace's package directory, or a sibling reached with ../
    const ns = s.match(/^@[^/]+\/([^/]+)\//);
    if (ns) {
        const rest = s.slice(ns[0].length);

        return rest.startsWith('../') ? `suite/${rest.replace(/^(\.\.\/)+/, '')}` : `suite/${ns[1]}/${rest.replace(/^\.\//, '')}`;
    }

    return s.replace(/^(\.\.?\/)+/, '');
};
/** The area a source file belongs to: a package, packages/suite/src/<dir>, an npm package. */
export const areaOf = file => {
    const p = file.split('/');
    if (p[0].startsWith('npm:')) return p[0].startsWith('npm:@') ? `${p[0]}/${p[1]}` : p[0];
    if (p[0] === 'packages' && p[1] === 'suite' && p[2] === 'src' && p.length > 4) return p.slice(0, 4).join('/');
    if (p[0] === 'networks') return p.slice(0, 3).join('/');

    return p.slice(0, Math.min(2, p.length - 1)).join('/') || file;
};

/** REACT_COMPILER_PATHS at a revision: the directories the webpack build compiles; null when not wired up. */
export const compilerPathsAt = (repo, rev) => {
    if (!repo || !rev) return undefined;
    let text;
    try {
        text = git(['show', `${rev}:packages/suite/webpack/reactCompiler.ts`], repo);
    } catch {
        return null;
    }
    const block = text.match(/REACT_COMPILER_PATHS[^=]*=\s*\[([\s\S]*?)\]/);
    if (!block) return null;
    const body = block[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    return [...body.matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
};

/** Map every sentinel to its source file through the chunk's .js.map. */
const attribute = async (sentinels, SourceMapConsumer) => {
    const hits = [];
    let unmapped = 0;
    for (const { file, at } of sentinels) {
        const mapFile = `${file}.map`;
        if (!exists(mapFile)) {
            unmapped += at.length;
            continue;
        }
        const text = fs.readFileSync(file, 'utf8');
        let consumer = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, 'utf8')));
        // source-map 0.7+ returns a promise; 0.6 (Suite's today) is synchronous
        if (typeof consumer.then === 'function') consumer = await consumer;
        let line = 1;
        let lineStart = 0;
        let pos = 0;
        for (const i of at) {
            // the map's columns count UTF-16 units of the generated line: walk the string, not bytes
            for (let nl = text.indexOf('\n', pos); nl >= 0 && nl < i; nl = text.indexOf('\n', nl + 1)) {
                line += 1;
                lineStart = nl + 1;
            }
            pos = lineStart;
            const o = consumer.originalPositionFor({ line, column: i - lineStart });
            if (o && o.source) hits.push(sourcePath(o.source));
            else unmapped += 1;
        }
        if (typeof consumer.destroy === 'function') consumer.destroy();
    }

    return { hits, unmapped };
};

/** How much of a build the React Compiler compiled: sentinels by file and area, next to the configured paths. */
const compilerOf = async (sentinels, { repo, configured }) => {
    const total = sentinels.reduce((t, s) => t + s.at.length, 0);
    const out = { sentinels: total, compiledSentinels: null, reactOwn: null, files: null, areas: [], configured: configured ?? null, unmatched: [], outside: 0, unmapped: 0 };
    if (!total) return Object.assign(out, { compiledSentinels: 0, reactOwn: 0, files: 0 });
    let SourceMapConsumer = null;
    try {
        ({ SourceMapConsumer } = await importFromRepo(repo, 'source-map'));
    } catch {
        // no source-map package: totals only
    }
    if (!SourceMapConsumer) return out;
    const { hits, unmapped } = await attribute(sentinels, SourceMapConsumer);
    const own = hits.filter(f => f.startsWith('npm:'));
    const app = hits.filter(f => !f.startsWith('npm:'));
    const files = new Map();
    for (const f of app) files.set(f, (files.get(f) || 0) + 1);
    const areas = new Map();
    for (const [f, n] of files) {
        const a = areaOf(f);
        const x = areas.get(a) || { area: a, files: 0, sentinels: 0 };
        x.files += 1;
        x.sentinels += n;
        areas.set(a, x);
    }
    const inside = f => (configured || []).some(dir => f.startsWith(`${dir}/`));
    Object.assign(out, {
        compiledSentinels: app.length,
        reactOwn: own.length,
        files: files.size,
        areas: [...areas.values()].sort((a, b) => b.files - a.files || a.area.localeCompare(b.area)),
        unmatched: (configured || []).filter(dir => ![...files.keys()].some(f => f.startsWith(`${dir}/`))),
        outside: configured ? [...files.keys()].filter(f => !inside(f)).length : 0,
        unmapped,
    });

    return out;
};

/**
 * Fingerprint of one target's build. dir = side.web (web build dir) or side.desktop (desktop app dir);
 * expect = the sha the build should carry (the clone's HEAD); rev = the revision whose
 * REACT_COMPILER_PATHS to report (default: expect).
 */
export const fingerprint = async ({ target = 'web', dir, expect = null, repo = null, rev = null }) => {
    const parts = {};
    const sentinels = [];
    for (const { part, dir: d } of partsOf(target, dir)) {
        const files = jsFiles(d);
        const s = scanPart(files, expect);
        const top = s.releases[0] || null;
        // the release string names the commit; with an expectation, its own hits count too
        const commit = expect && s.expectHits ? expect : top ? top.commit : null;
        const others = [...new Set(s.releases.map(r => r.commit).filter(c => c !== commit))];
        parts[part] = {
            dir: d, files: s.files, bytes: s.bytes, commit, verified: expect ? commit === expect && !others.length : null, others,
            release: top && { version: top.version, suiteType: top.suiteType, codesign: top.codesign },
            sentinels: s.sentinels.reduce((t, x) => t + x.at.length, 0), coverageFiles: s.coverageFiles,
        };
        // the main process is outside every compiled path: only renderer / app bundles count
        if (part !== 'main') sentinels.push(...s.sentinels);
    }
    const list_ = Object.values(parts).filter(p => p.files);
    const head = parts.app || parts.renderer || list_[0] || {};
    const configured = repo ? compilerPathsAt(repo, rev || expect || head.commit) : undefined;
    const compiler = await compilerOf(sentinels, { repo, configured });
    const commits = [...new Set(list_.map(p => p.commit).filter(Boolean))];

    return {
        v: FP_VERSION, target, dir, at: new Date().toISOString(),
        commit: commits.length === 1 ? commits[0] : head.commit || null,
        // every part carries the expected commit and nothing else
        verified: expect ? list_.length > 0 && list_.every(p => p.verified) : null,
        mixed: commits.length > 1 ? commits : null,
        release: head.release || null,
        files: list_.reduce((t, p) => t + p.files, 0),
        coverageFiles: list_.reduce((t, p) => t + p.coverageFiles, 0),
        compiler,
        parts,
    };
};

// ------------------------------------------------------------------ text
const n = v => (typeof v === 'number' ? v.toLocaleString('en-US') : '–');
/** "2,118 memo blocks in 912 files — suite-common/wallet-core 40 · …" or "not compiled (…)". */
export const compilerText = (c, top = 5) => {
    if (!c) return '–';
    const conf = c.configured === null ? 'not configured at this revision' : c.configured ? `configured: ${c.configured.join(', ') || 'none'}` : '';
    if (c.files === null) return `${n(c.sentinels)} sentinels (no source maps to attribute them)${conf ? ` · ${conf}` : ''}`;
    if (!c.files) return `not compiled (${c.reactOwn ? "React's own sentinel only" : 'no sentinel'})${conf ? ` · ${conf}` : ''}`;
    const areas = c.areas.slice(0, top).map(a => `${a.area} ${n(a.files)}`).join(' · ') + (c.areas.length > top ? ` · +${c.areas.length - top} more` : '');
    const gaps = [c.unmatched.length && `configured but nothing compiled under ${c.unmatched.join(', ')}`, c.outside && `${c.outside} files outside the configured paths`].filter(Boolean).join('; ');

    return `${n(c.compiledSentinels)} memo blocks in ${n(c.files)} files — ${areas}${conf ? ` · ${conf}` : ''}${gaps ? ` · ${gaps}` : ''}`;
};
/** One line per fingerprint. */
export const fingerprintText = fp => {
    if (!fp) return 'no fingerprint';
    const r = fp.release ? ` (${fp.release.version}.${fp.release.suiteType}${fp.release.codesign ? '.codesign' : ''})` : '';
    const commit = fp.commit ? `${fp.commit.slice(0, 10)}${fp.verified === true ? ' ✓' : fp.verified === false ? ' ✗ (expected another commit)' : ''}${r}` : 'no commit found';

    return `commit ${commit}${fp.mixed ? ` · MIXED commits ${fp.mixed.map(c => c.slice(0, 10)).join(', ')}` : ''} · ${fp.files} files · coverage ${fp.coverageFiles} · compiler: ${compilerText(fp.compiler)}`;
};

// ------------------------------------------------------------------ CLI
if (import.meta.main) {
    const args = parseArgs();
    const out = [];
    if (args.run) {
        const run = loadRun(args.run);
        const repo = repoRoot(args.repo || run.repo);
        const target = args.target || run.target || 'web';
        const keys = list(args.sides).length ? list(args.sides) : Object.keys(run.sides);
        for (const key of keys) {
            const side = sideOf(run, key);
            const dir = target === 'desktop' ? side.desktop : side.web;
            if (!dir) {
                out.push({ side: key, error: side.url ? `deployed preview ${side.url}: fingerprinted in the page (env.build)` : `no ${target} build — run build.mjs` });
                continue;
            }
            out.push({ side: key, fp: await fingerprint({ target, dir, expect: side.buildSha || side.sha || null, repo, rev: side.buildSha || side.sha }) });
        }
    } else {
        const dir = args._[0];
        if (!dir) throw new Error('usage: node fingerprint.mjs --run=<id> | <build dir> [--target=web|desktop] [--expect=<sha>]');
        let repo = null;
        try {
            repo = repoRoot(args.repo);
        } catch {
            // no checkout: no source maps, no configured paths
        }
        const target = args.target || (exists(path.join(dir, 'dist', 'app.js')) ? 'desktop' : 'web');
        out.push({ side: null, fp: await fingerprint({ target, dir: path.resolve(dir), expect: args.expect ? String(args.expect) : null, repo, rev: args.rev ? String(args.rev) : null }) });
    }
    if (args.json) {
        console.log(JSON.stringify(out, null, 1));
    } else {
        for (const o of out) {
            if (o.error) log(`${o.side}: ${o.error}`);
            else log(`${o.side ? `${o.side} ` : ''}${o.fp.target} ${fingerprintText(o.fp)}`);
        }
    }
    if (out.some(o => o.fp && (o.fp.verified === false || o.fp.coverageFiles || o.fp.mixed))) process.exitCode = 1;
}
