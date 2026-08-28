# The repo's own performance rules

Trezor Suite carries four performance skills. They are binding on any code the team writes, and they
are also the **fix catalogue**: nearly every regression this harness can find has a named remedy in
one of them. A report that invents generic advice when a house rule already covers the case is worse
than useless — it competes with the rule.

Read the rule itself before citing it. These are pointers, not copies, and the source can move:

| Skill | Covers | Path |
| --- | --- | --- |
| Asymptotic complexity | indexing before iteration, sort comparators, reduce accumulators | `skills/performance-complexity/SKILL.md` |
| DOM and CSS | forced layout, observer APIs, compositor-only transitions | `skills/performance-dom/SKILL.md` |
| React hooks | memoization, stable dependencies, wasted memo vs render loop | `skills/performance-react-hooks/SKILL.md` |
| Scheduling | `requestIdleCallback`, deferring non-essential work | `skills/performance-scheduling/SKILL.md` |

Also relevant: `skills/redux/SKILL.md` (one `useSelector` per value) and `skills/components/SKILL.md`
(pass the narrow prop; don't optimise until you can point at the cost).

## Use them twice

**In phase 2, as a source of suspects.** Scan the diff for rule violations before measuring. A
violation is a hypothesis with a known mechanism, which tells you which scenario will expose it — a
`.find()` inside a `.map()` over transactions predicts that the *update* scenario degrades with list
size, not that scrolling gets janky.

**In phase 8, as the remedy.** Every recommendation should name the rule it comes from and link the
skill, so the author can act on it without rediscovering the reasoning, and so the fix matches how
the rest of the codebase already solves that problem.

## Finding → rule

| What the numbers show | Likely cause | Rule to cite |
| --- | --- | --- |
| Scripting time grows faster than the collection | `.find`/`.some`/`.includes` inside `.map`/`.filter`; a scan or allocation inside a sort comparator; `{ ...acc }` in a `reduce` | complexity — index by key first; O(1) comparators; keyed assign or `Map` |
| Commits per interaction unchanged, but each commit is much bigger (`fibersRendered` up) | work relocated into the render body, or a memo that stopped hitting | react-hooks — relocate render-body work before memoizing; memoize only what pays |
| One store change re-renders far more of the tree than it should | a selector returning a fresh reference; a wide `useSelector`; a subscription per row | react-hooks + redux — `createWeakMapSelector`, `returnStableArrayIfEmpty`, one `useSelector` per value |
| Effects or requests firing repeatedly with a stable render count | an unstable dependency on a `useEffect` — the silent, unbounded case | react-hooks — minimal dependencies; depend on `accountKey`, never `account` |
| High `forcedStyleAndLayoutDuration`, or `Layout`/`UpdateLayoutTree` nested inside `FunctionCall` | geometry read while layout is dirty, usually reads interleaved with writes | dom — one read then the writes; take geometry from an `IntersectionObserver`/`ResizeObserver` where it can come from one |
| Frames over budget during an animation, `Layout` on every frame | animating `width`/`height`/`top`/`margin`, or `transition: all` / the bare-duration shorthand | dom — transition `transform`/`opacity` only, and always name the property |
| A long task on the startup path that the user is not waiting for | analytics, telemetry, prefetch or cache warming on the critical path | scheduling — `requestIdleCallback` with a `timeout`, plus a `setTimeout` fallback on web |
| DOM node count scaling with the data | a list rendering every row | not a rule — but weigh it against render volume, since virtualizing trades DOM size for per-scroll commits |

## Two rules that change what a *finding* means

**Which app is compiled decides whether a memo is a fix or a defect.** `suite-native` runs React
Compiler, so it auto-memoizes and manual memoization there is a regression risk — a bail-out silently
drops auto-memoization for the whole component. `packages/suite` (web and desktop) is **not**
compiled, so manual memoization is the only runtime mechanism. `suite-common/*` and
`packages/components` ship to both and must be memoized for the web consumer. Since this harness
measures web, "add a `useMemo`" is a legitimate recommendation here — but say so explicitly when the
changed file also ships to native.

**A redundant memo is flagged as often as a missing one.** Do not recommend memoization on the
strength of a render count alone. Show the cost first: the work is genuinely expensive over a real
list, or a downstream hook needs the result's identity to be stable. O(1) arithmetic and formatting
belong in a plain util.

## Reporting a change that follows a rule but shows no win

This comes up often enough to be worth a fixed stance. A branch may adopt a rule — replacing geometry
reads with an `IntersectionObserver`, say — and the measurement may show no improvement, because that
particular call site was never hot.

Do not report that as "the stated motivation does not show up" and leave it there. The change is
still required by the house rule, and the rule exists because the call site being cold today is not a
property you can rely on. Report it as: the change is mandated by `performance-dom` regardless; this
call site was not where the cost was; here is where the measured win actually came from. That is
accurate, and it does not read as an argument against following the rule.

## The forced-layout list is about *when*, not *whether*

`performance-dom` lists the properties that force synchronous layout, and it includes `scrollTop`,
including setting it. That is the correct coding rule. It does not mean every such read costs a
reflow.

These properties force layout **only when layout is currently invalidated**. Nothing has dirtied
layout during a plain scroll gesture, so a `scrollTop` read in a scroll handler hits clean cached
geometry — measured as `forcedStyleAndLayoutDuration: 0.0ms` across a whole gesture. The expensive
shape is the one the rule's own example shows: a read *interleaved with writes*, where each read
re-computes what the previous write invalidated.

So when the harness reports zero forced layout on a branch that reads geometry, that is a real
measurement and not a broken instrument — and it is not licence to break the rule, because a call
site's layout being clean is an accident of the current code, not a guarantee. Say both things.
