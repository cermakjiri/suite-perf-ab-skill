# Desktop target (Electron)

`"target": "desktop"` in run.json (or `--target=desktop` per pass) runs the same scenario in the
Suite desktop app. Measured and verified on 2026-10-13 (Electron 43.2.0, Playwright 1.62.1, M4).

## Build

`build.mjs --targets=desktop` runs, in the side's clone, the prep CI does for desktop
(message-system config, app assets, `@trezor/transport-bridge build:lib` — the renderer copies the
bridge UI from it), then `yarn workspace @suite/desktop-app clean` (removes `build-electron/`,
`build/`, `dist/` — the desktop build never cleans on its own, and stale chunks with other hashes
would mix two builds), `build:ui` (renderer, ~33 s) and `build:app` (main + preload with
`NODE_ENV=production`, ~19 s), in the run's profile (`release`: `IS_CODESIGN_BUILD=true` — also hides
the DevTools menu and drops "Dev" from the app name; the rig attaches over CDP either way). The
result is `<clone>/suite/desktop-app` with `dist/app.js` and `build/index.html`. Its fingerprint
reads the renderer (`build/js`) and the main process (`dist/`): both must carry the clone's commit
(main only inside its release string); React Compiler coverage is counted in the renderer
(`references/builds.md`).

## Launch (rig/launch.mjs)

- **The real app dir**, never a copy or a symlinked wrapper: main validates every IPC sender with
  `relative(__dirname of dist/app.js, page path) === '../build/index.html'`
  (`packages/ipc-proxy/src/validateIpcMessage.ts`). A wrapper with symlinked `build/` fails the
  handshake and the renderer stays blank with no store.
- **Own profile per side**: `--user-data-dir=$PERF_AB_HOME/apps/<run>-<side>` — Electron honors it
  for `app.getPath('userData')` and for Chromium storage (IndexedDB) alike — plus
  `--remove-user-data-on-start`, so every session starts empty and the unpacked-build profile in
  `~/Library/Application Support/@suite/desktop-app` is never touched.
- Switches: `--expose-store` (preload sets `desktopFlags.exposeStore`, the renderer assigns
  `window.store`), `--js-flags=--expose-gc`, `--width=1440 --height=900` (`resize_page` does not
  work on Electron; the page gets 1440×887 — the title bar), `--host-resolver-rules=MAP *.sentry.io
  ~NOTFOUND`, and for synthetic runs `--offline-mode` (cancels every renderer request except
  `file://`, disables main-process Sentry). Env `PLAYWRIGHT_RUN=true`.
