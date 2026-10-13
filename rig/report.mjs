/**
 * Build a self-contained HTML report (inline CSS and SVG, Google Fonts only) from a run's
 * summary.json, its session files and an optional narrative.json written by the agent.
 *
 *   node report.mjs --run=<name|dir> [--narrative=<file>] [--out=<file.html>] [--main=<pass>]
 *
 * narrative.json (all optional): { "title", "pageTitle", "summary", "verdicts": [{ "label", "big",
 * "from", "why", "tone": "better|worse|tradeoff|flat" }], "findings": [html], "caveats": [html],
 * "sections": [{ "title", "html" }], "passLabels": { "<pass>": "label" }, "metricLabels": {} }
 * Without verdicts, cards are generated from the scenario's first four headline metrics in the
 * main pass: the first timing pass (lib.mjs passRole) or --main; with none, "no timing pass yet".
 * Publish the page with the Artifact tool (load the artifact-design skill first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { RIG, parseArgs, loadRun, resolveIn, readJson, exists, median, importScenario, CALL_P, called, controlVerdict, controlText, passRole, verdictMetrics, countKeys } from './lib.mjs';

const args = parseArgs();
const run = loadRun(args.run);
const S = readJson(path.join(run.dir, 'summary.json'));
const narrFile = args.narrative ? path.resolve(args.narrative) : path.join(run.dir, 'narrative.json');
const N = exists(narrFile) ? readJson(narrFile) : {};
let scenario = {};
try {
    scenario = await importScenario(resolveIn(run.dir, run.scenario));
} catch {
    // optional
}
const OUT = path.resolve(args.out || path.join(run.dir, 'report.html'));

// ------------------------------------------------------------------ formatting
const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isMs = k => /(Ms|\.ms)$/.test(k) || /lag|frame(P|Max)/.test(k);
const fmtMs = v => {
    if (v === null || v === undefined || Number.isNaN(v)) return '–';
    const a = Math.abs(v);
    if (a >= 10000) return (v / 1000).toFixed(1) + ' s';
    if (a >= 1000) return (v / 1000).toFixed(2) + ' s';
    if (a >= 100) return Math.round(v) + ' ms';

    return +v.toFixed(1) + ' ms';
};
const fmtN = v => (v === null || v === undefined ? '–' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(+(+v).toFixed(2)));
const fmtV = (k, v) => (isMs(k) ? fmtMs(v) : fmtN(v));
const fmtPct = p => (p === null || p === undefined || !Number.isFinite(p) ? '–' : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)}%`);
const short = sha => (sha ? String(sha).slice(0, 10) : '');
const headline = S.headline || scenario.headline || [];
// the gate's placement metric: shown in every table, never toned as better or worse
const PLACEMENT = 'pcore.eSharePct';
const RIG_LABELS = { [PLACEMENT]: 'Main-thread CPU on efficiency cores, %', 'pcore.eJudgedSharePct': 'Main-thread CPU on efficiency cores, judged %' };
const labelOf = k => (N.metricLabels && N.metricLabels[k]) || (headline.find(h => h.key === k) || {}).label || RIG_LABELS[k] || k;
const dirOf = k => (k.startsWith('pcore.') ? 'none' : (headline.find(h => h.key === k) || {}).dir || 'lower');
// CALL_P and called() (lib.mjs): a direction is called only when every session separates and that
// is unlikely by chance; aggregate's advice uses the same rule
const tone = (d, dir) => {
    if (!d || d.medPct === null || d.medPct === undefined || dir === 'none') return 'flat';
    if (!called(d) || Math.abs(d.medPct) < 3) return 'flat';
    const lower = d.separated === 'B lower';

    return (dir === 'lower') === lower ? 'better' : 'worse';
};
const sideKeys = Object.keys(S.run.sides);
const [KA, KB] = sideKeys;
const sideLabel = k => `${S.run.sides[k].label || k} · ${k}`;
const passNames = Object.keys(S.passes);
// summary.json has each pass's role (plan.json's, or inferred); an older one gets it inferred here
const roleOf = p => S.passes[p].role || passRole(p, S.passes[p].meta);
// verdict cards come from a timing pass only: never a counting, trial or control pass
const mainPass = args.main || passNames.find(p => roleOf(p) === 'timing') || null;
const passLabel = p => (N.passLabels && N.passLabels[p]) || p;

// ------------------------------------------------------------------ pieces
const strip = (a, b, k) => {
    const all = (a || []).concat(b || []);
    if (!all.length) return '';
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) {
        lo -= 1;
        hi += 1;
    }
    const x = v => 8 + ((v - lo) / (hi - lo)) * 152;
    const dots = (vals, cls, y) => vals.map(v => `<circle cx="${x(v).toFixed(1)}" cy="${y}" r="3.6" class="${cls}"><title>${esc(fmtV(k, v))}</title></circle>`).join('');

    return `<svg class="strip" viewBox="0 0 168 30" role="img" aria-label="session medians"><line x1="4" x2="164" y1="15" y2="15" class="axis"/>${dots(a || [], 'dot-a', 9)}${dots(b || [], 'dot-b', 21)}</svg>`;
};
const statCell = (k, x) => (x && x.stats
    ? `<td class="num"><span class="p75">${esc(fmtV(k, x.stats.p75))}</span><span class="spread">p50 ${esc(fmtV(k, x.stats.p50))} · ${esc(fmtV(k, x.stats.min))}–${esc(fmtV(k, x.stats.max))}</span></td>`
    : '<td class="num">–</td>');
const metricRows = (R, keys) => keys.filter(k => R.metrics[k]).map(k => {
    const m = R.metrics[k];
    const d = m.delta || {};
    const t = tone(d, dirOf(k));
    const verdict = !d.separated ? 'too few sessions' : d.separated === 'overlap' ? `sessions overlap · p ${d.p}` : `${called(d) ? 'sessions separate' : 'consistent, too few to call'} · p ${d.p}`;

    return `<tr><th scope="row">${esc(labelOf(k))}<span class="hint">${esc(k)}</span></th>${statCell(k, m[KA])}${statCell(k, m[KB])}<td class="num delta ${t}">${esc(fmtPct(d.medPct))}<span class="verdict-tag">p75 ${esc(fmtPct(d.p75Pct))}</span></td><td class="sessions">${strip(m[KA] && m[KA].sessions, m[KB] && m[KB].sessions, k)}<span class="verdict-tag">${esc(verdict)}</span></td></tr>`;
}).join('');
const table = (caption, R, keys, note) => `<figure class="tbl"><figcaption>${caption}</figcaption><div class="scroll"><table>
<thead><tr><th scope="col">Metric</th><th scope="col" class="num">${esc(sideLabel(KA))} <span class="n">n ${R.sides[KA] ? R.sides[KA].n : 0}</span></th><th scope="col" class="num">${esc(sideLabel(KB))} <span class="n">n ${R.sides[KB] ? R.sides[KB].n : 0}</span></th><th scope="col" class="num">Δ median</th><th scope="col">Sessions</th></tr></thead>
<tbody>${metricRows(R, keys)}</tbody></table></div>${note ? `<p class="note">${note}</p>` : ''}</figure>`;

const autoVerdicts = () => {
    const P = S.passes[mainPass];
    if (!P) return [];
    const out = [];
    for (const [rate, R] of Object.entries(P.rates)) {
        for (const h of verdictMetrics(headline)) {
            const m = R.metrics[h.key];
            if (!m || !m.delta) continue;
            const t = tone(m.delta, h.dir);
            out.push({
                label: `${h.label}, ${rate}x`,
                big: fmtPct(m.delta.medPct),
                from: `${fmtV(h.key, median(m[KA].sessions))} → ${fmtV(h.key, median(m[KB].sessions))}`,
                why: !m.delta.separated ? 'Fewer than two sessions a side: no call.'
                    : m.delta.separated === 'overlap' ? `Session medians overlap (p ${m.delta.p}): not a difference this run can call.`
                        : `Every ${KB} session median is ${m.delta.separated === 'B lower' ? 'below' : 'above'} every ${KA} one (p ${m.delta.p})${called(m.delta) ? '.' : ': consistent, but too few sessions to call.'}`,
                tone: t,
            });
        }
    }

    return out;
};
const verdictCards = list => `<div class="verdicts">${list.map(v => `<article class="verdict ${esc(v.tone || 'flat')}"><span class="label">${esc(v.label)}</span><span class="big">${esc(v.big)}</span>${v.from ? `<span class="from">${esc(v.from)}</span>` : ''}${v.why ? `<p class="why">${v.why}</p>` : ''}</article>`).join('')}</div>`;

// ------------------------------------------------------------------ environment
const firstSession = side => {
    for (const p of [mainPass].concat(passNames)) {
        const s = S.passes[p] && S.passes[p].sessions[side];
        if (s && s.length) return s[0];
    }

    return null;
};
const sessionsOf = side => passNames.flatMap(p => (S.passes[p].sessions[side] || []));
// the performance-core gate (summary.pcore): wait, discards by cause, the efficiency share kept (macOS's
// own placement), the median P clock
const pcoreText = side => {
    const g = S.pcore && S.pcore[side];
    if (!g) return '– (sessions from before the gate)';
    if (!g.gated && !g.partly) return `off: ${g.off.join('; ') || 'unknown'}`;
    const rates = Object.entries(g.rates).map(([r, x]) => `${r}x: E share ${x.medianEPct ?? '–'} % median (≤ ${x.maxEPct ?? '–'} %), P ${x.medianGHz ?? '–'} GHz`).join(' · ');
    const partly = g.partly ? ` · ${g.partly} partly gated (${g.ungatedIterations} measured iterations ungated: ${g.off.join('; ')})` : '';
    const why = Object.entries(g.causes || {}).map(([c, n]) => `${n} ${c}`).join(', ');

    const scope = (g.scopes || []).includes('process') ? ' · process scope (no per-thread counters): no main-thread share' : '';

    return `${g.gated}/${g.sessions} sessions gated${partly} · waited ${fmtMs(g.waitMs)} · ${g.discards} discarded${why ? ` (${why})` : ''}${g.timeouts ? ` · ${g.timeouts} gates not met` : ''}${rates ? ` · ${rates}` : ''}${scope}`;
};
const placementFlags = (S.advice && S.advice.placement) || [];
const loads = sideKeys.flatMap(k => sessionsOf(k).map(s => s.load && s.load[0]).filter(x => typeof x === 'number'));
const sideCard = (k, i) => {
    const s = S.run.sides[k];
    const f = firstSession(k) || {};
    const env = f.env || {};
    const calib = f.calib || {};
    const rates = Object.keys(calib).map(Number).sort((a, b) => a - b);
    const cal = rates.map(r => `${r}x ${fmtMs(median(calib[r]))}`).join(' · ');
    const ratio = rates.length > 1 ? (median(calib[rates[rates.length - 1]]) / median(calib[rates[0]])).toFixed(2) : null;
    const canary = env.canary ? (median(env.canary.spread) / Math.max(0.1, median(env.canary.slice))).toFixed(1) : null;
    const idle = f.idle ? Object.entries(f.idle).map(([r, v]) => `${r}x ${v.taskPerS} ms/s`).join(' · ') : '';
    const markers = env.markers ? Object.entries(env.markers).map(([n, c]) => `${esc(n)} ×${c}`).join(', ') : '';

    return `<div class="sidecard${i ? ' b' : ''}"><h3>${esc(sideLabel(k))}</h3><dl class="kv">
<dt>revision</dt><dd><code>${esc(short(s.sha || s.rev))}</code>${s.variant ? ` + ${esc(s.variant)}` : ''}</dd>
<dt>sessions</dt><dd>${sessionsOf(k).length} (${sessionsOf(k).filter(x => x.complete).length} complete)</dd>
<dt>code markers</dt><dd>${markers || '–'}</dd>
<dt>coverage files</dt><dd>${env.coverageFiles ?? '–'}</dd>
<dt>React renderers</dt><dd>${env.renderers ?? '–'}${env.desktopLaunches > 1 ? ` (desktop: ${env.desktopLaunches} launches)` : ''}</dd>
<dt>calibration loop</dt><dd>${esc(cal)}${ratio ? ` → ${ratio}x` : ''}</dd>
<dt>idle CPU</dt><dd>${esc(idle)}</dd>
<dt>debugger canary</dt><dd>${canary ? `spread/slice ${canary} (≈1 = no debugger)` : '–'}</dd>
<dt>performance cores</dt><dd>${esc(pcoreText(k))}</dd>
<dt>browser</dt><dd>${esc(f.browser || '–')}</dd></dl></div>`;
};

// ------------------------------------------------------------------ sections
const passSections = passNames.map(p => {
    const P = S.passes[p];
    const meta = P.meta || {};
    const counts = roleOf(p) === 'counts';
    const headKeys = headline.length ? headline.map(h => h.key) : Object.keys(Object.values(P.rates)[0].metrics).filter(k => k.startsWith('total.'));
    const blocks = Object.entries(P.rates).map(([rate, R]) => {
        // a counting pass is instrumented: its counts, never its timing; gated passes add the placement row
        const keys = counts ? countKeys(R, headline) : headKeys.concat(R.metrics[PLACEMENT] && !headKeys.includes(PLACEMENT) ? [PLACEMENT] : []);
        const extra = counts ? [] : Object.keys(R.metrics).filter(k => !keys.includes(k) && !k.startsWith('pcore.') && called(R.metrics[k].delta) && Math.abs(R.metrics[k].delta.medPct || 0) >= 5);
        const problems = sideKeys.flatMap(k => (R.sides[k] ? R.sides[k].problems : []));
        const ctl = R.control ? `<figure class="tbl"><figcaption>Injected-cost control <span class="sub">a known busy block per unit of work, alternating 0 / ${esc(meta.altInject)} ms inside each session; the metric should move by the injected total</span></figcaption><div class="scroll"><table class="plain"><thead><tr><th>Session</th><th class="num">Expected</th><th class="num">total.taskMs moved</th><th class="num">Landed</th></tr></thead><tbody>${Object.values(R.control).flat().map(c => {
            const t = c.landed['total.taskMs'] || Object.values(c.landed)[0] || {};

            return `<tr><td class="mono">${esc(c.session)}</td><td class="num">${esc(fmtMs(c.expectedMs))}</td><td class="num">${esc(fmtMs(t.deltaMs))}</td><td class="num">${esc(t.landedPct ?? '–')}%</td></tr>`;
        }).join('')}</tbody></table></div>${controlVerdict(R.control) ? `<p class="note">${esc(controlText(controlVerdict(R.control)))}</p>` : ''}</figure>` : '';

        return `${table(`${esc(passLabel(p))} @ ${esc(rate)}x CPU<span class="sub">k ${esc(meta.k)} per session, first ${esc(meta.warmup)} discarded · ${sideKeys.map(k => `${k} ${R.sides[k] ? R.sides[k].sessions.length : 0} sessions`).join(', ')}${meta.altInject ? ' · inject=0 iterations only' : ''}${counts ? ' · counts only: the instrumentation taxes timing' : ''}</span>`, R, keys, null)}
${extra.length ? table(`Other metrics whose sessions separate (p ≤ ${CALL_P}) by 5% or more · ${esc(rate)}x`, R, extra, null) : ''}
${ctl}
${problems.length ? `<div class="callout"><p><b>${problems.length} iterations dropped</b>: ${problems.slice(0, 6).map(esc).join('; ')}${problems.length > 6 ? ' …' : ''}</p></div>` : ''}`;
    }).join('\n');

    return `<section><h2>${esc(passLabel(p))}</h2>${meta.cfg ? `<p class="note">cfg <code>${esc(JSON.stringify(meta.cfg))}</code></p>` : ''}${blocks}</section>`;
}).join('\n');

const autoCaveats = [
    S.run.device === 'synthetic' ? 'Synthetic state: seeded store and mocked backend, identical on both sides; no device and no network.' : `Device: ${esc(S.run.device)} (trezor-user-env emulator) — real connect flow; backend latency adds noise to wall times, CPU totals are less affected.`,
    'Percentiles pool iterations from several page sessions; iterations inside a session are correlated, so the session columns decide whether a timing difference is real.',
    `One machine${loads.length ? `, 1-min load average ${Math.min(...loads)}–${Math.max(...loads)} at session starts` : ''}; numbers do not transfer to other hardware, only the direction and the session separation do.`,
    `Compared against ${esc(sideLabel(KA))} at <code>${esc(short(S.run.sides[KA].sha || S.run.sides[KA].rev))}</code>.`,
];

const prNum = S.run.pr ? (String(S.run.pr).match(/(\d+)\/?$/) || [])[1] : null;
const pageTitle = N.pageTitle || (prNum ? `PR ${prNum} perf A/B` : `${S.run.id || 'Suite'} perf A/B`);
const title = N.title || S.run.title || pageTitle;
const verdicts = N.verdicts && N.verdicts.length ? N.verdicts : autoVerdicts();
const css = fs.readFileSync(path.join(RIG, 'report.css'), 'utf8');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>${css}</style></head>
<body><main class="page">
<header class="top"><span class="eyebrow">Suite perf A/B · ${esc(S.run.target)} · ${esc(S.run.device)} · ${esc(S.run.scenario)}</span>
<h1>${esc(title)}</h1>
${N.summary ? `<p class="lede">${N.summary}</p>` : scenario.description ? `<p class="lede">${esc(scenario.description)}</p>` : ''}
<div class="chips">${sideKeys.map(k => `<span class="chip"><b>${esc(k)}</b> ${esc(S.run.sides[k].label || '')} <code>${esc(short(S.run.sides[k].sha || S.run.sides[k].rev))}</code></span>`).join('')}${S.run.pr ? `<a class="chip" href="${esc(S.run.pr)}">${esc(prNum ? `#${prNum}` : 'PR')}</a>` : ''}<span class="chip">${esc(S.generated.slice(0, 10))}</span></div></header>
${verdicts.length ? `<section><h2>Verdict</h2>${verdictCards(verdicts)}</section>` : mainPass ? '' : '<section><h2>Verdict</h2><p class="note">No timing pass yet: counting, trial and control passes make no timing claim.</p></section>'}
${N.findings && N.findings.length ? `<section><h2>Findings</h2><ul>${N.findings.map(f => `<li>${f}</li>`).join('')}</ul></section>` : ''}
${(N.sections || []).map(s => `<section><h2>${esc(s.title)}</h2>${s.html}</section>`).join('\n')}
${passSections}
<section><h2>Builds and rig health</h2>${placementFlags.length ? `<div class="callout"><p><b>Efficiency-core placement differs between the sides.</b> ${placementFlags.map(f => esc(`${passLabel(f.pass)} @ ${f.rate}x: ${f.text}.`)).join(' ')}</p></div>` : ''}<div class="sidecards">${sideKeys.map(sideCard).join('')}</div>
<p class="note">Code markers are source strings found in the running bundle's modules: they prove which build each side ran. The calibration loop is a fixed busy loop per CPU rate (the higher rate should read about that many times slower). The spread/slice canary reads about 1 without a debugger and about 25 when a DevTools debugger taxes spreads.</p>
${S.advice && S.advice.next && S.advice.next.length ? `<p class="note">Could more sessions change a verdict? ${(S.advice.controls || []).filter(c => c.state && c.state !== 'failed').map(c => esc(controlText(c, `${c.pass} @ ${c.rate}x`))).concat(S.advice.next.map(esc)).join(' · ')}</p>` : ''}</section>
<section><h2>Caveats</h2><ul>${autoCaveats.concat(N.caveats || []).map(c => `<li>${c}</li>`).join('')}</ul></section>
<section><h2>Method</h2><ul>
<li>Each session is one fresh ${S.run.target === 'desktop' ? 'Electron app launch (own user-data dir, wiped at start)' : 'headless Chromium page'} serving a local production build; sessions alternate ${esc(sideKeys.join('/'))} in ABBA order.</li>
<li>Per CPU rate: a calibration loop, a ${esc(((S.passes[mainPass] && S.passes[mainPass].meta && S.passes[mainPass].meta.idleMs) || 10000) / 1000)}-second idle window (background CPU per second), then k iterations of a two-spin warm-up and the measured phases <code>${esc((scenario.phases || []).map(p => (typeof p === 'string' ? p : p.name)).join(' → '))}</code>.</li>
<li>Main-thread time is CDP <code>Performance.getMetrics</code> in thread ticks, read at every phase boundary; frames, timer lag, long tasks, long animation frames and React commits come from in-page probes that are identical on both sides.</li>
<li>Δ median compares the medians of the per-session medians; "sessions separate" means every ${esc(KB)} session median lies beyond every ${esc(KA)} one, with a permutation p-value over the session medians.</li></ul></section>
<footer>Generated ${esc(S.generated)} by the suite-perf-ab rig from <code>${esc(run.dir)}</code>.</footer>
</main></body></html>
`;
fs.writeFileSync(OUT, html);
console.log('written', OUT, `${Math.round(fs.statSync(OUT).size / 1024)} KB`);
