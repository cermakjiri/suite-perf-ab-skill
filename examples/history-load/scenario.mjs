/**
 * history-load — Node part (see page.js for the in-page part). Worked example: PR #33320, PR #33507.
 * Web and desktop: page.js runs the real thunk through the page's suite.thunk tool (desktop bundles
 * keep it module-internal), else the bundle's export; postInit records which path ran (out.post.thunk).
 * plan.json next to this file is a plan for it in the core-checks order (counts, pilot, h20 as the
 * main pass, ctl, then the second size and the persisted negative control; `more` optional).
 *
 * Persistence: cfg.remember defaults to false — nothing is written to IndexedDB, so the timing is
 * the load. With it on, the drain is most of every iteration and reads the same on both sides
 * unless the diff touches storage (PR 33507's 1,000-tx pass: ~11 s of a ~17 s iteration at 4x; a
 * 5,000-tx drain outlasted the 10-min phase timeout). Turn it on for every pass when the diff
 * touches storage or persistence (packages/suite/src/storage, the storage middleware, IndexedDB
 * code); otherwise keep one persisted pass as the negative control (its drain must read the same).
 * The product fix for the drain is Suite draft PR #33456 (write only the changed transaction rows):
 * this scenario with remember on is how to A/B it.
 * Counting pass: --cfg.countIdb=true with remember on (patches IDB prototypes, never time with it on).
 */
export default {
    name: 'history-load',
    description: 'Full transaction-history load of a BTC account: the real fetchAllTransactionsForAccountThunk paging through a mocked backend, then (remembered device) IndexedDB catching up.',
    page: 'page.js',
    cfg: { pages: 20, latency: 100, rateLatency: 40, remember: false, countIdb: false },
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
        if (rec.before && rec.before.historic) return `started with ${rec.before.historic} historic rates: the seed was not put back`;

        return true;
    },
    line: rec => {
        const d = rec.phases.drain || {};

        return `rows ${d.rows}/${d.expected} pages ${(rec.phases.load || {}).pages} persist ${d.persistMs}`;
    },
};