- One Electron binary for both sides (the checkout's `node_modules/electron`), so the binary is not
  part of the comparison. Pass `electron` to `launchDesktop` to compare Electron upgrades.
- Never `yarn suite:dev:desktop` next to a run you care about: it rimrafs `build/`, `build-electron/`
  and `dist/` of the shared tree.

## The init-script race

The probes (above all the React DevTools hook) must be installed before the first window loads.
Playwright can only add the init script after `_electron.launch()` returns, and the app may create
its window first:

- Measurement sessions (no fixed CDP port): the script usually wins; when it does not, the rig
  **relaunches** (up to 3×) and records `env.desktopLaunches`. It never reloads: a renderer reload
  re-runs main's per-renderer IPC registration and can leave the app without a store for good
  (the "Attempted to register a second handler" race the QA harness hit on 6 of 14 reloads).
- Exploration sessions (`open.mjs`, a fixed `--remote-debugging-port`, 9222 or the next free one):
  the window wins every time. The probes are injected after boot instead (`probesLate`) — everything works except React
  commit counts. Fine for MCP work, which is never timing-grade anyway.

## What is different from web

| | Web | Desktop |
| --- | --- | --- |
| Store | `window.store` via `window.Playwright` (usePlaywright) | `window.store` via `--expose-store` |
| TrezorConnect | `window.TrezorConnect` | `@trezor/connect-electron`'s `factoryPrivileged` object (found by `__H.connect()` via the `initIpcProxy` module); methods are plain, replaceable |
| Router | browser history; `@router/goto` exported | memory history: `location` never changes, read `state().router`; `@router/goto` is **not exported** — `__H.goto` falls back to menu clicks |
| Thunks in the bundle | many exported (`findThunk`) | module concatenation keeps most internal (`fetchAllTransactionsForAccount`, `@router/goto` not found) → drive through the UI |
| Sentry | not initialized under `window.Playwright` | renderer initializes it (tracing on local builds); main is off with `--offline-mode` |
| Idle CPU (same seeded state, 4x) | ~20 ms/s | ~150 ms/s |
| Viewport | 1440×900 | 1440×887 |

So desktop numbers are never compared with web numbers — only desktop A with desktop B. Idle CPU
is ~7x higher on desktop: budget more sessions, and idle-correct long windows.

## Code outside the renderer

Every instrument in the rig reads the renderer's main thread: CDP thread ticks (`taskMs`), long
tasks, frames, input lag, React commits, the page's probes. Code that runs anywhere else moves none
of them with its own work. It shows only where it touches the renderer: how long a phase waits for
it, and the copies at the boundary. Measured on the coinjoin backend (run `coinjoin-address-stats`,
2026-10-16; `examples/desktop-ipc-backend`, 2026-10-17) and, for workers, with a Chromium 151 probe.

### Where the changed code runs

Follow the import chain from the changed file to whatever loads it (mapped at 04caace736):

| Changed code | Web | Desktop | A scenario reaches it through |
| --- | --- | --- | --- |
| `packages/suite`, `suite/*` (`suite/coinjoin` too), `suite-common/*` | renderer main thread | renderer main thread | the usual phases |
| connect core: `packages/connect-core`, `packages/connect/src/impl`, `protobuf`, `protocol`, Cardano's CSL WASM | renderer main thread (`CoreInModuleWeb`) | **main** (`CoreInModuleNode`, `modules/trezor-connect.ts`); the renderer has only the IPC client `@trezor/connect-electron` | `__H.connect()` |
| `packages/blockchain-link` workers: blockbook, blockfrost, ripple, stellar | a **Web Worker** per backend (`packages/connect-core/src/workers/workers.browser.ts`) | main | connect calls against a live backend, i.e. an emulator run (synthetic runs mock connect) |
| … solana, evm-rpc; electrum (desktop only) | renderer main thread | main | the same |
| `packages/coinjoin/src/backend` (CoinjoinBackend) | never: `suite/coinjoin/src/coinjoinService.ts` throws outside `isDesktop()` | a **utility process** per backend (`modules/coinjoin.ts` → `libs/thread-proxy.ts` → `threads/coinjoin-backend.ts`) | `window.ipcProxy`, channel `CoinjoinBackend` (`examples/desktop-ipc-backend`) |
| `packages/coinjoin/src/client` (CoinjoinClient) | never | **main**, plus the WabiSabi native binary | `window.ipcProxy`, channel `CoinjoinClient` |
| transports | WebUSB on the renderer main thread, its sessions in a SharedWorker | main (`packages/transport`); `transport-bridge` in the `bridge` utility process (one per app, outlives reloads); Bluetooth in main plus the native `trezor-bluetooth` process | connect; `desktopApi` (bridge); `window.ipcProxy`, channel `Bluetooth` |
| `suite/desktop-app-main/src` | – | main; `src/threads/*` become utility processes | `desktopApi`, `window.ipcProxy` |
| Evolu sync: `suite/suite-sync/src/evolu`, `suite-common/suite-sync-evolu` | renderer, plus an Evolu SharedWorker and a DB Worker (SQLite WASM) | the same | the store |

How to tell from the code:

- **`createIpcProxy('<channel>', …)` in renderer code**: the object lives in main or a utility
  process. The preload lets four channels through: `Bluetooth`, `CoinjoinBackend`,
  `CoinjoinClient`, `TrezorConnect` (`suite/desktop-app-main/src/preload.ts`,
  `packages/ipc-proxy/src/proxy-generator.ts`). A page script calls
  `window.ipcProxy.create(channel, id, ctorArgs)` first (main registers the instance's listeners in
  its create handler), then `request(channel, id, method, args)`; `setHandler` / `clearHandler`
  subscribe to its events.
- **`ThreadProxy` in main** (`libs/thread-proxy.ts`): `utilityProcess.fork` of
  `dist/threads/<name>.js` with no options, so every utility process carries Electron's default
  service name `Node Utility Process` (tell them apart by pid). For CoinjoinBackend, `create`
  resolves once the thread has started.
- **`new Worker` / `new SharedWorker`**: a worker in the renderer process.
- **Gating**: `isDesktop()` / `isWeb()` (`@trezor/env-utils`, `process.env.SUITE_TYPE` inlined by
  the build) and `desktopApi.available` (false on web). Platform swaps come from package `browser`
  maps (both renderer builds honour them, main does not), webpack aliases such as
  `'@trezor/connect$': '@trezor/connect-electron'` in the desktop renderer, and the two composition
  roots; there are no `.desktop.ts` / `.web.ts` files.

Gotchas:

- **One file, two runtimes.** Connect core runs on the renderer main thread on web and in main on
  desktop: a connect change moves web's renderer metrics, and on desktop only the IPC wait and the
  decoding of the reply. Time each target for what it is.
- **Off the main thread on web too**: the four blockchain-link workers.
- **Page-script hazards**: `clearHandler('TrezorConnect', …)` makes main call
  `TrezorConnect.removeAllListeners(event)`, which drops Suite's own listener too (Bluetooth the
  same); every `create('CoinjoinBackend', …)` forks a process that lives until `disable`, a reload
  or quit.

