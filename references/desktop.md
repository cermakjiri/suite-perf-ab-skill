# Desktop target (Electron)

`"target": "desktop"` in run.json (or `--target=desktop` per pass) runs the same scenario in the
Suite desktop app. Measured and verified on 2026-10-13 (Electron 43.2.0, Playwright 1.62.1, M4).

## Build

`build.mjs --targets=desktop` runs, in the side's clone, `yarn workspace @suite/desktop-app clean`
(removes `build-electron/`, `build/`, `dist/` — the desktop build never cleans on its own, and
stale chunks with other hashes would mix two builds), `build:ui` (renderer, ~33 s) and `build:app`
(main + preload with `NODE_ENV=production`, ~19 s). The result is `<clone>/suite/desktop-app` with
`dist/app.js` and `build/index.html`.

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
- Exploration sessions (`open.mjs`, fixed `--remote-debugging-port=9222`): the window wins every
  time. The probes are injected after boot instead (`probesLate`) — everything works except React
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

## Window and machine

Electron has no headless mode: each session opens a visible window for ~10-30 s. Do not use the
Mac during a desktop plan; a focus change or ⌘Q aimed at another app can end a session (it then
fails and plan.mjs retries it once). A desktop session costs ~1 GB RAM.

## MCP on desktop

`open.mjs --target=desktop` → the `chrome-devtools-electron` MCP (`--browserUrl
http://127.0.0.1:9222`) lists the Electron page and runs `evaluate_script`, traces and heap
snapshots on it; the `playwright` MCP (`--cdp-endpoint`) snapshots and drives it. See
references/mcp.md.
