#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdio.h>
#include <limits.h>
#include <float.h>
#include <assert.h>

// ── Helpers ───────────────────────────────────────────────────────────────────

static char *str_dup_n(const char *s, size_t n) {
    char *r = (char *)malloc(n + 1);
    memcpy(r, s, n);
    r[n] = '\0';
    return r;
}

static int32_t normalise_index(int32_t i, int32_t len) {
    if (i < 0) i = len + i;
    if (i < 0) i = 0;
    if (i > len) i = len;
    return i;
}

// ── length ────────────────────────────────────────────────────────────────────
// Returns the number of Unicode codepoints (characters), not raw bytes.
// For ASCII-only strings this is identical to strlen().
// Works by counting only leading bytes — continuation bytes (0x80–0xBF) are skipped.
int32_t length(const char *s) {
    int32_t count = 0;
    while (*s) {
        // A leading byte is anything that is NOT a UTF-8 continuation byte.
        // Continuation bytes match the pattern 10xxxxxx (0x80 – 0xBF).
        if (((unsigned char)*s & 0xC0) != 0x80) count++;
        s++;
    }
    return count;
}

// ── charAt ────────────────────────────────────────────────────────────────────
// Returns a 1-char heap string, or "" for out-of-bounds.
char *charAt(const char *s, int32_t i) {
    int32_t len = (int32_t)strlen(s);
    if (i < 0 || i >= len) return str_dup_n("", 0);
    return str_dup_n(s + i, 1);
}

// ── at ────────────────────────────────────────────────────────────────────────
// Like charAt but supports negative indices (from end).
char *at(const char *s, int32_t i) {
    int32_t len = (int32_t)strlen(s);
    int32_t idx = normalise_index(i, len);
    if (idx >= len) return str_dup_n("", 0);
    return str_dup_n(s + idx, 1);
}

// ── charCodeAt ────────────────────────────────────────────────────────────────
int32_t charCodeAt(const char *s, int32_t i) {
    int32_t len = (int32_t)strlen(s);
    if (i < 0 || i >= len) return -1;
    return (int32_t)(unsigned char)s[i];
}

// ── fromCharCode ──────────────────────────────────────────────────────────────
char *fromCharCode(int32_t code) {
    char *r = (char *)malloc(2);
    r[0] = (char)code;
    r[1] = '\0';
    return r;
}

// ── indexOf ───────────────────────────────────────────────────────────────────
int32_t indexOf(const char *s, const char *search) {
    if (!*search) return 0;
    const char *p = strstr(s, search);
    return p ? (int32_t)(p - s) : -1;
}

// ── lastIndexOf ───────────────────────────────────────────────────────────────
int32_t lastIndexOf(const char *s, const char *search) {
    if (!*search) return (int32_t)strlen(s);
    size_t slen = strlen(search);
    size_t n    = strlen(s);
    if (slen > n) return -1;
    for (int32_t i = (int32_t)(n - slen); i >= 0; i--) {
        if (memcmp(s + i, search, slen) == 0) return i;
    }
    return -1;
}

// ── includes ─────────────────────────────────────────────────────────────────
int32_t includes(const char *s, const char *search) {
    return strstr(s, search) ? 1 : 0;
}

// ── startsWith ───────────────────────────────────────────────────────────────
int32_t startsWith(const char *s, const char *prefix) {
    size_t plen = strlen(prefix);
    return strncmp(s, prefix, plen) == 0 ? 1 : 0;
}

// ── endsWith ─────────────────────────────────────────────────────────────────
int32_t endsWith(const char *s, const char *suffix) {
    size_t slen  = strlen(s);
    size_t sflen = strlen(suffix);
    if (sflen > slen) return 0;
    return memcmp(s + slen - sflen, suffix, sflen) == 0 ? 1 : 0;
}

// ── slice ────────────────────────────────────────────────────────────────────
// slice(s, start, end): supports negative indices (from end).
char *slice(const char *s, int32_t start, int32_t end) {
    int32_t len = (int32_t)strlen(s);
    start = normalise_index(start, len);
    end   = normalise_index(end,   len);
    if (start >= end) return str_dup_n("", 0);
    return str_dup_n(s + start, (size_t)(end - start));
}

