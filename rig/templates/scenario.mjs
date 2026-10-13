/**
 * <scenario name> — Node part. Copy rig/templates/{scenario.mjs,page.js} to <run>/scenario/ and
 * fill them in; everything else (launch, seeding order, throttling, probes, CDP thread time,
 * sessions, statistics, report) is the rig's. Worked example: examples/history-load/.
 */
export default {
    name: 'my-scenario',
    description: '<one sentence: what one iteration does, from the user\'s point of view>',
    page: 'page.js',
    // scenario knobs, readable in the page as H.CFG; override per pass with "cfg" in plan.json or --cfg.<key>=<value>
    cfg: { size: 60 },
    // measured phases, in order; CDP thread time is read at every boundary. A phase is either a
    // name implemented in page.js (window.__A.phases[name]) or { name, node: async ctx => ({...}) }
    // driven from Node with trusted input: ctx = { page, cdp, context, it, cfg, side, target, ev }
    phases: ['act'],
    k: 8,
    rates: [4, 1],
    warmup: 2,
    // Suite route to open after postInit (routeName from @suite/router-config), or { name, params };
    // also where every iteration starts: after a discarded attempt the runner restores it (page.js
    // reset(), else after() and this route) and checks it before retrying
    route: 'suite-index',
    // phases whose window length differs a lot between sides: also report task time minus idle CPU
    idleCorrect: [],
    // what the report leads with; dir: lower | higher | none
    headline: [
        { key: 'act.ms', label: 'Interaction, wall', unit: 'ms', dir: 'lower' },
        { key: 'act.taskMs', label: 'Main-thread CPU', unit: 'ms', dir: 'lower' },
        { key: 'act.commits', label: 'React commits', unit: 'n', dir: 'lower' },
    ],
    // per-iteration validity: true, or a string saying what went wrong (the iteration is dropped)
    valid: rec => (rec.phases.act && rec.phases.act.ok === false ? 'act did not complete' : true),
    // optional: extra text on the progress line of every iteration
    line: rec => '',
    // optional: env + session checks before measuring; return a string to abort the session
    check: env => null,
};
