# Suite: answer `devtoolstooldiscovery` with automation tools

Status: draft for review (2026-10-14). Paths below are from the `trezor-suite` checkout at
`749121a0e9` (branch `apps-embedding/in-app-browser-react-native`); re-check them against the branch
the work lands on. The consumer side — what `suite-perf-ab` expects and what it already does — is
`references/discovery.md` in the skill; this document is the Suite side.

## Goal

Let Suite (web and the desktop renderer) answer the Chrome DevTools MCP's `devtoolstooldiscovery`
event with one small, gated group of automation tools, so that an agent exploring a build through
the MCP, and the perf rig driving a build through Playwright, use the same app-side contract instead
of hand-written `evaluate_script` calls and webpack-registry scraping.

Not a goal: a new in-app debugging UI, a public API, anything reachable by a user without the
automation gate, or a replacement for the e2e suite's existing `window.store` seam (it stays).

## Why

- chrome-devtools-mcp (1.3.0, behind `--categoryExperimentalThirdParty=true`) asks a page for tools
  by dispatching a `devtoolstooldiscovery` CustomEvent on `window` and reading what the listener
  passes to `event.respondWith(toolGroup)`. It lists them (`list_3p_developer_tools`), validates
  arguments against each tool's JSON schema and runs them (`execute_3p_developer_tool`, or
  `window.__dtmcp.executeTool` from `evaluate_script`). A tool that returns a DOM element gives the
  MCP a clickable uid.
- It is a plain DOM event: the perf rig dispatches it itself from Playwright, with no MCP attached,
  so timing sessions stay debugger-free and still get the tools.
- Today the rig finds thunks by walking `__webpack_require__` (desktop bundles keep them
  module-internal: history-load is web only), maintains the `@storage/load` payload shape by hand
  (a missing key silently no-ops the seed), reads lifecycle and router state from the store, and
  must win an init-script race on desktop to count React commits (relaunches up to 3x). Each of
  those is one tool here.

## Design

### Gate

One predicate, evaluated at runtime, identical on both targets:

```ts
export const isAutomationToolsEnabled = () =>
    typeof window !== 'undefined' &&
    (window.Playwright === true || window.desktopFlags?.exposeStore === true);
```

- web: `window.Playwright` set by an init script before the app loads (what `usePlaywright.ts` and
  `createWebApp.tsx` already key on).
- desktop: `desktopFlags.exposeStore` from the `--expose-store` switch (`preload.ts`), which the rig
  already passes. No new switch.

Ungated pages register **no listener** at all, so the MCP's `DOMDebugger.getEventListeners` check
finds nothing and nothing runs. Keep the gate a runtime switch, not a build-time one: the rig
measures `release` (codesign) builds, and a gate on `!isCodesignBuild()` (weighed as item 20 in
`plans/desktop-testability-improvements.md`) would remove the tools from exactly the builds it
compares.

### Where it lives

A new workspace package `suite/automation-tools` (`@suite/automation-tools`), no React, no UI:

| File | Role |
| --- | --- |
| `src/gate.ts` | `isAutomationToolsEnabled()` |
| `src/types.ts` | `ToolGroup`, `Tool` (name, description, `inputSchema`, `execute`) — the MCP's shape |
| `src/createAutomationTools.ts` | pure factory: `(deps) => ToolGroup`; deps = `{ store, services, history, document }` |
| `src/registerToolDiscovery.ts` | adds the `devtoolstooldiscovery` listener on `window`; responds **synchronously** |
| `src/thunkRegistry.ts` | `Map<typePrefix, thunk>` filled by `createThunk` (below) |
| `src/storagePayload.ts` | `emptyStoragePayload()` + `fillStoragePayload(partial)` derived from `loadStoragePayload` |
| `src/earlyPerfHook.ts` | self-contained script for the first webpack entry item (phase 3) |
| `README.md` | the contract, one line per tool, with the version |

Wired once per target, right after `injectServicesIntoReduxExtra(services)`:

