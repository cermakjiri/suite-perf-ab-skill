/**
 * desktop-ipc-backend — Node part (the in-page part is page.js). A template for a change in code that
 * Suite desktop runs outside the renderer, behind the preload's window.ipcProxy: an Electron utility
 * process that main's ThreadProxy forks (CoinjoinBackend), or main itself (CoinjoinClient,
 * TrezorConnect, Bluetooth: the other createIpcProxy channels). Worked instance:
 * CoinjoinBackend.getAccountInfo (packages/coinjoin), run coinjoin-address-stats (2026-10-16):
 * 136 → 40.6 ms at 4x, 110 → 18.3 ms at 1x, 1,476 → 145 ms at size M, the AccountInfo hash equal
 * on both sides at every it.n.
 *
 * When: the diff changes code that never runs on the renderer's main thread (references/desktop.md,
 * "Code outside the renderer", says how to tell), so the renderer metrics cannot see it, and on web it
 * may not run at all (coinjoin throws outside desktop). Target desktop only. Code that no IPC call
 * reaches gets a Node function-level A/B instead (rig/fnbench.mjs).
 *
 * Adapt: page.js's ADAPT block — CHANNEL, METHOD, DISPOSE and SETTINGS from the app code that drives
 * the backend, args(n) as a pure function of it.n, prepare() for what the app caches and passes back,
 * describe() for the result fields to keep. Rename `call` to the method only if you also rename the
 * keys below.
 *
 * Reading it:
 * - CDP CPU throttling slows only the renderer's main thread. The utility process runs at full speed
 *   at every rate, so its share of `call.ms` reads the same at 4x and 1x, and the rate scales only
 *   the renderer's share: the structured-clone copies (`call.taskMs`), equal on both sides unless the
 *   payloads changed (postInit's argKiB, after's resultKiB).
 * - When one side's call window is many times shorter, its frame and lag p95 jump: the same single
 *   copy block becomes the p95 of a window with few frames. Compare frameMax / lagMax, CPU and long
 *   tasks, never percentiles over windows of different length.
 * - Same output: `after.hash` (FNV-1a over the result's canonical JSON) must be equal on both sides at
 *   every it.n — node <skill>/examples/desktop-ipc-backend/hashes.mjs --run=<id>.
 * - Cold or warm: by default every call is the first into a fresh process. A backend the app keeps
 *   alive (CoinjoinService keeps one per network) is mostly called warm: plan pass `warm`
 *   (--cfg.warm=1) times call 2 of a process, its spawn done untimed in before().
 */
export default {
    name: 'desktop-ipc-backend',
    description: 'Spawn a desktop backend over IPC and time one call into it: CoinjoinBackend.getAccountInfo for a synthetic coinjoin account, as fetchAndUpdateAccountThunk calls it after a scan.',
    page: 'page.js',
    cfg: { size: 'S', warm: 0 },
    phases: ['spawn', 'call'],
    k: 8,
    rates: [4, 1],
    warmup: 2,
    route: 'suite-index',
    // the change itself makes one side's call window several times shorter: subtract the session's
    // idle CPU rate × window length from the renderer CPU (call.taskCorrMs), leaving the IPC copies
    idleCorrect: ['call'],
    headline: [
        { key: 'call.ms', label: 'Backend call round trip, wall', unit: 'ms', dir: 'lower' },
        { key: 'call.taskCorrMs', label: 'Renderer CPU during the call (IPC copies, idle-corrected)', unit: 'ms', dir: 'lower' },
        { key: 'spawn.ms', label: 'Backend process spawn, wall', unit: 'ms', dir: 'lower' },
    ],
    valid: rec => {
        const p = rec.phases || {};
        if (!p.spawn || p.spawn.ok === false) return 'spawn did not complete';
        if (!p.call || p.call.ok === false) return 'the call returned no result';
        if (!rec.after || !rec.after.hash) return 'no result hash';

        return true;
    },
    line: rec => {
        const a = rec.after || {};

        return a.hash ? `hash ${a.hash} · result ${a.resultKiB} KiB` : '';
    },
};