// ── sliceFrom ────────────────────────────────────────────────────────────────
// sliceFrom(s, start): slice from start to end of string.
char *sliceFrom(const char *s, int32_t start) {
    int32_t len = (int32_t)strlen(s);
    start = normalise_index(start, len);
    return str_dup_n(s + start, (size_t)(len - start));
}

// ── toUpperCase ───────────────────────────────────────────────────────────────
char *toUpperCase(const char *s) {
    size_t n = strlen(s);
    char  *r = (char *)malloc(n + 1);
    for (size_t i = 0; i < n; i++) r[i] = (char)toupper((unsigned char)s[i]);
    r[n] = '\0';
    return r;
}

// ── toLowerCase ───────────────────────────────────────────────────────────────
char *toLowerCase(const char *s) {
    size_t n = strlen(s);
    char  *r = (char *)malloc(n + 1);
    for (size_t i = 0; i < n; i++) r[i] = (char)tolower((unsigned char)s[i]);
    r[n] = '\0';
    return r;
}

// ── trim ─────────────────────────────────────────────────────────────────────
char *trim(const char *s) {
    while (isspace((unsigned char)*s)) s++;
    size_t n = strlen(s);
    while (n > 0 && isspace((unsigned char)s[n - 1])) n--;
    return str_dup_n(s, n);
}

char *trimStart(const char *s) {
    while (isspace((unsigned char)*s)) s++;
    return str_dup_n(s, strlen(s));
}

char *trimEnd(const char *s) {
    size_t n = strlen(s);
    while (n > 0 && isspace((unsigned char)s[n - 1])) n--;
    return str_dup_n(s, n);
}

// ── padStart ─────────────────────────────────────────────────────────────────
char *padStart(const char *s, int32_t width, const char *fill) {
    int32_t slen  = (int32_t)strlen(s);
    int32_t flen  = (int32_t)strlen(fill);
    if (slen >= width || flen == 0) return str_dup_n(s, (size_t)slen);
    int32_t pad   = width - slen;
    char   *r     = (char *)malloc((size_t)width + 1);
    int32_t pos   = 0;
    while (pos < pad) {
        r[pos] = fill[(pos) % flen];
        pos++;
    }
    memcpy(r + pad, s, (size_t)slen);
    r[width] = '\0';
    return r;
}

// ── padEnd ────────────────────────────────────────────────────────────────────
char *padEnd(const char *s, int32_t width, const char *fill) {
    int32_t slen = (int32_t)strlen(s);
    int32_t flen = (int32_t)strlen(fill);
    if (slen >= width || flen == 0) return str_dup_n(s, (size_t)slen);
    int32_t pad = width - slen;
    char   *r   = (char *)malloc((size_t)width + 1);
    memcpy(r, s, (size_t)slen);
    for (int32_t i = 0; i < pad; i++) r[slen + i] = fill[i % flen];
    r[width] = '\0';
    return r;
}

// ── repeat ────────────────────────────────────────────────────────────────────
char *repeat(const char *s, int32_t n) {
    if (n <= 0) return str_dup_n("", 0);
    size_t slen = strlen(s);
    size_t rlen = slen * (size_t)n;
    char  *r    = (char *)malloc(rlen + 1);
    for (int32_t i = 0; i < n; i++) memcpy(r + i * slen, s, slen);
    r[rlen] = '\0';
    return r;
}

// ── replace ───────────────────────────────────────────────────────────────────
// Replace first occurrence of `from` with `to`.
char *replace(const char *s, const char *from, const char *to) {
    if (!*from) return str_dup_n(s, strlen(s));
    const char *p = strstr(s, from);
    if (!p) return str_dup_n(s, strlen(s));
    size_t flen   = strlen(from);
    size_t tlen   = strlen(to);
    size_t before = (size_t)(p - s);
    size_t after  = strlen(p + flen);
    char  *r      = (char *)malloc(before + tlen + after + 1);
    memcpy(r,               s,        before);
    memcpy(r + before,      to,       tlen);
    memcpy(r + before + tlen, p + flen, after);
    r[before + tlen + after] = '\0';
    return r;
}

