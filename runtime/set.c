#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <assert.h>

// ── IntSet ────────────────────────────────────────────────────────────────────
//
// A heap-allocated, ordered set of distinct 32-bit signed integers.
//
//   struct IntSet { uint8_t freed; int32_t *data; int32_t len; int32_t cap; }
//
// Internally the elements are kept in ascending sorted order so that
//   • contains / add / remove can use binary search  (O(log n))
//   • toString always produces a deterministic, sorted output
//
// Growth strategy: double capacity when full, minimum capacity 4.
// NULL is accepted gracefully by all public functions.

typedef struct IntSet {
    uint8_t  freed;
    int32_t *data;
    int32_t  len;
    int32_t  cap;
} IntSet;

// ── Internal helpers ──────────────────────────────────────────────────────────

// Binary search: returns the index where v is found (or should be inserted).
static int32_t is_lower_bound(const int32_t *data, int32_t len, int32_t v) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid] < v) lo = mid + 1;
        else               hi = mid;
    }
    return lo;
}

static void is_grow(IntSet *s, int32_t min_cap) {
    int32_t cap = s->cap < 4 ? 4 : s->cap;
    while (cap < min_cap) cap *= 2;
    s->data = (int32_t *)realloc(s->data, (size_t)cap * sizeof(int32_t));
    s->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

IntSet *intset_new(void) {
    IntSet *s = (IntSet *)malloc(sizeof(IntSet));
    s->freed = 0;
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    return s;
}

void intset_free(IntSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: IntSet\n"); abort(); }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    // DO NOT free(s) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t intset_size(const IntSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    return s ? s->len : 0;
}

// intset_contains: returns 1 if v is in the set, 0 otherwise.
int32_t intset_contains(const IntSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    if (!s || s->len == 0) return 0;
    int32_t i = is_lower_bound(s->data, s->len, v);
    return (i < s->len && s->data[i] == v) ? 1 : 0;
}

// intset_add: insert v if not already present. No-op for duplicates.
void intset_add(IntSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    if (!s) return;
    int32_t i = is_lower_bound(s->data, s->len, v);
    if (i < s->len && s->data[i] == v) return;  // already present
    if (s->len >= s->cap) is_grow(s, s->len + 1);
    // Shift right to make room
    memmove(s->data + i + 1, s->data + i, (size_t)(s->len - i) * sizeof(int32_t));
    s->data[i] = v;
    s->len++;
}

// intset_remove: remove v if present. No-op if not found.
void intset_remove(IntSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    if (!s || s->len == 0) return;
    int32_t i = is_lower_bound(s->data, s->len, v);
    if (i >= s->len || s->data[i] != v) return;  // not found
    memmove(s->data + i, s->data + i + 1, (size_t)(s->len - i - 1) * sizeof(int32_t));
    s->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

// intset_print: print "{v0, v1, ...}" followed by a newline.
void intset_print(const IntSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    putchar('{');
    if (s) {
        for (int32_t i = 0; i < s->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("%d", (int)s->data[i]);
        }
    }
    puts("}");
}

// intset_to_string: heap-allocated "{v0, v1, ...}" string (caller must free).
char *intset_to_string(const IntSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    if (!s || s->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: each int32 is at most 11 chars ("-2147483648"), plus ", " between
    size_t buflen = 2 + (size_t)s->len * 13;
    char  *buf    = (char *)malloc(buflen);
    size_t pos    = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int written = snprintf(buf + pos, buflen - pos, "%d", (int)s->data[i]);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── StringSet ─────────────────────────────────────────────────────────────────
//
// A heap-allocated, ordered set of distinct C string pointers.
//
//   struct StringSet { uint8_t freed; char **data; int32_t len; int32_t cap; }
//
// Ownership: StringSet stores pointers to strings it does NOT own.
// Elements are sorted lexicographically (strcmp order).

typedef struct StringSet {
    uint8_t  freed;
    char   **data;
    int32_t  len;
    int32_t  cap;
} StringSet;

static int32_t ss_lower_bound(char * const *data, int32_t len, const char *v) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (strcmp(data[mid], v) < 0) lo = mid + 1;
        else                          hi = mid;
    }
    return lo;
}

static void ss_grow(StringSet *s, int32_t min_cap) {
    int32_t cap = s->cap < 4 ? 4 : s->cap;
    while (cap < min_cap) cap *= 2;
    s->data = (char **)realloc(s->data, (size_t)cap * sizeof(char *));
    s->cap  = cap;
}

StringSet *stringset_new(void) {
    StringSet *s = (StringSet *)malloc(sizeof(StringSet));
    s->freed = 0;
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    return s;
}

void stringset_free(StringSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: StringSet\n"); abort(); }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    // DO NOT free(s) — keep as tombstone
}

int32_t stringset_size(const StringSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    return s ? s->len : 0;
}

int32_t stringset_contains(const StringSet *s, const char *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    if (!s || s->len == 0 || !v) return 0;
    int32_t i = ss_lower_bound(s->data, s->len, v);
    return (i < s->len && strcmp(s->data[i], v) == 0) ? 1 : 0;
}

void stringset_add(StringSet *s, const char *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    if (!s || !v) return;
    int32_t i = ss_lower_bound(s->data, s->len, v);
    if (i < s->len && strcmp(s->data[i], v) == 0) return;
    if (s->len >= s->cap) ss_grow(s, s->len + 1);
    memmove(s->data + i + 1, s->data + i, (size_t)(s->len - i) * sizeof(char *));
    s->data[i] = (char *)v;
    s->len++;
}

void stringset_remove(StringSet *s, const char *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    if (!s || s->len == 0 || !v) return;
    int32_t i = ss_lower_bound(s->data, s->len, v);
    if (i >= s->len || strcmp(s->data[i], v) != 0) return;
    memmove(s->data + i, s->data + i + 1, (size_t)(s->len - i - 1) * sizeof(char *));
    s->len--;
}

void stringset_print(const StringSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    putchar('{');
    if (s) {
        for (int32_t i = 0; i < s->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            putchar('"');
            fputs(s->data[i] ? s->data[i] : "", stdout);
            putchar('"');
        }
    }
    puts("}");
}

char *stringset_to_string(const StringSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    if (!s || s->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate total length: sum of quoted strings + separators
    size_t total = 2;  // "{}"
    for (int32_t i = 0; i < s->len; i++) {
        total += 2;  // quotes
        total += s->data[i] ? strlen(s->data[i]) : 0;
        if (i > 0) total += 2;  // ", "
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        buf[pos++] = '"';
        const char *elem = s->data[i] ? s->data[i] : "";
        size_t elen = strlen(elem);
        memcpy(buf + pos, elem, elen);
        pos += elen;
        buf[pos++] = '"';
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── BoolSet ───────────────────────────────────────────────────────────────────
//
// A set of boolean values.  At most two distinct members (false, true).
//
//   struct BoolSet { uint8_t freed; uint8_t flags; }
//   bit 0 = contains false
//   bit 1 = contains true
//
// Backed by a heap-allocated struct for uniform pointer semantics.

typedef struct BoolSet {
    uint8_t freed;
    uint8_t flags;
} BoolSet;

BoolSet *boolset_new(void) {
    BoolSet *s = (BoolSet *)malloc(sizeof(BoolSet));
    s->freed = 0;
    s->flags = 0;
    return s;
}

void boolset_free(BoolSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: BoolSet\n"); abort(); }
    s->freed = 1;
    s->flags = 0;
    // DO NOT free(s) — keep as tombstone
}

int32_t boolset_size(const BoolSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s) return 0;
    return (int32_t)(__builtin_popcount(s->flags));
}

int32_t boolset_contains(const BoolSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s) return 0;
    uint8_t bit = v ? 2 : 1;
    return (s->flags & bit) ? 1 : 0;
}

void boolset_add(BoolSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s) return;
    uint8_t bit = v ? 2 : 1;
    s->flags |= bit;
}

void boolset_remove(BoolSet *s, int32_t v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s) return;
    uint8_t bit = v ? 2 : 1;
    s->flags &= (uint8_t)(~bit);
}

void boolset_print(const BoolSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    putchar('{');
    if (s) {
        int first = 1;
        if (s->flags & 1) { fputs("false", stdout); first = 0; }
        if (s->flags & 2) { if (!first) fputs(", ", stdout); fputs("true", stdout); }
    }
    puts("}");
}

char *boolset_to_string(const BoolSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s || s->flags == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    if (s->flags == 3) {
        char *out = (char *)malloc(14);
        memcpy(out, "{false, true}", 14);
        return out;
    }
    if (s->flags == 1) {
        char *out = (char *)malloc(8);
        memcpy(out, "{false}", 8);
        return out;
    }
    // flags == 2
    char *out = (char *)malloc(7);
    memcpy(out, "{true}", 7);
    return out;
}

// ── FloatSet ──────────────────────────────────────────────────────────────────
//
// Ordered set of 32-bit single-precision floats (sorted ascending).
// NaN values are not supported (NaN ≠ NaN, so they always insert).

typedef struct FloatSet {
    uint8_t  freed;
    float   *data;
    int32_t  len;
    int32_t  cap;
} FloatSet;

static int32_t fs_lower_bound(const float *data, int32_t len, float v) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid] < v) lo = mid + 1;
        else               hi = mid;
    }
    return lo;
}

