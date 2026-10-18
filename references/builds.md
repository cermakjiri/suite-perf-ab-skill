# Builds: what is compared, how it is built, and the proof

Both sides of a run are built locally, from pinned commits, with CI's recipe, in copy-on-write clones
of the checkout. This page is the why behind `revs.mjs`, `build.mjs`, `fingerprint.mjs` and
`bundlediff.mjs`; the flags are in `references/rig.md`. Measured on 2026-10-13 (M4, PR #32496 merged into develop).

## The pair: the target branch against the feature branch

`revs.mjs --pr=<n>` takes the PR's own target branch (`baseRefName`: `develop`, or a `release/*`
branch for a backport) from `gh`, fetches it and the PR head, and checks one thing before anything is
built: **is the feature branch up to date with its target?** Up to date means the target's tip is in
the branch (merge-base == tip). Then A = that tip, B = the head: exactly the branch's own commits
apart, on the base it would merge into.

A branch that is behind cannot be measured conclusively as it stands, in either direction:

- against today's tip, every commit the target gained since the fork is charged to the PR — 123
  commits and 720 files for PR #32496 on 2026-10-13, 20 of them files the PR also touches, and
  `yarn.lock` moved;
- against the fork point (the merge-base), the change is measured on a base that no longer exists:
  the target's newer code may change what the PR's code costs, and the merge ships the combination.

So `revs.mjs` stops there (exit 3), prints what moved on the target (commit count, files, the files
both sides touched, whether `yarn.lock` moved, the newest commits) and the advice: **rebase first**,
then pin again. Only on an explicit choice by the user:

| `--accept-behind=` | A | B | Says |
| --- | --- | --- | --- |
| `merge-base` | the fork point | the PR head | the branch's own commits, on its old base; the report carries the caveat |
| `merge-ref` | the merge's first parent | GitHub's `refs/pull/<n>/merge` | the PR applied to its target, as CI tests it. Not for a conflicting PR. GitHub recomputes the ref lazily: PR #32496's was 21 commits behind the tip — the report says so |

`run.json` keeps the check (`base`: branch, tip, merge-base, behind, ahead, mode, state, the files both
sides touched), `build.mjs` refuses to build a branch recorded as behind, `preflight.mjs` repeats the
verdict and says when the target moved since pinning (the pair still isolates the branch's commits;
pin again to measure on the new tip), and the report states it as a caveat.

Fetched refs: `origin/<base>` and `refs/perf-ab/pull/<n>/{head,merge}` — a namespace of the rig's
own, so the commits stay reachable until the clones are built, outside `git branch -a`, and the
user's `FETCH_HEAD` untouched (`--no-write-fetch-head`). `cleanup.mjs --refs` drops them. Sides
written by hand (an A/A run, two arbitrary SHAs) skip the check; `build.mjs` says so.

## The recipe

Per side, in `$PERF_AB_HOME/clones/<sha12>[-<variant>].<profile>` (cached: a second run against the
same commit and profile reuses the build):

