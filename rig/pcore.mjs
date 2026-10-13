/**
 * Performance-core gate for measured iterations (macOS on Apple silicon).
 *
 * macOS cannot pin a thread (THREAD_AFFINITY_POLICY is not supported): placement follows QoS and
 * load, and a renderer main thread on an efficiency core runs 3.7-4.9x slower with a wide spread.
 * So instead of pinning, every measured iteration of a timing, control or trial pass (not counts,
 * not warm-up) passes a gate and runs under a watchdog:
 *   1. machine gate  `need` performance cores were >= 90 % idle over the last 0.5 s (os.cpus()
 *                    deltas sampled every 250 ms all session long, counted as idle capacity, with
 *                    this session's own renderer main thread left out: CDP CPU throttling keeps it
 *                    spinning (rate - 1)/rate of the time even when the page is idle);
 *   2. ready check   a fixed ~8 ms in-page spin ran >= 95 % on performance cores, at >= 85 % of this
 *                    machine's reference P clock for the CPU rate (the median of passing checks, kept
 *                    in $PERF_AB_HOME/machine.json), with the thread at its normal priority — which
 *                    also waits out the post-idle clock ramp; retried every 50 ms. Both share the
 *                    iteration's wait cap; a gate that cannot be met fails the session with the reason
 *                    (at once for a demoted thread or a low clock: waiting does not fix those);
 *   3. watchdog      the renderer main thread's judged efficiency-core time (Judge: E time in work
 *                    segments of >= 10 ms of CPU, all of it when throttled) counts against
 *                    max(maxEcoreMs, maxEcorePct % of its CPU) only where something pushed it there:
 *                    contention (under 1 performance core free, this thread left out, over the
 *                    100 ms up to the sample, or E-weighted over the whole iteration) or demotion (its
 *                    base priority below its normal one: the per-target floor in machine.json, or the
 *                    session's). A breach, or a watcher that dies, discards the iteration at once and
 *                    the runner retries it. E time with performance cores free at normal priority is
 *                    macOS's own placement: kept, and reported as the iteration's efficiency share.
 *                    Off in process scope.
 * The counters come from rig/native/pcore.c (a private proc_pidinfo flavor per thread, or the public
 * per-process rusage as a fallback), compiled with clang on first use and cached.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { RIG, home, tryJson, writeJsonSafe, sleep, median, dur } from './lib.mjs';

const SOURCE = path.join(RIG, 'native', 'pcore.c');
const TASKPOLICY = '/usr/sbin/taskpolicy';
// ~8 ms of CPU on a performance core: the calibration loop's body runs ~1.6e6 times per ms at 4 GHz
const READY_SPIN = 1.3e7;
const IDLE = 0.9;
const WINDOW_MS = 500;
const TICK_MS = 250;
const READY_SHARE = 0.95;
const READY_CLOCK = 0.85;
const READY_EVERY_MS = 50;
// passing ready checks a CPU rate (or a target's priority) needs before it is enforced, and how many are kept
const REF_MIN = 5;
const REF_KEEP = 25;
// the watchdog's work segments: >= 1 ms of CPU per 20 ms of sample interval, >= 10 ms of CPU each
const ACTIVE_MS = 1;
const SEGMENT_MS = 10;
const HEAD_MS = 5;
const ROLES_GATED = ['timing', 'control', 'trial'];
// contention: fewer performance cores free than this, over the 100 ms up to a sample or E-weighted
// over the iteration (the window misses bursts that fill the cores for less than 100 ms) — the
// latter once this much judged E time from this many samples has accumulated
const FREE_MIN = 1;
const FREE_WINDOW_MS = 100;
const MEAN_MIN_MS = 10;
const MEAN_MIN_SAMPLES = 3;
// demotion: a base priority below the renderer's normal one — the median of this target's passing
// ready checks in machine.json, else below the default QoS band
const PRI_FLOOR = 31;
// gate causes that waiting does not fix fail the session after this long
const DEMOTED_GRACE_MS = 30000;
const CLOCK_GRACE_MS = 60000;
// a core map the check could not verify (a busy machine) is checked again after this long
const RECHECK_MS = 10 * 60000;

/** Idle ms of the performance cores so far (os.cpus() ticks: 10 ms resolution per core). */
const idleOf = pIndices => {
    const cpus = os.cpus();

    return pIndices.reduce((sum, i) => sum + cpus[i].times.idle, 0);
};
/**
 * Free performance capacity in cores between two stamped samples: the performance cores' idle time
 * plus the watched thread's own P time (its share is not someone else's load), over the wall time.
 * The 10 ms ticks bound the error at 10 ms per core over the window: ±0.4 cores over 100 ms with 4.
 */
