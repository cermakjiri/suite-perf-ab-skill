/**
 * Machine-wide locks, so several runs (several agents, several PRs) can share one machine without
 * measuring each other or building into the same tree.
 *
 * A lock is a directory $PERF_AB_HOME/locks/<name>/ with one ticket file per holder or waiter, named
 * by the time it was requested: the oldest live ticket holds the lock, the rest wait in that order
 * (FIFO). A ticket is live while its pid runs and its heartbeat (refreshed every 20 s) is younger
 * than 3 min; a dead or frozen one is removed by whoever finds it, so a killed process never wedges
 * the queue.
 *
 *   machine      one at a time per machine: every page session (run.mjs, any role) and every heavy
 *                build step (build.mjs). Two sessions at once, or a webpack build next to a timing
 *                session, would measure each other: the performance-core gate only sees what lands
 *                on the cores, not memory bandwidth or the shared caches. PERF_AB_SLOT=off (or
 *                --slot=off) skips it — the numbers are then not comparable with anything.
 *   clone-<name> one build per clone: two runs that need the same commit build it once.
 *   emulator     the trezor-user-env emulator: every session wipes and re-seeds it.
 *
 * Clone users: a session or exploration that serves a clone's build registers in
 * <clone>/.perf-ab-users/<pid>.json; build.mjs --rebuild refuses while a live one is there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { home, alive, sleep, tryJson, exists } from './lib.mjs';

const HEARTBEAT_MS = 20000;
const STALE_MS = 180000;

export const lockDir = name => path.join(home(), 'locks', name);
const ticketTime = id => Number(id.split('-')[0]);

/** Live tickets of a lock, oldest first (the first one holds it); dead and frozen tickets are removed. */
export const queue = name => {
    const dir = lockDir(name);
    if (!exists(dir)) return [];
    const now = Date.now();
    const live = [];
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const file = path.join(dir, f);
        const t = tryJson(file);
        const beat = t && Date.parse(t.heartbeatAt || t.requestedAt);
        // a ticket being written reads as null for an instant: young files are kept
        const young = (() => {
            try {
                return now - fs.statSync(file).mtimeMs < 5000;
            } catch {
                return false;
            }
        })();
        if (!t) {
            if (!young) fs.rmSync(file, { force: true });
            continue;
        }
        if (alive(t.pid) === false || (Number.isFinite(beat) && now - beat > STALE_MS)) {
            fs.rmSync(file, { force: true });
            continue;
        }
        live.push(Object.assign({ id: f.slice(0, -5) }, t));
    }

    return live.sort((a, b) => ticketTime(a.id) - ticketTime(b.id) || a.id.localeCompare(b.id));
};

/** "main-2-A of pr32496-dash (pid 4242) since 16:02" */
export const holderText = t => (t ? `${t.label || t.kind || 'a process'}${t.run ? ` of ${t.run}` : ''} (pid ${t.pid}) since ${new Date(t.acquiredAt || t.requestedAt).toTimeString().slice(0, 5)}` : 'nobody');

/**
 * Take a lock, waiting in line. info = { kind, run, label, ... } is shown to the others while they
 * wait. onWait({ ahead, holder, waitedMs }) is called on every poll while waiting. Returns
 * { waitedMs, release() }.
 */
export const acquire = async (name, info = {}, { onWait, pollMs = 400 } = {}) => {
    const dir = lockDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const id = `${String(t0).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(dir, `${id}.json`);
    const ticket = Object.assign({ pid: process.pid }, info, { requestedAt: new Date(t0).toISOString(), heartbeatAt: new Date(t0).toISOString() });
    const write = () => {
        ticket.heartbeatAt = new Date().toISOString();
        const tmp = `${file}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(ticket));
        fs.renameSync(tmp, file);
    };
    write();
    let released = false;
    const drop = () => {
        released = true;
        fs.rmSync(file, { force: true });
    };
    const beat = setInterval(() => {
        try {
            if (!released) write();
        } catch {
            // the next poll rewrites it
        }
    }, HEARTBEAT_MS);
    beat.unref();
    process.once('exit', drop);
    for (;;) {
        const q = queue(name);
        const pos = q.findIndex(t => t.id === id);
        // removed as stale (a long freeze): queue again with the same request time
        if (pos < 0) {
            write();
            continue;
        }
        if (pos === 0) break;
        if (onWait) onWait({ ahead: pos, holder: q[0], waitedMs: Date.now() - t0 });
        await sleep(pollMs);
    }
    ticket.acquiredAt = new Date().toISOString();
    write();

    return {
        name,
        waitedMs: Date.now() - t0,
        release() {
            if (released) return;
            clearInterval(beat);
            process.off('exit', drop);
            drop();
        },
    };
};

/** acquire, run fn, release — also when fn throws. */
export const withLock = async (name, info, opts, fn) => {
    const h = await acquire(name, info, opts);
    try {
        return await fn(h);
    } finally {
        h.release();
    }
};

/** Whether the machine slot is switched off for this process (--slot=off or PERF_AB_SLOT=off). */
export const slotOff = flag => flag === false || flag === 'off' || process.env.PERF_AB_SLOT === 'off';

// ------------------------------------------------------------------ clone users
/** The clone a build path lives in ($PERF_AB_HOME/clones/<name>/…), or null. */
export const cloneOf = p => {
    if (!p) return null;
    const root = path.join(home(), 'clones') + path.sep;
    const abs = path.resolve(p);
    if (!abs.startsWith(root)) return null;

    return path.join(root, abs.slice(root.length).split(path.sep)[0]);
};
/** Register this process as serving a clone's build; returns release(). */
export const useClone = (clone, info = {}) => {
    if (!clone) return () => {};
    const dir = path.join(clone, '.perf-ab-users');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(Object.assign({ pid: process.pid, since: new Date().toISOString() }, info)));
    const drop = () => fs.rmSync(file, { force: true });
    process.once('exit', drop);

    return () => {
        process.off('exit', drop);
        drop();
    };
};
/** Live processes serving a clone's build (dead entries are removed). */
export const cloneUsers = clone => {
    const dir = clone && path.join(clone, '.perf-ab-users');
    if (!dir || !exists(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const u = tryJson(path.join(dir, f));
        if (!u || alive(u.pid) === false || u.pid === process.pid) {
            if (!u || alive(u.pid) === false) fs.rmSync(path.join(dir, f), { force: true });
            continue;
        }
        out.push(u);
    }

    return out;
};