// ── replaceAll ────────────────────────────────────────────────────────────────
char *replaceAll(const char *s, const char *from, const char *to) {
    if (!*from) return str_dup_n(s, strlen(s));
    size_t flen  = strlen(from);
    size_t tlen  = strlen(to);
    // Count occurrences first
    size_t count = 0;
    const char *p = s;
    while ((p = strstr(p, from)) != NULL) { count++; p += flen; }
    // Build result
    size_t slen = strlen(s);
    size_t rlen = slen + count * (tlen > flen ? tlen - flen : 0)
                       - count * (flen > tlen ? flen - tlen : 0);
    char  *r    = (char *)malloc(rlen + 1);
    char  *out  = r;
    p = s;
    const char *q;
    while ((q = strstr(p, from)) != NULL) {
        size_t n = (size_t)(q - p);
        memcpy(out, p, n); out += n;
        memcpy(out, to, tlen); out += tlen;
        p = q + flen;
    }
    strcpy(out, p);
    return r;
}

// ── concat ────────────────────────────────────────────────────────────────────
char *concat(const char *a, const char *b) {
    size_t alen = strlen(a), blen = strlen(b);
    char  *r    = (char *)malloc(alen + blen + 1);
    memcpy(r,        a, alen);
    memcpy(r + alen, b, blen);
    r[alen + blen] = '\0';
    return r;
}

// ── Template-string helpers ───────────────────────────────────────────────────
// Used by the $"..." template literal lowering.  Each returns a heap-allocated
// null-terminated string; the caller owns it.

// int_to_string: decimal representation of a 32-bit signed integer.
char *int_to_string(int32_t n) {
    // Maximum int32: 11 chars ("-2147483648\0")
    char *buf = (char *)malloc(16);
    snprintf(buf, 16, "%d", n);
    return buf;
}

// int_digit_count: number of decimal digits in n (sign counts as 1 extra digit).
// Examples: 0→1, 9→1, 10→2, -5→2, 100→3, -100→4
int32_t int_digit_count(int32_t n) {
    if (n == 0) return 1;
    int32_t count = (n < 0) ? 1 : 0;  // leading '-' for negatives
    if (n < 0) {
        // avoid overflow for INT_MIN: work with unsigned
        uint32_t u = (n == INT32_MIN) ? (uint32_t)INT32_MAX + 1u : (uint32_t)(-n);
        while (u > 0) { count++; u /= 10; }
    } else {
        while (n > 0) { count++; n /= 10; }
    }
    return count;
}

// float_to_string: up to 15 significant digits, no trailing zeros.
char *float_to_string(double f) {
    char *buf = (char *)malloc(64);
    snprintf(buf, 64, "%.15g", f);
    return buf;
}

// ── Buffer ────────────────────────────────────────────────────────────────────
// string.toBuffer() returns a heap-allocated Buffer* whose `data` field holds
// a copy of the raw UTF-8 bytes of the string.  The NUL terminator is NOT
// included: `len` gives the exact byte count.

typedef struct Buffer {
    uint8_t  freed;
    uint8_t *data;
    int32_t  len;
} Buffer;

// Allocate a Buffer* from a null-terminated C string.
Buffer *string_to_buffer(const char *s) {
    int32_t n = (int32_t)strlen(s);
    Buffer  *b = (Buffer *)malloc(sizeof(Buffer));
    b->freed  = 0;
    b->data   = (uint8_t *)malloc((size_t)n);
    memcpy(b->data, s, (size_t)n);
    b->len    = n;
    return b;
}

// Return the number of bytes (excluding the NUL terminator).
int32_t buffer_length(Buffer *b) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    return b->len;
}

// Return the byte at index i (0-based).  Returns 0 for out-of-bounds indices.
uint8_t buffer_get(Buffer *b, int32_t i) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (i < 0 || i >= b->len) return 0;
    return b->data[i];
}

