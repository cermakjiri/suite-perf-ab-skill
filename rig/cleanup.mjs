/**
 * Disk housekeeping for the run home. Clones are the big part (~1-2 GiB of real blocks each once
 * built); runs (session JSON, report) are small and worth keeping.
 *
 *   node cleanup.mjs                          list clones, runs, desktop profile dirs and locks
 *   node cleanup.mjs --clones --older-than=3  remove clones not used for 3 days
 *   node cleanup.mjs --clone=<name>           remove one clone (<sha12>[-<variant>].<profile>)
 *        [--run=<id>] [--force] [--repo=<checkout>]
 *   node cleanup.mjs --apps                   remove the desktop sessions' user-data dirs
 *   node cleanup.mjs --refs [--repo=<checkout>]  drop the refs/perf-ab/* revs.mjs fetched into the checkout
 *
 * A clone still referenced by a run's run.json is listed with that run; removing it only means the
 * next build.mjs for that run clones and builds again. A clone that a live session or exploration
 * serves, or that a build of another run holds, is never removed (parallel runs). Clones named
 * without a profile suffix come from before build profiles and are not reused by build.mjs.
 *
 * Shared clones (several runs on one base): a clone whose commit is a side in the run.json of
 * another run than --run=<the run you are done with> (without --run: of two or more runs, built or
 * only pinned), or is the tip of a local branch of the main checkout that other local branches are
 * based on, is kept with a warning unless --force: the next run on that base would rebuild it
 * (~2.5 min, seen when the base of two runs was removed after the first). A clone only one run
 * uses is removed as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs, home, readJson, tryJson, exists, log, repoRoot, mainCheckout, git, resolveIn } from './lib.mjs';
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
const add = (name, run) => (usedBy[name] = usedBy[name] || new Set()).add(run);
for (const r of runs) {
    try {
        const j = readJson(path.join(r, 'run.json'));
        const profile = (j.build && j.build.profile) || 'release';
        for (const s of Object.values(j.sides || {})) {
            for (const p of [s.clone, s.web, s.desktop]) {
                const m = p && p.match(/clones\/([^/]+)/);
                if (m) add(m[1], path.basename(r));
            }
            // pinned but not built yet: the clone build.mjs will make for it (its naming)
            const sha = [s.sha, s.rev].find(x => /^[0-9a-f]{40}$/.test(x || ''));
            if (!sha) continue;
            let variant = s.variant || null;
            if (!variant && s.patch) {
                const f = resolveIn(r, s.patch);
                variant = exists(f) ? `patch-${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8)}` : null;
            }
            add(`${sha.slice(0, 12)}${variant ? `-${variant}` : ''}.${s.profile || profile}`, path.basename(r));
        }
    } catch {
        // not a run dir
    }
}
// a clone other work still needs: pinned by another run, or the tip of a local branch others are based on
let branchTips = null;
const repo = (() => {
    try {
        return mainCheckout(repoRoot(args.repo)) || repoRoot(args.repo);
    } catch {
        return null;
    }
})();
const baseOf = sha => {
    if (!repo || !sha) return null;
    try {
        branchTips ??= git(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/'], repo).split('\n').filter(Boolean).map(l => l.split(' '));
        const tips = branchTips.filter(([o]) => o === sha).map(([, n]) => n);
        if (!tips.length) return null;
        const on = git(['for-each-ref', '--contains', sha, '--format=%(objectname) %(refname:short)', 'refs/heads/'], repo).split('\n').filter(Boolean).map(l => l.split(' ')).filter(([o]) => o !== sha).map(([, n]) => n);

        return on.length ? `the tip of ${tips.slice(0, 3).join(', ')}${tips.length > 3 ? ', …' : ''}, which ${on.length} other local branch${on.length === 1 ? ' is' : 'es are'} based on (${on.slice(0, 3).join(', ')}${on.length > 3 ? ', …' : ''})` : null;
    } catch {
        return null;
    }
};
const shared = c => {
    const name = path.basename(c);
    const st = tryJson(path.join(c, '.perf-ab-build.json')) || {};
    const by = [...(usedBy[name] || [])];
    const others = args.run ? by.filter(r => r !== String(args.run)) : by.length > 1 ? by : [];
    const why = [others.length && `pinned by ${others.length === by.length && !args.run ? `${by.length} runs` : 'other runs'} (${others.join(', ')})`, baseOf(st.sha)].filter(Boolean);

    return why.length ? why.join('; ') : null;
};
const clones = ls(path.join(H, 'clones'));
const ageDays = p => (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
// in use by another run: a live session or exploration serving it, or a build holding its lock
const inUse = c => {
    const users = cloneUsers(c);
    const building = queue(`clone-${path.basename(c)}`);

    return users.length || building.length ? [...users.map(u => `${u.label || u.kind} of ${u.run || '?'} (pid ${u.pid})`), ...building.map(holderText)].join(', ') : null;
};
const remove = (p, why) => {
    const clone = p.includes(`${path.sep}clones${path.sep}`);
    const busy = clone ? inUse(p) : null;
    if (busy) {
        log('kept', p, `— in use: ${busy}`);

        return;
    }
    const keep = clone && !args.force ? shared(p) : null;
    if (keep) {
        log('kept', p, `— shared: ${keep}. The next run on this base would rebuild it (~2.5 min); --force removes it anyway`);

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
        const base = baseOf(st.sha);
        console.log(`  ${path.basename(c).padEnd(38)} ${gib(du(c)).padStart(10)}  ${Object.keys(st.targets || {}).filter(t => st.targets[t].ok).join('+') || 'no build'}${st.profile ? '' : ' (no profile: from before profiles, not reused)'}  ${ageDays(c).toFixed(1)} d  ${usedBy[path.basename(c)] ? 'used by ' + [...usedBy[path.basename(c)]].join(', ') : ''}${base ? ` · base: ${base}` : ''}${busy ? ` · IN USE: ${busy}` : ''}`);
    }
    console.log('\nruns:');
    for (const r of runs) console.log(`  ${path.basename(r).padEnd(34)} ${gib(du(r)).padStart(10)}  ${exists(path.join(r, 'report.html')) ? 'report' : ''}`);
    const apps = ls(path.join(H, 'apps'));
    if (apps.length) console.log(`\ndesktop user-data dirs: ${apps.map(a => path.basename(a)).join(', ')} (--apps removes them)`);
    // live lock queues (dead tickets are dropped by reading them)
    const locks = ls(path.join(H, 'locks')).map(d => [path.basename(d), queue(path.basename(d))]).filter(([, q]) => q.length);
    if (locks.length) console.log(`\nlocks:\n${locks.map(([n, q]) => `  ${n.padEnd(38)} ${holderText(q[0])}${q.length > 1 ? ` · ${q.length - 1} waiting` : ''}`).join('\n')}`);
}