The build says it too. After both sides of a target are built, `build.mjs` compares their bundles
per part — web `build/`, the desktop renderer's `build/`, main's `dist/` with `dist/threads/*`
(`rig/bundlediff.mjs`, run.json `bundles`) — and the differing files show which part the diff
reached. In `coinjoin-address-stats` the web and renderer bundles were code-identical, and the
only real difference was `dist/threads/coinjoin-backend.js` (+177 bytes). A code-identical target
is reported as unaffected instead of timed.

### What to measure instead

- **The awaited round trip.** A phase that awaits the call (`call.ms`) is the app's own latency:
  the renderer's structured-clone copy of the arguments, main relaying it, the backend's work, the
  result copied back. It is the headline. getAccountInfo, 30 txs × 100 inputs/outputs: 136 →
  40.6 ms at 4x, 110 → 18.3 ms at 1x (6 v 6 sessions, p 0.002); 60 × 200: 1,476 → 145 ms (4 v 4,
  p 0.029).
- **Renderer CPU in that window is the IPC cost.** `call.taskMs` is the copies plus idle background
  work: ~31 ms at 4x on both sides, equal unless the payloads changed (the example records `argKiB`
  and `resultKiB`). Idle-correct it (`idleCorrect: ['call']`, read `call.taskCorrMs`): the change
  itself makes one side's window shorter, and raw `taskMs` then reads lower there from background
  work alone (60 × 200: 126 vs 120 ms in windows 1.33 s apart, at 5–11 ms/s idle).
- **Spawn as a phase of its own.** Fork, load and construct (~92 ms, unchanged by the commit). A
  change in what the thread bundle imports or does at start shows there, and the call phase stays
  free of startup.
- **The output.** Hash every result and compare the sides at each `it.n`
  (`examples/desktop-ipc-backend/hashes.mjs`). A faster backend that returns something else is a
  bug, not a win.
- **Cold and warm.** A fresh backend per iteration makes every timed call the first into a new
  process (cold JIT). The app keeps its backends (CoinjoinService: one per network), so most real
  calls run warm: the example's `warm` pass times the second call of a process (2026-10-17, one
  session per side at 4x: cold 138.5 → 44.7 ms, warm 135.8 → 37.6 ms; the new code gains more from
  a warm JIT).
- **Collect garbage before a timed call that follows untimed IPC work.** In the warm pass the
  warm-up call's copies (~0.9 MB) were collected inside the timed call: side A's renderer CPU read
  38–40 ms against 33–35 ms cold. With a full GC after the warm-up call and after every iteration
  (the desktop launch exposes `gc()`), the warm pass no longer reads above the cold one (A
  33.6–35.8 vs 33.1–35.7 ms).

None of it sees the backend's own CPU apart from wall time, work it does after it replied, or the
queue: a long CPU-bound call holds its utility process, and every other call to that backend waits
behind it (the old getAccountInfo held the coinjoin backend ~1.3 s at 60 × 200). A single-call
scenario measures the hold, not the queue.

### Traps

