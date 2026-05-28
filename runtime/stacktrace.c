/**
 * runtime/stacktrace.c — call-stack capture and formatting
 *
 * Implements the C backing for stdlib/stacktrace.code:
 *
 *   Stacktrace           — opaque snapshot of the call stack at a given moment
 *   stacktrace_capture() — record the current call stack
 *   stacktrace_depth()   — number of frames captured
 *   stacktrace_frame()   — symbol name (or hex address) of frame i
 *   stacktrace_format()  — multi-line human-readable string of all frames
 *
 * Implementation uses POSIX backtrace() + backtrace_symbols() when available
 * (macOS, Linux glibc).  Falls back to an empty one-frame snapshot otherwise.
 *
 * All allocations are heap-allocated and intentionally never freed — they are
 * intended for error reporting only, not for high-frequency use.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* HAVE_BACKTRACE: defined on platforms that provide POSIX backtrace(3).
 * Windows does not provide this — the #else branch returns an empty snapshot,
 * which is safe (callers treat a depth-0 Stacktrace as "unavailable"). */
#ifdef __APPLE__
#  include <execinfo.h>
#  define HAVE_BACKTRACE 1
#elif defined(__linux__) && defined(__GLIBC__)
#  include <execinfo.h>
#  define HAVE_BACKTRACE 1
#endif
/* _WIN32: no HAVE_BACKTRACE — empty snapshot returned below */

/* ── Stacktrace ─────────────────────────────────────────────────────────── */

#define STACKTRACE_MAX_DEPTH 64

typedef struct Stacktrace {
    int32_t      depth;
    const char **frames;   /* array of symbol strings (or NULL when unavailable) */
} Stacktrace;

/* Capture the current call stack. */
Stacktrace *stacktrace_capture(void) {
    Stacktrace *st = (Stacktrace *)malloc(sizeof(Stacktrace));
    if (!st) { st = (Stacktrace *)malloc(sizeof(Stacktrace)); }  /* retry once */

#ifdef HAVE_BACKTRACE
    void *ptrs[STACKTRACE_MAX_DEPTH];
    int depth = backtrace(ptrs, STACKTRACE_MAX_DEPTH);
    /* Skip frame 0 (this function itself) */
    int skip = depth > 1 ? 1 : 0;
    st->depth = depth - skip;
    if (st->depth <= 0) {
        st->depth  = 0;
        st->frames = NULL;
        return st;
    }
    char **syms = backtrace_symbols(ptrs + skip, st->depth);
    if (!syms) {
        st->frames = NULL;
        return st;
    }
    /* Copy into a permanent array */
    st->frames = (const char **)malloc((size_t)st->depth * sizeof(const char *));
    for (int i = 0; i < st->depth; i++) {
        size_t len = strlen(syms[i]);
        char *copy = (char *)malloc(len + 1);
        memcpy(copy, syms[i], len + 1);
        st->frames[i] = copy;
    }
    free(syms);
#else
    st->depth  = 0;
    st->frames = NULL;
#endif

    return st;
}

/* Number of frames in the captured stack. */
int32_t stacktrace_depth(const Stacktrace *st) {
    return st ? st->depth : 0;
}

/* Symbol string for frame `i` (0 = outermost caller after capture).
 * Returns "<unknown>" when the index is out of range or symbols unavailable. */
const char *stacktrace_frame(const Stacktrace *st, int32_t i) {
    if (!st || !st->frames || i < 0 || i >= st->depth) return "<unknown>";
    return st->frames[i];
}

/* Multi-line formatted string of all frames, one per line.
 * Caller is responsible for freeing — but in practice callers (error display)
 * treat it as permanent storage. */
const char *stacktrace_format(const Stacktrace *st) {
    if (!st || st->depth == 0 || !st->frames) {
        const char *empty = "<no stacktrace available>";
        char *buf = (char *)malloc(strlen(empty) + 1);
        strcpy(buf, empty);
        return buf;
    }

    /* Compute total length */
    size_t total = 0;
    for (int32_t i = 0; i < st->depth; i++) {
        total += strlen(st->frames[i]) + 1;  /* +1 for '\n' */
    }
    total += 1;  /* null terminator */

    char *buf = (char *)malloc(total);
    char *ptr = buf;
    for (int32_t i = 0; i < st->depth; i++) {
        size_t len = strlen(st->frames[i]);
        memcpy(ptr, st->frames[i], len);
        ptr += len;
        *ptr++ = '\n';
    }
    *ptr = '\0';
    return buf;
}
