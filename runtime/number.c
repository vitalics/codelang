/**
 * CodeLang Number runtime — dynamic numeric type
 *
 * Number stores one of three representations, promoted automatically:
 *
 *   NUM_INT    — int64_t fast path (all integers that fit in 64 bits)
 *   NUM_BIGINT — arbitrary-precision integer (base-10^9 digit array)
 *   NUM_FLOAT  — double (when a non-integer value is stored)
 *
 * Overflow in NUM_INT arithmetic automatically promotes to NUM_BIGINT.
 * Float arithmetic always yields NUM_FLOAT.
 *
 * Memory: every Number* is heap-allocated via malloc/calloc.
 *         No GC — for long-running programs a proper allocator would be needed.
 */

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <math.h>

// ── Kind tags ─────────────────────────────────────────────────────────────────

#define NUM_INT    0
#define NUM_BIGINT 1
#define NUM_FLOAT  2

// ── BigInt representation ─────────────────────────────────────────────────────
//
// Digits are stored little-endian (index 0 = least-significant) in base 10^9.
// Each digit[i] is in [0, 10^9).  Negative numbers set `negative = 1`.

#define BIGINT_BASE 1000000000ULL

typedef struct {
    uint32_t *digits;
    uint32_t  len;      /* number of digits actually used */
    uint32_t  cap;      /* allocated capacity             */
    int       negative; /* 1 = negative, 0 = non-negative */
} BigInt;

// ── Number struct ─────────────────────────────────────────────────────────────

typedef struct Number {
    int kind;
    union {
        int64_t ival;
        BigInt  bigint;
        double  dval;
    };
} Number;

// ── Internal helpers ──────────────────────────────────────────────────────────

static Number *num_alloc(void) {
    return (Number *)calloc(1, sizeof(Number));
}

static void bigint_init(BigInt *b, uint32_t cap) {
    b->digits   = (uint32_t *)calloc(cap, sizeof(uint32_t));
    b->len      = 0;
    b->cap      = cap;
    b->negative = 0;
}

static void bigint_grow(BigInt *b, uint32_t need) {
    if (need <= b->cap) return;
    uint32_t newcap = need + 4;
    b->digits = (uint32_t *)realloc(b->digits, newcap * sizeof(uint32_t));
    /* zero the new slots */
    memset(b->digits + b->cap, 0, (newcap - b->cap) * sizeof(uint32_t));
    b->cap = newcap;
}

static void bigint_trim(BigInt *b) {
    while (b->len > 1 && b->digits[b->len - 1] == 0)
        b->len--;
}

static int bigint_is_zero(const BigInt *b) {
    return b->len == 1 && b->digits[0] == 0;
}

/* Returns -1, 0, +1 for |a| vs |b| */
static int bigint_cmp_mag(const BigInt *a, const BigInt *b) {
    if (a->len != b->len)
        return (a->len > b->len) ? 1 : -1;
    for (int i = (int)a->len - 1; i >= 0; i--) {
        if (a->digits[i] != b->digits[i])
            return (a->digits[i] > b->digits[i]) ? 1 : -1;
    }
    return 0;
}

/* Fill a BigInt from an unsigned 64-bit value */
static void bigint_from_u64(BigInt *b, uint64_t v) {
    bigint_init(b, 4);
    if (v == 0) { b->digits[0] = 0; b->len = 1; return; }
    while (v > 0) {
        bigint_grow(b, b->len + 1);
        b->digits[b->len++] = (uint32_t)(v % BIGINT_BASE);
        v /= BIGINT_BASE;
    }
}

/* Fill a BigInt from a signed 64-bit integer */
static void bigint_from_i64(BigInt *b, int64_t v) {
    b->negative = (v < 0) ? 1 : 0;
    /* Handle INT64_MIN: -(INT64_MIN) overflows, so treat specially */
    uint64_t uv;
    if (v == INT64_MIN) {
        uv = (uint64_t)INT64_MAX + 1ULL;
    } else {
        uv = (uint64_t)(b->negative ? -v : v);
    }
    bigint_from_u64(b, uv);
    /* bigint_from_u64 sets negative=0, so restore */
    b->negative = (v < 0) ? 1 : 0;
}

/* Deep-copy src into dst (dst must be uninitialised or freshly cleared) */
static void bigint_copy(BigInt *dst, const BigInt *src) {
    dst->len      = src->len;
    dst->cap      = src->cap;
    dst->negative = src->negative;
    dst->digits   = (uint32_t *)malloc(src->cap * sizeof(uint32_t));
    memcpy(dst->digits, src->digits, src->len * sizeof(uint32_t));
}

