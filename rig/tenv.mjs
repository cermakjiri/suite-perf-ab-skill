/**
 * trezor-user-env (emulator + bridge + optional regtest backend) for runs with device=emulator,
 * and the controller client run.mjs uses to put the emulator into a known state per session.
 *
 *   node tenv.mjs up [--regtest] [--pull]  start (or resume) the container; regtest adds the blockbook sidecar
 *   node tenv.mjs status             containers and which ports answer
 *   node tenv.mjs prepare [--model=T3T1] [--fw=2-latest] [--mnemonic=mnemonic_all|"12 words"] [--passphrase]
 *                                    wipe + start the emulator, load the seed, start the bridge
 *   node tenv.mjs yes [n] | no | screen | features | stop | down
 *
 * The repo's compose files use network_mode: host, which Docker Desktop on macOS lacks, so ports are
 * published one by one. The emulator MCP (`trezor-emulator`, SSE on :9003) is served by the same
 * container; it connects only if the container was up when the Claude session started.
 * One emulator serves the whole machine: run.mjs and open.mjs hold the `emulator` lock (rig/locks.mjs)
 * while they use it, and `down` / `prepare` refuse while someone else holds it (--force overrides).
 * Run OUTSIDE the Bash sandbox: the docker socket and local WebSockets are denied inside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, log, sleep, dur } from './lib.mjs';

const NAME = 'perf-ab-tenv';
const REGTEST = 'perf-ab-tenv-regtest';
const PORTS = { controller: 9001, dashboard: 9002, mcp: 9003, bridge: 21328, regtestBlockbook: 19121 };
const PUBLISHED = [9001, 9002, 9003, 21328, 19121, 19021, 18021];
const MNEMONICS = { mnemonic_all: 'all all all all all all all all all all all all', mnemonic_12: 'alcohol woman abuse must during monitor noble actual mixed trade anger aisle' };

const docker = (argv, allowFail = false) => {
    const r = spawnSync('docker', argv, { encoding: 'utf8' });
    if (r.status !== 0 && !allowFail) throw new Error(`docker ${argv.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);

    return (r.stdout || '').trim();
};
const stateOf = name => docker(['inspect', '-f', '{{.State.Status}}', name], true) || 'absent';
const tcpOpen = (port, host = '127.0.0.1', ms = 800) => new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = ok => {
        s.destroy();
        resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
});
// a progress line every 10 s of a wait: what, how long so far, the timeout
const waiting = (what, timeoutMs, t0 = Date.now()) => {
    let next = t0 + 10000;

    return () => {
        if (Date.now() < next) return;
        log(`waiting for ${what} · ${dur(Date.now() - t0)} of ${dur(timeoutMs)}`);
        next += 10000;
    };
};
const waitPort = async (port, ms, what = `port ${port}`) => {
    const t0 = Date.now();
    const tick = waiting(what, ms, t0);
    while (Date.now() - t0 < ms) {
        if (await tcpOpen(port)) return true;
        tick();
        await sleep(1000);
    }

    return false;
};
/**
 * The image the repo's e2e compose file pins — if it is pulled. The image is ~5.5 GB and is never
 * downloaded implicitly: without --pull a missing pinned tag falls back to the newest local
 * trezor-user-env image (both sides of a run share one emulator, so its version is not part of the
 * comparison), and with no local image at all `up` stops and says so. TENV_IMAGE overrides.
 */
const image = (repo, pull) => {
    if (process.env.TENV_IMAGE) return process.env.TENV_IMAGE;
    const y = fs.readFileSync(path.join(repo, 'docker', 'docker-compose.suite-ci-e2e.yml'), 'utf8');
    const m = y.match(/ghcr\.io\/trezor\/trezor-user-env:[0-9a-f]{40}/);
    if (!m) throw new Error('trezor-user-env image tag not found in docker/docker-compose.suite-ci-e2e.yml');
    const pinned = m[0];
    const local = docker(['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}'], true).split('\n')
        .map(l => l.split('\t')).filter(([n]) => n && n.startsWith('ghcr.io/trezor/trezor-user-env:'));
    if (local.some(([n]) => n === pinned)) return pinned;
    if (pull) {
        log(`pulling ${pinned} (~5.5 GB)`);
        docker(['pull', pinned]);

        return pinned;
    }
    if (!local.length) throw new Error(`no trezor-user-env image is pulled — \`tenv.mjs up --pull\` downloads ${pinned} (~5.5 GB)`);
    const newest = local.sort((a, b) => String(b[1]).localeCompare(String(a[1])))[0][0];
    log(`pinned ${pinned} is not pulled; using local ${newest} (--pull fetches the pinned one, ~5.5 GB)`);

    return newest;
};
// another tenv (the QA harness's qa-trezor-user-env, a manual `trezor-user-env`) already serving the ports
const foreign = () => docker(['ps', '--format', '{{.Names}}\t{{.Ports}}'], true).split('\n').filter(Boolean).map(l => l.split('\t'))
    .filter(([n, p]) => n !== NAME && n !== REGTEST && /:(9001|21328)->/.test(p || ''));

