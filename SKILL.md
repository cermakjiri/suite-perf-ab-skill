---
name: suite-perf-ab
description: >
  Measure and compare runtime performance of a Trezor Suite branch or PR against develop, on web
  and on the Electron desktop app, with a reusable Playwright rig: both revisions are built in
  copy-on-write clones, every page session seeds identical wallet state (synthetic store state, or a
  trezor-user-env emulator with real backends), the interaction is replayed at 4x and 1x CPU in ABBA
  session order, and the report compares session medians with main-thread CPU, long tasks, frames,
  input delay, React commits and memory, deltas in both directions. A run only writes its scenario.
  Use it whenever someone wants to benchmark, profile, or A/B a Suite branch or PR, verify or
  challenge a perf claim before approving or merging, ask whether a change made Suite (web or
  desktop) faster, slower, janky or leaky, check how a surface holds up with a large seeded wallet,
  or raises render and scripting time, React commits or re-renders, total blocking time, forced
  reflow, style recalculation, jank, dropped frames, INP, memory growth, IndexedDB/persistence cost
  or DOM size for a Suite change — even without the word "profile", and even when they only
  advertise a win, since catching unmeasured regressions is half the job. Also for exploring a
  build interactively through the Playwright MCP or the chrome-devtools(-electron) MCP before
  measuring. It only measures and compares: do not use it to write the optimization, fix the slow
  code, profile suite-native, time builds, CI or jest runs, compare bundle sizes (suite-bundle-ab),
  debug flaky tests, audit a public site, add a JS microbenchmark, or merely summarize a branch.
---

# Suite performance A/B

Measure a branch against `develop` and say, with numbers a reviewer can trust, what got faster,
what got slower, and what did not move — on web, on desktop, or both.

Everything but the scenario is in `rig/` (reference: `references/rig.md`). A run writes two files
— the scenario's Node part and its in-page part — and a run definition; building, launching,
seeding order, throttling, probes, sessions, statistics and the report are shared. A typical run:
~10 min to build and write the scenario, ~25 min of unattended timing, ~10 min to read and report.

## What a good run produces

- A build pair proven comparable: production builds of pinned SHAs made with the same command,
  no coverage instrumentation, a code marker per side that proves which build ran.
- One scenario per suspected problem class, isolating one interaction, with fresh data per iteration.
- ≥4 page sessions per side in ABBA order at 4x and 1x CPU. **The session is the unit**: iterations
  inside one session are correlated (same-build sessions differ up to 2x at 4x), so a timing
  difference is called only when every session median of one side lies beyond the other's (4 v 4
  separated: p 0.029). Counts (commits, rows, layouts) need no such care.
- A paired injected-cost control that lands (the metric can move) and, where it applies, a negative
  control (a pass where the change cannot matter reads the same on both sides).
- Deltas in both directions, attribution for anything that moved, explicit caveats.

## The rig at a glance

| Step | Command (all `node <skill>/rig/…`) | Sandbox |
| --- | --- | --- |
| Check machine, checkout, builds | `preflight.mjs --run=<id>` | either |
| Build both sides (clones, cached by SHA) | `build.mjs --run=<id> --targets=web[,desktop]` | on |
| Explore one side with the MCPs (CDP :9222) | `open.mjs --run=<id> --side=B [--target=desktop]` | **off**, background |
| One page session | `run.mjs --run=<id> --side=A --out=<f>` | **off** |
| The whole plan, ABBA, resumable | `plan.mjs --run=<id> [--only=counts,pilot]` | **off**, background |
| Where it stands: stage, iteration, ETA | `status.mjs --run=<id>` (instant) | on |
| Session statistics + advice → summary.json | `aggregate.mjs --run=<id>` | on |
| Self-contained HTML report | `report.mjs --run=<id>` | on |
| CPU profile → source files | `attr.mjs <x.cpuprofile> --run=<id> --side=A` | on |
| Emulator (trezor-user-env) | `tenv.mjs up \| prepare \| down` | **off** |
| Disk | `cleanup.mjs [--clones --older-than=3]` | on |

Runs live in `$PERF_AB_HOME` (default `~/.local/share/suite-perf-ab`: outside every worktree,
writable from the sandbox), one folder per run; clones and builds are shared between runs.

The rig is ES modules (`.mjs`, scenarios included: `export default { … }`) written for the latest
Node LTS (24). Builds run yarn with the `.nvmrc` Node of the revision being built when nvm has it
(else the running Node, with a warning), so both sides are built by the same Node.

