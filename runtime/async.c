/**
 * CodeLang Async runtime — pthreads-based concurrency primitives.
 *
 * Provides:
 *   Task     — heap-allocated pthread_t wrapper; returned by async_spawn_task.
 *   Context  — immutable linked-list of string key-value pairs (Go-style context).
 *   Shared   — mutex wrapper for mutual-exclusion locks.
 *   Scheduler— priority-queue scheduler (3 levels; WICG-inspired).
 *   Timers   — setTimeout / setInterval backed by a dedicated timer thread.
 *
 * Compile: clang -O2 -lpthread   (Linux / macOS)
 *          macOS: no extra flags; pthreads is in libSystem.
 */

#include <pthread.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <stdint.h>

/* On Linux, nanosleep needs _POSIX_C_SOURCE; on macOS it's always available. */
#ifndef _POSIX_C_SOURCE
#  define _POSIX_C_SOURCE 199309L
#endif

/* ── Fat-pointer ABI ─────────────────────────────────────────────────────────
 * CodeLang function values use a two-field struct { fn_ptr, env_ptr }.
 * On x86-64 (System V) and AArch64, a 16-byte struct of two pointer-size
 * fields is passed in two integer registers — identical to (void*, void*).
 * We therefore represent it as a C struct for readability.
 */
typedef struct {
    void (*fn)(void *env);
    void  *env;
} FatPtr;

/* ── Task ─────────────────────────────────────────────────────────────────── */

typedef struct {
    pthread_t thread;
    int       active;   /* 1 while the thread is running */
} Task;

typedef struct {
    FatPtr fp;
} ThreadArg;

static void *thread_entry(void *arg) {
    ThreadArg *ta = (ThreadArg *)arg;
    ta->fp.fn(ta->fp.env);
    free(ta);
    return NULL;
}

Task *async_spawn_task(FatPtr fp) {
    Task      *t  = (Task *)malloc(sizeof(Task));
    ThreadArg *ta = (ThreadArg *)malloc(sizeof(ThreadArg));
    ta->fp       = fp;
    t->active    = 1;
    pthread_create(&t->thread, NULL, thread_entry, ta);
    return t;
}

void async_wait_task(Task *t) {
    if (t && t->active) {
        pthread_join(t->thread, NULL);
        t->active = 0;
    }
}

void async_task_free(Task *t) {
    if (t) free(t);
}

/* ── Sleep ───────────────────────────────────────────────────────────────── */

void async_sleep_ms(int32_t ms) {
    if (ms <= 0) return;
    struct timespec ts;
    ts.tv_sec  = (time_t)(ms / 1000);
    ts.tv_nsec = (long)((ms % 1000) * 1000000L);
    nanosleep(&ts, NULL);
}

/* ── AsyncContext ─────────────────────────────────────────────────────────── */

typedef struct AsyncContext {
    struct AsyncContext *parent;
    char                *key;
    char                *value;
} AsyncContext;

AsyncContext *context_background(void) {
    AsyncContext *ctx = (AsyncContext *)malloc(sizeof(AsyncContext));
    ctx->parent = NULL;
    ctx->key    = NULL;
    ctx->value  = NULL;
    return ctx;
}

/* Returns a new child context with (key, value) attached.
 * The parent chain is shared (immutable), so no copying is needed. */
AsyncContext *context_with_value(AsyncContext *parent, const char *key, const char *value) {
    AsyncContext *ctx = (AsyncContext *)malloc(sizeof(AsyncContext));
    ctx->parent = parent;
    ctx->key    = strdup(key   ? key   : "");
    ctx->value  = strdup(value ? value : "");
    return ctx;
}

/* Walk the parent chain to find the most-recently-set value for key. */
const char *context_get(AsyncContext *ctx, const char *key) {
    for (AsyncContext *c = ctx; c != NULL; c = c->parent) {
        if (c->key && strcmp(c->key, key) == 0) return c->value;
    }
    return "";   /* not found — return empty string (never NULL) */
}

