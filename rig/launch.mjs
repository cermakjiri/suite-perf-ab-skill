/**
 * Launch one side of a run, for measurement (run.mjs) or exploration (open.mjs).
 *
 *  web      Playwright Chromium. A local production build is served from disk through routes at
 *           http://suite.localhost/ (no server, nothing to bind); a deployed preview (side.url) is
 *           loaded as is. Every other host is unresolvable unless network=live.
 *  desktop  Electron on the side's built suite/desktop-app dir with its own --user-data-dir under
 *           $PERF_AB_HOME/apps (wiped at start). One Electron binary (the checkout's) serves both sides.
 *
 * Both need the Bash sandbox off: Chromium's and Electron's Mach-port rendezvous is denied inside it.
 * With cdpPort set (open.mjs) the browser listens on that port, so the playwright MCP
 * (--cdp-endpoint) and the chrome-devtools-electron MCP (--browserUrl) can attach.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { playwright, importFromRepo, home } from './lib.mjs';

const BASE = 'http://suite.localhost/';
const VIEWPORT = { width: 1440, height: 900 };
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/markdown', '.txt': 'text/plain', '.map': 'application/json',
};
// analytics and Sentry never leave the machine; answered 200 so the app logs no errors
const TELEMETRY = /^https:\/\/(data\.trezor\.io\/suite\/log\/|[\w.-]+\.sentry\.io\/)/;

const routeCommon = async (context, { device, network, hits }) => {
    await context.route(TELEMETRY, route => {
        hits.telemetry += 1;

        return route.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } });
    });
    if (network === 'live') return;
    // token definitions are plain JSON; a stalled request would hang Suite's init
    await context.route('https://data.trezor.io/suite/definitions/**', route => {
        hits.definitions += 1;

        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'access-control-allow-origin': '*' } });
    });
    if (device === 'synthetic') {
        // no bridge, no local backends: fail fast instead of waiting for a socket
        await context.route(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//, route => {
            const h = route.request().url().split('/').slice(0, 3).join('/');
            hits.aborted[h] = (hits.aborted[h] || 0) + 1;

            return route.abort();
        });
    }
};

const serveBuild = async (context, buildDir, hits) => {
    const root = path.resolve(buildDir);
    await context.route(`${BASE}**`, route => {
        let rel = decodeURIComponent(route.request().url().slice(BASE.length).split('?')[0].split('#')[0]);
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        let file = path.join(root, rel);
        if (!file.startsWith(root)) return route.fulfill({ status: 403, body: '' });
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!fs.existsSync(file)) {
            if (hits.missing.length < 50) hits.missing.push(rel);

            return route.fulfill({ status: 404, body: 'not found' });
        }
        hits.served += 1;
        hits.bytes += fs.statSync(file).size;

        return route.fulfill({
            status: 200,
            headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' },
            body: fs.readFileSync(file),
        });
    });
};

let chromiumMajor = null;
// Suite's browser detection rejects the "HeadlessChrome" token, so headless runs present a normal UA
const userAgent = executable => {
    if (!chromiumMajor) {
        const v = execFileSync(executable, ['--version'], { encoding: 'utf8' });
        chromiumMajor = (v.match(/(\d+)\.\d+\.\d+/) || [])[1] || '151';
    }

    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0 Safari/537.36`;
};

const launchWeb = async ({ repo, side, initScript, headed = false, cdpPort = null, device = 'synthetic', network = 'none', userDataDir = null, viewport = VIEWPORT }) => {
    const { chromium } = await playwright(repo);
    if (!side.web && !side.url) throw new Error(`side ${side.key} has neither a web build nor a url — run build.mjs first`);
    const base = side.web ? BASE : side.url;
    const args = ['--js-flags=--expose-gc', '--disable-features=LocalNetworkAccessChecks'];
    if (side.web && network !== 'live') {
        const keep = ['suite.localhost'].concat(device === 'synthetic' ? [] : ['localhost', '127.0.0.1']);
        args.push(`--host-resolver-rules=MAP * ~NOTFOUND, ${keep.map(h => `EXCLUDE ${h}`).join(', ')}`);
    }
    if (cdpPort) args.push(`--remote-debugging-port=${cdpPort}`);
    const executable = chromium.executablePath();
    const ctxOpts = { viewport, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'light', userAgent: userAgent(executable) };
    let browser = null;
    let context;
    if (cdpPort) {
        // a persistent context is the browser's default context — the only one CDP clients (the MCPs) see
        const dir = userDataDir || path.join(home(), 'profiles', `web-${side.key}`);
        fs.rmSync(dir, { recursive: true, force: true });
        // the exploration session handles its own signals (open.mjs closes the context, logs why)
        context = await chromium.launchPersistentContext(dir, Object.assign({ headless: !headed, args, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }, ctxOpts));
    } else {
        browser = await chromium.launch({ headless: !headed, args });
        if (headed) {
            // the page's window is a CDP background target: it opens inactive, so a measuring session
            // does not take the focus from someone working on the machine
            const s = await browser.newBrowserCDPSession();
            const before = (await s.send('Target.getBrowserContexts')).browserContextIds;
            context = await browser.newContext(ctxOpts);
            const id = (await s.send('Target.getBrowserContexts')).browserContextIds.find(x => !before.includes(x));
            const opened = context.waitForEvent('page', { timeout: 30000 });
            await s.send('Target.createTarget', { url: 'about:blank', browserContextId: id, newWindow: true, background: true });
            await opened;
            await s.detach();
        } else {
            context = await browser.newContext(ctxOpts);
        }
    }
    const hits = { served: 0, bytes: 0, missing: [], definitions: 0, telemetry: 0, aborted: {} };
    await routeCommon(context, { device, network: side.web ? network : 'live', hits });
    if (side.web) await serveBuild(context, side.web, hits);
    if (initScript) await context.addInitScript(initScript);
    const page = context.pages()[0] || (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const version = browser ? browser.version() : chromiumMajor;

    return {
        kind: 'web',
        base,
        page,
        context,
        cdp,
        hits,
        version,
        open: () => page.goto(base, { waitUntil: 'load', timeout: 120000 }),
        close: async () => {
            await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
        },
    };
};

/** The side's built suite/desktop-app dir, checked. */
const desktopApp = side => {
    const appDir = side.desktop;
    if (!appDir || !fs.existsSync(path.join(appDir, 'dist', 'app.js')) || !fs.existsSync(path.join(appDir, 'build', 'index.html'))) {
        throw new Error(`side ${side.key}: ${appDir} is not a built suite/desktop-app (dist/app.js + build/index.html) — run build.mjs --targets=desktop`);
    }

    return appDir;
};

