#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <assert.h>

// ── IntIntMap ─────────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from int32_t keys to int32_t values.
//
//   struct IntIntMap { uint8_t freed; IntIntEntry *data; int32_t len; int32_t cap; }
//
// Entries are kept in ascending key order so binary search gives O(log n)
// lookups. Growth strategy: double capacity when full, minimum capacity 4.
// NULL is accepted gracefully by all public functions.

typedef struct { int32_t key; int32_t val; } IntIntEntry;
typedef struct IntIntMap { uint8_t freed; IntIntEntry *data; int32_t len, cap; } IntIntMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t iim_lower_bound(const IntIntEntry *data, int32_t len, int32_t key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid].key < key) lo = mid + 1;
        else                     hi = mid;
    }
    return lo;
}

static void iim_grow(IntIntMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (IntIntEntry *)realloc(m->data, (size_t)cap * sizeof(IntIntEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

IntIntMap *intintmap_new(void) {
    IntIntMap *m = (IntIntMap *)malloc(sizeof(IntIntMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void intintmap_free(IntIntMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: IntIntMap\n"); abort(); }
    m->freed = 1;
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t intintmap_size(const IntIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    return m ? m->len : 0;
}

int intintmap_contains(const IntIntMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = iim_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

int32_t intintmap_get(const IntIntMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = iim_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return 0;
}

void intintmap_put(IntIntMap *m, int32_t key, int32_t val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    if (!m) return;
    int32_t i = iim_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) iim_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(IntIntEntry));
    m->data[i].key = key;
    m->data[i].val = val;
    m->len++;
}

void intintmap_remove(IntIntMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = iim_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(IntIntEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void intintmap_print(const IntIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("%d: %d", (int)m->data[i].key, (int)m->data[i].val);
        }
    }
    puts("}");
}

char *intintmap_to_string(const IntIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntIntMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Each entry: up to 11 chars for key + ": " + up to 11 chars for val = 24, plus ", "
    size_t buflen = 2 + (size_t)m->len * 26 + 1;
    char  *buf    = (char *)malloc(buflen);
    size_t pos    = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int written = snprintf(buf + pos, buflen - pos, "%d: %d",
                               (int)m->data[i].key, (int)m->data[i].val);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── IntStringMap ──────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from int32_t keys to heap-owned char* values.
//
//   struct IntStringMap { uint8_t freed; IntStringEntry *data; int32_t len; int32_t cap; }
//
// Values are heap-owned: strdup on put, free on remove/free.
// Entries are kept in ascending key order (binary search, O(log n)).

typedef struct { int32_t key; char *val; } IntStringEntry;
typedef struct IntStringMap { uint8_t freed; IntStringEntry *data; int32_t len, cap; } IntStringMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t ism_lower_bound(const IntStringEntry *data, int32_t len, int32_t key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid].key < key) lo = mid + 1;
        else                     hi = mid;
    }
    return lo;
}

static void ism_grow(IntStringMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (IntStringEntry *)realloc(m->data, (size_t)cap * sizeof(IntStringEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

IntStringMap *intstringmap_new(void) {
    IntStringMap *m = (IntStringMap *)malloc(sizeof(IntStringMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void intstringmap_free(IntStringMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: IntStringMap\n"); abort(); }
    m->freed = 1;
    for (int32_t i = 0; i < m->len; i++) free(m->data[i].val);
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t intstringmap_size(const IntStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    return m ? m->len : 0;
}

int intstringmap_contains(const IntStringMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = ism_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

char *intstringmap_get(const IntStringMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = ism_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return 0;
}

void intstringmap_put(IntStringMap *m, int32_t key, const char *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    if (!m) return;
    int32_t i = ism_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        free(m->data[i].val);
        m->data[i].val = val ? strdup(val) : NULL;
        return;
    }
    if (m->len >= m->cap) ism_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(IntStringEntry));
    m->data[i].key = key;
    m->data[i].val = val ? strdup(val) : NULL;
    m->len++;
}

void intstringmap_remove(IntStringMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = ism_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    free(m->data[i].val);
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(IntStringEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void intstringmap_print(const IntStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            const char *v = m->data[i].val ? m->data[i].val : "";
            printf("%d: \"%s\"", (int)m->data[i].key, v);
        }
    }
    puts("}");
}

char *intstringmap_to_string(const IntStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntStringMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: key (11) + ": \"" (3) + val + "\"" (1), plus ", " (2)
    size_t total = 2;  // "{}"
    for (int32_t i = 0; i < m->len; i++) {
        total += 11 + 3 + 1;  // key digits + `: "` + closing `"`
        total += m->data[i].val ? strlen(m->data[i].val) : 0;
        if (i > 0) total += 2;  // ", "
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        const char *v = m->data[i].val ? m->data[i].val : "";
        int written = snprintf(buf + pos, total - pos, "%d: \"%s\"",
                               (int)m->data[i].key, v);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── StringIntMap ──────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from heap-owned char* keys to int32_t values.
//
//   struct StringIntMap { uint8_t freed; StringIntEntry *data; int32_t len; int32_t cap; }
//
// Keys are heap-owned: strdup on put, free on remove/free.
// Entries are kept in lexicographic key order (strcmp, binary search, O(log n)).

typedef struct { char *key; int32_t val; } StringIntEntry;
typedef struct StringIntMap { uint8_t freed; StringIntEntry *data; int32_t len, cap; } StringIntMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t sim_lower_bound(const StringIntEntry *data, int32_t len, const char *key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (strcmp(data[mid].key, key) < 0) lo = mid + 1;
        else                                hi = mid;
    }
    return lo;
}

static void sim_grow(StringIntMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (StringIntEntry *)realloc(m->data, (size_t)cap * sizeof(StringIntEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

StringIntMap *stringintmap_new(void) {
    StringIntMap *m = (StringIntMap *)malloc(sizeof(StringIntMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void stringintmap_free(StringIntMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: StringIntMap\n"); abort(); }
    m->freed = 1;
    for (int32_t i = 0; i < m->len; i++) free(m->data[i].key);
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t stringintmap_size(const StringIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    return m ? m->len : 0;
}

int stringintmap_contains(const StringIntMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return 0;
    int32_t i = sim_lower_bound(m->data, m->len, key);
    return (i < m->len && strcmp(m->data[i].key, key) == 0) ? 1 : 0;
}

int32_t stringintmap_get(const StringIntMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return 0;
    int32_t i = sim_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) return m->data[i].val;
    return 0;
}

void stringintmap_put(StringIntMap *m, const char *key, int32_t val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    if (!m || !key) return;
    int32_t i = sim_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) sim_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(StringIntEntry));
    m->data[i].key = strdup(key);
    m->data[i].val = val;
    m->len++;
}

void stringintmap_remove(StringIntMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return;
    int32_t i = sim_lower_bound(m->data, m->len, key);
    if (i >= m->len || strcmp(m->data[i].key, key) != 0) return;
    free(m->data[i].key);
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(StringIntEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void stringintmap_print(const StringIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            const char *k = m->data[i].key ? m->data[i].key : "";
            printf("\"%s\": %d", k, (int)m->data[i].val);
        }
    }
    puts("}");
}

char *stringintmap_to_string(const StringIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringIntMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: `"` (1) + key + `": ` (3) + val (11) + closing nothing, plus ", " (2)
    size_t total = 2;  // "{}"
    for (int32_t i = 0; i < m->len; i++) {
        total += 1 + (m->data[i].key ? strlen(m->data[i].key) : 0) + 3 + 11;
        if (i > 0) total += 2;  // ", "
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        const char *k = m->data[i].key ? m->data[i].key : "";
        int written = snprintf(buf + pos, total - pos, "\"%s\": %d",
                               k, (int)m->data[i].val);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── StringStringMap ───────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from heap-owned char* keys to heap-owned char*
// values.
//
//   struct StringStringMap { uint8_t freed; StringStringEntry *data; int32_t len; int32_t cap; }
//
// Both keys and values are heap-owned: strdup on put, free on remove/free.
// Entries are kept in lexicographic key order (strcmp, binary search, O(log n)).

typedef struct { char *key; char *val; } StringStringEntry;
typedef struct StringStringMap { uint8_t freed; StringStringEntry *data; int32_t len, cap; } StringStringMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t ssm_lower_bound(const StringStringEntry *data, int32_t len, const char *key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (strcmp(data[mid].key, key) < 0) lo = mid + 1;
        else                                hi = mid;
    }
    return lo;
}

static void ssm_grow(StringStringMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (StringStringEntry *)realloc(m->data, (size_t)cap * sizeof(StringStringEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

StringStringMap *stringstringmap_new(void) {
    StringStringMap *m = (StringStringMap *)malloc(sizeof(StringStringMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void stringstringmap_free(StringStringMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: StringStringMap\n"); abort(); }
    m->freed = 1;
    for (int32_t i = 0; i < m->len; i++) {
        free(m->data[i].key);
        free(m->data[i].val);
    }
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t stringstringmap_size(const StringStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    return m ? m->len : 0;
}

int stringstringmap_contains(const StringStringMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return 0;
    int32_t i = ssm_lower_bound(m->data, m->len, key);
    return (i < m->len && strcmp(m->data[i].key, key) == 0) ? 1 : 0;
}

char *stringstringmap_get(const StringStringMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return 0;
    int32_t i = ssm_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) return m->data[i].val;
    return 0;
}

void stringstringmap_put(StringStringMap *m, const char *key, const char *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    if (!m || !key) return;
    int32_t i = ssm_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) {
        free(m->data[i].val);
        m->data[i].val = val ? strdup(val) : NULL;
        return;
    }
    if (m->len >= m->cap) ssm_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(StringStringEntry));
    m->data[i].key = strdup(key);
    m->data[i].val = val ? strdup(val) : NULL;
    m->len++;
}

void stringstringmap_remove(StringStringMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return;
    int32_t i = ssm_lower_bound(m->data, m->len, key);
    if (i >= m->len || strcmp(m->data[i].key, key) != 0) return;
    free(m->data[i].key);
    free(m->data[i].val);
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(StringStringEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void stringstringmap_print(const StringStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            const char *k = m->data[i].key ? m->data[i].key : "";
            const char *v = m->data[i].val ? m->data[i].val : "";
            printf("\"%s\": \"%s\"", k, v);
        }
    }
    puts("}");
}

char *stringstringmap_to_string(const StringStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringStringMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: `"` (1) + key + `": "` (4) + val + `"` (1), plus ", " (2)
    size_t total = 2;  // "{}"
    for (int32_t i = 0; i < m->len; i++) {
        total += 1 + (m->data[i].key ? strlen(m->data[i].key) : 0) + 4
               + (m->data[i].val ? strlen(m->data[i].val) : 0) + 1;
        if (i > 0) total += 2;  // ", "
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        const char *k = m->data[i].key ? m->data[i].key : "";
        const char *v = m->data[i].val ? m->data[i].val : "";
        int written = snprintf(buf + pos, total - pos, "\"%s\": \"%s\"", k, v);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── IntPtrMap ─────────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from int32_t keys to void* values.
//
//   struct IntPtrMap { uint8_t freed; IntPtrEntry *data; int32_t len; int32_t cap; }
//
// Values are NOT freed by the map — caller owns them.
// Entries are kept in ascending key order (binary search, O(log n)).
// get() returns NULL for absent keys.

typedef struct { int32_t key; void *val; } IntPtrEntry;
typedef struct IntPtrMap { uint8_t freed; IntPtrEntry *data; int32_t len, cap; } IntPtrMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t ipm_lower_bound(const IntPtrEntry *data, int32_t len, int32_t key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (data[mid].key < key) lo = mid + 1;
        else                     hi = mid;
    }
    return lo;
}

static void ipm_grow(IntPtrMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (IntPtrEntry *)realloc(m->data, (size_t)cap * sizeof(IntPtrEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

IntPtrMap *intptrmap_new(void) {
    IntPtrMap *m = (IntPtrMap *)malloc(sizeof(IntPtrMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void intptrmap_free(IntPtrMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: IntPtrMap\n"); abort(); }
    m->freed = 1;
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t intptrmap_size(const IntPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    return m ? m->len : 0;
}

int intptrmap_contains(const IntPtrMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = ipm_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

void *intptrmap_get(const IntPtrMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    if (!m || m->len == 0) return NULL;
    int32_t i = ipm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return NULL;
}

void intptrmap_put(IntPtrMap *m, int32_t key, void *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    if (!m) return;
    int32_t i = ipm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) ipm_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(IntPtrEntry));
    m->data[i].key = key;
    m->data[i].val = val;
    m->len++;
}

void intptrmap_remove(IntPtrMap *m, int32_t key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = ipm_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(IntPtrEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void intptrmap_print(const IntPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("%d: <ptr>", (int)m->data[i].key);
        }
    }
    puts("}");
}

char *intptrmap_to_string(const IntPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: IntPtrMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Each entry: up to 11 chars for key + ": <ptr>" (7), plus ", " (2)
    size_t buflen = 2 + (size_t)m->len * 20 + 1;
    char  *buf    = (char *)malloc(buflen);
    size_t pos    = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int written = snprintf(buf + pos, buflen - pos, "%d: <ptr>",
                               (int)m->data[i].key);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── StringPtrMap ──────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from heap-owned char* keys to void* values.
//
//   struct StringPtrMap { uint8_t freed; StringPtrEntry *data; int32_t len; int32_t cap; }
//
// Keys are heap-owned: strdup on put, free on remove/free.
// Values are NOT freed by the map — caller owns them.
// Entries are kept in lexicographic key order (strcmp, binary search, O(log n)).
// get() returns NULL for absent keys.

typedef struct { char *key; void *val; } StringPtrEntry;
typedef struct StringPtrMap { uint8_t freed; StringPtrEntry *data; int32_t len, cap; } StringPtrMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t sptrm_lower_bound(const StringPtrEntry *data, int32_t len, const char *key) {
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if (strcmp(data[mid].key, key) < 0) lo = mid + 1;
        else                                hi = mid;
    }
    return lo;
}

static void sptrm_grow(StringPtrMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (StringPtrEntry *)realloc(m->data, (size_t)cap * sizeof(StringPtrEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

StringPtrMap *stringptrmap_new(void) {
    StringPtrMap *m = (StringPtrMap *)malloc(sizeof(StringPtrMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void stringptrmap_free(StringPtrMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: StringPtrMap\n"); abort(); }
    m->freed = 1;
    for (int32_t i = 0; i < m->len; i++) free(m->data[i].key);
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t stringptrmap_size(const StringPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    return m ? m->len : 0;
}

int stringptrmap_contains(const StringPtrMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return 0;
    int32_t i = sptrm_lower_bound(m->data, m->len, key);
    return (i < m->len && strcmp(m->data[i].key, key) == 0) ? 1 : 0;
}

void *stringptrmap_get(const StringPtrMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return NULL;
    int32_t i = sptrm_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) return m->data[i].val;
    return NULL;
}

void stringptrmap_put(StringPtrMap *m, const char *key, void *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    if (!m || !key) return;
    int32_t i = sptrm_lower_bound(m->data, m->len, key);
    if (i < m->len && strcmp(m->data[i].key, key) == 0) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) sptrm_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(StringPtrEntry));
    m->data[i].key = strdup(key);
    m->data[i].val = val;
    m->len++;
}

void stringptrmap_remove(StringPtrMap *m, const char *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    if (!m || m->len == 0 || !key) return;
    int32_t i = sptrm_lower_bound(m->data, m->len, key);
    if (i >= m->len || strcmp(m->data[i].key, key) != 0) return;
    free(m->data[i].key);
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(StringPtrEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void stringptrmap_print(const StringPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            const char *k = m->data[i].key ? m->data[i].key : "";
            printf("\"%s\": <ptr>", k);
        }
    }
    puts("}");
}

char *stringptrmap_to_string(const StringPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: StringPtrMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: `"` (1) + key + `": <ptr>` (8), plus ", " (2)
    size_t total = 2;
    for (int32_t i = 0; i < m->len; i++) {
        total += 1 + (m->data[i].key ? strlen(m->data[i].key) : 0) + 8;
        if (i > 0) total += 2;
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        const char *k = m->data[i].key ? m->data[i].key : "";
        int written = snprintf(buf + pos, total - pos, "\"%s\": <ptr>", k);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── PtrIntMap ─────────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from void* keys (by pointer identity) to
// int32_t values.
//
//   struct PtrIntMap { uint8_t freed; PtrIntEntry *data; int32_t len; int32_t cap; }
//
// Keys are compared by pointer address (cast to uintptr_t).
// Keys are NOT freed (raw pointers, caller owns).
// Entries are kept in ascending address order (binary search, O(log n)).
// get() returns 0 for absent keys.

typedef struct { void *key; int32_t val; } PtrIntEntry;
typedef struct PtrIntMap { uint8_t freed; PtrIntEntry *data; int32_t len, cap; } PtrIntMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t pim_lower_bound(const PtrIntEntry *data, int32_t len, void *key) {
    uintptr_t k = (uintptr_t)key;
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if ((uintptr_t)data[mid].key < k) lo = mid + 1;
        else                              hi = mid;
    }
    return lo;
}

static void pim_grow(PtrIntMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (PtrIntEntry *)realloc(m->data, (size_t)cap * sizeof(PtrIntEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

PtrIntMap *ptrintmap_new(void) {
    PtrIntMap *m = (PtrIntMap *)malloc(sizeof(PtrIntMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void ptrintmap_free(PtrIntMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: PtrIntMap\n"); abort(); }
    m->freed = 1;
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t ptrintmap_size(const PtrIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    return m ? m->len : 0;
}

int ptrintmap_contains(const PtrIntMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = pim_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

int32_t ptrintmap_get(const PtrIntMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = pim_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return 0;
}

void ptrintmap_put(PtrIntMap *m, void *key, int32_t val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    if (!m) return;
    int32_t i = pim_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) pim_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(PtrIntEntry));
    m->data[i].key = key;
    m->data[i].val = val;
    m->len++;
}

void ptrintmap_remove(PtrIntMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = pim_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(PtrIntEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void ptrintmap_print(const PtrIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("<ptr>: %d", (int)m->data[i].val);
        }
    }
    puts("}");
}

char *ptrintmap_to_string(const PtrIntMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrIntMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Each entry: "<ptr>: " (7) + up to 11 chars for val, plus ", " (2)
    size_t buflen = 2 + (size_t)m->len * 20 + 1;
    char  *buf    = (char *)malloc(buflen);
    size_t pos    = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int written = snprintf(buf + pos, buflen - pos, "<ptr>: %d",
                               (int)m->data[i].val);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── PtrStringMap ──────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from void* keys (by pointer identity) to
// heap-owned char* values.
//
//   struct PtrStringMap { uint8_t freed; PtrStringEntry *data; int32_t len; int32_t cap; }
//
// Keys are compared by pointer address (uintptr_t). Keys are NOT freed.
// Values are heap-owned: strdup on put, free on remove/free.
// Entries are kept in ascending address order (binary search, O(log n)).
// get() returns "" (static empty string) for absent keys.

typedef struct { void *key; char *val; } PtrStringEntry;
typedef struct PtrStringMap { uint8_t freed; PtrStringEntry *data; int32_t len, cap; } PtrStringMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t psm_lower_bound(const PtrStringEntry *data, int32_t len, void *key) {
    uintptr_t k = (uintptr_t)key;
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if ((uintptr_t)data[mid].key < k) lo = mid + 1;
        else                              hi = mid;
    }
    return lo;
}

static void psm_grow(PtrStringMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (PtrStringEntry *)realloc(m->data, (size_t)cap * sizeof(PtrStringEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

PtrStringMap *ptrstrmap_new(void) {
    PtrStringMap *m = (PtrStringMap *)malloc(sizeof(PtrStringMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void ptrstrmap_free(PtrStringMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: PtrStringMap\n"); abort(); }
    m->freed = 1;
    for (int32_t i = 0; i < m->len; i++) free(m->data[i].val);
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t ptrstrmap_size(const PtrStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    return m ? m->len : 0;
}

int ptrstrmap_contains(const PtrStringMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = psm_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

char *ptrstrmap_get(const PtrStringMap *m, void *key) {
    static const char empty[] = "";
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    if (!m || m->len == 0) return (char *)empty;
    int32_t i = psm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return (char *)empty;
}

void ptrstrmap_put(PtrStringMap *m, void *key, const char *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    if (!m) return;
    int32_t i = psm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        free(m->data[i].val);
        m->data[i].val = val ? strdup(val) : NULL;
        return;
    }
    if (m->len >= m->cap) psm_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(PtrStringEntry));
    m->data[i].key = key;
    m->data[i].val = val ? strdup(val) : NULL;
    m->len++;
}

void ptrstrmap_remove(PtrStringMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = psm_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    free(m->data[i].val);
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(PtrStringEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void ptrstrmap_print(const PtrStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            const char *v = m->data[i].val ? m->data[i].val : "";
            printf("<ptr>: \"%s\"", v);
        }
    }
    puts("}");
}

char *ptrstrmap_to_string(const PtrStringMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrStringMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Estimate: "<ptr>: \"" (8) + val + "\"" (1), plus ", " (2)
    size_t total = 2;
    for (int32_t i = 0; i < m->len; i++) {
        total += 8 + (m->data[i].val ? strlen(m->data[i].val) : 0) + 1;
        if (i > 0) total += 2;
    }
    total++;  // NUL
    char  *buf = (char *)malloc(total);
    size_t pos = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        const char *v = m->data[i].val ? m->data[i].val : "";
        int written = snprintf(buf + pos, total - pos, "<ptr>: \"%s\"", v);
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}

// ── PtrPtrMap ─────────────────────────────────────────────────────────────────
//
// A heap-allocated, sorted map from void* keys (by pointer identity) to
// void* values.
//
//   struct PtrPtrMap { uint8_t freed; PtrPtrEntry *data; int32_t len; int32_t cap; }
//
// Keys are compared by pointer address (uintptr_t).
// Neither keys nor values are freed by the map — caller owns both.
// Entries are kept in ascending address order (binary search, O(log n)).
// get() returns NULL for absent keys.

typedef struct { void *key; void *val; } PtrPtrEntry;
typedef struct PtrPtrMap { uint8_t freed; PtrPtrEntry *data; int32_t len, cap; } PtrPtrMap;

// ── Internal helpers ──────────────────────────────────────────────────────────

static int32_t ppm_lower_bound(const PtrPtrEntry *data, int32_t len, void *key) {
    uintptr_t k = (uintptr_t)key;
    int32_t lo = 0, hi = len;
    while (lo < hi) {
        int32_t mid = lo + (hi - lo) / 2;
        if ((uintptr_t)data[mid].key < k) lo = mid + 1;
        else                              hi = mid;
    }
    return lo;
}

static void ppm_grow(PtrPtrMap *m, int32_t min_cap) {
    int32_t cap = m->cap < 4 ? 4 : m->cap;
    while (cap < min_cap) cap *= 2;
    m->data = (PtrPtrEntry *)realloc(m->data, (size_t)cap * sizeof(PtrPtrEntry));
    m->cap  = cap;
}

// ── Construction / destruction ────────────────────────────────────────────────

PtrPtrMap *ptrptrmap_new(void) {
    PtrPtrMap *m = (PtrPtrMap *)malloc(sizeof(PtrPtrMap));
    m->freed = 0;
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    return m;
}

void ptrptrmap_free(PtrPtrMap *m) {
    if (!m) return;
    if (m->freed) { fprintf(stderr, "double-free: PtrPtrMap\n"); abort(); }
    m->freed = 1;
    free(m->data);
    m->data = NULL;
    m->len  = 0;
    m->cap  = 0;
    // DO NOT free(m) — keep as tombstone
}

// ── Core operations ───────────────────────────────────────────────────────────

int32_t ptrptrmap_size(const PtrPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    return m ? m->len : 0;
}

int ptrptrmap_contains(const PtrPtrMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    if (!m || m->len == 0) return 0;
    int32_t i = ppm_lower_bound(m->data, m->len, key);
    return (i < m->len && m->data[i].key == key) ? 1 : 0;
}

void *ptrptrmap_get(const PtrPtrMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    if (!m || m->len == 0) return NULL;
    int32_t i = ppm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) return m->data[i].val;
    return NULL;
}

void ptrptrmap_put(PtrPtrMap *m, void *key, void *val) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    if (!m) return;
    int32_t i = ppm_lower_bound(m->data, m->len, key);
    if (i < m->len && m->data[i].key == key) {
        m->data[i].val = val;
        return;
    }
    if (m->len >= m->cap) ppm_grow(m, m->len + 1);
    memmove(m->data + i + 1, m->data + i, (size_t)(m->len - i) * sizeof(PtrPtrEntry));
    m->data[i].key = key;
    m->data[i].val = val;
    m->len++;
}

void ptrptrmap_remove(PtrPtrMap *m, void *key) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    if (!m || m->len == 0) return;
    int32_t i = ppm_lower_bound(m->data, m->len, key);
    if (i >= m->len || m->data[i].key != key) return;
    memmove(m->data + i, m->data + i + 1, (size_t)(m->len - i - 1) * sizeof(PtrPtrEntry));
    m->len--;
}

// ── Output ────────────────────────────────────────────────────────────────────

void ptrptrmap_print(const PtrPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    putchar('{');
    if (m) {
        for (int32_t i = 0; i < m->len; i++) {
            if (i > 0) { putchar(','); putchar(' '); }
            printf("<ptr>: <ptr>");
        }
    }
    puts("}");
}

char *ptrptrmap_to_string(const PtrPtrMap *m) {
    if (m && m->freed) { fprintf(stderr, "use-after-free: PtrPtrMap\n"); abort(); }
    if (!m || m->len == 0) {
        char *out = (char *)malloc(3);
        out[0] = '{'; out[1] = '}'; out[2] = '\0';
        return out;
    }
    // Each entry: "<ptr>: <ptr>" (12), plus ", " (2)
    size_t buflen = 2 + (size_t)m->len * 14 + 1;
    char  *buf    = (char *)malloc(buflen);
    size_t pos    = 0;
    buf[pos++] = '{';
    for (int32_t i = 0; i < m->len; i++) {
        if (i > 0) { buf[pos++] = ','; buf[pos++] = ' '; }
        int written = snprintf(buf + pos, buflen - pos, "<ptr>: <ptr>");
        if (written > 0) pos += (size_t)written;
    }
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return buf;
}
