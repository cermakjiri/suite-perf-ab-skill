/**
 * Exploration session: one side of a run, seeded exactly as a timing session would be, left open
 * with CDP on 127.0.0.1:9222 so the MCPs can attach:
 *
 *   playwright MCP               (`playwright mcp --cdp-endpoint=http://127.0.0.1:9222`)
 *       browser_snapshot for testids/roles, browser_evaluate / browser_run_code_unsafe to prototype
 *       the scenario's page.js against the live app (window.__H and window.__A are installed)
 *   chrome-devtools-electron MCP (`chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`)
 *       performance_start_trace / performance_analyze_insight, take_heapsnapshot, list_console_messages
 *       — works for a web side too: it attaches to whatever listens on :9222
 *
 *   node open.mjs --run=<name|dir> --side=B [--target=web|desktop] [--port=9222] [--headed]
 *        [--no-seed] [--minutes=90] [--cfg.<key>=<value>]
 *
 * Start it with run_in_background and the sandbox off; it prints "READY" and stays up until
 * killed, --minutes pass, or the window is closed. Never take timing numbers from an
 * MCP-attached page: the DevTools MCP enables the V8 debugger, which makes array spreads ~20x
 * slower. Timings come from plan.mjs/run.mjs only. Only one MCP should drive the page at a time.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RIG, parseArgs, loadRun, sideOf, resolveIn, repoRoot, writeJson, home, log, importScenario } from './lib.mjs';
import { launch } from './launch.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const side = sideOf(run, args.side || 'B');
const repo = repoRoot(args.repo || run.repo);
const target = args.target || run.target || 'web';
const device = run.device || 'synthetic';
const network = run.network || (device === 'synthetic' ? 'none' : 'live');
const PORT = Number(args.port || 9222);
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

const main = async () => {
    if (await busy(PORT)) throw new Error(`127.0.0.1:${PORT} is taken (another open.mjs, a peer session, a Chrome with remote debugging?) — stop it or pass --port`);
    if (device === 'emulator' && !(run.emulator && run.emulator.prepare === false)) log('emulator', JSON.stringify(await (await import('./tenv.mjs')).prepare(run.emulator || {})));
    const L = await launch(target, { repo, side, initScript, headed: !!args.headed, cdpPort: PORT, device, network, tag: `open-${side.key}`, lateInject: true });
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
    writeJson(path.join(home(), 'open.json'), info);
    log(`READY ${target} side ${side.key} on ${info.cdp} — ${info.url}`);
    if (L.probesLate && L.probesLate()) log('note: desktop with a fixed CDP port loads before the init script — probes injected after boot, React commit counts are not available in this session');
    log('in the page: window.__H (probes, store, findThunk, goto, runPhase), window.__A (the scenario: seed/postInit/phases/after)');
    let stopping = false;
    const stop = async why => {
        if (stopping) return;
        stopping = true;
        log('closing:', why);
        await L.close();
        try {
            fs.unlinkSync(path.join(home(), 'open.json'));
        } catch {
            // already gone
        }
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
