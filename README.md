# suite-perf-ab

> **Status: alpha.** Shared for early testing. Expect rough edges, and please report what breaks.

An [Agent Skill](https://agentskills.io) that measures **Trezor Suite web** runtime performance on a
branch or PR against `develop`, by driving both preview builds in a real Chrome through the
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) server.

It is tool-agnostic: the same folder works in **Claude Code** and in **GitHub Copilot**
(CLI, VS Code agent mode, coding agent, code review).

## What it does

- Reads the diff and works out which UI surfaces are actually affected, instead of trusting the PR
  description.
- Seeds both branches into an **identical synthetic wallet state** from the page itself — no device,
  emulator, Docker or backend needed.
- Replays each scenario **≥12 kept iterations** per branch, at **1x and 4x CPU throttling**, and
  reports **p75** with the spread.
- Covers the whole SPA picture: React render volume, main-thread blocking, style and layout, paint
  and dropped frames, memory growth across repeated navigation, and cold boot.
- Reports deltas **in both directions**, plus an explicit caveats section. A report that only
  confirms the PR's claim has not been checked.

## What it will not do

Write the optimization or fix the slow code, profile suite-native or the Electron desktop shell,
time builds/CI/jest, compare bundle sizes, or summarize what a branch changed.

## Requirements

| | |
| --- | --- |
| A `trezor-suite` checkout | the skill reads the diff with `git` and cites the repo's own `skills/performance-*` rules |
| Google Chrome | the MCP server launches its own instance |
| Node.js ≥ 18 | the three analysis scripts are zero-dependency CommonJS (`fs`, `path`, `zlib`) |
| Network access to `dev.suite.sldev.cz` | it compares deployed preview builds, not local dev builds |
| Chrome DevTools MCP connected | see [step 2](#2-connect-the-chrome-devtools-mcp-server-required) — nothing works without it |

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

## 2. Connect the Chrome DevTools MCP server (required)

The skill drives the browser entirely through this server. Without it, it cannot run at all.

### Claude Code

```bash
claude mcp add chrome-devtools -s user -- npx chrome-devtools-mcp@latest
```

Confirm with `/mcp` — you want `chrome-devtools` listed as connected.

### Copilot CLI

```bash
copilot mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
```

Equivalent hand edit of `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "local",
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

### VS Code (Copilot agent mode)

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"]
    }
  }
}
```

Click **Start** above the server entry, and make sure Chat is in **Agent** mode.

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

Both the branch and `develop` need a preview deployment at
`https://dev.suite.sldev.cz/suite-web/<branch-name>/web/` — the skill checks this first, and a
missing preview is the most common way a run stalls.

Expect a **long, mostly unattended run**: every scenario is replayed at least 12 times per branch
per throttling level, and traces are recorded for each.

### What you get

A report with a scenario per suspected problem class, p75 per metric with min/p50/max so you can see
the spread, wins and regressions both listed, the fix cited from the repo's own performance skills
where one applies, and a caveats section stating what was synthetic and what the measurement could
not see.

---

## Repo layout

| Path | What it is |
| --- | --- |
| `SKILL.md` | the skill itself — the 8-phase measurement protocol |
| `references/problem-classes.md` | the six ways an SPA regresses, and which scenario exposes each |
| `references/house-rules.md` | maps findings onto Trezor Suite's own performance rules |
| `references/seeding.md` | driving the app into a realistic state without a device |
| `references/pitfalls.md` | read this whenever a number looks wrong |
| `assets/harness-core.js` | in-page measurement primitives + the adapter contract |
| `assets/adapters/suite-web.js` | Suite-web selectors, state seeding and scenarios |
| `assets/harness.js` | the bundle injected into the page |
| `scripts/p75.js` | percentiles over in-page iteration records |
| `scripts/iter-report.js` | slices a trace into the marked per-iteration windows |
| `scripts/analyze-trace.js` | full DevTools category breakdown of a trace (`--aggregate`, `--compare`) |

## Update

```bash
git -C ~/.claude/skills/suite-perf-ab pull
```

(Use whichever path you installed to.) Uninstall by deleting that folder.

## Alpha notes

- Only Suite **web** is supported. `assets/adapters/suite-web.js` is the single adapter; another
  surface means writing another one (the contract is documented at the top of `harness-core.js`).
- It compares **deployed preview builds**. Local dev builds have different performance
  characteristics and are not comparable against a deployed one.
- Chrome only.
- Found something wrong, or a scenario it should cover?
  [Open an issue](https://github.com/cermakjiri/suite-perf-ab-skill/issues).
