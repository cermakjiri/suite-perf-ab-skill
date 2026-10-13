/**
 * Attribute a V8 CPU profile of a production Suite build (run.mjs --profile-at=<iter> writes
 * <session>.r<rate>i<iter>.cpuprofile) to original source files through the build's source maps:
 * self time per file and per function, and inclusive time per file (a sample counts once per
 * distinct file on its stack). CDP TaskDuration says how much; this says where.
 *
 *   node attr.mjs <profile.cpuprofile> (--run=<name|dir> --side=A | --build=<dir>) [--top=25] [--json=<out.json>]
 *
 * Needs `source-map` from the checkout's node_modules (resolved via --repo / the current checkout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadRun, sideOf, repoRoot, importFromRepo } from './lib.mjs';

const args = parseArgs();
const profFile = args._[0];
if (!profFile) throw new Error('usage: node attr.mjs <profile.cpuprofile> --run=<run> --side=<A|B> | --build=<dir>');
let buildDir = args.build;
if (!buildDir) {
    const run = loadRun(args.run);
    const side = sideOf(run, args.side);
    buildDir = (args.target || run.target) === 'desktop' ? path.join(side.desktop, 'build') : side.web;
}
const { SourceMapConsumer } = await importFromRepo(repoRoot(args.repo), 'source-map');
const TOP = Number(args.top || 25);
const prof = JSON.parse(fs.readFileSync(profFile, 'utf8'));

const consumers = {};
const consumerFor = url => {
    const m = url.match(/\/(js\/[^/?#]+\.js)$/);
    if (!m) return null;
    if (!(m[1] in consumers)) {
        const mapFile = path.join(buildDir, m[1] + '.map');
        consumers[m[1]] = fs.existsSync(mapFile) ? new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, 'utf8'))) : null;
    }

    return consumers[m[1]];
};
// collapse a source path to package + path inside it
const norm = src => {
    let s = src.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
    const nm = s.lastIndexOf('node_modules/');
    if (nm >= 0) s = 'npm:' + s.slice(nm + 13);

    return s;
};
const label = node => {
    const cf = node.callFrame;
    if (!cf.url) return { file: cf.functionName && cf.functionName.startsWith('(') ? cf.functionName : `(${cf.functionName || 'native'})`, fn: cf.functionName || '' };
    const c = consumerFor(cf.url);
    if (!c) return { file: cf.url.replace(/^[a-z]+:\/\/[^/]*\//, ''), fn: cf.functionName };
    const pos = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
    if (!pos.source) return { file: cf.url.replace(/^[a-z]+:\/\/[^/]*\//, '') + ' (unmapped)', fn: cf.functionName };

    return { file: norm(pos.source), fn: (pos.name || cf.functionName || '(anonymous)') + ':' + pos.line };
};

const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
const labels = new Map();
for (const n of prof.nodes) labels.set(n.id, label(n));
const self = {};
const selfFn = {};
const incl = {};
const special = {};
let total = 0;
for (let i = 0; i < prof.samples.length; i++) {
    const dt = (prof.timeDeltas[i + 1] !== undefined ? prof.timeDeltas[i + 1] : 0) / 1000;
    const id = prof.samples[i];
    const lb = labels.get(id);
    total += dt;
    if (lb.file.startsWith('(')) special[lb.file] = (special[lb.file] || 0) + dt;
    self[lb.file] = (self[lb.file] || 0) + dt;
    const fk = lb.file + ' › ' + lb.fn;
    selfFn[fk] = (selfFn[fk] || 0) + dt;
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const f = labels.get(cur).file;
        if (seen.has(f)) continue;
        seen.add(f);
        incl[f] = (incl[f] || 0) + dt;
    }
}
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(1)]);
const out = {
    profile: path.basename(profFile), build: buildDir, totalMs: +total.toFixed(1), busyMs: +(total - (special['(idle)'] || 0)).toFixed(1),
    special: Object.fromEntries(Object.entries(special).map(([k, v]) => [k, +v.toFixed(1)])),
    selfByFile: top(self, TOP), selfByFunction: top(selfFn, TOP), inclusiveByFile: top(incl, TOP),
};
if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
console.log(`${out.profile}: total ${out.totalMs} ms, busy (non-idle) ${out.busyMs} ms`, JSON.stringify(out.special));
for (const [title, list] of [['self by file', out.selfByFile], ['self by function', out.selfByFunction], ['inclusive by file', out.inclusiveByFile]]) {
    console.log(`\n${title}:`);
    for (const [k, v] of list) console.log(String(v).padStart(9), k);
}
