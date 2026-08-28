---
name: suite-perf-ab
description: >
  Measure and compare runtime performance of a Trezor Suite web branch or PR against develop by
  driving both in a real browser with the Chrome DevTools MCP: it seeds identical synthetic wallet
  state, auto-detects the affected UI surfaces from the git diff instead of trusting the PR
  description, replays each interaction 15 times at 1x and 4x CPU throttling, and reports p75 with
  deltas in both directions. It covers the whole single-page-app picture — React render volume,
  main-thread blocking, style and layout, paint and dropped frames, memory growth across repeated
  navigation, and cold boot cost. Use it whenever someone wants to benchmark, profile, or A/B a
  Suite branch or PR, verify or challenge a perf claim before approving or merging, ask whether a
  change made Suite faster, slower, janky or leaky, check how a surface holds up with a large
  seeded wallet, or raises render and scripting time, React commits or re-renders, wasted renders,
  total blocking time, forced reflow, style recalculation, jank, dropped frames, INP, memory leaks,
  or DOM size for a Suite change — even without the word "profile", and even when they only
  advertise a win, since catching unmeasured regressions is half the job. It only measures and
  compares in-browser web Suite: do not use it to write the optimization, fix the slow code,
  profile suite-native or the Electron desktop shell, time builds, CI, or jest runs, compare bundle
  sizes, debug flaky tests, audit a public site, add a JS microbenchmark, or merely summarize what
  a branch changed.
---

# Suite single-page-app performance A/B

Measure a branch against `develop` and say, with numbers a reviewer can trust, what got faster,
what got slower, and what did not move.

Recording a trace is the easy part. The work is getting two builds into an **identical, realistic
state** without a device, choosing scenarios that actually exercise what changed, and collecting
enough samples that the answer is a distribution rather than an anecdote.

## What a good run produces

- A scenario per suspected problem class, each isolating one interaction.
- p75 over **≥12 kept iterations** per scenario per branch per throttling level, warm-ups discarded.
- A 1x and a 4x CPU pass, because a fast Mac hides regressions real users feel.
- Deltas in both directions. A report that only confirms the PR's claim has not been checked.
- An explicit caveats section: what was synthetic, what n was, what the measurement could not see.

## Before you start

Confirm the Chrome DevTools MCP is connected (`list_pages`). Everything runs through it.

No device, emulator, Docker or backend is needed. If you find yourself starting `trezor-user-env`,
stop and read `references/seeding.md` — the app can be driven into any state from the page itself,
which is faster and far more repeatable.

## 1. Two comparable builds

Every Suite PR gets a preview deployment, and so does develop:

- branch: `https://dev.suite.sldev.cz/suite-web/<branch-name>/web/` (slashes kept, e.g. `perf/accounts-list`)
- base: `https://dev.suite.sldev.cz/suite-web/develop/web/`

Both are production builds on the same host, which is what makes them comparable. Check both return
200 with `curl -o /dev/null -w '%{http_code}' -L` before anything else — a missing preview is the
most common way a run gets half-finished.

Routes are directory-style and **need the trailing slash**: `/accounts/` is 200, `/accounts` is a
302. Query params go after it, e.g. `/accounts/?symbol=btc&accountIndex=0&accountType=normal`.

Fall back to local builds only if a preview is genuinely missing; a dev build has different
performance characteristics and cannot be compared against a deployed one.

## 2. Turn the diff into suspects, then scenarios

```bash
git fetch origin <branch>
git diff develop...origin/<branch> --stat
git diff develop...origin/<branch> -- <each source file>
```

Read every changed source file's diff **in full**, and read the surrounding file at both revisions
(`git show develop:<path>`, `git show origin/<branch>:<path>`) when the diff alone does not say what
the code did before.

Then open `references/problem-classes.md` and work through its two tables. The first names the six
ways an SPA regresses — main-thread blocking, React render volume, style and layout, paint and
compositing, memory, load and boot — with the metric and scenario that expose each. The second maps
what a diff touches onto those classes, so a change to effect dependencies raises *memory* as a
suspect and not only render volume.

Write the suspect list down before measuring, and check it again when you write the report. A
scenario list that only covers one class is how a run reports "no regression" while missing three.

Then scan the same diff against the repo's own performance rules — `skills/performance-complexity`,
`performance-dom`, `performance-react-hooks`, `performance-scheduling` — using the finding→rule table
in `references/house-rules.md`. A rule violation is a suspect with a known mechanism, which tells you
which scenario will expose it: a `.find()` inside a `.map()` over transactions predicts that *update*
degrades with list size, not that scrolling gets janky. Those same rules are the fix catalogue in
phase 8, so reading them now pays twice.

