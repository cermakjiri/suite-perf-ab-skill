/**
 * Did the sides of a run build the same code? Their JS is compared with everything that differs
 * between any two builds masked, per part of a target: web build/, and for desktop the renderer's
 * build/ and the main process's dist/ on their own. A code-identical target is unaffected by the
 * change: report it so instead of timing it.
 *
 *   node bundlediff.mjs --run=<name|dir> [--targets=web,desktop]   the sides' builds (run.json); writes run.json `bundles`
 *   node bundlediff.mjs <dirA> <dirB> [--shas=<a>,<b>]              two build dirs (a web build/, or a desktop-app dir)
 *
 * build.mjs runs it after both sides of a target are built; preflight.mjs reads run.json `bundles`.
 * Masked before comparing (every build differs there, whatever its code):
 *   - content-hashed names: chunks pair by name with the 8-hex hash stripped (main.1a2b3c4d.js ↔ main.9f8e7d6c.js)
 *   - every side's commit, full and short (any hex run starting with its first 7 characters): bundles inline it
 *   - quoted 8-hex chunk-hash maps ("1a2b3c4d") and .<hash>.js references
 *   - the build-signed message-system config (eyJ… JWT-like tokens, signed at build time)
 *   - short mangled identifiers (1-3 characters not after a dot): the minifier renames them when modules shift
 * Code-identical thus means identical apart from mangled names, hashes, the commit and the signed
 * config. Plain checksums cannot tell: in the coinjoin-address-stats run 65 of 265 web files differed
 * byte for byte while web and the renderer were code-identical and only dist/threads/coinjoin-backend.js
 * differed (+177 bytes). Strings, numbers, property names and longer identifiers are never masked.
 *
 * run.json `bundles`: { <target>: { "<A>-<B>": { v, key, at, identical, parts: { <part>: { files: [nA, nB],
 * byteSame, identical, differing: [{ file, kind: code | only-A | only-B | duplicate, a, b, delta }] } } } } },
 * cached by both sides' commits, profiles and build times (key). Sandbox: on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, loadRun, updateRun, tryJson, exists, log, sideCommit } from './lib.mjs';

export const BD_VERSION = 1;
// a target's parts, relative to the dir run.json records for it (web: …/web-app/build, desktop: …/desktop-app)
export const PARTS = { web: [['web', '.']], desktop: [['renderer', 'build'], ['main', 'dist']] };
const HASHED = /^(.*?)([^/]+)\.([0-9a-f]{8})\.js$/;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]{0,2}(?![\w$])/g;

const jsFiles = root => {
    const out = [];
    const walk = rel => {
        for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const p = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) out.push(p);
        }
    };
    if (exists(root)) walk('');

    return out.sort();
};
/** Masks for these commits (both sides' sha and buildSha). */
export const masker = shas => {
    const prefixes = [...new Set(shas.filter(s => /^[0-9a-f]{7,40}$/.test(s || '')).map(s => s.slice(0, 7)))];
    const sha = prefixes.length ? new RegExp(`(?:${prefixes.join('|')})[0-9a-f]*`, 'g') : null;

    return text => {
        let t = sha ? text.replace(sha, '<SHA>') : text;
        t = t.replace(/"[0-9a-f]{8}"/g, '"<H>"').replace(/\.[0-9a-f]{8}\.js/g, '.<H>.js').replace(/eyJ[\w.-]{40,}/g, '<JWT>');

        return t.replace(IDENT, 'I');
    };
};
/** One part: pair the JS files by hash-stripped name, compare bytes, then masked text. */
export const comparePart = (dirA, dirB, mask) => {
    const index = (root, side, issues) => {
        const m = new Map();
        for (const f of jsFiles(root)) {
            const h = f.match(HASHED);
            const key = h ? `${h[1]}${h[2]}.<hash>.js` : f;
            if (m.has(key)) issues.push({ file: key, kind: 'duplicate', side });
            m.set(key, f);
        }

        return m;
    };
    const issues = [];
    const a = index(dirA, 'A', issues);
    const b = index(dirB, 'B', issues);
    const differing = issues.map(x => ({ file: x.file, kind: 'duplicate', a: null, b: null, delta: null, side: x.side }));
    let byteSame = 0;
    for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const fa = a.get(key);
        const fb = b.get(key);
        const sizeOf = (root, f) => fs.statSync(path.join(root, f)).size;
        if (!fa || !fb) {
            const size = fa ? sizeOf(dirA, fa) : sizeOf(dirB, fb);
            differing.push({ file: key, kind: fa ? 'only-A' : 'only-B', a: fa ? size : null, b: fb ? size : null, delta: fa ? -size : size });
            continue;
        }
        const ba = fs.readFileSync(path.join(dirA, fa));
        const bb = fs.readFileSync(path.join(dirB, fb));
        if (ba.equals(bb)) {
            byteSame += 1;
            continue;
        }
        // latin1: one char per byte, so the masks see what the Python prototype's byte regexes saw
        if (mask(ba.toString('latin1')) !== mask(bb.toString('latin1'))) differing.push({ file: key, kind: 'code', a: ba.length, b: bb.length, delta: bb.length - ba.length });
    }
    differing.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));

    return { files: [a.size, b.size], byteSame, identical: !differing.length, differing };
};
/** A target's parts compared: { identical, parts }. dirA/dirB are the dirs run.json records for the target. */
export const compareTarget = (target, dirA, dirB, shas) => {
    const mask = masker(shas);
    const parts = {};
    for (const [name, rel] of PARTS[target] || [[target, '.']]) parts[name] = comparePart(path.join(dirA, rel), path.join(dirB, rel), mask);

    return { identical: Object.values(parts).every(p => p.identical), parts };
};
const bytes = n => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US')} B`;
/** "web A-B: code-identical between sides (…) · 265 JS files, 65 differ byte for byte" or the differing files. */
export const bundlesText = (target, pair, r, max = 6) => {
    const files = p => `${p.files[0] === p.files[1] ? p.files[0] : `${p.files[0]}/${p.files[1]}`} JS files`;
    const one = ([name, p]) => {
        const label = Object.keys(r.parts).length > 1 ? `${name} ` : '';
        if (p.identical) return `${label}code-identical (${files(p)}, ${p.files[0] - p.byteSame} differ byte for byte)`;
        const list_ = p.differing.slice(0, max).map(d => `${d.file} ${d.kind === 'code' ? bytes(d.delta) : d.kind}`).join(', ');

        return `${label}differs in ${p.differing.length} of ${files(p)}: ${list_}${p.differing.length > max ? `, +${p.differing.length - max} more` : ''}`;
    };
    const head = r.identical ? 'code-identical between sides (apart from mangled names, hashes, commit, signed config)' : 'code differs between sides';

    return `${target} ${pair}: ${head} — ${Object.entries(r.parts).map(one).join('; ')}`;
};