static void fs_grow(FloatSet *s, int32_t min_cap) {
    int32_t cap = s->cap < 4 ? 4 : s->cap;
    while (cap < min_cap) cap *= 2;
    s->data = (float *)realloc(s->data, (size_t)cap * sizeof(float));
    s->cap  = cap;
}

FloatSet *floatset_new(void) {
    FloatSet *s = (FloatSet *)malloc(sizeof(FloatSet));
    s->freed = 0;
    s->data = NULL; s->len = 0; s->cap = 0;
    return s;
}

void floatset_free(FloatSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: FloatSet\n"); abort(); }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    // DO NOT free(s) — keep as tombstone
}

int32_t floatset_size(const FloatSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    return s ? s->len : 0;
}

int32_t floatset_contains(const FloatSet *s, float v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    if (!s || s->len == 0) return 0;
    int32_t i = fs_lower_bound(s->data, s->len, v);
    return (i < s->len && s->data[i] == v) ? 1 : 0;
}

void floatset_add(FloatSet *s, float v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    if (!s) return;
    int32_t i = fs_lower_bound(s->data, s->len, v);
    if (i < s->len && s->data[i] == v) return;
    if (s->len >= s->cap) fs_grow(s, s->len + 1);
    memmove(s->data + i + 1, s->data + i, (size_t)(s->len - i) * sizeof(float));
    s->data[i] = v;
    s->len++;
}