Treat the PR description as a hypothesis. It names what the author noticed; a perf PR usually
touches shared components whose other consumers the author never measured, and that is where
regressions hide. Derive your own list, then say which surfaces the description missed.

If a changed surface genuinely cannot be reached without a device flow (parts of trading and
receive), say so in the report rather than quietly dropping it.

## 3. Identical state on both branches

Read `references/seeding.md`. Suite exposes its Redux store on `window.store` when
`window.Playwright` is truthy, so an init script can inject a synthetic remembered device and any
number of accounts before the app finishes booting.

Two properties belong in the report:

- The seed is **byte-identical** on both branches — same device, same accounts, same order.
- It is **synthetic**: no real device, no passphrase, no wallet, and nothing persists, because the
  state goes into the store rather than IndexedDB.

Match the viewport on both branches (`resize_page`, then verify `innerWidth`/`innerHeight` *and* the
relevant container's `clientHeight` agree). One pixel of difference changes how many rows render.

## 4. Instrument

The harness is two files, concatenated and passed as the `initScript` argument of `navigate_page`:

```bash
cat ~/.claude/skills/suite-perf-ab/assets/harness-core.js \
    ~/.claude/skills/suite-perf-ab/assets/adapters/suite-web.js
```

`harness-core.js` is app-agnostic instrumentation and scenario primitives. `adapters/suite-web.js`
supplies the Suite knowledge: fixtures, seeding, selectors, and the concrete scenarios built on the
primitives. Profiling a different surface means writing a new adapter, not touching the core.

It has to be `initScript`, not `evaluate_script`, for two reasons that both fail silently:

- `window.Playwright` must be true before `MainWeb`'s effect runs, or `window.store` never appears.
- The React DevTools hook must exist before `react-dom`'s module body evaluates, because that is
  when React looks for it. Install it late and every commit count reads zero.

What the core gives you, all passively:

| Signal | From | Sees |
| --- | --- | --- |
| React commits, timestamps | fake `__REACT_DEVTOOLS_GLOBAL_HOOK__` | every commit; safe because production react-dom calls the hook inside `try/catch` |
| Fibers committed, newly mounted | opt-in fiber walk | how *big* a commit was, not just how many |
| Long tasks, TBT | `PerformanceObserver('longtask')` | main-thread work over 50ms |
| Script time, forced style/layout | `PerformanceObserver('long-animation-frame')` | per-script duration and Chrome's own forced-reflow accounting |
| Interaction latency | `PerformanceObserver('event')` | input responsiveness — read the caveat in `pitfalls.md` about synthetic events |
| Layout shift | `PerformanceObserver('layout-shift')` | content jumping during an interaction |
| Frame intervals | `requestAnimationFrame` deltas | the only signal below the observers' 50ms floor |
| Heap trend | memory sampler | growth across repeated cycles |

Do not monkey-patch `getBoundingClientRect` or the layout getters to count reads during a timing
run. It works, but it taxes whichever branch reads layout more — usually the one you are judging.
Counting in a dedicated non-timing run is fine; say which run a count came from.

## 5. Scenario primitives

The core implements seven shapes. An adapter supplies `{setup, act, reset}` for each; the shape
decides what is isolated.

| Primitive | Isolates | Use when the diff touched |
| --- | --- | --- |
| `mount` | first render of a subtree | list rendering, a new component, data volume |
| `update` | re-render with mounting already paid | memoization, selectors, store shape |
| `interact` | responsiveness of a handler | event handlers, input paths |
| `scroll` | per-frame work | virtualization, scroll handlers, CSS containment |
| `navigate` | teardown plus build of a route | routing, effect cleanup |
| `cycle` | retention across repeated mount/unmount | effects, observers, caches, listeners |
| `boot` | cold load, bundle parse, hydration | imports, code splitting, dependencies |

Two traps worth knowing before you write a scenario:

- **One dispatch, not many.** Suite reads the store through `useSyncExternalStore`, so a store change
  from outside React renders synchronously, once per dispatch. Sixty individual `createAccount`
  dispatches produce ~39 commits and measure a list being built incrementally. Use a bulk action.
- **Scale the data.** Run size-sensitive scenarios at two sizes (60 and 200 accounts works). Flat
  versus linear in collection size is the most convincing result available and it needs two points.

## 6. The measurement protocol

Same numbers on both branches, always:

| Knob | Value | Why |
| --- | --- | --- |
| Iterations | 15, first 3 discarded | JIT and styled-components warm up; iteration 0 runs 20–30% slower |
| Statistic | p75, nearest rank | Report p50/p75/min/max so the reader sees the spread |
| CPU | 1x and 4x (`emulate`) | 1x on Apple silicon at 120Hz floors frame time at 8.3ms and hides real regressions |
| Sizes | two, for anything size-sensitive | Separates "faster" from "no longer scales" |
| Cycles | ≥20 for `cycle` | A heap slope needs a run; two readings prove nothing |

State what the p75 is **over**: repeated iterations within one page session, not independent page
loads. It captures variance in the interaction, not in app startup. Report iteration 0 separately
when the cold case matters.

Traces are a *supplement*, not the source of headline numbers. Record at most one short trace per
branch per scenario, for the scripting / style / paint split, and label it with its real n.
`references/pitfalls.md` explains why; the short version is that tracing this workload writes
~200MB in 1.2s, saturates the thread it is measuring, truncates its own buffer, and its overhead
scales with React commit count — so it penalises whichever branch commits more, which is not the
same branch in every scenario.

## 7. Analyse

Zero-dependency Node, all in `scripts/`:

```bash
# p75 over in-page iteration records — the headline numbers
node scripts/p75.js --label="develop mount 4x" --warmup=3 <records.json> --out=<summary.json>

# slice a trace into the windows the harness marked, then p75 each metric
node scripts/iter-report.js --scenario=S1 --label="develop mount" --warmup=0 <trace.json>

# one trace, full DevTools category breakdown (also --aggregate and --compare)
node scripts/analyze-trace.js <trace.json> [--from=<ms>] [--to=<ms>] [--json]
```

Save each `evaluate_script` result straight to a file with its `filePath` argument — the records are
long and you will want them again. Delete trace files as soon as you have their summary; they are
~200MB each and a full run makes six.

**When a result surprises you, verify it before reporting.** A regression found with one gesture
should be reproduced with a different one — a slow drag as well as a fast flick. One extra run is
cheap; a retracted finding is not. For a suspected leak, confirm with `take_heapsnapshot` before
calling it a leak.

## 8. Report

Publish as an artifact, structured so a reviewer can act:

- **Verdict cards** — one per scenario, headline delta, direction obvious at a glance.
- **A table per scenario** — develop, branch, delta, with n and throttling stated.
- **Root cause for any regression** — commit counts and fiber counts usually name the mechanism.
  Follow with concrete ordered fixes referencing real props and files, and **cite the house rule each
  fix comes from** (`references/house-rules.md` maps findings to rules). Suite already has a named,
  worked answer for most of what this harness finds; inventing generic advice next to an existing
  rule competes with it. Where no rule covers the finding, say that explicitly rather than dressing
  an opinion up as policy.
- **The traced category split** — scripting vs style/layout vs paint, flagged with its small n.
- **Coverage** — which of the six classes you measured, and which suspects you raised but could not
  reach. An unmeasured class is not a passed one.
- **Caveats** — synthetic state, what p75 is over, trace overhead, one machine.

Two habits that make a report trustworthy:

- **Check the PR's stated motivation separately from its result.** A PR can be a real win for a
  reason other than the one it claims. If the claimed mechanism does not show up, say so and say
  what the win actually came from — that is useful review feedback, not criticism. When the change
  the numbers did not credit is one a house rule *requires*, say that too: "mandated by
  `performance-dom` regardless; this call site was not where the cost was" is accurate, whereas
  leaving it at "the motivation does not show up" reads as an argument against following the rule.
- **Lead with the regression if there is one.** The author already knows about the win.

## Adapting to another surface or app

Write a new file in `assets/adapters/`. An adapter exports an object with the state seeding, the
selectors that find the elements a scenario drives, and the concrete scenarios built from the core
primitives. `adapters/suite-web.js` is the worked example; the contract it implements is documented
at the top of `harness-core.js`.

## Bundled files

| File | Read it when |
| --- | --- |
| `references/problem-classes.md` | Phase 2 — turning a diff into suspects, and phase 8 checking coverage |
| `references/house-rules.md` | Phase 2 scanning the diff for rule violations, and phase 8 citing the fix |
| `references/seeding.md` | Setting up state; extending fixtures to other slices |
| `references/pitfalls.md` | Any number looks wrong, or before trusting a trace, an INP figure or a leak |
| `assets/harness-core.js` | Every run; also the adapter contract |
| `assets/adapters/suite-web.js` | Every Suite run; the template for a new adapter |
| `scripts/p75.js` | Aggregating in-page iteration records |
| `scripts/iter-report.js` | Slicing a trace into marked windows |
| `scripts/analyze-trace.js` | Full category breakdown of one trace |
