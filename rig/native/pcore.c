/*
 * pcore — which core type a thread runs on (Apple silicon), for the suite-perf-ab rig.
 * Compiled on first use by rig/pcore.mjs (clang -O1) into $PERF_AB_HOME/bin/pcore-<source hash>.
 *
 *   pcore cores                        perf levels (hw.nperflevels, hw.perflevelN.*) and whether the
 *                                      per-thread counters work here
 *   pcore spin [--ms 500]              keep this thread busy at default QoS; its P/E split and P clock
 *                                      (the core-map check)
 *   pcore find --root <pid>            descendants of <pid> that have a CrRendererMain thread, with
 *                                      that thread's counters
 *   pcore watch --pid <pid> --tid <tid> [--interval-ms 20] [--scope thread|process]
 *                                      cumulative P/E ms and cycles, and the thread's base and current
 *                                      priority (PROC_PIDTHREADID64INFO pth_priority / pth_curpri), as
 *                                      JSON lines, every interval and at once, one line each, for every
 *                                      stdin "r" ("r":1 marks an answer); exits when stdin closes (4:
 *                                      unsupported layout)
 *
 * Per-thread counters come from a private proc_pidinfo flavor (PROC_PIDTHREADCOUNTS = 34, from XNU's
 * proc_info_private.h, not in the SDK): per perf level (0 = performance, 1 = efficiency)
 * instructions, cycles, user and system time in mach ticks. --scope process reads the public
 * proc_pid_rusage(RUSAGE_INFO_V6) for the whole process instead: ri_user_ptime + ri_system_ptime
 * and ri_pcycles against the totals, also in mach ticks on Apple silicon. Every per-thread read
 * checks the layout (an 8-byte header and one 40-byte record per perf level, as many as
 * hw.nperflevels): anything else is reported as unsupported, so the rig falls back instead of
 * reading efficiency time as 0. find lowers itself to background QoS, watch to utility.
 */
#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <pthread.h>
#include <pthread/qos.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define PROC_PIDLISTTHREADIDS 28
#define PROC_PIDTHREADCOUNTS 34

struct ptc_data { uint64_t instructions, cycles, user_mach, system_mach, energy_nj; };
struct ptc { uint16_t len, r0; uint32_t r1; struct ptc_data counts[4]; };
typedef struct { double p, e; uint64_t pc, ec; } sample_t;

static double tick_ms;
static int nlevels;
// what the last thread_sample() read, for the unsupported-layout message
static int last_ret, last_len;

// 0, -1 when the thread is gone, -2 when the private layout is not the one this file reads: an
// 8-byte header and one 40-byte record per perf level (the kernel truncates a short buffer silently)
static int thread_sample(pid_t pid, uint64_t tid, sample_t *s) {
    struct ptc c;
    memset(&c, 0, sizeof c);
    int ret = proc_pidinfo(pid, PROC_PIDTHREADCOUNTS, tid, &c, sizeof c);
    last_ret = ret;
    last_len = c.len;
    if (ret <= 0) return -1;
    if (nlevels < 2 || nlevels > 4 || c.len != nlevels || ret != 8 + c.len * (int)sizeof(struct ptc_data)) return -2;
    s->p = (double)(c.counts[0].user_mach + c.counts[0].system_mach) * tick_ms;
    s->e = (double)(c.counts[1].user_mach + c.counts[1].system_mach) * tick_ms;
    s->pc = c.counts[0].cycles;
    s->ec = c.counts[1].cycles;
    return 0;
}

static int process_sample(pid_t pid, sample_t *s) {
    struct rusage_info_v6 ri;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V6, (rusage_info_t *)&ri) != 0) return -1;
    double total = (double)(ri.ri_user_time + ri.ri_system_time) * tick_ms;
    s->p = (double)(ri.ri_user_ptime + ri.ri_system_ptime) * tick_ms;
    s->e = total - s->p;
    s->pc = ri.ri_pcycles;
    s->ec = ri.ri_cycles - ri.ri_pcycles;
    return 0;
}

static void json_str(const char *v) {
    putchar('"');
    for (; *v; v++) {
        if (*v == '"' || *v == '\\') putchar('\\');
        if ((unsigned char)*v >= 0x20) putchar(*v);
    }
    putchar('"');
}

