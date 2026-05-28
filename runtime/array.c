#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <assert.h>

// ── IntArray ──────────────────────────────────────────────────────────────────
//
// A heap-allocated, dynamically-sized array of 32-bit signed integers.
//
//   struct IntArray { uint8_t freed; int32_t *data; int32_t len; int32_t cap; }
//
// Growth strategy: double capacity when full, minimum capacity 4.
// All public functions that take an IntArray* accept NULL gracefully where
// it makes sense (length → 0, get → 0, push/pop → no-op).

typedef struct IntArray {
    uint8_t  freed;
    int32_t *data;
    int32_t  len;
    int32_t  cap;
} IntArray;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t ia_normalise(int32_t i, int32_t len) {
    if (i < 0) i = len + i;
    return i;
}

static void ia_grow(IntArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (int32_t *)realloc(a->data, (size_t)cap * sizeof(int32_t));
    a->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

// intarray_new(): allocate an empty IntArray with initial capacity 0.
IntArray *intarray_new(void) {
    IntArray *a = (IntArray *)malloc(sizeof(IntArray));
    a->freed = 0;
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    return a;
}

// intarray_new_with_capacity(cap): allocate an empty IntArray pre-reserved for cap elements.
IntArray *intarray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    IntArray *a = (IntArray *)malloc(sizeof(IntArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (int32_t *)malloc((size_t)cap * sizeof(int32_t)) : NULL;
    return a;
}

// intarray_with(n, v): allocate an IntArray of length n with every element = v.
IntArray *intarray_with(int32_t n, int32_t v) {
    if (n < 0) n = 0;
    IntArray *a = (IntArray *)malloc(sizeof(IntArray));
    a->freed = 0;
    int32_t   cap = n < 4 ? 4 : n;
    a->data = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
    a->len  = n;
    a->cap  = cap;
    for (int32_t i = 0; i < n; i++) a->data[i] = v;
    return a;
}

// intarray_free(a): release all heap memory owned by a.
void intarray_free(IntArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: IntArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}

// ── Basic access ──────────────────────────────────────────────────────────────

// intarray_length(a): number of elements.
int32_t intarray_length(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return a ? a->len : 0;
}

// intarray_get(a, i): element at index i (0-based).  Returns 0 for OOB.
int32_t intarray_get(IntArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return 0;
    return a->data[i];
}

// intarray_at(a, i): like get() but negative indices count from end.
int32_t intarray_at(IntArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return 0;
    int32_t idx = ia_normalise(i, a->len);
    if (idx < 0 || idx >= a->len) return 0;
    return a->data[idx];
}

// intarray_set(a, i, v): write element at index i.  OOB writes are ignored.
void intarray_set(IntArray *a, int32_t i, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return;
    a->data[i] = v;
}

// intarray_first(a): first element or 0 if empty.
int32_t intarray_first(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[0] : 0;
}

// intarray_last(a): last element or 0 if empty.
int32_t intarray_last(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[a->len - 1] : 0;
}

// ── Mutation ──────────────────────────────────────────────────────────────────

// intarray_push(a, v): append v to the end.  Amortised O(1).
void intarray_push(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return;
    if (a->len == a->cap) ia_grow(a, a->len + 1);
    a->data[a->len++] = v;
}

// intarray_pop(a): remove and return the last element.  Returns 0 if empty.
int32_t intarray_pop(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || a->len == 0) return 0;
    return a->data[--a->len];
}

// intarray_unshift(a, v): insert v at the front (O(n)).
void intarray_unshift(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return;
    if (a->len == a->cap) ia_grow(a, a->len + 1);
    memmove(a->data + 1, a->data, (size_t)a->len * sizeof(int32_t));
    a->data[0] = v;
    a->len++;
}

// intarray_shift(a): remove and return the first element (O(n)).  Returns 0 if empty.
int32_t intarray_shift(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || a->len == 0) return 0;
    int32_t v = a->data[0];
    memmove(a->data, a->data + 1, (size_t)(a->len - 1) * sizeof(int32_t));
    a->len--;
    return v;
}

// intarray_fill(a, v): set every element to v (mutates in-place).
void intarray_fill(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return;
    for (int32_t i = 0; i < a->len; i++) a->data[i] = v;
}

// intarray_reverse(a): reverse the array in-place.
void intarray_reverse(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return;
    int32_t lo = 0, hi = a->len - 1;
    while (lo < hi) {
        int32_t tmp  = a->data[lo];
        a->data[lo]  = a->data[hi];
        a->data[hi]  = tmp;
        lo++; hi--;
    }
}

// intarray_sort(a): sort the array in ascending order (in-place).
static int ia_cmp(const void *x, const void *y) {
    int32_t a = *(const int32_t *)x;
    int32_t b = *(const int32_t *)y;
    return (a > b) - (a < b);   // avoids overflow from subtraction
}

void intarray_sort(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || a->len < 2) return;
    qsort(a->data, (size_t)a->len, sizeof(int32_t), ia_cmp);
}

// ── Search ────────────────────────────────────────────────────────────────────

// intarray_index_of(a, v): first position of v, or -1.
int32_t intarray_index_of(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return -1;
    for (int32_t i = 0; i < a->len; i++)
        if (a->data[i] == v) return i;
    return -1;
}