void floatset_remove(FloatSet *s, float v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    if (!s || s->len == 0) return;
    int32_t i = fs_lower_bound(s->data, s->len, v);
    if (i >= s->len || s->data[i] != v) return;
    memmove(s->data + i, s->data + i + 1, (size_t)(s->len - i - 1) * sizeof(float));
    s->len--;
}

void floatset_print(const FloatSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    putchar('{');
    if (s) for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { putchar(','); putchar(' '); }
        printf("%.15g", (double)s->data[i]);
    }
    puts("}");
}

char *floatset_to_string(const FloatSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    if (!s || s->len == 0) {
        char *out = (char *)malloc(3); out[0]='{'; out[1]='}'; out[2]='\0'; return out;
    }
    char tmp[32];
    size_t total = 2;
    for (int32_t i = 0; i < s->len; i++) {
        total += (size_t)snprintf(tmp, sizeof(tmp), "%.15g", (double)s->data[i]);
        if (i < s->len - 1) total += 2;
    }
    char *buf = (char *)malloc(total + 1);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int w = snprintf(buf + pos, total + 1 - pos, "%.15g", (double)s->data[i]);
        if (w > 0) pos += (size_t)w;
    }
    buf[pos++] = '}'; buf[pos] = '\0';
    return buf;
}

// ── DoubleSet ─────────────────────────────────────────────────────────────────
//
// Ordered set of 64-bit double-precision floats (sorted ascending).

typedef struct DoubleSet {
    uint8_t  freed;
    double  *data;
    int32_t  len;
    int32_t  cap;
} DoubleSet;

static int32_t ds_lower_bound(const double *data, int32_t len, double v) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid] < v) lo = mid + 1;
        else               hi = mid;
    }
    return lo;
}

static void ds_grow(DoubleSet *s, int32_t min_cap) {
    int32_t cap = s->cap < 4 ? 4 : s->cap;
    while (cap < min_cap) cap *= 2;
    s->data = (double *)realloc(s->data, (size_t)cap * sizeof(double));
    s->cap  = cap;
}

DoubleSet *doubleset_new(void) {
    DoubleSet *s = (DoubleSet *)malloc(sizeof(DoubleSet));
    s->freed = 0;
    s->data = NULL; s->len = 0; s->cap = 0;
    return s;
}

void doubleset_free(DoubleSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: DoubleSet\n"); abort(); }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    // DO NOT free(s) — keep as tombstone
}

int32_t doubleset_size(const DoubleSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    return s ? s->len : 0;
}

