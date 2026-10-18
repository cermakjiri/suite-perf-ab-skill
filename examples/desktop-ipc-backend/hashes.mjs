/**
 * Cross-side output check for scenarios whose after() returns `hash` (examples/desktop-ipc-backend):
 * groups every iteration of a run's session records by scenario cfg and it.n, and checks that every
 * side that ran a point got the same hash there. All equal = the change kept the output on this
 * workload; a difference names the points and sessions to look at.
 *
 *   node <skill>/examples/desktop-ipc-backend/hashes.mjs --run=<id|dir> [--pass=pilot,main] [--all]
 *
 * --all lists every point. A point only one side ran (a discarded iteration is retried with the next
 * it.n) is counted, not judged. Exit 0 all equal, 1 a difference — across sides, or within one side
 * (then the data is not a pure function of it.n, or the backend is not deterministic) — 2 nothing to
 * compare. Records from before hashes were strings (FNV-1a as a number) read the same.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { run: { type: 'string' }, pass: { type: 'string' }, all: { type: 'boolean', default: false } } });
if (!args.run) {
    console.error('usage: node hashes.mjs --run=<id|dir> [--pass=pilot,main] [--all]');
    process.exit(2);
}
const home = process.env.PERF_AB_HOME || path.join(os.homedir(), '.local', 'share', 'suite-perf-ab');
const dir = args.run.includes('/') ? path.resolve(args.run) : path.join(home, 'runs', args.run);
const outDir = path.join(dir, 'out');
const passes = args.pass ? new Set(args.pass.split(',')) : null;
const SESSION = /^(.+)-(\d+)-([^-.]+)\.json$/; // <pass>-<n>-<side>.json
const hex = h => (typeof h === 'number' ? (h >>> 0).toString(16).padStart(8, '0') : String(h));
const sortedJson = v => JSON.stringify(v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : {});

// cfg + n → side → hash → sessions
const points = new Map();
const sides = new Set();
let sessions = 0;
for (const file of fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : []) {
    const m = SESSION.exec(file);
    if (!m || (passes && !passes.has(m[1]))) continue;
    let rec;
    try {
        rec = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
    } catch {
        continue;
    }
    if (!rec || !Array.isArray(rec.runs)) continue;
    const side = (rec.meta && rec.meta.side) || m[3];
    const cfg = sortedJson(rec.meta && rec.meta.cfg);
    const session = file.slice(0, -'.json'.length);
    let hashed = 0;
    for (const it of rec.runs) {
        const h = it.after && it.after.hash;
        if (h == null || it.n == null) continue;
        const key = `${cfg}\u0000${it.n}`;
        if (!points.has(key)) points.set(key, new Map());
        const bySide = points.get(key);
        if (!bySide.has(side)) bySide.set(side, new Map());
        const byHash = bySide.get(side);
        if (!byHash.has(hex(h))) byHash.set(hex(h), []);
        byHash.get(hex(h)).push(session);
        hashed += 1;
    }
    if (hashed) {
        sessions += 1;
        sides.add(side);
    }
}

const label = key => {
    const [cfg, n] = key.split('\u0000');

    return `${cfg === '{}' ? '' : `cfg ${cfg} `}n ${n}`;
};
const fmt = bySide =>
    [...bySide]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([side, byHash]) => `${side} ${[...byHash].map(([h, ss]) => `${h} (${ss.length === 1 ? ss[0] : `${ss[0]} +${ss.length - 1}`})`).join(' / ')}`)
        .join(' · ');
const keys = [...points.keys()].sort((a, b) => {
    const [ca, na] = a.split('\u0000');
    const [cb, nb] = b.split('\u0000');

    return ca === cb ? Number(na) - Number(nb) : ca.localeCompare(cb);
});

let paired = 0;
let equal = 0;
let unpaired = 0;
const bad = [];
for (const key of keys) {
    const bySide = points.get(key);
    const split = [...bySide.values()].some(byHash => byHash.size > 1);
    const distinct = new Set([...bySide.values()].flatMap(byHash => [...byHash.keys()]));
    if (bySide.size < 2) unpaired += 1;
    else paired += 1;
    if (split) bad.push([key, 'differs within a side']);
    else if (distinct.size > 1) bad.push([key, 'differs across sides']);
    else if (bySide.size > 1) equal += 1;
}

console.log(
    `${path.basename(dir)}: ${sessions} sessions with hashes, sides ${[...sides].sort().join(' ') || '–'} · ${paired} points on two or more sides: ${equal} equal${bad.length ? `, ${bad.length} differ` : ''}${unpaired ? ` · ${unpaired} on one side only` : ''}`,
);
for (const [key, why] of bad.slice(0, 20)) console.log(`  ✗ ${label(key)}: ${why} — ${fmt(points.get(key))}`);
if (bad.length > 20) console.log(`  … ${bad.length - 20} more`);
if (args.all) for (const key of keys) console.log(`  ${label(key)}: ${fmt(points.get(key))}`);
process.exit(bad.length ? 1 : paired ? 0 : 2);