/* ── Shared (mutex) ──────────────────────────────────────────────────────── */

typedef struct {
    pthread_mutex_t mutex;
} Shared;

Shared *shared_new(void) {
    Shared *s = (Shared *)malloc(sizeof(Shared));
    pthread_mutex_init(&s->mutex, NULL);
    return s;
}

void shared_lock(Shared *s) {
    if (s) pthread_mutex_lock(&s->mutex);
}

void shared_unlock(Shared *s) {
    if (s) pthread_mutex_unlock(&s->mutex);
}

void shared_free(Shared *s) {
    if (s) {
        pthread_mutex_destroy(&s->mutex);
        free(s);
    }
}

/* ── Scheduler (WICG-inspired priority queue) ────────────────────────────── */
/*
 * Priorities (smaller = higher priority):
 *   0 → user-blocking   (run ASAP on a dedicated thread)
 *   1 → user-visible    (default priority)
 *   2 → background      (run when idle)
 *
 * Tasks are dispatched to a pool of 3 worker threads (one per priority level).
 * Each worker runs its own FIFO queue protected by a mutex/cond pair.
 */

/* 5 priority levels matching the CodeLang Priority enum:
 *   0 = Highest  (user-blocking, run ASAP)
 *   1 = High     (above default)
 *   2 = Medium   (default)
 *   3 = Low      (below default)
 *   4 = Lowest   (background idle)  */
#define SCHED_PRIORITIES  5
#define SCHED_QUEUE_CAP  64

typedef struct {
    FatPtr  tasks[SCHED_QUEUE_CAP];
    int     head;
    int     tail;
    int     count;
    int     shutdown;
    pthread_mutex_t mu;
    pthread_cond_t  cv;
} SchedQueue;

typedef struct {
    SchedQueue queues[SCHED_PRIORITIES];
    pthread_t  workers[SCHED_PRIORITIES];
} Scheduler;

static void *sched_worker(void *arg) {
    SchedQueue *q = (SchedQueue *)arg;
    for (;;) {
        pthread_mutex_lock(&q->mu);
        while (q->count == 0 && !q->shutdown)
            pthread_cond_wait(&q->cv, &q->mu);
        if (q->shutdown && q->count == 0) {
            pthread_mutex_unlock(&q->mu);
            return NULL;
        }
        FatPtr fp  = q->tasks[q->head];
        q->head    = (q->head + 1) % SCHED_QUEUE_CAP;
        q->count--;
        pthread_mutex_unlock(&q->mu);
        fp.fn(fp.env);
    }
}

Scheduler *scheduler_new(void) {
    Scheduler *s = (Scheduler *)calloc(1, sizeof(Scheduler));
    for (int i = 0; i < SCHED_PRIORITIES; i++) {
        SchedQueue *q = &s->queues[i];
        q->head     = 0;
        q->tail     = 0;
        q->count    = 0;
        q->shutdown = 0;
        pthread_mutex_init(&q->mu, NULL);
        pthread_cond_init(&q->cv, NULL);
        pthread_create(&s->workers[i], NULL, sched_worker, q);
    }
    return s;
}

/* priority: 0 = user-blocking, 1 = user-visible, 2 = background */
void scheduler_post_task(Scheduler *s, FatPtr fp, int32_t priority) {
    if (!s) return;
    int p = (priority < 0) ? 0 : (priority >= SCHED_PRIORITIES ? SCHED_PRIORITIES - 1 : priority);
    SchedQueue *q = &s->queues[p];
    pthread_mutex_lock(&q->mu);
    if (q->count < SCHED_QUEUE_CAP) {
        q->tasks[q->tail] = fp;
        q->tail  = (q->tail + 1) % SCHED_QUEUE_CAP;
        q->count++;
        pthread_cond_signal(&q->cv);
    }
    pthread_mutex_unlock(&q->mu);
}

