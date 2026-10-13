/**
 * Disk housekeeping for the run home. Clones are the big part (~1-2 GiB of real blocks each once
 * built); runs (session JSON, report) are small and worth keeping.
 *
 *   node cleanup.mjs                          list clones, runs, desktop profile dirs and locks
 *   node cleanup.mjs --clones --older-than=3  remove clones not used for 3 days
 *   node cleanup.mjs --clone=<name>           remove one clone (<sha12>[-<variant>].<profile>)
 *   node cleanup.mjs --apps                   remove the desktop sessions' user-data dirs
 *   node cleanup.mjs --refs [--repo=<checkout>]  drop the refs/perf-ab/* revs.mjs fetched into the checkout
 *
 * A clone still referenced by a run's run.json is listed with that run; removing it only means the
 * next build.mjs for that run clones and builds again. A clone that a live session or exploration
 * serves, or that a build of another run holds, is never removed (parallel runs). Clones named
 * without a profile suffix come from before build profiles and are not reused by build.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, home, readJson, exists, log, repoRoot, mainCheckout, git } from './lib.mjs';
import { queue, holderText, cloneUsers } from './locks.mjs';

const args = parseArgs();
const H = home();
const du = p => {
    const r = spawnSync('du', ['-sk', p], { encoding: 'utf8' });

    return r.status === 0 ? Number(r.stdout.split(/\s+/)[0]) / 1048576 : null;
};
const gib = v => (v === null ? '?' : `${v.toFixed(2)} GiB`);
const ls = d => (exists(d) ? fs.readdirSync(d).filter(n => !n.startsWith('.')).map(n => path.join(d, n)) : []);
const runs = ls(path.join(H, 'runs'));
const usedBy = {};
for (const r of runs) {
    try {
        const j = readJson(path.join(r, 'run.json'));
        for (const s of Object.values(j.sides || {})) {
            for (const p of [s.web, s.desktop]) {
                const m = p && p.match(/clones\/([^/]+)/);
                if (m) (usedBy[m[1]] = usedBy[m[1]] || new Set()).add(path.basename(r));
            }
        }
    } catch {
        // not a run dir
    }
}
const clones = ls(path.join(H, 'clones'));
const ageDays = p => (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
// in use by another run: a live session or exploration serving it, or a build holding its lock
const inUse = c => {
    const users = cloneUsers(c);
    const building = queue(`clone-${path.basename(c)}`);

    return users.length || building.length ? [...users.map(u => `${u.label || u.kind} of ${u.run || '?'} (pid ${u.pid})`), ...building.map(holderText)].join(', ') : null;
};
const remove = (p, why) => {
    const busy = p.includes(`${path.sep}clones${path.sep}`) ? inUse(p) : null;
    if (busy) {
        log('kept', p, `— in use: ${busy}`);

        return;
    }
    fs.rmSync(p, { recursive: true, force: true });
    log('removed', p, why);
};

if (args.clone) {
    remove(path.join(H, 'clones', String(args.clone)), '(--clone)');
} else if (args.clones) {
    const older = Number(args.olderThan ?? 0);
    for (const c of clones) {
        const st = path.join(c, '.perf-ab-build.json');
        const age = ageDays(exists(st) ? st : c);
        if (age >= older) remove(c, `(${age.toFixed(1)} days)`);
    }
} else if (args.apps) {
    for (const a of ls(path.join(H, 'apps'))) remove(a, '(desktop user-data dir)');
} else if (args.refs) {
    const repo = mainCheckout(repoRoot(args.repo)) || repoRoot(args.repo);
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/perf-ab/'], repo).split('\n').filter(Boolean);
    for (const r of refs) git(['update-ref', '-d', r], repo);
    log(`dropped ${refs.length} refs/perf-ab/* refs from ${repo}`);
} else {
    console.log(`run home ${H}\n\nclones (apparent size: copy-on-write clones share blocks with the checkout — real usage is the changed files + build output, ~1-2 GiB each; df shows the truth):`);
    for (const c of clones) {
        const st = exists(path.join(c, '.perf-ab-build.json')) ? readJson(path.join(c, '.perf-ab-build.json')) : {};
        const busy = inUse(c);
        console.log(`  ${path.basename(c).padEnd(38)} ${gib(du(c)).padStart(10)}  ${Object.keys(st.targets || {}).filter(t => st.targets[t].ok).join('+') || 'no build'}${st.profile ? '' : ' (no profile: from before profiles, not reused)'}  ${ageDays(c).toFixed(1)} d  ${usedBy[path.basename(c)] ? 'used by ' + [...usedBy[path.basename(c)]].join(', ') : ''}${busy ? ` · IN USE: ${busy}` : ''}`);
    }
    console.log('\nruns:');
    for (const r of runs) console.log(`  ${path.basename(r).padEnd(34)} ${gib(du(r)).padStart(10)}  ${exists(path.join(r, 'report.html')) ? 'report' : ''}`);
    const apps = ls(path.join(H, 'apps'));
    if (apps.length) console.log(`\ndesktop user-data dirs: ${apps.map(a => path.basename(a)).join(', ')} (--apps removes them)`);
    // live lock queues (dead tickets are dropped by reading them)
    const locks = ls(path.join(H, 'locks')).map(d => [path.basename(d), queue(path.basename(d))]).filter(([, q]) => q.length);
    if (locks.length) console.log(`\nlocks:\n${locks.map(([n, q]) => `  ${n.padEnd(38)} ${holderText(q[0])}${q.length > 1 ? ` · ${q.length - 1} waiting` : ''}`).join('\n')}`);
}