// Release the heap memory owned by a Buffer*.
void buffer_free(Buffer *b) {
    if (!b) return;
    if (b->freed) { fprintf(stderr, "double-free: Buffer\n"); abort(); }
    b->freed = 1;
    free(b->data);
    b->data = NULL;
    b->len  = 0;
    // DO NOT free(b) — keep as tombstone
}

// Print a Buffer object as a bracket-enclosed, comma-separated list of decimal
// byte values followed by a newline.
// Example: [208, 159, 209, 128, ...] for the UTF-8 encoding of "Привет, мир".
void buffer_print(Buffer *b) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    putchar('[');
    for (int32_t i = 0; i < b->len; i++) {
        if (i > 0) {
            putchar(',');
            putchar(' ');
        }
        printf("%u", (unsigned)b->data[i]);
    }
    puts("]");  // puts appends '\n'
}

// ── New Buffer primitives ─────────────────────────────────────────────────────

// buffer_new: allocate a zero-filled Buffer* of `len` bytes.
// Returns NULL if len < 0.
Buffer *buffer_new(int32_t len) {
    if (len < 0) len = 0;
    Buffer *b  = (Buffer *)malloc(sizeof(Buffer));
    b->freed  = 0;
    b->data   = (uint8_t *)calloc((size_t)len, 1);
    b->len    = len;
    return b;
}

// buffer_set: write byte value `v` at index `i`.
// Out-of-bounds writes are silently ignored.
void buffer_set(Buffer *b, int32_t i, uint8_t v) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (i < 0 || i >= b->len) return;
    b->data[i] = v;
}

// buffer_slice: return a new Buffer* containing bytes [start, end).
// Negative indices count from the end (Python-style).
// Clamped to valid range; returns empty Buffer* for empty/inverted ranges.
Buffer *buffer_slice(Buffer *b, int32_t start, int32_t end) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    int32_t len = b->len;
    if (start < 0) start = len + start;
    if (end   < 0) end   = len + end;
    if (start < 0) start = 0;
    if (end   > len) end = len;
    if (start >= end) return buffer_new(0);
    int32_t n   = end - start;
    Buffer  *out = (Buffer *)malloc(sizeof(Buffer));
    out->freed  = 0;
    out->data   = (uint8_t *)malloc((size_t)n);
    memcpy(out->data, b->data + start, (size_t)n);
    out->len    = n;
    return out;
}

// buffer_concat: return a new Buffer* that is the concatenation of a and b.
Buffer *buffer_concat(Buffer *a, Buffer *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    int32_t n   = a->len + b->len;
    Buffer  *out = (Buffer *)malloc(sizeof(Buffer));
    out->freed  = 0;
    out->data   = (uint8_t *)malloc((size_t)n);
    memcpy(out->data,            a->data, (size_t)a->len);
    memcpy(out->data + a->len,   b->data, (size_t)b->len);
    out->len    = n;
    return out;
}

// buffer_to_string: interpret the raw bytes as a UTF-8 sequence and return a
// heap-allocated null-terminated string.  The caller is responsible for freeing it
// (or it will be collected by the runtime on process exit in typical usage).
char *buffer_to_string(Buffer *b) {
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    char *s = (char *)malloc((size_t)b->len + 1);
    memcpy(s, b->data, (size_t)b->len);
    s[b->len] = '\0';
    return s;
}