static void bigint_free(BigInt *b) {
    free(b->digits);
    b->digits = NULL;
    b->len = b->cap = 0;
}

// ── Public constructors ───────────────────────────────────────────────────────

Number *number_from_int64(int64_t v) {
    Number *n  = num_alloc();
    n->kind    = NUM_INT;
    n->ival    = v;
    return n;
}

Number *number_from_double(double v) {
    Number *n  = num_alloc();
    int64_t iv = (int64_t)v;
    if ((double)iv == v) {
        n->kind = NUM_INT;
        n->ival = iv;
    } else {
        n->kind = NUM_FLOAT;
        n->dval = v;
    }
    return n;
}

// ── Helpers: ensure Number is usable as BigInt ────────────────────────────────

/*
 * Return a pointer to the BigInt inside n (or a temporary).
 * If n is NUM_INT, fill *tmp and return tmp.
 * Caller must call bigint_free(tmp) iff the returned pointer == tmp.
 */
static const BigInt *as_bigint_tmp(const Number *n, BigInt *tmp) {
    if (n->kind == NUM_BIGINT) return &n->bigint;
    bigint_from_i64(tmp, n->ival);
    return tmp;
}

// ── BigInt arithmetic (pure, returning new Number*) ──────────────────────────

/* Add |a| + |b| magnitudes; caller sets sign */
static BigInt bigint_add_mag(const BigInt *a, const BigInt *b) {
    uint32_t maxLen = (a->len > b->len ? a->len : b->len) + 1;
    BigInt r;
    bigint_init(&r, maxLen);
    r.len = maxLen;
    uint64_t carry = 0;
    for (uint32_t i = 0; i < maxLen; i++) {
        uint64_t ad = (i < a->len) ? a->digits[i] : 0;
        uint64_t bd = (i < b->len) ? b->digits[i] : 0;
        uint64_t s  = ad + bd + carry;
        r.digits[i] = (uint32_t)(s % BIGINT_BASE);
        carry       = s / BIGINT_BASE;
    }
    bigint_trim(&r);
    return r;
}

/* Subtract |a| - |b| where |a| >= |b|; caller sets sign */
static BigInt bigint_sub_mag(const BigInt *a, const BigInt *b) {
    BigInt r;
    bigint_init(&r, a->len);
    r.len = a->len;
    int64_t borrow = 0;
    for (uint32_t i = 0; i < a->len; i++) {
        int64_t ad   = (int64_t)a->digits[i];
        int64_t bd   = (i < b->len) ? (int64_t)b->digits[i] : 0;
        int64_t diff = ad - bd - borrow;
        if (diff < 0) { diff += (int64_t)BIGINT_BASE; borrow = 1; }
        else           borrow = 0;
        r.digits[i] = (uint32_t)diff;
    }
    bigint_trim(&r);
    return r;
}

static Number *bigint_add_signed(const BigInt *a, const BigInt *b) {
    Number *r = num_alloc();
    r->kind   = NUM_BIGINT;
    if (a->negative == b->negative) {
        r->bigint          = bigint_add_mag(a, b);
        r->bigint.negative = a->negative;
    } else {
        int cmp = bigint_cmp_mag(a, b);
        if (cmp == 0) {
            bigint_init(&r->bigint, 1);
            r->bigint.len       = 1;
            r->bigint.digits[0] = 0;
            r->bigint.negative  = 0;
        } else if (cmp > 0) {
            r->bigint          = bigint_sub_mag(a, b);
            r->bigint.negative = a->negative;
        } else {
            r->bigint          = bigint_sub_mag(b, a);
            r->bigint.negative = b->negative;
        }
    }
    return r;
}

static Number *bigint_sub_signed(const BigInt *a, const BigInt *b) {
    BigInt neg = *b;
    neg.negative = !b->negative;
    return bigint_add_signed(a, &neg);
}

static Number *bigint_mul_nn(const BigInt *a, const BigInt *b) {
    uint32_t rlen = a->len + b->len;
    Number *r = num_alloc();
    r->kind   = NUM_BIGINT;
    bigint_init(&r->bigint, rlen);
    r->bigint.len      = rlen;
    r->bigint.negative = (a->negative != b->negative) ? 1 : 0;
    memset(r->bigint.digits, 0, rlen * sizeof(uint32_t));
    for (uint32_t i = 0; i < a->len; i++) {
        uint64_t carry = 0;
        for (uint32_t j = 0; j < b->len; j++) {
            uint64_t cur = (uint64_t)r->bigint.digits[i + j]
                         + (uint64_t)a->digits[i] * (uint64_t)b->digits[j]
                         + carry;
            r->bigint.digits[i + j] = (uint32_t)(cur % BIGINT_BASE);
            carry                   = cur / BIGINT_BASE;
        }
        r->bigint.digits[i + b->len] += (uint32_t)carry;
    }
    bigint_trim(&r->bigint);
    return r;
}