**Prompts**: ask for everything up front in one batch — the sandbox-off commands above, `git
fetch`, and any network host the run needs (`dev.suite.sldev.cz` for deployed previews, the
backends for `network: live`). Never `chmod +x` (it prompts even in bypass mode); run every script
as `node <file>`.

**Wait in the background.** Start `build.mjs`, `plan.mjs`, `open.mjs`, `tenv.mjs up` and any step
longer than about a minute with Bash `run_in_background: true`; the completion notification
re-invokes you. Never wait in the foreground: no `until …; do sleep …; done`, no repeated status
polling (the last run lost 120 min to 29 such loops, 7 of them killed at the 10-minute limit).
After starting a step, tell the user in one line what runs, the estimate and finish time (the
first line it prints) and the status command.

**Progress.** `node <skill>/rig/status.mjs --run=<id>` answers at once, in ≤ 8 lines: what runs
(pass, session, stage, rate, iteration, phase), done / failed / to go, elapsed, ETA and finish
time, the build if one is going, and whether the plan died or stalled. The background task's
output has a heartbeat line with the stage and the ETA on every stage change and every 30 s. The
user can run `status.mjs --watch` in their own terminal; never run `--watch` yourself.

## Workflow

### 1. Preflight and pin the revisions

```bash
git fetch origin pull/<n>/head                           # the PR head, by SHA from here on
git merge-base origin/develop <pr-head-sha>              # side A: develop at the PR's base
node <skill>/rig/preflight.mjs                           # load, disk, power, Playwright, port 9222
```

Side A is the merge-base, not today's develop: exactly the PR's commits apart. Create the run
folder: `$PERF_AB_HOME/runs/<id>/` with `run.json` and `plan.json` copied from `rig/templates/`.
Fill `sides.A/B.rev` with SHAs and give each side a **marker** — a string only the PR's code
contains (a template literal, an action type, an error message the minifier keeps) with the module
count expected (0 on A, ≥1 on B). The runner refuses a session whose bundle does not match.

### 2. Turn the diff into suspects, then scenarios

**Read code through a subagent.** An Explore subagent reads the diff (`git diff <merge-base>
<pr-head>`: every changed source file in full, the surrounding file at both revisions where the
diff alone does not say what the code did before) and the code path, and returns a brief: entry
points, thunks and selectors, testids and routes, the expected mechanism, what to seed. Keep only
the brief in the main conversation; read a file directly only when you are about to edit it. The
last run read 1.06M characters of code into the main conversation and compacted three times.

From the brief, work through `references/problem-classes.md` (six ways an SPA regresses × what a
diff touches) and the repo's `skills/performance-*` rules with `references/house-rules.md` (give
both to the subagent when the diff is large). Write the suspect list down before measuring. Treat
the PR description as a hypothesis; a perf PR usually touches shared code whose other consumers
the author never measured.

Pick targets: **web** by default; add **desktop** when the change touches desktop code, IPC,
Electron-specific paths, or when someone asks about desktop (references/desktop.md). Pick the
device: **synthetic** (seeded store, mocked backend: deterministic, the default) or **emulator**
(trezor-user-env, real connect + discovery + live backends: real data, noisier; references/emulator.md).

### 3. Build both sides (in the background while you write the scenario)

`node <skill>/rig/build.mjs --run=<id> --targets=web` (add `,desktop`). Per side: copy-on-write
clone of the main checkout (~20 s), forced checkout of the SHA, optional `patch` (a variant: a
reverted hunk, a tweaked constant), offline `yarn install --immutable --mode=skip-build` (~3 s),
then the same build command on both sides (web ~35-60 s, desktop ~55 s) with no Sentry token and
no `INSTRUMENT_CODE`. A cached SHA builds in 0 s. It writes the build paths into `run.json`, numbers
its steps (`[A 3/4] web build … (last 0:52)`) and estimates them from earlier builds on this machine.

### 4. Write the scenario

Copy `rig/templates/scenario.mjs` and `page.js` to `<run>/scenario/` and start from the closest example:

| Example | Shows | Targets |
| --- | --- | --- |
| `examples/history-load/` | store seed, mocked TrezorConnect pages, a real thunk from the bundle, IndexedDB probe, load/drain phases, idle correction, counting pass, negative control | web (desktop bundles do not export the thunk) |
| `examples/account-switch/` | stored transactions in the seed, Node-side phases with trusted clicks (valid INP), size knob | web + desktop |
| `examples/emulator-accounts/` | real device and live data: settings-only seed, device checks off, waiting for discovery | web + desktop, `device: emulator` |