const launchDesktop = async ({ repo, side, initScript, cdpPort = null, device = 'synthetic', network = 'none', tag = null, electron = null, extraArgs = [], viewport = VIEWPORT, lateInject = false }) => {
    const { _electron } = await playwright(repo);
    // The real app dir, not a copy or a symlink farm: main validates every IPC sender as
    // relative(__dirname of dist/app.js, page path) === '../build/index.html'. Electron honors
    // --user-data-dir for app.getPath('userData') and Chromium storage (IndexedDB) alike, so each
    // side gets its own profile, wiped at start, and the unpacked-build dir in Application Support
    // (@suite/desktop-app) is never touched.
    const appDir = desktopApp(side);
    const userData = path.join(home(), 'apps', tag || `desktop-${side.key}`);
    const executablePath = electron || (await importFromRepo(repo, 'electron'));
    const args = [
        appDir,
        `--user-data-dir=${userData}`,
        '--expose-store',
        '--js-flags=--expose-gc',
        `--width=${viewport.width}`,
        `--height=${viewport.height}`,
        '--remove-user-data-on-start',
        '--host-resolver-rules=MAP *.sentry.io ~NOTFOUND',
    ];
    // offline mode cancels every renderer request but file:// and disables main-process Sentry
    if (device === 'synthetic' && network !== 'live') args.push('--offline-mode');
    // Playwright puts its own --remote-debugging-port=0 first; a later one wins and Playwright follows it
    if (cdpPort) args.push(`--remote-debugging-port=${cdpPort}`);
    args.push(...extraArgs);
    // The init script must be in place before the first window loads (the React hook has to exist
    // before react-dom evaluates). Register it the moment Playwright has the app; if the window still
    // won the race, relaunch rather than reload: a renderer reload re-runs Suite's main-process IPC
    // registration and can leave the app without a store for good ("second handler" race).
    let app;
    let page;
    let launches = 0;
    let probesLate = false;
    const hits = { served: 0, bytes: 0, missing: [], definitions: 0, telemetry: 0, aborted: {} };
    for (;;) {
        launches += 1;
        app = await _electron.launch({
            executablePath,
            args,
            cwd: appDir,
            env: Object.assign({}, process.env, { PLAYWRIGHT_RUN: 'true' }),
            timeout: 120000,
        });
        if (initScript) await app.context().addInitScript(initScript);
        page = await app.firstWindow({ timeout: 120000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 120000 });
        const has = !initScript || (await page.evaluate(() => !!window.__H).catch(() => false));
        if (has) break;
        // exploration (fixed CDP port) loses this race every time: inject after boot instead
        if (lateInject) {
            await page.waitForFunction(() => !!window.store, null, { timeout: 120000 });
            await page.evaluate(initScript);
            probesLate = true;
            break;
        }
        await app.close().catch(() => {});
        if (launches >= 3) throw new Error('desktop: the init script missed the first window load 3 times in a row');
    }
    const context = app.context();
    await routeCommon(context, { device, network: 'live', hits });
    const electronVersion = await app.evaluate(({ app: a }) => process.versions.electron + ' / ' + a.getPath('userData')).catch(e => String(e));
    const cdp = await context.newCDPSession(page);

    return {
        kind: 'desktop',
        base: 'file://',
        app,
        page,
        context,
        cdp,
        hits,
        appDir,
        userData,
        version: electronVersion,
        executablePath,
        open: async () => {},
        launches: () => launches,
        // true: the probes were injected after boot — no React hook, commit counts read 0
        probesLate: () => probesLate,
        close: () => app.close().catch(() => {}),
    };
};

const launch = (target, opts) => (target === 'desktop' ? launchDesktop(opts) : launchWeb(opts));

export { BASE, VIEWPORT, launch, launchWeb, launchDesktop, desktopApp };
