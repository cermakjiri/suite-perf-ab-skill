# Measurement failure modes

Every entry here was hit for real or verified by direct measurement in Chrome. Most fail *quietly*
— they produce plausible numbers rather than an error — which is why they are worth knowing before
you trust a result.

## The builds and the rig

These fail before a single metric is collected, and everything downstream still looks normal.

### The branch preview is coverage-instrumented; develop's usually is not

Both previews are production builds from the same webpack config on the same host, which is exactly
why this is easy to miss. They are not built by the same workflow:

| Writes to | Workflow | Trigger | `INSTRUMENT_CODE` | Istanbul |
| --- | --- | --- | --- | --- |
| `suite-web/<branch>/web` | `test-suite-web-desktop-e2e-pr.yml` → `build-suite-web-e2e.yml` | every PR | `"false"` | **on** |
| `suite-web/develop/web` | `build-suite-web.yml` | push to develop | unset | off |
| `suite-web/develop/web` | `test-suite-web-desktop-e2e-nightly.yml` | cron Mon–Fri 00:00 | `"true"` | **on** |
| `suite-web/develop/web` | `test-suite-web-desktop-e2e-canary.yml` | cron Sun 01:00 | `"false"` | **on** |

The first row is not a typo. `packages/suite/webpack/createBaseConfig.ts` (formerly `packages/suite-build/configs/base.webpack.config.ts`) gates the plugin
on `process.env.INSTRUMENT_CODE ? [...] : []`, and the string `"false"` is truthy in Node — so the
input whose name and default say "off" turns instrumentation **on**. Every PR preview is
instrumented. Only the workflow that sets no env var at all produces a clean build, and that
workflow only ever builds `develop`.

The develop preview is whatever the **last** of its three writers left behind, so its state changes
through the week: instrumented after a weekday nightly, clean again after the next push to develop.
Which means the asymmetry is real but not constant — it has to be measured per run, not assumed.

Measured 2026-09-14, scanning every deployed chunk for `__coverage__` / `cov_<hash>`:

| Preview | Chunks | Instrumented |
| --- | --- | --- |
| `fix/low-fee-warning` (PR) | 227 | **35** (3,700 markers) |
| `develop` | 219 | 0 |

Istanbul's `include` is `packages/*/src/**` and `suite-common/*/src/**` — application code only.
So the counters land on exactly the code a PR changes, the tax is asymmetric in the branch's
disfavour, and the run manufactures a regression that does not exist in the source. Sampling the
biggest chunks does **not** find it: the three largest on both sides are vendor and near-identical
in size (615,473 vs 615,925 bytes).

Check at runtime, per build, once the app has booted:

```js
Object.keys(globalThis.__coverage__ ?? {}).length   // 0 = clean, anything else = instrumented
```

Instrumented modules create and populate that global as they initialise, so a booted app shows it
immediately. Offline equivalent — note it must walk every chunk, not a sample:

```bash
B=https://dev.suite.sldev.cz/suite-web/<branch>/web
M=$(curl -sL "$B/" | grep -oE 'js/main\.[a-f0-9]+\.js' | head -1)
curl -s "$B/$M" | grep -oE '[0-9]+:"[a-f0-9]{8}"' | tr -d '"' |
  while IFS=: read id h; do
    curl -s "$B/js/$id.$h.js" | grep -q '__coverage__' && { echo "INSTRUMENTED (chunk $id)"; break; }
  done
```

If the two sides disagree, the deployed pair is not comparable and no number of extra iterations
fixes it. Two honest ways out:

1. Report only what does not depend on the timings — the diff reading, the suspect list, the
   coverage gaps — and say plainly why the numbers are missing.
2. Build both revisions locally with the same command and `INSTRUMENT_CODE` unset, and compare that
   pair. Symmetric-but-local beats asymmetric-but-deployed. Never mix one deployed side with one
   local side.

Do not try to subtract the instrumentation out. Its cost is per executed statement in changed code,
which is the very thing being measured.

### The develop baseline moves, and merging the PR erases the comparison