const freeOf = (a, b) => (a && b && a.idleP !== undefined && b.idleP !== undefined && b.at > a.at ? (b.idleP - a.idleP + (b.p - a.p)) / (b.at - a.at) : null);
const priOf = s => (s && typeof s.pri === 'number' && s.pri >= 0 ? s.pri : null);
const newTally = () => ({ e: 0, fe: 0, f: 0, min: Infinity, n: 0, counted: 0, contention: 0, cfe: 0, contentionFree: 0, demotion: 0 });
// judged sample intervals with E time: { e, interval, window, contended, demoted }
const tally = (sum, list) => {
    for (const x of list) {
        sum.e += x.e;
        sum.n += 1;
        if (x.interval !== null) {
            sum.f += x.interval * x.e;
            sum.fe += x.e;
        }
        if (x.window !== null) sum.min = Math.min(sum.min, x.window);
        if (x.contended || x.demoted) sum.counted += x.e;
        if (x.contended) {
            sum.contention += x.e;
            if (x.window !== null) {
                sum.contentionFree += x.window * x.e;
                sum.cfe += x.e;
            }
        }
        if (x.demoted) sum.demotion += x.e;
    }
};

/**
 * The watchdog's judgment of a thread's efficiency-core time, from the watcher's samples and their
 * real intervals (a busy machine makes them irregular). Consecutive samples in which the thread did
 * at least ~1 ms of CPU (per 20 ms of interval) form a work segment; efficiency time is judged only in
 * segments with at least 10 ms of CPU. Sustained work on efficiency cores is caught at any duty —
 * 40 % in 8 ms slices, 10 ms bursts split across samples — and isolated wake-ups are not. Under CPU
 * throttling (rate > 1) the throttle keeps the thread busy throughout, and all efficiency time is judged.
 * Judged time counts against the limit only where it ran under contention (under FREE_MIN performance
 * cores free over the 100 ms up to the sample, or E-weighted over the iteration; without os.cpus()
 * stamps contention cannot be told and never counts) or demoted (base priority below `basePri`, the
 * thread's normal one); the rest is macOS's own placement. `seed`: stamped samples from before the
 * iteration, so its first 100 ms are judged like the rest. Exported for the synthetic rule checks.
 */
