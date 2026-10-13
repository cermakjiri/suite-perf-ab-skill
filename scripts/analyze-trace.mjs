#!/usr/bin/env node

/**
 * analyze-trace.mjs - hard numbers out of raw Chrome DevTools performance traces.
 *
 * Input: the JSON written by chrome-devtools-mcp `performance_stop_trace --filePath`
 * (or DevTools "Save profile..."). Accepts `{"traceEvents":[...], ...}` or a bare
 * array, plain `.json` or gzipped `.json.gz`. Zero npm dependencies.
 *
 * Usage
 *   node analyze-trace.mjs <trace-file...> [--json] [--from=<ms>] [--to=<ms>] [--label=<name>]
 *   node analyze-trace.mjs --aggregate [--p=75] <trace-file...>
 *   node analyze-trace.mjs --compare '<a-glob>' '<b-glob>' [--p=75]
 *
 * ---------------------------------------------------------------------------
 * METHOD (read this before trusting a number)
 * ---------------------------------------------------------------------------
 *
 * 1. Time base. Trace `ts`/`dur` are microseconds on an arbitrary monotonic
 *    clock. Everything printed in ms is relative to an origin, which is
 *    `navigationStart` of the main frame when present, otherwise the earliest
 *    non-metadata event in the trace. `--from`/`--to` are ms on that same axis.
 *    Two windowing rules, applied consistently: *durations* (self time, task
 *    time, Layout/Paint totals, TBT) are clipped to the window interval, while
 *    point-anchored *entities* (user-timing measures and marks, invalidation and
 *    frame instants, animation frames) count in full for the window that
 *    contains their start. Navigation milestones are never windowed - they are
 *    absolute reference points on the same axis, and a window that excludes FCP
 *    still reports it.
 *
 * 2. Threads. Metadata events (`process_name`, `thread_name`) name every thread.
 *    The main thread is the `CrRendererMain` of the process that owns the main
 *    frame (from `TracingStartedInBrowser.args.data.frames[]`, the frame with no
 *    `parent`); if that is missing we fall back to the busiest `CrRendererMain`.
 *    Scripting/rendering numbers are main-thread only. Raster/decode/GPU work
 *    physically cannot run there, so painting is reported as main-thread paint
 *    plus raster-worker plus GPU-process self time (sub-fields are broken out).
 *
 * 3. SELF TIME (the "toplevel task tree + duration minus children" method).
 *    DevTools timeline events are complete ('X') events that nest strictly
 *    inside their parent, rooted at a toplevel `RunTask`. Per thread we sort by
 *    (ts asc, dur desc) - so a parent always precedes a child that starts at the
 *    same ts - and walk a stack, popping every frame whose end <= the new event's
 *    start. The remaining top of stack is the direct parent.
 *
 *    Instead of `self = dur - sum(children.dur)` we accumulate the *gaps* between
 *    consecutive direct children as explicit intervals:
 *
 *        parent.self += [parent.cursor .. child.ts]   (clipped to the window)
 *        parent.cursor = max(parent.cursor, child.end)
 *        ...on pop:  node.self += [node.cursor .. node.end]
 *
 *    That is algebraically identical to duration-minus-children for a clean tree
 *    (children are disjoint, so the gaps are the complement), never double counts,
 *    and - unlike the subtraction form - stays exact when a `--from/--to` window
 *    cuts through the middle of a task, because each self interval is clipped
 *    individually. Overlapping/ragged children are clamped to the parent's end.
 *
 *    B/E (begin/end) pairs are folded into synthetic 'X' events first. Phases that
 *    are overlays rather than real stack frames are excluded from the tree so they
 *    cannot steal a parent's self time: async ('b','e','n','S','T','F'), instants
 *    ('I','i','R'), samples ('P'), metadata ('M'), and everything in
 *    `blink.user_timing` / `blink.console` / `latencyInfo` (`performance.measure`
 *    is reported separately, see 6).
 *
 * 4. Categories. Name -> category tables mirror DevTools' EventStyles:
 *      scripting  FunctionCall, EvaluateScript, v8.compile, v8.run, RunMicrotasks,
 *                 TimerFire, EventDispatch, XHRReadyStateChange, FireAnimationFrame,
 *                 FireIdleCallback, ParseScriptOnBackground, GC (also reported on
 *                 its own as gcSelfMs so it can be subtracted)
 *      rendering  Layout, UpdateLayoutTree/RecalculateStyles, HitTest, PrePaint,
 *                 UpdateLayerTree, ComputeIntersections, ParseAuthorStyleSheet
 *      painting   Paint, PaintImage, PaintSetup, Layerize, Commit, RasterTask,
 *                 DecodeImage/ImageDecodeTask, GPUTask, CompositeLayers
 *      loading    ParseHTML, Resource*, XHRLoad, DecodeBodyData
 *      toplevel   RunTask and friends (the task's own overhead; kept separate so
 *                 the per-category self times sum to main-thread task time)
 *    Anything unknown lands in `other` and shows up in the "top self time by
 *    event name" list, so a miscategorised name is visible rather than silent.
 *
 * 5. TBT. Long task = a *toplevel* main-thread task (depth 0) with dur > 50ms.
 *    Blocking time uses Lighthouse's `calculateSumOfBlockingTime`: for each long
 *    task, clip it to [start,end], skip if the clipped duration is < 50ms, else
 *    add (clippedDuration - 50). Reported three ways: over the whole window
 *    (`tbtTotalMs`), from FCP to the end of the window (`tbtFromFcpMs`, the
 *    Lighthouse-comparable one) and from navigationStart (`tbtFromNavMs`).
 *
 * 6. blink.user_timing. `performance.measure` shows up either as an 'X' event or
 *    as an async 'b'/'e' pair (modern Chrome, which is how React's performance
 *    tracks and any `performance.measure` we add ourselves arrive). Both forms are
 *    paired and grouped by name with count/total/max; `performance.mark` ('R'/'I')
 *    is counted as a mark. Measures whose name matches
 *    /react|atom-glyph|commit|render|suite|trezor/i are additionally summed into
 *    the reactMeasure* metrics (the atom glyph is what React's own tracks prefix
 *    their measure names with).
 *
 * 7. Forced synchronous layout. A `Layout` / `UpdateLayoutTree` whose ancestor
 *    chain contains a JS-execution frame (FunctionCall, EvaluateScript,
 *    EventDispatch, TimerFire, RunMicrotasks, ...) was forced by a geometry read
 *    from script - the same rule DevTools uses to draw its "Forced reflow"
 *    warning. Counted as forcedLayout / forcedStyleRecalc metrics; the stricter
 *    "...and Chrome attached a JS stack trace" variant is reported alongside.
 *    Invalidation instants (LayoutInvalidationTracking, ScheduleStyleRecalculation)
 *    and the sum of `beginData.dirtyObjects` are counted too - they say how much
 *    of the tree each pass had to touch.
 *
 * 8. CPU profile (optional). `Profile` + `ProfileChunk` samples are folded into
 *    per-function self time (timeDeltas[i] attributed to samples[i]).
 *    `(idle)`, `(program)`, `(root)`, `(garbage collector)` are excluded from
 *    jsSampledSelfMs. These numbers are *not* added to scriptingSelfMs - they are
 *    an independent sampled estimate of the same wall time, and adding them would
 *    double count.
 *
 * 9. Percentiles (--aggregate / --compare) use nearest-rank on the ascending
 *    sample, i.e. idx = clamp(ceil(p/100 * n) - 1, 0, n-1). No interpolation, so
 *    every reported value is a value that actually occurred in some trace.
 *    Traces missing a metric contribute nothing to it (n shrinks) rather than 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Category tables (mirrors devtools-frontend EventStyles, trimmed to what we sum)
// ---------------------------------------------------------------------------

const CAT = new Map();
const put = (category, names) => names.forEach(n => CAT.set(n, category));

const GC_NAMES = new Set([
    'GCEvent', 'MajorGC', 'MinorGC', 'BlinkGC.AtomicPhase', 'BlinkGCMarking',
    'V8.GCScavenger', 'V8.GCIncrementalMarking', 'V8.GCCompactor', 'V8.GCFinalizeMC',
    'CppGC.IncrementalMark',
]);

put('scripting', [
    'FunctionCall', 'EvaluateScript', 'v8.compile', 'v8.compileModule', 'v8.produceCache',
    'v8.run', 'v8.callFunction', 'V8.Execute', 'V8.CallFunction', 'RunMicrotasks',
    'TimerFire', 'TimerInstall', 'TimerRemove', 'EventDispatch', 'XHRReadyStateChange',
    'FireAnimationFrame', 'FireIdleCallback', 'RequestIdleCallback', 'CancelIdleCallback',
    'RequestAnimationFrame', 'CancelAnimationFrame', 'CompileScript', 'CacheScript',
    'CompileCode', 'OptimizeCode', 'ParseScriptOnBackground', 'EventTiming',
    'WebSocketCreate', 'WebSocketSendHandshakeRequest', 'WebSocketReceiveHandshakeResponse',
    'v8.parseOnBackground', 'V8.ParseFunction', 'StreamingCompileScript',
    ...GC_NAMES,
]);

put('rendering', [
    'Layout', 'UpdateLayoutTree', 'RecalculateStyles', 'InvalidateLayout',
    'ScheduleStyleRecalculation', 'HitTest', 'PrePaint', 'UpdateLayerTree',
    'ComputeIntersections', 'ParseAuthorStyleSheet', 'Animation', 'BeginMainThreadFrame',
    'RequestMainThreadFrame', 'LocalFrameView::RunStyleAndLayoutLifecyclePhases',
    'LocalFrameView::performLayout', 'StyleRecalcInvalidationTracking',
]);

put('painting', [
    'Paint', 'PaintImage', 'PaintSetup', 'Layerize', 'Commit', 'RasterTask',
    'DecodeImage', 'DecodeLazyPixelRef', 'ImageDecodeTask', 'ImageUploadTask',
    'Decode Image', 'Draw LazyPixelRef', 'ResizeImage', 'GPUTask', 'CompositeLayers',
    'UpdateLayer', 'RasterizeAndRecord',
]);

put('loading', [
    'ParseHTML', 'ResourceWillSendRequest', 'ResourceSendRequest', 'ResourceReceiveResponse',
    'ResourceReceivedData', 'ResourceFinish', 'ResourceMarkAsCached', 'XHRLoad',
    'DecodeBodyData', 'ReceiveData', 'CommitLoad',
]);

put('toplevel', [
    'RunTask', 'ThreadControllerImpl::RunTask', 'ThreadControllerImpl::DoWork',
    'TaskQueueManager::ProcessTaskFromWorkQueue', 'MessageLoop::RunTask',
    'SequenceManager::RunTask', 'ThreadProxy::BeginMainFrame',
]);

const RENDERING_CORE = new Set(['Layout', 'UpdateLayoutTree', 'RecalculateStyles', 'HitTest', 'PrePaint']);
const PAINTING_OFFMAIN = new Set([
    'RasterTask', 'DecodeImage', 'ImageDecodeTask', 'ImageUploadTask', 'DecodeLazyPixelRef',
    'Decode Image', 'GPUTask', 'RasterizeAndRecord', 'ResizeImage',
]);

// Ancestors that mean "we are inside running JavaScript" (forced-layout detection).
const JS_EXEC = new Set([
    'FunctionCall', 'EvaluateScript', 'v8.run', 'v8.callFunction', 'V8.Execute',
    'V8.CallFunction', 'RunMicrotasks', 'TimerFire', 'EventDispatch',
    'XHRReadyStateChange', 'FireAnimationFrame', 'FireIdleCallback', 'EventTiming',
]);

const TOPLEVEL_NAMES = new Set([...CAT.keys()].filter(k => CAT.get(k) === 'toplevel'));

// Phases / categories that are overlays, not real stack frames.
const TREE_SKIP_CATS = ['blink.user_timing', 'blink.console', 'latencyInfo', 'devtools.timeline.async'];

const LONG_TASK_US = 50_000;
const TBT_THRESHOLD_MS = 50;

const categoryOf = name => CAT.get(name) || 'other';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const readTraceFile = file => {
    let buf = fs.readFileSync(file);

    // Trust the gzip magic over the extension; either is produced in practice.
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        buf = zlib.gunzipSync(buf);
    }
    let text = buf.toString('utf8');

    buf = null; // let the buffer go before JSON.parse doubles our footprint

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        // Traces are often truncated (tab closed mid-flush). Salvage the prefix.
        const cut = text.lastIndexOf('}');
        if (cut < 0) throw err;
        const head = text.slice(0, cut + 1);
        const repaired = /^\s*\[/.test(head) ? `${head}]` : `${head}]}`;
        parsed = JSON.parse(repaired.replace(/,\s*(\]|\})/g, '$1'));
        process.stderr.write(`warning: ${path.basename(file)} was truncated; parsed the recoverable prefix\n`);
    }
    text = null;

    const events = Array.isArray(parsed) ? parsed : parsed && parsed.traceEvents;
    if (!Array.isArray(events)) {
        throw new Error('no traceEvents array found');
    }

    return { events };
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const us2ms = us => us / 1000;
const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(d)));
const has = (cat, needle) => typeof cat === 'string' && cat.indexOf(needle) !== -1;
const bump = (map, key, delta) => map.set(key, (map.get(key) || 0) + delta);

const nameStat = (map, name) => {
    let stat = map.get(name);
    if (!stat) {
        stat = { count: 0, durUs: 0, selfUs: 0 };
        map.set(name, stat);
    }

    return stat;
};

const threadKindOf = (threadName, pid, mainPid) => {
    const name = threadName || '';
    if (name === 'CrRendererMain') return pid === mainPid ? 'main' : 'renderer-other';
    if (name.startsWith('CompositorTileWorker')) return 'raster';
    if (name === 'Compositor') return 'compositor';
    if (name === 'CrGpuMain' || name === 'VizCompositorThread' || name === 'CrGpuHostThread') return 'gpu';
    if (name.includes('Worker') || name.includes('worker')) return 'worker';
    if (name === 'CrBrowserMain') return 'browser';

    return 'other';
};

/**
 * Lighthouse's calculateSumOfBlockingTime, verbatim in behaviour: a long task
 * contributes (clippedDuration - 50ms), and is skipped entirely when less than
 * 50ms of it falls inside the interval.
 */
