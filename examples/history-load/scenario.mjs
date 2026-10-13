/**
 * history-load — Node part (see page.js for the in-page part). Worked example: PR #33320.
 * Web only: the scenario dispatches the real thunk from the bundle, and desktop bundles do not
 * export it. plan.json next to this file is a plan for it in the core-checks order (counts, pilot,
 * h20 as the main pass, ctl, then the second size and the negative control; `more` optional).
 * Counting pass: --cfg.countIdb=true (patches IDB prototypes, never time with it on).
 * Negative control: --cfg.remember=false (nothing persists, both sides must read the same).
 */
export default {
    name: 'history-load',
    description: 'Full transaction-history load of a remembered BTC account: the real fetchAllTransactionsForAccountThunk paging through a mocked backend, then IndexedDB catching up.',
    page: 'page.js',
    cfg: { pages: 20, latency: 100, rateLatency: 40, remember: true, countIdb: false },
    phases: ['load', 'drain'],
    k: 8,
    rates: [1, 4],
    warmup: 2,
    route: 'suite-index',
    // phases whose CPU totals scale with window length (one side drains for minutes): aggregate
    // subtracts the session's idle CPU rate x window length as <phase>.taskCorrMs
    idleCorrect: ['drain'],
    headline: [
        { key: 'load.ms', label: 'History load, wall', unit: 'ms', dir: 'lower' },
        { key: 'load.taskMs', label: 'Main-thread CPU while loading', unit: 'ms', dir: 'lower' },
        { key: 'load.longTaskMs', label: 'Long-task time while loading', unit: 'ms', dir: 'lower' },
        { key: 'load.lagP99', label: 'Input-delay proxy p99 while loading', unit: 'ms', dir: 'lower' },
        { key: 'drain.persistMs', label: 'Persisted after load', unit: 'ms', dir: 'lower' },
        { key: 'drain.taskCorrMs', label: 'CPU while persisting (idle-corrected)', unit: 'ms', dir: 'lower' },
        { key: 'total.taskMs', label: 'Main-thread CPU, whole window', unit: 'ms', dir: 'lower' },
    ],
    valid(rec) {
        const load = rec.phases.load || {};
        const drain = rec.phases.drain || {};
        if (load.loadError) return `load error: ${load.loadError}`;
        if (!drain.persisted) return `persisted ${drain.rows}/${drain.expected}`;
        if (rec.after && rec.after.resurrected) return 'rows written back after reset';

        return true;
    },
    line: rec => {
        const d = rec.phases.drain || {};

        return `rows ${d.rows}/${d.expected} pages ${(rec.phases.load || {}).pages} persist ${d.persistMs}`;
    },
};