// intarray_last_index_of(a, v): last position of v, or -1.
int32_t intarray_last_index_of(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return -1;
    for (int32_t i = a->len - 1; i >= 0; i--)
        if (a->data[i] == v) return i;
    return -1;
}

// intarray_includes(a, v): 1 if v is in the array, 0 otherwise.
int32_t intarray_includes(IntArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return intarray_index_of(a, v) >= 0 ? 1 : 0;
}

// ── Extraction ────────────────────────────────────────────────────────────────

// intarray_slice(a, start, end): new IntArray containing elements [start, end).
// Negative indices count from the end.
IntArray *intarray_slice(IntArray *a, int32_t start, int32_t end) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a) return intarray_new();
    int32_t len = a->len;
    if (start < 0) start = len + start;
    if (end   < 0) end   = len + end;
    if (start < 0) start = 0;
    if (end > len) end = len;
    if (start >= end) return intarray_new();
    int32_t   n   = end - start;
    IntArray *out = intarray_with(n, 0);
    memcpy(out->data, a->data + start, (size_t)n * sizeof(int32_t));
    return out;
}

// intarray_slice_from(a, start): new IntArray from start to end.
IntArray *intarray_slice_from(IntArray *a, int32_t start) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return intarray_slice(a, start, a ? a->len : 0);
}

// intarray_clone(a): full copy of a.
IntArray *intarray_clone(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    return intarray_slice(a, 0, a ? a->len : 0);
}

// intarray_concat(a, b): new IntArray = a ++ b.
IntArray *intarray_concat(IntArray *a, IntArray *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    int32_t  an  = a ? a->len : 0;
    int32_t  bn  = b ? b->len : 0;
    IntArray *out = intarray_with(an + bn, 0);
    if (a && an) memcpy(out->data,      a->data, (size_t)an * sizeof(int32_t));
    if (b && bn) memcpy(out->data + an, b->data, (size_t)bn * sizeof(int32_t));
    return out;
}

// ── Output ────────────────────────────────────────────────────────────────────

// intarray_join(a, sep): heap-allocated string "v0<sep>v1<sep>...vn".
// sep is a null-terminated C string.
// Caller owns the result and must free it.
char *intarray_join(IntArray *a, const char *sep) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(1);
        s[0] = '\0';
        return s;
    }
    // First pass: compute total length.
    size_t sep_len = strlen(sep);
    size_t total   = 0;
    char   tmp[24];
    for (int32_t i = 0; i < a->len; i++) {
        total += (size_t)snprintf(tmp, sizeof(tmp), "%d", (int)a->data[i]);
        if (i < a->len - 1) total += sep_len;
    }
    char *out = (char *)malloc(total + 1);
    char *ptr = out;
    for (int32_t i = 0; i < a->len; i++) {
        int wrote = snprintf(ptr, total + 1 - (size_t)(ptr - out), "%d", (int)a->data[i]);
        ptr += wrote;
        if (i < a->len - 1) {
            memcpy(ptr, sep, sep_len);
            ptr += sep_len;
        }
    }
    *ptr = '\0';
    return out;
}

// intarray_print(a): print "[v0, v1, ...]" followed by a newline.
void intarray_print(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    putchar('[');
    if (a) {
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("%d", (int)a->data[i]);
        }
    }
    puts("]");
}

// intarray_to_string(a): heap-allocated "[v0, v1, ...]" string.
// Caller owns the result and must free it.
char *intarray_to_string(IntArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: IntArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(3);
        s[0] = '['; s[1] = ']'; s[2] = '\0';
        return s;
    }
    // Delegate to join then wrap.
    char *inner = intarray_join(a, ", ");
    size_t n    = strlen(inner);
    char  *out  = (char *)malloc(n + 3);
    out[0] = '[';
    memcpy(out + 1, inner, n);
    out[n + 1] = ']';
    out[n + 2] = '\0';
    free(inner);
    return out;
}

// ── StringArray ───────────────────────────────────────────────────────────────
//
// A heap-allocated, dynamically-sized array of C string pointers (char*).
//
//   struct StringArray { uint8_t freed; char **data; int32_t len; int32_t cap; }
//
// Ownership: StringArray stores pointers to strings it does NOT own.
// Callers are responsible for the lifetime of the strings themselves.
// stringarray_free() releases only the array structure and the pointer buffer,
// never the individual strings.
//
// Growth strategy: identical to IntArray (doubles, minimum 4).

typedef struct StringArray {
    uint8_t  freed;
    char   **data;
    int32_t  len;
    int32_t  cap;
} StringArray;

static const char *SA_EMPTY_STR = "";

// ── Internal helpers ──────────────────────────────────────────────────────────

