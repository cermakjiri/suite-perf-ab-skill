# Page-provided tools: `devtoolstooldiscovery`

What the skill expects from a Suite build that answers the Chrome DevTools MCP's
`devtoolstooldiscovery` event, and what the rig does with it. The Suite-side plan is
`plans/suite-devtools-discovery.md`. Until Suite ships the tools, every helper here falls back to
the rig's own way and nothing changes; `env.discovery.found` says which it was.

## The protocol (chrome-devtools-mcp 1.3.0, `--categoryExperimentalThirdParty=true`)

1. The MCP checks (`DOMDebugger.getEventListeners`) that `window` has a `devtoolstooldiscovery`
   listener. No listener: nothing is dispatched, nothing is listed.
2. It dispatches `new CustomEvent('devtoolstooldiscovery')` on `window` with an own property
   `respondWith(toolGroup)`. The listener calls it, synchronously, with
   `{ name, description, tools: [{ name, description, inputSchema, execute(args) }] }`.
   Asynchronous answers get one `setTimeout(0)` of grace.
3. `list_3p_developer_tools` prints every group (name, description, each tool's name,
   description and JSON schema). `execute_3p_developer_tool(toolName, params)` validates `params`
   against the schema and runs `execute`; the result is serialized (DOM elements become stashed
   uids the MCP can click, non-plain objects print as `<X instance>`, functions as
   `<Function object>`). `evaluate_script` can call `window.__dtmcp.executeTool(name, params)`
   for results that must stay live.

The event is plain DOM, so `rig/page/core.js` dispatches the same shape itself from Playwright.
One app-side contract, two consumers; timing sessions keep running without the MCP.

## The contract the rig consumes (group `suite`, v1)

Tool names are dotted. "sync" tools return a value, never a promise: the rig polls them from
synchronous code (`suiteReady`, `commitsIn`) and treats a promise as "not offered".

| Tool | Input | Returns | sync | The rig uses it in |
| --- | --- | --- | --- | --- |
| `suite.ready` | `{}` | `{ ready, lifecycle, routerLoaded, route, loadingScreen }` | yes | `H.suiteReady()` (else the store) |
| `suite.build` | `{}` | `{ commit, version, suiteType, codesign, toolsVersion }` | yes | recorded in `env.discovery`; the build proof stays the module scan |
| `suite.goto` | `{ routeName, params?, preserveParams? }` | `{ route, pathname }` or `{ route, locked: true }` | no | `H.goto()` (else `@router/goto` from the bundle, else a menu click) |
| `suite.thunk` | `{ typePrefix, arg? }` | the dispatched thunk's resolved action | no | `H.thunk(typePrefix)` (else `findThunk` + dispatch) |
| `suite.dispatch` | `{ action }` | `{ ok: true }` | yes | MCP exploration (the rig has `window.store`) |
| `suite.state` | `{ path, maxChars? }` | `{ value }` (refuses oversized results) | yes | MCP exploration |
| `suite.services` | `{ name: store \| connect \| desktopApi \| history }` | the live object | yes | `H.connect()` (else `window.TrezorConnect`, else the bundle walk) |
| `suite.storageDefaults` | `{}` | the empty `@storage/load` payload with every key | yes | scenarios: merge the seed over it instead of listing keys by hand |
| `suite.seed` | `{ storage, selectedDevice? }` | `{ accounts, devices, selectedDevice, filledKeys }` | no | scenarios' `seed()` |
| `suite.perf` | `{ action: read \| reset, from?, to? }` | `{ installed, renderers, commits, longTasks }` | yes | commit counts when no renderer registered with the rig's hook and it had no hook to wrap (a late injection on desktop without the page's early hook sees nothing; with it, the rig wraps it and counts from then on) |
| `suite.testIds` | `{ prefix?, limit? }` | `{ testIds, total }` | yes | MCP exploration, scenarios |
| `suite.find` | `{ testId, nth? }` | `{ element, count }` | yes | MCP: a clickable uid; scenarios: an element |

## `window.__H` helpers

- `discover({ refresh })` — asks the page (one tick of grace for asynchronous answers) and returns
  `{ found, groups: [{ name, description, tools: [names] }] }`. `run.mjs` calls it after
  `postInit` and logs the answer; `H.goto` and `H.tool` call it lazily.
- `tool(name, args)` — runs a page tool, in-page: live objects come back live, promises are
  awaited. Throws when the page does not offer it (the message lists what it offers).
- `hasTool(name)`, `syncTool(name, args)` (undefined when absent, when it threw, or when it
  answered with a promise), `tools()` (the summary without asking again).
- `thunk(typePrefix)` — `arg => Promise<resolved action>` through `suite.thunk`, else through the
  bundle's export; `null` when neither finds it.
- `goto`, `suiteReady`, `connect`, `commits` and the window stats' `commits` prefer the page's
  tool as listed above and keep their previous behaviour as the fallback.

`env` records `discovery` (the summary) and `pageHook` (`suite.perf`'s `{ installed, renderers,
commits }`, or null). `run.mjs` accepts the page's hook in place of its own for the "React hook
installed before react-dom" check. `aggregate.mjs` copies `discovery` per side into
`summary.run.sides.<side>.tools` and warns when the sides offer different tools (a change that
touches the tools themselves); the report shows the tool list on each side card.

## Rules

- **Never a timing number through the MCP** — the tools do not change that (references/mcp.md).
- **Identical on both sides.** When the warning above fires, the report says that the rig fell
  back to its own helpers where a tool was missing, and the PR is measured with that caveat.
- **Tools run outside measured windows** unless the scenario calls them inside a phase on
  purpose; a `suite.state` of a large slice is work on the measured thread.
- **The page answers synchronously.** A Suite that answers after a tick still works with the MCP
  and with `discover()`, but `hasTool`/`syncTool` from synchronous code will miss it until
  `discover()` has run once.