The contract (`references/rig.md`): `seed()` before Suite finishes init, `postInit()` for mocks and
lookups, measured `phases` that resolve when the user-visible work is done, `after()` that restores
state and verifies the iteration, `valid()` that drops an iteration that did not do its job.
`window.__H` gives store/connect access, `findThunk`, `goto`, `waitFor`, `injectCost` and the probes.
Rules that keep a scenario honest:

- **One dispatch, not many** — the store renders synchronously per dispatch.
- **Fresh data per iteration** when the app caches results (index targets by `it.n`, and seed
  `RUN.iterations + RUN.spares + 1` of them: a discarded iteration is retried with the next `it.n`).
- **A known start**: every iteration starts at the scenario's `route`. After a discarded attempt the
  runner restores it with page.js `reset()` (default: `after()`, then the route) and checks it; give
  a scenario whose phases navigate away a `reset()` (examples/account-switch).
- **Trusted input** for anything about input responsiveness: a Node-side phase with `page.click` /
  `page.keyboard`; Event Timing ignores `dispatchEvent`.
- **Two sizes** for anything size-sensitive (a `cfg` knob, one pass each): flat vs linear is the
  most convincing result available.
- Counting instrumentation (patched prototypes, fiber walks) only in its own pass.

Prototype the in-page part against a live build before the first timing pass: `open.mjs` keeps one
side open on CDP :9222 with the scenario loaded, and the MCPs attach to it (references/mcp.md):
the Playwright MCP for testids and `browser_evaluate` of `window.__A.phases.x(…)`, the
chrome-devtools-electron MCP for a trace or a heap snapshot. **Never take a timing number from an
MCP-attached page**: the DevTools MCP turns the V8 debugger on, which makes array spreads ~25x
slower (the env canary shows it: spread/slice ≈ 1 normal, ≈ 25 attached).

### 5. Core checks first, then more only if it can change the result

The template plan runs the core checks in this order: `counts` (AB, k 1, 1x, `fiberStats` on —
deterministic counts confirm the mechanism, no timing claims), `pilot` (AB, k 1, 4x, a smaller
size if the scenario has a knob — both sides run, and it gives the ETA its per-iteration time),
`main` (ABBAABBA, k 8, 4x and 1x), `ctl` (ABBA, alternating 0 / 10 ms of injected cost per unit
of work inside each session). `more` (one more ABBA block of main) is optional: it runs only when
named. Put a second size or a negative control (`cfg` that switches the mechanism off) after `ctl`.
Every pass has a `role` (`counts`, `trial`, `timing`, `control`); only timing passes carry a
verdict. Run them as two background plans (sandbox off, `run_in_background: true`):

```bash
node <skill>/rig/plan.mjs --run=<id> --only=counts,pilot      # ~2 min: read the counts and the logs
node <skill>/rig/plan.mjs --run=<id>                          # ~25 min: every other non-optional pass
```

**Performance cores** (macOS on Apple silicon, on by default): every measured iteration of a
timing, control or trial pass waits until performance cores are free and the renderer's main
thread runs on one at full clock; a session that cannot get there (cores busy for 15 min, a
demoted renderer, a low clock) fails with the reason instead of measuring. An iteration is
discarded and retried with fresh data only when another program's load (under 1 performance core
free) or a demotion of the thread (`taskpolicy -b`, App Nap, a hidden window) pushed its work onto
efficiency cores; the log line says which. A busy machine mostly makes the plan wait
(`pcore-wait`), but contention shorter than ~100 ms goes unseen, so a quiet machine still gives the
cleanest data. Efficiency-core time with performance cores free is macOS's own placement of light
1x work: it is kept and reported per side as `pcore.eSharePct` in every table, and the advice and
the report flag sides that differ by 5 points or more — read a 1x time difference next to that
flag (measurements: references/rig.md).