void scheduler_wait_all(Scheduler *s) {
    if (!s) return;
    for (int i = 0; i < SCHED_PRIORITIES; i++) {
        SchedQueue *q = &s->queues[i];
        /* Spin until queue is empty (simple, good enough for tests). */
        for (;;) {
            pthread_mutex_lock(&q->mu);
            int empty = (q->count == 0);
            pthread_mutex_unlock(&q->mu);
            if (empty) break;
            struct timespec ts = { 0, 1000000L }; /* 1 ms */
            nanosleep(&ts, NULL);
        }
    }
}

void scheduler_free(Scheduler *s) {
    if (!s) return;
    for (int i = 0; i < SCHED_PRIORITIES; i++) {
        SchedQueue *q = &s->queues[i];
        pthread_mutex_lock(&q->mu);
        q->shutdown = 1;
        pthread_cond_signal(&q->cv);
        pthread_mutex_unlock(&q->mu);
        pthread_join(s->workers[i], NULL);
        pthread_mutex_destroy(&q->mu);
        pthread_cond_destroy(&q->cv);
    }
    free(s);
}

/* ── Timer thread infrastructure ─────────────────────────────────────────── */

#define MAX_TIMERS 128

typedef struct {
    int      id;
    int      active;
    int      repeat;      /* 1 = interval, 0 = one-shot */
    int32_t  interval_ms;
    FatPtr   fp;
    int64_t  fire_at_ms;  /* monotonic ms */
} TimerEntry;

static TimerEntry  g_timers[MAX_TIMERS];
static pthread_t   g_timer_thread;
static pthread_mutex_t g_timer_mu  = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_timer_cv  = PTHREAD_COND_INITIALIZER;
static int         g_timer_shutdown = 0;
static int         g_timer_next_id  = 1;
static int         g_timer_initialized = 0;

static int64_t mono_now_ms(void) {
    struct timespec ts;
#ifdef CLOCK_MONOTONIC
    clock_gettime(CLOCK_MONOTONIC, &ts);
#else
    clock_gettime(CLOCK_REALTIME, &ts);
#endif
    return (int64_t)ts.tv_sec * 1000LL + (int64_t)(ts.tv_nsec / 1000000LL);
}

static void *timer_thread_fn(void *arg) {
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&g_timer_mu);
        if (g_timer_shutdown) { pthread_mutex_unlock(&g_timer_mu); break; }

        /* Find the earliest timer */
        int64_t now     = mono_now_ms();
        int64_t nearest = now + 1000; /* default: wake up every second */
        FatPtr  to_fire[MAX_TIMERS];
        int     to_fire_count = 0;

        for (int i = 0; i < MAX_TIMERS; i++) {
            if (!g_timers[i].active) continue;
            if (g_timers[i].fire_at_ms <= now) {
                to_fire[to_fire_count++] = g_timers[i].fp;
                if (g_timers[i].repeat) {
                    g_timers[i].fire_at_ms = now + g_timers[i].interval_ms;
                    if (g_timers[i].fire_at_ms < nearest)
                        nearest = g_timers[i].fire_at_ms;
                } else {
                    g_timers[i].active = 0;
                }
            } else {
                if (g_timers[i].fire_at_ms < nearest)
                    nearest = g_timers[i].fire_at_ms;
            }
        }
        pthread_mutex_unlock(&g_timer_mu);

        /* Fire callbacks outside the lock */
        for (int i = 0; i < to_fire_count; i++)
            to_fire[i].fn(to_fire[i].env);

        /* Sleep until the next timer fires */
        int64_t sleep_ms = nearest - mono_now_ms();
        if (sleep_ms > 0) {
            struct timespec ts;
            ts.tv_sec  = (time_t)(sleep_ms / 1000);
            ts.tv_nsec = (long)((sleep_ms % 1000) * 1000000L);
            pthread_mutex_lock(&g_timer_mu);
            struct timespec abs_ts;
#ifdef CLOCK_MONOTONIC
            clock_gettime(CLOCK_MONOTONIC, &abs_ts);
#else
            clock_gettime(CLOCK_REALTIME, &abs_ts);
#endif
            abs_ts.tv_sec  += ts.tv_sec;
            abs_ts.tv_nsec += ts.tv_nsec;
            if (abs_ts.tv_nsec >= 1000000000L) {
                abs_ts.tv_sec++;
                abs_ts.tv_nsec -= 1000000000L;
            }
#ifdef CLOCK_MONOTONIC
            pthread_cond_timedwait(&g_timer_cv, &g_timer_mu, &abs_ts);
#else
            pthread_cond_timedwait(&g_timer_cv, &g_timer_mu, &abs_ts);
#endif
            pthread_mutex_unlock(&g_timer_mu);
        }
    }
    return NULL;
}