export class Judge {
    constructor(throttled, basePri = null, seed = []) {
        this.throttled = throttled;
        this.basePri = basePri;
        this.minPri = basePri;
        this.all = 0;
        this.closed = 0;
        this.closedHead = 0;
        this.seg = { cpu: 0, e: 0, head: 0, samples: [] };
        // the judged samples with E time: free capacity next to them, and what counts against the limit
        this.sum = newTally();
        this.recent = seed.filter(s => s.at !== undefined).slice(-12);
    }
    step(a, b) {
        if (!this.recent.length || this.recent.at(-1) !== a) this.recent.push(a);
        this.recent.push(b);
        while (this.recent.length > 12) this.recent.shift();
        const pri = priOf(b);
        if (pri !== null && (this.minPri === null || pri < this.minPri)) this.minPri = pri;
        const e = b.e - a.e;
        const cpu = b.p - a.p + e;
        this.all += e;
        let x = null;
        if (e > 0) {
            const window = freeOf(this.recent.findLast(r => b.at - r.at >= FREE_WINDOW_MS) || this.recent[0], b);
            const pris = [priOf(a), pri].filter(v => v !== null);
            x = {
                e, interval: freeOf(a, b), window,
                contended: window !== null && window < FREE_MIN,
                demoted: this.basePri !== null && pris.length > 0 && Math.min(...pris) < this.basePri,
            };
        }
        if (this.throttled) {
            if (x) tally(this.sum, [x]);

            return;
        }
        if (cpu >= ACTIVE_MS * Math.max(1, (b.t - a.t) / 20)) {
            // diagnostic: efficiency time in a segment's first 5 ms of CPU (where a waking thread is placed)
            if (this.seg.cpu < HEAD_MS) this.seg.head += Math.min(e, HEAD_MS - this.seg.cpu);
            this.seg.cpu += cpu;
            this.seg.e += e;
            if (x) this.seg.samples.push(x);
        } else {
            if (this.seg.cpu >= SEGMENT_MS) {
                this.closed += this.seg.e;
                this.closedHead += this.seg.head;
                tally(this.sum, this.seg.samples);
            }
            this.seg = { cpu: 0, e: 0, head: 0, samples: [] };
        }
    }
    /** The tally of judged samples, an open segment included once it is judged. */
    current() {
        if (this.throttled || this.seg.cpu < SEGMENT_MS) return this.sum;
        const t = Object.assign({}, this.sum);
        tally(t, this.seg.samples);

        return t;
    }
    /** The E-weighted free capacity over the judged E time, once there is enough of it to go by. */
    meanFree(t = this.current()) {
        return t.fe > 0 && t.e >= MEAN_MIN_MS && t.n >= MEAN_MIN_SAMPLES ? t.f / t.fe : null;
    }
    /**
     * Free performance capacity (cores) next to the judged efficiency time — the E-weighted mean over
     * the sample intervals that had some, and the lowest 100 ms up to such a sample — or null (under
     * 1 ms of judged E time says nothing, or samples without os.cpus() stamps).
     */
    get freeP() {
        const t = this.current();

        return t.e >= 1 && t.fe > 0 ? { mean: t.f / t.fe, min: Number.isFinite(t.min) ? t.min : null, samples: t.n } : null;
    }
    /** Judged E ms that count against the limit: under contention (per sample, or the whole iteration) or demoted. */
    get countedMs() {
        const t = this.current();
        const mean = this.meanFree(t);

        return mean !== null && mean < FREE_MIN ? t.e : t.counted;
    }
    /** Why: E ms under contention (and the free capacity then), E ms demoted, the priorities. */
    get causes() {
        const t = this.current();
        const mean = this.meanFree(t);
        const whole = mean !== null && mean < FREE_MIN;

        return {
            contentionMs: whole ? Math.max(t.contention, t.e - t.demotion) : t.contention,
            contentionFree: whole ? mean : t.cfe > 0 ? t.contentionFree / t.cfe : null,
            demotionMs: t.demotion, basePri: this.basePri, minPri: this.minPri,
        };
    }
    /** Efficiency-core ms judged: in work segments (an open one included), or all when throttled. */
    get eMs() {
        return this.throttled ? this.all : this.closed + (this.seg.cpu >= SEGMENT_MS ? this.seg.e : 0);
    }
    /** Of those, the ms in the first 5 ms of CPU of their segments (diagnostic; 0 when throttled). */
    get headMs() {
        return this.throttled ? 0 : this.closedHead + (this.seg.cpu >= SEGMENT_MS ? this.seg.head : 0);
    }
}

const supported = () => process.platform === 'darwin' && process.arch === 'arm64';

let built = null;
/** The helper binary: compiled on first use into $PERF_AB_HOME/bin/pcore-<source hash>, then cached. */
export const helper = () => {
    if (built) return built;
    if (!supported()) throw new Error(`${process.platform}/${process.arch}: core types are told apart on macOS arm64 only`);
    const src = fs.readFileSync(SOURCE);
    const bin = path.join(home(), 'bin', `pcore-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}`);
    if (!fs.existsSync(bin)) {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        const tmp = `${bin}.${process.pid}.tmp`;
        try {
            execFileSync('clang', ['-O1', '-o', tmp, SOURCE], { stdio: ['ignore', 'pipe', 'pipe'] });
            fs.renameSync(tmp, bin);
        } catch (e) {
            fs.rmSync(tmp, { force: true });
            throw new Error(`cannot build ${SOURCE} with clang: ${String((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0]}`);
        }
    }
    built = bin;

    return bin;
};
const call = (...argv) => JSON.parse(execFileSync(helper(), argv, { encoding: 'utf8', timeout: 30000 }));

// ------------------------------------------------------------------ the machine
const machineFile = () => path.join(home(), 'machine.json');
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const busyMs = () => os.cpus().map(c => c.times.user + c.times.nice + c.times.sys + c.times.irq);
/**
 * This machine's core map, cached in machine.json: perf levels from sysctl, and which os.cpus()
 * indices are performance cores — checked: a default-QoS spin of the helper (it lands on performance
 * cores) must lift those indices, against an idle window of the same length. A check a busy machine
 * spoils falls back to the sysctl counts in efficiency-first order (Apple silicon's, verified on an
 * M4) with `verified: false`, and is tried again after RECHECK_MS.
 */