// Docker Desktop answers `docker info` while its engine still returns 500 to everything else; an
// empty `docker images` from a half-started engine must not read as "no images" (that would pull)
const engineReady = async (timeoutMs = 120000) => {
    const t0 = Date.now();
    const tick = waiting('the Docker engine', timeoutMs, t0);
    while (Date.now() - t0 < timeoutMs) {
        if (spawnSync('docker', ['ps', '-q'], { encoding: 'utf8' }).status === 0) return true;
        tick();
        await sleep(2000);
    }

    return false;
};
const up = async ({ regtest = false, repo, pull = false }) => {
    if (!(await engineReady())) throw new Error('Docker engine not ready: start Docker Desktop (open -a Docker) and wait for it, then re-run outside the sandbox');
    const others = foreign();
    if (others.length) {
        log(`reusing ${others.map(o => o[0]).join(', ')} (already serves the controller/bridge ports)`);

        return status();
    }
    const st = stateOf(NAME);
    if (st === 'absent') {
        const img = image(repo, pull);
        log(`starting ${NAME} from ${img}`);
        docker(['run', '-d', '--name', NAME, ...PUBLISHED.flatMap(p => ['-p', `${p}:${p}`]), '-e', 'SDL_VIDEODRIVER=dummy', '-e', 'XDG_RUNTIME_DIR=/var/tmp', img]);
    } else if (st !== 'running') {
        docker(['start', NAME]);
    }
    if (regtest) {
        const rs = stateOf(REGTEST);
        if (rs === 'absent') docker(['run', '-d', '--name', REGTEST, '--network', `container:${NAME}`, 'ghcr.io/trezor/trezor-user-env-regtest']);
        else if (rs !== 'running') docker(['start', REGTEST]);
    }
    (await openSocket()).close();
    log(`controller :${PORTS.controller} answers`);
    if (regtest) log(`regtest blockbook :${PORTS.regtestBlockbook} ${(await waitPort(PORTS.regtestBlockbook, 180000, `regtest blockbook :${PORTS.regtestBlockbook}`)) ? 'up' : 'TIMEOUT'}`);

    return status();
};
const status = async () => {
    const out = { containers: {}, ports: {} };
    for (const n of [NAME, REGTEST]) out.containers[n] = stateOf(n);
    for (const o of foreign()) out.containers[o[0]] = 'running (foreign)';
    for (const [k, p] of Object.entries(PORTS)) out.ports[`${k}:${p}`] = await tcpOpen(p);

    return out;
};
const down = () => {
    for (const n of [REGTEST, NAME]) docker(['rm', '-f', n], true);

    return status();
};