- `suite/web-app/src/createSuiteWebCompositionRoot.ts`
- `suite/desktop-app-renderer/src/createSuiteDesktopCompositionRoot.ts`

```ts
if (isAutomationToolsEnabled()) {
    registerToolDiscovery(createAutomationTools({ store, services, history, document }));
}
```

### The tool group (v1)

Group `name: "suite"`, `description: "Trezor Suite automation tools v1"`. Tool names are dotted so
they cannot collide with another group's. Every `inputSchema` is an object schema with
`additionalProperties: false`. "sync" means `execute` returns a value, not a promise — the rig
polls those from synchronous code.

| Tool | Input | Returns | Backed by | sync |
| --- | --- | --- | --- | --- |
| `suite.ready` | `{}` | `{ ready, lifecycle, routerLoaded, route, loadingScreen }` | `state.suite.lifecycle.status`, `state.router`, `[data-testid="@suite/loading"]` | yes |
| `suite.build` | `{}` | `{ commit, version, suiteType, codesign, toolsVersion: 1 }` | `process.env.COMMITHASH`, `VERSION`, `isCodesignBuild()`, `isDesktop()` | yes |
| `suite.goto` | `{ routeName, params?, preserveParams? }` | `{ route, pathname }` once `state.router.route.name === routeName`; `{ route, locked: true }` when navigation is locked | `gotoThunk` (`suite/router/src/routerThunks.ts`) | no |
| `suite.thunk` | `{ typePrefix, arg? }` | the resolved action of the dispatched thunk (`{ type, payload?, error?, meta }`) | the thunk registry | no |
| `suite.dispatch` | `{ action: { type, payload?, meta? } }` | `{ ok: true }` | `store.dispatch` (plain actions; thunks go through `suite.thunk`) | yes |
| `suite.state` | `{ path, maxChars? }` | `{ value }`; throws when its JSON exceeds `maxChars` (default 65536) | `getState()` + dotted path | yes |
| `suite.services` | `{ name: "store" \| "connect" \| "desktopApi" \| "history" }` | the live object (for in-page composition; the MCP prints `<X instance>`) | the composition root | yes |
| `suite.storageDefaults` | `{}` | the empty `@storage/load` payload: every key `loadStoragePayload` produces, with `[]` / `undefined` | `storagePayload.ts` | yes |
| `suite.seed` | `{ storage, selectedDevice? }` | `{ accounts, devices, selectedDevice, filledKeys }` | `storageLoad(fillStoragePayload(storage))`, then `updateSelectedDevice` | no |
| `suite.perf` | `{ action: "read" \| "reset", from?, to? }` | `{ installed, renderers, commits, longTasks }` (commits between `from`/`to` in `performance.now()` ms when given) | the early hook (phase 3) | yes |
| `suite.testIds` | `{ prefix?, limit? }` | `{ testIds: string[], total }` | `document.querySelectorAll('[data-testid]')` | yes |
| `suite.find` | `{ testId, nth? }` | `{ element, count }` | `querySelectorAll('[data-testid="…"]')` | yes |

Rules the implementation keeps:

- **Cheap and side-effect free unless named so.** `ready`, `build`, `state`, `testIds`, `find`,
  `storageDefaults`, `perf read` must not dispatch, allocate large objects or walk the whole store.
  `state` refuses oversized results instead of serializing them; the MCP walks every result
  recursively.
- **Identical on both sides of a comparison.** The group's description carries the version; the rig
  records the tool names and the description per side and warns when they differ. A PR that
  changes the tools gets measured with the rig's own helpers and says so.
- **Respond synchronously** to the discovery event (the MCP resolves at once when it can; the rig
  reads synchronous answers from synchronous code).
- **No pending-thunk counter and no redacted state API** (verdicts from the testability audit:
  debounce makes the counter read 0 for 300 ms; redaction breaks what e2e asserts on).
