#!/usr/bin/env node
/**
 * Percentile summary over the per-iteration records produced by assets/harness.js.
 *
 *   node p75.js --label="develop mount 4x" --warmup=3 [--p=75] records.json [--out=summary.json]
 *
 * `records.json` is whatever an `m1`/`m2f`/`m2g`/`m3` run returned — save it straight from
 * evaluate_script's `filePath` argument. Any wrapper object is unwrapped as long as it contains
 * exactly one array.
 *
 * The percentile is nearest-rank (no interpolation), which is what to state in the report: for
 * n=12, p75 is the 9th smallest value. Every metric also reports p50/min/max so the reader can see
 * the spread rather than trusting a single number.
 */
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const a = args.find(x => x.startsWith(`--${name}=`));

    return a ? a.split('=').slice(1).join('=') : dflt;
};
const files = args.filter(a => !a.startsWith('--'));
const warmup = Number(opt('warmup', 3));
const pct = Number(opt('p', 75));

if (!files.length) {
    console.error('usage: node p75.js [--label=NAME] [--warmup=3] [--p=75] records.json [--out=summary.json]');
    process.exit(1);
}

const pick = (sorted, p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

const load = f => {
    let j = JSON.parse(fs.readFileSync(f, 'utf8'));
    while (j && !Array.isArray(j) && typeof j === 'object') {
        const k = Object.keys(j).find(key => Array.isArray(j[key]));
        if (!k) break;
        j = j[k];
    }
    if (!Array.isArray(j)) throw new Error(`${f}: no array of iteration records found`);

    return j;
};

const out = {};
for (const f of files) {
    const all = load(f);
    const rows = all.slice(warmup);
    if (!rows.length) {
        console.error(`!! ${f}: ${all.length} records, all discarded as warm-up`);
        continue;
    }
    const label = opt('label', f);

    // Keep only numeric metrics. `i` is the iteration index, not a measurement.
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(
        k => k !== 'i' && rows.every(r => typeof r[k] === 'number' || r[k] === null),
    );

    const summary = {};
    for (const k of keys) {
        const vals = rows
            .map(r => r[k])
            .filter(v => typeof v === 'number' && Number.isFinite(v))
            .sort((a, b) => a - b);
        if (!vals.length) continue;
        summary[k] = {
            p50: pick(vals, 50),
            [`p${pct}`]: pick(vals, pct),
            min: vals[0],
            max: vals[vals.length - 1],
            n: vals.length,
        };
    }
    out[label] = { n: rows.length, discarded: warmup, summary };

    console.log(
        `\n=== ${label} · n=${rows.length} kept of ${all.length} (${warmup} warm-up discarded) · p${pct} nearest-rank ===\n`,
    );
    const w = Math.max(...Object.keys(summary).map(k => k.length), 6);
    const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
    console.log(
        `${'metric'.padEnd(w)}  ${'p50'.padStart(9)}  ${`p${pct}`.padStart(9)}  ${'min'.padStart(9)}  ${'max'.padStart(9)}`,
    );
    console.log(`${'-'.repeat(w)}  ${'-'.repeat(9)}  ${'-'.repeat(9)}  ${'-'.repeat(9)}  ${'-'.repeat(9)}`);
    for (const [k, s] of Object.entries(summary)) {
        console.log(
            `${k.padEnd(w)}  ${fmt(s.p50).padStart(9)}  ${fmt(s[`p${pct}`]).padStart(9)}  ${fmt(s.min).padStart(9)}  ${fmt(s.max).padStart(9)}`,
        );
    }
}

const dest = opt('out', null);
if (dest) {
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${dest}`);
}
