# Measurement failure modes

Every entry here was hit for real or verified by direct measurement in Chrome. Most fail *quietly*
— they produce plausible numbers rather than an error — which is why they are worth knowing before
you trust a result.

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
get 2, with no warning. Symptom: `iter-report.js` prints `no S*-* measures found`, or reports fewer
iterations than you ran. Shrink the traced scenario, and if a full iteration will not fit, say so
and rely on the untraced metrics.

### Trace window alignment reads as zeros

`analyze-trace.js` takes `--from`/`--to` relative to its own origin: `navigationStart` when present,
otherwise the earliest event with `ts > 0`, **skipping metadata (`ph: 'M'`) events**. Compute the
origin differently and every window lands in empty space.

Symptom: every metric is `0.0` but `windowDurationMs` is correct — the window is the right length in
the wrong place. That combination is never a real "no work happened". Traces recorded mid-session
have no `navigationStart`, so the fallback path is the normal one; `iter-report.js` already
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
