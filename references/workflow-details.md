# Workflow details

What SKILL.md keeps as one line, at length: why its rules exist (measured), the progress the user
follows, the device choice, exploring a build with the MCPs, the performance-core gate, parallel
runs, deployed previews, and what each bundled file is for. Read the section you need
(`grep '^## '`).

## Why the rules (measured)

- **Context is the cost.** Every model call re-reads the whole conversation from the cache. A run
  makes ~55–75 calls; PR 33507's run started at a 334k-token prefix, ~2/3 of every call's cache read
  was earlier history, and it read 20M tokens from the cache where a fresh session would have read
  ~7M. Hence step 0 (a fresh session above ~150k tokens) and the small-context rule: a 30k-token read
  followed by 100 calls is ~3M tokens of cache reads. An earlier run read 1.06M characters of code
  into the main conversation and compacted three times; an Explore subagent returns a brief instead.
  The report: the 82–136 KB HTML cost ~40k tokens to read, `report.txt` ~8–10k. `aggregate.mjs
  --brief` is ≤ ~1.5k tokens for a typical run (the full tables several times that).
- **`!` checks are expensive.** A `!` command in the Claude prompt re-enters the conversation and
  the agent answers it, re-reading the whole context: 8 status checks cost 6.8M tokens in a
  330–430k-token session. The user watches in a terminal tab instead (`status.mjs --watch`), which
  costs nothing.
- **Foreground waits are expensive and fragile.** One run lost 120 min to 29 `until … sleep` loops,
  7 of them killed at the 10-minute tool limit. Background tasks re-invoke the agent when they end;
  a plan's events arrive through the Monitor tool.

## Progress the user can follow

**The checklist** is the app's task list (`mcp__ccd_turn__update_plan`), in this order and with
these names:

| Item | Estimate from |
| --- | --- |
| `Pin + preflight` | ~1–2 min |
| `Brief the diff` | the subagent, ~3–6 min |
| `Build <targets>` | build.mjs's first line (`est 0:40, ≈ 13:11`) |
| `Scenario + smoke` | ~10 min |
| `Counts + pilot` | the counts-and-pilot plan's first line |
| `<pass> · N sessions · ≈ HH:MM` — one per timing pass | plan-status.json `passes[].finishAt` (a `~` estimate is rough: another workload's) |
| `Control` | the same, for the control pass(es) |
| `Aggregate + report` | ~10 min |
| `Cleanup` | ~1 min |

Each item carries its estimate and expected finish time; the current one is in progress. Refresh the
times whenever a plan event arrives.

**The terminal tab.** When a plan starts, open a tab running `node <skill>/rig/status.mjs
--run=<id> --watch` (`mcp__terminal__run_in_terminal`, title `perf-ab <id>`) and link it
(`[the tab](#terminal/<tab_id>)`); without the terminal tools, give the user the command to run in a
terminal of their own. Never `!`.

**Events.** While the plan runs the agent is idle. `node <skill>/rig/status.mjs --run=<id> --events`
under the Monitor tool (`timeout_ms` 1800000; re-arm on expiry — a plan that ended meanwhile is
reported at once) prints one line per pass change (with every pass's state and finish time), a
power-wait start and its 10-minute mark (ask the user to plug in), and every end state: finished,
failed, interrupted, stalled, plan process gone. On an event: refresh the checklist; on an end
state: read the plan's last lines (`tail -40 <run>/out/plan.log`, the brief) and go on. Each wake is
one model call (~0.15–0.25M tokens in a fresh session), ~6–10 a run.

## Choosing the device

| | Synthetic (seeded store, mocked backend) | Emulator (trezor-user-env: real connect + discovery, live backends) |
| --- | --- | --- |
| Best when | the change is Suite's own code (reducers, middleware, rendering, persistence) and its cost scales with data a seed can size; the expected effect is small (under ~5 %): only identical data and backend timing let sessions separate | the change is in device communication, connect, discovery or the backend calls, or seeded state cannot reach the code path |
| Gives | size knobs, fresh data per iteration, exact counts, calls on 1-2 % effects | real data shapes (tokens, several networks), real backend latency, responses in the order they really arrive |
| Costs | the data is a model: what it assumes (timestamps, response order, latency, data shapes) can decide the result | Docker and a ~5.5 GB image, live network, discovery per session; backend noise in wall times (compare CPU, long tasks, counts); the workload is whatever history the seed's accounts have; first-load effects need one load per session |

Good enough: **synthetic alone** when the scenario models everything the change depends on;
**synthetic, then one emulator pass** when the result hangs on something synthetic only assumes —
the order or timing of backend responses, real data shapes (PR #33465: whether a page's fiat rates
land before or after the history load settles); **emulator alone** when synthetic cannot reach the
path. An emulator pass next to a synthetic verdict shows whether it holds on real data; it rarely
calls a small effect by itself.

How to settle it depends on the permission mode the session's own context states (the system
prompt, e.g. "bypass permissions mode is active", or a reminder when the mode changes):
**manual** (default) or **accept edits**: ask with AskUserQuestion — both options, your
recommendation first and marked "(Recommended)", one line each on what it buys for this change;
**bypass permissions** or **auto**: choose yourself and say in one line which device and why. When
the context names no mode, treat it as manual and ask. Either way write the choice into `run.json`
(`device`; `network: live` and `emulator` for the emulator; references/emulator.md) and the reason
into the report's caveats.

## Exploring a build with the MCPs

Prototype the in-page part against a live build before the first timing pass: `open.mjs --run=<id>
--side=B [--target=desktop]` (sandbox off, background) keeps one side open on CDP :9222 (the next
free port when taken) with the scenario loaded, and the MCPs attach to it (references/mcp.md): the
Playwright MCP for testids and `browser_evaluate` of `window.__A.phases.x(…)`, the
chrome-devtools-electron MCP for a trace or a heap snapshot. A Suite that answers
`devtoolstooldiscovery` (references/discovery.md) lists its own tools there
(`list_3p_developer_tools`: `suite.ready`, `suite.goto`, `suite.thunk`, `suite.seed`, …);
`window.__H.tool(name, args)` runs the same tools from a scenario, and `goto`, `thunk`, `suiteReady`,
`connect` prefer them on their own — with or without them, the scenario reads the same. **Never take
a timing number from an MCP-attached page**: the DevTools MCP turns the V8 debugger on, which makes
array spreads ~25x slower (the env canary shows it: spread/slice ≈ 1 normal, ≈ 25 attached).

## Performance cores

On macOS on Apple silicon (on by default) every measured iteration of a timing, control or trial
pass waits until performance cores are free and the renderer's main thread runs on one at full
clock; a session that cannot get there (cores busy for 15 min, a demoted renderer, a low clock)
fails with the reason instead of measuring. An iteration is discarded and retried with fresh data
only when another program's load (under 1 performance core free) or a demotion of the thread
(`taskpolicy -b`, App Nap, a hidden window) pushed its work onto efficiency cores; the log line says
which. A busy machine mostly makes the plan wait (`pcore-wait`), but contention shorter than ~100 ms
goes unseen, so a quiet machine still gives the cleanest data. Efficiency-core time with performance
cores free is macOS's own placement of light 1x work: it is kept and reported per side as
`pcore.eSharePct` in every table, and the advice and the report flag sides that differ by 5 points
or more — read a 1x time difference next to that flag. Measurements: references/rig.md.

Power is gated the same way, per session: on battery or in Low Power Mode the cores run at other
clocks, so plan.mjs holds timing and control sessions (`power-wait`) until AC; counts, trial passes
and builds go on. Observed before the gate: counts, a pilot and a desktop smoke ran on battery, and
preflight only warned.

## Parallel runs

Several runs (agents, PRs, web and desktop of one PR) can share the machine, and the rig keeps them
from measuring each other: every page session and every heavy build step takes the machine slot,
one at a time across all runs, first come first served — a session waiting for it shows stage
`queued` with who holds it. A clone is built by one run at a time and never rebuilt while a session
serves it; the emulator is held by whoever uses it; `open.mjs` takes the next free CDP port. So
starting a second run's build or plan is safe; it interleaves and takes longer. Tell the user when
another run holds the machine (`preflight.mjs` and `status.mjs` say so). Runs on one base share its
clone: `cleanup.mjs` keeps a clone another run pins (references/builds.md). Start each run in a
session of its own (step 0).

## Deployed previews (only when a local build is impossible)

Local builds are the method. A side can still be `"url":
"https://dev.suite.sldev.cz/suite-web/<branch>/web/"` instead of a `rev`, only if both sides are
previews of the same workflow and `env.coverageFiles` reads 0 on both: PR previews come from the e2e
workflow with Istanbul on, develop's usually not, which manufactures a regression on the branch.
Each session records the commit its preview served; `plan.mjs` stops when a side's deployment
changes between sessions (develop redeploys on every push), and `aggregate.mjs` refuses to pool
sessions from two deployments. Previews are `preview`-profile builds (redux-logger on).
`references/pitfalls.md` has the details.

## The rig's code

The rig is ES modules (`.mjs`, scenarios included: `export default { … }`) written for the latest
Node LTS (24). Builds run yarn with the `.nvmrc` Node of the revision being built when nvm has it
(else the running Node, with a warning), so both sides are built by the same Node. Runs live in
`$PERF_AB_HOME` (default `~/.local/share/suite-perf-ab`: outside every worktree, writable from the
sandbox).

## Bundled files

| File | Read it when |
| --- | --- |
| `references/rig.md` | Writing run.json / plan.json / a scenario; every script's flags; output and metric names |
| `references/builds.md` | Why the pair is the target branch vs the branch, the rebase gate, the build recipe and profiles, the commit proof, the bundle comparison, React Compiler coverage, parallel runs and shared clones, build-config changes weighed |
| `references/workflow-details.md` | This page |
| `references/desktop.md` | Any desktop target: launch, isolation, IPC, routing, code outside the renderer, what differs from web |
| `references/emulator.md` | `device: emulator`, the `trezor-emulator` MCP, real data |
| `references/mcp.md` | Exploring a build with the Playwright / chrome-devtools(-electron) MCPs, traces, heap snapshots |
| `references/discovery.md` | A Suite that answers `devtoolstooldiscovery`: the tool contract, what `__H` prefers, the per-side check |
| `references/fnbench.md` | A function-level A/B in Node (`rig/fnbench.mjs`): its config, reading the controls, the traps (shared inputs, memory layout, GC in medians, JIT sharing) |
| `references/problem-classes.md` | Step 2 (diff → suspects) and checking coverage in the report |
| `references/house-rules.md` | Step 2 rule scan, and citing the fix in the report |
| `references/seeding.md` | Store seeding: the `@storage/load` payload, gates, account shape |
| `references/pitfalls.md` | Any number that looks wrong; before trusting a trace, an INP figure or a leak |
| `rig/templates/` | Start of every run: run.json, plan.json, scenario.mjs, page.js, narrative.json |
| `examples/` | Worked scenarios (SKILL.md step 4) |
| `scripts/analyze-trace.mjs` | Category breakdown of a DevTools trace (MCP traces included) |
| `assets/` | The older DevTools-MCP-only harness (`harness-core.js` primitives: mount/update/interact/scroll/navigate/cycle/boot) — ideas for scenario shapes; not for timing |