- **No timing claims.** The tools exist so the rig and the MCP drive the app; numbers still come
  from the rig's probes and CDP thread ticks.

### Thunk registry

`createThunk` (`suite-common/redux-utils`) registers every thunk it creates in a module-level
`Map<typePrefix, thunk>` (a few hundred function references, no user data, built during module
evaluation on both sides alike). `suite.thunk` dispatches `registry.get(typePrefix)(arg)` and
returns the resolved action. This replaces the rig's `findThunk` (which cannot see
module-internal thunks in the desktop bundle) and makes `examples/history-load` runnable on desktop.

### Storage payload builder

`loadStoragePayload.ts` is the one place that knows which keys `@storage/load` carries; derive
`emptyStoragePayload()` from it (the same list, empty) so a new slice changes both at once, and
`fillStoragePayload(partial)` = defaults ⊕ partial. `suite.seed` dispatches the result and reports
`filledKeys` (which keys the caller left out) so a scenario can see what it is implicitly relying
on. This closes the "missing key silently no-ops the seed" trap for good.

### Early perf hook (phase 3)

`earlyPerfHook.ts`: no imports, runs before react-dom's module body (the first item of the web and
desktop renderer webpack `entry` arrays — locate in `packages/suite/webpack/`), returns at once when
the gate is off or a `__REACT_DEVTOOLS_GLOBAL_HOOK__` already exists (the rig's init script won on
web; its own probes are then authoritative). Otherwise installs the minimal hook
(`inject`, `onCommitFiberRoot` recording `performance.now()` per commit into a capped array,
no-op stubs for the rest — the same shape `packages/perf-e2e/src/instrumentation.ts` and the rig
use) and exposes it to `suite.perf`. This ends the desktop init-script race: React commit counts
become available in every desktop session, measurement and exploration alike, with no relaunch.

### Hydration-time seed (phase 2, decision needed)

`suite.seed` dispatches after the store exists (what the rig does today). A seed applied **at
hydration** — the preloaded state as if the DB held it, init running once on it — is cleaner for
boot and first-load scenarios. Mechanism: an init script sets `window.__suiteSeed = <storage
payload>` before the app loads; `createHydrateReduxStore` consumes it as the preload action
(`storageLoad(fillStoragePayload(window.__suiteSeed))`) when the gate is on. Decision for the
reviewer: desktop's `--state` patch asks `confirm()` on codesign builds
(`createHydrateReduxStore.ts`, `patchConfirm`); a headless rig cannot answer it. `--expose-store`
already exposes the full store on codesign builds without a prompt, so gating the seed the same way
is consistent — but it is a choice to make explicitly, not to inherit.

### Security and privacy

- Nothing new is reachable without the gate; with it, the tools give what `window.store` and
  `window.TrezorConnect` already give today (full unredacted state, dispatch). The audit's notes
  still stand and are not changed here: `window.store` is unredacted, Redux DevTools is ungated in
  production, `window.desktopApi` is exposed unconditionally.
- `suite.services` hands out live objects on purpose (replacing `TrezorConnect` methods with mocks
  is how the rig gets a deterministic backend); it is gated like everything else.
- The listener is on `window` and only responds with the group; it never reads the event's
  payload, so a page cannot be made to do anything by dispatching the event itself beyond listing
  the tools it already exposes to the same origin.

## Changes by file

### Phase 1 — listener and the read/drive tools (web + desktop)

1. `suite/automation-tools/` (new package): `gate.ts`, `types.ts`, `createAutomationTools.ts`
   (`suite.ready`, `suite.build`, `suite.goto`, `suite.thunk`, `suite.dispatch`, `suite.state`,
   `suite.services`, `suite.testIds`, `suite.find`), `registerToolDiscovery.ts`, `thunkRegistry.ts`,
   `README.md`, unit tests (a store with the real root reducer, no DOM beyond jsdom).
