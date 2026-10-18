# fnbench: function-level A/B in Node

`rig/fnbench.mjs` times one function of two Suite revisions against each other in Node, without the
app. It builds one esbuild bundle per variant from the checkout's real paths and gives every variant
its own module instance in each session process. It adds A/A and 2x controls, runs ABBA rounds and
treats the session as the unit. Use it for what the page rig cannot see. The workflow (when to
measure, how to report) is in SKILL.md, and the page rig is in `references/rig.md`.

## When to use it instead of the page rig

| The change | Tool |
| --- | --- |
| Code that never runs on the renderer: the coinjoin backend (an Electron utility process), `desktop-app-main`, a worker | fnbench, plus the in-app IPC route (`references/desktop.md`) when the round trip matters |
| A pure function whose cost the app hides behind a network wait, a timer or rendering, or that needs inputs too large to seed | fnbench |
| How a cost grows with input size; which hunk of a diff carries a win | fnbench (sizes, the cost model, hybrids) |
| Anything a user sees: renders, React commits, layout, input delay, IndexedDB, app memory | the page rig |

fnbench answers "how much cheaper is this function, and how does it scale". It does not answer "does
the app feel faster". When a change does both, run both: fnbench for the function and the page rig
for the screen. The page rig's numbers include what fnbench leaves out (IPC copies, rendering,
contention with the rest of the app).

**Node is not Electron.** Node's V8 is not the V8 in Suite's Electron or Chrome, and the bundle comes
from esbuild, not webpack. Ratios carry over; absolute times are indicative.

## Running it

```
node <skill>/rig/fnbench.mjs --config=<file> [--run=<name|dir>] [--repo=<checkout>] [--sizes=S,M]
     [--only=build,plan,run,aggregate] [--dry] [--fresh] [--rebuild] [--sessions=<n>]
     [--rounds=<n>] [--budget=<minutes per size>] [--inputs=settled|fresh] [--slot=off] [--pcore=off]
```

- **Sandbox on.** No browser starts, and Bash can run it. Run anything over a minute with
  `run_in_background: true` and wait for the completion notice.
- **`--dry` first.** It builds, calibrates and prints the plan with its estimate, but runs no
  session. Then run the same command without `--dry`. A rerun resumes: sessions of an unchanged plan
  stay, and only the rest run. A session counts only under the key it was measured with:
  - the protocol version;
  - the bundles' bytes and the installed versions of the externals they load;
  - what the config gives a session: its functions by source, its settings, and the modules it
    imports, by content. Not the budget, the session count, the model or `describe`; constants that
    `call` or `makeInput` read from the config file itself are not covered, so keep those in the
    data module;
  - the size's shape;
  - whether the performance-core gate really worked.

  A session process refuses to start when the config changed since the plan. `--only=run` refuses
  a stale plan, and `aggregate` leaves a stale size out with a warning. Another budget keeps a
  size's calibration unless the new cap could change which variants run. `--fresh` drops the
  sessions, the calibration and the plan, and `--rebuild` rebuilds the bundles.
- **`--run`** defaults to the config's `name`. It can be an existing page-rig run: fnbench writes only
  under `<run>/fnbench/`, never `out/`.