// ------------------------------------------------------------------ controller client
// Docker publishes ports before the container serves them, so "port open" proves nothing: retry
// the WebSocket handshake itself until the controller answers.
const openSocket = async (timeoutMs = 90000) => {
    const t0 = Date.now();
    const tick = waiting(`the controller ws://127.0.0.1:${PORTS.controller}`, timeoutMs, t0);
    for (;;) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORTS.controller}/`);
        const { promise, resolve } = Promise.withResolvers();
        ws.addEventListener('open', () => resolve(true), { once: true });
        ws.addEventListener('error', () => resolve(false), { once: true });
        if (await promise) return ws;
        if (Date.now() - t0 > timeoutMs) throw new Error(`cannot reach ws://127.0.0.1:${PORTS.controller} — tenv up? sandbox off?`);
        tick();
        await sleep(1500);
    }
};
const controller = async () => {
    const ws = await openSocket();
    const pending = new Map();
    let id = 0;
    ws.addEventListener('message', ({ data }) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        const k = String(msg.id);
        if (pending.has(k)) {
            pending.get(k)(msg);
            pending.delete(k);
        }
    });
    const send = (type, params = {}, timeoutMs = 180000) => {
        const { promise, resolve, reject } = Promise.withResolvers();
        const k = String(++id);
        const t = setTimeout(() => {
            pending.delete(k);
            reject(new Error(`${type} timed out`));
        }, timeoutMs);
        pending.set(k, msg => {
            clearTimeout(t);
            const err = msg.error?.message ?? msg.error;
            // a debug-link ReadTimeout is not fatal (trezor-user-env-link treats it the same)
            if (msg.success === false && !String(err).includes('ReadTimeout')) reject(new Error(`${type}: ${err ?? JSON.stringify(msg)}`));
            else resolve(msg.response ?? msg);
        });
        ws.send(JSON.stringify({ id: k, type, ...params }));

        return promise;
    };

    return { send, close: () => ws.close() };
};

/**
 * Known emulator state for one session: wiped, seeded, bridge on. Default seed "all all ... all"
 * has real history on mainnet backends (network=live) — real data, real discovery.
 */
const prepare = async (opts = {}) => {
    const model = opts.model || 'T3T1';
    const fw = opts.fw || (model === 'T1B1' ? '1-latest' : '2-latest');
    const mnemonic = (opts.mnemonic || '').includes(' ') ? opts.mnemonic : MNEMONICS[opts.mnemonic || 'mnemonic_all'];
    const c = await controller();
    try {
        await c.send('bridge-stop');
        await c.send('emulator-stop');
        await c.send('emulator-start', { model, version: fw, wipe: true });
        await c.send('emulator-setup', { mnemonic, pin: '', passphrase_protection: !!opts.passphrase, label: opts.label || 'Perf Trezor', needs_backup: false });
        await c.send('bridge-start', { version: 'node-bridge' });
        const bridge = await fetch(`http://127.0.0.1:${PORTS.bridge}/status/`, { headers: { Origin: 'http://suite.localhost' } }).then(r => r.status).catch(e => e.message);

        return { model, fw, seed: mnemonic.split(' ')[0] + '…', bridge };
    } finally {
        c.close();
    }
};

export { PORTS, up, status, down, prepare, controller };

if (import.meta.main) {
    const a = parseArgs();
    const cmd = a._[0];
    (async () => {
        const repo = repoRoot(a.repo);
        let r;
        if (cmd === 'up') r = await up({ regtest: !!a.regtest, repo, pull: !!a.pull });
        else if (cmd === 'status') r = await status();
        else if (cmd === 'down' || cmd === 'prepare') {
            // the emulator is shared by every run on this machine: a session or exploration holding it is using it
            const { queue, holderText } = await import('./locks.mjs');
            const busy = queue('emulator').filter(t => t.pid !== process.pid);
            if (busy.length && !a.force) {
                console.error(`the emulator is in use: ${busy.map(holderText).join('; ')} — ${cmd === 'down' ? 'stopping it would break that session' : 'preparing wipes it under that session'} (--force to do it anyway)`);
                process.exit(1);
            }
            r = cmd === 'down' ? await down() : await prepare({ model: a.model, fw: a.fw, mnemonic: a.mnemonic, passphrase: !!a.passphrase, label: a.label });
        }
        else if (['yes', 'no', 'screen', 'features', 'stop'].includes(cmd)) {
            const c = await controller();
            const type = { yes: 'emulator-press-yes', no: 'emulator-press-no', screen: 'emulator-get-screen-content', features: 'emulator-get-features', stop: 'emulator-stop' }[cmd];
            const times = cmd === 'yes' ? Number(a._[1] || 1) : 1;
            for (let i = 0; i < times; i++) {
                await sleep(200); // button-request race (trezor-suite#23270)
                r = await c.send(type);
            }
            c.close();
        } else {
            console.error('usage: node tenv.mjs up [--regtest] | status | prepare [--model --fw --mnemonic] | yes [n] | no | screen | features | stop | down');
            process.exit(1);
        }
        console.log(JSON.stringify(r, null, 1));
    })().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}
