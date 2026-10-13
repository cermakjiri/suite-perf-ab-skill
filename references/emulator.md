# Real device and real data: trezor-user-env

`"device": "emulator"` makes every session use a Trezor emulator through the bridge, Suite's real
connect → authorize → discovery flow, and (with `"network": "live"`) the production backends. Use
it when the change is in device communication, discovery, account loading with real history, or
when synthetic state cannot reproduce the workload. It is slower (discovery per session) and
noisier (backend latency): compare CPU (`taskMs`), counts and INP rather than wall times.
Verified 2026-10-13 on web and desktop with the `all all … all` seed: Suite acquired the emulated
T3T1 (firmware 2.12.5), discovery completed in 5-8 s with 20 BTC accounts and real history.

## Setup (outside the sandbox)

```bash
open -a Docker                                   # Docker Desktop, if it is not running
node <skill>/rig/tenv.mjs up                     # container perf-ab-tenv, ports published one by one
node <skill>/rig/tenv.mjs status                 # what answers: controller 9001, dashboard 9002, MCP 9003, bridge 21328
node <skill>/rig/tenv.mjs up --regtest           # + regtest blockbook on 19121 (network: none + regtest coins)
node <skill>/rig/tenv.mjs down                   # remove the containers when done
```

- The repo's compose files use `network_mode: host`, which Docker Desktop on macOS does not have;
  `tenv.mjs` publishes 9001, 9002, 9003, 21328, 19121, 19021, 18021.
- Image: the tag `docker/docker-compose.suite-ci-e2e.yml` pins. It is ~5.5 GB and never pulled
  implicitly: when it is missing, `up` uses the newest local `trezor-user-env` image and says so, and
  with no local image it stops (`--pull` fetches the pinned one; `TENV_IMAGE=` overrides). Both
  sides share one emulator, so its version is not part of the comparison.
- Docker Desktop answers `docker info` before its engine works (`docker ps` returns HTTP 500 for a
  while); `up` waits for `docker ps`, because an empty image list from a half-started engine would
  otherwise read as "nothing pulled".
- Another tenv already serving 9001/21328 (the QA harness's `qa-trezor-user-env`, a manual one)
  is reused, not duplicated.
- Docker publishes ports before the container serves them: "port open" proves nothing. The
  controller client retries the WebSocket handshake itself.

## Per session

`run.mjs` calls `tenv.prepare(run.emulator)` before launching: bridge stop → emulator stop →
`emulator-start { model, version, wipe: true }` → `emulator-setup { mnemonic, pin: '',
passphrase_protection, label, needs_backup: false }` → `bridge-start { version: 'node-bridge' }` →
bridge `/status/` with the run's origin. Every session starts from the same device state. Defaults:
`{ "model": "T3T1", "fw": "2-latest", "mnemonic": "mnemonic_all" }` (`mnemonic_12` or literal words
work too; `fw` takes `1-latest` for T1B1).

Web origin: the build is served at `http://suite.localhost/`; the bridge accepts hostnames ending in
`localhost` (and `sldev.cz`, `trezor.io`) — never `127.0.0.1` as an origin. With `network: live`
nothing is host-mapped; analytics and Sentry are still answered locally.

## The scenario side (examples/emulator-accounts)

- Seed settings only: `@storage/load` with `flags.initialRun: false`, analytics answered,
  `walletSettings.enabledNetworks` — devices, accounts and transactions come from the device and
  the backend.
- Turn the device checks off right after the seed: `suiteSettings/toggleFirmwareHashCheck`,
  `…/toggleFirmwareRevisionCheck`, `…/toggleDeviceAuthenticityCheck` with `payload: false`.
  Production builds otherwise block an emulator on the authenticity check (debug keys).
- Ready = Suite ready, `selectedDevice` connected + acquired + `state` set, and discovery done:
  `wallet.discovery` is a map keyed by device whose entries reach `status: 'complete'`.
- Real data varies per account (47 vs 2 transactions on the `all` seed): reopen the same account
  for a stable workload, or cycle with the same order on both sides.

## Traps

- **Never poll the emulator screen during a device prompt** (`emulator-get-screen-content`, the MCP's
  screenshot): it broke a signing session in the QA harness. Wait on
  `selectedDevice.buttonRequests` in the store instead, and press with `tenv.mjs yes`.
- One emulator serves the whole machine. A session takes the `emulator` lock before the machine
  slot (`references/builds.md`), so emulator runs of several agents take turns, and `open.mjs` holds
  it while an exploration is open. `tenv.mjs down` and `tenv.mjs prepare` refuse while someone else
  holds it (`--force` overrides).
- After `bridge-stop`, web Connect falls back to WebUSB until a reload: restart the session instead.
- Live backends: wall times include network latency and its variance; a backend hiccup shows as
  one slow session. More sessions, CPU metrics, and say so in the caveats.
- Real data is not byte-identical over time (new transactions on a public seed). Run both sides in
  one plan, interleaved (ABBA), never against numbers from another day.

## The trezor-emulator MCP

The container also serves an MCP over SSE on `:9003` (registered here as `trezor-emulator`,
`http://127.0.0.1:9003/sse`): screenshots of the emulator screen, press yes/no, swipe — for driving
device prompts interactively while exploring with `open.mjs`. The Claude session connects to it
only at start; when the session started before `tenv.mjs up`, the server shows as failed and must
be reconnected from `/mcp` (a user-config server; the agent cannot re-dial it). For runs it is not
needed: `run.mjs` talks to the controller (`:9001`) directly.

## A physical Trezor

Not automatable (PIN, confirmations), but possible for a manual exploration: stop tenv (one process
owns 21328), run the repo's bridge on the USB device (`node packages/transport-bridge/dist/bin.js`,
build it with `yarn workspace @trezor/transport-bridge build:lib`), and use `open.mjs` on a run
with `"device": "emulator", "emulator": { "prepare": false }` — the rig then uses whatever device is
on the bridge instead of wiping and seeding an emulator. Timing passes stay with the emulator.