static int cores(void) {
    int n = 0;
    size_t sz = sizeof n;
    if (sysctlbyname("hw.nperflevels", &n, &sz, NULL, 0) != 0) n = 0;
    printf("{\"nperflevels\":%d,\"levels\":[", n);
    for (int i = 0; i < n; i++) {
        char key[64], name[64] = "";
        int logical = 0, physical = 0;
        size_t s;
        snprintf(key, sizeof key, "hw.perflevel%d.name", i);
        s = sizeof name;
        sysctlbyname(key, name, &s, NULL, 0);
        snprintf(key, sizeof key, "hw.perflevel%d.logicalcpu", i);
        s = sizeof logical;
        sysctlbyname(key, &logical, &s, NULL, 0);
        snprintf(key, sizeof key, "hw.perflevel%d.physicalcpu", i);
        s = sizeof physical;
        sysctlbyname(key, &physical, &s, NULL, 0);
        printf("%s{\"name\":", i ? "," : "");
        json_str(name);
        printf(",\"logical\":%d,\"physical\":%d}", logical, physical);
    }
    uint64_t tid = 0;
    pthread_threadid_np(NULL, &tid);
    sample_t x;
    int r = thread_sample(getpid(), tid, &x);
    printf("],\"threadCounts\":%s", r == 0 ? "true" : "false");
    if (r != 0) printf(",\"threadCountsError\":\"%s (ret %d, len %d, nperflevels %d)\"", r == -2 ? "unsupported layout" : "refused", last_ret, last_len, nlevels);
    printf("}\n");

    return 0;
}

static int spin(int ms) {
    uint64_t tid = 0;
    pthread_threadid_np(NULL, &tid);
    sample_t a, b;
    if (thread_sample(getpid(), tid, &a) != 0) memset(&a, 0, sizeof a);
    uint64_t end = mach_absolute_time() + (uint64_t)(ms / tick_ms);
    volatile uint64_t x = 0;
    while (mach_absolute_time() < end) {
        for (int i = 0; i < 200000; i++) x += (uint64_t)i % 7;
    }
    if (thread_sample(getpid(), tid, &b) != 0) memset(&b, 0, sizeof b);
    double p = b.p - a.p, e = b.e - a.e;
    printf("{\"ms\":%d,\"p\":%.3f,\"e\":%.3f,\"pGHz\":%.3f}\n", ms, p, e, p > 0 ? (double)(b.pc - a.pc) / p / 1e6 : 0);

    return 0;
}

static int find(pid_t root) {
    int n = proc_listallpids(NULL, 0);
    if (n <= 0) return 1;
    n += 256;
    pid_t *pids = calloc((size_t)n, sizeof(pid_t));
    pid_t *ppids = calloc((size_t)n, sizeof(pid_t));
    char *mine = calloc((size_t)n, 1);
    n = proc_listallpids(pids, n * (int)sizeof(pid_t));
    for (int i = 0; i < n; i++) {
        struct proc_bsdinfo bi;
        ppids[i] = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &bi, sizeof bi) == sizeof bi ? (pid_t)bi.pbi_ppid : -1;
        mine[i] = pids[i] == root;
    }
    // descendants of root: repeat until no process joins
    for (int changed = 1; changed;) {
        changed = 0;
        for (int i = 0; i < n; i++) {
            if (mine[i] || ppids[i] <= 0) continue;
            for (int j = 0; j < n; j++) {
                if (mine[j] && pids[j] == ppids[i]) {
                    mine[i] = 1;
                    changed = 1;
                    break;
                }
            }
        }
    }
    uint64_t tids[1024];
    int first = 1;
    printf("[");
    for (int i = 0; i < n; i++) {
        if (!mine[i]) continue;
        int nt = proc_pidinfo(pids[i], PROC_PIDLISTTHREADIDS, 0, tids, sizeof tids) / (int)sizeof(uint64_t);
        for (int t = 0; t < nt; t++) {
            struct proc_threadinfo ti;
            memset(&ti, 0, sizeof ti);
            if (proc_pidinfo(pids[i], PROC_PIDTHREADID64INFO, tids[t], &ti, sizeof ti) <= 0) continue;
            if (strcmp(ti.pth_name, "CrRendererMain") != 0) continue;
            char name[256] = "";
            proc_name(pids[i], name, sizeof name);
            sample_t s, w;
            int ok = thread_sample(pids[i], tids[t], &s) == 0;
            int wok = process_sample(pids[i], &w) == 0;
            printf("%s{\"pid\":%d,\"tid\":%llu,\"name\":", first ? "" : ",", pids[i], (unsigned long long)tids[t]);
            json_str(name);
            if (ok) printf(",\"p\":%.3f,\"e\":%.3f", s.p, s.e);
            else printf(",\"p\":null,\"e\":null");
            // the whole process too: for the rusage fallback when the thread counters are refused
            if (wok) printf(",\"pp\":%.3f,\"pe\":%.3f}", w.p, w.e);
            else printf(",\"pp\":null,\"pe\":null}");
            first = 0;
        }
    }
    printf("]\n");

    return 0;
}