const sumOfBlockingTime = (tasks, startMs, endMs) => {
    if (endMs < startMs) return 0;
    let sum = 0;
    for (const task of tasks) {
        if (task.endMs < startMs) continue;
        if (task.durMs < TBT_THRESHOLD_MS) continue;
        const clippedStart = Math.max(task.startMs, startMs);
        const clippedEnd = Math.min(task.endMs, endMs);
        const clipped = clippedEnd - clippedStart;
        if (clipped < TBT_THRESHOLD_MS) continue;
        sum += clipped - TBT_THRESHOLD_MS;
    }

    return sum;
};

// ---------------------------------------------------------------------------
// Pass 1: metadata, milestones, user timing, frames, cpu profile
// ---------------------------------------------------------------------------

const FCP_NAMES = new Set(['firstContentfulPaint', 'MarkFCP', 'firstContentfulPaint::Candidate']);
const FP_NAMES = new Set(['firstPaint', 'MarkFirstPaint']);
const DCL_NAMES = new Set(['domContentLoadedEventEnd', 'MarkDOMContent']);
const LOAD_NAMES = new Set(['loadEventEnd', 'MarkLoad']);
const NAV_NAMES = new Set(['navigationStart', 'NavigationStart']);

// React's performance tracks prefix measures with the atom glyph (U+269B).
const REACT_MEASURE_RE = /react|⚛|commit|render|suite|trezor/i;