// buffer_index_of: return the first position of needle inside haystack,
// or -1 if not found.  Both are raw byte sequences (not C strings).
int32_t buffer_index_of(Buffer *haystack, Buffer *needle) {
    if (haystack && haystack->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (needle   && needle->freed)   { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (needle->len == 0) return 0;
    if (needle->len > haystack->len) return -1;
    int32_t limit = haystack->len - needle->len;
    for (int32_t i = 0; i <= limit; i++) {
        if (memcmp(haystack->data + i, needle->data, (size_t)needle->len) == 0)
            return i;
    }
    return -1;
}

// buffer_equals: return 1 if a and b have identical contents, 0 otherwise.
int32_t buffer_equals(Buffer *a, Buffer *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (a->len != b->len) return 0;
    return memcmp(a->data, b->data, (size_t)a->len) == 0 ? 1 : 0;
}

// buffer_last_index_of: return the last position of needle inside haystack,
// or -1 if not found.
int32_t buffer_last_index_of(Buffer *haystack, Buffer *needle) {
    if (haystack && haystack->freed) { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (needle   && needle->freed)   { fprintf(stderr, "use-after-free: Buffer\n"); abort(); }
    if (needle->len == 0) return haystack->len;
    if (needle->len > haystack->len) return -1;
    int32_t limit = haystack->len - needle->len;
    for (int32_t i = limit; i >= 0; i--) {
        if (memcmp(haystack->data + i, needle->data, (size_t)needle->len) == 0)
            return i;
    }
    return -1;
}

// ── Mutable string primitives ─────────────────────────────────────────────────
//
// string_alloc(n)         — allocate a zero-filled, NUL-terminated buffer of n
//                           bytes (n+1 bytes allocated so the NUL fits at [n]).
//                           Negative n is clamped to 0.  Returns a char* owned
//                           by the caller; free with the C free() function.
//
// string_set_byte(s,i,v)  — write value v (cast to uint8_t) into s[i].  No
//                           bounds check is performed; callers must ensure i is
//                           within [0, n-1].

char *string_alloc(int32_t n) {
    if (n < 0) n = 0;
    return (char *)calloc((size_t)n + 1, 1);
}

void string_set_byte(char *s, int32_t i, int32_t v) {
    s[i] = (char)(uint8_t)v;
}

// ── Point helpers (used by the operator_overload test fixture) ────────────────
// Packs two 32-bit signed integers into a single 64-bit value.
// Encoding: hi 32 bits = x,  lo 32 bits = y (unsigned interpretation).
#include <stdint.h>

int64_t point_pack(int32_t x, int32_t y) {
    return ((int64_t)x << 32) | (uint32_t)y;
}

int32_t point_x(int64_t p) {
    return (int32_t)(p >> 32);
}

int32_t point_y(int64_t p) {
    return (int32_t)(p & 0xFFFFFFFF);
}

// ── Scalar type min / max helpers ─────────────────────────────────────────────
// One function per width/sign combination.  All return the inclusive boundary
// value for the corresponding C type.  Unsigned minimums are always 0.

int8_t   i8_min (void) { return INT8_MIN;  }
int8_t   i8_max (void) { return INT8_MAX;  }
int16_t  i16_min(void) { return INT16_MIN; }
int16_t  i16_max(void) { return INT16_MAX; }
int32_t  i32_min(void) { return INT32_MIN; }
int32_t  i32_max(void) { return INT32_MAX; }
int64_t  i64_min(void) { return INT64_MIN; }
int64_t  i64_max(void) { return INT64_MAX; }

uint8_t  u8_min (void) { return 0; }
uint8_t  u8_max (void) { return UINT8_MAX;  }
uint16_t u16_min(void) { return 0; }
uint16_t u16_max(void) { return UINT16_MAX; }
uint32_t u32_min(void) { return 0; }
uint32_t u32_max(void) { return UINT32_MAX; }
uint64_t u64_min(void) { return 0; }
uint64_t u64_max(void) { return UINT64_MAX; }

float    f32_min(void) { return -FLT_MAX; }
float    f32_max(void) { return  FLT_MAX; }
double   f64_min(void) { return -DBL_MAX; }
double   f64_max(void) { return  DBL_MAX; }

// ── Panic ─────────────────────────────────────────────────────────────────────
//
// runtime_panic(msg) — prints "panic: <msg>" to stderr and aborts the process.
// Called by the `panic(expr)` built-in statement.
// The function is declared [[noreturn]] so the compiler knows it never returns.

__attribute__((noreturn))
void runtime_panic(const char *msg) {
    fprintf(stderr, "panic: %s\n", msg != NULL ? msg : "(null)");
    fflush(stderr);
    abort();
}