// ── Arithmetic public API ─────────────────────────────────────────────────────

Number *number_add(Number *a, Number *b) {
    /* Float dominates */
    if (a->kind == NUM_FLOAT || b->kind == NUM_FLOAT) {
        double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
        double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
        Number *r = num_alloc(); r->kind = NUM_FLOAT; r->dval = av + bv;
        return r;
    }
    /* Fast path: both i64 without overflow */
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        int64_t res;
        if (!__builtin_add_overflow(a->ival, b->ival, &res))
            return number_from_int64(res);
    }
    /* Fall back to BigInt */
    BigInt ta, tb;
    const BigInt *ba = as_bigint_tmp(a, &ta);
    const BigInt *bb = as_bigint_tmp(b, &tb);
    Number *r = bigint_add_signed(ba, bb);
    if (ba == &ta) bigint_free(&ta);
    if (bb == &tb) bigint_free(&tb);
    return r;
}

Number *number_sub(Number *a, Number *b) {
    if (a->kind == NUM_FLOAT || b->kind == NUM_FLOAT) {
        double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
        double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
        Number *r = num_alloc(); r->kind = NUM_FLOAT; r->dval = av - bv;
        return r;
    }
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        int64_t res;
        if (!__builtin_sub_overflow(a->ival, b->ival, &res))
            return number_from_int64(res);
    }
    BigInt ta, tb;
    const BigInt *ba = as_bigint_tmp(a, &ta);
    const BigInt *bb = as_bigint_tmp(b, &tb);
    Number *r = bigint_sub_signed(ba, bb);
    if (ba == &ta) bigint_free(&ta);
    if (bb == &tb) bigint_free(&tb);
    return r;
}

Number *number_mul(Number *a, Number *b) {
    if (a->kind == NUM_FLOAT || b->kind == NUM_FLOAT) {
        double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
        double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
        Number *r = num_alloc(); r->kind = NUM_FLOAT; r->dval = av * bv;
        return r;
    }
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        int64_t res;
        if (!__builtin_mul_overflow(a->ival, b->ival, &res))
            return number_from_int64(res);
    }
    BigInt ta, tb;
    const BigInt *ba = as_bigint_tmp(a, &ta);
    const BigInt *bb = as_bigint_tmp(b, &tb);
    Number *r = bigint_mul_nn(ba, bb);
    if (ba == &ta) bigint_free(&ta);
    if (bb == &tb) bigint_free(&tb);
    return r;
}

/*
 * Integer division (truncated toward zero).
 * If either operand is float, returns float.
 * BigInt division falls back to double for simplicity.
 */
Number *number_div(Number *a, Number *b) {
    if (a->kind == NUM_FLOAT || b->kind == NUM_FLOAT) {
        double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
        double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
        Number *r = num_alloc(); r->kind = NUM_FLOAT; r->dval = av / bv;
        return r;
    }
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        if (b->ival == 0) { Number *r = num_alloc(); r->kind = NUM_INT; r->ival = 0; return r; }
        return number_from_int64(a->ival / b->ival);
    }
    /* BigInt / BigInt: convert to double (good enough for most uses) */
    double av = (a->kind == NUM_INT) ? (double)a->ival : /* bigint→double: best effort */
        (a->bigint.negative ? -1.0 : 1.0) * (double)a->bigint.digits[a->bigint.len - 1];
    double bv = (b->kind == NUM_INT) ? (double)b->ival :
        (b->bigint.negative ? -1.0 : 1.0) * (double)b->bigint.digits[b->bigint.len - 1];
    Number *r = num_alloc();
    r->kind = NUM_FLOAT;
    r->dval = av / bv;
    return r;
}

Number *number_mod(Number *a, Number *b) {
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        if (b->ival == 0) return number_from_int64(0);
        return number_from_int64(a->ival % b->ival);
    }
    /* Float/BigInt modulo */
    double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
    double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
    Number *r = num_alloc();
    r->kind   = NUM_FLOAT;
    r->dval   = av - (int64_t)(av / bv) * bv;
    return r;
}