| Step | What | Took |
| --- | --- | --- |
| clone | `clone.py`: APFS `clonefile` of the main checkout, `.claude` worktrees skipped | 21 s |
| checkout | `git checkout --force --detach <sha>`; a variant's `patch` applied and committed (below); `.env.local` set aside | < 5 s |
| yarn install | `--immutable --mode=skip-build`, offline first | 3-4 s |
| prep | what CI regenerates before every build: `message-system` `sign-config` (development key), `@suite/app-assets` `browser-detection` + `favicon`, for desktop `@trezor/transport-bridge build:lib` | 9-10 s; +10 s for desktop |
| web | `yarn workspace @suite/web-app build` | 36 s; 63 s compiled (PR #32496) |
| desktop | `clean` (3 s), `build:ui` (renderer, 44 s), `build:app` (main + preload, 25 s) | ~70 s |
| fingerprint | below: the bundle must carry the clone's commit and the profile's flag, and no coverage | < 1 s |

**Why the prep steps.** A clone copies the checkout's untracked files too, so without them a build
bundles whatever generated files the checkout had when it was cloned: the message-system config
(`suite-common/message-system/files/config.v1.ts`, git-ignored, generated on 2026-10-05 in the
checkout measured here), the browser-detection and favicon scripts, the transport-bridge UI. Two
clones made on different days then bundle different generated content. CI regenerates them before
every build (`build-suite-web.yml`: `message-system-sign-config`, `app-assets build:lib`); so does
the rig. The one exception is the guide content (`guide-pull-content` clones a repository over the
network): it stays as inherited, its hash is recorded per side, and `preflight.mjs` warns when the
sides differ — the guide markdown is bundled, but only a scenario that opens the guide could notice.

**What the build sees.** The webpack config loads `<repo>/.env.local` through dotenv
(`packages/suite/webpack/env.ts`); a developer's `.env.local` (TanStack devtools, transport ping,
codesign…) would reach every build. The checkout clones it along, so the rig renames it to
`.env.local.perf-ab-ignored` in the clone and scrubs the same knobs from the environment
(`INSTRUMENT_CODE`, `NODE_ENV`, `IS_CODESIGN_BUILD`, `TANSTACK_REACT_QUERY_DEV_TOOLS`,
`TRANSPORT_BROWSER_PING`, `ASSET_PREFIX`, `TEST_BUILD`, …, `SENTRY_AUTH_TOKEN=''`), then sets the
profile's. Node is the revision's `.nvmrc` one when nvm has it (else the running Node, on both sides,
with a warning).

**Installs.** Offline from the checkout's `.yarn/cache` first. A target branch newer than the
checkout locks packages that cache never saw (`YN0080 … blocked`): the rig then installs again with
the network, keeps what it fetched in `$PERF_AB_HOME/yarn-cache` (yarn's cache files are
content-addressed, so any clone can take them) and seeds every later clone from there — the second
side and the next runs on the same base install offline again. Inside an agent's Bash sandbox the
network install needs `registry.yarnpkg.com` allowed; yarn berry ignores `HTTPS_PROXY`, so the rig
hands the sandbox's proxy over as `YARN_HTTPS_PROXY`, caps yarn at 8 parallel downloads (the proxy
aborted a burst of 50: "The server aborted pending request") and moves yarn's global folder from
`~/.yarn` (not writable from the sandbox) to `$PERF_AB_HOME/yarn-global`. The mirror must stay on:
with `enableMirror` off yarn names cache files by cache key (`<pkg>-10.zip`) instead of by checksum
(`<pkg>-<hash>-<checksum>.zip`), finds none of the checkout's zips and downloads all ~3,600 again
(~50-100 a minute through the proxy; seen 2026-10-13, one package actually missing). If it still
fails, run `build.mjs` with the sandbox off.

**Variants.** A side with a `patch` (a reverted hunk, a tweaked constant) gets the patch committed in
its clone with a fixed identity and the base commit's date — the same patch on the same base gives the
same commit, and that commit is what its bundle carries (`side.buildSha`), so a variant is told apart
from its base without a marker too.

## Profiles: what is built

`run.json` `"build": { "profile": … }` (or `build.mjs --profile`), the same for every side; each
profile builds in its own clone.

| | `release` (default) | `preview` |
| --- | --- | --- |
| `IS_CODESIGN_BUILD` | `true` | unset |
| Is what | users install: suite.trezor.io and the desktop releases | CI previews on dev.suite.sldev.cz and the e2e builds |
| redux-logger | off | **on**: `createLogger` in `packages/suite/src/reducers/store.ts` logs every dispatch (`!isCodesignBuild()`) |
| endpoints (message system, earn, quota manager, Solana/Stellar env) | production | develop |
| analytics / logger `isDev` | false | true |
| message-system config | the bundled config is signed with the development key (the production key never leaves CI), which a codesign build rejects: no message-system banners, one console error at boot — on both sides | accepted |
| desktop main | DevTools menu off, app name without "Dev" | on |
| release string | `<version>.web.codesign.<sha>` | `<version>.web.<sha>` |

