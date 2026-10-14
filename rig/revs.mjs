/**
 * Pin the two revisions of a run: the target branch (side A) and the feature branch (side B), after
 * checking that the feature branch is up to date with its target. Writes run.json's `base` and
 * `sides.A/B.rev` (full SHAs), creating the run folder from rig/templates/ when it does not exist.
 *
 *   node revs.mjs --run=<id> --pr=<number|url>                   base = the PR's target branch (gh)
 *   node revs.mjs --run=<id> --branch=<name|sha> [--base=develop]
 *        [--accept-behind=merge-base|merge-ref] [--no-fetch] [--repo=<checkout>] [--json]
 *
 * Up to date = every commit of the target branch's tip is in the feature branch (merge-base == tip):
 * then A = the target's tip, B = the head, exactly the branch's own commits apart. Behind = the target
 * moved on since the branch forked. Comparing the head with today's tip would then charge the
 * target's newer commits to the branch, and comparing with the old fork point measures the change on
 * a base that no longer exists — either can be inconclusive. So a branch that is behind stops here
 * (exit 3) with what moved on the target, and the advice to rebase first. Only on an explicit choice:
 *   --accept-behind=merge-base  A = the fork point, B = the head: the branch's own commits on its old
 *                               base (the report carries the caveat)
 *   --accept-behind=merge-ref   A = first parent, B = GitHub's refs/pull/<n>/merge: the PR applied to
 *                               the target as CI tests it (a PR only; not when it conflicts)
 *
 * Fetches into the main checkout: origin/<base> and refs/perf-ab/pull/<n>/{head,merge} (a namespace
 * of the rig's own, so the commits stay reachable until the clones are built; cleanup.mjs --refs
 * drops it). Exit 0 pinned, 3 behind (nothing pinned), 2 error. Runs in the sandbox (network: github.com).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RIG, parseArgs, runDir, readJson, writeJson, exists, repoRoot, mainCheckout, git, log } from './lib.mjs';

const args = parseArgs();
const ACCEPT = args.acceptBehind ? String(args.acceptBehind) : null;
if (ACCEPT && !['merge-base', 'merge-ref'].includes(ACCEPT)) throw new Error('--accept-behind is merge-base or merge-ref');
if (!args.run) throw new Error('--run=<id> is required');
if (!args.pr && !args.branch) throw new Error('--pr=<number|url> or --branch=<name|sha> is required');

const repo = mainCheckout(repoRoot(args.repo)) || repoRoot(args.repo);
const short = s => (s ? s.slice(0, 10) : '–');
const tryGit = argv => {
    try {
        return git(argv, repo);
    } catch {
        return null;
    }
};
const fail = (msg, code = 2) => {
    console.error(msg);
    process.exit(code);
};

// ------------------------------------------------------------------ the run folder
const dir = runDir(args.run);
const file = path.join(dir, 'run.json');
if (!exists(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tpl = readJson(path.join(RIG, 'templates', 'run.json'));
    writeJson(file, Object.assign(tpl, { id: path.basename(dir) }));
    if (!exists(path.join(dir, 'plan.json'))) fs.copyFileSync(path.join(RIG, 'templates', 'plan.json'), path.join(dir, 'plan.json'));
    log(`created ${dir} (run.json, plan.json from rig/templates)`);
}
const run = readJson(file);

// ------------------------------------------------------------------ what to compare
const slugOf = () => {
    const url = tryGit(['remote', 'get-url', 'origin']) || '';
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);

    return m ? m[1] : 'trezor/trezor-suite';
};
let pr = null;
let base = args.base ? String(args.base) : null;
let headRef = null;
const refspecs = [];
if (args.pr) {
    const m = String(args.pr).match(/(?:github\.com\/([^/]+\/[^/]+)\/pull\/)?(\d+)\/?$/);
    if (!m) fail(`--pr=${args.pr}: not a PR number or URL`);
    const slug = m[1] || slugOf();
    const number = Number(m[2]);
    const gh = spawnSync('gh', ['pr', 'view', String(number), '--repo', slug, '--json', 'number,title,url,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,state,isDraft'], { encoding: 'utf8' });
    if (gh.status === 0) {
        const j = JSON.parse(gh.stdout);
        pr = { number, url: j.url, title: j.title, headRefName: j.headRefName, headSha: j.headRefOid, cross: j.isCrossRepository, mergeable: j.mergeable, state: j.state, draft: j.isDraft, baseRefName: j.baseRefName };
        if (base && base !== j.baseRefName) log(`note: --base=${base} overrides the PR's target branch ${j.baseRefName}`);
        base = base || j.baseRefName;
    } else {
        pr = { number, url: `https://github.com/${slug}/pull/${number}` };
        base = base || 'develop';
        log(`warning: gh pr view failed (${(gh.stderr || gh.error || '').toString().trim().split('\n')[0]}) — target branch assumed ${base}; pass --base if the PR targets another branch`);
    }
    if (pr.state && pr.state !== 'OPEN') log(`note: PR #${number} is ${pr.state.toLowerCase()}`);
    headRef = `refs/perf-ab/pull/${number}/head`;
    refspecs.push(`+refs/pull/${number}/head:${headRef}`);
    if (ACCEPT === 'merge-ref') refspecs.push(`+refs/pull/${number}/merge:refs/perf-ab/pull/${number}/merge`);
} else {
    base = base || 'develop';
    const name = String(args.branch).replace(/^origin\//, '');
    // a pushed branch is fetched (with --no-fetch: its remote-tracking ref as it is); a local one or a sha is taken as it is
    const remote = /^[\w./-]+$/.test(name) && (args.noFetch
        ? !!tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])
        : spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', name], { cwd: repo, encoding: 'utf8' }).status === 0);
    if (remote) {
        headRef = `refs/remotes/origin/${name}`;
        refspecs.push(`+refs/heads/${name}:${headRef}`);
    } else {
        headRef = String(args.branch);
        if (!tryGit(['rev-parse', '--verify', `${headRef}^{commit}`])) fail(`--branch=${args.branch}: not on origin and not a local ref or commit`);
        log(`note: ${args.branch} is not a branch on origin — using the local ${tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${headRef}`]) ? 'branch' : 'revision'} as it is`);
    }
}
// a base on origin is fetched; a local-only branch (a stacked, unpushed base) is taken as it is
const baseOnOrigin = args.noFetch
    ? !!tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])
    : spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', base], { cwd: repo, encoding: 'utf8' }).status === 0;
const baseLocal = !baseOnOrigin && !!tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
const baseRef = baseLocal ? `refs/heads/${base}` : `refs/remotes/origin/${base}`;
if (baseLocal) log(`note: base ${base} is not a branch on origin — using the local branch as it is`);
else refspecs.unshift(`+refs/heads/${base}:${baseRef}`);

// ------------------------------------------------------------------ fetch
let fetchedAt = null;
if (!args.noFetch && refspecs.length) {
    // a parallel run fetching into the same checkout can hold a ref lock for a moment: retry once
    for (let attempt = 0; attempt < 2; attempt++) {
        // explicit refspecs only, and the user's FETCH_HEAD left alone
        const r = spawnSync('git', ['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', 'origin', ...refspecs], { cwd: repo, encoding: 'utf8' });
        if (r.status === 0) {
            fetchedAt = new Date().toISOString();
            break;
        }
        if (attempt) fail(`git fetch origin ${refspecs.join(' ')} failed:\n${(r.stderr || '').trim()}${ACCEPT === 'merge-ref' ? '\n(no merge ref: the PR conflicts with its target, or GitHub has not computed it yet)' : ''}`);
    }
}
const head = tryGit(['rev-parse', '--verify', `${headRef}^{commit}`]);
const tip = tryGit(['rev-parse', '--verify', `${baseRef}^{commit}`]);
if (!head) fail(`cannot resolve ${headRef}${args.noFetch ? ' (--no-fetch: fetch it first)' : ''}`);
if (!tip) fail(`cannot resolve origin/${base}${args.noFetch ? ' (--no-fetch: fetch it first)' : ''}`);
if (pr && pr.headSha && pr.headSha !== head) log(`note: GitHub reported head ${short(pr.headSha)}, the fetch got ${short(head)} (a push in between?) — pinning the fetched one`);
const mergeBase = tryGit(['merge-base', tip, head]);
if (!mergeBase) fail(`${short(head)} and origin/${base} share no history`);
const behind = Number(git(['rev-list', '--count', `${head}..${tip}`], repo));
const ahead = Number(git(['rev-list', '--count', `${tip}..${head}`], repo));
const what = pr ? `PR #${pr.number}${pr.headRefName ? ` ${pr.headRefName}` : ''}` : String(args.branch);
log(`${what} → ${base} · head ${short(head)} · ${ahead} commit${ahead === 1 ? '' : 's'} of its own${pr && pr.mergeable ? ` · ${pr.mergeable.toLowerCase()}` : ''}${pr && pr.draft ? ' · draft' : ''}`);
log(`base ${baseLocal ? '' : 'origin/'}${base} @ ${short(tip)}${baseLocal ? ' (local branch)' : fetchedAt ? ' (just fetched)' : ' (not fetched: --no-fetch)'} · merge-base ${short(mergeBase)}`);
if (!ahead) fail(`${what} has no commits on top of origin/${base}: nothing to compare (merged already, or the wrong branch?)`);

// ------------------------------------------------------------------ what moved on the target
const appPath = f => !/^(suite-native|docs|skills|\.github|\.husky|\.claude)\//.test(f) && !/\.(md|mdx|snap)$/.test(f) && !/(\.test|\.spec)\.[jt]sx?$|\/(__tests__|e2e|tests?)\//.test(f);
const changed = (a, b) => (tryGit(['diff', '--name-only', a, b]) || '').split('\n').filter(Boolean);
const baseInfo = {
    branch: base, tip, mergeBase, behind, ahead, checkedAt: new Date().toISOString(), fetchedAt,
    pr: pr && { number: pr.number, url: pr.url, title: pr.title || null, headRefName: pr.headRefName || null, cross: pr.cross ?? null, mergeable: pr.mergeable || null },
    head,
};
if (behind) {
    const moved = changed(mergeBase, tip);
    const ours = new Set(changed(mergeBase, head));
    // files both sides touched, app code only: where the target's newer commits can interact with the branch
    const overlap = moved.filter(f => ours.has(f) && appPath(f));
    const app = moved.filter(appPath);
    Object.assign(baseInfo, { movedFiles: moved.length, movedAppFiles: app.length, overlap: overlap.slice(0, 20), lockfile: moved.includes('yarn.lock') });
    const newest = (tryGit(['log', '--format=%h %s', '-n', '4', `${mergeBase}..${tip}`]) || '').split('\n').filter(Boolean);
    log(`BEHIND: ${behind} commit${behind === 1 ? '' : 's'} on ${base} are not in the branch — ${moved.length} files changed there since the merge-base, ${app.length} of them app code${overlap.length ? `, ${overlap.length} also changed by the branch (${overlap.slice(0, 4).join(', ')}${overlap.length > 4 ? ', …' : ''})` : ''}${baseInfo.lockfile ? '; yarn.lock moved' : ''}`);
    for (const l of newest) log(`   ${l.slice(0, 110)}`);
}

// ------------------------------------------------------------------ decide
let A;
let B;
let mode;
if (!behind) {
    mode = 'tip';
    A = { rev: tip, label: `${base}` };
    B = { rev: head, label: pr ? `PR #${pr.number}` : String(args.branch) };
} else if (ACCEPT === 'merge-base') {
    mode = 'merge-base';
    A = { rev: mergeBase, label: `${base} (merge-base)` };
    B = { rev: head, label: pr ? `PR #${pr.number}` : String(args.branch) };
    log(`accepted: measuring the branch's own commits on its old base (A = merge-base ${short(mergeBase)}); the report says it is ${behind} behind`);
} else if (ACCEPT === 'merge-ref') {
    if (!pr) fail('--accept-behind=merge-ref needs --pr (GitHub computes the merge ref per PR)');
    if (pr.mergeable === 'CONFLICTING') fail(`PR #${pr.number} conflicts with ${base}: there is no merge ref — the branch has to be rebased`);
    const mergeSha = tryGit(['rev-parse', '--verify', `refs/perf-ab/pull/${pr.number}/merge^{commit}`]);
    if (!mergeSha) fail(`no refs/pull/${pr.number}/merge fetched`);
    const [, p1, p2] = git(['rev-list', '--parents', '-n', '1', mergeSha], repo).split(' ');
    if (p2 !== head) fail(`GitHub's merge ref ${short(mergeSha)} was made for head ${short(p2)}, not ${short(head)} — it is recomputed when the PR is viewed (gh pr view ${pr.number}); try again in a minute`);
    const lag = Number(git(['rev-list', '--count', `${p1}..${tip}`], repo));
    mode = 'merge-ref';
    A = { rev: p1, label: `${base} (merge ref parent)` };
    B = { rev: mergeSha, label: `PR #${pr.number} merged into ${base}` };
    Object.assign(baseInfo, { mergeRef: mergeSha, mergeRefBase: p1, mergeRefLag: lag });
    log(`accepted: GitHub's merge of PR #${pr.number} into ${base} (B = ${short(mergeSha)}, A = its first parent ${short(p1)}${lag ? `, ${lag} commits behind origin/${base}` : ', the current tip'})`);
} else {
    baseInfo.state = 'behind';
    run.base = baseInfo;
    writeJson(file, run);
    const conflicting = pr && pr.mergeable === 'CONFLICTING';
    console.log([
        '',
        `→ Rebase the branch onto origin/${base} first${pr && pr.cross ? ' (the author has to: it comes from a fork)' : ''}, then pin again. Measured as it stands, the`,
        `  result can be inconclusive: against today's ${base} the PR would be charged with ${behind} commits it does not`,
        '  contain, and against its fork point the change is measured on a base that no longer exists.',
        '  Without a rebase, only on an explicit choice:',
        `    --accept-behind=merge-base   the branch's own commits on its old base (caveat in the report)`,
        conflicting ? `    (no merge ref: PR #${pr.number} conflicts with ${base})` : pr ? `    --accept-behind=merge-ref    GitHub's merge of the PR into ${base}, as CI tests it` : null,
    ].filter(l => l !== null).join('\n'));
    process.exit(3);
}

// ------------------------------------------------------------------ write run.json
baseInfo.mode = mode;
baseInfo.state = behind ? 'behind-accepted' : 'up-to-date';
// a side whose revision changed loses what build.mjs derived from the old one
const BUILT = ['sha', 'buildSha', 'web', 'desktop', 'clone', 'profile', 'fingerprint'];
const pin = (key, s) => {
    const old = (run.sides && run.sides[key]) || {};
    const keep = Object.fromEntries(Object.entries(old).filter(([k]) => !['rev', 'label', 'url'].includes(k) && (old.rev === s.rev || !BUILT.includes(k))));
    // template placeholders are not markers
    if (keep.markers && Object.keys(keep.markers).some(k => k.startsWith('<'))) delete keep.markers;

    return Object.assign({ label: s.label, rev: s.rev }, keep);
};
run.sides = Object.assign({}, run.sides, { A: pin('A', A), B: pin('B', B) });
run.base = baseInfo;
if (pr) {
    run.pr = pr.url;
    if (!run.title || run.title.includes('<')) run.title = `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`;
}
if (!run.id || run.id.includes('<')) run.id = path.basename(dir);
writeJson(file, run);
log(`pinned ${path.basename(dir)}: A ${short(A.rev)} (${A.label}) · B ${short(B.rev)} (${B.label}) · ${behind ? `behind ${behind}, accepted as ${mode}` : 'up to date'}`);
log(`next: node ${path.join(RIG, 'build.mjs')} --run=${path.basename(dir)} --targets=${run.target || 'web'}`);
if (args.json) console.log(JSON.stringify({ base: run.base, sides: { A: run.sides.A, B: run.sides.B } }, null, 1));
