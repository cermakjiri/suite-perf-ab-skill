/**
 * Exploration session: one side of a run, seeded exactly as a timing session would be, left open
 * with CDP on 127.0.0.1:9222 (the first free port from 9222 on, when another session holds it) so
 * the MCPs can attach:
 *
 *   playwright MCP               (`playwright mcp --cdp-endpoint=http://127.0.0.1:9222`)
 *       browser_snapshot for testids/roles, browser_evaluate / browser_run_code_unsafe to prototype
 *       the scenario's page.js against the live app (window.__H and window.__A are installed)
 *   chrome-devtools-electron MCP (`chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`)
 *       performance_start_trace / performance_analyze_insight, take_heapsnapshot, list_console_messages
 *       — works for a web side too: it attaches to whatever listens on :9222
 *
 *   node open.mjs --run=<name|dir> --side=B [--target=web|desktop] [--port=9222|auto] [--headed]
 *        [--no-seed] [--minutes=90] [--cfg.<key>=<value>]
 *
 * Start it with run_in_background and the sandbox off; it prints "READY" and stays up until
 * killed, --minutes pass, or the window is closed. Never take timing numbers from an
 * MCP-attached page: the DevTools MCP enables the V8 debugger, which makes array spreads ~20x
 * slower. Timings come from plan.mjs/run.mjs only. Only one MCP should drive the page at a time.
 *
 * Parallel runs: the port is the first free one from 9222 unless --port names one (the MCPs as
 * configured attach to 9222 only: another port means pointing the MCP there); the session's pid,
 * port and URL go to <run>/open-<side>.json; the web profile is per run and side. It registers as a
 * user of the clone it serves and, with device=emulator, holds the emulator until it closes — it
 * never takes the machine slot, so another run's timing session next to it sees its CPU as load.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RIG, parseArgs, loadRun, sideOf, resolveIn, repoRoot, writeJson, home, log, importScenario } from './lib.mjs';
import { launch } from './launch.mjs';
import { acquire, holderText, cloneOf, useClone } from './locks.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const side = sideOf(run, args.side || 'B');
const repo = repoRoot(args.repo || run.repo);
const target = args.target || run.target || 'web';
const device = run.device || 'synthetic';
const network = run.network || (device === 'synthetic' ? 'none' : 'live');
const RUN_ID = run.id || path.basename(run.dir);
const scenarioFile = resolveIn(run.dir, run.scenario);
const scenario = await importScenario(scenarioFile);
const cfg = Object.assign({}, scenario.cfg, run.cfg, args.cfg);
const pageFile = path.resolve(path.dirname(scenarioFile), scenario.page || 'page.js');
const initScript = [
    'window.Playwright = true;',
    `window.__CFG = ${JSON.stringify(cfg)};`,
    `window.__RUN = ${JSON.stringify({ k: 8, rates: [1], iterations: 40, side: side.key, target, device, explore: true })};`,
    fs.readFileSync(path.join(RIG, 'page', 'core.js'), 'utf8'),
    fs.readFileSync(pageFile, 'utf8'),
].join('\n');

const busy = port => new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
        s.destroy();
        resolve(true);
    });
    s.once('error', () => resolve(false));
});

// the first free port from 9222 (another exploration, a peer session or a Chrome with remote debugging may hold it)
const freePort = async () => {
    if (args.port && args.port !== 'auto') {
        const p = Number(args.port);
        if (await busy(p)) throw new Error(`127.0.0.1:${p} is taken (another open.mjs, a peer session, a Chrome with remote debugging?) — stop it, or leave --port out to take the next free one`);

        return p;
    }
    for (let p = 9222; p < 9300; p++) if (!(await busy(p))) return p;
    throw new Error('no free port in 9222-9299');
};

const main = async () => {
    // the clone this session serves must not be rebuilt underneath it; the emulator is held while it is open
    useClone(cloneOf(target === 'desktop' ? side.desktop : side.web), { kind: 'explore', run: RUN_ID, label: `open ${side.key}` });
    if (device === 'emulator' && !(run.emulator && run.emulator.prepare === false)) {
        let next = 0;
        await acquire('emulator', { kind: 'explore', run: RUN_ID, label: `open ${side.key}` }, {
            onWait: w => {
                if (Date.now() < next) return;
                next = Date.now() + 30000;
                log(`waiting for the emulator · ${holderText(w.holder)}`);
            },
        });
        log('emulator', JSON.stringify(await (await import('./tenv.mjs')).prepare(run.emulator || {})));
    }
    // two explorations started together would both find 9222 free: pick the port and bind it one at a time
    const portLock = await acquire('cdp-port', { kind: 'explore', run: RUN_ID, label: `open ${side.key}` });
    const PORT = await freePort();
    if (PORT !== 9222) log(`port 9222 is taken: CDP on ${PORT} — the MCPs as configured attach to 9222 only (point them at http://127.0.0.1:${PORT}, or stop the other session)`);
    let L;
    try {
        L = await launch(target, { repo, side, initScript, headed: !!args.headed, cdpPort: PORT, device, network, tag: `${RUN_ID}-open-${side.key}`, userDataDir: path.join(home(), 'profiles', `${RUN_ID}-web-${side.key}`), lateInject: true });
    } finally {
        portLock.release();
    }
    const { page } = L;
    const ev = (fn, a) => page.evaluate(fn, a);
    await L.open();
    await page.waitForFunction(() => window.__A && window.__H && (window.__A.ready ? window.__A.ready() : !!window.__H.store()), null, { timeout: 90000 });
    if (!args.noSeed) {
        log('seed', JSON.stringify(await ev(() => (window.__A.seed ? window.__A.seed() : null))));
        await page.waitForFunction(() => (window.__A.isReady ? window.__A.isReady() : window.__H.suiteReady()), null, { timeout: 180000, polling: 250 });
        log('postInit', JSON.stringify(await ev(() => (window.__A.postInit ? window.__A.postInit() : null))).slice(0, 300));
        if (scenario.route) log('route', await ev(r => window.__H.goto(r.name, r.params), typeof scenario.route === 'string' ? { name: scenario.route } : scenario.route));
    }
    const info = { pid: process.pid, port: PORT, cdp: `http://127.0.0.1:${PORT}`, side: side.key, label: side.label, target, url: page.url(), run: run.dir, started: new Date().toISOString() };
    const infoFile = path.join(run.dir, `open-${side.key}.json`);
    writeJson(infoFile, info);
    log(`READY ${target} side ${side.key} on ${info.cdp} — ${info.url}`);
    if (L.probesLate && L.probesLate()) log('note: desktop with a fixed CDP port loads before the init script — probes injected after boot, React commit counts are not available in this session');
    log('in the page: window.__H (probes, store, findThunk, goto, runPhase), window.__A (the scenario: seed/postInit/phases/after)');
    let stopping = false;
    const stop = async why => {
        if (stopping) return;
        stopping = true;
        log('closing:', why);
        await L.close();
        fs.rmSync(infoFile, { force: true });
        process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    page.on('close', () => stop('window closed'));
    setTimeout(() => stop(`${args.minutes || 90} minutes passed`), Number(args.minutes || 90) * 60000);
};

await main().catch(e => {
    console.error(e?.stack ?? e);
    process.exit(1);
});