**Why `release` is the default.** redux-logger is per-dispatch work that users never pay. With CDP's
Runtime domain on — Playwright always has it on — every logged action and state is serialized into
a console message and kept reachable by the inspector. Measured on the same commit (`85b057a8d8`,
web, 4x CPU, ABBA, 2 sessions a side): 200 no-op dispatches took **24.8 ms of main-thread CPU in the
release build and 224 ms in the preview build** (session medians 24.9 / 24.7 vs 226 / 222 ms) —
about 1 ms per dispatch, 9x the dispatch itself. That cost scales with the **number of dispatches**,
which is exactly what perf PRs tend to change (batching, coalescing, fewer actions): a preview build
adds the logger's cost to every dispatch the PR saves or adds, inflating the delta. Use `preview` to
reproduce what a preview or the e2e builds show, or when comparing with numbers taken from previews.
A build-config A/B like this one is a run whose sides share a commit and differ in profile
(`build.mjs --sides=B --profile=preview`); preflight and the report say so.

The fingerprint checks the profile took effect (the `.codesign` in the release string); a bundle that
disagrees with its profile fails the build and the session.

## Which build ran — no marker to choose

Every Suite bundle inlines the commit it was built from, twice: `process.env.COMMITHASH`
(`getCommitHash`, `packages/suite/webpack/createBaseConfig.ts` on develop) and the release string
`process.env.SENTRY_RELEASE` = `<version>.<web|desktop>[.codesign].<sha>`, both from `git rev-parse
HEAD` in the tree being built. They are DefinePlugin values, so they are in local builds, CI previews
and releases alike — the Sentry plugin (which only `build-suite-web.yml` runs, and which adds
`window.SENTRY_RELEASE`) is not needed. In a web build they sit in the app's chunks and in the worker
and connect-popup entries; on desktop in the renderer's `main.<hash>.js` and in `dist/app.js` (main).

- **After every build** `fingerprint.mjs` reads the bundle: the commit must be the clone's HEAD (a
  stale build, or one from another tree, fails the build), the codesign flag the profile's, coverage
  0. `preflight.mjs` fingerprints again from disk before a plan.
- **In every session** the env check scans the loaded modules once for this side's commit and every
  other side's. Another side's commit, or a release string naming another commit, fails the session;
  this side's commit present is `env.build.verified: true`. If the module carrying it has not loaded
  yet, the build's offline fingerprint vouches (`'offline'`).
- **Deployed previews** (`url` sides) have no expected commit: each session records the one it was
  served. `plan.mjs` stops when a side's deployment changes between sessions, and `aggregate.mjs`
  refuses to pool a side whose sessions ran more than one commit (develop redeploys on every push:
  `pitfalls.md`) unless `--allow-mixed-builds`.
- **Re-pinned or rebuilt sides**: a session made from another commit than the side's current build is
  stale; `plan.mjs` runs it again.

`markers` in `run.json` are now optional: they prove that a given piece of code is in the bundle
(not tree-shaken, not behind a flag), which the commit cannot.

## Did the change reach the bundle at all — the bundle comparison

After both sides of a target are built, `build.mjs` compares their JS (`rig/bundlediff.mjs`) and
prints per target either **code-identical between sides (apart from mangled names, hashes, commit,
signed config)** or the files that differ with their size deltas; `run.json` keeps it as `bundles`
(`{ web: { "A-B": { identical, parts: { web: { files, byteSame, differing } } } } }`) and
`preflight.mjs` shows it. A code-identical target is **unaffected by the change: report it so, do
not time it** — timing two identical programs only measures the noise. The parts are compared
separately: web `build/`, the desktop renderer `build/` and the desktop main process `dist/` (where
the utility-process threads live).

Plain checksums cannot answer it: two builds of different commits differ byte for byte in most
chunks even when no code changed. What differs between any two builds is masked first:

| Masked | Why it differs |
| --- | --- |
| content-hashed names (`main.1a2b3c4d.js`): chunks pair by name with the 8-hex hash stripped | the hash covers the inlined commit |
| both sides' commits, full and short (any hex run starting with the first 7 characters) | `COMMITHASH`, the release string |
| quoted 8-hex chunk-hash maps (`"1a2b3c4d"`) and `.<hash>.js` references | the runtime's chunk table |
| `eyJ…` JWT-like tokens | the message-system config is signed at build time |
| identifiers of 1–3 characters not after a dot (`(?<![\w$.])[A-Za-z_$][\w$]{0,2}(?![\w$])` → one placeholder) | the minifier renames them when modules shift |

