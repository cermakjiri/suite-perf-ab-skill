# suite-perf-ab

> **Status: alpha.** Shared for early testing. Expect rough edges, and please report what breaks.

An [Agent Skill](https://agentskills.io) that measures **Trezor Suite** runtime performance — web
and the Electron desktop app — on a branch or PR against its target branch (`develop`), with a
reusable Playwright rig.
Each run writes only its scenario; building, launching, seeding, throttling, statistics and the
report are shared.

It is tool-agnostic: the same folder works in **Claude Code** and in **GitHub Copilot**
(CLI, VS Code agent mode, coding agent, code review).

## What it does

- Reads the diff and works out which UI surfaces and problem classes are affected, instead of
  trusting the PR description.
- Checks the branch is up to date with its target branch first, and advises a rebase when it is
  not (a result against a moved base can be inconclusive).
- Builds both revisions locally (the target's tip and the PR head) with CI's recipe as **release**
  builds (`IS_CODESIGN_BUILD=true`: what users install — no redux-logger) in copy-on-write clones,
  cached by commit and profile.
- Proves which build each session ran from the commit every bundle inlines — no marker to choose —
  and records **React Compiler coverage** per side (memo blocks per source area, from the source
  maps).
- Seeds both sides into an **identical wallet state**: synthetic store state with a mocked backend
  (default), or a **trezor-user-env emulator** with Suite's real connect, discovery and live
  backends for real data.
- Replays the scenario in **page sessions alternated ABBA**, at **4x and 1x CPU**, reading
  main-thread CPU per phase over CDP (thread ticks) next to long tasks, frames, input delay, INP,
  React commits and memory.
- Treats the **session as the unit**: a timing difference is called only when the sessions
  separate (permutation p), with a paired injected-cost control proving the metric can move.
- On Apple silicon, starts every measured iteration on a **performance core**: it waits for free
  performance cores and a renderer at full clock, and discards and retries an iteration whose main
  thread another program's load or a demotion pushes onto efficiency cores, so a busy machine
  mostly costs waiting (contention under ~100 ms goes unseen: quieter is still cleaner). macOS's
  own placement of light work on efficiency cores is kept and reported per side.
- Writes a self-contained HTML report — regressions first, both directions, attribution, caveats.
- Lets several runs share one machine: measured sessions and heavy build steps take turns, one at a
  time across all runs; clones, the emulator and the CDP port are guarded.
- Optional: keeps one side open on CDP :9222 for the **Playwright MCP** and the
  **chrome-devtools(-electron) MCP** to explore, trace and heap-snapshot (never to time). A Suite
  that answers the MCP's `devtoolstooldiscovery` event lists its own automation tools there, and
  the rig uses the same tools from Playwright (`references/discovery.md`).

## What it will not do

Write the optimization or fix the slow code, profile suite-native, time builds/CI/jest, compare
bundle sizes (that is `suite-bundle-ab`), or summarize what a branch changed.

## Requirements

| | |
| --- | --- |
| A `trezor-suite` checkout with `node_modules` (`yarn`) | the rig takes `playwright-core`, Chromium and Electron from it and clones it per revision |
| macOS on APFS | revisions are built in `clonefile()` copy-on-write clones (~20 s, ~1-2 GiB each once built) |
| Node.js 24 (latest LTS), Python 3 | the rig is zero-dependency ES modules (`.mjs`) written for the latest Node LTS; builds use each revision's `.nvmrc` Node when nvm has it; `clone.py` uses ctypes |
| Playwright Chromium (`yarn playwright install chromium`) | web sessions run headless |
| clang (Xcode Command Line Tools) | builds the performance-core helper (`rig/native/pcore.c`) on first use; without it the gate is off |
| Docker Desktop | only for `device: emulator` (trezor-user-env) |
| `gh` and network access | `github.com` / `api.github.com` to pin a PR and its target branch; `registry.yarnpkg.com` when the target branch locks packages the checkout's yarn cache lacks |
| MCP servers (optional) | `playwright` / `chrome-devtools-electron` attached to `127.0.0.1:9222`, `trezor-emulator` on `:9003` — see `references/mcp.md` |

Runs and clones live in `$PERF_AB_HOME` (default `~/.local/share/suite-perf-ab`).

---

## 1. Install the skill

The repo **is** the skill folder, so installing is one `git clone` straight into a skills directory.

### Claude Code

Personal — available in every project:

```bash
git clone https://github.com/cermakjiri/suite-perf-ab-skill.git ~/.claude/skills/suite-perf-ab
```

Or project-only, from the root of your `trezor-suite` checkout (`.claude/` is gitignored there, so
this stays local to you):

```bash
git clone https://github.com/cermakjiri/suite-perf-ab-skill.git .claude/skills/suite-perf-ab
```

Start a new session, then check it is there by typing `/suite-perf-ab`.

### GitHub Copilot

Copilot discovers skills in `~/.copilot/skills` (personal) and in `.github/skills`, `.claude/skills`
or `.agents/skills` inside a repository — so **if you already did the Claude Code project install
above, Copilot picks it up automatically** and you can skip this.

Personal — Copilot CLI, every repo:

```bash
git clone https://github.com/cermakjiri/suite-perf-ab-skill.git ~/.copilot/skills/suite-perf-ab
```

Project — VS Code agent mode, coding agent, code review; run from your `trezor-suite` root:

```bash
git clone https://github.com/cermakjiri/suite-perf-ab-skill.git .github/skills/suite-perf-ab
```

⚠️ Unlike `.claude/`, `.github/` **is** tracked in `trezor-suite`. While this is alpha, keep it out
of your commits:

```bash
echo ".github/skills/suite-perf-ab/" >> .git/info/exclude
```

---

## 2. MCP servers (optional)

Measurement needs no MCP. For exploring a build, attach to the session `rig/open.mjs` keeps open on
CDP `127.0.0.1:9222`:

```bash
claude mcp add playwright -- <trezor-suite>/node_modules/.bin/playwright mcp --cdp-endpoint=http://127.0.0.1:9222
claude mcp add chrome-devtools-electron -- npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --categoryExperimentalThirdParty=true
claude mcp add --transport sse trezor-emulator http://127.0.0.1:9003/sse     # served by trezor-user-env
```

The DevTools MCP enables the V8 debugger on every page it attaches to (array spreads ~25x slower),
so numbers are never taken from an MCP-attached page. `--categoryExperimentalThirdParty=true` turns
on `list_3p_developer_tools` / `execute_3p_developer_tool`: the tools a page offers through the
`devtoolstooldiscovery` event (Suite-side plan: `plans/suite-devtools-discovery.md`).

---

## 3. Use it

Run your agent from the `trezor-suite` checkout. The skill triggers on intent — you do not have to
name it:

- `profile PR 12345 against develop`
- `did my branch perf/accounts-list make the accounts list slower?`
- `this PR claims a 30% faster dashboard — verify it before I approve`
- `check the transaction list for jank and memory leaks with a big wallet`

In Claude Code you can also invoke it explicitly:

```
/suite-perf-ab perf/accounts-list
```

The skill checks the PR is up to date with its target branch (and asks you about a rebase when it
is not), builds the target's tip and the PR head locally (no preview deployments needed), writes
the scenario, runs the core checks (counts and a short pilot), then the timing plan in the
background (~25 min for the default plan), drafts the report, and adds sessions only when they
could change a verdict. Desktop: ask for it ("…on desktop too"). Real device and data: ask for the
emulator ("…with a real wallet / with trezor-user-env").

To see where a run stands — stage, session, iteration, ETA and finish time — run this in your own
terminal:

```bash
node ~/.claude/skills/suite-perf-ab/rig/status.mjs --run=<id> --watch
```

### What you get

A report with verdict cards, one table per pass and CPU rate (session medians as dots, so you can
see whether the sessions separate), controls, build provenance and rig health per side, caveats,
and the method. The run folder keeps every session's raw JSON, so any number can be re-derived.

---

## Repo layout

| Path | What it is |
| --- | --- |
| `SKILL.md` | the workflow |
| `rig/` | the reusable rig: `revs` (pin the target and the branch, up-to-date check), `preflight`, `build`, `fingerprint` (commit, profile, React Compiler coverage of a build), `run` (one session), `plan` (ABBA, resumable, with heartbeats and an ETA), `status` (where a run stands, at once), `aggregate` (statistics and advice), `report`, `open` (MCP exploration), `tenv` (emulator), `attr` (profile attribution), `cleanup`, `locks` (parallel runs); `page/core.js` (in-page probes and helpers); `templates/` |
| `examples/` | worked scenarios: `history-load` (web, store seed + mocked backend + real thunk), `account-switch` (web + desktop, trusted clicks), `emulator-accounts` (real device and data) |
| `references/rig.md` | every script's flags, run.json / plan.json / scenario contract, outputs, metric names |
| `references/builds.md` | the pair and the rebase gate, the build recipe and profiles, the commit proof, React Compiler coverage, parallel runs, build-config changes weighed |
| `references/desktop.md`, `emulator.md`, `mcp.md`, `discovery.md` | the desktop target, trezor-user-env, exploring with the MCPs, the page-provided tool contract |
| `references/problem-classes.md`, `house-rules.md` | diff → suspects → scenarios; fixes cited from Suite's own rules |
| `references/seeding.md`, `pitfalls.md` | store seeding; every trap that produced a wrong answer once |
| `scripts/analyze-trace.mjs` | DevTools trace category breakdown (works on MCP traces) |
| `assets/`, `scripts/p75.mjs`, `scripts/iter-report.mjs` | the older DevTools-MCP-only harness |

## Update

```bash
git -C ~/.claude/skills/suite-perf-ab pull
```

(Use whichever path you installed to.) Uninstall by deleting that folder.

## Alpha notes

- macOS only (APFS clones, Electron's macOS paths); Chromium and Electron only.
- Desktop: one visible Electron window per session (no headless Electron); do not use the Mac
  during a desktop plan. Desktop bundles keep most Suite thunks module-internal, so desktop
  scenarios drive the UI (`examples/account-switch`).
- Emulator runs depend on live backends unless you use the regtest sidecar: compare CPU and counts,
  not wall times.
- Parallel runs share one machine by taking turns: two plans at once each take about twice as long,
  and their numbers stay clean. Every pinned commit × profile is a clone of ~1-2 GiB.
- Found something wrong, or a scenario it should cover?
  [Open an issue](https://github.com/cermakjiri/suite-perf-ab-skill/issues).