export const machine = async () => {
    // the OS release too: an update can change the private counter layout the helper checks
    const id = `${os.cpus()[0].model} x${os.cpus().length} ${os.platform()} ${os.release()}`;
    const cached = tryJson(machineFile());
    const same = cached && cached.id === id;
    if (same && cached.pIndices && (cached.verified !== false || Date.now() - Date.parse(cached.at) < RECHECK_MS)) return cached;
    const c = call('cores');
    if (c.nperflevels < 2) throw new Error(`one perf level on ${id}: no efficiency cores to stay off`);
    const nP = c.levels[0].logical;
    const nE = c.levels[1].logical;
    const orders = { 'efficiency-first': range(nE, nE + nP), 'performance-first': range(0, nP) };
    let found = null;
    let check = null;
    for (let tries = 0; tries < 3 && !found; tries++) {
        const b0 = busyMs();
        await sleep(600);
        const b1 = busyMs();
        const spin = call('spin', '--ms', '600');
        const b2 = busyMs();
        const lift = b2.map((v, i) => v - b1[i] - (b1[i] - b0[i]));
        const sum = idx => Math.round(idx.reduce((s, i) => s + lift[i], 0));
        for (const [order, p] of Object.entries(orders)) {
            const rest = range(0, nP + nE).filter(i => !p.includes(i));
            check = { order, spinPms: Math.round(spin.p), spinEms: Math.round(spin.e), spinGHz: spin.pGHz, liftPms: sum(p), liftEms: sum(rest) };
            if (sum(p) >= 0.5 * spin.p && sum(p) > 2 * Math.max(0, sum(rest))) {
                found = order;
                break;
            }
        }
    }
    const order = found || 'efficiency-first';
    const m = Object.assign({}, same ? cached : {}, {
        id, levels: c.levels, threadCounts: c.threadCounts, threadCountsError: c.threadCountsError || null, order, verified: !!found, pIndices: orders[order],
        check, spinGHz: check && check.spinGHz, ready: (same && cached.ready) || {}, pri: (same && cached.pri) || {}, at: new Date().toISOString(),
    });
    writeJsonSafe(machineFile(), m);

    return m;
};
/** The reference P clock for a CPU rate: the median of its recent passing ready checks. */
const refGHz = (m, rate) => (m.ready && m.ready[rate] && m.ready[rate].length >= REF_MIN ? median(m.ready[rate]) : null);
/** The renderer's normal base priority for a target (web | desktop): the median of its passing ready checks. */
const priFloor = (m, target) => (m.pri && m.pri[target] && m.pri[target].length >= REF_MIN ? median(m.pri[target]) : null);
// read again before writing: other sessions keep adding to machine.json
const learn = (m, key, sub, value) => {
    const now = tryJson(machineFile()) || m;
    const list = ((now[key] && now[key][sub]) || []).concat(value).slice(-REF_KEEP);
    m[key] = Object.assign({}, now[key], { [sub]: list });
    writeJsonSafe(machineFile(), Object.assign({}, now, { [key]: m[key] }));
};

// ------------------------------------------------------------------ free performance cores
/**
 * Idle capacity of the performance cores over the last 0.5 s, in cores: the sum of their idle
 * fractions (os.cpus() deltas). A thread that hops between cores spreads its load over all of
 * them, so cores are counted as capacity, 0.9 of a core per free core.
 */
