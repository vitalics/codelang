/**
 * CodeLang SIMD runtime — Float2 / Float4 / Float8 / Float16
 *
 * Provides constructors, element access, and math helpers for the intrinsic
 * SIMD vector types declared in stdlib/numbers.code:
 *
 *   Float2  → <2 x float>   (2D vectors, UV coords)
 *   Float4  → <4 x float>   (3D homogeneous, RGBA)
 *   Float8  → <8 x float>   (batch processing)
 *   Float16 → <16 x float>  (batch processing)
 *
 * Arithmetic operators (+, -, *, /) are handled directly by the LLVM IR
 * generator (fadd/fsub/fmul/fdiv on vector types).  This file covers
 * everything that needs C-side implementation: constructors, element
 * extraction, reductions (dot, sum), math (sqrt, normalize), and formatting.
 *
 * Compiled with:  clang -O2 -march=native
 * Requires:       C11 + GNU vector extensions (supported by Clang and GCC)
 */

#include <stdint.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Vector type aliases via GNU vector extensions ───────────────────────── */

typedef float  Float2  __attribute__((vector_size(8)));
typedef float  Float4  __attribute__((vector_size(16)));
typedef float  Float8  __attribute__((vector_size(32)));
typedef float  Float16 __attribute__((vector_size(64)));

/* ══════════════════════════════════════════════════════════════════════════
 * Float2  (<2 x float>)
 * ══════════════════════════════════════════════════════════════════════════ */

Float2 float2_of(float x, float y) {
    return (Float2){ x, y };
}

Float2 float2_splat(float v) {
    return (Float2){ v, v };
}

float float2_x(Float2 v) { return v[0]; }
float float2_y(Float2 v) { return v[1]; }

Float2 float2_set_x(Float2 v, float x) { v[0] = x; return v; }
Float2 float2_set_y(Float2 v, float y) { v[1] = y; return v; }

float float2_dot(Float2 a, Float2 b) {
    Float2 p = a * b;
    return p[0] + p[1];
}

float float2_length_sq(Float2 v) { return float2_dot(v, v); }
float float2_length(Float2 v)    { return sqrtf(float2_length_sq(v)); }

Float2 float2_normalize(Float2 v) {
    float len = float2_length(v);
    if (len == 0.0f) return v;
    return v / float2_splat(len);
}

Float2 float2_abs(Float2 v) {
    return (Float2){ fabsf(v[0]), fabsf(v[1]) };
}

Float2 float2_min(Float2 a, Float2 b) {
    return (Float2){ a[0] < b[0] ? a[0] : b[0],
                     a[1] < b[1] ? a[1] : b[1] };
}

Float2 float2_max(Float2 a, Float2 b) {
    return (Float2){ a[0] > b[0] ? a[0] : b[0],
                     a[1] > b[1] ? a[1] : b[1] };
}

Float2 float2_clamp(Float2 v, Float2 lo, Float2 hi) {
    return float2_min(float2_max(v, lo), hi);
}

Float2 float2_lerp(Float2 a, Float2 b, float t) {
    return a + (b - a) * float2_splat(t);
}

float float2_distance(Float2 a, Float2 b) {
    return float2_length(b - a);
}

/* Rotate v by angle radians counter-clockwise */
Float2 float2_rotate(Float2 v, float angle) {
    float c = cosf(angle), s = sinf(angle);
    return (Float2){ v[0]*c - v[1]*s, v[0]*s + v[1]*c };
}

/* Reflect v about normal n (n must be unit-length) */
Float2 float2_reflect(Float2 v, Float2 n) {
    return v - n * float2_splat(2.0f * float2_dot(v, n));
}

/* 2D cross product (returns scalar — the z-component of the 3D cross) */
float float2_cross(Float2 a, Float2 b) {
    return a[0]*b[1] - a[1]*b[0];
}

/* Perpendicular vector (rotate 90° CCW) */
Float2 float2_perp(Float2 v) {
    return (Float2){ -v[1], v[0] };
}

char *float2_to_string(Float2 v) {
    char *buf = (char *)malloc(64);
    snprintf(buf, 64, "Float2(%g, %g)", (double)v[0], (double)v[1]);
    return buf;
}