The second plan skips the finished counts and pilot sessions. Draft the result right after it:
aggregate, report, narrative. Run `--only=more` (its sessions pool into main as `main-5-A` …,
then re-aggregate) only when the aggregate's advice says more sessions could change a verdict.
Sessions are resumable (re-run the command) and logged per session in `out/`; each plan ends with
the aggregate. Prefer 4x for CPU totals (after idle the first ~30 ms of work runs 2.5-3x slower on
Apple silicon, which compresses 1x deltas; the rig's warm-up spins counter most of it).

### 6. Read the result

`aggregate.mjs` prints the headline metrics per pass and rate: pooled p50/p75 with min–max, Δ of
the session medians, the session medians themselves and the verdict (`B lower` / `B higher` /
`overlap`, permutation p). Then any other metric whose sessions separate (p ≤ 0.1, |Δ| ≥ 5%).
Last the advice: per timing pass and rate, each timing headline metric is called, underpowered
(these session counts cannot reach p ≤ 0.1: 2 v 2 at best 0.333), borderline (p ≤ 0.25) or
settled; the control is landed, inconclusive, underpowered (raise ctl k) or failed (every session
missed 70–110% the same way). `next:` lines say what one more block could call (with its
estimate and command), that the draft is stable, or — only for a failed control — to fix the rig
before adding sessions.
Before believing a delta:

- **Controls**: the injected cost landed (roughly 70-110% of what was injected; at 1x a lighter
  build can read lower). If it did not, the metric cannot see this workload.
- **Env per side**: markers as expected, `coverageFiles` 0, React renderers 1, calibration 4x ≈ 4×
  1x, the canary ≈ 1, and the performance-core line (waits, discards, E share, P clock).
- **Window length**: when one side's phase lasts much longer (a drain), compare `taskCorrMs`
  (idle-corrected) and the counts, not raw totals or percentiles over the window.
- A delta with no mechanism in the diff gets attributed before it is reported: `--profile-at=3` on
  one session per side, then `attr.mjs` (source-mapped self/inclusive time). CDP thread time says
  how much, the profile says where — they can disagree on promise-heavy code (IndexedDB).

### 7. Report

Write `<run>/narrative.json` (template in `rig/templates/`): verdict cards, findings, root cause
sections, caveats. Then `node <skill>/rig/report.mjs --run=<id>`, load the `artifact-design`
skill, and publish `report.html` with the Artifact tool. Habits that make it trustworthy:

- **Lead with the regression if there is one.** The author already knows about the win.
- **Check the stated motivation separately from the result.** If the claimed mechanism does not
  show up, say what the win actually came from. When the change the numbers did not credit is one
  a house rule requires, say that too ("mandated by `performance-dom` regardless").
- **Root cause and fixes cite the house rule** (`references/house-rules.md`); where no rule covers
  it, say so instead of dressing an opinion up as policy.
- **Coverage**: which of the six problem classes were measured, which suspects could not be reached.
- **Caveats**: synthetic vs emulator state, sessions and k, the base SHA, the machine and its load,
  web and desktop numbers are never compared with each other.

### 8. Clean up

`node <skill>/rig/cleanup.mjs` lists clones (big), runs (small) and desktop profile dirs. Keep the
run folder (report, summary, sessions); drop clones you will not reuse. If `tenv.mjs up` started
the emulator, `tenv.mjs down`.

## Deployed previews instead of local builds

A side can be `"url": "https://dev.suite.sldev.cz/suite-web/<branch>/web/"` instead of a `rev` (no
build). Only if both sides are previews, both are production builds of the same workflow, and
`env.coverageFiles` reads 0 on both: PR previews come from the e2e workflow with Istanbul on,
develop's usually not, which manufactures a regression on the branch. Pin the baseline: develop
redeploys on every push, and a merge mid-run collapses every delta toward zero.
`references/pitfalls.md` has the details. Local builds avoid all of it.

## Bundled files

| File | Read it when |
| --- | --- |
| `references/rig.md` | Writing run.json / plan.json / a scenario; every script's flags; output and metric names |
| `references/desktop.md` | Any desktop target: launch, isolation, IPC, routing, what differs from web |
| `references/emulator.md` | `device: emulator`, the `trezor-emulator` MCP, real data |
| `references/mcp.md` | Exploring a build with the Playwright / chrome-devtools(-electron) MCPs, traces, heap snapshots |
| `references/problem-classes.md` | Step 2 (diff → suspects) and checking coverage in the report |
| `references/house-rules.md` | Step 2 rule scan, and citing the fix in the report |
| `references/seeding.md` | Store seeding: the `@storage/load` payload, gates, account shape |
| `references/pitfalls.md` | Any number that looks wrong; before trusting a trace, an INP figure or a leak |
| `rig/templates/` | Start of every run: run.json, plan.json, scenario.mjs, page.js, narrative.json |
| `examples/` | Worked scenarios (see step 4) |
| `scripts/analyze-trace.mjs` | Category breakdown of a DevTools trace (MCP traces included) |
| `assets/` | The older DevTools-MCP-only harness (`harness-core.js` primitives: mount/update/interact/scroll/navigate/cycle/boot) — ideas for scenario shapes; not for timing |