class CoreSampler {
    constructor(pIndices) {
        this.p = pIndices;
        this.ring = [];
        this.timer = setInterval(() => this.sample(), TICK_MS).unref();
        this.sample();
    }
    sample() {
        this.ring.push({ t: Date.now(), cpus: os.cpus() });
        if (this.ring.length > 12) this.ring.shift();
    }
    /** { t0, t1, idle (cores) } over the last 0.5 s, or null until 0.5 s of samples exist. */
    window() {
        this.sample();
        const last = this.ring.at(-1);
        const old = this.ring.findLast(s => last.t - s.t >= WINDOW_MS - 25);
        if (!old) return null;
        let idle = 0;
        for (const i of this.p) {
            const a = old.cpus[i].times;
            const b = last.cpus[i].times;
            const total = b.idle - a.idle + (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
            if (total > 0) idle += (b.idle - a.idle) / total;
        }

        return { t0: old.t, t1: last.t, idle };
    }
    stop() {
        clearInterval(this.timer);
    }
}

// ------------------------------------------------------------------ one thread's counters
/**
 * `pcore watch` on one thread (or process), at utility QoS (background QoS is starved on a busy
 * machine): `latest` follows its 20 ms samples, read() asks for an exact one (stdin "r", one answer
 * line each), `listener` sees every sample, `recent` keeps the last dozen. With `pIndices` every
 * sample gets an os.cpus() stamp (~10 µs) for the free capacity. A read that times out marks the
 * watcher broken (the gate looks for the renderer again); `onDeath` hears at once when it exits.
 * Closing stdin ends it, so it dies with the session.
 */
class Watch {
    constructor({ pid, tid, scope, pIndices = null, intervalMs = 20 }) {
        const argv = ['watch', '--pid', String(pid), '--tid', String(tid), '--interval-ms', String(intervalMs), '--scope', scope];
        this.child = fs.existsSync(TASKPOLICY)
            ? spawn(TASKPOLICY, ['-c', 'utility', helper(), ...argv], { stdio: ['pipe', 'pipe', 'ignore'] })
            : spawn(helper(), argv, { stdio: ['pipe', 'pipe', 'ignore'] });
        this.latest = null;
        this.error = null;
        this.listener = null;
        this.onDeath = null;
        this.stamp = pIndices;
        this.recent = [];
        this.waiters = [];
        // recent samples on Node's clock, for the thread's P time over a window
        this.hist = [];
        let buf = '';
        this.child.stdout.on('data', d => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                this.line(buf.slice(0, i));
                buf = buf.slice(i + 1);
            }
        });
        this.child.stdin.on('error', () => {});
        this.child.on('exit', code => {
            this.error ??= `the counter watcher exited (${code})`;
            for (const w of this.waiters.splice(0)) w.reject(new Error(this.error));
            const dead = this.onDeath;
            this.onDeath = null;
            if (dead) dead(this.error);
        });
    }
    line(text) {
        let s;
        try {
            s = JSON.parse(text);
        } catch {
            return;
        }
        if (s.error) {
            this.error = s.error;

            return;
        }
        if (this.stamp) {
            s.at = Date.now();
            s.idleP = idleOf(this.stamp);
        }
        this.latest = s;
        this.recent.push(s);
        if (this.recent.length > 12) this.recent.shift();
        this.hist.push({ at: Date.now(), p: s.p });
        if (this.hist.length > 150) this.hist.shift();
        if (s.r && this.waiters.length) this.waiters.shift().resolve(s);
        if (this.listener) this.listener(s);
    }
    /** The thread's P ms between two Node timestamps (from its 20 ms samples). */
    pBetween(t0, t1) {
        const at = t => this.hist.findLast(h => h.at <= t) || this.hist[0];
        const a = at(t0);
        const b = at(t1);

        return a && b ? Math.max(0, b.p - a.p) : 0;
    }
    read() {
        if (this.error) return Promise.reject(new Error(this.error));
        const { promise, resolve, reject } = Promise.withResolvers();
        const w = {};
        const timer = setTimeout(() => {
            // drop the waiter, or its late answer would land on the next read; the watcher is broken
            const at = this.waiters.indexOf(w);
            if (at >= 0) this.waiters.splice(at, 1);
            this.error ??= 'the counter watcher did not answer within 3 s';
            this.close();
            reject(new Error(this.error));
        }, 3000);
        w.resolve = s => {
            clearTimeout(timer);
            resolve(s);
        };
        w.reject = e => {
            clearTimeout(timer);
            reject(e);
        };
        this.waiters.push(w);
        this.child.stdin.write('r\n');

        return promise;
    }
    close() {
        this.listener = null;
        this.onDeath = null;
        this.child.stdin.end();
        setTimeout(() => this.child.kill(), 1000).unref();
    }
}