const scanEvents = events => {
    const threadNames = new Map(); // `${pid}:${tid}` -> name
    const processNames = new Map();
    const milestonesUs = { navigationStart: null, firstPaint: null, fcp: null, lcp: null, dcl: null, load: null };
    // Everything point-anchored is collected with its timestamp and filtered
    // against the window later (the window is only known once we have an origin).
    const measures = []; // {name, startUs, durUs}
    const marks = []; // {name, startUs}
    const openAsync = new Map(); // key -> ts (for async b/e pairing)
    const frames = { drawFrame: [], dropped: [], partialDropped: [], beginFrame: [] };
    const animationFrames = []; // {startUs, durUs}
    const invalidation = { layout: [], style: [] };
    const profiles = new Map(); // profile id -> {startUs, nodes, samples, deltas}
    let mainPid = null;
    let mainFrameId = null;
    let minUs = Infinity;
    let maxUs = -Infinity;

    for (const event of events) {
        const ph = event.ph;

        if (ph === 'M') {
            if (event.name === 'thread_name' && event.args && event.args.name) {
                threadNames.set(`${event.pid}:${event.tid}`, event.args.name);
            } else if (event.name === 'process_name' && event.args && event.args.name) {
                processNames.set(event.pid, event.args.name);
            }
            continue;
        }

        if (typeof event.ts === 'number' && event.ts > 0) {
            if (event.ts < minUs) minUs = event.ts;
            const end = event.ts + (typeof event.dur === 'number' ? event.dur : 0);
            if (end > maxUs) maxUs = end;
        }

        const name = event.name;
        const cat = event.cat || '';

        if (name === 'TracingStartedInBrowser' && event.args && event.args.data && Array.isArray(event.args.data.frames)) {
            const main = event.args.data.frames.find(frame => !frame.parent) || event.args.data.frames[0];
            if (main) {
                mainFrameId = main.frame || null;
                if (typeof main.processId === 'number') mainPid = main.processId;
            }
        }

        // --- navigation milestones -------------------------------------------
        const frameOk = !mainFrameId || !event.args || !event.args.frame || event.args.frame === mainFrameId
            || (event.args.data && event.args.data.frame === mainFrameId);

        if (frameOk) {
            if (NAV_NAMES.has(name) && milestonesUs.navigationStart === null) milestonesUs.navigationStart = event.ts;
            else if (FP_NAMES.has(name) && milestonesUs.firstPaint === null) milestonesUs.firstPaint = event.ts;
            else if (FCP_NAMES.has(name) && milestonesUs.fcp === null) milestonesUs.fcp = event.ts;
            else if (DCL_NAMES.has(name) && milestonesUs.dcl === null) milestonesUs.dcl = event.ts;
            else if (LOAD_NAMES.has(name) && milestonesUs.load === null) milestonesUs.load = event.ts;
            else if (name === 'largestContentfulPaint::Candidate') milestonesUs.lcp = event.ts;
            else if (name === 'largestContentfulPaint::Invalidate') milestonesUs.lcp = null;
        }

        // --- invalidation tracking -------------------------------------------
        if (name === 'LayoutInvalidationTracking' || name === 'InvalidateLayout') invalidation.layout.push(event.ts);
        else if (name === 'ScheduleStyleRecalculation' || name === 'StyleRecalcInvalidationTracking') invalidation.style.push(event.ts);

        // --- frames ----------------------------------------------------------
        if (name === 'DrawFrame') frames.drawFrame.push(event.ts);
        else if (name === 'DroppedFrame') frames.dropped.push(event.ts);
        else if (name === 'PartialDroppedFrame') frames.partialDropped.push(event.ts);
        else if (name === 'BeginFrame') frames.beginFrame.push(event.ts);

        // --- user timing (X, async b/e pairs, marks) --------------------------
        const isMilestoneName = NAV_NAMES.has(name) || DCL_NAMES.has(name) || LOAD_NAMES.has(name)
            || FCP_NAMES.has(name) || FP_NAMES.has(name);
        if (has(cat, 'blink.user_timing') && !isMilestoneName) {
            const key = `ut|${name}|${event.id2 ? JSON.stringify(event.id2) : event.id}`;
            if (ph === 'X' && typeof event.dur === 'number') measures.push({ name, startUs: event.ts, durUs: event.dur });
            else if (ph === 'b' || ph === 'S') openAsync.set(key, event.ts);
            else if (ph === 'e' || ph === 'F') {
                const start = openAsync.get(key);
                if (start !== undefined) {
                    openAsync.delete(key);
                    measures.push({ name, startUs: start, durUs: Math.max(0, event.ts - start) });
                }
            } else if (ph === 'R' || ph === 'I' || ph === 'i') marks.push({ name, startUs: event.ts });
        }

        // --- animation frames -------------------------------------------------
        if (name === 'AnimationFrame' || name === 'LongAnimationFrame' || name === 'AnimationFrame::Presentation') {
            const key = `af|${name}|${event.id2 ? JSON.stringify(event.id2) : event.id}`;
            if (ph === 'b' || ph === 'S') openAsync.set(key, event.ts);
            else if (ph === 'e' || ph === 'F') {
                const start = openAsync.get(key);
                if (start !== undefined) {
                    openAsync.delete(key);
                    animationFrames.push({ startUs: start, durUs: Math.max(0, event.ts - start) });
                }
            } else if (ph === 'X' && typeof event.dur === 'number') {
                animationFrames.push({ startUs: event.ts, durUs: event.dur });
            }
        }

        // --- v8 cpu profile ---------------------------------------------------
        if (name === 'Profile' && event.args && event.args.data) {
            const id = String(event.id || event.id2 || '0');
            const profile = profiles.get(id) || { startUs: null, nodes: new Map(), samples: [], deltas: [] };
            profile.startUs = typeof event.args.data.startTime === 'number' ? event.args.data.startTime : event.ts;
            profiles.set(id, profile);
        } else if (name === 'ProfileChunk' && event.args && event.args.data) {
            const id = String(event.id || event.id2 || '0');
            const profile = profiles.get(id) || { startUs: event.ts, nodes: new Map(), samples: [], deltas: [] };
            const chunk = event.args.data.cpuProfile || {};
            for (const node of chunk.nodes || []) profile.nodes.set(node.id, node);
            for (const sample of chunk.samples || []) profile.samples.push(sample);
            for (const delta of event.args.data.timeDeltas || []) profile.deltas.push(delta);
            profiles.set(id, profile);
        }
    }

    return {
        threadNames, processNames, milestonesUs, measures, marks, frames,
        animationFrames, invalidation, profiles, mainPid, mainFrameId,
        traceStartUs: minUs === Infinity ? 0 : minUs,
        traceEndUs: maxUs === -Infinity ? 0 : maxUs,
    };
};