// ── Comparison ────────────────────────────────────────────────────────────────

static int number_cmp_internal(Number *a, Number *b) {
    if (a->kind == NUM_FLOAT || b->kind == NUM_FLOAT) {
        double av = (a->kind == NUM_FLOAT) ? a->dval : (double)a->ival;
        double bv = (b->kind == NUM_FLOAT) ? b->dval : (double)b->ival;
        return (av < bv) ? -1 : (av > bv) ? 1 : 0;
    }
    if (a->kind == NUM_INT && b->kind == NUM_INT) {
        return (a->ival < b->ival) ? -1 : (a->ival > b->ival) ? 1 : 0;
    }
    BigInt ta, tb;
    const BigInt *ba = as_bigint_tmp(a, &ta);
    const BigInt *bb = as_bigint_tmp(b, &tb);
    int result;
    if (ba->negative != bb->negative) {
        result = ba->negative ? -1 : 1;
    } else {
        result = bigint_cmp_mag(ba, bb);
        if (ba->negative) result = -result;
    }
    if (ba == &ta) bigint_free(&ta);
    if (bb == &tb) bigint_free(&tb);
    return result;
}

int number_eq(Number *a, Number *b) { return number_cmp_internal(a, b) == 0 ? 1 : 0; }
int number_ne(Number *a, Number *b) { return number_cmp_internal(a, b) != 0 ? 1 : 0; }
int number_lt(Number *a, Number *b) { return number_cmp_internal(a, b) <  0 ? 1 : 0; }
int number_le(Number *a, Number *b) { return number_cmp_internal(a, b) <= 0 ? 1 : 0; }
int number_gt(Number *a, Number *b) { return number_cmp_internal(a, b) >  0 ? 1 : 0; }
int number_ge(Number *a, Number *b) { return number_cmp_internal(a, b) >= 0 ? 1 : 0; }

/* Three-way comparison: returns -1, 0, or +1 (suitable for Cmp protocol). */
int32_t number_cmp(Number *a, Number *b) { return (int32_t)number_cmp_internal(a, b); }

/* Type-limit sentinels: -Infinity and +Infinity as Number* values. */
Number *number_min_value(void) {
    Number *n = (Number *)calloc(1, sizeof(Number));
    n->kind = NUM_FLOAT;
    n->dval = -INFINITY;
    return n;
}

Number *number_max_value(void) {
    Number *n = (Number *)calloc(1, sizeof(Number));
    n->kind = NUM_FLOAT;
    n->dval = INFINITY;
    return n;
}

/* Raw double IEEE 754 infinity values — used by the inf / negInf types. */
double f64_positive_infinity(void) { return  INFINITY; }
double f64_negative_infinity(void) { return -INFINITY; }

/* Named IEEE 754 special values accessible from CodeLang. */
Number *number_infinity(void) {
    Number *n = (Number *)calloc(1, sizeof(Number));
    n->kind = NUM_FLOAT;
    n->dval = INFINITY;
    return n;
}

Number *number_negative_infinity(void) {
    Number *n = (Number *)calloc(1, sizeof(Number));
    n->kind = NUM_FLOAT;
    n->dval = -INFINITY;
    return n;
}

Number *number_nan(void) {
    Number *n = (Number *)calloc(1, sizeof(Number));
    n->kind = NUM_FLOAT;
    n->dval = NAN;
    return n;
}

/* Predicate helpers — return 1 (true) or 0 (false). */
int32_t number_is_nan(Number *n) {
    return (n->kind == NUM_FLOAT && isnan(n->dval)) ? 1 : 0;
}

int32_t number_is_infinite(Number *n) {
    return (n->kind == NUM_FLOAT && isinf(n->dval)) ? 1 : 0;
}

int32_t number_is_finite(Number *n) {
    if (n->kind == NUM_INT)    return 1;
    if (n->kind == NUM_BIGINT) return 1;
    return isfinite(n->dval) ? 1 : 0;
}

// ── Print ─────────────────────────────────────────────────────────────────────

static void bigint_print(const BigInt *b) {
    if (b->negative && !bigint_is_zero(b))
        putchar('-');
    /* Most-significant chunk: no leading zeros */
    printf("%" PRIu32, b->digits[b->len - 1]);
    /* Remaining chunks: exactly 9 digits each */
    for (int i = (int)b->len - 2; i >= 0; i--)
        printf("%09" PRIu32, b->digits[i]);
}

// ── Memoization ───────────────────────────────────────────────────────────────
//
// Auto-memo for pure functions: functions whose Number params are all `const`
// (immutable) may be safely memoized by the compiler.  The global `i8*` slot
// per function is lazily initialised to a MemoTable on first call.