int32_t doubleset_contains(const DoubleSet *s, double v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    if (!s || s->len == 0) return 0;
    int32_t i = ds_lower_bound(s->data, s->len, v);
    return (i < s->len && s->data[i] == v) ? 1 : 0;
}

void doubleset_add(DoubleSet *s, double v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    if (!s) return;
    int32_t i = ds_lower_bound(s->data, s->len, v);
    if (i < s->len && s->data[i] == v) return;
    if (s->len >= s->cap) ds_grow(s, s->len + 1);
    memmove(s->data + i + 1, s->data + i, (size_t)(s->len - i) * sizeof(double));
    s->data[i] = v;
    s->len++;
}

void doubleset_remove(DoubleSet *s, double v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    if (!s || s->len == 0) return;
    int32_t i = ds_lower_bound(s->data, s->len, v);
    if (i >= s->len || s->data[i] != v) return;
    memmove(s->data + i, s->data + i + 1, (size_t)(s->len - i - 1) * sizeof(double));
    s->len--;
}

void doubleset_print(const DoubleSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    putchar('{');
    if (s) for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { putchar(','); putchar(' '); }
        printf("%.15g", s->data[i]);
    }
    puts("}");
}

char *doubleset_to_string(const DoubleSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    if (!s || s->len == 0) {
        char *out = (char *)malloc(3); out[0]='{'; out[1]='}'; out[2]='\0'; return out;
    }
    char tmp[32];
    size_t total = 2;
    for (int32_t i = 0; i < s->len; i++) {
        total += (size_t)snprintf(tmp, sizeof(tmp), "%.15g", s->data[i]);
        if (i < s->len - 1) total += 2;
    }
    char *buf = (char *)malloc(total + 1);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int w = snprintf(buf + pos, total + 1 - pos, "%.15g", s->data[i]);
        if (w > 0) pos += (size_t)w;
    }
    buf[pos++] = '}'; buf[pos] = '\0';
    return buf;
}

// ── NumberSet ─────────────────────────────────────────────────────────────────
//
// Ordered set of arbitrary-precision Number values (sorted by numeric value).
// Each element is a heap-allocated Number* pointer (from runtime/number.c).
// Comparison uses number_lt and number_eq from the Number runtime.

// Forward declarations from runtime/number.c
typedef struct NumberOpaque Number;
extern int32_t number_lt(const Number*, const Number*);
extern int32_t number_eq(const Number*, const Number*);
extern char   *number_to_string(const Number*);
extern void    number_print(const Number*);

typedef struct NumberSet {
    uint8_t  freed;
    Number **data;
    int32_t  len;
    int32_t  cap;
} NumberSet;

static int32_t nset_compare(const Number *a, const Number *b) {
    if (number_eq(a, b)) return 0;
    return number_lt(a, b) ? -1 : 1;
}

static int32_t nset_lower_bound(Number **data, int32_t len, const Number *v) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (nset_compare(data[mid], v) < 0) lo = mid + 1;
        else                                hi = mid;
    }
    return lo;
}

static void nset_grow(NumberSet *s, int32_t min_cap) {
    int32_t cap = s->cap < 4 ? 4 : s->cap;
    while (cap < min_cap) cap *= 2;
    s->data = (Number **)realloc(s->data, (size_t)cap * sizeof(Number *));
    s->cap  = cap;
}

NumberSet *numberset_new(void) {
    NumberSet *s = (NumberSet *)malloc(sizeof(NumberSet));
    s->freed = 0;
    s->data = NULL; s->len = 0; s->cap = 0;
    return s;
}

void numberset_free(NumberSet *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: NumberSet\n"); abort(); }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    s->len  = 0;
    s->cap  = 0;
    // DO NOT free(s) — keep as tombstone
}

int32_t numberset_size(const NumberSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    return s ? s->len : 0;
}

int32_t numberset_contains(const NumberSet *s, const Number *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    if (!s || s->len == 0 || !v) return 0;
    int32_t i = nset_lower_bound(s->data, s->len, v);
    return (i < s->len && nset_compare(s->data[i], v) == 0) ? 1 : 0;
}

void numberset_add(NumberSet *s, Number *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    if (!s || !v) return;
    int32_t i = nset_lower_bound(s->data, s->len, v);
    if (i < s->len && nset_compare(s->data[i], v) == 0) return;
    if (s->len >= s->cap) nset_grow(s, s->len + 1);
    memmove(s->data + i + 1, s->data + i, (size_t)(s->len - i) * sizeof(Number *));
    s->data[i] = v;
    s->len++;
}