static void sa_grow(StringArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (char **)realloc(a->data, (size_t)cap * sizeof(char *));
    a->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

StringArray *stringarray_new(void) {
    StringArray *a = (StringArray *)malloc(sizeof(StringArray));
    a->freed = 0;
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    return a;
}

// stringarray_new_with_capacity(cap): empty StringArray pre-reserved for cap elements.
StringArray *stringarray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    StringArray *a = (StringArray *)malloc(sizeof(StringArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (char **)malloc((size_t)cap * sizeof(char *)) : NULL;
    return a;
}

// stringarray_with(n, v): n elements all pointing to the same string v.
StringArray *stringarray_with(int32_t n, const char *v) {
    if (n < 0) n = 0;
    StringArray *a   = (StringArray *)malloc(sizeof(StringArray));
    a->freed = 0;
    int32_t      cap = n < 4 ? 4 : n;
    a->data = (char **)malloc((size_t)cap * sizeof(char *));
    a->len  = n;
    a->cap  = cap;
    for (int32_t i = 0; i < n; i++) a->data[i] = (char *)v;
    return a;
}

void stringarray_free(StringArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: StringArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}

// ── Basic access ──────────────────────────────────────────────────────────────

int32_t stringarray_length(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return a ? a->len : 0;
}

const char *stringarray_get(StringArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return SA_EMPTY_STR;
    return a->data[i];
}

const char *stringarray_at(StringArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return SA_EMPTY_STR;
    int32_t idx = ia_normalise(i, a->len);   // reuse from IntArray section
    if (idx < 0 || idx >= a->len) return SA_EMPTY_STR;
    return a->data[idx];
}

void stringarray_set(StringArray *a, int32_t i, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return;
    a->data[i] = (char *)v;
}

const char *stringarray_first(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[0] : SA_EMPTY_STR;
}

const char *stringarray_last(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[a->len - 1] : SA_EMPTY_STR;
}

// ── Mutation ──────────────────────────────────────────────────────────────────

void stringarray_push(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return;
    if (a->len == a->cap) sa_grow(a, a->len + 1);
    a->data[a->len++] = (char *)v;
}

const char *stringarray_pop(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || a->len == 0) return SA_EMPTY_STR;
    return a->data[--a->len];
}

void stringarray_unshift(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return;
    if (a->len == a->cap) sa_grow(a, a->len + 1);
    memmove(a->data + 1, a->data, (size_t)a->len * sizeof(char *));
    a->data[0] = (char *)v;
    a->len++;
}

const char *stringarray_shift(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || a->len == 0) return SA_EMPTY_STR;
    const char *v = a->data[0];
    memmove(a->data, a->data + 1, (size_t)(a->len - 1) * sizeof(char *));
    a->len--;
    return v;
}

void stringarray_fill(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return;
    for (int32_t i = 0; i < a->len; i++) a->data[i] = (char *)v;
}

void stringarray_reverse(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return;
    int32_t lo = 0, hi = a->len - 1;
    while (lo < hi) {
        char *tmp    = a->data[lo];
        a->data[lo]  = a->data[hi];
        a->data[hi]  = tmp;
        lo++; hi--;
    }
}

static int sa_cmp(const void *x, const void *y) {
    return strcmp(*(const char **)x, *(const char **)y);
}

void stringarray_sort(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || a->len < 2) return;
    qsort(a->data, (size_t)a->len, sizeof(char *), sa_cmp);
}

// ── Search ────────────────────────────────────────────────────────────────────

int32_t stringarray_index_of(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return -1;
    for (int32_t i = 0; i < a->len; i++)
        if (strcmp(a->data[i], v) == 0) return i;
    return -1;
}

int32_t stringarray_last_index_of(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return -1;
    for (int32_t i = a->len - 1; i >= 0; i--)
        if (strcmp(a->data[i], v) == 0) return i;
    return -1;
}

int32_t stringarray_includes(StringArray *a, const char *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return stringarray_index_of(a, v) >= 0 ? 1 : 0;
}

// ── Extraction ────────────────────────────────────────────────────────────────

StringArray *stringarray_slice(StringArray *a, int32_t start, int32_t end) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a) return stringarray_new();
    int32_t len = a->len;
    if (start < 0) start = len + start;
    if (end   < 0) end   = len + end;
    if (start < 0) start = 0;
    if (end > len) end = len;
    if (start >= end) return stringarray_new();
    int32_t      n   = end - start;
    StringArray *out = stringarray_with(0, NULL);
    out->len = n;
    int32_t cap = n < 4 ? 4 : n;
    out->data = (char **)malloc((size_t)cap * sizeof(char *));
    out->cap  = cap;
    memcpy(out->data, a->data + start, (size_t)n * sizeof(char *));
    return out;
}

StringArray *stringarray_slice_from(StringArray *a, int32_t start) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return stringarray_slice(a, start, a ? a->len : 0);
}

StringArray *stringarray_clone(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    return stringarray_slice(a, 0, a ? a->len : 0);
}

StringArray *stringarray_concat(StringArray *a, StringArray *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    int32_t an = a ? a->len : 0;
    int32_t bn = b ? b->len : 0;
    StringArray *out = stringarray_with(0, NULL);
    int32_t n = an + bn;
    int32_t cap = n < 4 ? 4 : n;
    out->data = (char **)malloc((size_t)cap * sizeof(char *));
    out->cap  = cap;
    out->len  = n;
    if (a && an) memcpy(out->data,      a->data, (size_t)an * sizeof(char *));
    if (b && bn) memcpy(out->data + an, b->data, (size_t)bn * sizeof(char *));
    return out;
}

// ── Output ────────────────────────────────────────────────────────────────────