// ---------------------------------------------------------------------------
// Pass 2: per-thread task tree + self time
// ---------------------------------------------------------------------------

const buildThreadEvents = events => {
    const byThread = new Map();

    for (const event of events) {
        const ph = event.ph;
        if (ph !== 'X' && ph !== 'B' && ph !== 'E') continue;
        if (typeof event.ts !== 'number') continue;
        const cat = event.cat || '';
        if (TREE_SKIP_CATS.some(skip => has(cat, skip))) continue;
        const key = `${event.pid}:${event.tid}`;
        let list = byThread.get(key);
        if (!list) byThread.set(key, (list = []));
        list.push(event);
    }

    // Fold B/E pairs into synthetic complete events so one tree walk covers both.
    for (const [key, list] of byThread) {
        if (!list.some(event => event.ph === 'B' || event.ph === 'E')) {
            list.sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
            continue;
        }
        // At equal ts an 'E' closes before a new frame opens.
        list.sort((a, b) => a.ts - b.ts || (a.ph === 'E' ? -1 : 1) - (b.ph === 'E' ? -1 : 1));
        const out = [];
        const open = [];
        for (const event of list) {
            if (event.ph === 'X') out.push(event);
            else if (event.ph === 'B') open.push(event);
            else if (event.ph === 'E') {
                for (let i = open.length - 1; i >= 0; i -= 1) {
                    if (open[i].name === event.name || i === open.length - 1) {
                        const begin = open.splice(i, 1)[0];
                        out.push({
                            ...begin,
                            ph: 'X',
                            dur: Math.max(0, event.ts - begin.ts),
                            args: begin.args || event.args,
                        });
                        break;
                    }
                }
            }
        }
        out.sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
        byThread.set(key, out);
    }

    return byThread;
};

const walkThread = (list, kind, acc, winStartUs, winEndUs) => {
    const clip = (from, to) => {
        const start = from > winStartUs ? from : winStartUs;
        const end = to < winEndUs ? to : winEndUs;

        return end > start ? end - start : 0;
    };

    const selfByCat = acc.selfByKindCat.get(kind) || new Map();
    acc.selfByKindCat.set(kind, selfByCat);
    const names = acc.nameStats.get(kind) || new Map();
    acc.nameStats.set(kind, names);

    const stack = [];
    let scriptDepth = 0;

    const close = node => {
        node.selfUs += clip(node.cursor, node.end);
        if (JS_EXEC.has(node.name)) scriptDepth -= 1;
        bump(selfByCat, categoryOf(node.name), node.selfUs);
        if (GC_NAMES.has(node.name)) bump(selfByCat, '_gc', node.selfUs);
        nameStat(names, node.name).selfUs += node.selfUs;
    };

    for (const event of list) {
        const start = event.ts;
        const rawEnd = start + (typeof event.dur === 'number' ? event.dur : 0);

        while (stack.length && stack[stack.length - 1].end <= start) close(stack.pop());

        const parent = stack.length ? stack[stack.length - 1] : null;
        const end = parent && rawEnd > parent.end ? parent.end : rawEnd;

        if (parent) {
            // the gap since the previous sibling ended is the parent's own work
            if (start > parent.cursor) parent.selfUs += clip(parent.cursor, start);
            if (end > parent.cursor) parent.cursor = end;
        }

        const clippedDur = clip(start, rawEnd);
        const inWindow = clippedDur > 0 || (start >= winStartUs && start <= winEndUs);
        const isToplevel = TOPLEVEL_NAMES.has(event.name)
            || (has(event.cat, 'toplevel') && !has(event.cat, 'toplevel.flow'));
        const depth = stack.length;

        if (inWindow) {
            const stat = nameStat(names, event.name);
            stat.count += 1;
            stat.durUs += clippedDur;

            if (kind === 'main' && RENDERING_CORE.has(event.name)) {
                const bucket = event.name === 'Layout' ? acc.layout
                    : (event.name === 'UpdateLayoutTree' || event.name === 'RecalculateStyles') ? acc.styleRecalc
                        : null;
                const beginData = (event.args && (event.args.beginData || event.args.data)) || null;
                if (bucket) {
                    bucket.count += 1;
                    bucket.durUs += clippedDur;
                    if (scriptDepth > 0) {
                        bucket.forced += 1;
                        bucket.forcedDurUs += clippedDur;
                        if (beginData && beginData.stackTrace) bucket.forcedWithStack += 1;
                    }
                    if (beginData && typeof beginData.dirtyObjects === 'number') {
                        acc.layoutDirtyObjects += beginData.dirtyObjects;
                    }
                }
            }
        }

        const isRootTask = kind === 'main' && isToplevel && depth === 0 && rawEnd > start;
        let longTask = null;

        if (isRootTask) {
            const startMs = us2ms(start - acc.originUs);
            const durMs = us2ms(rawEnd - start);
            // every root task feeds TBT (Lighthouse clips the interval itself)
            acc.mainTasks.push({ startMs, endMs: us2ms(rawEnd - acc.originUs), durMs });
            if (clippedDur > 0) {
                acc.mainTaskTotalUs += clippedDur;
                if (rawEnd - start > LONG_TASK_US) {
                    longTask = { startMs, durMs, clippedDurMs: us2ms(clippedDur), children: [] };
                    acc.longTasks.push(longTask);
                }
            }
        }

        const node = { name: event.name, ts: start, end, cursor: start, selfUs: 0, longTask };

        if (depth === 1 && stack[0].longTask && stack[0].longTask.children.length < 12) {
            stack[0].longTask.children.push({ name: event.name, durMs: round(us2ms(rawEnd - start)) });
        }

        if (JS_EXEC.has(event.name)) scriptDepth += 1;
        stack.push(node);
    }

    while (stack.length) close(stack.pop());
};

// ---------------------------------------------------------------------------
// CPU profile folding
// ---------------------------------------------------------------------------

const IGNORED_FRAMES = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

