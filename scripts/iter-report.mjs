#!/usr/bin/env node
/**
 * Slice a Chrome trace into the per-iteration windows the harness marked, run analyze-trace.mjs on
 * each, and report the percentile across iterations.
 *
 *   node iter-report.mjs --scenario=S1 --label="develop mount" [--warmup=0] [--p=75] trace.json
 *                       [--out=summary.json]
 *
 * The harness's `s1`/`s2`/`s3` runners emit `performance.measure('S<n>-<i>', ...)` around each
 * iteration; those land in the trace as blink.user_timing events, which is what this finds.
 *
 * If it prints "no S*-* measures found", the trace buffer truncated before your iterations ran —
 * see references/pitfalls.md. Shrink the traced scenario rather than trusting a partial result.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const a = args.find(x => x.startsWith(`--${name}=`));

    return a ? a.split('=').slice(1).join('=') : dflt;
};
const files = args.filter(a => !a.startsWith('--'));
const scenario = opt('scenario', 'S1');
const label = opt('label', files[0] ? path.basename(files[0]) : '?');
const warmup = Number(opt('warmup', 0));
const pct = Number(opt('p', 75));
const ANALYZER = path.join(import.meta.dirname, 'analyze-trace.mjs');

if (!files.length) {
    console.error('usage: node iter-report.mjs --scenario=S1 [--label=NAME] [--warmup=0] [--p=75] trace.json');
    process.exit(1);
}

const readTrace = f => {
    const buf = fs.readFileSync(f);
    const txt = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const json = JSON.parse(txt);

    return Array.isArray(json) ? json : json.traceEvents;
};

/**
 * Must match analyze-trace.mjs exactly: navigationStart when present, otherwise the earliest event
 * with ts > 0, skipping metadata ('M') events. Get this wrong and every window lands in empty
 * space — the tell-tale is all-zero metrics with a correct windowDurationMs.
 */
const originOf = events => {
    let nav = Infinity;
    let first = Infinity;
    for (const e of events) {
        if (e.ph === 'M') continue;
        if (typeof e.ts !== 'number' || e.ts <= 0) continue;
        if (e.ts < first) first = e.ts;
        if ((e.name === 'navigationStart' || e.name === 'NavigationStart') && e.ts < nav) nav = e.ts;
    }

    return Number.isFinite(nav) ? nav : first;
};

// blink.user_timing measures appear either as complete ('X') events or as begin/end ('b'/'e') pairs
// depending on Chrome version, so handle both.
const findWindows = (events, scen) => {
    const re = new RegExp(`^${scen}-(\\d+)$`);
    const byIdx = new Map();
    const opens = new Map();
    for (const e of events) {
        const m = typeof e.name === 'string' && e.name.match(re);
        if (!m) continue;
        const idx = Number(m[1]);
        if (e.ph === 'X' || e.ph === 'R') {
            byIdx.set(idx, { idx, start: e.ts, end: e.ts + (e.dur || 0) });
        } else if (e.ph === 'b') {
            opens.set(idx, e.ts);
        } else if (e.ph === 'e' && opens.has(idx)) {
            byIdx.set(idx, { idx, start: opens.get(idx), end: e.ts });
            opens.delete(idx);
        }
    }

    return [...byIdx.values()].sort((a, b) => a.idx - b.idx);
};

const percentile = (sorted, p) => {
    if (!sorted.length) return null;

    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

const KEEP = [
    'scriptingSelfMs', 'renderingSelfMs', 'paintingSelfMs', 'paintingSelfMainThreadMs',
    'rasterSelfMs', 'gpuSelfMs', 'taskOverheadSelfMs', 'gcSelfMs',
    'mainThreadTaskTotalMs', 'cpuIdleMs', 'cpuUtilizationPct',
    'tbtTotalMs', 'longTaskCount', 'longTaskTotalMs', 'longestTaskMs',
    'layoutCount', 'layoutTotalMs', 'layoutForcedCount', 'layoutForcedTotalMs',
    'updateLayoutTreeCount', 'updateLayoutTreeTotalMs', 'updateLayoutTreeForcedCount',
    'hitTestTotalMs', 'prePaintTotalMs', 'paintCount', 'paintTotalMs',
    'longAnimationFrameCount', 'longAnimationFrameTotalMs', 'droppedFrameCount',
    'windowDurationMs',
];

const out = [];
for (const file of files) {
    const events = readTrace(file);
    const origin = originOf(events);
    const wins = findWindows(events, scenario);
    if (!wins.length) {
        console.error(`!! no ${scenario}-* measures found in ${file} — the trace buffer probably truncated`);
        continue;
    }
    for (const w of wins) {
        const from = (w.start - origin) / 1000;
        const to = (w.end - origin) / 1000;
        const raw = execFileSync(
            process.execPath,
            [ANALYZER, '--json', `--from=${from}`, `--to=${to}`, file],
            { maxBuffer: 512 * 1024 * 1024 },
        ).toString();
        const parsed = JSON.parse(raw);
        const one = Array.isArray(parsed) ? parsed[0] : parsed;
        out.push({ file, idx: w.idx, from, to, metrics: one.metrics, longTasks: one.details.longTasks });
    }
}

const kept = out.filter(o => o.idx >= warmup);
console.log(
    `\n=== ${label} · ${scenario} · ${kept.length} iterations kept of ${out.length} found (${warmup} warm-up discarded) · p${pct} nearest-rank ===\n`,
);

const rows = [];
for (const k of KEEP) {
    const vals = kept
        .map(o => o.metrics[k])
        .filter(v => typeof v === 'number')
        .sort((a, b) => a - b);
    if (!vals.length) continue;
    rows.push({
        metric: k,
        p50: percentile(vals, 50),
        [`p${pct}`]: percentile(vals, pct),
        min: vals[0],
        max: vals[vals.length - 1],
    });
}

const fmt = n => (typeof n === 'number' ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) : String(n));
const w0 = Math.max(...rows.map(r => r.metric.length), 6);
console.log(`${'metric'.padEnd(w0)}  ${'p50'.padStart(8)}  ${`p${pct}`.padStart(8)}  ${'min'.padStart(8)}  ${'max'.padStart(8)}`);
console.log(`${'-'.repeat(w0)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}`);
for (const r of rows) {
    console.log(
        `${r.metric.padEnd(w0)}  ${fmt(r.p50).padStart(8)}  ${fmt(r[`p${pct}`]).padStart(8)}  ${fmt(r.min).padStart(8)}  ${fmt(r.max).padStart(8)}`,
    );
}

if (kept.length) {
    console.log(`\nper-iteration scriptingSelfMs: ${kept.map(o => o.metrics.scriptingSelfMs.toFixed(1)).join(', ')}`);
}

const dest = opt('out', null);
if (dest) {
    fs.writeFileSync(dest, JSON.stringify({ label, scenario, warmup, pct, iterations: out, summary: rows }, null, 2));
    console.log(`\nwrote ${dest}`);
}