void numberset_remove(NumberSet *s, const Number *v) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    if (!s || s->len == 0 || !v) return;
    int32_t i = nset_lower_bound(s->data, s->len, v);
    if (i >= s->len || nset_compare(s->data[i], v) != 0) return;
    memmove(s->data + i, s->data + i + 1, (size_t)(s->len - i - 1) * sizeof(Number *));
    s->len--;
}

void numberset_print(const NumberSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    putchar('{');
    if (s) for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) { putchar(','); putchar(' '); }
        char *es = number_to_string(s->data[i]);
        printf("%s", es);
        free(es);
    }
    puts("}");
}

char *numberset_to_string(const NumberSet *s) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    if (!s || s->len == 0) {
        char *out = (char *)malloc(3); out[0]='{'; out[1]='}'; out[2]='\0'; return out;
    }
    char *body = (char *)malloc(1); body[0] = '\0';
    for (int32_t i = 0; i < s->len; i++) {
        if (i > 0) {
            size_t bl = strlen(body);
            char *t = (char *)malloc(bl + 3);
            memcpy(t, body, bl); t[bl] = ','; t[bl+1] = ' '; t[bl+2] = '\0';
            free(body); body = t;
        }
        char *es = number_to_string(s->data[i]);
        size_t bl = strlen(body), el = strlen(es);
        char *t = (char *)malloc(bl + el + 1);
        memcpy(t, body, bl); memcpy(t + bl, es, el); t[bl+el] = '\0';
        free(body); body = t;
    }
    size_t blen = strlen(body);
    char *out = (char *)malloc(blen + 3);
    out[0] = '{';
    memcpy(out + 1, body, blen);
    out[blen + 1] = '}'; out[blen + 2] = '\0';
    free(body);
    return out;
}

// ── Indexed access (Indexable / Countable protocol support) ───────────────────
//
// All `_at` functions support negative indices (Python-style: -1 = last element).
// Out-of-bounds accesses return a safe default (0, NULL, 0.0, etc.).
//
// Note: BoolSet is backed by bit flags rather than a sorted array, so
// boolset_at iterates the two possible values (false < true) in sorted order.

// intset_at: element at sorted position i (0-based, negative counts from end).
int32_t intset_at(const IntSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: IntSet\n"); abort(); }
    if (!s || s->len == 0) return 0;
    if (i < 0) i = s->len + i;
    if (i < 0 || i >= s->len) return 0;
    return s->data[i];
}

// stringset_at: element at sorted position i.  Returns NULL for OOB.
char *stringset_at(const StringSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: StringSet\n"); abort(); }
    if (!s || s->len == 0) return NULL;
    if (i < 0) i = s->len + i;
    if (i < 0 || i >= s->len) return NULL;
    return s->data[i];
}

// boolset_at: element at sorted position i.
//   Sorted order: false (0) < true (1).
//   Returns 0 (false) for OOB.
int32_t boolset_at(const BoolSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: BoolSet\n"); abort(); }
    if (!s) return 0;
    int32_t sz = boolset_size(s);
    if (sz == 0) return 0;
    if (i < 0) i = sz + i;
    if (i < 0 || i >= sz) return 0;
    // If only one element is present the two possible layouts are:
    //   flags==1 (only false)  → at(0)=0
    //   flags==2 (only true)   → at(0)=1
    //   flags==3 (both)        → at(0)=0, at(1)=1
    if (s->flags == 3) return i;          // 0→false, 1→true
    return (s->flags & 2) ? 1 : 0;       // single element: true or false
}

// floatset_at: element at sorted position i.
float floatset_at(const FloatSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: FloatSet\n"); abort(); }
    if (!s || s->len == 0) return 0.0f;
    if (i < 0) i = s->len + i;
    if (i < 0 || i >= s->len) return 0.0f;
    return s->data[i];
}

// doubleset_at: element at sorted position i.
double doubleset_at(const DoubleSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: DoubleSet\n"); abort(); }
    if (!s || s->len == 0) return 0.0;
    if (i < 0) i = s->len + i;
    if (i < 0 || i >= s->len) return 0.0;
    return s->data[i];
}

// numberset_at: element at sorted position i.  Returns NULL for OOB.
Number *numberset_at(const NumberSet *s, int32_t i) {
    if (s && s->freed) { fprintf(stderr, "use-after-free: NumberSet\n"); abort(); }
    if (!s || s->len == 0) return NULL;
    if (i < 0) i = s->len + i;
    if (i < 0 || i >= s->len) return NULL;
    return s->data[i];
}