2. `suite-common/redux-utils` `createThunk`: register in `thunkRegistry` (one `Map.set` per thunk).
3. `suite/web-app/src/createSuiteWebCompositionRoot.ts` and
   `suite/desktop-app-renderer/src/createSuiteDesktopCompositionRoot.ts`: the three-line wiring
   after `injectServicesIntoReduxExtra(services)`.
4. `suite/web-app/src/global.d.ts`, `suite/desktop-app-renderer/src/global.d.ts`: add
   `__dtmcp?` (the MCP's helper object) and the `devtoolstooldiscovery` event type with
   `respondWith`.
5. Docs: `docs/tests/` (or wherever e2e seams are documented) gets one page: the gate, the MCP
   flag, the tool list, "never time through the MCP".

### Phase 2 — seeding

6. `suite/automation-tools/src/storagePayload.ts` from `packages/suite/src/storage/loadStoragePayload.ts`
   (export the key list from there, or move the empty-shape builder next to it); `suite.seed`,
   `suite.storageDefaults`.
7. Optional, after the decision above: `createHydrateReduxStore.ts` reads `window.__suiteSeed`
   when the gate is on.

### Phase 3 — early perf hook

8. `suite/automation-tools/src/earlyPerfHook.ts`; the first `entry` item of the web and desktop
   renderer bundles; `suite.perf`. `packages/perf-e2e` can then read commits from it instead of
   installing its own hook via `addInitScript` (`suite/e2e/support/setup.ts`), later.

Each phase ships on its own and bumps `toolsVersion` only when a tool's contract changes.

## Acceptance

- With `--categoryExperimentalThirdParty=true`, `list_3p_developer_tools` on a gated page shows
  group `suite` with the v1 tools; `execute_3p_developer_tool("suite.ready")` returns the lifecycle.
- A page loaded without the gate has no `devtoolstooldiscovery` listener
  (`getEventListeners(window)` in DevTools is empty) and no `thunkRegistry` reads.
- `suite-perf-ab`: a web and a desktop session each record `env.discovery` with the same tool list
  on both sides; the desktop session gets React commit counts without a relaunch (phase 3);
  `examples/history-load` runs on desktop through `suite.thunk`.
- `suite-bundle-ab` on the PR: the package costs under ~3 KB gzip in the boot set, the early hook
  under 1 KB; `suite-perf-ab` on the PR with the gate off reads A/A (the tools never run).
- e2e unchanged: `window.store`, `window.TrezorConnect`, `window.Playwright` keep working.

## Risks and open questions

- The MCP feature is experimental; the event name or the `respondWith` shape may change. Suite
  implements the shape as of chrome-devtools-mcp 1.3.0; the rig dispatches the same shape, so the
  skill does not depend on the MCP version — only the MCP-driven exploration does.
- A PR that touches the tools themselves is measured asymmetrically: the rig falls back to its own
  helpers where a tool is missing and the report says so. Keep tool changes out of perf PRs.
- `confirm()` on codesign builds for the hydration seed (above).
- Result size: `suite.state` caps its output; `suite.services` must stay out of MCP results
  (document that it is for `__dtmcp.executeTool` composition in-page).
- Bundle cost: measure with `suite-bundle-ab`; the package is boot-set code on both targets.

## What the skill already does (this worktree)

- `rig/page/core.js`: dispatches the discovery event itself, keeps the tools, prefers `suite.goto`,
  `suite.thunk` (via `H.thunk`), `suite.services` (for `connect()`), `suite.ready` (synchronous)
  and `suite.perf` (when its own hook saw no renderer and had no hook to wrap), with the previous
  code as fallback;
  `env.discovery` and `env.pageHook` recorded per side.
- `rig/run.mjs`: logs the tools a session found; accepts a page-provided React hook.
- `rig/aggregate.mjs` / `rig/report.mjs`: the tool list per side in the summary and the report, a
  warning when the sides differ.
- `references/discovery.md` (the contract from the consumer side), `references/mcp.md`,
  `references/rig.md`, `SKILL.md`, `README.md` (the MCP flag).
