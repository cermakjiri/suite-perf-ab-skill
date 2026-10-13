/**
 * account-switch — Node part: a cross-platform worked example (web and desktop) of phases driven
 * from Node with trusted input. Each iteration clicks a different account in the menu (account
 * n % accounts, so consecutive iterations never reopen the same one) and waits for its
 * transaction list, then clicks the dashboard. Trusted clicks make Event Timing (inpMs) valid.
 *
 *   sizes: --cfg.txs=50 vs --cfg.txs=500 (does opening an account scale with its history?)
 */
const accountOf = (it, cfg) => it.n % (cfg.accounts || 6);

export default {
    name: 'account-switch',
    description: 'Open an account from the account menu until its transaction list is on screen, then go back to the dashboard (trusted clicks).',
    page: 'page.js',
    cfg: { accounts: 6, txs: 200 },
    k: 10,
    rates: [4, 1],
    warmup: 2,
    route: 'suite-index',
    phases: [
        {
            name: 'open',
            node: async ({ page, ev, it, cfg }) => {
                const index = accountOf(it, cfg);
                await page.click(`[data-testid="@account-menu/btc/normal/${index}"]`);

                return ev(i => window.__A.accountShown(i), index);
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
        { key: 'open.ms', label: 'Open account until its list is on screen', unit: 'ms', dir: 'lower' },
        { key: 'open.taskMs', label: 'Main-thread CPU, open', unit: 'ms', dir: 'lower' },
        { key: 'open.commits', label: 'React commits, open', unit: 'n', dir: 'lower' },
        { key: 'open.inpMs', label: 'INP of the click, open', unit: 'ms', dir: 'lower' },
        { key: 'back.ms', label: 'Back to dashboard', unit: 'ms', dir: 'lower' },
        { key: 'back.taskMs', label: 'Main-thread CPU, back', unit: 'ms', dir: 'lower' },
    ],
    valid: rec => (rec.phases.open && rec.phases.open.rows > 0 ? true : 'transaction list did not render'),
    line: rec => `rows ${rec.phases.open && rec.phases.open.rows} inp ${rec.phases.open && rec.phases.open.inpMs}`,
};
