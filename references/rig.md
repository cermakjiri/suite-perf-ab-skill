# The rig: reference

Everything a run does except the scenario lives in `rig/`. A run is a folder with a `run.json`,
a `plan.json`, the scenario (two files) and what the rig writes. This page is the full reference;
SKILL.md has the workflow.

All Node code is ES modules (`.mjs`, `node:` built-ins, packages from the checkout loaded with
`import()`), zero-dependency, written for the latest Node LTS (24: `import.meta.main`,
`Promise.withResolvers`, `util.parseArgs`, global `fetch`/`WebSocket`). `build.mjs` runs yarn with the
Node of the revision's `.nvmrc` when nvm has it (`$NVM_DIR/versions/node/v<version>`), else the
running Node with a warning; `--node=<binary>` overrides. Why the pair, the recipe, the profiles, the
commit proof and the locks are what they are: `references/builds.md`.

## Layout

```
$PERF_AB_HOME (default ~/.local/share/suite-perf-ab — writable from the Bash sandbox, outside every worktree)
  runs/<run-id>/
    run.json          sides, target, device, profile, scenario path    (revs.mjs creates it; you add the rest)
    plan.json         passes                                           (rig/templates/plan.json)
    scenario/         scenario.mjs + page.js                           (copy rig/templates/, or point at examples/)
    narrative.json    verdict text for the report                      (you write it, last)
    preflight.json    last preflight result
    build-status.json build.mjs progress: side, step i/n, its estimate, state
    out/<pass>-<n>-<side>.json|.log   one page session each; .cpuprofile with --profile-at
    out/progress/<pass>-<n>-<side>.json   live snapshot of a session (run.mjs --progress)
    out/plan-status.json              state, progress and ETA of the last plan
    summary.json      aggregate.mjs output, advice included
    report.html       report.mjs output
    traces/           DevTools MCP traces moved here (the MCP can only write inside the session cwd)
    open-<side>.json  pid, CDP port and URL of a live open.mjs session
  clones/<sha12>[-<variant>].<profile>/   copy-on-write clone + its build, reused by every run on that commit
    .perf-ab-build.json   its state: sha, buildSha, profile, prep, targets with their fingerprints
    .perf-ab-users/       live sessions and explorations serving it (pid files)
  apps/<run>-<side>/            desktop --user-data-dir of each session (wiped at start)
  profiles/<run>-web-<side>/    persistent Chromium profile of an open.mjs session
  locks/<name>/                 FIFO lock queues: machine, clone-<name>, emulator (rig/locks.mjs)
  yarn-cache/                   packages fetched for revisions newer than the checkout's cache
  timings.json                  the last 5 durations of every build step, for build.mjs's estimates
```

Files other processes poll (progress, plan and build status, timings) are written atomically
(a tmp file named by pid and a random suffix, then rename); a failed write warns once and never
fails a session or a build.

`run.json` paths are absolute, relative to the run dir, or `skill:<path>` (inside this skill, e.g.
`skill:examples/history-load/scenario.mjs`).

## Sandbox matrix

| Script | Sandbox | Why |
| --- | --- | --- |
| `preflight.mjs` | either (off sees `ps`, ports, docker) | read-only |
| `revs.mjs` | on (network: `github.com`, `api.github.com`) | fetches into the checkout's `.git` |
| `build.mjs` | on (network: `registry.yarnpkg.com` when the cache lacks packages) | clones under `~/.local/share`, yarn, webpack |
| `fingerprint.mjs` | on | files only |
| `run.mjs`, `plan.mjs`, `open.mjs` | **off** | Chromium/Electron die on the Mach-port rendezvous inside it |
| `tenv.mjs` | **off** | docker socket, local WebSocket |
| `aggregate.mjs`, `report.mjs`, `status.mjs`, `attr.mjs`, `cleanup.mjs` | on | files only |

Never `chmod +x` anything: it prompts even in bypass mode. Every script runs as `node rig/<x>.mjs`.
`rsync` is denied by a permission rule here; copy with `cp -R`.

## run.json

```json
{
  "id": "pr33320-history",                    // folder name; report title fallback
  "title": "PR #33320 — coalesce per-page IndexedDB rewrites",
  "pr": "https://github.com/trezor/trezor-suite/pull/33320",
  "target": "web",                            // web | desktop   (plan args can override per pass)
  "device": "synthetic",                      // synthetic | emulator (references/emulator.md)
  "network": "none",                          // none (default for synthetic) | live
  "emulator": { "model": "T3T1", "fw": "2-latest", "mnemonic": "mnemonic_all" },  // "prepare": false = use the device already on the bridge
  "build": { "profile": "release" },          // release (IS_CODESIGN_BUILD=true, default) | preview
  "scenario": "scenario/scenario.mjs",
  "cfg": {},                                  // scenario cfg overrides for every pass
  "base": { "branch": "develop", "tip": "…", "mergeBase": "…", "behind": 0, "ahead": 3, "mode": "tip", "state": "up-to-date", … },  // revs.mjs
  "sides": {
    "A": { "label": "develop", "rev": "163bed71c0…" },
    "B": { "label": "PR #33320", "rev": "38f4a19936…" },
    "B2": { "label": "PR + revert of X", "rev": "38f4a19936…", "patch": "revert-x.diff", "variant": "revert-x" }
  }
}
```

- `revs.mjs` writes `base` and `sides.A/B.rev` (full SHAs: a push mid-run cannot move a side) and
  creates the run folder when needed. `base.state`: `up-to-date`, `behind-accepted` (with `mode`
  `merge-base` | `merge-ref`), or `behind` — nothing pinned, `build.mjs` refuses. Sides written by
  hand (`rev`: anything `git rev-parse` resolves in the main checkout) skip the check.