const foldProfiles = (profiles, winStartUs, winEndUs) => {
    const perFn = new Map();
    let sampledUs = 0;
    let ignoredUs = 0;
    let samples = 0;

    for (const profile of profiles.values()) {
        if (!profile.samples.length) continue;
        let cursor = typeof profile.startUs === 'number' ? profile.startUs : 0;
        const count = profile.deltas.length ? Math.min(profile.samples.length, profile.deltas.length) : profile.samples.length;
        for (let i = 0; i < count; i += 1) {
            const delta = profile.deltas.length ? profile.deltas[i] : 0;
            cursor += delta;
            if (cursor < winStartUs || cursor > winEndUs) continue;
            const node = profile.nodes.get(profile.samples[i]);
            const frame = (node && node.callFrame) || {};
            const fn = frame.functionName || '(anonymous)';
            samples += 1;
            if (IGNORED_FRAMES.has(fn)) {
                ignoredUs += delta;
                continue;
            }
            sampledUs += delta;
            const url = frame.url ? `${frame.url}:${frame.lineNumber === undefined ? '?' : frame.lineNumber}` : '';
            bump(perFn, `${fn}\t${url}`, delta);
        }
    }

    const top = [...perFn.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([key, us]) => {
            const [fn, url] = key.split('\t');

            return { fn, url, selfMs: round(us2ms(us)) };
        });

    return { sampledSelfMs: round(us2ms(sampledUs)), ignoredMs: round(us2ms(ignoredUs)), samples, top };
};

// ---------------------------------------------------------------------------
// Analyze one trace
// ---------------------------------------------------------------------------