// stringarray_join(a, sep): "s0<sep>s1<sep>...sn" — no quotes.
char *stringarray_join(StringArray *a, const char *sep) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(1);
        s[0] = '\0';
        return s;
    }
    size_t sep_len = strlen(sep);
    size_t total   = 0;
    for (int32_t i = 0; i < a->len; i++) {
        total += strlen(a->data[i]);
        if (i < a->len - 1) total += sep_len;
    }
    char *out = (char *)malloc(total + 1);
    char *ptr = out;
    for (int32_t i = 0; i < a->len; i++) {
        size_t slen = strlen(a->data[i]);
        memcpy(ptr, a->data[i], slen);
        ptr += slen;
        if (i < a->len - 1) {
            memcpy(ptr, sep, sep_len);
            ptr += sep_len;
        }
    }
    *ptr = '\0';
    return out;
}

// stringarray_to_string(a): ["s0", "s1", ...] with quoted elements.
char *stringarray_to_string(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(3);
        s[0] = '['; s[1] = ']'; s[2] = '\0';
        return s;
    }
    // Compute total: '[' + ('"' + elem + '"' + ', ') * n + ']'
    size_t total = 2;  // [ and ]
    for (int32_t i = 0; i < a->len; i++) {
        total += 2 + strlen(a->data[i]);   // quotes
        if (i < a->len - 1) total += 2;   // ", "
    }
    char *out = (char *)malloc(total + 1);
    char *ptr = out;
    *ptr++ = '[';
    for (int32_t i = 0; i < a->len; i++) {
        *ptr++ = '"';
        size_t slen = strlen(a->data[i]);
        memcpy(ptr, a->data[i], slen);
        ptr += slen;
        *ptr++ = '"';
        if (i < a->len - 1) { *ptr++ = ','; *ptr++ = ' '; }
    }
    *ptr++ = ']';
    *ptr   = '\0';
    return out;
}

// stringarray_print(a): prints ["s0", "s1", ...] followed by a newline.
void stringarray_print(StringArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: StringArray\n"); abort(); }
    putchar('[');
    if (a) {
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            putchar('"');
            fputs(a->data[i], stdout);
            putchar('"');
        }
    }
    puts("]");
}

// ── BoolArray ─────────────────────────────────────────────────────────────────
//
// Heap-allocated, dynamically-sized array of booleans stored as int32_t (0/1).
//
//   struct BoolArray { uint8_t freed; int32_t *data; int32_t len; int32_t cap; }

typedef struct BoolArray {
    uint8_t  freed;
    int32_t *data;
    int32_t  len;
    int32_t  cap;
} BoolArray;

static int32_t ba_normalise(int32_t i, int32_t len) {
    if (i < 0) i = len + i;
    return i;
}

static void ba_grow(BoolArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (int32_t *)realloc(a->data, (size_t)cap * sizeof(int32_t));
    a->cap  = cap;
}

BoolArray *boolarray_new(void) {
    BoolArray *a = (BoolArray *)malloc(sizeof(BoolArray));
    a->freed = 0;
    a->data = NULL; a->len = 0; a->cap = 0;
    return a;
}

// boolarray_new_with_capacity(cap): empty BoolArray pre-reserved for cap elements.
BoolArray *boolarray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    BoolArray *a = (BoolArray *)malloc(sizeof(BoolArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (int32_t *)malloc((size_t)cap * sizeof(int32_t)) : NULL;
    return a;
}

void boolarray_free(BoolArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: BoolArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}

int32_t boolarray_length(const BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return a ? a->len : 0;
}

int32_t boolarray_get(const BoolArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return 0;
    return a->data[i] ? 1 : 0;
}

int32_t boolarray_at(const BoolArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a) return 0;
    i = ba_normalise(i, a->len);
    if (i < 0 || i >= a->len) return 0;
    return a->data[i] ? 1 : 0;
}

void boolarray_set(BoolArray *a, int32_t i, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a || i < 0 || i >= a->len) return;
    a->data[i] = v ? 1 : 0;
}

int32_t boolarray_first(const BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return (!a || a->len == 0) ? 0 : (a->data[0] ? 1 : 0);
}

int32_t boolarray_last(const BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return (!a || a->len == 0) ? 0 : (a->data[a->len - 1] ? 1 : 0);
}

void boolarray_push(BoolArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a) return;
    if (a->len >= a->cap) ba_grow(a, a->len + 1);
    a->data[a->len++] = v ? 1 : 0;
}

int32_t boolarray_pop(BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a || a->len == 0) return 0;
    return a->data[--a->len] ? 1 : 0;
}

int32_t boolarray_index_of(const BoolArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a) return -1;
    int32_t val = v ? 1 : 0;
    for (int32_t i = 0; i < a->len; i++)
        if (a->data[i] == val) return i;
    return -1;
}

int32_t boolarray_includes(const BoolArray *a, int32_t v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return boolarray_index_of(a, v) >= 0 ? 1 : 0;
}

BoolArray *boolarray_slice(const BoolArray *a, int32_t start, int32_t end) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (!a) return boolarray_new();
    start = ba_normalise(start, a->len);
    end   = ba_normalise(end,   a->len);
    if (start < 0) start = 0;
    if (end > a->len) end = a->len;
    if (start >= end) return boolarray_new();
    int32_t    n   = end - start;
    BoolArray *b   = (BoolArray *)malloc(sizeof(BoolArray));
    b->freed = 0;
    int32_t    cap = n < 4 ? 4 : n;
    b->data = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
    b->len = n; b->cap = cap;
    memcpy(b->data, a->data + start, (size_t)n * sizeof(int32_t));
    return b;
}