- **CPU throttling stops at the renderer's main thread.** `Emulation.setCPUThrottlingRate` slows
  only that thread. Main and the utility processes run at full speed at every rate, and so do Web
  Workers: in the probe a 100 ms loop took 100 → 410 ms on the main thread at 4x and 99–102 ms in a
  dedicated worker at 1x and 4x, also in one created after the throttle was set. So the backend's
  share of a round trip reads the same at 4x and 1x, and the rate scales only the renderer's share
  (side A: 136 ms at 4x, 110 ms at 1x; the 26 ms are mostly the copies, `taskMs` ~32 vs ~8 ms).
  Neither rate says how a slower machine fares, since there the backend slows too: report the
  backend's time as this machine's, and never read a 4x/1x ratio into it.
- **Percentiles over windows of different lengths.** When the change makes one side's window ~10×
  shorter, frame and lag p95 jump on the faster side: the same single copy block becomes the p95 of
  a window with few frames. At 60 × 200, side B's frame and lag p95 read ~51 ms against ~9 ms on
  side A, while both sides had the same worst frame (50–59 ms) and worst lag (49–59 ms) and no long
  tasks: one copy block in both, spread over A's 1.48 s window of 326 mostly idle frames and the
  p95 of B's 145 ms window of 9 frames. Compare `frameMax` / `lagMax`, CPU and long tasks there,
  and keep percentiles out of the headline.
- **Pass what the app caches.** The app passes the backend the account's addresses
  (`getAccountCache` in `suite/coinjoin/src/coinjoinAccountActions.ts`, from the stored account),
  and the backend derives only what that cache lacks. Derive them once (getAccountInfo with `[]`
  transactions returns them) and pass them the same way; otherwise every call derives every
  address again, a cost the app does not pay.
- **Nothing gates a backend.** Main creates one for every `create` call, without a feature-flag,
  Tor or `--offline-mode` check, and regtest settings with unreachable URLs are enough for a
  pure-CPU method such as getAccountInfo. `--offline-mode` does not reach the utility process
  either: `threads/coinjoin-backend.ts` has its own whitelist (localhost, 127.0.0.1, trezor.io), so
  keep the settings' URLs unreachable. A renderer reload (`did-start-loading`) disposes every
  backend — one more reason the rig never reloads on desktop. A discarded iteration disposes its
  own in page.js `reset()`.
- **Worker CPU is invisible to `taskMs` too.** `TaskDuration` counted 0.2–0.8 ms while a worker
  ran 100 ms. CDP `ProcessTime − ThreadTime` (the renderer process minus its main thread; the rig
  does not record either yet) followed the worker at both rates (99 ms at 1x, 104 ms at 4x).
  `ProcessTime` alone does only at 1x: at 4x the throttler itself keeps the main thread on a core
  ~3/4 of the wall time even while it idles (`ThreadTime` +79 ms in a 102 ms idle window, +0.2 ms
  at 1x).
- **Web: unaffected, not timed.** Code that only desktop runs (coinjoin throws outside desktop)
  leaves the web bundles code-identical between the sides. The report says the target is unaffected
  and why, instead of showing a web verdict of zero.

### Code no IPC call reaches

A function inside a backend that no IPC method exposes alone, or one hunk of a commit that changed
several: time the function itself in Node at both revisions with `rig/fnbench.mjs`. The coinjoin
run did it by hand: getAccountUtxo's path map (O(A²) → O(A)) read 0.998–1.000 of the old time at
160–300 addresses, so the whole gain was getAddressStats's one pass. The function-level number says
which hunk matters; the in-app round trip says what a user waits. Report both when a commit has
several hunks.

## Window and machine

Electron has no headless mode: each session opens a visible window for ~10-30 s. Do not use the
Mac during a desktop plan; a focus change or ⌘Q aimed at another app can end a session (it then
fails and plan.mjs retries it once). A desktop session costs ~1 GB RAM.

## MCP on desktop

`open.mjs --target=desktop` → the `chrome-devtools-electron` MCP (`--browserUrl
http://127.0.0.1:9222`) lists the Electron page and runs `evaluate_script`, traces and heap
snapshots on it; the `playwright` MCP (`--cdp-endpoint`) snapshots and drives it. See
references/mcp.md.

A desktop session holds the machine slot like a web one (`references/builds.md`): a desktop plan and
another run's web plan interleave, one session at a time.