Strings, numbers, property names and longer identifiers are never masked, so a code change still
shows. Measured on the coinjoin-address-stats pair (04caace736 vs 9ae5eeea9b, the one-pass
`getAccountInfo` rewrite): web (265 JS files) and the desktop renderer (218) code-identical, only
`dist/threads/coinjoin-backend.js` different (+177 bytes) — while the web builds differed byte for
byte in 10–65 files depending on the pair of builds. The comparison takes under a second (byte-equal
files skip the masks) and is cached in run.json by both sides' commits, profiles and build times;
`node <skill>/rig/bundlediff.mjs --run=<id>` runs it again, `bundlediff.mjs <dirA> <dirB>` compares
two build dirs by hand.

`build.mjs` writes run.json as a **merge**: it reads the file again right before writing and changes
only what the build owns (the sides' `sha, buildSha, profile, clone, web, desktop, fingerprint,
guide`, `build.profile`, `bundles`), so the title, scenario, cfg or device edited while it builds
survive (both earlier runs lost such edits to template placeholders). A side re-pinned meanwhile
keeps its new revision and gets no record of the old build: build again.

## React Compiler coverage, per side

`packages/suite` is not compiled on develop today, but compiler rollouts are the A/Bs most likely to
come (PR #32496 compiles `suite-common` and `packages/suite/src/{views,components,hooks}`), so
whether a side is compiled is measured, never assumed:

- The compiler emits `Symbol.for("react.memo_cache_sentinel")` once per memo block; React defines it
  once itself (`react-dom-client`). `fingerprint.mjs` counts the occurrences and maps each through the
  chunk's source map to its source file, then groups the files by area (`suite-common/<package>`,
  `packages/suite/src/<dir>`, `packages/<package>`).
- Next to it, the paths the revision configures: `REACT_COMPILER_PATHS` in
  `packages/suite/webpack/reactCompiler.ts` (absent = not wired up), with configured paths under
  which nothing was compiled (the rollout's silent failure mode) and compiled files outside them.
- In the page, `env.build.sentinelModules` counts the loaded modules that carry compiler output.

Measured on 2026-10-13, web: develop at `85b057a8d8` — not compiled (one sentinel, React's own), not
configured. PR #32496 merged into it (`df6fc9b8f1`) — 2,098 memo blocks in 797 files:
`packages/suite/src/components` 436 files, `views` 322, `hooks` 28, and 11 files across
`suite-common/*` (the rest of `suite-common` holds no components); every configured path matched,
nothing compiled outside them. At the dashboard of a settings-only seed, 48 of 2,288 loaded modules
carried compiler output on B, 1 (React's) on A. Fingerprinting both builds took 1.6 s.

Read memoization findings per side with it (`references/house-rules.md`), and expect a compiler
rollout to show in the counting pass (`fibersRendered` down where subtrees bail out).

## Parallel runs

Several runs can share the machine — several agents, several PRs, web and desktop of one PR:

| Shared | Guarded by | So |
| --- | --- | --- |
| the CPU, for measuring | the **machine slot** (`$PERF_AB_HOME/locks/machine`): every page session, any role, and every yarn step of a build | one at a time per machine, first come first served; sessions of several plans interleave, a build step slots in between two sessions; a session waiting shows stage `queued` (status, plan heartbeat), and its wait is left out of the ETA's overhead |
| a clone | `locks/clone-<name>` while building it; `<clone>/.perf-ab-users/` while a session or exploration serves it | a run needing the same commit waits, then finds it built; `--rebuild` and `cleanup.mjs` refuse a clone in use |
| the emulator (trezor-user-env) | `locks/emulator`, taken before the machine slot | sessions take turns; an exploration holds it while open; `tenv.mjs down/prepare` refuse while someone else holds it |
| CDP port 9222 | `open.mjs` takes the first free port from 9222 | a second exploration gets 9223… (the MCPs as configured attach to 9222 only) |
| run state | one folder per run; desktop profiles `apps/<run>-<side>`, web exploration profiles `profiles/<run>-web-<side>`, `<run>/open-<side>.json` | nothing per-run is shared |

A lock is a queue of ticket files; a ticket whose process died or froze (no heartbeat for 3 min) is
dropped by whoever finds it, so a killed run never wedges the others. `status.mjs` shows who has the
machine and who waits; `cleanup.mjs` lists the queues.

Not guarded: an exploration session (`open.mjs`) or anything else on the machine. The
performance-core gate sees their CPU as contention and waits or discards (`references/rig.md`), but
memory bandwidth and shared caches are invisible to it — keep the machine quiet during timing.
`--slot=off` (run.mjs, plan.mjs, build.mjs) or `PERF_AB_SLOT=off` skips the slot, for experiments
whose numbers are not compared with anything.

Disk is the other shared limit: every pinned commit × profile is a clone of ~1-2 GiB of real blocks
once built. `preflight.mjs` checks free space; `cleanup.mjs --clones --older-than=3` frees it.

**Shared clones.** Runs on one base share its clone (the second run's base builds in 0 s). So
`cleanup.mjs` keeps, with a warning, any clone whose commit is a side in another run's run.json than
the one you are done with (`--run=<id>`; without it, a clone pinned by two or more runs, built or
only pinned) or is the tip of a local branch of the main checkout that other local branches are
based on; `--force` removes it anyway. A clone only one run uses goes as before. Seen without the
guard: the base clone (04caace736) was removed after the coinjoin run and rebuilt (~2.5 min) for
PR 33507's run on the same base.

Several runs in one conversation: start each in its own session (SKILL.md step 0) — a run re-reads
everything earlier in its conversation on every model call.

## Build-config changes considered

Owning the build makes the build itself a lever. What was weighed:

| Change | Gives | Verdict |
| --- | --- | --- |
| `IS_CODESIGN_BUILD=true` (the `release` profile) | the build users run; no redux-logger cost per dispatch or retained states | **adopted, the default** |
| CI's prep steps (message system, app assets, transport bridge) | builds that do not depend on when the clone was made | **adopted** |
| Shared yarn cache for packages newer than the checkout | the second side and later runs install offline | **adopted** |
| React's profiling build (`react-dom` → `react-dom/profiling`): `actualDuration` per fiber, per commit | per-component render time in counting passes — the question a compiler rollout asks | not built yet: it needs a webpack config wrapped per revision (the app's config is TypeScript loaded through ts-node, so a wrapper has to live in the clone) and adds a timer per rendered fiber, so it can only be a third, non-timing profile with its own clones. `attr.mjs` (CPU profile through source maps) already says which files the time went to. Worth adding when a rollout needs per-component cost |
| Terser `keep_fnames` / `keep_classnames` | readable component names in fiber walks and profiles | rejected for timing builds (changes the bundle that is parsed and run); source maps already give names to `attr.mjs`. Would ride along with a profiling profile |
| Exporting thunks on desktop (`concatenateModules: false`, or an injected entry module) | desktop scenarios could dispatch `@router/goto` or `fetchAllTransactionsForAccount` like web | rejected: changes code shape and chunking on both sides — scenarios drive the desktop UI instead (`examples/account-switch`) |
| Switching Sentry or analytics off at build time | less background work | rejected: part of what users run; the rig answers them locally instead |
| Building the sides in parallel | about a minute per run | rejected: heavy build steps hold the machine slot anyway, so parallel runs keep their timing clean |

Session overhead (launch, seed, a 10 s idle window and a calibration loop per CPU rate) is ~25-30 s a
session and does not depend on the build; `--idle-ms` is the knob.

## suite-native later

A target is an entry in `build.mjs`'s `TARGET` table — its prep, its yarn steps, its output and
check — plus a bundle part in `fingerprint.mjs` (`partsOf`) and a launcher in `launch.mjs`. For
suite-native the JS bundle is Hermes bytecode (strings live in its string table, so the sentinel
count works on bytes) and the commit is in the Expo config (`extra.commitHash`, read by
`envUtils.native.ts`), not in the bundle text.