BoolArray *boolarray_slice_from(const BoolArray *a, int32_t start) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return boolarray_slice(a, start, a ? a->len : 0);
}

BoolArray *boolarray_clone(const BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    return boolarray_slice(a, 0, a ? a->len : 0);
}

BoolArray *boolarray_concat(const BoolArray *a, const BoolArray *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    int32_t la = a ? a->len : 0, lb = b ? b->len : 0, n = la + lb;
    BoolArray *c  = (BoolArray *)malloc(sizeof(BoolArray));
    c->freed = 0;
    int32_t    cap = n < 4 ? 4 : n;
    c->data = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
    c->len = n; c->cap = cap;
    if (la > 0) memcpy(c->data,      a->data, (size_t)la * sizeof(int32_t));
    if (lb > 0) memcpy(c->data + la, b->data, (size_t)lb * sizeof(int32_t));
    return c;
}

char *boolarray_to_string(const BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    size_t need = 3;
    if (a)
        for (int32_t i = 0; i < a->len; i++) {
            need += a->data[i] ? 4 : 5;
            if (i < a->len - 1) need += 2;
        }
    char *out = (char *)malloc(need), *ptr = out;
    *ptr++ = '[';
    if (a)
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { *ptr++ = ','; *ptr++ = ' '; }
            const char *s = a->data[i] ? "true" : "false";
            size_t      l = a->data[i] ? 4 : 5;
            memcpy(ptr, s, l); ptr += l;
        }
    *ptr++ = ']'; *ptr = '\0';
    return out;
}

void boolarray_print(BoolArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: BoolArray\n"); abort(); }
    putchar('[');
    if (a)
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            fputs(a->data[i] ? "true" : "false", stdout);
        }
    puts("]");
}

// ── PtrArray (shared backing for NumberArray and AnyArray) ────────────────────
//
// Stores void* pointers; NumberArray uses it for Number*, AnyArray for Any*.

typedef struct PtrArray {
    uint8_t  freed;
    void   **data;
    int32_t  len;
    int32_t  cap;
} PtrArray;

static int32_t pa_normalise(int32_t i, int32_t len) {
    if (i < 0) i = len + i;
    return i;
}

static void pa_grow(PtrArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (void **)realloc(a->data, (size_t)cap * sizeof(void *));
    a->cap  = cap;
}

PtrArray *ptrarray_new(void) {
    PtrArray *a = (PtrArray *)malloc(sizeof(PtrArray));
    a->freed = 0;
    a->data = NULL; a->len = 0; a->cap = 0;
    return a;
}
// ptrarray_new_with_capacity(cap): empty PtrArray pre-reserved for cap elements.
PtrArray *ptrarray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    PtrArray *a = (PtrArray *)malloc(sizeof(PtrArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (void **)malloc((size_t)cap * sizeof(void *)) : NULL;
    return a;
}

void    ptrarray_free(PtrArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: PtrArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}
int32_t ptrarray_length(const PtrArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return a ? a->len : 0;
}
void   *ptrarray_get(const PtrArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return (!a || i < 0 || i >= a->len) ? NULL : a->data[i];
}
static void   *ptrarray_first(const PtrArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[0] : NULL;
}
static void   *ptrarray_last(const PtrArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[a->len-1] : NULL;
}
void    ptrarray_set(PtrArray *a, int32_t i, void *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (a && i >= 0 && i < a->len) a->data[i] = v;
}
void    ptrarray_push(PtrArray *a, void *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (!a) return;
    if (a->len >= a->cap) pa_grow(a, a->len + 1);
    a->data[a->len++] = v;
}
static void   *ptrarray_pop(PtrArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return (!a || a->len == 0) ? NULL : a->data[--a->len];
}
static int32_t ptrarray_index_of(const PtrArray *a, void *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (!a) return -1;
    for (int32_t i = 0; i < a->len; i++) if (a->data[i] == v) return i;
    return -1;
}
static int32_t ptrarray_includes(const PtrArray *a, void *v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return ptrarray_index_of(a, v) >= 0 ? 1 : 0;
}

static void *ptrarray_at(const PtrArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (!a) return NULL;
    i = pa_normalise(i, a->len);
    return (i < 0 || i >= a->len) ? NULL : a->data[i];
}

static PtrArray *ptrarray_slice(const PtrArray *a, int32_t start, int32_t end) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (!a) return ptrarray_new();
    start = pa_normalise(start, a->len); end = pa_normalise(end, a->len);
    if (start < 0) start = 0; if (end > a->len) end = a->len;
    if (start >= end) return ptrarray_new();
    int32_t   n   = end - start;
    PtrArray *b   = (PtrArray *)malloc(sizeof(PtrArray));
    b->freed = 0;
    int32_t   cap = n < 4 ? 4 : n;
    b->data = (void **)malloc((size_t)cap * sizeof(void *)); b->len = n; b->cap = cap;
    memcpy(b->data, a->data + start, (size_t)n * sizeof(void *));
    return b;
}
static PtrArray *ptrarray_clone(const PtrArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    return ptrarray_slice(a, 0, a ? a->len : 0);
}
static PtrArray *ptrarray_concat(const PtrArray *a, const PtrArray *b) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    if (b && b->freed) { fprintf(stderr, "use-after-free: PtrArray\n"); abort(); }
    int32_t la = a ? a->len : 0, lb = b ? b->len : 0, n = la + lb;
    PtrArray *c = (PtrArray *)malloc(sizeof(PtrArray));
    c->freed = 0;
    int32_t  cap = n < 4 ? 4 : n;
    c->data = (void **)malloc((size_t)cap * sizeof(void *)); c->len = n; c->cap = cap;
    if (la > 0) memcpy(c->data,      a->data, (size_t)la * sizeof(void *));
    if (lb > 0) memcpy(c->data + la, b->data, (size_t)lb * sizeof(void *));
    return c;
}