// ------------------------------------------------------------------ the session's gate
export class Pcore {
    /** o = { mode, role, target, need, maxWaitMs, maxEcoreMs, maxEcorePct, retries, root, log } */
    constructor(o) {
        this.o = o;
        this.meta = {
            enabled: false, reason: null, mode: o.mode, role: o.role, target: o.target, scope: null, watchdog: false, renderer: null,
            thresholds: { need: o.need, maxWaitS: Math.round(o.maxWaitMs / 1000), maxEcoreMs: o.maxEcoreMs, maxEcorePct: o.maxEcorePct, retries: o.retries },
            gateWaitMs: 0, readyAttempts: 0, timeouts: 0, priFloor: null, normalPri: null, discards: [], kept: [],
        };
    }
    get on() {
        return this.meta.enabled;
    }
    /** Decide on or off (with the reason in meta), build the helper, map the cores, start sampling. */
    async init() {
        const off = reason => {
            this.meta.reason = reason;

            return false;
        };
        if (this.o.mode === 'off') return off('--pcore=off');
        if (!ROLES_GATED.includes(this.o.role)) return off(`${this.o.role} pass: never gated`);
        try {
            this.machine = await machine();
        } catch (e) {
            this.o.log(`pcore: off — ${e.message}`);

            return off(e.message);
        }
        // a configuration this machine cannot meet is an error, not a reason to run ungated
        if (this.machine.pIndices && this.o.need > this.machine.pIndices.length) throw new Error(`--pcore-free=${this.o.need}, but this machine has ${this.machine.pIndices.length} performance cores`);
        this.meta.scope = this.machine.threadCounts ? 'thread' : 'process';
        // process scope: GC, IO and compositor threads run on efficiency cores routinely, so a move of
        // the main thread cannot be told apart — the ready check stays, the watchdog does not
        this.meta.watchdog = this.meta.scope === 'thread';
        if (!this.machine.threadCounts) this.o.log(`pcore: per-thread counters unavailable (${this.machine.threadCountsError || 'refused'}) — ready check on the renderer process; moves to efficiency cores during an iteration cannot be detected (no watchdog)`);
        if (this.machine.pIndices) {
            this.sampler = new CoreSampler(this.machine.pIndices);
            if (this.machine.verified === false) this.o.log(`pcore: the core-map check did not come out clear (${JSON.stringify(this.machine.check)}; a busy machine?) — assuming performance cores are os.cpus() ${this.machine.pIndices.join(',')} (efficiency-first), checked again later`);
        } else {
            this.o.log('pcore: no core map — machine gate off, and contention cannot be judged: only demotions discard');
        }
        // anything below the renderer's normal priority for this target is a demotion, from the start
        this.meta.priFloor = priFloor(this.machine, this.o.target) ?? PRI_FLOOR;
        this.meta.machine = { order: this.machine.order, verified: this.machine.verified !== false, pIndices: this.machine.pIndices, spinGHz: this.machine.spinGHz };
        this.meta.enabled = true;

        return true;
    }
    /** The priority below which the thread counts as demoted: the target's floor, or the session's normal one if higher. */
    basePri() {
        return Math.max(this.meta.priFloor ?? PRI_FLOOR, this.meta.normalPri ?? -1);
    }
    /**
     * The renderer main thread to watch: the CrRendererMain under this session. With several, or
     * `force` (the watched one did not run the ready spin), the one whose main thread ran a test spin.
     */
    async renderer(ev, force = false) {
        if (this.watch && !this.watch.error && !force) return;
        if (this.watch && this.watch.error) this.o.log(`pcore: ${this.watch.error} — looking for the renderer again`);
        if (this.watch) this.watch.close();
        this.watch = null;
        const cpu = x => (this.meta.scope === 'thread' ? (x.p || 0) + (x.e || 0) : (x.pp || 0) + (x.pe || 0));
        const before = call('find', '--root', String(this.o.root));
        if (!before.length) throw new Error(`no CrRendererMain thread under pid ${this.o.root}`);
        let chosen = before[0];
        if (before.length > 1 || force) {
            // a spare renderer or another window: the one that runs our spin is the page's
            await ev(n => window.__H.busy(n), READY_SPIN * 3);
            const after = call('find', '--root', String(this.o.root));
            const grew = after.map(a => ({ a, d: cpu(a) - cpu(before.find(b => b.pid === a.pid && b.tid === a.tid) || {}) })).sort((x, y) => y.d - x.d);
            if (!grew.length || grew[0].d < 5) throw new Error('no renderer main thread under this session ran the test spin');
            chosen = grew[0].a;
        }
        this.watch = new Watch({ pid: chosen.pid, tid: chosen.tid, scope: this.meta.scope, pIndices: this.machine.pIndices });
        await this.watch.read();
        this.meta.renderer = { pid: chosen.pid, tid: chosen.tid, name: chosen.name, candidates: before.length };
    }
    async readyCheck(ev, rate) {
        const before = await this.watch.read();
        await ev(n => window.__H.busy(n), READY_SPIN);
        const after = await this.watch.read();
        const p = after.p - before.p;
        const e = after.e - before.e;
        const share = p + e > 0 ? p / (p + e) : 0;
        const ghz = p > 0 ? (after.pc - before.pc) / p / 1e6 : 0;
        const ref = refGHz(this.machine, rate);
        const pri = priOf(after);
        const demoted = pri !== null && pri < this.basePri();
        const onP = share >= READY_SHARE;
        const clockOk = ref === null || ghz >= READY_CLOCK * ref;
        const pass = onP && clockOk && !demoted;
        if (pass) {
            learn(this.machine, 'ready', rate, +ghz.toFixed(3));
            if (pri !== null) {
                learn(this.machine, 'pri', this.o.target, pri);
                this.meta.normalPri = Math.max(this.meta.normalPri ?? -1, pri);
            }
        }

        return { pass, onP, clockOk, demoted, pri, share: +share.toFixed(3), ghz: +ghz.toFixed(2), ref: ref && +ref.toFixed(2), cpuMs: +(p + e).toFixed(1), after };
    }
    /**
     * Free performance cores (>= 90 % idle) over the last 0.5 s, this session's own renderer main
     * thread left out: under CDP CPU throttling it spins in a signal handler for (rate - 1)/rate of
     * the time, even with the page idle (0.75 of a core at 4x), and that is not someone else's load.
     */
    freeCores() {
        const w = this.sampler.window();
        if (!w) return null;
        const own = this.watch ? this.watch.pBetween(w.t0, w.t1) / (w.t1 - w.t0) : 0;

        return Math.min(this.machine.pIndices.length, Math.floor((w.idle + own) / IDLE + 1e-6));
    }
    /**
     * Before a measured iteration: the machine gate, then the ready check, until both pass. When
     * they cannot be met — the wait cap `budgetMs` (what is left of the iteration's) runs out, the
     * thread stays demoted for 30 s or its clock stays low for 60 s — `timeout` is set with the
     * `reason`, and the caller fails the session rather than measure off the performance cores. A
     * ready check that reads ~0 ms of CPU watched the wrong thread: the renderer is looked for again.
     * onWait({ stage, free, total, since, attempts }) reports waiting. Returns
     * { base, waitMs, attempts, timeout, reason, check }.
     */
    async gate({ ev, rate, budgetMs, onWait }) {
        await this.renderer(ev);
        const t0 = Date.now();
        const total = this.sampler ? this.machine.pIndices.length : null;
        let attempts = 0;
        let reason = null;
        let lookedAgain = 0;
        let check = null;
        let free = null;
        let demotedSince = null;
        let lowClockSince = null;
        for (;;) {
            if (this.sampler) {
                for (;;) {
                    free = this.freeCores();
                    if (free !== null && free >= this.o.need) break;
                    if (Date.now() - t0 >= budgetMs) {
                        reason = `performance cores busy for ${dur(Date.now() - t0)} (${free ?? '?'} of ${total} free, ${this.o.need} needed)`;
                        break;
                    }
                    onWait({ stage: 'pcore-wait', free, total, need: this.o.need, since: t0, attempts });
                    await sleep(TICK_MS);
                }
                if (reason) break;
            }
            attempts += 1;
            check = await this.readyCheck(ev, rate);
            if (check.cpuMs < 1) {
                if (++lookedAgain > 2) throw new Error(`the watched renderer thread does not run the page (ready spin read ${check.cpuMs} ms after looking again twice)`);
                this.o.log(`pcore: the watched thread (pid ${this.meta.renderer.pid}) did not run the ready spin — looking for the renderer again`);
                await this.renderer(ev, true);
                continue;
            }
            if (check.pass) break;
            const now = Date.now();
            demotedSince = check.demoted ? demotedSince ?? now : null;
            lowClockSince = check.onP && !check.clockOk ? lowClockSince ?? now : null;
            if (demotedSince !== null && now - demotedSince >= DEMOTED_GRACE_MS) reason = `the renderer main thread is demoted (priority ${check.pri}, normal ${this.basePri()}) — a hidden or occluded window, App Nap or a background policy (taskpolicy -b)`;
            else if (lowClockSince !== null && now - lowClockSince >= CLOCK_GRACE_MS) reason = `the performance-core clock stays low (${check.ghz} GHz, under ${Math.round(READY_CLOCK * 100)} % of this machine's ${check.ref} GHz) — Low Power Mode or thermal throttling?`;
            else if (now - t0 >= budgetMs) reason = `the ready spin kept running on efficiency cores for ${dur(now - t0)} (last ${Math.round(check.share * 100)} % on P at priority ${check.pri ?? '?'})`;
            if (reason) break;
            onWait({ stage: 'ready', attempts, since: t0, share: check.share, ghz: check.ghz, ref: check.ref });
            await sleep(READY_EVERY_MS);
        }
        const waitMs = Date.now() - t0;
        this.meta.gateWaitMs += waitMs;
        this.meta.readyAttempts += attempts;
        if (reason) this.meta.timeouts += 1;

        return { base: check && check.after, waitMs, attempts, timeout: !!reason, reason, check };
    }
    /**
     * The main thread since `base`: E ms (all, judged, and counted — under contention or demoted —
     * with the cause split), CPU ms, its efficiency shares, the limit the counted part is held to
     * (2 % of `expectedCpuMs` while streaming, if that is more than the CPU so far), the free
     * performance capacity in cores (this thread left out) over the whole window (freeP) and next to
     * the judged E time (eFreeP E-weighted, eFreeMinP the lowest 100 ms), and its base priority
     * baseline and the lowest since.
     */
    measure(base, s, expectedCpuMs = 0) {
        const eMs = s.e - base.e;
        const pMs = s.p - base.p;
        const cpuMs = pMs + eMs;
        const round1 = v => (v === null || v === undefined ? null : +v.toFixed(1));
        const round2 = v => (v === null || v === undefined ? null : +v.toFixed(2));
        const j = this.judge;
        const free = j ? j.freeP : null;
        const why = j ? j.causes : {};
        const judged = j ? j.eMs : 0;

        return {
            eMs: +eMs.toFixed(1), eJudgedMs: +judged.toFixed(1), eCountedMs: +(j ? j.countedMs : 0).toFixed(1), eHeadMs: +(j ? j.headMs : 0).toFixed(1), pMs: +pMs.toFixed(1), cpuMs: +cpuMs.toFixed(1),
            eSharePct: cpuMs > 0 ? round2((100 * eMs) / cpuMs) : null, eJudgedSharePct: cpuMs > 0 ? round2((100 * judged) / cpuMs) : null,
            eContentionMs: round1(why.contentionMs ?? 0), contentionFreeP: round2(why.contentionFree), eDemotionMs: round1(why.demotionMs ?? 0), basePri: why.basePri ?? null, minPri: why.minPri ?? null,
            limit: Math.max(this.o.maxEcoreMs, (this.o.maxEcorePct / 100) * Math.max(cpuMs, expectedCpuMs || 0)), pGHz: pMs > 0 ? +((s.pc - base.pc) / pMs / 1e6).toFixed(2) : null,
            freeP: round2(freeOf(base, s)), eFreeP: round2(free && free.mean), eFreeMinP: round2(free && free.min), eSamples: free ? free.samples : 0,
        };
    }
    /**
     * Watch the iteration at CPU `rate`: onBreach(x) at the first sample whose counted E time (under
     * contention or demoted) is over the limit — judged against the rate's expected CPU (the median of
     * this session's kept iterations at the rate), so an early burst is held to what the end of the
     * iteration would allow — or at once with { watcher } when the watcher dies.
     */
    arm(base, rate, onBreach) {
        this.base = base;
        this.judge = new Judge(rate > 1, this.basePri(), this.watch.recent.filter(s => s !== base && s.at <= base.at));
        const expected = median(this.meta.kept.filter(k => k.rate === rate).map(k => k.cpuMs)) ?? 0;
        let prev = base;
        const breach = x => {
            this.watch.listener = null;
            this.watch.onDeath = null;
            onBreach(x);
        };
        this.watch.listener = s => {
            this.judge.step(prev, s);
            prev = s;
            if (!this.meta.watchdog) return;
            const x = this.measure(base, s, expected);
            if (x.eCountedMs > x.limit) breach(x);
        };
        this.watch.onDeath = error => breach({ watcher: error });
        this.prev = () => prev;
    }
    /**
     * End of the iteration's measured part: an exact sample, and whether it stayed on performance
     * cores. Throws when the watcher failed (the caller discards the iteration; the next gate looks
     * for the renderer again).
     */
    async disarm() {
        const prev = this.prev();
        this.watch.listener = null;
        this.watch.onDeath = null;
        const s = await this.watch.read();
        this.judge.step(prev, s);
        const x = this.measure(this.base, s);
        x.breach = this.meta.watchdog && x.eCountedMs > x.limit;

        return x;
    }
    close() {
        if (this.sampler) this.sampler.stop();
        if (this.watch) this.watch.close();
    }
}
