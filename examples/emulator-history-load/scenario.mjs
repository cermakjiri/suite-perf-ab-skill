/**
 * emulator-history-load — Node part (page.js is the in-page part). Needs run.json
 * `"device": "emulator", "network": "live"` and trezor-user-env up (node rig/tenv.mjs up); run.mjs
 * wipes and seeds the emulator before every session. Web only: the scenario dispatches the real
 * fetchAllTransactionsForAccountThunk from the bundle, and desktop bundles do not export it.
 *
 * The real-data counterpart of examples/history-load: real discovery, real pages and fiat rates
 * from the live backends, in the order and at the latency they arrive. One measured load per session
 * (k 1, warm-up 0), so the session count is the sample size: plan.json runs 4 v 4 per CPU rate.
 * Wall times carry network latency; compare CPU (taskMs), long tasks and the counts. The workload is
 * whatever history the seed's accounts have (the `all` seed's BTC accounts: tens of transactions);
 * cfg.networks and cfg.maxTxs choose it, and postInit reports every account's history size.
 */
export default {
    name: 'emulator-history-load',
    description: 'Real device, real data: full transaction-history load of the emulator wallet account with the most history through the real fetchAllTransactionsForAccountThunk and live backends, then IndexedDB catching up (txs rows and the historicRates row).',
    page: 'page.js',
    cfg: { networks: ['btc'], maxTxs: 1000, remember: true, countIdb: false },
    phases: ['load', 'drain'],
    k: 1,
    rates: [4],
    warmup: 0,
    route: 'suite-index',
    idleCorrect: ['drain'],
    headline: [
        { key: 'load.taskMs', label: 'Main-thread CPU while loading', unit: 'ms', dir: 'lower' },
        { key: 'load.longestTaskMs', label: 'Longest task while loading', unit: 'ms', dir: 'lower' },
        { key: 'load.longTaskMs', label: 'Long-task time while loading', unit: 'ms', dir: 'lower' },
        { key: 'load.ms', label: 'History load, wall (incl. backend)', unit: 'ms', dir: 'lower' },
        { key: 'drain.persistMs', label: 'Txs rows persisted after load', unit: 'ms', dir: 'lower' },
        { key: 'drain.ratesMs', label: 'Rates row complete after load', unit: 'ms', dir: 'lower' },
        { key: 'drain.taskCorrMs', label: 'CPU while persisting (idle-corrected)', unit: 'ms', dir: 'lower' },
        { key: 'total.taskMs', label: 'Main-thread CPU, whole window', unit: 'ms', dir: 'lower' },
    ],
    check: env => (env.verify && env.verify.connected ? null : 'the emulator is not connected — node rig/tenv.mjs status'),
    valid(rec) {
        const load = rec.phases.load || {};
        const drain = rec.phases.drain || {};
        if (load.loadError) return `load error: ${load.loadError}`;
        if (load.firstLoad !== 1) return 'not a first load: the account was fully loaded already (a retried iteration?)';
        if (!drain.persisted) return `persisted ${drain.rows}/${drain.expected}`;

        return true;
    },
    line: rec => {
        const l = rec.phases.load || {};
        const d = rec.phases.drain || {};

        return `txs ${l.txsBefore}→${l.txs}/${l.historyTotal} rows ${d.rows}/${d.expected} rates ${d.ratePoints}/${d.expectedRates} persist ${d.persistMs} rates@${d.ratesMs}`;
    },
};