static void ensure_timer_thread(void) {
    if (!g_timer_initialized) {
        memset(g_timers, 0, sizeof(g_timers));
        g_timer_initialized = 1;
        pthread_create(&g_timer_thread, NULL, timer_thread_fn, NULL);
    }
}

int32_t async_set_timeout(FatPtr fp, int32_t ms) {
    ensure_timer_thread();
    pthread_mutex_lock(&g_timer_mu);
    int id = 0;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (!g_timers[i].active) {
            id = g_timer_next_id++;
            g_timers[i].id          = id;
            g_timers[i].active      = 1;
            g_timers[i].repeat      = 0;
            g_timers[i].interval_ms = ms;
            g_timers[i].fp          = fp;
            g_timers[i].fire_at_ms  = mono_now_ms() + ms;
            pthread_cond_signal(&g_timer_cv);
            break;
        }
    }
    pthread_mutex_unlock(&g_timer_mu);
    return (int32_t)id;
}

int32_t async_set_interval(FatPtr fp, int32_t ms) {
    ensure_timer_thread();
    pthread_mutex_lock(&g_timer_mu);
    int id = 0;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (!g_timers[i].active) {
            id = g_timer_next_id++;
            g_timers[i].id          = id;
            g_timers[i].active      = 1;
            g_timers[i].repeat      = 1;
            g_timers[i].interval_ms = ms;
            g_timers[i].fp          = fp;
            g_timers[i].fire_at_ms  = mono_now_ms() + ms;
            pthread_cond_signal(&g_timer_cv);
            break;
        }
    }
    pthread_mutex_unlock(&g_timer_mu);
    return (int32_t)id;
}

void async_clear_timeout(int32_t id) {
    pthread_mutex_lock(&g_timer_mu);
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (g_timers[i].active && g_timers[i].id == id) {
            g_timers[i].active = 0;
            break;
        }
    }
    pthread_mutex_unlock(&g_timer_mu);
}

void async_clear_interval(int32_t id) {
    async_clear_timeout(id);
}

/* ── AbortSignal / AbortController ──────────────────────────────────────────
 *
 * Web AbortController-inspired cooperative cancellation API.
 *
 * AbortSignal     — read-only, consumer-facing; passed to cancellable operations.
 * AbortController — write side; call abort_controller_abort() to cancel.
 *
 * Thread-safety: a pthread_mutex_t inside AbortSignal protects the aborted
 * flag and the callback array.  Callbacks are fired once, outside the lock,
 * in the thread that calls abort_controller_abort().
 */

#define ABORT_MAX_CALLBACKS 32

typedef struct {
    int             aborted;
    char           *reason;                        /* NULL until fire */
    FatPtr          callbacks[ABORT_MAX_CALLBACKS];
    int             cb_count;
    pthread_mutex_t mu;
} AbortSignal;

typedef struct {
    AbortSignal *signal;
} AbortController;

/* ── Internal helpers ────────────────────────────────────────────────────── */

static AbortSignal *abort_signal_alloc(void) {
    AbortSignal *s = (AbortSignal *)calloc(1, sizeof(AbortSignal));
    pthread_mutex_init(&s->mu, NULL);
    /* aborted = 0, reason = NULL, cb_count = 0 by calloc */
    return s;
}

