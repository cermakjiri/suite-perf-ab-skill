/**
 * <scenario name> — in-page part, installed as an init script after rig/page/core.js.
 *
 * window.__H (core): CFG, RUN, store(), state(), dispatch(), connect() (TrezorConnect as the app
 * calls it), findThunk(typePrefix) (any RTK thunk from the production bundle), findModules(needle),
 * goto(routeName, params), suiteReady(), waitFor(fn, opts), settle(ms), sleep(ms), nextFrame(),
 * injectCost() (call once per unit of work: the rig control), probes.stats(from, to).
 *
 * Contract (all optional except phases):
 *   ready()            app booted far enough to seed (default: the store exists)
 *   seed()             store-level state before Suite finishes init; return a small summary
 *   isReady()          Suite is usable (default: __H.suiteReady())
 *   postInit()         mocks, thunks, probe connections; return a summary
 *   before(it)         per iteration, not measured;  it = { i, n, rate } (n counts the whole session)
 *   phases[name](it)   measured; resolve when the user-visible work is done; return extra numbers
 *   after(it)          per iteration, not measured: reset state, verify, return checks
 *   reset(it)          after an attempt the performance-core watchdog discarded: bring the app back
 *                      to where every iteration starts (default: after(it), then the scenario's
 *                      route); return false if it cannot. The runner then checks the route and
 *                      that Suite is ready, and stops the session rather than measure a mis-start
 *   verify()           state summary recorded in env and at the end of the session
 *
 * A retried iteration takes fresh data, the next it.n: seed H.RUN.iterations + H.RUN.spares + 1
 * targets when iterations index them by it.n (RUN.spares is a constant, the session's discard budget).
 */
(() => {
    const H = window.__H;
    const CFG = H.CFG;

    window.__A = {
        name: 'my-scenario',

        async seed() {
            // H.dispatch({ type: '@storage/load', payload: ... });  — see examples/history-load/page.js
            return null;
        },

        async postInit() {
            return null;
        },

        phases: {
            async act(it) {
                // one dispatch, not many: Suite renders synchronously per dispatch
                // await H.waitFor(() => document.querySelector('[data-testid="..."]'), { label: 'rendered' });
                await H.settle(0);

                return { ok: true };
            },
        },

        async after(it) {
            return null;
        },

        verify() {
            const s = H.state();

            return { route: s.router && s.router.route && s.router.route.name, size: CFG.size };
        },
    };
})();
