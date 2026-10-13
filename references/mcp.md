# Exploring a build with the MCPs

Three MCP servers are configured for this repo; none of them measures. They find selectors,
prototype scenario code against a live build, take traces and heap snapshots for attribution, and
drive device prompts. Timing comes from `run.mjs` / `plan.mjs` only.

| MCP | Attaches to | Use it for |
| --- | --- | --- |
| `playwright` (`playwright mcp --cdp-endpoint=http://127.0.0.1:9222`) | whatever listens on :9222 | `browser_snapshot` (roles, testids, refs), `browser_click`/`type` (trusted input), `browser_evaluate` / `browser_run_code_unsafe` to run `window.__A.phases.x({ n: 0 })` against the live app |
| `chrome-devtools-electron` (`chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`) | whatever listens on :9222 — web or Electron | `evaluate_script`, `performance_start_trace` / `stop_trace` (+ insights), `take_heapsnapshot`, `list_console_messages` (preserved over 3 navigations) |
| `chrome-devtools` | its own Chrome | quick looks at deployed previews; never for timing |
| `trezor-emulator` (SSE :9003) | trezor-user-env | emulator screen, yes/no/swipe (references/emulator.md) |

## The session

```bash
node <skill>/rig/open.mjs --run=<id> --side=B [--target=desktop] [--minutes=90]   # sandbox off, run_in_background
```

It launches the side exactly like a timing session (same build, seed, mocks, route), with CDP on
`127.0.0.1:9222`, prints `READY`, writes `$PERF_AB_HOME/open.json` and stays up until killed
(`kill -TERM <pid from open.json>`), the minutes pass, or the window closes. In the page:
`window.__H` (store, connect, findThunk, goto, runPhase, probes) and `window.__A` (the scenario).
Web uses a persistent Chromium profile — the browser's default context, the only one CDP clients
see. On desktop the window loads before the init script can be registered on a fixed port, so the
probes are injected after boot (no React commit counts in that session).

## Facts that cost time when unknown

- **The debugger tax.** Once the DevTools MCP attaches, the page runs with the V8 Debugger domain
  on: a 10k-element spread loop takes ~650 ms instead of ~26 ms (slice is unaffected). Any number
  from that page is taxed, asymmetrically — the side that spreads more pays more. The env canary
  (`__H.env().canary`) shows it: spread/slice ≈ 1 normal, ≈ 25 attached.
- **Attach is lazy and survives restarts with new ids.** Start `open.mjs` first, then call the MCP.
  After the browser restarts, the DevTools MCP says page ids changed (call `list_pages` again);
  the Playwright MCP fails one call with "Target page, context or browser has been closed" and
  reconnects on the next.
- **Files only inside the session's working directory.** `performance_stop_trace` / snapshot
  `filePath` outside it is refused ("not within any of the configured workspace roots"). Save to
  `<cwd>/.perf-ab/…` (git-ignored) and move it into the run folder (`<run>/traces/`) right away.
- **One driver at a time.** Both MCPs can attach together; let only one of them click.
- **Traces**: `performance_start_trace` with `reload: false, autoStop: false`, run one iteration
  through `evaluate_script` (`__H.runPhase('load', { i: 0, n: 7, rate: 1 })`), stop with a
  `filePath`, then `node <skill>/scripts/analyze-trace.mjs <trace.json.gz>` for the category split.
  A trace is a supplement with n = 1, never a headline number (tracing overhead scales with
  commits and lands unevenly).
- **Heap**: `take_heapsnapshot` on both sides after the same number of iterations, compare retained
  sizes of the suspect class; `performance.memory` alone is allocation history, not live data.
- Port 9222 is shared machine-wide: a peer session's browser or a leftover `open.mjs` holds it
  (`preflight.mjs` checks; `open.mjs` refuses to start on a taken port).