/* Fire the signal: idempotent, thread-safe.  Callbacks run outside the lock. */
static void abort_signal_fire_internal(AbortSignal *s, const char *reason) {
    if (!s) return;
    pthread_mutex_lock(&s->mu);
    if (s->aborted) {                    /* already aborted — no-op */
        pthread_mutex_unlock(&s->mu);
        return;
    }
    s->aborted = 1;
    s->reason  = strdup((reason && reason[0]) ? reason : "AbortError");
    int    count = s->cb_count;
    FatPtr cbs[ABORT_MAX_CALLBACKS];
    memcpy(cbs, s->callbacks, (size_t)count * sizeof(FatPtr));
    pthread_mutex_unlock(&s->mu);

    for (int i = 0; i < count; i++) cbs[i].fn(cbs[i].env);
}

/* ── Public signal API ───────────────────────────────────────────────────── */

int32_t abort_signal_aborted(AbortSignal *s) {
    if (!s) return 0;
    pthread_mutex_lock(&s->mu);
    int v = s->aborted;
    pthread_mutex_unlock(&s->mu);
    return (int32_t)v;
}

const char *abort_signal_reason(AbortSignal *s) {
    if (!s || !s->aborted) return "";
    return s->reason ? s->reason : "AbortError";
}

/* Register a callback invoked when the signal is aborted.
 * If the signal is already aborted, the callback fires immediately. */
void abort_signal_on_abort(AbortSignal *s, FatPtr fp) {
    if (!s) return;
    int already;
    pthread_mutex_lock(&s->mu);
    already = s->aborted;
    if (!already && s->cb_count < ABORT_MAX_CALLBACKS)
        s->callbacks[s->cb_count++] = fp;
    pthread_mutex_unlock(&s->mu);
    if (already) fp.fn(fp.env);   /* fire immediately if already aborted */
}

void abort_signal_free(AbortSignal *s) {
    if (!s) return;
    pthread_mutex_destroy(&s->mu);
    if (s->reason) free(s->reason);
    free(s);
}

/* ── Static signal factories ─────────────────────────────────────────────── */

/* Returns a signal that is already in the aborted state. */
AbortSignal *abort_signal_already_aborted(const char *reason) {
    AbortSignal *s = abort_signal_alloc();
    abort_signal_fire_internal(s, reason ? reason : "AbortError");
    return s;
}

/* Timeout helper — env for the one-shot timer callback. */
typedef struct { AbortSignal *sig; } AbortTimeoutEnv;

static void abort_timeout_cb(void *env) {
    AbortTimeoutEnv *a = (AbortTimeoutEnv *)env;
    abort_signal_fire_internal(a->sig, "TimeoutError");
    free(a);
}

/* Returns a signal that auto-aborts with reason "TimeoutError" after ms ms. */
AbortSignal *abort_signal_timeout(int32_t ms) {
    ensure_timer_thread();
    AbortSignal     *s   = abort_signal_alloc();
    AbortTimeoutEnv *env = (AbortTimeoutEnv *)malloc(sizeof(AbortTimeoutEnv));
    env->sig = s;
    FatPtr fp = { abort_timeout_cb, env };
    async_set_timeout(fp, ms);
    return s;
}

/* ── AbortController ─────────────────────────────────────────────────────── */

AbortController *abort_controller_new(void) {
    AbortController *c = (AbortController *)malloc(sizeof(AbortController));
    c->signal = abort_signal_alloc();
    return c;
}

AbortSignal *abort_controller_signal(AbortController *c) {
    return c ? c->signal : NULL;
}

/* Abort with the given reason (NULL or "" → "AbortError"). */
void abort_controller_abort(AbortController *c, const char *reason) {
    if (c) abort_signal_fire_internal(c->signal, reason);
}

/* Frees the controller and its owned signal. */
void abort_controller_free(AbortController *c) {
    if (!c) return;
    abort_signal_free(c->signal);
    free(c);
}
