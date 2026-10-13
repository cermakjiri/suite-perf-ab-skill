/**
 * Before any build or timing: is this machine, checkout and run ready, and are the builds what
 * they claim to be? Prints one line per check and writes <run>/preflight.json when --run is given.
 *
 *   node preflight.mjs [--run=<name|dir>] [--target=web|desktop] [--device=synthetic|emulator] [--repo=<checkout>]
 *
 * Exit 1 when a check fails. Works inside the sandbox; with it on, `ps`, the docker socket and
 * local ports read "unknown" — run it outside for the full picture right before a timing plan.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, home, loadRun, sideOf, repoRoot, resolveFromRepo, importFromRepo, nvmrcNode, git, exists, readJson, writeJson, loadavg } from './lib.mjs';

const args = parseArgs();
const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const out = cmd => {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });

    return r.status === 0 ? (r.stdout || '').trim() : null;
};
const portOpen = port => new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = v => {
        s.destroy();
        resolve(v);
    };
    s.setTimeout(700, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', e => done(e.code === 'EPERM' ? null : false));
});
const grepCount = (dir, needle) => {
    // how many .js files of a build carry the needle (>0 vs 0 is what proves a side)
    const r = spawnSync('grep', ['-rlF', '--include=*.js', needle, dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

    return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean).length : r.status === 1 ? 0 : null;
};

const main = async () => {
    let run = null;
    if (args.run) run = loadRun(args.run);
    const target = args.target || (run && run.target) || 'web';
    const device = args.device || (run && run.device) || 'synthetic';

    // ------------------------------------------------------------ toolchain
    let repo = null;
    try {
        repo = repoRoot(args.repo || (run && run.repo));
        add('checkout', 'ok', repo);
    } catch (e) {
        add('checkout', 'fail', e.message);
    }
    if (repo) {
        const nvm = exists(path.join(repo, '.nvmrc')) ? (fs.readFileSync(path.join(repo, '.nvmrc'), 'utf8').match(/^\s*v?(\d+[\d.]*)/m) || [])[1] || null : null;
        const sameMajor = !nvm || nvm.split('.')[0] === process.versions.node.split('.')[0];
        add('node', sameMajor ? 'ok' : 'warn', `${process.version}${process.release.lts ? ` (LTS ${process.release.lts})` : ''} — the rig is written for the latest LTS line (24); the checkout's .nvmrc is ${nvm}`);
        const b = nvmrcNode(repo);
        add('build node', b.exact ? 'ok' : 'warn', b.exact ? `${b.version} ${b.bin} (builds use each revision's .nvmrc Node)` : `.nvmrc ${b.want} is not installed — builds would use ${process.version} (nvm install ${b.want})`);
        try {
            const pw = readJson(resolveFromRepo(repo, 'playwright-core/package.json')).version;
            const exe = (await importFromRepo(repo, 'playwright-core')).chromium.executablePath();
            add('playwright', exists(exe) ? 'ok' : 'fail', `playwright-core ${pw}, chromium ${exists(exe) ? 'installed' : 'MISSING: yarn playwright install chromium'}`);
        } catch (e) {
            add('playwright', 'fail', e.message);
        }
        if (target === 'desktop') {
            try {
                const exe = await importFromRepo(repo, 'electron');
                const v = readJson(resolveFromRepo(repo, 'electron/package.json')).version;
                add('electron', exists(exe) ? 'ok' : 'fail', `${v} ${exe}`);
            } catch (e) {
                add('electron', 'fail', e.message);
            }
        }
        try {
            const head = git(['rev-parse', '--short=10', 'HEAD'], repo);
            const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
            const dirty = git(['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=no'], repo).split('\n').filter(Boolean).length;
            add('checkout state', 'ok', `${branch} @ ${head}, ${dirty} tracked changes (the rig never touches it; builds happen in clones)`);
        } catch (e) {
            add('checkout state', 'warn', e.message.split('\n')[0]);
        }
    }
    add('python3', out(['python3', '--version']) ? 'ok' : 'fail', out(['python3', '--version']) || 'missing (clone.py needs it)');

    // ------------------------------------------------------------ machine
    const H = home();
    try {
        fs.mkdirSync(H, { recursive: true });
        fs.accessSync(H, fs.constants.W_OK);
        add('run home', 'ok', H);
    } catch (e) {
        add('run home', 'fail', `${H}: ${e.message}`);
    }
    const df = out(['df', '-k', H]);
    if (df) {
        const freeGb = Number(df.split('\n').pop().trim().split(/\s+/)[3]) / 1048576;
        add('disk free', freeGb < 10 ? 'fail' : freeGb < 30 ? 'warn' : 'ok', `${freeGb.toFixed(0)} GiB on the run home's volume (a built clone holds ~1-2 GiB, desktop more)`);
    }
    const ncpu = os.cpus().length;
    const la = loadavg();
    // the performance-core gate (rig/pcore.mjs) makes a busy machine wait instead of skewing numbers —
    // fully only with per-thread counters and a core map (contention judged): only then is the load
    // average no longer a concern
    let fullGate = false;
    try {
        const { helper, machine } = await import('./pcore.mjs');
        helper();
        const m = await machine();
        fullGate = !!(m.pIndices && m.threadCounts);
        const map = m.pIndices ? `performance cores are os.cpus() ${m.pIndices.join(',')}${m.verified === false ? ' (assumed: the check was spoiled, retried later)' : ''}` : 'no core map: contention cannot be judged';
        add('performance-core gate', fullGate && m.verified !== false ? 'ok' : 'warn', `${map}, per-thread counters ${m.threadCounts ? 'readable' : 'refused (process fallback, no watchdog)'} — measured iterations wait for a free performance core and are retried when contention or a demotion pushes them onto efficiency cores`);
    } catch (e) {
        add('performance-core gate', 'warn', `off: ${e.message} — measured iterations run wherever macOS puts them; keep the machine quiet (plan.mjs --max-load=N)`);
    }
    add('load average', la[0] > ncpu * 0.5 && !fullGate ? 'warn' : 'ok', `${la.join(' ')} on ${ncpu} cores${fullGate ? ' — the performance-core gate waits for free cores (bursts under ~100 ms go unseen: quieter is still cleaner)' : ' — perf passes want a quiet machine (plan.mjs --max-load=N waits for it)'}`);
    const top = out(['ps', '-Ao', 'pcpu,comm', '-r']);
    if (top) {
        const busy = top.split('\n').slice(1, 6).map(l => l.trim()).filter(l => parseFloat(l) >= 20);
        add('busy processes', busy.length ? 'warn' : 'ok', busy.length ? busy.map(l => l.replace(/\s+/, '% ').replace(/^(\S+% )(.*\/)?/, '$1')).join('; ') : 'none above 20% CPU');
    } else {
        add('busy processes', 'warn', 'unknown (ps is blocked inside the sandbox)');
    }
    const batt = out(['pmset', '-g', 'batt']);
    if (batt) add('power', /AC Power/.test(batt) ? 'ok' : 'warn', /AC Power/.test(batt) ? 'AC' : 'battery: CPU scaling differs, plug in for timing');
    add('cpu', 'ok', `${os.cpus()[0] && os.cpus()[0].model}, ${Math.round(os.totalmem() / 1073741824)} GiB`);
    const p9222 = await portOpen(9222);
    add('port 9222', p9222 === null ? 'warn' : p9222 ? 'warn' : 'ok', p9222 === null ? 'unknown (sandbox)' : p9222 ? 'in use — open.mjs and the MCPs need it free (another session or browser?)' : 'free (open.mjs + MCPs)');
    const p8000 = await portOpen(8000);
    if (p8000) add('dev server :8000', 'warn', 'a dev server is running — fine for the rig (builds are separate), but it costs CPU during timing');
    if (device === 'emulator') {
        const d = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
        add('docker', d.status === 0 ? 'ok' : 'fail', d.status === 0 ? `server ${d.stdout.trim()}` : 'not reachable: open -a Docker (outside the sandbox)');
        for (const [n, p] of [['tenv controller', 9001], ['tenv MCP (SSE)', 9003], ['bridge', 21328]]) {
            const o = await portOpen(p);
            add(n, o ? 'ok' : 'warn', `:${p} ${o === null ? 'unknown (sandbox)' : o ? 'open' : 'closed — node tenv.mjs up'}`);
        }
    }

    // ------------------------------------------------------------ the run
    if (run) {
        add('run', 'ok', `${run.dir} — target ${target}, device ${device}, scenario ${run.scenario}`);
        for (const key of Object.keys(run.sides || {})) {
            const side = sideOf(run, key);
            if (side.url) {
                add(`side ${key}`, 'warn', `deployed preview ${side.url}: check coverage instrumentation in-page (env.coverageFiles) — PR previews are Istanbul-instrumented`);
                continue;
            }
            const dir = target === 'desktop' ? side.desktop && path.join(side.desktop, 'build') : side.web;
            if (!dir || !exists(dir)) {
                add(`side ${key}`, 'fail', `no ${target} build yet — node build.mjs --run=${path.basename(run.dir)} --targets=${target}`);
                continue;
            }
            const js = path.join(dir, 'js');
            const main = exists(js) ? fs.readdirSync(js).find(f => /^main\.[0-9a-f]{8,}\.js$/.test(f) || /^app\.[0-9a-f]{8,}\.js$/.test(f)) : null;
            const devBuild = exists(path.join(js, 'app.js')) || exists(path.join(js, 'main.js'));
            const cov = grepCount(dir, '__coverage__');
            const markers = Object.entries(side.markers || {}).map(([n, want]) => {
                const c = grepCount(dir, n);

                return { n, want, c, ok: c !== null && (want === 0 ? c === 0 : c > 0) };
            });
            const bad = devBuild || cov > 0 || markers.some(m => !m.ok);
            add(`side ${key}`, bad ? 'fail' : 'ok', `${side.label || ''} ${String(side.sha || side.rev).slice(0, 10)} ${target} build ${devBuild ? 'is a DEV build' : main ? 'production' : '(no hashed main chunk)'}; coverage files ${cov}; markers ${markers.map(m => `${JSON.stringify(m.n)} in ${m.c} files (want ${m.want ? '>0' : 0})`).join(', ') || 'none set — add one per side'}`);
            if (target === 'desktop' && !exists(path.join(side.desktop, 'dist', 'app.js'))) add(`side ${key} main`, 'fail', 'dist/app.js missing — build:app did not run');
        }
    }

    const icon = { ok: '  ok ', warn: 'WARN ', fail: 'FAIL ' };
    for (const c of checks) console.log(`${icon[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
    if (run) writeJson(path.join(run.dir, 'preflight.json'), { at: new Date().toISOString(), checks });
    if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
};

await main();