// the sides' clone state: what the cache key needs (a rebuild changes the build time)
const builtAt = (side, target) => {
    const st = side.clone ? tryJson(path.join(side.clone, '.perf-ab-build.json')) : null;

    return (st && st.targets && st.targets[target] && st.targets[target].at) || null;
};
/**
 * Compare every side against the first for each target both have built; write run.json `bundles`
 * (merge-write) and return the lines to print. Cached: an unchanged pair is not compared again.
 */
export const compareRun = (run, targets) => {
    const keys = Object.keys(run.sides);
    const lines = [];
    const results = {};
    const [first, ...others] = keys;
    for (const t of targets) {
        for (const k of others) {
            const A = run.sides[first];
            const B = run.sides[k];
            if (!A[t] || !B[t] || !exists(A[t]) || !exists(B[t])) continue;
            const pair = `${first}-${k}`;
            const key = [BD_VERSION, sideCommit(A), A.profile, builtAt(A, t), sideCommit(B), B.profile, builtAt(B, t)].join('|');
            const old = run.bundles && run.bundles[t] && run.bundles[t][pair];
            let r = old && old.key === key ? old : null;
            if (!r) {
                const t0 = Date.now();
                const shas = [A.sha, A.buildSha, B.sha, B.buildSha].filter(Boolean);
                r = Object.assign({ v: BD_VERSION, key, at: new Date().toISOString(), ms: 0 }, compareTarget(t, A[t], B[t], shas));
                r.ms = Date.now() - t0;
            }
            (results[t] ||= {})[pair] = r;
            lines.push(bundlesText(t, pair, r));
        }
    }
    if (Object.keys(results).length) {
        updateRun(run, fresh => {
            fresh.bundles = fresh.bundles || {};
            for (const [t, pairs] of Object.entries(results)) fresh.bundles[t] = Object.assign({}, fresh.bundles[t], pairs);
        });
    }

    return lines;
};
/** Which targets run.json says are code-identical between every pair, e.g. ['web']. */
export const identicalTargets = run => Object.entries(run.bundles || {}).filter(([, pairs]) => Object.values(pairs).length && Object.values(pairs).every(r => r.identical)).map(([t]) => t);

if (import.meta.main) {
    const args = parseArgs();
    if (args.run) {
        const run = loadRun(args.run);
        const targets = list(args.targets).length ? list(args.targets) : Object.keys(PARTS);
        const lines = compareRun(run, targets);
        if (!lines.length) log(`no target with a build on two sides (${targets.join(', ')}): build them first (build.mjs)`);
        for (const l of lines) log(l);
    } else {
        const [a, b] = args._;
        if (!a || !b) throw new Error('usage: bundlediff.mjs --run=<id> [--targets=web,desktop] | <dirA> <dirB> [--shas=<a>,<b>]');
        const target = exists(path.join(a, 'dist')) && exists(path.join(a, 'build')) ? 'desktop' : 'web';
        const r = compareTarget(target, path.resolve(a), path.resolve(b), list(args.shas));
        log(bundlesText(target, 'A-B', r, 30));
    }
}