// ── NumberArray ───────────────────────────────────────────────────────────────
// Stores Number* (from number.c) as void*.

typedef PtrArray NumberArray;

/* Forward declarations — resolved at link time */
extern void  number_print(void *n);
extern char *number_to_string(void *n);
extern char *concat(const char *a, const char *b);

NumberArray *numberarray_new(void)                                          { return ptrarray_new(); }
NumberArray *numberarray_new_with_capacity(int32_t cap)                     { return ptrarray_new_with_capacity(cap); }
void         numberarray_free(NumberArray *a)                               { ptrarray_free(a); }
int32_t      numberarray_length(const NumberArray *a)                       { return ptrarray_length(a); }
void        *numberarray_get(const NumberArray *a, int32_t i)               { return ptrarray_get(a, i); }
void        *numberarray_at(const NumberArray *a, int32_t i)                { return ptrarray_at(a, i); }
void         numberarray_set(NumberArray *a, int32_t i, void *v)            { ptrarray_set(a, i, v); }
void        *numberarray_first(const NumberArray *a)                        { return ptrarray_first(a); }
void        *numberarray_last(const NumberArray *a)                         { return ptrarray_last(a); }
void         numberarray_push(NumberArray *a, void *v)                      { ptrarray_push(a, v); }
void        *numberarray_pop(NumberArray *a)                                { return ptrarray_pop(a); }
int32_t      numberarray_index_of(const NumberArray *a, void *v)            { return ptrarray_index_of(a, v); }
int32_t      numberarray_includes(const NumberArray *a, void *v)            { return ptrarray_includes(a, v); }
NumberArray *numberarray_slice(const NumberArray *a, int32_t s, int32_t e)  { return ptrarray_slice(a, s, e); }
NumberArray *numberarray_slice_from(const NumberArray *a, int32_t s)        { return ptrarray_slice(a, s, a ? a->len : 0); }
NumberArray *numberarray_clone(const NumberArray *a)                        { return ptrarray_clone(a); }
NumberArray *numberarray_concat(const NumberArray *a, const NumberArray *b) { return ptrarray_concat(a, b); }

void numberarray_print(NumberArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: NumberArray\n"); abort(); }
    putchar('[');
    if (a)
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            number_print(a->data[i]);
        }
    puts("]");
}

char *numberarray_to_string(const NumberArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: NumberArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(3); s[0]='['; s[1]=']'; s[2]='\0'; return s;
    }
    char *body = (char *)malloc(1); body[0] = '\0';
    for (int32_t i = 0; i < a->len; i++) {
        if (i > 0) { char *t = concat(body, ", "); free(body); body = t; }
        char *es = number_to_string(a->data[i]);
        char *t  = concat(body, es); free(body); body = t;
    }
    size_t blen = strlen(body);
    char *out = (char *)malloc(blen + 3);
    out[0] = '[';
    memcpy(out + 1, body, blen);
    out[blen + 1] = ']'; out[blen + 2] = '\0';
    free(body);
    return out;
}

// ── AnyArray ──────────────────────────────────────────────────────────────────
// Stores Any* (opaque) as void*. Prints "<Any>" placeholder per element.

typedef PtrArray AnyArray;

AnyArray *anyarray_new(void)                                          { return ptrarray_new(); }
AnyArray *anyarray_new_with_capacity(int32_t cap)                     { return ptrarray_new_with_capacity(cap); }
void      anyarray_free(AnyArray *a)                                  { ptrarray_free(a); }
int32_t   anyarray_length(const AnyArray *a)                          { return ptrarray_length(a); }
void     *anyarray_get(const AnyArray *a, int32_t i)                  { return ptrarray_get(a, i); }
void     *anyarray_at(const AnyArray *a, int32_t i)                   { return ptrarray_at(a, i); }
void      anyarray_set(AnyArray *a, int32_t i, void *v)               { ptrarray_set(a, i, v); }
void     *anyarray_first(const AnyArray *a)                           { return ptrarray_first(a); }
void     *anyarray_last(const AnyArray *a)                            { return ptrarray_last(a); }
void      anyarray_push(AnyArray *a, void *v)                         { ptrarray_push(a, v); }
void     *anyarray_pop(AnyArray *a)                                   { return ptrarray_pop(a); }
int32_t   anyarray_index_of(const AnyArray *a, void *v)               { return ptrarray_index_of(a, v); }
int32_t   anyarray_includes(const AnyArray *a, void *v)               { return ptrarray_includes(a, v); }
AnyArray *anyarray_slice(const AnyArray *a, int32_t s, int32_t e)     { return ptrarray_slice(a, s, e); }
AnyArray *anyarray_slice_from(const AnyArray *a, int32_t s)           { return ptrarray_slice(a, s, a ? a->len : 0); }
AnyArray *anyarray_clone(const AnyArray *a)                           { return ptrarray_clone(a); }
AnyArray *anyarray_concat(const AnyArray *a, const AnyArray *b)       { return ptrarray_concat(a, b); }