`develop` redeploys on every push, and the upload is `aws s3 sync --delete` — the build you
baselined against is not retained anywhere once it is replaced. Two consequences:

- A run spanning a develop push compares against two different bases without saying so.
- If the PR **merges** mid-session, the develop preview rebuilds with the PR's own code in it. Every
  delta collapses toward zero and the report reads "no regression" — the exact failure this skill
  exists to prevent, arriving through the back door.

The rig fingerprints every session instead of trusting a URL: **every bundle inlines the commit it
was built from**, PR previews included — `process.env.COMMITHASH` and the release string
`process.env.SENTRY_RELEASE` = `<version>.web[.codesign].<40-hex sha>` are DefinePlugin values
(`packages/suite/webpack/createBaseConfig.ts`), so they need no Sentry token. Each session reads the
commit from the modules it loaded (`env.build.commit`); `plan.mjs` stops when a preview side serves
another commit than its earlier sessions, and `aggregate.mjs` refuses to pool a side whose sessions
ran two commits (`--allow-mixed-builds` overrides, with a warning). What exists **only on the develop
preview** is `window.SENTRY_RELEASE` — the Sentry webpack plugin's global, gated on `!isDev &&
sentryAuthToken`, which only `build-suite-web.yml` has: on 2026-09-14 it read `26.10.0.web.d0d87f04…`,
exactly `origin/develop` at that moment. By hand, the release string is in one of the app's chunks
(not `main.<hash>.js` any more): grep every chunk for `[0-9.]+\.web(\.codesign)?\.[0-9a-f]{40}`.

The same gate produces a third asymmetry worth knowing: the Sentry plugin uploads source maps and
deletes them, so `*.js.map` is **404 on develop and 200 on every PR preview** (verified on both).
Nothing about runtime performance changes, but symbolication works on one side of the pair and not
the other.

Keep the numbers already taken, label every table with the base SHA it was measured against, and
never merge pre- and post-merge base numbers into one row. Re-baselining means getting a preview
built from the pre-merge SHA — which, coming from a branch build, would be coverage-instrumented
while the develop build it replaces was not, so it is not a drop-in substitute for the base you lost.

### CPU throttling that silently did not apply

`emulate_cpu` returning success says the call was accepted, not that the renderer slowed down. The
rate is set per target, so a new page or target quietly runs at 1x, and a "4x pass" that is really a
second 1x pass yields a tidy, plausible, meaningless table — usually one showing less difference
than the 1x pass, which is the direction that gets believed.

Measure the ratio rather than trusting the call:

```js
(() => { let x = 0; const t0 = performance.now();
  for (let i = 0; i < 5e7; i++) x += i % 7;
  return { ms: performance.now() - t0, x };
})()
```

Return `x` so the loop is not optimised away, and size the count so the 1x reading is 50–200ms — too
short and the ratio is noise. Expect ≈4x under 4x throttling (3.5–4.5 in practice); near 1.0 means
it never applied. Re-verify after switching branches, for the same reason the viewport does.

### A metric that cannot move looks exactly like a metric that did not move

Most of this file is ways a number comes back absent, floored, excluded or flat — INP from synthetic
input, standard CLS during interactions, sub-50ms work under either long-task observer, rAF deltas
below the frame budget, `performance.memory` under ~30MB. Every one of them reports "no change", and
so does a PR that is genuinely safe. Nothing in the output distinguishes the two.

So before an A/B is worth reporting, show the metric responds to the thing you would attribute to
the PR. The two data sizes the protocol already requires are the free version: if p75 at 200
accounts does not sit clearly above p75 at 60, that metric is not sensing that scenario, and a null
result from it is not evidence of no regression. For a scenario that is not size-sensitive, inject a
known cost — a 20ms busy block inside `act` — confirm it lands, then remove it.

Run the control on both builds. A probe that works on one and not the other — the React hook failing
to install, an observer never firing — is itself the finding, and it invalidates the comparison
rather than merely weakening it.

## Metrics that can be silently empty

### Interaction latency from synthetic input is not slow or noisy — it is absent

Event Timing records only **trusted** events. A native-value-setter plus
`dispatchEvent(new Event('input'))` produces **zero** entries at any `durationThreshold`, and
`performance.interactionCount` stays 0. The same handlers hit by real CDP input produced 11 entries.

So any INP figure taken from the harness's own `setInputValue` driving is an absence, not a speed.
The harness reports `interactionsValid: false` and `inpMs: null` precisely so an invalid run cannot
be read as a fast one — check that flag before quoting a latency.

To measure interaction cost for real, drive with the MCP's own `click`, `type_text` and `press_key`
tools, which go through CDP and produce trusted entries. `fill` and `fill_form` were **not**
verified; if they set `.value` directly they will silently produce nothing, so test before relying
on them. Keep `setInputValue` for state setup you are not timing.

Two more traps once you do have trusted input:

- `interactionId` is 0 on `input`/`beforeinput` and on the compat mouse events. Only
  `pointerdown`/`pointerup`/`click` and `keydown`/`keypress`/`keyup` carry one. Filtering to
  `input` events — the instinct for a text-entry harness — finds nothing.
- Every entry in an interaction group carries the same `duration`, so "max duration" ties. Break
  ties on processing time, or you select `pointerdown` and get `processingMs: 0` with a
  meaningless breakdown.

The attribution arithmetic sums exactly to `duration`:
`inputDelay = processingStart - startTime`, `processing = processingEnd - processingStart`,
`presentationDelay = (startTime + duration) - processingEnd`.

### Standard CLS reads 0.00000 in every interaction run

`hadRecentInput` is true for any shift within 500ms of a trusted discrete input, and standard CLS
excludes those. Since measuring interactions *requires* trusted input, every shift your interaction
causes is excluded. A run showing CLS improving from 0 to 0 measured nothing.

Report `clsIncludingRecentInput` for interaction work. Programmatic `scrollTo` does not arm
`hadRecentInput`, so scroll-driven shifts do land in standard CLS.

Virtualized lists usually produce no shifts at all — rows are transform-positioned and transforms
do not shift layout. A non-zero value there is a real bug signal, not noise.

### Both long-task observers are blind below 50ms

`longtask` and `long-animation-frame` share a hard 50ms floor that cannot be lowered;
`durationThreshold: 5` on LoAF still returns nothing under 50. `longtask` attribution is useless in
practice (`name: 'self'`, `containerType: 'window'`). LoAF is strictly better: it sees ≥50ms frames
including style/layout/paint, aggregates many sub-50ms tasks sharing one frame, and its `scripts[]`
carry `invoker`, `invokerType`, `sourceURL`, `sourceFunctionName` and
`forcedStyleAndLayoutDuration` — the last being the best passive forced-reflow detector available.

`blockingDuration` is **not** `duration - 50`. An observed frame with `duration: 99.6` had
`blockingDuration: 45.5`, because it derives from the longest constituent task. Never reconstruct
it arithmetically.

### rAF deltas are a threshold detector, not a measure

Measured on a 120Hz display: idle p50 8.3ms; with **4ms of work per frame the deltas were
unchanged** (p50 8.3, max 9.1); at 10ms/frame p90 jumped to 16.6. So frame intervals prove "the
budget was blown N times" and prove nothing about magnitude below it.

They are also not portable. The budget is 8.33ms at 120Hz and 16.7ms at 60Hz, so identical code
drops frames on one machine and not another. Never compare dropped-frame counts across machines,
displays or CI runners, and pin both branches to one display.

A continuous rAF loop is itself not passive — it forces a frame every interval and prevents idle.
It belongs in a dedicated run, which is why the scroll primitive is separate from the others. The
scroll driver also *sets* `scrollTop` every frame, which `skills/performance-dom` correctly lists as
forcing layout; the cost is real, identical on both branches, and part of the driver rather than the
code under test — worth stating in the report rather than discovering later.

### Forced layout is about *when*, not *whether*

`skills/performance-dom` lists the properties that force synchronous layout, `scrollTop` among them.
That is the right coding rule and it is binding. It does not mean every such read costs a reflow:
these force layout **only when layout is currently invalidated**. Nothing dirties layout during a
plain scroll, so a `scrollTop` read in a scroll handler hits clean cached geometry — measured at
`forcedStyleAndLayoutDuration: 0.0ms` across a whole gesture. The expensive shape is the one the
rule's own example shows, a read *interleaved with writes*.

So a zero here is a real measurement, and it is not evidence that the rule is unnecessary. Report
both: the cost did not materialise at this call site, and the rule still applies because that is a
property of today's code, not a guarantee.

## Memory

### `performance.memory` has real precision and fake meaning

Available on a plain https page, no flag needed, and byte-granular (no bucketing observed in
Chrome 152). But it tracks allocation and GC history, not live data:

- 20 × 50KB `Float64Array` allocations moved it by **exactly 0 bytes** — typed-array backing stores
  are external memory, not JS heap.
- 12 × ~500KB of plain objects moved it by 0, then it jumped +19.4MB in one step, because new-space
  allocation is invisible until a scavenge promotes a batch.
- 235MB allocated then fully dereferenced, idle 3s: the value never fell. It rose ~500B per sample.
- **3600 detached DOM nodes cost only ~0.85MB** — DOM lives in Blink, not the V8 heap, so a
  detached-DOM leak is nearly invisible to this counter.

A single delta is worthless below ~30MB. What is trustworthy is the **minimum over a window of
samples after a provoked GC**: on a genuinely clean cycle, block minima were 1.90 / 1.91 / 1.77 /
1.92 MiB — flat to ~150KiB across 20 cycles. Call a leak only on a sustained slope of ≥64KB/cycle
with ≥8MB total drift, and treat those constants as machine-specific until `mem.calibrate()` says
otherwise on yours.

### `measureUserAgentSpecificMemory()` is not available and cannot be made available cheaply

`typeof performance.measureUserAgentSpecificMemory === 'function'` is **false** without cross-origin
isolation — the member is gated off entirely, so you cannot feature-detect and catch. It needs
`COOP: same-origin` + `COEP: require-corp`, and retrofitting COEP onto Suite would require every
cross-origin subresource (coin icons, the connect iframe) to send CORP headers. That changes the app
under test, which breaks the comparison unless both branches are served that way.

### How to actually provoke a GC

- **`take_heapsnapshot` forces a full GC.** Verified: a heap sitting at 99.4MB of dropped garbage
  dropped to 839KB after one call, and pending `FinalizationRegistry` callbacks all fired. This is
  the MCP's GC primitive. It costs 1–3s and perturbs the process, so never mid-timing-run.
- **Allocation pressure works** — a few rounds of large short-lived arrays finalized 200/200 dead
  canaries within 54ms. The price is that its own garbage is still uncollected at sample time,
  which is exactly why you sample a minimum over a window rather than one reading.
- **Idling is only partial**: 10s of idle finalized 177/200 canaries and then plateaued. Idle GC
  does the young generation and will not reliably finish an old-generation cycle.
- **Folklore, does nothing**: nulling references and awaiting a microtask, rAF or `setTimeout(0)`;
  `window.gc()` without the flag (undefined); "allocate something huge to hit the limit".
- **The real fix if you control the browser launch**: `--js-flags=--expose-gc`.
  chrome-devtools-mcp accepts `chromeArgs`. This is worth more than every heuristic above combined,
  and the harness auto-detects `globalThis.gc` and uses it when present.

### Naive listener counting reports leaks on clean code

Counting net `addEventListener` minus `removeEventListener` over-reports: listeners bound to
throwaway elements are legitimately never removed, because the node dies and takes them along. A
clean control scenario scored +1 listener/cycle and produced a false "suspected".

Only growth on **persistent targets** — window, document, documentElement, body, visualViewport,
non-Node EventTargets — is a leak signal. Net observer count is clean either way: the leaky control
scored exactly +1 MutationObserver/cycle, the clean one 0. For styled-components, growth in
`document.styleSheets[*].cssRules.length` per cycle catches runaway class injection.

This patching is legitimate *because it is a counting run, not a timing run*. Never leave it on
while timing.

## React

### `bundleType: 0` does not mean "production"

The profiling build emits `bundleType: 0` too, with a byte-identical internals object. The only
reliable discriminator is a fiber field test: `typeof root.current.actualDuration === 'number'`.
Production has no timing fields at all (`actualDuration`, `selfBaseDuration`, `treeBaseDuration`,
`actualStartTime` — zero occurrences), so **all timing must come from your own `performance.now()`
and PerformanceObservers**. The React 19 timeline-profiler hook path does not exist in 19.2.3.

### The commit hook runs inside the commit task, before paint

`flushMutationEffects` → `flushLayoutEffects` → `flushSpawnedWork` are three consecutive
synchronous calls, and `onCommitFiberRoot` fires from the last. Every microsecond spent in the hook
extends the very task being measured, lands in long-task totals and counts toward INP.

So `mode: 'stats'` — which walks the fiber tree — is a diagnostic, never a timing-run tool. Even
`mode: 'count'` is not literally free, and it is *asymmetric* when one branch commits 40 times and
the other 180. For absolute purity, run the timing pass with `mode: 'off'` and take counts in a
second identical pass.

Installing the hook at all perturbs both branches equally (React calls four functions per commit it
would otherwise skip), so it does not bias the comparison — but probe-on numbers are not comparable
to probe-off numbers.

### What the fiber walk does and does not prove

`alternate !== null && alternate.child === child` is React's own bailout predicate, lifted from
`bubbleProperties`. It means the entire subtree below was untouched this render, which is what makes
the walk cheap and what makes `fibersRendered` meaningful.

It tells you a fiber *was worked on*, not that the work was wasted. Detecting a re-render that
produced an identical result is not possible in a production build — component names do not survive
minification either, so per-component attribution is out. `fibersRendered` versus `fibersCommitted`
is the honest proxy: it says how much of the tree each commit touched.

## Tracing

### Tracing distorts what it measures, unevenly

A DevTools trace of a Suite interaction writes roughly **200MB in 1.2 seconds**, almost all of it
invalidation records, and that cost lands on the thread being measured. Observed: one scroll
iteration took 660ms untraced and 2,240ms traced, with CPU utilisation inside the window at 100%.

The overhead scales with **React commit count**, not DOM size — so it penalises whichever branch
commits more, and that is not the same branch in every scenario. A comparison built on traced totals
can invert the true result. Take headline numbers from the passive in-page instrumentation; use
traces only for the scripting / style / paint split, labelled with their real n.

### The trace buffer truncates, silently

Only the first ~1.2s of a heavy workload survives. Ask for 12 iterations inside one trace and you
get 2, with no warning. Symptom: `iter-report.mjs` prints `no S*-* measures found`, or reports fewer
iterations than you ran. Shrink the traced scenario, and if a full iteration will not fit, say so
and rely on the untraced metrics.

### Trace window alignment reads as zeros

`analyze-trace.mjs` takes `--from`/`--to` relative to its own origin: `navigationStart` when present,
otherwise the earliest event with `ts > 0`, **skipping metadata (`ph: 'M'`) events**. Compute the
origin differently and every window lands in empty space.

Symptom: every metric is `0.0` but `windowDurationMs` is correct — the window is the right length in
the wrong place. That combination is never a real "no work happened". Traces recorded mid-session
have no `navigationStart`, so the fallback path is the normal one; `iter-report.mjs` already
implements the matching rule.

## Scenario construction

### Multiple dispatches do not batch

Suite reads the store through `useSyncExternalStore`, so a store change from outside React renders
synchronously to avoid tearing — React's automatic batching does not apply. Sixty `createAccount`
dispatches produced ~39 commits and measured a list being built incrementally, not a mount. Use one
bulk action per measured step.

### Thunks dispatched as plain actions silently do nothing

`@router/goto` is a thunk; dispatching `{type: '@router/goto', payload}` no-ops and the scenario
measures nothing while looking healthy. The plain slice action is
`router/routerLocationChange`. Whenever a scenario drives the app through an action, assert the
state actually moved before measuring — the `navigate` scenario checks that row counts change and
returns an error if they do not.

### Iteration 0 is cold

The first iteration after a page load runs 20–30% slower — JIT, styled-components inserting rules,
first layout of new markup. Observed 160ms against a 131ms steady-state p75. Discard the first
three; report iteration 0 separately if the cold case matters.

### Verify a surprise before reporting it

A regression or win found with one gesture shape is a hypothesis. Reproduce it with a second shape —
a slow drag as well as a fast flick, a second data size — before it goes in the report. One extra
run is cheap; a retracted finding is not.

## Small things that waste a run

- **Viewport drift.** `resize_page` applies to the current page; after navigating to the other
  branch, set it again and verify `innerWidth`/`innerHeight` *and* the scroll container's
  `clientHeight` match. One pixel changes how many rows render.
- **Route redirects.** Suite's static export needs the trailing slash: `/accounts/` is 200,
  `/accounts` is a 302.
- **Disk.** Traces are ~200MB each and a full run makes six. Delete each one as soon as its summary
  is saved, and check free space before starting.
- **Inline output.** Per-iteration records are long. Pass `filePath` to `evaluate_script`.
- **Stale summaries.** If you fix a bug in an analysis script, re-derive every summary it produced —
  a summary written before the fix will sit there full of zeros.

## Found with the Playwright rig (2026-09 → 2026-10)

Each of these produced a clean-looking wrong answer at least once. The rig guards the ones it can;
the rest are for reading results.

### Measurement

- **The DevTools MCP taxes array spreads ~25x.** Pages it attaches to run with the V8 Debugger
  domain on: 10k `a = [...a, i]` takes ~650 ms instead of ~26 ms; `slice()+push` is untouched. A
  PR that removes spreads looked 11x better through the MCP than in a debugger-free Chromium. The
  runner's env canary (`spread`/`slice` ≈ 1) proves a session was debugger-free.
- **Idle core ramp.** After ~300 ms of idle, the first ~30 ms of renderer work runs 2.5-3x slower
  on Apple silicon. A 20 ms injected block moved a metric by 1.4 ms until the warm-up (two spins,
  each its own task followed by a frame) went in front of every iteration. Prefer 4x for CPU
  totals; at 1x a light build's savings read compressed.
- **The session is the unit.** Same-build sessions differed 222 vs 157 ms p50 at 4x; a consistent
  +10 ms per keystroke in 2 v 2 sessions was pure noise (profiles showed equal script time, and the
  sign flipped at 4x). Pooled iteration statistics across builds are meaningless with 2 sessions.
- **Controls must be paired inside a session.** Across processes, a +200 ms injection drowned in
  ±300 ms of session spread at 4x. Alternating 0 / X ms inside one session (`--alt-inject`) landed
  85-112% at 4x on both builds.
- **Window-length confound.** When one side's window is minutes longer (an IndexedDB drain),
  percentiles over the whole window flatter it (idle frames) and CPU totals overcharge it (probe
  and background cost × time). Split the phases at the user-visible boundary and idle-correct the
  long one (`idleCorrect`, `taskCorrMs`).
- **CDP thread time and the V8 profile can disagree** on promise-heavy code: CDP filed a PR's
  IndexedDB win under "other" (non-script) time and read +20% script; the source-mapped profile
  showed the idb wrapper 220 → 35 ms. Totals from CDP, attribution from `attr.mjs`.
- **Non-codesign builds run redux-logger** (`!isCodesignBuild()` in
  `packages/suite/src/reducers/store.ts`): every dispatch is logged, and with CDP's Runtime domain on
  (Playwright's) serialized into the console and kept reachable: 200 no-op dispatches took 224 ms of
  main-thread CPU at 4x in a preview build and 24.8 ms in a release build of the same commit (~1 ms
  per dispatch). Its cost follows the number of dispatches — what perf PRs change. The rig builds the `release`
  profile (`IS_CODESIGN_BUILD=true`) by default for that reason; CI previews and `--profile=preview`
  builds have it (`references/builds.md`). The dashboard's recharts re-renders on every store change
  either way: say so when quoting absolute values.
- **Motion baseline.** A frame's rAF timestamp can precede the input's `event.timeStamp` while
  that frame already sees the post-input layout. Take a synchronous `getBoundingClientRect`
  baseline when arming and compare `performance.now()` in callbacks, not `ts`.
- **Infinite animations** (a spinner while fees never load offline) force style + layout every
  frame on both sides; pause `document.getAnimations()` with `iterations === Infinity` before a window.

### Seeding and the app

- **The `@storage/load` payload must carry every slice the revision expects** (`supportedNetworks`,
  `earnOnboarding`, `stellarContractTokens`, `language: 'en-US'` …). A missing key makes one
  reducer throw inside a try/catch and the whole seed silently no-ops — Suite then never finishes
  loading on either build. Re-check the payload keys against the revisions under test.
- **Fresh data per iteration**: after a completed `fetchAllTransactionsForAccount`, the account
  keeps `areAllTransactionsLoaded` (only `removeAccount` clears it); reloading it pages by 5 — a
  different workload. Seed one target per iteration.
- **Suite's browser detection rejects the `HeadlessChrome` UA** and **token definitions are a
  plain fetch that hangs init** when stalled: the rig sets a normal UA and answers definitions.
- Same transaction timestamps for every seeded account mean anything keyed by tx time sees a
  constant-size map, not a growing one.

### Builds and the environment

- **zsh `time` + an env prefix silently builds a dev bundle** (the script's `NODE_ENV` is lost):
  73 MB of JS instead of 21. `build.mjs` checks for a hashed `main.<hash>.js`.
- **The desktop build never cleans its output**: stale chunks with other hashes mix two builds.
  `build.mjs` runs `clean` first.
- **Clones**: `clonefile` follows symlinks (CLAUDE.md arrives as a file; the forced checkout fixes
  it); `git status` in a clone talks to the original's fsmonitor daemon until `core.fsmonitor` is
  off; peers switch the main checkout's branch mid-run — never build in the shared tree. A built
  clone holds ~1-2 GiB of real blocks: check disk (`preflight.mjs`).
- **A clone inherits the checkout's untracked files.** `.env.local` (loaded by the webpack config
  through dotenv) carried a developer's build knobs into every build; generated, git-ignored files
  (the message-system config, browser-detection, favicon, the transport-bridge UI) were bundled as
  the checkout last generated them — on 2026-10-13 the checkout's message-system config was eight
  days old, and two clones made on different days bundle different content. `build.mjs` sets
  `.env.local` aside and regenerates what CI regenerates; the guide content (network) is compared
  by hash in preflight.
- **The checkout's yarn cache lags the target branch.** A develop tip newer than the checkout's last
  install locks packages its offline cache never saw (`YN0080 … blocked`). `build.mjs` installs
  again with the network and keeps the fetched packages for later clones. In an agent sandbox yarn
  berry ignores `HTTPS_PROXY` (handed over as `YARN_HTTPS_PROXY`), a burst of 50 downloads gets
  "The server aborted pending request" from the proxy (8 at a time), and the global mirror under
  `~/.yarn` is not writable (mirror off).
- **The feature branch behind its target.** PR #32496 was 123 commits behind develop, 20 files
  changed on both sides, `yarn.lock` moved: measured against today's develop it would be charged with
  all of that, measured on its fork point it runs on a base that no longer exists. `revs.mjs` stops
  and advises a rebase (`references/builds.md`).
- **Agent tooling**: `chmod +x` prompts even in bypass mode; `rsync` is denied by a permission
  rule (use `cp -R`); `ps`, the docker socket and local WebSockets are blocked inside the Bash
  sandbox; Chromium and Electron need it off; foreground `sleep` is blocked — run plans in the
  background and wait for the notification.
- **Desktop**: references/desktop.md (IPC sender validation, the init-script race, thunks that
  are not exported, higher idle CPU).
