# Problem classes, and how a diff points at them

A branch can regress performance in six roughly independent ways. They need different metrics and
different scenarios, and a run that only measures one of them will confidently report "no
regression" while missing the others.

Use this file twice: once in phase 2 to turn the diff into a list of suspects, and again in phase 8
to check you actually measured every suspect you raised.

## The six classes

| Class | What goes wrong | Metrics that show it | Scenario | Instrument |
| --- | --- | --- | --- | --- |
| **Main-thread blocking** | Long tasks starve input; the app stops responding mid-interaction | TBT, long-task count and longest, INP | interact | `longtask`, LoAF, event timing |
| **React render volume** | Too many commits, too many components per commit, one store change fanning out to every subscriber | commits per interaction, fibers committed, newly mounted | mount, update, interact | DevTools hook |
| **Style & layout** | A big DOM makes every recalc expensive; script reads geometry while layout is dirty | `UpdateLayoutTree` and `Layout` count + ms, forced sync layout ms | mount, scroll | trace category split, LoAF `forcedStyleAndLayoutDuration` |
| **Paint & compositing** | Frames dropped, work that could be compositor-only lands on the main thread, content jumps | frame interval percentiles, frames over budget, paint count, CLS | scroll, animate | rAF deltas, `layout-shift`, trace |
| **Memory** | Repeated mount/unmount retains DOM, listeners, observers or cache entries | heap slope across cycles, retained-node survival | cycle | memory sampler, heap snapshot |
| **Load & boot** | Bundle parse/eval grows, boot waterfall lengthens | script eval time, FCP/LCP, transfer size | boot | trace with reload |

They interact. Virtualizing a list cuts style & layout and memory but usually *raises* React render
volume, because the window re-renders as it moves. Memoizing a selector cuts render volume but can
raise memory if the cache is unbounded. Expect a trade, look for it, and report both sides.

Each class has a house rule that fixes it, and those rules are binding on the codebase anyway:

| Class | Rule to reach for |
| --- | --- |
| Main-thread blocking | `skills/performance-complexity` (work per item), `skills/performance-scheduling` (work at the wrong moment) |
| React render volume | `skills/performance-react-hooks`, plus `skills/redux` for selector fan-out |
| Style & layout | `skills/performance-dom` — forced layout, observer APIs |
| Paint & compositing | `skills/performance-dom` — transition `transform`/`opacity` only |
| Memory | no dedicated rule; `performance-react-hooks` covers the effect-cleanup cases that cause most of it |
| Load & boot | `skills/performance-scheduling` — defer what the user is not waiting for |

`references/house-rules.md` maps specific findings to specific rules, and explains the two rules that
change what a finding *means* (which app is compiled, and why a redundant memo is as bad as a missing
one).

## Reading the diff

Match what changed against this table and write down the suspects before you measure anything. When
several rows match, the union is your scenario list — it is normal for one PR to need three
scenarios.

| What the diff changes | Suspect classes | Scenarios to run |
| --- | --- | --- |
| List rendering: virtualization, windowing, pagination, `key` strategy | render volume, style & layout, paint | mount, scroll, update |
| Memoization added or removed: `memo`, `useMemo`, `useCallback`, reselect/`createSelector` | render volume | update, interact |
| New or changed effects, subscriptions, observers (`useEffect` deps, `ResizeObserver`, `IntersectionObserver`) | render volume, **memory** | interact, cycle |
| Event handlers added, removed or rewired | blocking, **memory** | interact, scroll, cycle |
| Layout reads: `offsetHeight`, `getBoundingClientRect`, `scrollTop`, `clientWidth` | style & layout | scroll, interact |
| CSS: `position`, `overflow`, `will-change`, `contain`, `content-visibility`, transforms, `min-width` | style & layout, paint | scroll, mount |
| Context providers, store shape, what a component subscribes to | render volume | interact, update |
| Module-level caches, `Map`/`Set` registries, singletons | **memory** | cycle |
| A swapped dependency | treat as unknown | the full battery |
| Imports, code splitting, lazy boundaries | load & boot | boot |
| Data volume assumptions (a list that used to be short) | style & layout, render volume, memory | mount at two sizes, cycle |

Two habits worth keeping:

- **A swapped library is not a refactor.** It changes scheduling, allocation and DOM shape all at
  once. Run everything and let the numbers say which classes moved.
- **The PR description names what the author noticed.** A change to a shared component affects every
  consumer of it, and the author measured one. Derive suspects from the diff, then compare against
  the description and report any surface it missed.

## Which metric settles which argument

When two branches disagree, these are the numbers that actually decide it:

- *"It renders less"* — commits per interaction **and** fibers committed. Commit count alone hides a
  commit that got much bigger, and DOM node count alone hides a commit that got much more frequent.
- *"It does less layout work"* — `UpdateLayoutTree` count and total ms from a trace, not DOM node
  count. A smaller DOM usually means less recalc, but confirm it rather than assuming.
- *"It removed forced reflow"* — LoAF `forcedStyleAndLayoutDuration`, which is Chrome's own
  accounting. Zero on both branches is the common, correct answer: the properties
  `performance-dom` lists force layout only when layout is currently *invalidated*, and a scroll
  gesture does not invalidate it. That is a real measurement, not a broken instrument — and not
  licence to break the rule, since a call site's layout being clean is an accident of today's code.
- *"It is smoother"* — frame-interval percentiles and the count over 16.7ms / 33.4ms, from an
  untraced run. Wall time of a gesture is a weaker signal because it mixes in your driving loop.
- *"It does not leak"* — heap slope across ≥20 cycles, plus a heap snapshot to confirm what is
  retained. A single before/after heap reading proves nothing.
- *"It is more responsive"* — INP-style event timing if the input was real, otherwise long tasks and
  dispatch-to-commit latency, and say which you used.

## Choosing a scenario

Scenarios are defined by what changes and when, not by the feature being tested:

- **mount** — the subtree is absent, then present, from one state change. Isolates first render.
- **update** — present, then given different data, from one state change. Isolates re-render cost
  with mounting already paid for.
- **interact** — a user input runs a handler. Isolates responsiveness.
- **scroll** — a container is scrolled frame by frame. Isolates per-frame work.
- **navigate** — a route change tears one subtree down and builds another. Catches teardown cost and
  leaks that mount/unmount alone misses.
- **cycle** — mount and unmount repeatedly, sampling memory. The only scenario that finds leaks.
- **boot** — a cold page load. The only one that sees bundle parse and hydration.

Run at **two data sizes** wherever a list or collection is involved. A change that is flat in size
versus one that is linear in it is the most convincing result available, and it takes two points.