void anyarray_print(AnyArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: AnyArray\n"); abort(); }
    putchar('[');
    if (a)
        for (int32_t i = 0; i < a->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            fputs("<Any>", stdout);
        }
    puts("]");
}

char *anyarray_to_string(const AnyArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: AnyArray\n"); abort(); }
    int32_t n    = a ? a->len : 0;
    size_t  need = 3 + (n > 0 ? (size_t)n * 5 + (size_t)(n - 1) * 2 : 0);
    char *out = (char *)malloc(need), *ptr = out;
    *ptr++ = '[';
    for (int32_t i = 0; i < n; i++) {
        if (i > 0) { *ptr++ = ','; *ptr++ = ' '; }
        memcpy(ptr, "<Any>", 5); ptr += 5;
    }
    *ptr++ = ']'; *ptr = '\0';
    return out;
}

// ── FloatArray ────────────────────────────────────────────────────────────────
//
// A heap-allocated, dynamically-sized array of 32-bit single-precision floats.
//
//   struct FloatArray { uint8_t freed; float *data; int32_t len; int32_t cap; }

typedef struct FloatArray {
    uint8_t  freed;
    float   *data;
    int32_t  len;
    int32_t  cap;
} FloatArray;

static void fa_grow(FloatArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (float *)realloc(a->data, (size_t)cap * sizeof(float));
    a->cap  = cap;
}

FloatArray *floatarray_new(void) {
    FloatArray *a = (FloatArray *)malloc(sizeof(FloatArray));
    a->freed = 0;
    a->data = NULL; a->len = 0; a->cap = 0;
    return a;
}

// floatarray_new_with_capacity(cap): empty FloatArray pre-reserved for cap elements.
FloatArray *floatarray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    FloatArray *a = (FloatArray *)malloc(sizeof(FloatArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (float *)malloc((size_t)cap * sizeof(float)) : NULL;
    return a;
}

FloatArray *floatarray_with(int32_t n, float v) {
    if (n < 0) n = 0;
    FloatArray *a = (FloatArray *)malloc(sizeof(FloatArray));
    a->freed = 0;
    int32_t cap = n < 4 ? 4 : n;
    a->data = (float *)malloc((size_t)cap * sizeof(float));
    a->len = n; a->cap = cap;
    for (int32_t i = 0; i < n; i++) a->data[i] = v;
    return a;
}

void floatarray_free(FloatArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: FloatArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}

int32_t floatarray_length(const FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    return a ? a->len : 0;
}
float   floatarray_get(const FloatArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    return (a && i >= 0 && i < a->len) ? a->data[i] : 0.0f;
}
void    floatarray_set(FloatArray *a, int32_t i, float v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (a && i >= 0 && i < a->len) a->data[i] = v;
}
float   floatarray_first(const FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[0] : 0.0f;
}
float   floatarray_last(const FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[a->len-1] : 0.0f;
}

void floatarray_push(FloatArray *a, float v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (!a) return;
    if (a->len >= a->cap) fa_grow(a, a->len + 1);
    a->data[a->len++] = v;
}

float floatarray_pop(FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (!a || a->len == 0) return 0.0f;
    return a->data[--a->len];
}

void  floatarray_fill(FloatArray *a, float v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (a) for (int32_t i = 0; i < a->len; i++) a->data[i] = v;
}

static int fa_cmp(const void *x, const void *y) {
    float a = *(const float*)x, b = *(const float*)y;
    return (a > b) - (a < b);
}
void floatarray_sort(FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (a && a->len > 1) qsort(a->data, (size_t)a->len, sizeof(float), fa_cmp);
}

void floatarray_reverse(FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (!a) return;
    for (int32_t i = 0, j = a->len-1; i < j; i++, j--) {
        float t = a->data[i]; a->data[i] = a->data[j]; a->data[j] = t;
    }
}

void floatarray_print(FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    putchar('[');
    if (a) for (int32_t i = 0; i < a->len; i++) {
        if (i > 0) { putchar(','); putchar(' '); }
        printf("%.15g", (double)a->data[i]);
    }
    puts("]");
}

char *floatarray_to_string(const FloatArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: FloatArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(3); s[0]='['; s[1]=']'; s[2]='\0'; return s;
    }
    char tmp[32];
    size_t total = 2; // "[]"
    for (int32_t i = 0; i < a->len; i++) {
        total += (size_t)snprintf(tmp, sizeof(tmp), "%.15g", (double)a->data[i]);
        if (i < a->len - 1) total += 2; // ", "
    }
    char *out = (char *)malloc(total + 1);
    char *ptr = out;
    *ptr++ = '[';
    for (int32_t i = 0; i < a->len; i++) {
        if (i > 0) { *ptr++ = ','; *ptr++ = ' '; }
        int w = snprintf(ptr, (size_t)(out + total + 1 - ptr), "%.15g", (double)a->data[i]);
        ptr += w;
    }
    *ptr++ = ']'; *ptr = '\0';
    return out;
}