#define MEMO_BUCKETS 8192

typedef struct MemoEntry {
    Number          *key;
    Number          *value;
    struct MemoEntry *next;
} MemoEntry;

typedef struct MemoTable {
    MemoEntry *buckets[MEMO_BUCKETS];
} MemoTable;

static uint32_t number_hash(const Number *n) {
    if (n->kind == NUM_INT) {
        uint64_t v = (uint64_t)n->ival;
        return (uint32_t)(v ^ (v >> 32));
    }
    if (n->kind == NUM_FLOAT) {
        uint64_t v;
        memcpy(&v, &n->dval, 8);
        return (uint32_t)(v ^ (v >> 32));
    }
    /* BigInt: fold digits */
    uint32_t h = n->bigint.negative ? 0x80000000u : 0u;
    for (uint32_t i = 0; i < n->bigint.len; i++)
        h = h * 31u + n->bigint.digits[i];
    return h;
}

/*
 * number_memo_get1 / number_memo_set1
 *
 * `slot` points to the per-function global i8* variable (initially null).
 * Both functions are thread-unsafe (single-threaded assumption).
 */
Number *number_memo_get1(void **slot, Number *key) {
    if (!*slot) return NULL;
    MemoTable *t = (MemoTable *)*slot;
    uint32_t h = number_hash(key) % MEMO_BUCKETS;
    for (MemoEntry *e = t->buckets[h]; e; e = e->next) {
        if (number_cmp_internal(e->key, key) == 0) return e->value;
    }
    return NULL;
}

void number_memo_set1(void **slot, Number *key, Number *val) {
    if (!*slot) *slot = calloc(1, sizeof(MemoTable));
    MemoTable *t = (MemoTable *)*slot;
    uint32_t h = number_hash(key) % MEMO_BUCKETS;
    MemoEntry *e = (MemoEntry *)malloc(sizeof(MemoEntry));
    e->key   = key;
    e->value = val;
    e->next  = t->buckets[h];
    t->buckets[h] = e;
}

// ── Print ─────────────────────────────────────────────────────────────────────

void number_print(Number *n) {
    switch (n->kind) {
        case NUM_INT:
            printf("%" PRId64 "\n", n->ival);
            break;
        case NUM_BIGINT:
            bigint_print(&n->bigint);
            putchar('\n');
            break;
        case NUM_FLOAT:
            printf("%.15g\n", n->dval);
            break;
    }
}

// ── String conversion ─────────────────────────────────────────────────────────
//
// Returns 1 (true) when `n` is a non-zero, non-NaN value; 0 (false) otherwise.
// Semantics match the JS / Python "truthy number" rule:
//   0, -0, NaN  → false
//   everything else → true
int32_t number_to_bool(Number *n) {
    switch (n->kind) {
        case NUM_INT:    return n->ival != 0 ? 1 : 0;
        case NUM_FLOAT:  return (!isnan(n->dval) && n->dval != 0.0) ? 1 : 0;
        case NUM_BIGINT: return !bigint_is_zero(&n->bigint) ? 1 : 0;
        default:         return 0;
    }
}

// Returns a heap-allocated, NUL-terminated string representation of `n`.
// The caller owns the result and must free() it when done.

char *number_to_string(Number *n) {
    char buf[64];
    switch (n->kind) {
        case NUM_INT:
            snprintf(buf, sizeof(buf), "%" PRId64, n->ival);
            return strdup(buf);
        case NUM_FLOAT:
            snprintf(buf, sizeof(buf), "%.15g", n->dval);
            return strdup(buf);
        case NUM_BIGINT: {
            const BigInt *b = &n->bigint;
            /* worst-case length: sign + len*9 digits + NUL */
            size_t cap = (size_t)b->len * 9 + 3;
            char *s = (char *)malloc(cap);
            if (!s) return strdup("0");
            int pos = 0;
            if (b->negative && !bigint_is_zero(b))
                s[pos++] = '-';
            /* most-significant chunk — no leading zeros */
            pos += snprintf(s + pos, cap - (size_t)pos, "%" PRIu32,
                            b->digits[b->len - 1]);
            /* remaining chunks — exactly 9 decimal digits each */
            for (int i = (int)b->len - 2; i >= 0; i--)
                pos += snprintf(s + pos, cap - (size_t)pos, "%09" PRIu32,
                                b->digits[i]);
            return s;
        }
        default:
            return strdup("0");
    }
}