- `build.mjs` adds per side `sha`, `buildSha` (a variant's own commit, when it has a `patch`),
  `profile`, `clone`, `web` (the build dir), `desktop` (the `suite/desktop-app` dir), `fingerprint`
  per target (commit, release, coverage, React Compiler coverage) and `guide` (the inherited guide
  content's hash).
- `markers` (optional): a source string and the number of bundle modules expected to contain it.
  The commit proves which build ran; a marker proves a given piece of code is in it (not
  tree-shaken, not behind a flag). `run.mjs` aborts a session whose build does not match;
  `preflight.mjs` greps the build offline. Pick a string the minifier keeps.
- A side with `url` (a deployed preview) is loaded as is, nothing built: compare like with like,
  and check `env.coverageFiles` — PR previews are Istanbul-instrumented, develop's are not. Its
  commit is recorded per session (`env.build.commit`).
- More than two sides work everywhere except the report, which pairs the first two.

## plan.json

```json
{ "passes": [
  { "name": "counts", "role": "counts",  "order": "AB",       "args": { "k": 1, "rates": "1", "warmup": 0, "cfg": { "fiberStats": true } } },
  { "name": "pilot",  "role": "trial",   "order": "AB",       "args": { "k": 1, "rates": "4", "warmup": 0, "cfg": { "pages": 10 } } },
  { "name": "main",   "role": "timing",  "order": "ABBAABBA", "args": { "k": 8, "rates": "4,1", "warmup": 2 } },
  { "name": "ctl",    "role": "control", "order": "ABBA",     "args": { "k": 8, "rates": "4", "warmup": 2, "altInject": 10 } },
  { "name": "big",    "role": "timing",  "order": "ABBA",     "args": { "k": 6, "rates": "4", "cfg": { "pages": 80 } } },
  { "name": "more",   "role": "timing",  "extends": "main", "order": "ABBA", "optional": true }
] }
```

Core checks first (SKILL.md step 5): `counts`, `pilot`, `main`, `ctl`, then extra passes (a
second size, a negative control). `role` says what a pass is for, and every script decides by it
(report cards, advice, the main pass, ETA pools): `counts` (counting instrumentation on; its counts
are shown, never its timing), `trial` (pilot, smoke: never judged), `timing` (the only role that
carries a verdict), `control` (paired injected cost). Without a `role` it is inferred:
`cfg.fiberStats` → counts, `altInject` → control, a name `counts?…` → counts, `pilot|smoke|trial…`
→ trial, anything else → timing. `order` is the side sequence; sessions are numbered per side
(`main-1-A main-1-B main-2-B main-2-A …`). `args` become `run.mjs` flags (camelCase →
`--kebab-case`, `cfg` → `--cfg.<key>`). An `"optional": true` pass runs only when `--only` names
it. `"extends": "main"` runs with main's args (its own `args` merged over them) and continues main's
numbers (`main-5-A …`), so its sessions pool into main in the aggregate. Other fields (`purpose`)
are free text. Session count is what makes a timing call possible: p ≤ 0.1 needs at least 5
sessions in total (2 v 3 reaches 0.1, 3 v 3 0.1, 4 v 4 separated 0.029); 2 v 2 can never be called
(0.333).

## run.mjs — one page session

```
node rig/run.mjs --run=<id|dir> --side=A --out=<file.json>
     [--k=8] [--rates=4,1] [--warmup=2] [--cfg.<key>=<v>] [--alt-inject=10] [--target=web|desktop]
     [--profile-at=<iter>] [--idle-ms=10000] [--headed] [--phase-timeout-ms=600000] [--allow-coverage]
     [--progress=<file>|false] [--role=timing|control|trial|counts] [--slot=off]
     [--pcore=auto|off] [--pcore-free=2] [--pcore-max-wait-s=900] [--max-ecore-ms=15] [--max-ecore-pct=2] [--pcore-retries=5]
```

`--headed` (web) runs the full Chromium with a window instead of the headless shell. The window is
created as a background target (CDP `Target.createTarget` with `background: true`), so it does not
take the focus from someone working on the machine (checked on an unlocked screen: the frontmost
app stayed the user's in every 2 s sample of 4 sessions). The
`pcore` flags are the performance-core gate (next section); `plan.mjs` passes `--role` and
forwards them. They are not the pass's configuration: `meta.argv` leaves them out, and plan.mjs
strips them from a pass's `args` too before comparing (lib.mjs `passArgv`), so changing them — on the
command line or in plan.json — never makes a session stale. What does: the seed. Every session seeds
`RUN.spares` = 8 spare targets (lib.mjs `SPARES`, independent of every flag) and records
`meta.spares`; a record without it, or with another count, is stale.

Sequence: register as a user of the side's clone → [device=emulator: the `emulator` lock] → the
`machine` slot (stage `queued` while another session or build step of any run holds it; the wait is
`meta.timing.queueMs`, left out of the overhead the ETA learns) → [device=emulator: wipe + seed the
emulator, start the bridge] → launch (web: headless
Chromium, build served from disk at `http://suite.localhost/` through routes, every other host
unresolvable; desktop: Electron on the side's app dir with its own profile, relaunched if the init
script missed the first load — references/desktop.md) → init
script `window.Playwright = true; __CFG; __RUN; rig/page/core.js; <scenario page.js>` → wait
`__A.ready()` → `__A.seed()` → wait `__A.isReady()` (default: Suite lifecycle ready, router
loaded, no loading screen) → `__A.postInit()` → `scenario.nodeSetup(ctx)` → `__H.goto(route)` →
env checks (coverage 0, React hook installed before react-dom; the build: this side's commit
present in the loaded modules and no other side's, the release string's commit and codesign flag
matching the side — `env.build` = { commit, release, modules, sentinelModules, expected, verified:
true | 'offline' (not loaded yet: the build's fingerprint vouches) | null (a preview) }; markers;
`scenario.check`) →
per rate: `Emulation.setCPUThrottlingRate`, calibration loop ×5, idle window, then k × ([measured
iterations: the performance-core gate] → `__A.before` → warm-up spins → every phase with
`Performance.getMetrics` (thread ticks) read at its boundaries [and the watchdog] → `__A.after`) →
`__A.verify()`.

The output file is rewritten after every iteration and gets `complete: true` at the end.

`--progress` (default `out/progress/<session>.json` next to `--out`; `false` turns it off) is a
snapshot written atomically on every stage change and iteration boundary, otherwise at most once a
second, and at least every 30 s as a keepalive: `{ session, side, pid, startedAt, updatedAt, stage,
stageAt, rate, rates, rateIndex, iteration, k, warmup, phase, unitsDone, unitsTotal, iterMs: {
<rate>: [wall ms per finished iteration] } }`.
`stage` follows the code: `queued` (with `queue: { lock, holder, ahead, since }`), `emulator`,
`launch`, `seed`, `checks`, then per rate `calibrate`,
`idle`, `warm-up` (the iterations aggregate discards), `measure` (`profile` for the
`--profile-at` iteration), `pcore-wait` / `ready` while the gate waits (with `gate: { free, total,
since | attempts, share, ghz, ref }`), then `done` — or `failed` / `interrupted` with `error`.
`phase` is the step inside an iteration: `before`, `spin`, a scenario phase, `after`, `settle`
(after a discard). `unitsDone`/`unitsTotal` count iterations; `discards`, `discardLog`,
`gateWaitMs` and `renderer` come from the gate. The same timing lands in the record as
`meta.timing = { startedAt, durationMs, overheadMs, iterMs }` (overhead = everything but
iterations), which the ETA learns from.

### Performance cores (`rig/pcore.mjs`, `rig/native/pcore.c`)

macOS cannot pin a thread (`THREAD_AFFINITY_POLICY` returns 46, not supported); placement follows
QoS and load, and a renderer main thread on an efficiency core runs 3.7–4.9x slower with a wide
spread. So on macOS arm64 (`--pcore=auto`, the default; `--pcore=off` disables it) every
**measured** iteration of a **timing, control or trial** pass — paired-control iterations and
`--profile-at` captures included; counting passes and warm-up iterations never — goes through:

1. **Machine gate**: wait until `--pcore-free` (2; more than the machine has is refused)
   performance cores were ≥ 90 % idle over the last 0.5 s (per-core `os.cpus()` deltas sampled
   every 250 ms all session long, counted as idle capacity, 0.9 of a core per free core). This
   session's own renderer main thread is left out: CDP CPU throttling spins it in a signal handler
   for (rate − 1)/rate of the time, 0.75 of a core at 4x even with the page idle. Progress stage
   `pcore-wait`: "waiting for a performance core · 1 of 4 free · 0:40".
2. **Ready check**: a fixed ~8 ms in-page spin (`H.busy`, slower in wall time when throttled) must
   run ≥ 95 % on performance cores, at ≥ 85 % of this machine's reference P clock for the CPU rate
   (the median of the last 25 passing checks per rate in `$PERF_AB_HOME/machine.json`, enforced
   once a rate has 5), with the thread at its normal priority (below). It also waits out the
   post-idle clock ramp (1x checks read 2.0–3.9 GHz, 4x 3.9–4.25 GHz on an M4). Retried every 50 ms;
   stage `ready` with the attempt count. A check that reads ~0 ms of CPU watched the wrong thread:
   the renderer is identified again (twice at most).
   **No measurement off the performance cores**: gate and checks share one wait cap per iteration,
   `--pcore-max-wait-s` (900). When the gate cannot be met the session fails with the reason
   rather than measure — "performance cores busy for 15:00", at once after 30 s of "the renderer
   main thread is demoted (priority 4, normal 47)", after 60 s of "the performance-core clock stays
   low (… Low Power Mode or thermal throttling?)", or the ready spin still on efficiency cores at the
   cap; `plan.mjs --retries` runs the session again. (Records from before this rule have measured
   iterations flagged `gate: 'timeout'`; aggregate leaves them out with a warning.)
3. **Watchdog**: the helper streams the main thread's counters and base priority every 20 ms
   (utility QoS; real sample intervals are used, they stretch on a busy machine). Consecutive samples
   in which the thread did ≥ ~1 ms of CPU (per 20 ms) form a work segment, and efficiency-core time
   is judged only in segments with ≥ 10 ms of CPU — sustained work on efficiency cores is caught at
   any duty, isolated wake-ups are not; at throttled rates (4x) the throttle keeps the thread busy
   throughout and all efficiency time is judged. Judged time **counts** only where something pushed
   the work there:
   - **contention** — under 1 performance core free (`os.cpus()` idle time plus this thread's own P
     time) over the 100 ms up to the sample, or E-weighted over the iteration once ≥ 10 ms of judged
     time from ≥ 3 samples has accumulated: bursts that fill the cores for less than the window (on
     efficiency cores only while 0 were free, 40 ms of every 100) average out per window but not
     there, and then all judged time counts. Samples from before the iteration seed the window, so
     its first 100 ms are judged like the rest. Without a core map contention cannot be told (the
     session log warns) and only demotions count;
   - **demotion** — the thread's base priority (`pth_priority` from `PROC_PIDTHREADID64INFO`) below
     its normal one: the median of this target's (web, desktop) passing ready checks in
     `machine.json` (`pri`, once it has 5; 31, the default QoS band, before), or the session's
     highest at a passing check if that is higher (`meta.pcore.priFloor`, `normalPri`). It catches
     `taskpolicy -b` (47 → 4), App Nap and a backgrounded or hidden window although performance
     cores are free, and a renderer demoted from the start fails the session at its first gate.

   Efficiency time with performance cores free at normal priority is macOS's own placement: the
   iteration is kept and its efficiency share recorded (below). Counted time may not exceed
   max(`--max-ecore-ms` 15, `--max-ecore-pct` 2 % of its CPU); while streaming the 2 % is taken of
   the rate's expected CPU (the median of this session's kept iterations at the rate, or the CPU so
   far before one), so an early burst is held to what the end of the iteration would allow. A
   breach — or a watcher that dies, noticed at its exit — discards the iteration at once: `H.abort()` ends the in-page phase (the rig's waits, `sleep`,
   `settle`, `waitFor` and `injectCost`, throw at their next step), nothing of the attempt is
   recorded, the aborted work drains (`H.drainAborted`), and the app goes back to where iterations
   start: page.js `reset()`, else `__A.after()` and the scenario's `route`. The runner checks it is
   there (route and Suite ready; the log names the route before and after) and stops the session if
   not, rather than measure an iteration that starts elsewhere. Then the iteration is retried from
   the gate with fresh data (the next `it.n`; scenarios seed `RUN.iterations + RUN.spares + 1`
   targets). Every discard line names its cause — "main thread ran 21.2 ms on efficiency cores
   while demoted (priority 47 → 4) (21.2 ms judged of 946.7 ms CPU)", or "… under contention (0.4 of
   4 performance cores free) …". After `--pcore-retries` (5) retries of one iteration, its 6th
   discard, the session fails: "renderer main thread keeps landing on efficiency cores … — 6 demoted
   (priority 47 → 4): a hidden or occluded window, App Nap or a background policy"; past
   `RUN.spares` (8) discards in one session, as "too many discarded iterations"; both sum up the
   causes (contention with the free capacity meanwhile: other programs' load), and `plan.mjs
   --retries` runs the session again. If the gate itself fails twice mid-session it turns
   off with the reason, and the measured iterations it misses are flagged `gate: 'off'` (aggregate
   counts the session as partly gated).

**macOS's own placement is kept and reported.** Each gated iteration in thread scope records
`rec.pcore` = { `eSharePct`, `eJudgedSharePct` }: the share of the main thread's CPU that ran on
efficiency cores, all of it and judged (process scope, which counts the whole renderer, records
none). Aggregate treats them as metrics (`pcore.eSharePct` in every table, session medians and the
A/B delta per pass × rate), and when the sides' session medians differ by ≥ 5 points with separate
sessions the advice prints a `flag:` line and the report's rig-health section a callout: "B ran
12 % of its main-thread CPU on efficiency cores vs A 2 % (macOS placement with performance cores
free) — part of a 1x time difference can come from that". Read a 1x time difference next to it.
The gate cannot see contention shorter than ~100 ms that does not dominate the iteration, so a
quiet machine still gives the cleanest data.

Why, measured on an M4 (4 performance + 6 efficiency cores, macOS 26), web history-load at 1x:

- **It is macOS's choice, not contention**: next to the efficiency time 3.7–4.0 of 4 performance
  cores were free (E-weighted), with the renderer main thread at its normal priority 47. Side B,
  whose IndexedDB drain is a longer, lighter tail (1.24 s vs 0.35 s), ran 11–22 % of its main-thread
  CPU on efficiency cores, side A 2–5 %; at 4x, where the throttle keeps the thread busy, both ran
  ≤ 0.7 ms there. Desktop account-switch: ≤ 0.9 % at 1x.
- **Headless or headed does not matter**: with the screen locked, headless B 21.3 % / A 4.1 % and
  headed 21.9 % / 4.3 %; unlocked, headed with the window frontmost the whole session B 11.0 % / A
  1.6 %, headed in the background 11.7 % / 3.2 %, headless 15.4 % / 2.2 %. The unlocked runs placed
  less on efficiency cores than the locked ones, at lower P clocks (2.8–3.5 vs 3.4–3.6 GHz).
- **Contention does not move it**: 6–10 spinners at default or user-interactive QoS started
  mid-iteration (4x and 1x) left the renderer, at priority 47, on its performance cores (0–0.4 ms on
  efficiency cores); the contention rule is exercised by the synthetic checks only.
- **Synthetic rule checks**: efficiency time with ≥ 1 core free at normal priority is kept (40 %
  duty with 4 free, 4x throttle spin with 3 free, 1.5 free); with 0.5 free, spinners taking all 4
  cores mid-run, bursts at 0 free for 40 ms of every 100, or demoted 47 → 4 / 47 → 46 with 4 free it
  counts and discards.

The renderer is the `CrRendererMain` thread among run.mjs's descendants (headless Chromium, its
persistent-context variant, or Electron's helpers); with several, the one whose main thread ran a
test spin. `meta.pcore` keeps: `enabled` or the `reason` it is off, `target`, `scope` (thread |
process), `watchdog`, `renderer` { pid, tid, name }, `thresholds`, `gateWaitMs`, `readyAttempts`,
`timeouts` (gates that could not be met), `priFloor`, `normalPri`, `discards` [{ rate, iter, n,
cause (contention | demotion | watcher), eMs (counted), eJudgedMs, eTotalMs, cpuMs, eContentionMs,
contentionFreeP, eDemotionMs, basePri, minPri, freeP, eFreeP, eFreeMinP, watcher, why, retry }] and
`kept` [{ rate, iter, scope, pMs, eMs, eJudgedMs, eCountedMs, eHeadMs (judged E in the first 5 ms of
CPU of its segments), cpuMs, eSharePct and eJudgedSharePct (thread scope only), eContentionMs,
eDemotionMs, basePri, minPri, pGHz, freeP, eFreeP, eFreeMinP, eSamples, waitMs, ready, retries }].
The free performance capacity is in cores, with this renderer thread's own P time counted as free,
from `os.cpus()` stamps on every watcher sample (~10 µs each; 10 ms ticks): `freeP` over the whole
measured part, `eFreeP` E-weighted over the samples with judged efficiency time (the answer to "were
performance cores free while it ran on efficiency cores?"), `eFreeMinP` the lowest 100 ms ending at
such a sample (±0.4 cores; short bursts read diluted), `eSamples` how many. The helper:
`rig/native/pcore.c`, built with `clang -O1` on first use into `$PERF_AB_HOME/bin/pcore-<source
hash>` and cached (`cores`, `spin`, `find --root`, `watch --pid --tid`; find runs at background QoS,
watch at utility through `taskpolicy -c utility` — background QoS starved it to 180 ms sample gaps
on a busy machine — and answers every stdin `r` with its own line; each sample also carries the
thread's base and current priority, `pth_priority` / `pth_curpri` from the public
`PROC_PIDTHREADID64INFO`, −1 if unread). It reads per-thread time and
cycles per core type with a **private** `proc_pidinfo` flavor (`PROC_PIDTHREADCOUNTS` = 34,
`PROC_PIDLISTTHREADIDS` = 28, from XNU's `proc_info_private.h`) that a macOS update could change;
every read checks the layout (return value = 8 + len × 40, len = `hw.nperflevels`), since the kernel
truncates a short buffer silently, and anything else counts as unsupported. **Fallbacks**: not
macOS arm64, no clang, or one perf level → the gate is off with one warning in the session log and
`meta.pcore.reason`; the private flavor refused or unsupported → process scope: the public
`proc_pid_rusage(RUSAGE_INFO_V6)` of the renderer process (`ri_user_ptime + ri_system_ptime`,
`ri_pcycles`; mach ticks on Apple silicon) for the ready check, and **no watchdog** — GC, IO and
compositor threads run on efficiency cores routinely, so a move cannot be detected (the session log
warns, `meta.pcore.watchdog` is false); a core-map check a busy machine spoils → the sysctl perf-level
counts in efficiency-first order (Apple silicon's; on an M4 os.cpus() 6–9 are the performance cores)
with `verified: false`, checked again after 10 minutes (the session log and preflight say so).
`machine.json` (re-checked when the CPU or the OS release changes) holds the perf levels, which
`os.cpus()` indices are performance cores (verified by a default-QoS spin), the ready-check clocks
per rate (`ready`) and the renderer's normal priority per target (`pri`). `--max-load` in
`plan.mjs` is superseded by the gate and stays for machines without it.

```js
{ meta: { run, side, label, rev, sha, buildSha, variant, profile, build, target, device, network, slot, scenario, cfg, k, rates, warmup, idleMs, altInject, host, browser, started, finished, timing: { …, queueMs } },
  complete, env: { coverageFiles, hook, renderers, markers, build, canary, ua, dpr, inner, store, connect, sentry, verify, desktopLaunches, ... },
  seed, post, calib: { <rate>: [ms x5] }, idle: { <rate>: { ms, taskMs, commits, ... } },
  runs: [ { rate, iter, n, inject, load1m, before, phases: { <name>: <phase record> }, after, problem } ],
  end, hits: { served, missing, definitions, telemetry, aborted }, diag: [console errors/warnings] }
```

A phase record merges three sources:

| Source | Fields |
| --- | --- |
| window (`ms` = phase wall time) | `ms` |
| in-page probes, same on both sides | `commits`, `frames`, `frameP50/P95/P99/Max`, `framesOver50/100`, `jankMs`, `lagP95/P99/Max`, `lagOver50` (10 ms timer chain: input-delay proxy), `longTasks`, `longTaskMs`, `longestTaskMs`, `tbtMs`, `loafs`, `loafBlockingMs`, `loafScriptMs`, `forcedLayoutMs`, `interactions`, `inpMs` (trusted input only), `cls`, `heapPeak` |
| CDP, thread ticks | `taskMs`, `scriptMs`, `layoutMs`, `styleMs`, `otherMs` (= task − script − layout − style: GC, IDB, native, parsing), `layouts`, `styleRecalcs`, `heapEndMiB` |
| counting passes only (`cfg.fiberStats`) | `fibers`, `fibersRendered`, `fibersMounted`: fibers walked, rendered and mounted over the window's commits |
| the scenario | whatever the phase returned (`rows`, `pages`, `persistMs`, …; numbers in nested objects as `<field>.<key>`, e.g. `counts.put.txs`), `injectedCalls`/`injectedMs` |

## The scenario

Two files; copy `rig/templates/` and read `examples/history-load/` (a complete, tested one).

`scenario.mjs` (Node, `export default { … }`): `name`, `description`, `page`, `cfg`, `phases` (names, or `{ name, node:
async ctx => record }` for trusted input — `ctx = { page, cdp, context, it, cfg, side, target, ev }`),
`k`, `rates`, `warmup`, `route`, `idleCorrect` (phase names), `headline` (`[{ key, label, unit, dir }]`),
`valid(rec, cfg)` (true or a problem string), `line(rec)`, `check(env)`, `nodeSetup(ctx)`.

`page.js` (in the page, after the core): assigns `window.__A` with `ready`, `seed`, `isReady`,
`postInit`, `before(it)`, `phases: { name(it, cfg) }`, `after(it)`, `reset(it)` (after a discarded
attempt: back to where iterations start, false if it cannot; default `after(it)` and the route),
`verify()`; `it = { i, n, rate }` (`n` counts iterations over the whole session, retries included —
use it to give every iteration fresh data, and seed `RUN.iterations + RUN.spares + 1` targets).

`window.__H` (rig/page/core.js): `CFG`, `RUN`, `buildInfo()` (the running build's release string,
commit and how many loaded modules carry React Compiler output), `store()` (window.store on web with `window.Playwright`,
desktop with `--expose-store`, else the react-redux Provider), `state()`, `dispatch()`, `connect()`
(TrezorConnect as the app calls it; desktop has no `window.TrezorConnect`), `findThunk(typePrefix)`
and `findModules(needle)` (production bundle lookups via `__webpack_require__`; desktop bundles keep
most thunks module-internal), `exportsOf(id)`, `markers(needles)`, `click(testid)`,
`goto(routeName, params)` (`@router/goto` where exported, else a menu click for `suite-index`,
`settings-index`, `wallet-index`), `routeName()`,
`suiteReady()`, `waitFor(fn, { timeout, label })`, `settle(ms)`, `sleep`, `nextFrame`, `spin`,
`busy(n)` (the ready check's fixed spin), `warm()`, `injectCost()`, `probes.start/stop/stats(from,
to)`, `runPhase`, `windowStart/End`, `idleWindow`, `calib`, `env`, and the discard protocol:
`abort(reason)` (ends the running phase; `sleep`, `settle`, `waitFor` and `injectCost` throw at
their next step), `drainAborted(ms)` (waits for the aborted work to finish) and `clearAbort()`.

Rules the contract encodes:

- **Fresh data per iteration** when the app caches results (Suite marks an account
  `areAllTransactionsLoaded`; a second load of it is a different workload). Seed enough targets
  (`H.RUN.iterations + H.RUN.spares + 1`: spares for iterations the performance-core watchdog
  discards and retries with the next `it.n`) and index them by `it.n`.
- **One dispatch, not many**: the store renders synchronously per dispatch.
- **Resolve a phase when the user-visible work is done** (`waitFor` a DOM state, a store state, a
  persisted row), then `settle`. A phase that returns early measures nothing.
- **`after` restores the state** the next iteration expects and verifies the iteration did what it
  claims (rows persisted, nothing resurrected). `valid` turns that into a dropped iteration.
- **`H.injectCost()` once per unit of work** (per page, per row batch) makes the paired control meaningful.
- Counting instrumentation (patched prototypes, fiber walks: `cfg.fiberStats`) belongs in its own
  pass, never in a timing pass.

## plan.mjs

```
node rig/plan.mjs --run=<id> [--plan=<file>] [--only=main,ctl] [--dry] [--retries=1] [--heartbeat=30]
     [--pcore=auto|off] [--pcore-free=2] [--pcore-max-wait-s=900] [--max-ecore-ms=15] [--max-ecore-pct=2] [--pcore-retries=5]
     [--slot=off] [--max-load=6] [--max-wait-s=900]
```

Builds: a complete session made from another commit than its side's current build (`sideCommit`:
`buildSha` or `sha` — the side was re-pinned or rebuilt) is stale and runs again. A deployed-preview
side that serves another commit than its earlier sessions stops the plan (develop redeployed): its
sessions cannot pool. Parallel runs: every session waits for the machine slot, so two plans
interleave their sessions one at a time; the start line says when another run holds the machine.

The `pcore` flags go to every session (run.mjs, "Performance cores" above); a discard prints its
own line with its cause (`main-2-A 4x it 3/8 discarded — main thread ran 21.2 ms on efficiency
cores while demoted (priority 47 → 4) (21.2 ms judged of 946.7 ms CPU) · retry 1/5`), a session's
end line its discards and gate wait, summed over its attempts (also in `plan-status.json`). A pass
that extends another is refused while that pass's sessions are stale (made with other arguments
or spare targets): their numbers would pool. `--max-load` / `--max-wait-s` are
superseded by the gate and stay for machines without it.

Sequential sessions in plan order, each a child `run.mjs` with its log in `out/` and its progress
in `out/progress/`; complete outputs made with the same arguments are skipped (a record from before
`meta.argv` counts when its k, rates, warmup and cfg match), so re-running the same command
resumes. Without `--only` it runs every non-optional pass; optional passes run only when `--only`
names them, and an unknown `--only` name exits 2 with the plan's passes. One plan per run: it
refuses to start while `plan-status.json` names another live plan pid. `--max-load` (superseded)
waits until the 1-minute load average drops below N before each session. Ends with `aggregate.mjs`. Run it with `run_in_background: true` (sandbox off) and wait
for the completion notification; never poll in foreground loops. `--dry` lists the sessions and,
once the run has history, the estimate per pass and in total.

Its output answers which stage, how far, how long:

```
11:46:26 plan plan.json · to run: counts 2, ctl 2 · 4 done (skipped) · est 0:01:25, ≈ 11:47 · optional, not run: more
11:44:26 == [2/4] main · main-1-B (B) · k2 · rates 4,1 · est 0:25 · load 2.04
11:44:39    main-1-B measure 4x it 2/2 before · 0:13/0:26 · plan 1/4 · ETA 0:01:03 ≈ 11:45
11:44:53    main-1-B exit 0 in 0:28 · 4 iterations · plan 2/4 · ETA 0:00:53 ≈ 11:45
```

A heartbeat line (stage, rate, iteration i/k, phase, session elapsed/estimate, plan done/total,
ETA) comes on every stage or rate change and every `--heartbeat` seconds; `--max-load` waits and
retries print their own lines. **ETA model** (lib.mjs `etaModel`): a session takes overhead
(fixed + per rate; with sessions of one rate count only, all of it per rate) + per rate k × the
wall time of one iteration at that rate (the warm-up iterations are part of k), learned from the
finished sessions' `meta.timing` in pools: the same pass, then the same role and cfg, then any
timing or trial pass, then counts and controls. An estimate from the last two pools is rough and
printed `~0:31`. A rate a pool has not run scales one it has by their ratio in sessions that ran
both, else by 1 (wall time per iteration barely follows the throttle: 3.0–4.0 s at 1x, 3.7–4.1 s
at 4x in the smoke runs). The running session uses its own iteration times. With no finished
session it says "ETA after the first session" instead of guessing.

`out/plan-status.json` (atomic, every second while a session runs): `run, plan, pid, state
(running | finished | failed | interrupted — SIGINT/SIGTERM too), startedAt, updatedAt,
elapsedMs, totals { toRun, done, failed, skipped }, current` (the running session merged with its
live progress, or `{ waiting: 'load' }`), `sessions [{ id, pass, side, state, startedAt,
durationMs, exit, endedAt, iterations }], etaMs, etaAt, etaRough`, plus the earlier fields
(`started, total, done, skipped, failed[], etaS, durationsS, finished`).

## status.mjs

```
node rig/status.mjs --run=<id> [--json] [--watch[=<s>]]
```

Reads run.json, `out/plan-status.json`, the running session's progress file and
`build-status.json`, prints at most 8 lines and exits:

```
plan progress-smoke · running · pid 15237 · plan.json · started 11:44
now  main · main-2-A (A) · measure 1x it 2/2 load · 0:21 of est 0:26
sessions 3 done, 0 failed, 1 to go (of 4; 0 complete before)
time 0:01:41 elapsed · ETA 0:00:05 · finish ≈ 11:45
last main-2-B exit 0 in 0:26 · 4 iterations · 11:45
```

The `now` line also says how long the current stage has run (a session waiting for the machine reads
`queued for the machine · <holder> · <wait>`), and a `machine` line names who holds the machine slot
and who waits when another run is involved. It flags (`! …`) a plan or session
whose pid is gone while its state says running (crashed or killed: run the plan again to resume),
and a session snapshot older than 2 min (stuck: a live session writes one at least every 30 s; the
line names the stage and the session log). With no plan running it shows the last plan's final
state, the last session, and whether `summary.json` is newer than the last session; sessions run
without a plan show their records and the newest progress file. A `plan-status.json` from before
pids were recorded reads as finished or unknown, and a build counts as running only while its pid
lives (`build.mjs` marks SIGINT/SIGTERM as interrupted). `--json` prints the snapshot; `--watch`
re-prints every N s (default 5) until the plan and build end — for the user's own terminal, never
as an agent's wait.

## aggregate.mjs

```
node rig/aggregate.mjs --run=<id> [--passes=main,ctl] [--print=main] [--warmup=<n>] [--all] [--allow-mixed-builds]
```

Builds first: the commit every session ran (`env.build.commit`, else `meta.buildSha`/`meta.sha`). A
side whose sessions ran more than one commit is refused — exit 2, no summary — unless
`--allow-mixed-builds` (then a warning in the summary and the report). A side whose sessions all ran
another commit than `run.json` now pins gets a warning (plan.mjs reruns them). `summary.run` carries
`profile`, `base` (the revision check) and per side `commit`, `commits` (sessions per commit),
`profile`, `fingerprint` (of the run's target) and `guide`; the console ends with one `build` line
per side (commit, profile, release, React Compiler coverage).

Per pass × rate × side: kept iterations (after warm-up, no problem, inject = 0), every metric as
`<phase>.<field>`, `total.<field>` (additive fields summed over phases), `after.<field>`,
`<phase>.taskCorrMs` (idle-corrected for `idleCorrect` phases: task − idle CPU per second × phase
ms). For each metric: pooled `{ n, p50, p75, p90, min, max, mean }`, one median per session, and the
B-vs-A delta `{ p75Pct, medPct, separated, p }` — `separated` is `B lower|B higher|overlap` (needs ≥2
sessions a side), `p` a permutation p-value over session medians. Control passes report, per
session, how much of the injected cost landed in each `*.taskMs`. Console: headline metrics, then
any other metric with p ≤ 0.1 and |Δ| ≥ 5%; a counting pass (name with `count`) prints its
deterministic counts instead (commits, fibers, layouts, the scenario's), never its timing.

Then the **advice** (`summary.advice`, also in the report's rig-health section; `summary.passes.<pass>.role`
records each role): could more sessions change a verdict? Only timing passes with 2+ sessions a
side are judged — trial, counting and control passes never are. Every timing headline metric
(without a headline every phase's `ms`/`taskMs`/`inpMs` and the totals; counts and zero-variance
metrics left out) is **called** (sessions separate, p ≤ `CALL_P` 0.1 — lib.mjs, shared with the
report), **underpowered** (these session counts cannot reach 0.1 at all, separated or not),
**borderline** (not called, p ≤ 0.25 — overlapping sessions with p ≤ 0.1 too) or **settled**. The
paired control (lib.mjs `controlVerdict`, the same words in the report) is **landed**,
**inconclusive** (the sessions straddle 70–110 % or their median is outside: one session swings
±30 points), **underpowered** (fewer than 3 inject / no-inject pairs a session: raise ctl k) or
**failed** (every session missed the band the same way). `next:` lines, open metrics sorted by
|Δ| (four shown, then `+N more`):

```
next: 5 underpowered at 4x (open.inpMs +11.3% p 0.333, back.taskMs +10% p 0.333, open.ms +9.1% p 0.333, back.ms +8.5% p 0.333, +1 more · 2 v 2 sessions cannot reach p ≤ 0.1) — one more ABBA block of dsmoke (4 sessions) could call them: add { "name": "more", "extends": "dsmoke", … } to plan.json, then plan.mjs --run=<id> --only=more
next: the draft is stable — more sessions would not change any verdict
next: fix the rig before adding sessions — the paired control ctl @ 4x did not land (sessions 41–58 %, median 50 %; want 70–110 %)
next: run the timing passes (plan.mjs --run=<id>)
```

The block command is `plan.mjs --run=<id> --only=<pass>` while an optional pass that extends the
judged one still has sessions to run, else the pass to add. A failed control comes first and never
appears next to "stable"; with only counts or trial passes done, the line says to run the timing
passes.

## report.mjs

```
node rig/report.mjs --run=<id> [--narrative=<file>] [--out=<file>] [--main=<pass>]
```

Self-contained HTML (inline CSS/SVG, Google Fonts), light and dark, no horizontal scroll at phone
width. The side cards carry the build proof (the commit every session ran, ✓ against the pinned one,
the release string, the profile) and the React Compiler coverage; a callout when the sides differ in
it; caveats on how the revisions were pinned and on the profile. Verdict cards (from `narrative.json`, or generated from the first four headline metrics
of the main pass — the first timing pass, or `--main`; never a counting, trial or control pass,
and "no timing pass yet" without one; a direction is only called when sessions separate with
p ≤ 0.1), findings and custom
sections, one table per pass × rate with per-session dot strips, controls, dropped iterations,
build provenance and rig health per side (markers, coverage, renderers, calibration ratio, idle
CPU, debugger canary), caveats, method. Load the `artifact-design` skill, then publish with the
Artifact tool.

## Other scripts

- `revs.mjs --run=<id> (--pr=<n|url> | --branch=<name|sha> [--base=develop]) [--accept-behind=merge-base|merge-ref] [--no-fetch] [--json]` — pins A (the target branch's tip) and B (the head) after the up-to-date check; exit 3 when the branch is behind (nothing pinned), 2 on an error. `references/builds.md`.
- `fingerprint.mjs --run=<id> [--sides=A,B] [--target] [--json]` or `fingerprint.mjs <build dir> [--expect=<sha>]` — the commit, release string, coverage and React Compiler coverage of a build, from its files. Exit 1 on a commit mismatch, coverage or mixed commits.
- `build.mjs --run=<id> [--targets=web,desktop] [--sides=A,B] [--profile=release|preview] [--rebuild] [--network-install] [--node=<binary>] [--slot=off]` — see SKILL.md step 3 and `references/builds.md`. Prints the steps and an estimate up front, numbers them per side (`[A 3/4] web build … (last 0:52)` … `[A 3/4] web build done in 0:53`, a heartbeat every 30 s in between; step output goes to `<clone>/.perf-ab-logs/`, never stdout), keeps the last 5 durations per step in `$PERF_AB_HOME/timings.json`, and writes `build-status.json` (side, step i/n, start, estimate, ETA, state; `interrupted` on SIGINT/SIGTERM) for `status.mjs`. Each side's state is read again when its turn comes, so an A/A run on one clone builds once.
- `open.mjs --run=<id> --side=B [--target] [--port=9222|auto] [--headed] [--no-seed] [--minutes=90]` — references/mcp.md. Without `--port` it takes the first free port from 9222.
- `tenv.mjs up|status|prepare|yes|screen|down` — references/emulator.md. While it waits for the Docker engine, the controller or a port it prints `waiting for … · 0:20 of 2:00` every 10 s.
- `attr.mjs <x.cpuprofile> --run=<id> --side=A [--top=25] [--json=<f>]` — source-mapped self/inclusive time per file and function.
- `cleanup.mjs [--clones --older-than=3 | --clone=<name> | --apps | --refs]` — list (clones, runs, lock queues) or free disk; never removes a clone in use by a live session, exploration or build. `--refs` drops the `refs/perf-ab/*` refs revs.mjs fetched.
- `rig/locks.mjs` — the lock queues (`machine`, `clone-<name>`, `emulator`) and the clone-users registry; `PERF_AB_SLOT=off` or `--slot=off` skips the machine slot.
- `scripts/analyze-trace.mjs <trace.json[.gz]>` — category breakdown of a DevTools trace (MCP traces too).
