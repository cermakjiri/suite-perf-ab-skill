/**
 * emulator-accounts — Node part. Needs run.json `"device": "emulator", "network": "live"` and
 * trezor-user-env up (node rig/tenv.mjs up); run.mjs wipes and seeds the emulator before every
 * session, so each session starts from the same device state. Wall times include live backend
 * latency (noisy); CPU (taskMs), commits and INP are what to compare. See references/emulator.md.
 */
export default {
    name: 'emulator-accounts',
    description: 'Real device, real data: discovery of the emulator wallet against live backends, then open accounts with history from the account menu (trusted clicks) and go back to the dashboard.',
    page: 'page.js',
    cfg: { networks: ['btc'], stableMs: 3000, cycle: false },
    k: 8,
    rates: [4, 1],
    warmup: 2,
    route: 'suite-index',
    phases: [
        {
            name: 'open',
            node: async ({ page, ev, it }) => {
                const p = await ev(n => window.__A.pick(n), it.n);
                await page.click(`[data-testid="${p.testid}"]`);

                return ev(x => window.__A.accountShown(x), p);
            },
        },
        {
            name: 'back',
            node: async ({ page, ev }) => {
                await page.click('[data-testid="@suite/menu/suite-index"]');

                return ev(() => window.__A.dashboardShown());
            },
        },
    ],
    headline: [
        { key: 'open.taskMs', label: 'Main-thread CPU, open account', unit: 'ms', dir: 'lower' },
        { key: 'open.commits', label: 'React commits, open account', unit: 'n', dir: 'lower' },
        { key: 'open.inpMs', label: 'INP of the click, open account', unit: 'ms', dir: 'lower' },
        { key: 'open.ms', label: 'Open account until its list is on screen (incl. backend)', unit: 'ms', dir: 'lower' },
        { key: 'back.taskMs', label: 'Main-thread CPU, back', unit: 'ms', dir: 'lower' },
    ],
    check: env => (env.verify && env.verify.connected ? null : 'the emulator is not connected — node rig/tenv.mjs status'),
    valid: rec => (rec.phases.open && rec.phases.open.rows > 0 ? true : 'transaction list did not render'),
    line: rec => `rows ${rec.phases.open && rec.phases.open.rows} inp ${rec.phases.open && rec.phases.open.inpMs}`,
};