const analyze = (file, opts) => {
    const { events } = readTraceFile(file);
    const scan = scanEvents(events);

    const originUs = scan.milestonesUs.navigationStart !== null ? scan.milestonesUs.navigationStart : scan.traceStartUs;
    const traceStartMs = us2ms(scan.traceStartUs - originUs);
    const traceEndMs = us2ms(scan.traceEndUs - originUs);
    const fromMs = opts.from === null ? traceStartMs : opts.from;
    const toMs = opts.to === null ? traceEndMs : opts.to;
    const winStartUs = originUs + fromMs * 1000;
    const winEndUs = originUs + toMs * 1000;

    const acc = {
        originUs,
        selfByKindCat: new Map(),
        nameStats: new Map(),
        mainTasks: [],
        longTasks: [],
        mainTaskTotalUs: 0,
        layout: { count: 0, durUs: 0, forced: 0, forcedDurUs: 0, forcedWithStack: 0 },
        styleRecalc: { count: 0, durUs: 0, forced: 0, forcedDurUs: 0, forcedWithStack: 0 },
        layoutDirtyObjects: 0,
    };

    // classify threads; fall back to the busiest renderer main when the trace has
    // no TracingStartedInBrowser (e.g. traces started after navigation)
    const threads = [...buildThreadEvents(events)].map(([key, list]) => {
        const pid = Number(key.split(':')[0]);
        const threadName = scan.threadNames.get(key) || '';

        return { key, pid, threadName, kind: threadKindOf(threadName, pid, scan.mainPid), list };
    });

    if (!threads.some(thread => thread.kind === 'main')) {
        const byBusiest = (a, b) => b.list.length - a.list.length;
        const pick = threads.filter(t => t.threadName === 'CrRendererMain').sort(byBusiest)[0]
            || threads.slice().sort(byBusiest)[0];
        if (pick) pick.kind = 'main';
    }

    for (const thread of threads) walkThread(thread.list, thread.kind, acc, winStartUs, winEndUs);

    const catMs = (kind, category) => {
        const map = acc.selfByKindCat.get(kind);

        return map ? us2ms(map.get(category) || 0) : 0;
    };
    const kindTotal = (kinds, category) => kinds.reduce((sum, kind) => sum + catMs(kind, category), 0);

    let rasterSelfMs = 0;
    let gpuSelfMs = 0;
    for (const kind of acc.selfByKindCat.keys()) {
        if (kind === 'main') continue;
        for (const [name, stat] of acc.nameStats.get(kind) || new Map()) {
            if (!PAINTING_OFFMAIN.has(name)) continue;
            if (name === 'GPUTask' || kind === 'gpu') gpuSelfMs += us2ms(stat.selfUs);
            else rasterSelfMs += us2ms(stat.selfUs);
        }
    }

    const windowMs = Math.max(0, toMs - fromMs);
    const mainTaskTotalMs = us2ms(acc.mainTaskTotalUs);
    const toMsFromOrigin = us => (us === null ? null : round(us2ms(us - originUs)));

    const milestones = {
        navigationStartMs: toMsFromOrigin(scan.milestonesUs.navigationStart),
        firstPaintMs: toMsFromOrigin(scan.milestonesUs.firstPaint),
        fcpMs: toMsFromOrigin(scan.milestonesUs.fcp),
        lcpMs: toMsFromOrigin(scan.milestonesUs.lcp),
        dclMs: toMsFromOrigin(scan.milestonesUs.dcl),
        loadMs: toMsFromOrigin(scan.milestonesUs.load),
    };

    const tbtTotalMs = sumOfBlockingTime(acc.mainTasks, fromMs, toMs);
    const tbtFromFcpMs = milestones.fcpMs === null ? null
        : sumOfBlockingTime(acc.mainTasks, Math.max(milestones.fcpMs, fromMs), toMs);
    const tbtFromNavMs = milestones.navigationStartMs === null ? null
        : sumOfBlockingTime(acc.mainTasks, Math.max(0, fromMs), toMs);

    const paintingMainMs = catMs('main', 'painting');

    // Point-anchored entities (measures, marks, invalidation and frame instants,
    // animation frames) belong to the window that contains their START. Their
    // duration is never clipped - they are counted as whole entities, not as time.
    const started = entry => entry.startUs >= winStartUs && entry.startUs <= winEndUs;
    const countStarted = list => list.filter(ts => ts >= winStartUs && ts <= winEndUs).length;

    const inWindowFrames = scan.animationFrames.filter(started);
    const longFrames = inWindowFrames.filter(af => af.durUs > LONG_TASK_US);

    const grouped = new Map();
    for (const measure of scan.measures) {
        if (!started(measure)) continue;
        let group = grouped.get(measure.name);
        if (!group) {
            group = { count: 0, totalUs: 0, maxUs: 0 };
            grouped.set(measure.name, group);
        }
        group.count += 1;
        group.totalUs += measure.durUs;
        if (measure.durUs > group.maxUs) group.maxUs = measure.durUs;
    }
    const utGroups = [...grouped.entries()]
        .map(([name, group]) => ({
            name,
            count: group.count,
            totalMs: round(us2ms(group.totalUs)),
            maxMs: round(us2ms(group.maxUs)),
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    const reactGroups = utGroups.filter(group => REACT_MEASURE_RE.test(group.name));

    const markGroups = new Map();
    for (const entry of scan.marks) {
        if (started(entry)) bump(markGroups, entry.name, 1);
    }

    const profile = foldProfiles(scan.profiles, winStartUs, winEndUs);

    const mainNames = acc.nameStats.get('main') || new Map();
    const stat = name => mainNames.get(name) || { count: 0, durUs: 0, selfUs: 0 };
    const selfOf = name => us2ms(stat(name).selfUs);

    const metrics = {
        windowFromMs: round(fromMs),
        windowToMs: round(toMs),
        windowDurationMs: round(windowMs),

        scriptingSelfMs: round(catMs('main', 'scripting')),
        gcSelfMs: round(catMs('main', '_gc')),
        renderingSelfMs: round(catMs('main', 'rendering')),
        paintingSelfMs: round(paintingMainMs + rasterSelfMs + gpuSelfMs),
        paintingSelfMainThreadMs: round(paintingMainMs),
        rasterSelfMs: round(rasterSelfMs),
        gpuSelfMs: round(gpuSelfMs),
        loadingSelfMs: round(catMs('main', 'loading')),
        taskOverheadSelfMs: round(catMs('main', 'toplevel')),
        otherSelfMs: round(catMs('main', 'other')),
        workerScriptingSelfMs: round(kindTotal(['worker', 'renderer-other'], 'scripting')),

        mainThreadTaskTotalMs: round(mainTaskTotalMs),
        cpuIdleMs: round(Math.max(0, windowMs - mainTaskTotalMs)),
        cpuUtilizationPct: round(windowMs > 0 ? (mainTaskTotalMs / windowMs) * 100 : 0),

        tbtTotalMs: round(tbtTotalMs),
        tbtFromFcpMs: round(tbtFromFcpMs),
        tbtFromNavMs: round(tbtFromNavMs),
        longTaskCount: acc.longTasks.length,
        longTaskTotalMs: round(acc.longTasks.reduce((sum, task) => sum + task.durMs, 0)),
        longestTaskMs: round(acc.longTasks.reduce((max, task) => Math.max(max, task.durMs), 0)),

        layoutCount: acc.layout.count,
        layoutTotalMs: round(us2ms(acc.layout.durUs)),
        forcedLayoutCount: acc.layout.forced,
        forcedLayoutTotalMs: round(us2ms(acc.layout.forcedDurUs)),
        forcedLayoutWithStackCount: acc.layout.forcedWithStack,
        layoutDirtyObjectsTotal: acc.layoutDirtyObjects,
        updateLayoutTreeCount: acc.styleRecalc.count,
        updateLayoutTreeTotalMs: round(us2ms(acc.styleRecalc.durUs)),
        forcedStyleRecalcCount: acc.styleRecalc.forced,
        forcedStyleRecalcTotalMs: round(us2ms(acc.styleRecalc.forcedDurUs)),
        layoutInvalidationCount: countStarted(scan.invalidation.layout),
        styleRecalcInvalidationCount: countStarted(scan.invalidation.style),

        hitTestCount: stat('HitTest').count,
        hitTestMs: round(selfOf('HitTest')),
        prePaintCount: stat('PrePaint').count,
        prePaintMs: round(selfOf('PrePaint')),
        paintCount: stat('Paint').count,
        paintMs: round(selfOf('Paint')),
        paintImageMs: round(selfOf('PaintImage')),
        commitMs: round(selfOf('Commit')),
        layerizeMs: round(selfOf('Layerize')),

        ...milestones,

        userTimingMeasureCount: utGroups.reduce((sum, group) => sum + group.count, 0),
        userTimingTotalMs: round(utGroups.reduce((sum, group) => sum + group.totalMs, 0)),
        userTimingMarkCount: [...markGroups.values()].reduce((sum, count) => sum + count, 0),
        reactMeasureCount: reactGroups.reduce((sum, group) => sum + group.count, 0),
        reactMeasureTotalMs: round(reactGroups.reduce((sum, group) => sum + group.totalMs, 0)),
        reactMeasureMaxMs: round(reactGroups.reduce((max, group) => Math.max(max, group.maxMs), 0)),

        animationFrameCount: inWindowFrames.length,
        longAnimationFrameCount: longFrames.length,
        longAnimationFrameTotalMs: round(longFrames.reduce((sum, af) => sum + us2ms(af.durUs), 0)),
        droppedFrameCount: countStarted(scan.frames.dropped),
        partialDroppedFrameCount: countStarted(scan.frames.partialDropped),
        drawFrameCount: countStarted(scan.frames.drawFrame),
        beginFrameCount: countStarted(scan.frames.beginFrame),

        jsSampledSelfMs: profile.sampledSelfMs,
        jsSampleCount: profile.samples,

        traceEventCount: events.length,
    };

    return {
        file,
        label: opts.label || path.basename(file),
        origin: scan.milestonesUs.navigationStart === null ? 'firstTraceEvent' : 'navigationStart',
        traceStartMs: round(traceStartMs),
        traceEndMs: round(traceEndMs),
        metrics,
        details: {
            threads: threads
                .map(thread => ({ thread: thread.threadName || thread.key, kind: thread.kind, events: thread.list.length }))
                .sort((a, b) => b.events - a.events)
                .slice(0, 12),
            longTasks: acc.longTasks
                .slice()
                .sort((a, b) => b.durMs - a.durMs)
                .slice(0, opts.top)
                .map(task => ({ startMs: round(task.startMs), durMs: round(task.durMs), children: task.children })),
            topEventNames: [...mainNames.entries()]
                .map(([name, entry]) => ({
                    name,
                    category: categoryOf(name),
                    count: entry.count,
                    selfMs: round(us2ms(entry.selfUs)),
                    totalMs: round(us2ms(entry.durUs)),
                }))
                .sort((a, b) => b.selfMs - a.selfMs)
                .slice(0, opts.names),
            userTiming: utGroups.slice(0, 20),
            marks: [...markGroups.entries()].map(([name, count]) => ({ name, count })).slice(0, 20),
            topJsFunctions: profile.top,
        },
    };
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const num = value => (value === null || value === undefined ? '-' : (typeof value === 'number' ? value.toFixed(1) : String(value)));
const int = value => (value === null || value === undefined ? '-' : String(value));

const renderTable = (headers, rows) => {
    const all = [headers, ...rows];
    const widths = headers.map((_, i) => Math.max(...all.map(row => String(row[i] === undefined ? '' : row[i]).length)));
    const line = row => row
        .map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])))
        .join('  ')
        .trimEnd();

    return [line(headers), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
};

const renderReport = result => {
    const m = result.metrics;
    const out = [];

    out.push('');
    out.push(`=== ${result.label} ===`);
    out.push(`file            ${result.file}`);
    out.push(`origin          ${result.origin} (t=0); trace spans ${num(result.traceStartMs)} .. ${num(result.traceEndMs)} ms`);
    out.push(`window          ${num(m.windowFromMs)} .. ${num(m.windowToMs)} ms  (${num(m.windowDurationMs)} ms)`);
    out.push(`trace events    ${int(m.traceEventCount)}`);
    out.push('');
    out.push('-- main thread self time --------------------------------------------');
    out.push(renderTable(['bucket', 'self ms', 'note'], [
        ['scripting', num(m.scriptingSelfMs), `incl. GC ${num(m.gcSelfMs)} ms`],
        ['rendering', num(m.renderingSelfMs), 'Layout + Style + HitTest + PrePaint'],
        ['painting (main)', num(m.paintingSelfMainThreadMs), 'Paint / Commit / Layerize'],
        ['loading', num(m.loadingSelfMs), 'ParseHTML / Resource*'],
        ['task overhead', num(m.taskOverheadSelfMs), 'RunTask self'],
        ['other', num(m.otherSelfMs), 'uncategorised (see event names below)'],
        ['= task total', num(m.mainThreadTaskTotalMs), `${num(m.cpuUtilizationPct)}% of window, idle ${num(m.cpuIdleMs)} ms`],
    ]));
    out.push('');
    out.push('-- off main thread --------------------------------------------------');
    out.push(renderTable(['bucket', 'self ms'], [
        ['raster / decode', num(m.rasterSelfMs)],
        ['gpu', num(m.gpuSelfMs)],
        ['worker scripting', num(m.workerScriptingSelfMs)],
        ['painting (all threads)', num(m.paintingSelfMs)],
    ]));
    out.push('');
    out.push('-- blocking ---------------------------------------------------------');
    out.push(renderTable(['metric', 'value'], [
        ['TBT (whole window)', `${num(m.tbtTotalMs)} ms`],
        ['TBT (FCP .. end)', m.tbtFromFcpMs === null ? '- (no FCP in trace)' : `${num(m.tbtFromFcpMs)} ms`],
        ['TBT (nav .. end)', m.tbtFromNavMs === null ? '-' : `${num(m.tbtFromNavMs)} ms`],
        ['long tasks (> 50 ms)', `${int(m.longTaskCount)}, ${num(m.longTaskTotalMs)} ms total, longest ${num(m.longestTaskMs)} ms`],
    ]));
    if (result.details.longTasks.length) {
        out.push('');
        out.push(renderTable(['#', 'start ms', 'dur ms', 'direct children'], result.details.longTasks.map((task, i) => [
            String(i + 1),
            num(task.startMs),
            num(task.durMs),
            task.children.length ? task.children.map(child => `${child.name} ${num(child.durMs)}`).join(', ') : '-',
        ])));
    }
    out.push('');
    out.push('-- layout / style ---------------------------------------------------');
    out.push(renderTable(['metric', 'count', 'total ms'], [
        ['Layout', int(m.layoutCount), num(m.layoutTotalMs)],
        ['  forced sync (inside JS)', int(m.forcedLayoutCount), num(m.forcedLayoutTotalMs)],
        ['  forced with JS stack', int(m.forcedLayoutWithStackCount), '-'],
        ['UpdateLayoutTree', int(m.updateLayoutTreeCount), num(m.updateLayoutTreeTotalMs)],
        ['  forced sync (inside JS)', int(m.forcedStyleRecalcCount), num(m.forcedStyleRecalcTotalMs)],
        ['HitTest', int(m.hitTestCount), num(m.hitTestMs)],
        ['PrePaint', int(m.prePaintCount), num(m.prePaintMs)],
        ['Paint', int(m.paintCount), num(m.paintMs)],
        ['LayoutInvalidationTracking', int(m.layoutInvalidationCount), '-'],
        ['ScheduleStyleRecalculation', int(m.styleRecalcInvalidationCount), '-'],
        ['dirtyObjects (sum)', int(m.layoutDirtyObjectsTotal), '-'],
    ]));
    out.push('');
    out.push('-- milestones -------------------------------------------------------');
    out.push(renderTable(['milestone', 'ms'], [
        ['navigationStart', num(m.navigationStartMs)],
        ['firstPaint', num(m.firstPaintMs)],
        ['FCP', num(m.fcpMs)],
        ['LCP', num(m.lcpMs)],
        ['DOMContentLoaded', num(m.dclMs)],
        ['load', num(m.loadMs)],
    ]));
    out.push('');
    out.push('-- frames -----------------------------------------------------------');
    out.push(renderTable(['metric', 'value'], [
        ['animation frames', int(m.animationFrameCount)],
        ['long animation frames (> 50 ms)', `${int(m.longAnimationFrameCount)} (${num(m.longAnimationFrameTotalMs)} ms)`],
        ['dropped frames', int(m.droppedFrameCount)],
        ['partial dropped frames', int(m.partialDroppedFrameCount)],
        ['drawn frames', int(m.drawFrameCount)],
    ]));
    if (result.details.userTiming.length) {
        out.push('');
        out.push('-- blink.user_timing measures ---------------------------------------');
        out.push(renderTable(['name', 'count', 'total ms', 'max ms'], result.details.userTiming
            .map(group => [group.name, int(group.count), num(group.totalMs), num(group.maxMs)])));
        out.push(`react/suite-matching: ${int(m.reactMeasureCount)} measures, ${num(m.reactMeasureTotalMs)} ms total, max ${num(m.reactMeasureMaxMs)} ms`);
    }
    if (result.details.marks.length) {
        out.push('');
        out.push(renderTable(['mark', 'count'], result.details.marks.map(mark => [mark.name, int(mark.count)])));
    }
    if (result.details.topJsFunctions.length) {
        out.push('');
        out.push('-- cpu profile (sampled JS self time) -------------------------------');
        out.push(`${int(m.jsSampleCount)} samples in window, ${num(m.jsSampledSelfMs)} ms attributed to JS frames`);
        out.push(renderTable(['function', 'self ms', 'source'], result.details.topJsFunctions
            .map(fn => [fn.fn, num(fn.selfMs), fn.url || '-'])));
    }
    out.push('');
    out.push('-- top self time by event name (main thread) ------------------------');
    out.push(renderTable(['event', 'category', 'count', 'self ms', 'total ms'], result.details.topEventNames
        .map(entry => [entry.name, entry.category, int(entry.count), num(entry.selfMs), num(entry.totalMs)])));
    out.push('');
    out.push('-- threads ----------------------------------------------------------');
    out.push(renderTable(['thread', 'kind', 'events'], result.details.threads
        .map(thread => [thread.thread, thread.kind, int(thread.events)])));
    out.push('');

    return out.join('\n');
};

// ---------------------------------------------------------------------------
// Percentiles / aggregate / compare
// ---------------------------------------------------------------------------

/** Nearest-rank percentile: idx = clamp(ceil(p/100 * n) - 1, 0, n - 1) on ascending values. */
const percentile = (sortedAsc, p) => {
    if (!sortedAsc.length) return null;
    const rank = Math.ceil((p / 100) * sortedAsc.length);

    return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
};

const collect = results => {
    const keys = [];
    const seen = new Set();
    for (const result of results) {
        for (const key of Object.keys(result.metrics)) {
            if (!seen.has(key)) {
                seen.add(key);
                keys.push(key);
            }
        }
    }
    const samples = new Map();
    for (const key of keys) {
        samples.set(key, results
            .map(result => result.metrics[key])
            .filter(value => typeof value === 'number' && Number.isFinite(value))
            .sort((a, b) => a - b));
    }

    return { keys, samples };
};

const renderAggregate = (results, p) => {
    const { keys, samples } = collect(results);
    const rows = keys.map(key => {
        const values = samples.get(key);

        return [
            key,
            String(values.length),
            num(percentile(values, 50)),
            num(percentile(values, p)),
            num(values[0] === undefined ? null : values[0]),
            num(values.length ? values[values.length - 1] : null),
        ];
    });

    return [
        '',
        `=== aggregate over ${results.length} trace(s) - p${p} is nearest-rank, no interpolation ===`,
        ...results.map((result, i) => `  [${i + 1}] ${result.label}  (${result.file})`),
        '',
        renderTable(['metric', 'n', 'p50', `p${p}`, 'min', 'max'], rows),
        '',
    ].join('\n');
};

const renderCompare = (groupA, groupB, p) => {
    const a = collect(groupA.results);
    const b = collect(groupB.results);
    const keys = [...new Set([...a.keys, ...b.keys])];
    const rows = keys.map(key => {
        const av = a.samples.get(key) || [];
        const bv = b.samples.get(key) || [];
        const ap = percentile(av, p);
        const bp = percentile(bv, p);
        const delta = ap === null || bp === null ? null
            : (ap === 0 ? (bp === 0 ? 0 : null) : ((bp - ap) / ap) * 100);

        return [
            key,
            num(percentile(av, 50)), num(ap),
            num(percentile(bv, 50)), num(bp),
            delta === null ? '-' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`,
        ];
    });

    return [
        '',
        `=== compare A(${groupA.results.length} traces) vs B(${groupB.results.length} traces) - nearest-rank p50/p${p}, delta = (B-A)/A on p${p} ===`,
        `  A = ${groupA.pattern}`,
        `  B = ${groupB.pattern}`,
        '',
        renderTable(['metric', 'A p50', `A p${p}`, 'B p50', `B p${p}`, `delta p${p}`], rows),
        '',
    ].join('\n');
};

// ---------------------------------------------------------------------------
// Tiny glob (no deps): supports *, ?, ** across path segments
// ---------------------------------------------------------------------------

const isTraceFile = file => /\.json(\.gz)?$/i.test(file);

const walkDir = (dir, out, depth = 0) => {
    if (depth > 8) return out;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full, out, depth + 1);
        else out.push(full);
    }

    return out;
};

const globToRe = pattern => {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === '*') {
            if (pattern[i + 1] === '*') {
                source += '.*';
                i += 1;
                if (pattern[i + 1] === '/') i += 1;
            } else source += '[^/]*';
        } else if (char === '?') source += '[^/]';
        else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }

    return new RegExp(`^${source}$`);
};

const expand = pattern => {
    if (!/[*?]/.test(pattern)) {
        if (fs.existsSync(pattern) && fs.statSync(pattern).isDirectory()) {
            return walkDir(pattern, []).filter(isTraceFile).sort();
        }

        return [pattern];
    }
    const abs = path.resolve(pattern);
    const base = abs.slice(0, abs.search(/[*?]/)).replace(/[^/]*$/, '') || '/';
    const re = globToRe(abs);

    return walkDir(base, []).filter(file => re.test(file)).sort();
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `analyze-trace.mjs - hard numbers out of raw Chrome DevTools traces (no npm deps)

  node analyze-trace.mjs <trace-file...> [--json] [--from=<ms>] [--to=<ms>] [--label=<name>]
                                        [--top=<n>] [--names=<n>]
  node analyze-trace.mjs --aggregate [--p=75] [--json] <trace-file...>
  node analyze-trace.mjs --compare '<a-glob>' '<b-glob>' [--p=75] [--json]

  --from/--to   window in ms, relative to navigationStart (or first trace event)
  --p           percentile for --aggregate/--compare (nearest-rank, default 75)
  --top         number of long tasks to list (default 10)
  --names       number of event names to list (default 12)
  --json        machine-readable output

  Quote globs so the shell does not expand them. Accepts .json and .json.gz.`;

const parseArgs = argv => {
    const opts = {
        files: [], json: false, from: null, to: null, label: null, top: 10, names: 12,
        aggregate: false, compare: null, p: 75, help: false,
    };
    const rest = [];
    for (const arg of argv) {
        if (arg === '--json') opts.json = true;
        else if (arg === '--aggregate') opts.aggregate = true;
        else if (arg === '--compare') opts.compare = [];
        else if (arg === '-h' || arg === '--help') opts.help = true;
        else if (arg.startsWith('--from=')) opts.from = Number(arg.slice(7));
        else if (arg.startsWith('--to=')) opts.to = Number(arg.slice(5));
        else if (arg.startsWith('--label=')) opts.label = arg.slice(8);
        else if (arg.startsWith('--top=')) opts.top = Number(arg.slice(6));
        else if (arg.startsWith('--names=')) opts.names = Number(arg.slice(8));
        else if (arg.startsWith('--p=')) opts.p = Number(arg.slice(4));
        else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
        else rest.push(arg);
    }
    for (const [flag, value] of [['--from', opts.from], ['--to', opts.to], ['--p', opts.p], ['--top', opts.top], ['--names', opts.names]]) {
        if (value !== null && !Number.isFinite(value)) throw new Error(`${flag} needs a number`);
    }
    if (opts.compare) {
        if (rest.length !== 2) throw new Error('--compare needs exactly two globs');
        opts.compare = rest;
    } else opts.files = rest;

    return opts;
};

const main = () => {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`${err.message}\n\n${USAGE}\n`);
        process.exit(2);
    }
    if (opts.help || (!opts.compare && !opts.files.length)) {
        process.stdout.write(`${USAGE}\n`);
        process.exit(opts.help ? 0 : 2);
    }

    const run = file => {
        try {
            return analyze(file, opts);
        } catch (err) {
            process.stderr.write(`error: ${file}: ${err.message}\n`);

            return null;
        }
    };

    if (opts.compare) {
        const groups = opts.compare.map(pattern => {
            const files = expand(pattern);
            if (!files.length) process.stderr.write(`warning: no files matched ${pattern}\n`);

            return { pattern, results: files.map(run).filter(Boolean) };
        });
        if (!groups[0].results.length || !groups[1].results.length) {
            process.stderr.write('error: --compare needs at least one parsable trace per side\n');
            process.exit(1);
        }
        if (opts.json) {
            const toJson = group => {
                const collected = collect(group.results);

                return {
                    pattern: group.pattern,
                    files: group.results.map(result => result.file),
                    p50: Object.fromEntries(collected.keys.map(key => [key, percentile(collected.samples.get(key), 50)])),
                    [`p${opts.p}`]: Object.fromEntries(collected.keys.map(key => [key, percentile(collected.samples.get(key), opts.p)])),
                };
            };
            process.stdout.write(`${JSON.stringify({ mode: 'compare', p: opts.p, a: toJson(groups[0]), b: toJson(groups[1]) }, null, 2)}\n`);
        } else {
            process.stdout.write(renderCompare(groups[0], groups[1], opts.p));
        }

        return;
    }

    const files = opts.files.flatMap(file => (/[*?]/.test(file) ? expand(file) : [file]));
    const results = files.map(run).filter(Boolean);
    if (!results.length) process.exit(1);

    if (opts.aggregate) {
        if (opts.json) {
            const collected = collect(results);
            const pick = p => Object.fromEntries(collected.keys.map(key => [key, percentile(collected.samples.get(key), p)]));
            process.stdout.write(`${JSON.stringify({
                mode: 'aggregate',
                p: opts.p,
                files: results.map(result => result.file),
                n: Object.fromEntries(collected.keys.map(key => [key, collected.samples.get(key).length])),
                p50: pick(50),
                [`p${opts.p}`]: pick(opts.p),
                min: Object.fromEntries(collected.keys.map(key => {
                    const values = collected.samples.get(key);

                    return [key, values.length ? values[0] : null];
                })),
                max: Object.fromEntries(collected.keys.map(key => {
                    const values = collected.samples.get(key);

                    return [key, values.length ? values[values.length - 1] : null];
                })),
            }, null, 2)}\n`);
        } else {
            process.stdout.write(renderAggregate(results, opts.p));
        }

        return;
    }

    if (opts.json) {
        process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);

        return;
    }
    results.forEach(result => process.stdout.write(renderReport(result)));
};

main();
