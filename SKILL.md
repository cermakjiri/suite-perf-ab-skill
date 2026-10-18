---
name: suite-perf-ab
description: >
  Measure and compare runtime performance of a Trezor Suite branch or PR against its target branch
  (develop), on web and on the Electron desktop app, with a reusable Playwright rig: it first checks
  the branch is up to date with its target (and advises a rebase when it is not), builds both
  revisions locally as release production builds in copy-on-write clones, proves from the commit
  every bundle inlines which build each session ran, records React Compiler coverage per side, seeds
  identical wallet state (synthetic store state, or a trezor-user-env emulator with real backends),
  replays the interaction at 4x and 1x CPU in ABBA session order, and compares session medians of
  main-thread CPU, long tasks, frames, input delay, React commits and memory, deltas in both
  directions. Several runs can share a machine, one measured session at a time. A run only writes
  its scenario.
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
  debug flaky tests, audit a public site, write a standalone JS microbenchmark (a function-level A/B
  of two Suite revisions is this skill's rig/fnbench.mjs), or merely summarize a branch.
---

# Suite performance A/B

Measure a branch against its target branch (`develop`, or a backport's `release/*`) and say, with
numbers a reviewer can trust, what got faster, slower, or did not move — web, desktop or both. The
rig is `rig/` (`references/rig.md`); the why behind each rule: `references/workflow-details.md`.

## A good run has

- A comparable pair: up to date with its target (or the gap accepted, stated), built locally with
  CI's recipe (release profile), no coverage, every session proven to run its side's commit; React
  Compiler coverage per side; a code-identical target reported as unaffected, not timed.
- One scenario per suspected problem class, one interaction, fresh data per iteration.
- ≥4 sessions per side, ABBA, 4x and 1x. **The session is the unit**: call a timing difference only
  when every session median of one side lies beyond the other's (4 v 4: p 0.029). Counts need not.
- A paired injected-cost control that lands; a negative control where one applies.
- Deltas both ways, attribution for whatever moved, explicit caveats.

## Rules

- **Small context**: no whole log, file or table in the conversation — `tail`/`grep`,
  `aggregate.mjs --brief`, `report.txt`, references by section (`grep '^## '`), code through an
  Explore subagent (read a file yourself only to edit it): a 30k-token read followed by 100 calls
  costs ~3M tokens.
- **Every permission up front**, one batch: the sandbox-off commands below and the hosts
  `github.com`, `api.github.com`, `registry.yarnpkg.com` (+ backends for `network: live`). Never
  `chmod +x`; run scripts as `node <file>`.
- **Wait in the background**: `build`, `plan`, `open`, `tenv up` and anything over ~1 min with
  `run_in_background`; no foreground sleep loops or repeated status polls, never `--watch` in your
  own Bash. After starting one, tell the user what runs, its estimate and finish time, and:
  **Run `node <skill>/rig/status.mjs --run=<id> --watch` in a terminal tab, not with `!` in the
  Claude prompt — a `!` check re-enters the conversation and my reply re-reads the whole context
  (8 such checks cost 6.8M tokens).** With the terminal tools (`mcp__terminal__run_in_terminal`),
  open that tab yourself when a plan starts and link it.
- **No timing number from an MCP-attached page**: its debugger makes spreads ~25x slower.
- **Parallel runs** take turns on the machine (stage `queued`); say so when another run holds it.

## The rig

| `node <skill>/rig/…` | Does | Sandbox |
| --- | --- | --- |
| `revs.mjs --run=<id> --pr=<n>` / `--branch=<b>` | pin A and B, up-to-date check | on |
| `preflight.mjs [--run=<id>]` | machine, power, builds, bundles | either |
| `build.mjs --run=<id> --targets=web[,desktop]` | build both sides, compare bundles | on |
| `fingerprint.mjs` · `bundlediff.mjs --run=<id>` | what a build is · do the sides differ | on |
| `open.mjs --run=<id> --side=B` | one side open for the MCPs | **off**, bg |
| `run.mjs --run=<id> --side=A --out=<f>` | one page session | **off** |
| `plan.mjs --run=<id> [--only=counts,pilot]` | the plan, resumable | **off**, bg |
| `status.mjs --run=<id> [--watch \| --events]` | where it stands · Monitor events | on |
| `aggregate.mjs --run=<id> [--brief]` · `report.mjs --run=<id> --text` | statistics · report | on |
| `attr.mjs <x.cpuprofile> --run=<id> --side=A` | CPU profile → source | on |
| `fnbench.mjs --config=<file> [--run=<id>] [--dry]` | Node function-level A/B: code no page reaches, a pure function by size (`fnbench.md`) | on, bg |
| `tenv.mjs up \| prepare \| down` · `cleanup.mjs` | emulator · disk | **off** · on |

## Workflow

**Checklist** (the app's task list, `mcp__ccd_turn__update_plan`), each item with its estimate and
`≈ HH:MM`, the current one in progress: `Pin + preflight` · `Brief the diff` · `Build <targets>` ·
`Scenario + smoke` · `Counts + pilot` · `<pass> · N sessions · ≈ HH:MM` per timing pass · `Control`
· `Aggregate + report` · `Cleanup`.

### 0. Before pinning

Read the context size (`mcp__ccd_session_mgmt__get_usage`, else estimate). Above ~150k tokens stop:
tell the user the size, that each of the run's ~55–75 calls re-reads it (calls × size), and offer a
fresh session with a brief (`start_session`) — or continue on their word. Then `preflight.mjs`: a
power BLOCK (battery, Low Power Mode) means timing will wait — ask the user to plug in. A branch
behind its target: step 1.

### 1. Pin the revisions

`revs.mjs` pins A = the target's tip, B = the head when the branch is up to date; `preflight.mjs
--run=<id>`. **Behind** (exit 3) pins nothing: never work around it yourself — ask the user, leading
with **rebase first** (recommended: as it stands the result can be inconclusive), else
`--accept-behind=merge-base` (its own commits on the old base) or `--accept-behind=merge-ref`
(GitHub's merge, no conflicts). Every bundle inlines its commit: no marker needed (`builds.md`).

### 2. Diff → suspects → scenarios

An Explore subagent reads `git diff <A> <B>` (changed files in full, both revisions where needed)
and returns a brief: entry points, thunks, selectors, testids, routes, mechanism, what to seed.
Work it through `references/problem-classes.md` and `house-rules.md` (both to the subagent for a
large diff); write the suspects down before measuring. The PR description is a hypothesis: shared
code has consumers the author never measured.
- **Targets**: web; add desktop for desktop code, IPC, Electron paths, or when asked
  (`references/desktop.md`). A code-identical target (step 3) is unaffected: report, do not time.
- Code that does not run on the renderer's main thread (a backend behind `createIpcProxy`, Electron
  main or a utility process, connect core on desktop, a Web Worker) moves no renderer metric:
  references/desktop.md, "Code outside the renderer", says where a changed module runs and what to
  time instead.
- **Device**: synthetic or emulator (`workflow-details.md`). Manual or accept-edits mode (or none
  named): ask (AskUserQuestion, recommendation first); bypass or auto: choose and say why. Record it in
  `run.json` (`device`; emulator: `network: live`) and the reason in the caveats.
- **Persistence off** (`remember: false`) unless the diff touches storage (`packages/suite/src/
  storage`, the storage middleware, IndexedDB code), plus one persisted pass as a negative control:
  the drain is most of a persisted iteration (PR 33507: ~11 of ~17 s). Suite draft PR #33456 fixes
  it; this rig with persistence on is how to A/B it.

### 3. Build (in the background while you write the scenario)

`build.mjs` — CI's recipe per side in a copy-on-write clone, `release` profile (`--profile=preview`
for what CI previews are), fingerprinted, cached by SHA + profile. It merge-writes `run.json`
(edit it meanwhile freely) and compares the sides' JS: **code-identical** (apart from mangled
names, hashes, commit, signed config) or the files that differ. `references/builds.md`.

### 4. Write the scenario

Copy `rig/templates/scenario.mjs` + `page.js` to `<run>/scenario/`, from the closest example:

| Example | Shows | Targets |
| --- | --- | --- |
| `history-load/` | seeded store, mocked connect, the real thunk via `suite.thunk`, persistence off + a persisted negative control | web + desktop |
| `account-switch/` | stored transactions, Node-side trusted clicks (INP), size knob | web + desktop |
| `desktop-ipc-backend/` | code outside the renderer: a backend in an Electron utility process driven over `window.ipcProxy` (spawn and call phases), data from `it.n`, the result hashed and compared across sides (`hashes.mjs`), dispose in `after()` and `reset()`, idle-corrected renderer CPU, cold and warm (`--cfg.warm=1`) calls | desktop |
| `emulator-accounts/` | real device, live data, waiting for discovery | web + desktop, emulator |
| `emulator-history-load/` | the real thunk against live backends, one cold load per session | web, emulator |
| `fnbench-coinjoin/` | a `fnbench.mjs` config + data module: coinjoin `getAccountInfo` old vs new by size, a one-file hybrid, a cost model for sizes the old side cannot finish | Node |

Contract (`references/rig.md`): `seed()`, `postInit()`, measured `phases` that resolve when the
user-visible work is done, `after()` that restores and verifies, `valid()`. Honest scenarios:
**one dispatch**, not many; **fresh data per iteration** (`it.n`; seed `RUN.iterations + RUN.spares
+ 1`); **a known start** (the `route`; `reset()` when phases navigate away); **trusted input** for
responsiveness (Node-side `page.click`; Event Timing ignores `dispatchEvent`); **two sizes** for
anything size-sensitive; counting instrumentation in its own pass; a phase that waits on its own
gives up before `H.RUN.phaseTimeoutMs` with `{ timedOut }`. Prototype against a live build with
`open.mjs` and the MCPs (`workflow-details.md`).

### 5. Core checks, then more only if it can change the result

Template order: `counts` (AB, k 1, 1x, `fiberStats`: no timing claims), `pilot` (AB, k 1, 4x, smaller size), `main`
(ABBAABBA, k 8, 4x + 1x), `ctl` (ABBA, k 10, 0 / 10 ms injected per unit of work in ABBA order),
extra sizes and negative controls after; `more` only when named. Only `timing` passes carry a
verdict (other roles: `counts`, `trial`, `control`). Run `plan.mjs --only=counts,pilot`, read the
counts and logs, then `plan.mjs` (sandbox off, background). The plan by itself:
- runs a **size pilot** (k 1, 4x, trial, never pooled) per unmeasured timing workload: ETAs from the
  matching size (`~`: another size, re-estimated from the pass's own iterations);
- **fails fast**: a phase timeout is not retried as is — the pass is marked failed (`drain >
  10:00`) and the plan goes on; a first iteration past 5× its size pilot stops the pass; no single
  iteration is ever dropped;
- **waits for AC power** before timing and control (ask the user past ~10 min) and for free
  **performance cores** (a quiet machine is still cleanest; read 1x next to the E-share flag);
- logs to `out/plan.log`, every attempt to `out/<session>.attempt<n>.log`.

While it runs, arm `status.mjs --run=<id> --events` with the Monitor tool (`timeout_ms` 1800000,
re-arm on expiry) and refresh the checklist on each event (each wake is one model call, ~0.15–0.25M
tokens in a fresh session; ~6–10 a run). It ends with
`aggregate.mjs --brief`: draft the result right after; `--only=more` only when the advice says
more sessions could change a verdict. Prefer 4x for CPU totals (after idle the first ~30 ms of work
runs 2.5–3x slower on Apple silicon, which compresses 1x deltas).

### 6. Read the result

Read the brief (each line explained in `references/rig.md`, aggregate.mjs). Before believing a
delta check: the **control** landed (~70–110 %, each injected iteration against its plain
neighbours; if not, the metric cannot see this workload); **drift** (flagged when the climb over
a session reaches a third of the reported Δ: state builds up per iteration, the medians hold for
this k; below that it is information); **env per side** (commit ✓, profile,
`coverageFiles` 0, one React renderer, calibration 4x ≈ 4× 1x, canary ≈ 1, performance cores, AC;
aggregate refuses two builds or power sources, warns on different page tools — put that in the
caveats); **window length**
(a much longer phase on one side: compare `taskCorrMs` and counts); a delta with **no mechanism in
the diff** gets attributed first (`--profile-at=3`, `attr.mjs`: thread time says how much, the
profile where; they disagree on promise-heavy code such as IndexedDB).

### 7. Report

Write `narrative.json` (`rig/templates/`), run `report.mjs --run=<id> --text` and review
**`report.txt`**, not the HTML (~8–10k vs ~40k tokens); load `artifact-design`, publish
`report.html` with the Artifact tool. **Lead with the regression**; check the stated motivation
apart from the result; cite the house rule behind each fix or say none covers it (a memo's value
depends on the side's compiler coverage); say what was covered and what was unaffected; caveats:
synthetic vs emulator, sessions and k, the base SHA, the machine; never compare web with desktop.

### 8. Clean up

`cleanup.mjs` lists clones and runs; drop what you will not reuse with `--clone=<name>
--run=<id>` — a clone another run pins, or another local branch is based on, needs `--force`.
`tenv.mjs down` if you started the emulator. Keep the run folder.

**In `references/workflow-details.md`**: the measured why of each rule, checklist and events in
full, the device choice, MCP exploration, performance cores and power, parallel runs, deployed
previews (only when a local build is impossible), what every bundled file is for.