// ── DoubleArray ───────────────────────────────────────────────────────────────
//
// A heap-allocated, dynamically-sized array of 64-bit double-precision floats.

typedef struct DoubleArray {
    uint8_t  freed;
    double  *data;
    int32_t  len;
    int32_t  cap;
} DoubleArray;

static void da_grow(DoubleArray *a, int32_t min_cap) {
    int32_t cap = a->cap < 4 ? 4 : a->cap;
    while (cap < min_cap) cap *= 2;
    a->data = (double *)realloc(a->data, (size_t)cap * sizeof(double));
    a->cap  = cap;
}

DoubleArray *doublearray_new(void) {
    DoubleArray *a = (DoubleArray *)malloc(sizeof(DoubleArray));
    a->freed = 0;
    a->data = NULL; a->len = 0; a->cap = 0;
    return a;
}

// doublearray_new_with_capacity(cap): empty DoubleArray pre-reserved for cap elements.
DoubleArray *doublearray_new_with_capacity(int32_t cap) {
    if (cap < 0) cap = 0;
    DoubleArray *a = (DoubleArray *)malloc(sizeof(DoubleArray));
    a->freed = 0;
    a->len  = 0;
    a->cap  = cap;
    a->data = cap > 0 ? (double *)malloc((size_t)cap * sizeof(double)) : NULL;
    return a;
}

DoubleArray *doublearray_with(int32_t n, double v) {
    if (n < 0) n = 0;
    DoubleArray *a = (DoubleArray *)malloc(sizeof(DoubleArray));
    a->freed = 0;
    int32_t cap = n < 4 ? 4 : n;
    a->data = (double *)malloc((size_t)cap * sizeof(double));
    a->len = n; a->cap = cap;
    for (int32_t i = 0; i < n; i++) a->data[i] = v;
    return a;
}

void doublearray_free(DoubleArray *a) {
    if (!a) return;
    if (a->freed) { fprintf(stderr, "double-free: DoubleArray\n"); abort(); }
    a->freed = 1;
    free(a->data);
    a->data = NULL;
    a->len  = 0;
    a->cap  = 0;
    // DO NOT free(a) — keep as tombstone
}

int32_t doublearray_length(const DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    return a ? a->len : 0;
}
double  doublearray_get(const DoubleArray *a, int32_t i) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    return (a && i >= 0 && i < a->len) ? a->data[i] : 0.0;
}
void    doublearray_set(DoubleArray *a, int32_t i, double v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (a && i >= 0 && i < a->len) a->data[i] = v;
}
double  doublearray_first(const DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[0] : 0.0;
}
double  doublearray_last(const DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    return (a && a->len > 0) ? a->data[a->len-1] : 0.0;
}

void doublearray_push(DoubleArray *a, double v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (!a) return;
    if (a->len >= a->cap) da_grow(a, a->len + 1);
    a->data[a->len++] = v;
}

double doublearray_pop(DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (!a || a->len == 0) return 0.0;
    return a->data[--a->len];
}

void doublearray_fill(DoubleArray *a, double v) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (a) for (int32_t i = 0; i < a->len; i++) a->data[i] = v;
}

static int da_cmp(const void *x, const void *y) {
    double a = *(const double*)x, b = *(const double*)y;
    return (a > b) - (a < b);
}
void doublearray_sort(DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (a && a->len > 1) qsort(a->data, (size_t)a->len, sizeof(double), da_cmp);
}

void doublearray_reverse(DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (!a) return;
    for (int32_t i = 0, j = a->len-1; i < j; i++, j--) {
        double t = a->data[i]; a->data[i] = a->data[j]; a->data[j] = t;
    }
}

void doublearray_print(DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    putchar('[');
    if (a) for (int32_t i = 0; i < a->len; i++) {
        if (i > 0) { putchar(','); putchar(' '); }
        printf("%.15g", a->data[i]);
    }
    puts("]");
}

char *doublearray_to_string(const DoubleArray *a) {
    if (a && a->freed) { fprintf(stderr, "use-after-free: DoubleArray\n"); abort(); }
    if (!a || a->len == 0) {
        char *s = (char *)malloc(3); s[0]='['; s[1]=']'; s[2]='\0'; return s;
    }
    char tmp[32];
    size_t total = 2;
    for (int32_t i = 0; i < a->len; i++) {
        total += (size_t)snprintf(tmp, sizeof(tmp), "%.15g", a->data[i]);
        if (i < a->len - 1) total += 2;
    }
    char *out = (char *)malloc(total + 1);
    char *ptr = out;
    *ptr++ = '[';
    for (int32_t i = 0; i < a->len; i++) {
        if (i > 0) { *ptr++ = ','; *ptr++ = ' '; }
        int w = snprintf(ptr, (size_t)(out + total + 1 - ptr), "%.15g", a->data[i]);
        ptr += w;
    }
    *ptr++ = ']'; *ptr = '\0';
    return out;
}