void float2_print(Float2 v) {
    printf("Float2(%g, %g)\n", (double)v[0], (double)v[1]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Float4  (<4 x float>)
 * ══════════════════════════════════════════════════════════════════════════ */

Float4 float4_of(float x, float y, float z, float w) {
    return (Float4){ x, y, z, w };
}

Float4 float4_xyz(float x, float y, float z) {
    return (Float4){ x, y, z, 0.0f };
}

Float4 float4_splat(float v) {
    return (Float4){ v, v, v, v };
}

float float4_x(Float4 v) { return v[0]; }
float float4_y(Float4 v) { return v[1]; }
float float4_z(Float4 v) { return v[2]; }
float float4_w(Float4 v) { return v[3]; }

Float4 float4_set_x(Float4 v, float x) { v[0] = x; return v; }
Float4 float4_set_y(Float4 v, float y) { v[1] = y; return v; }
Float4 float4_set_z(Float4 v, float z) { v[2] = z; return v; }
Float4 float4_set_w(Float4 v, float w) { v[3] = w; return v; }

/* Full 4-component dot product */
float float4_dot(Float4 a, Float4 b) {
    Float4 p = a * b;
    return p[0] + p[1] + p[2] + p[3];
}

/* 3-component dot product (ignores w) */
float float4_dot3(Float4 a, Float4 b) {
    Float4 p = a * b;
    return p[0] + p[1] + p[2];
}

float float4_length_sq(Float4 v)  { return float4_dot(v, v); }
float float4_length_sq3(Float4 v) { return float4_dot3(v, v); }
float float4_length(Float4 v)     { return sqrtf(float4_length_sq(v)); }
float float4_length3(Float4 v)    { return sqrtf(float4_length_sq3(v)); }

Float4 float4_normalize(Float4 v) {
    float len = float4_length(v);
    if (len == 0.0f) return v;
    return v / float4_splat(len);
}

/* Normalize treating v as a 3D vector (preserves w) */
Float4 float4_normalize3(Float4 v) {
    float len = float4_length3(v);
    if (len == 0.0f) return v;
    Float4 r = v / float4_splat(len);
    r[3] = v[3];   /* restore original w */
    return r;
}

/* 3D cross product — result has w=0 */
Float4 float4_cross3(Float4 a, Float4 b) {
    return (Float4){
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0],
        0.0f
    };
}

Float4 float4_abs(Float4 v) {
    return (Float4){ fabsf(v[0]), fabsf(v[1]), fabsf(v[2]), fabsf(v[3]) };
}

Float4 float4_min(Float4 a, Float4 b) {
    return (Float4){ a[0] < b[0] ? a[0] : b[0],
                     a[1] < b[1] ? a[1] : b[1],
                     a[2] < b[2] ? a[2] : b[2],
                     a[3] < b[3] ? a[3] : b[3] };
}

Float4 float4_max(Float4 a, Float4 b) {
    return (Float4){ a[0] > b[0] ? a[0] : b[0],
                     a[1] > b[1] ? a[1] : b[1],
                     a[2] > b[2] ? a[2] : b[2],
                     a[3] > b[3] ? a[3] : b[3] };
}

Float4 float4_clamp(Float4 v, Float4 lo, Float4 hi) {
    return float4_min(float4_max(v, lo), hi);
}

Float4 float4_lerp(Float4 a, Float4 b, float t) {
    return a + (b - a) * float4_splat(t);
}

float float4_distance(Float4 a, Float4 b)  { return float4_length(b - a); }
float float4_distance3(Float4 a, Float4 b) { return float4_length3(b - a); }

/* Reflect v about unit normal n */
Float4 float4_reflect3(Float4 v, Float4 n) {
    return v - n * float4_splat(2.0f * float4_dot3(v, n));
}

/* Horizontal sum of all 4 lanes */
float float4_sum(Float4 v) { return v[0] + v[1] + v[2] + v[3]; }

char *float4_to_string(Float4 v) {
    char *buf = (char *)malloc(96);
    snprintf(buf, 96, "Float4(%g, %g, %g, %g)",
             (double)v[0], (double)v[1], (double)v[2], (double)v[3]);
    return buf;
}

void float4_print(Float4 v) {
    printf("Float4(%g, %g, %g, %g)\n",
           (double)v[0], (double)v[1], (double)v[2], (double)v[3]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Float8  (<8 x float>) — pointer-based C API
 *
 * ARM64 (Apple Silicon) AAPCS64 only supports NEON registers up to 128 bits.
 * Passing <8 x float> (256-bit) by value across the LLVM IR → C ABI boundary
 * causes a SIGBUS on ARM64.  All Float8 functions therefore use float* at
 * the boundary; the CodeLang IR generator emits alloca + bitcast wrappers to
 * bridge the LLVM vector register world with this pointer-based API.
 * ══════════════════════════════════════════════════════════════════════════ */

/* out ← {a,b,c,d,e,f,g,h} */
void float8_of(float *out, float a, float b, float c, float d,
               float e, float f, float g, float h) {
    out[0]=a; out[1]=b; out[2]=c; out[3]=d;
    out[4]=e; out[5]=f; out[6]=g; out[7]=h;
}

/* out ← {v,v,v,v,v,v,v,v} */
void float8_splat(float *out, float v) {
    for (int32_t i = 0; i < 8; i++) out[i] = v;
}

float float8_get(const float *v, int32_t i) { return v[i]; }

/* out ← v with lane i replaced by val  (out may alias v) */
void float8_set(float *out, const float *v, int32_t i, float val) {
    memcpy(out, v, 32);
    out[i] = val;
}

float float8_sum(const float *v) {
    return v[0]+v[1]+v[2]+v[3]+v[4]+v[5]+v[6]+v[7];
}

float float8_dot(const float *a, const float *b) {
    float s = 0.0f;
    for (int32_t i = 0; i < 8; i++) s += a[i] * b[i];
    return s;
}

void float8_abs(float *out, const float *v) {
    for (int32_t i = 0; i < 8; i++) out[i] = fabsf(v[i]);
}

void float8_min(float *out, const float *a, const float *b) {
    for (int32_t i = 0; i < 8; i++) out[i] = a[i] < b[i] ? a[i] : b[i];
}

void float8_max(float *out, const float *a, const float *b) {
    for (int32_t i = 0; i < 8; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
}

void float8_lerp(float *out, const float *a, const float *b, float t) {
    for (int32_t i = 0; i < 8; i++) out[i] = a[i] + (b[i] - a[i]) * t;
}

char *float8_to_string(const float *v) {
    char *buf = (char *)malloc(192);
    snprintf(buf, 192, "Float8(%g, %g, %g, %g, %g, %g, %g, %g)",
             (double)v[0], (double)v[1], (double)v[2], (double)v[3],
             (double)v[4], (double)v[5], (double)v[6], (double)v[7]);
    return buf;
}

void float8_print(const float *v) {
    printf("Float8(%g, %g, %g, %g, %g, %g, %g, %g)\n",
           (double)v[0], (double)v[1], (double)v[2], (double)v[3],
           (double)v[4], (double)v[5], (double)v[6], (double)v[7]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Float16  (<16 x float>) — pointer-based C API (same rationale as Float8)
 * ══════════════════════════════════════════════════════════════════════════ */

void float16_of(float *out,
                float a, float b, float c, float d,
                float e, float f, float g, float h,
                float i, float j, float k, float l,
                float m, float n, float o, float p) {
    out[ 0]=a; out[ 1]=b; out[ 2]=c; out[ 3]=d;
    out[ 4]=e; out[ 5]=f; out[ 6]=g; out[ 7]=h;
    out[ 8]=i; out[ 9]=j; out[10]=k; out[11]=l;
    out[12]=m; out[13]=n; out[14]=o; out[15]=p;
}

void float16_splat(float *out, float v) {
    for (int32_t i = 0; i < 16; i++) out[i] = v;
}

float float16_get(const float *v, int32_t i) { return v[i]; }

void float16_set(float *out, const float *v, int32_t i, float val) {
    memcpy(out, v, 64);
    out[i] = val;
}

float float16_sum(const float *v) {
    float s = 0.0f;
    for (int32_t i = 0; i < 16; i++) s += v[i];
    return s;
}

float float16_dot(const float *a, const float *b) {
    float s = 0.0f;
    for (int32_t i = 0; i < 16; i++) s += a[i] * b[i];
    return s;
}

void float16_lerp(float *out, const float *a, const float *b, float t) {
    for (int32_t i = 0; i < 16; i++) out[i] = a[i] + (b[i] - a[i]) * t;
}

char *float16_to_string(const float *v) {
    char *buf = (char *)malloc(384);
    snprintf(buf, 384,
             "Float16(%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g)",
             (double)v[ 0],(double)v[ 1],(double)v[ 2],(double)v[ 3],
             (double)v[ 4],(double)v[ 5],(double)v[ 6],(double)v[ 7],
             (double)v[ 8],(double)v[ 9],(double)v[10],(double)v[11],
             (double)v[12],(double)v[13],(double)v[14],(double)v[15]);
    return buf;
}

void float16_print(const float *v) {
    printf("Float16(%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g,%g)\n",
           (double)v[ 0],(double)v[ 1],(double)v[ 2],(double)v[ 3],
           (double)v[ 4],(double)v[ 5],(double)v[ 6],(double)v[ 7],
           (double)v[ 8],(double)v[ 9],(double)v[10],(double)v[11],
           (double)v[12],(double)v[13],(double)v[14],(double)v[15]);
}
