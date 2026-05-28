/**
 * CodeLang Math runtime — wrappers around C99 <math.h> / libm.
 *
 * Every function exposed here is imported by stdlib/math.code via
 * `export extern fn`.  All floating-point work uses double (Float64)
 * because CodeLang's `float` alias maps to LLVM `double`.
 *
 * On macOS libm is bundled in libSystem — no extra link flag is needed.
 * On Linux you must pass -lm to the linker.
 */

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

// ── Constants ─────────────────────────────────────────────────────────────────

double math_pi()      { return M_PI; }
double math_e()       { return M_E; }
double math_ln2()     { return M_LN2; }
double math_ln10()    { return M_LN10; }
double math_log2e()   { return M_LOG2E; }
double math_log10e()  { return M_LOG10E; }
double math_sqrt2()   { return M_SQRT2; }
double math_tau()     { return M_PI * 2.0; }

// ── Rounding ──────────────────────────────────────────────────────────────────

double  math_floor(double x)  { return floor(x); }
double  math_ceil(double x)   { return ceil(x); }
double  math_round(double x)  { return round(x); }
double  math_trunc(double x)  { return trunc(x); }

// sign: -1.0 / 0.0 / 1.0  (NaN → 0.0)
double math_sign_f(double x) {
    if (x > 0.0) return  1.0;
    if (x < 0.0) return -1.0;
    return 0.0;
}

int32_t math_sign_i(int32_t x) {
    if (x > 0) return  1;
    if (x < 0) return -1;
    return 0;
}

// ── Absolute value ────────────────────────────────────────────────────────────

double  math_abs_f(double x)  { return fabs(x); }
int32_t math_abs_i(int32_t x) { return abs(x); }
int64_t math_abs_l(int64_t x) { return llabs(x); }

// ── Power / roots ─────────────────────────────────────────────────────────────

double math_sqrt(double x)          { return sqrt(x); }
double math_cbrt(double x)          { return cbrt(x); }
double math_pow(double x, double y) { return pow(x, y); }
double math_exp(double x)           { return exp(x); }
double math_exp2(double x)          { return exp2(x); }
double math_expm1(double x)         { return expm1(x); }  // e^x - 1, accurate near 0

// ── Logarithms ────────────────────────────────────────────────────────────────

double math_log(double x)   { return log(x); }    // natural log
double math_log2(double x)  { return log2(x); }
double math_log10(double x) { return log10(x); }
double math_log1p(double x) { return log1p(x); }  // ln(1+x), accurate near 0

// ── Trigonometry (arguments in radians) ──────────────────────────────────────

double math_sin(double x)           { return sin(x); }
double math_cos(double x)           { return cos(x); }
double math_tan(double x)           { return tan(x); }
double math_asin(double x)          { return asin(x); }
double math_acos(double x)          { return acos(x); }
double math_atan(double x)          { return atan(x); }
double math_atan2(double y, double x) { return atan2(y, x); }

// ── Hyperbolic functions ──────────────────────────────────────────────────────

double math_sinh(double x)  { return sinh(x); }
double math_cosh(double x)  { return cosh(x); }
double math_tanh(double x)  { return tanh(x); }
double math_asinh(double x) { return asinh(x); }
double math_acosh(double x) { return acosh(x); }
double math_atanh(double x) { return atanh(x); }

// ── Min / max / clamp ─────────────────────────────────────────────────────────

double  math_min_f(double a, double b)   { return fmin(a, b); }
double  math_max_f(double a, double b)   { return fmax(a, b); }
int32_t math_min_i(int32_t a, int32_t b) { return a < b ? a : b; }
int32_t math_max_i(int32_t a, int32_t b) { return a > b ? a : b; }

double math_clamp_f(double x, double lo, double hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

int32_t math_clamp_i(int32_t x, int32_t lo, int32_t hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

// ── Misc ──────────────────────────────────────────────────────────────────────

double math_hypot(double a, double b)    { return hypot(a, b); }
double math_fmod(double x, double y)     { return fmod(x, y); }
double math_remainder(double x, double y){ return remainder(x, y); }
double math_copysign(double mag, double sign) { return copysign(mag, sign); }

// ── Angle conversion ──────────────────────────────────────────────────────────

double math_to_radians(double deg) { return deg * M_PI / 180.0; }
double math_to_degrees(double rad) { return rad * 180.0 / M_PI; }

// ── IEEE 754 queries ──────────────────────────────────────────────────────────

int32_t math_is_nan(double x)      { return isnan(x)    ? 1 : 0; }
int32_t math_is_finite(double x)   { return isfinite(x) ? 1 : 0; }
int32_t math_is_infinite(double x) { return isinf(x)    ? 1 : 0; }

// ── Random ────────────────────────────────────────────────────────────────────
//
// math_random() returns a uniform double in [0.0, 1.0).
// Not cryptographically secure — uses C stdlib rand().
// Call math_seed_random() once at startup for reproducible sequences.

double math_random(void) {
    return (double)rand() / ((double)RAND_MAX + 1.0);
}

void math_seed_random(int32_t seed) {
    srand((unsigned int)seed);
}