- **The repo.** `--repo` (or `$SUITE_REPO`, the current checkout, then the main checkout) supplies
  `node_modules` (esbuild and the bundle's dependencies) and the git objects. Its branch and working
  tree do not matter: tracked files come from git. No app build is needed.
- **`--only`** runs some phases (`build`, `plan`, `run`, `aggregate`) on an existing plan.
  `--sizes` limits a run to some sizes; other sizes' plans and sessions stay. `--sessions`,
  `--rounds` and `--budget` override the config for every size.
- **Gates.** Every session waits for AC power without Low Power Mode, like plan.mjs (unlimited;
  `PERF_AB_POWER=ac` measures anyway and is recorded). It then takes the machine slot (`--slot=off`
  skips it) and starts once 2 performance cores are free (`--pcore=off` skips that). The build and
  the calibration take the slot too.

Progress lines follow plan.mjs. A header gives the plan and its estimate, `== [i/n] <size>-<k>` lines
start sessions, a 30 s heartbeat gives the stage and ETA, and each session ends with its ratios.
`<run>/fnbench/status.json` holds the state for an instant check.

## The config

An ES module that default-exports an object. `examples/fnbench-coinjoin/fnbench.config.mjs` is a
complete one.

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | folder name | Titles, and the default `--run` |
| `revs` | required | `{ A: <before>, B: <after> }`: any revision the checkout has (fetch a PR head first) |
| `variants` | `{ A: { base: 'A' }, B: { base: 'B' } }` | `name: { base, files }`. `base` is `'A'`, `'B'` or a git revision; `files: { 'repo/path.ts': 'B' }` overrides single files. A plain A and a plain B are required; anything with `files` is a hybrid |
| `ref` | the plain B | The equivalence reference; every output must equal its output |
| `controls` | `{ aa: <plain A>, twice: <ref> }` | The A/A copy (item `<aa>2`) and the 2x block (item `<twice>2x`); `false` leaves one out |
| `entry` | required | What the bundle exports: `{ name: 'repo/path.ts' \| 'package' \| 'spec#original' \| 'spec#*' }`, or ESM source resolved from the checkout root. Export the function and whatever `makeInput` needs |
| `external` | `[]` | Packages left out of the bundle, next to the native addons found automatically (`binding.gyp` or `prebuilds/`) |
| `esbuild` | `{}` | Extra esbuild options (`alias`, `conditions`, `define`, `plugins`, …), merged in. `process.env.NODE_ENV` is `"production"` unless `define` says otherwise |
| `makeInput` | required | `(shape, { mod, size, cacheDir }) => input`, deterministic. `mod` is the sacrificial instance's exports; cache expensive parts in `cacheDir` |
| `describe` | – | `(input, refOutput) => ({ … })`: numbers printed next to the shape |
| `call` | required | `(mod, input) => result`: the timed call. It may return a promise. Keep it self-contained (see the traps) |
| `normalize` | identity | `output => comparable`, applied before the equivalence check (drop timestamps, sort a Map) |
| `inputs` | `'settled'` | `'settled'`: every item gets its own input, and two full GCs settle all of them before any call (long-lived data, the same layout in every session). `'fresh'`: a new input for every call, built just before its block (data that just arrived over IPC or from a parse). `--inputs=` overrides it; give the other mode its own `--run` |
| `metric` | `'cpu'` | What the verdict uses: thread CPU time or wall time; the other is reported below it |
| `sizes` | required | `name: { shape, sessions, rounds, budgetMin, items, reps }` in ascending cost. `shape` goes to `makeInput` and `model.cost`; `items` restricts a size to some items |
| `sessions`, `rounds` | `6`, `8` | Per size, unless the size sets them |
| `budgetMin` | `10` | Minutes per size (see the plan below) |
| `model` | – | `{ variant, fit: [sizes], cost: shape => number }`: `variant` ≈ k · cost(shape), fitted on `fit`, checked on the other measured sizes, and extrapolated where that variant did not run |
| `minBlockMs` | `1` | Calls per timed block (reps) so that a block lasts at least this long |
| `warmupMs`, `warmupCalls` | `200`, `100` | The warm-up per item: blocks until either is reached (the check's first call counts) |
| `gc` | `false` | `true`: a full GC before every block (before its fresh inputs are built). It keeps one item's old-space garbage out of the next item's block, but it slows short allocating calls (see the traps) |
| `nodeArgs` | `[]` | Extra Node flags for the session processes |

## What a run does

**Build.** There is one bundle per variant: ESM, the running Node's target, a `createRequire`
banner, and `node_modules` linked next to the bundles. Every tracked repo file the bundle pulls in is
served from `git cat-file` at the variant's revision (`files` overrides first), so the working tree's
branch and edits do not leak in. Relative imports resolve against the variant's tree whenever the
checkout would give another file or none, so a file added, moved or deleted between the revisions
resolves for the side that has it. That includes files in a folder only that side has, and their
package imports. Package imports (`@trezor/…`, workspace links included) still resolve on disk.
`node_modules` and untracked (generated) repo files come from disk, the same for every variant, and
are listed in `build.json`.

Bundles are written under temporary names and renamed only after every check passes. A cached
build is used only when every bundle on disk still has the recorded hash and no external package
changed its version. The build refuses:
- an override that is not in the bundle (a wrong path, or the entry does not reach it);
- a file imported at a revision that does not have it;
- A and B bundles that are byte-identical.

It logs which changed files landed in the bundles and the module sets that differ (for example, the
old code still pulled in `blockchain-link`'s root).

**Plan.** For every variant and size, one short process times a cold call and warm calls for about
`warmupMs`. These are estimates, not results. Variants over the size's per-call cap are handled as
follows:
- The cap is the budget / 16, so the smallest plan still fits: 4 sessions × (2 rounds + the check + a
  warm-up call).
- A variant over the cap is stopped.
- A variant that was too slow at a smaller size, or that the cost model (fitted on the smaller
  sizes' estimates) puts over 2 × the cap, is skipped.

The plan then fits sessions × rounds × items into the size's budget. With every item it tries fewer
rounds (down to 2), then fewer sessions (down to 4). Only then does it drop items, in this order:
the optional ones (hybrids, the A/A copy, the most expensive first), then the 2x block, and last the
slow side, keeping the fast side's own controls. A control never runs without its variant. Every
cut is printed with its reason. Reps per item keep a block over `minBlockMs`, and the sacrificial
instance is the fastest variant's bundle.

**Sessions.** Each session is its own `node --expose-gc` process (`NODE_ENV=production`, no
`NODE_OPTIONS`), and the first side alternates between sessions (A first, then B first).
- **Instances.** The sacrificial instance (`<bundle>?sac`) is imported first, builds the inputs and
  makes one call on an input of its own. Then every item gets its own module instance
  (`<bundle>?<item>`), imported in the session's order. The 2x block has its own instance too: one
  it shared with its variant would get extra calls and warm code that the other side never gets.
- **Inputs.** With `inputs: 'settled'`, every item gets its own copy, built the same way; a pristine
  copy is kept for the check. Two full GCs then settle all of them before any call, so no variant
  ever touches another's data and the layout is the same in every session. With `'fresh'`, every
  call gets a new input, built just before its block.
- **Glue.** Every item gets its own copy of `call` and its own block loop, each a `new Function`
  with the item's name in its source. Loop results are stored, so no call is dead code.
- **The check**, before any timing:
  - every instance's output must equal the reference's (`isDeepStrictEqual` after `normalize`);
  - the reference must return the same thing twice;
  - every settled input must come back equal to the pristine copy, with no newly frozen objects.

  Any failure stops the session with the first differing path.
- **Warm-up.** Every item runs its own blocks until `warmupMs` or `warmupCalls`.
- **Rounds** run in ABBA order: forward, reversed, reversed, forward. Every block is timed as thread
  CPU (`process.threadCpuUsage`, µs resolution) and wall time, then divided per call. Main-thread GC
  pauses inside a block are recorded from `gc` performance entries.
- **Priming.** A block under 50 ms is preceded by one untimed block of the same item, right before
  it, so the timed one starts on warm caches whatever ran before it in the round.
- **Placement.** On macOS arm64 a `pcore watch` on the session process reads P/E core time before
  the priming and after the block. The main thread's efficiency-core time is bounded from below: the
  process's E time beyond all its other threads' CPU. A block over max(0.5 ms, 2 % of its CPU) runs
  again, up to 3 times. The rest is reported as the E share.

**Aggregate.** It works like aggregate.mjs:
- each item's session medians (one per session and metric);
- every comparison's ratio is paired, because both sides ran in every session: the median of the
  per-session ratios, with their range (`ratioOfMedians` sits next to it in summary.json). Δ% is
  the paired change from `from` to `to`;
- the verdict is the rig's: separation and `permutationP` over the two sides' session medians.
  **called** when every session separates and p ≤ 0.1 (4 v 4 reaches 0.029 and 6 v 6 0.002),
  **underpowered** when the session counts cannot reach 0.1, **borderline** at p ≤ 0.25, else
  **settled**;
- `pairedP` stands next to it: an exact sign-flip test on the per-session log ratios. It sees a
  small, consistent effect that drift between sessions hides from the unpaired test, but it cannot go
  below 0.125 with 4 sessions (0.031 with 6, 0.0078 with 8).

Sessions on AC and on battery are never pooled. Comparisons:
- **main** `A/B`, the speedup: from A to B, Δ negative when B is cheaper;
- **hybrid** `<h>/<base>`: about 1.00 when the overridden files alone change nothing;
- the two **controls**.

## Reading the output

`<run>/fnbench/table.txt` (also printed) has one row per size. Then, per size: the shape and
`describe`, the reps, what was not run and why, the other metric, the GC pauses and the paired p.
After that come the model, the controls and warnings. The coinjoin example on this M4 (2026-10-17,
abridged):

```
size  n×r  A                       B                       A/B               Δ       sep      p       verdict  A2/A   B2x/B         AU/A   E%
S     6×8  380.9 ms [372.2–396.8]  1.652 ms [1.579–1.712]  235 [221–237]     -99.6%  B lower  0.0022  called   1.000  1.926         0.998  0.07
M     6×4  6.190 s [5.872–6.596]   3.641 ms [3.419–3.936]  1693 [1676–1751]  -99.9%  B lower  0.0022  called   0.996  1.997         0.997  0.23
L     4×8  ~62.14 s (model)        8.115 ms [7.982–8.156]  ~7657 (model)     –       –        –       –        –      2.195 (look)  –      0
XL    4×8  ~1:03:29 (model)        52.85 ms [52.28–53.06]  ~72080 (model)    –       –        –       –        –      1.905         –      0

S: T=30 V=100 receive=40 change=120 · addresses 160, used 1, utxo 58 · input settled, one per item, unchanged and unfrozen
    wall: A/B 236 [221–237] p 0.0022 called · AU/A 0.997 [0.995–0.999] p 0.8009 settled · … · GC pauses per call, mean (share of blocks with one): A 218.6 µs (31 %), …
    paired p (sign-flip on per-session ratios, cpu): A/B 0.0313 · AU/A 0.0313 · A2/A 0.8438
…
model: A ≈ k · cost(shape), cost = ({ T, V, receive, change }) => (receive + change) * T * V ** 2, fitted on S
    M predicted 5.714 s, measured 6.190 s (-7.7%) · L predicted 62.14 s → A/B ~7657 (not run) · XL predicted 1:03:29 → A/B ~72080 (not run)

controls: A/A S 1.000, M 0.996 · 2x S 1.926, M 1.997, L 2.195 (look), XL 1.905 · wall/cpu ≤ 1.003 · E share ≤ 0.23 % (main thread, lower bound), 2 blocks run again
warning: L B2x: GC pauses worth 7 % of a call land in 53 % of its blocks, which its median counts: raise minBlockMs so a block holds several GC cycles
warning: L: the 2x control reads 2.195 [2.161–2.279] (look): see "Reading the controls" in references/fnbench.md
```

Read it in this order:
1. **The controls.** A/A 0.996–1.000 and 2x 1.93–2.00 where A and B both ran, and E share
   ≤ 0.23 %. L's 2x is explained by the GC warning above it (see the traps).
2. **The verdict.** Called at both measured sizes: 6 v 6 separated, p 0.0022.
3. **The ratio with its session range.** It grows with size: the old cost is ~addresses · T · V²,
   the new one is about linear in T · V.
4. **The hybrid.** AU/A sits within the A/A spread (0.998 [0.995–0.999] next to 1.000
   [0.993–1.007]), so the `getAccountUtxo` hunk alone does not change the cost; the stats rewrite
   carries the whole win. S's paired p 0.031 is all six sessions on one side of a 0.2 % shift,
   which the A/A copy's own range covers. M does not repeat it (0.997, paired p 0.38).

`summary.json` holds the same per size: `items.<item>.{cpu,wall}.{median,range,sessions}`, `gcMs`,
`wallPerCpu`, `comparisons[]` (`{label, kind, from, to, cpu: {ratio, range, sessions,
ratioOfMedians, deltaPct, separated, p, pairedP, verdict, control}, wall: …}`), `placement`,
`dropped`, `describe`. It also has `model`, `controls`, `power`, `load`, `warnings`, the revisions
and every variant's bundle hash. Every session's own file keeps its per-block samples.

## Reading the controls

- **A/A copy** (`A2/A`): a second module instance of the same bundle, timed like any item. It should
  read 1.00: in range 0.98–1.02, worth a look up to 0.95–1.05, off beyond. It measures the floor:
  separate instances, positions in the round and drift inside a session. A difference smaller than
  the A/A spread is not real. A hybrid at 0.998 next to an A/A of 0.99–1.01 means "no effect". A/A
  sits on the non-sacrificial side, so a first-instance penalty per bundle would show up there too.
- **2x block** (`B2x/B`): another instance of the reference's bundle, called twice per rep in one
  block. It should read 2.0: in range 1.9–2.1, worth a look up to 1.8–2.2, off beyond. It proves the
  measurement scales:
  - below 2: the second call is cheaper, from a memo, a frozen input (the check catches frozen
    settled inputs) or warm caches. Without priming, a block's first call refilled the caches after
    the previous item's 390 ms block: the new coinjoin code read 1.86 in one session, and its time
    depended on the session's first side (2.0–2.1 vs 1.8–1.9 ms). Priming removed both;
  - above 2: the second call pays for the first one's garbage, or the block is too short for the
    timer (raise `minBlockMs`);
  - the 2x block is a separate instance, so it carries instance-to-instance variance too. On the
    2 ms coinjoin call a B-side A/A read 0.957–1.015 per session (median 1.001). In the session where
    B2/B read 0.957, B2x/B read 1.77: that session's B instance was the slow one. Judge the 2x
    control by its median and look at the A/A next to it before blaming the method;
  - on calls of a few nanoseconds the controls go off by design: every instance's loop compiles
    differently (a 3 ns call read 2x 3.46). fnbench is for calls of microseconds and up.
- **wall/cpu**: per item, the median of wall ÷ thread CPU. About 1.00 on a quiet machine. Over 1.05
  means the thread was descheduled (a loaded machine) or waited for other threads (an async call):
  trust the CPU numbers and the controls, not wall.
- **E%**: the main thread's efficiency-core share, a lower bound. Blocks over the limit were run
  again (`retried`). Blocks that stayed there after 3 tries are counted in `offP` and warned about.
  Check the controls before believing any ratio. When a control is off, the machine or the method
  failed that session, not the code.

## Traps

### Variants in one process share JIT feedback unless every one has its own copy

Two calls of the same function object share its inline caches and optimized code, and so do
closures one factory hands out. On Node 24, the sibling of an optimized closure ran optimized code
on its first call. A harness that imports a module once and swaps inputs, or one shared `call`
wrapper for every variant, measures a megamorphic mix. fnbench gives every item its own module
instance (`import('<bundle>?<item>')`); two instances of one file did not share optimized code. It
also compiles `call` and the block loop per item with a `new Function` of their own. A `call` that
uses a binding from the config module's scope cannot be copied: it falls back to the shared one,
and the summary warns. Keep `call` self-contained (`(mod, input) => mod.fn(input)`).

### The first instance imported into a process runs slower

In the Immer reducer bench (2026-10-13) the first-imported of two byte-identical copies read 1.28x
slower, whatever its name. A sacrificial copy imported first and used only for the warm-up brought
the A/A to 0.99–1.02. The sacrificial instance also runs `makeInput`, so setup code never trains a
timed instance's feedback.

### Variants that share an input measure each other

A call leaves traces in its input even when it changes nothing visible. The new coinjoin code looks
every vin/vout address up in a `Map`, which stores a hash in each string. The old code compares the
same strings with `===`, and on hashed strings it ran 385 → 196 ms. The ad hoc harness that fnbench
replaces gave all variants one input, so the old side read 200 ms and the win 92×. On inputs of its
own, the old code reads 381 ms and the win is 235× at S (6.19 s and 1693× at M). So every item gets
its own input, built the same way. The A/A copy has one too, so A/A ≈ 1.00 also shows that the
copies are equivalent.

### A function that walks a large input runs at the speed of the input's memory layout

The old coinjoin code chases pointers through ~480k vin/vout entries per call at S. Its cost
followed where its input sat in memory (P cores at 4.04 GHz, the same code and data):
- 77 ms on a young input, still in allocation order;
- ~390 ms on the same input after a full GC had moved it (and with no hashed strings);
- with a new input per call and no forced GC, every process repeated the same pattern of 88–390 ms
  calls, following the GC cycle (a median around 220 ms).

The new code read 2.2–2.7 ms in all of them (single calls, not primed). `inputs: 'settled'` (two
full GCs before any call) gives every session the same layout and the tightest sessions. `'fresh'`
is closer to a call fed by IPC or a parse, but it spreads wider and its median depends on the GC
cycle. When a function walks big data, run both (each with its own `--run`) and report the range:
the ratio is not one number.

### A forced GC before every block slows short allocating calls

`gc: true` starts every block on an empty heap. That keeps one item's garbage out of the next
item's block, but V8 shrinks the young generation after a full GC, so a short call that allocates
pays extra scavenges: the new coinjoin code went 2.5 → 3.2 ms (+28 %), the 200 ms old code did not
move. It is off by default. The GC column (main-thread GC pauses inside the blocks, per call) shows
when another item's garbage lands in a block.

### A call that freezes or changes its input gets cheaper on a reused one

Immer's auto-freeze freezes what it returns, including the parts of the input it kept. Calls on an
already frozen tree skip the freezing, so the second and later calls on a reused payload are cheaper
than the first. A call that sorts or annotates its input in place does the same. With settled
inputs, the check compares every item's input with a pristine copy and counts frozen objects before
and after; either change stops the session with "set inputs: 'fresh'". `'fresh'` builds a new input
for every call outside the timed region, so `makeInput` must be cheap enough: cache the expensive
parts in `cacheDir`, as the coinjoin example caches derived addresses.

### A loaded machine moves wall time first, then everything

Other sessions and builds share the cores. CPU time ignores the time the thread waits to be
scheduled, so on a loaded machine thread CPU kept the A/A at about 1.00 while wall time did not. CPU
time does not help when the thread lands on an efficiency core, though: it runs 3.7–4.9x slower and
the CPU time grows with it. That is why sessions take the machine slot, wait for 2 free performance
cores and run blocks again that provably ran on efficiency cores. Read the controls and wall/cpu
before the ratios.

### Native addons crash when bundled

A bundled `bcrypto` looks for its `.node` binary next to its own file through `__dirname`, which an
ESM bundle does not have. Packages with `binding.gyp` or `prebuilds/` stay external automatically.
Their loaders and wrappers (coinjoin needs `golomb` and `loady`) go in `external`. Externals load from
the checkout's `node_modules` through the link next to the bundles. A crash with `__dirname is not
defined` or a missing `.node` file names the next package to add.

### The bundle is not the app's build

`NODE_ENV` is `"production"` (as in release builds), and code behind development checks is gone. Add
`define` entries the app's webpack config sets if the function reads them. An untracked, generated
file (message-system config, protobuf output) comes from disk and is the same for both variants: if
the change regenerates it, generate both versions and A/B them by hand. `build.json` lists every
untracked file.

### Absolute numbers depend on the heap around them

Other payloads in the same process shift absolute times (shared hidden classes, GC pressure, the
layout above). Report ratios with the input mode. Explain a gap between fnbench's absolute times and
someone else's measurement with that, not with a regression.

### A model extrapolates; it does not measure

The cost model fills in sizes the slow side cannot finish, and the table marks them `(model)`. Trust
an extrapolation only as far as the model's error on a measured size that was not in the fit. The
coinjoin model (addresses · T · V², fitted on S) predicted M 7.7 % low: 5.71 s against 6.19 s
measured (8.6 % in an earlier run). On its own settled data the old code grows a little faster than
the model, so the L and XL extrapolations are floors. The ad hoc harness's shared input had fitted within 1 %. Fit on the
smallest size, check on the next one, and report the error next to every extrapolation.

### A median of short blocks counts GC pauses only past half of them

A call that allocates pays for GC pauses that land in some of its blocks only. A median skips them
while they land in under half of the blocks, and counts them once they land in over half. A block
twice as long (the 2x control) crosses that line first. At L the new coinjoin code (8 ms a call) had
a pause in 3–13 % of its blocks and its 2x block in 50–53 %, so the 2x control read 2.20 in two runs
(GC worth ~7 % of a call). The table lists each item's mean GC pause per call and the share of blocks
with one. It warns when pauses worth over 2 % of a call land in some blocks but not most; raise
`minBlockMs` until every block holds several GC cycles. At S and M the new code's own blocks had
almost no pauses, so its A/B ratios carry no such bias.

## Files

```
<run>/fnbench/
  build.json         revisions, every variant's bundle (sha256, modules from git per revision,
                     node_modules, untracked files, changed files), module-set differences, warnings
  bundles/           <variant>.mjs + node_modules -> the checkout's
  calibration.json   per size and variant: input/import/cold/warm/GC ms, or cap / skipped
  plan.json          per size: sessions, rounds, items, reps, sacrificial, dropped (why), estimate,
                     the keys it was planned under
  specs/             what each child process got (rerun one by hand:
                     node --expose-gc fnbench.mjs --child=<spec>; it overwrites the session's file)
  sessions/<size>-<n>.json   one session: check, warm-up, priming, per-block samples (cpu, wall,
                     gc, e), medians, placement, load, power
  summary.json, table.txt    the aggregate
  status.json        state, phase, current session and stage, done/total, ETA
  cache/             makeInput's cache
```

## Worked example: coinjoin getAccountInfo

`examples/fnbench-coinjoin/`: commit 9ae5eeea9b computes coinjoin address stats in one pass over the
account's transactions instead of one pass per address. It runs in the coinjoin backend's utility
process. `data.mjs` builds a deterministic account per shape: real regtest addresses derived with
the bundle's own `CoinjoinAddressController` (cached), and wide `joint` transactions with a few owned
inputs and outputs.

```
node <skill>/rig/fnbench.mjs --config=<skill>/examples/fnbench-coinjoin/fnbench.config.mjs --run=fnbench-coinjoin
```

One run took 13 min on the M4 with the machine slot free: build 3 s, calibration 2 min (L's old
side runs into the cap twice), 20 sessions 11 min. The result is the table under "Reading the
output". Two full runs agreed within 3 % on the A/B ratios. The new side's absolute times at L and
XL moved 10–13 % between them (the machine, not the code), which is why fnbench reports ratios. The
last run:
- **S:** 381 ms → 1.65 ms (235×).
- **M:** 6.19 s → 3.64 ms (1693×).
- **L and XL:** only the new side runs, 8.1 ms and 53 ms. The model puts the old side at ≥ 62 s and
  ≥ 63 min.
- **Controls:** A/A 0.996–1.000, 2x 1.93–2.00, and the hybrid's ratio inside the A/A spread.

The ad hoc harness it replaces had reported S 200 ms → 2.2 ms (92×) and M 2.98 s → 4.2 ms (710×). It
gave all variants one input, which the new code's Map lookups left hashed for the old code (see the
traps). Run that way, fnbench's bundles read the same as the old harness: 195–197 ms against
2.2–2.3 ms (85–90×), whichever side ran first.