static int watch(pid_t pid, uint64_t tid, int interval, int whole) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    struct pollfd in = { .fd = 0, .events = POLLIN };
    uint64_t t0 = mach_absolute_time();
    char buf[256];
    for (;;) {
        int asked = 0;
        int r = poll(&in, 1, interval);
        if (r < 0 && errno != EINTR) return 1;
        if (r > 0) {
            ssize_t got = read(0, buf, sizeof buf);
            if (got <= 0) return 0;
            for (ssize_t i = 0; i < got; i++) asked += buf[i] == 'r';
        }
        // one line per "r" (each its own sample), or one periodic line
        for (int k = 0; k < (asked ? asked : 1); k++) {
            sample_t s;
            int got = whole ? process_sample(pid, &s) : thread_sample(pid, tid, &s);
            if (got == -2) {
                printf("{\"error\":\"unsupported per-thread counter layout (ret %d, len %d, nperflevels %d)\"}\n", last_ret, last_len, nlevels);
                return 4;
            }
            if (got != 0) {
                printf("{\"error\":\"%s %d is gone\"}\n", whole ? "process" : "thread of", pid);
                return 3;
            }
            // the thread's base priority (QoS, task policy, darwinbg) and its current one, -1 if unread
            struct proc_threadinfo ti;
            int pri = -1;
            int cur = -1;
            if (proc_pidinfo(pid, PROC_PIDTHREADID64INFO, tid, &ti, sizeof ti) == (int)sizeof ti) {
                pri = ti.pth_priority;
                cur = ti.pth_curpri;
            }
            printf("{\"t\":%.2f,\"p\":%.3f,\"e\":%.3f,\"pc\":%llu,\"ec\":%llu,\"pri\":%d,\"cur\":%d%s}\n", (double)(mach_absolute_time() - t0) * tick_ms, s.p, s.e,
                   (unsigned long long)s.pc, (unsigned long long)s.ec, pri, cur, asked ? ",\"r\":1" : "");
        }
    }
}

static const char *opt(int argc, char **argv, const char *name, const char *fallback) {
    for (int i = 2; i + 1 < argc; i++) if (strcmp(argv[i], name) == 0) return argv[i + 1];

    return fallback;
}

int main(int argc, char **argv) {
    mach_timebase_info_data_t tb;
    mach_timebase_info(&tb);
    tick_ms = (double)tb.numer / tb.denom / 1e6;
    size_t sz = sizeof nlevels;
    if (sysctlbyname("hw.nperflevels", &nlevels, &sz, NULL, 0) != 0) nlevels = 0;
    const char *mode = argc > 1 ? argv[1] : "";
    if (strcmp(mode, "cores") == 0) return cores();
    if (strcmp(mode, "spin") == 0) return spin(atoi(opt(argc, argv, "--ms", "500")));
    // the watcher stays off the thread it watches: utility QoS, not background, which a busy
    // machine starves (sample gaps of 110-180 ms with 12 spinners); its own CPU is negligible
    pthread_set_qos_class_self_np(strcmp(mode, "watch") == 0 ? QOS_CLASS_UTILITY : QOS_CLASS_BACKGROUND, 0);
    if (strcmp(mode, "find") == 0) return find(atoi(opt(argc, argv, "--root", "0")));
    if (strcmp(mode, "watch") == 0) {
        return watch(atoi(opt(argc, argv, "--pid", "0")), strtoull(opt(argc, argv, "--tid", "0"), NULL, 10),
                     atoi(opt(argc, argv, "--interval-ms", "20")), strcmp(opt(argc, argv, "--scope", "thread"), "process") == 0);
    }
    fprintf(stderr, "usage: pcore cores | spin [--ms 500] | find --root <pid> | watch --pid <pid> --tid <tid> [--interval-ms 20] [--scope thread|process]\n");

    return 2;
}
