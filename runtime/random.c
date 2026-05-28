/**
 * CodeLang Random runtime — high-quality seedable PRNG + distributions.
 *
 * PRNG: xorshift64* (Vigna 2014) — 64-bit state, period 2^64-1.
 *   Fast, passes BigCrush, easy to seed, no external dependencies.
 *
 * Thread safety: NOT thread-safe.  Use one RNG state per thread if needed.
 *
 * Exposed to CodeLang via stdlib/random.code through `extern fn` bindings.
 * All floats are C `double` (CodeLang `float` = Float64 = LLVM `double`).
 */

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// ── xorshift64* state ─────────────────────────────────────────────────────────

static uint64_t rng_state = 88172645463325252ULL;  // nonzero default

static inline uint64_t xrng_next(void) {
    uint64_t x = rng_state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    rng_state = x;
    return x * 2685821657736338717ULL;
}

// ── Seed ──────────────────────────────────────────────────────────────────────

void random_seed(int32_t seed) {
    // Spread the 32-bit seed into a 64-bit state, ensuring non-zero.
    uint64_t s = (uint64_t)(int64_t)seed;
    // Wang hash to mix bits
    s = (~s) + (s << 21);
    s =   s  ^ (s >> 24);
    s = ( s  + (s <<  3)) + (s << 8);
    s =   s  ^ (s >> 14);
    s = ( s  + (s <<  2)) + (s << 4);
    s =   s  ^ (s >> 28);
    s =   s  + (s << 31);
    rng_state = s | 1ULL;  // guarantee nonzero
}

// random_time_seed() — seed from wall-clock time
void random_time_seed(void) {
    random_seed((int32_t)time(NULL));
}

// ── Core generators ───────────────────────────────────────────────────────────

// float() — uniform double in [0.0, 1.0)
double random_float(void) {
    // Use upper 53 bits (mantissa width of double)
    return (double)(xrng_next() >> 11) * (1.0 / (double)(1ULL << 53));
}

// uniform(lo, hi) — uniform double in [lo, hi)
double random_uniform(double lo, double hi) {
    return lo + random_float() * (hi - lo);
}

// randInt(lo, hi) — uniform int in [lo, hi] (both inclusive)
int32_t random_int(int32_t lo, int32_t hi) {
    if (lo == hi) return lo;
    uint32_t range = (uint32_t)(hi - lo) + 1u;
    // Rejection sampling to eliminate modulo bias
    uint32_t threshold = (uint32_t)(-(int32_t)range) % range;
    for (;;) {
        uint32_t r = (uint32_t)xrng_next();
        if (r >= threshold)
            return lo + (int32_t)(r % range);
    }
}

// bool() — uniform random boolean (50/50)
int32_t random_bool(void) {
    return (int32_t)((xrng_next() >> 63) & 1u);
}

// coin(p) — Bernoulli trial: 1 with probability p, 0 otherwise
int32_t random_coin(double p) {
    return random_float() < p ? 1 : 0;
}

// ── Distributions ─────────────────────────────────────────────────────────────

// gauss(mu, sigma) — Normal distribution via Box-Muller transform.
// Generates two values per call; stores spare for next call (fast).
static int32_t _gauss_spare_valid = 0;
static double  _gauss_spare       = 0.0;

double random_gauss(double mu, double sigma) {
    if (_gauss_spare_valid) {
        _gauss_spare_valid = 0;
        return mu + sigma * _gauss_spare;
    }
    double u, v, s;
    do {
        u = random_float() * 2.0 - 1.0;
        v = random_float() * 2.0 - 1.0;
        s = u * u + v * v;
    } while (s >= 1.0 || s == 0.0);
    double factor = sqrt(-2.0 * log(s) / s);
    _gauss_spare       = v * factor;
    _gauss_spare_valid = 1;
    return mu + sigma * (u * factor);
}

// exponential(lambda) — Exponential distribution with rate lambda.
// Mean = 1/lambda.  Uses inverse CDF: -ln(U)/lambda.
double random_exponential(double lambda) {
    double u;
    do { u = random_float(); } while (u == 0.0);  // avoid log(0)
    return -log(u) / lambda;
}

// triangular(lo, hi, mode) — Triangular distribution.
// Useful for quick modelling when you know min/max/most-likely value.
double random_triangular(double lo, double hi, double mode) {
    double u = random_float();
    double fc = (mode - lo) / (hi - lo);
    if (u < fc)
        return lo + sqrt(u * (hi - lo) * (mode - lo));
    else
        return hi - sqrt((1.0 - u) * (hi - lo) * (hi - mode));
}

// ── Array operations ──────────────────────────────────────────────────────────
//
// Use the stable public API from runtime/array.c rather than reaching into
// the struct internals directly.  The actual IntArray/StringArray structs both
// start with `uint8_t freed`, so any offset-based cast would be wrong.
//
// Extern declarations match the signatures in runtime/array.c:
extern int32_t    intarray_length(void *a);
extern int32_t    intarray_get   (void *a, int32_t i);
extern void       intarray_set   (void *a, int32_t i, int32_t v);

extern int32_t    stringarray_length(void *a);
extern const char *stringarray_get  (void *a, int32_t i);
extern void        stringarray_set  (void *a, int32_t i, const char *v);

// Fisher-Yates shuffle — IntArray (in-place, O(n))
void random_shuffle_ints(void *arr_ptr) {
    int32_t len = intarray_length(arr_ptr);
    for (int32_t i = len - 1; i > 0; i--) {
        int32_t j  = random_int(0, i);
        int32_t vi = intarray_get(arr_ptr, i);
        int32_t vj = intarray_get(arr_ptr, j);
        intarray_set(arr_ptr, i, vj);
        intarray_set(arr_ptr, j, vi);
    }
}

// Fisher-Yates shuffle — StringArray (in-place, O(n))
void random_shuffle_strings(void *arr_ptr) {
    int32_t len = stringarray_length(arr_ptr);
    for (int32_t i = len - 1; i > 0; i--) {
        int32_t    j  = random_int(0, i);
        const char *vi = stringarray_get(arr_ptr, i);
        const char *vj = stringarray_get(arr_ptr, j);
        stringarray_set(arr_ptr, i, vj);
        stringarray_set(arr_ptr, j, vi);
    }
}

// random_choice_int(arr) — index of a random element; -1 if empty
int32_t random_choice_int(void *arr_ptr) {
    int32_t len = intarray_length(arr_ptr);
    if (len == 0) return -1;
    return random_int(0, len - 1);
}

// random_choice_string(arr) — index of a random element; -1 if empty
int32_t random_choice_string(void *arr_ptr) {
    int32_t len = stringarray_length(arr_ptr);
    if (len == 0) return -1;
    return random_int(0, len - 1);
}
