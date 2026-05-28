/**
 * CodeLang NPU runtime — hardware-accelerated matrix operations
 *
 * On Apple Silicon (M-series) this delegates to Apple's Accelerate framework,
 * which routes work to the AMX (Apple Matrix Extension) coprocessor and the
 * Neural Engine where appropriate:
 *
 *   matrix_multiply → cblas_sgemm  (GEMM via AMX)
 *   matrix_add      → vDSP_vadd    (vector add via vDSP)
 *   matrix_relu     → vDSP_vthres  (vector threshold via vDSP)
 *
 * On Linux a portable scalar fallback is used automatically.
 *
 * Compiled with: clang -O2
 * macOS link:    -framework Accelerate
 * Linux link:    -lm  (no BLAS dependency for the scalar path)
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#ifdef __APPLE__
/* Use the new ILP64-compatible Accelerate headers (macOS 13.3+).
   On older SDKs the legacy cblas.h is included automatically.      */
#  define ACCELERATE_NEW_LAPACK 1
#  include <Accelerate/Accelerate.h>
#endif

/* ── Internal struct ────────────────────────────────────────────────────────── */

typedef struct {
    float   *data;   /* row-major, size = rows * cols */
    int32_t  rows;
    int32_t  cols;
} Matrix;

/* ── Construction / destruction ─────────────────────────────────────────────── */

Matrix *matrix_new(int32_t rows, int32_t cols) {
    Matrix *m = (Matrix *)malloc(sizeof(Matrix));
    m->rows   = rows;
    m->cols   = cols;
    m->data   = (float *)calloc((size_t)(rows * cols), sizeof(float));
    return m;
}

void matrix_free(Matrix *m) {
    if (!m) return;
    free(m->data);
    free(m);
}

/* ── Element access ─────────────────────────────────────────────────────────── */

float matrix_get(Matrix *m, int32_t row, int32_t col) {
    return m->data[(int)(row * m->cols + col)];
}

void matrix_set(Matrix *m, int32_t row, int32_t col, float val) {
    m->data[(int)(row * m->cols + col)] = val;
}

int32_t matrix_rows(Matrix *m) { return m->rows; }
int32_t matrix_cols(Matrix *m) { return m->cols; }

/* ── Arithmetic ─────────────────────────────────────────────────────────────── */

/**
 * C = A × B — hardware-accelerated on Apple Silicon via cblas_sgemm (AMX).
 * Requires: A is (m×k), B is (k×n), result is (m×n).
 */
Matrix *matrix_multiply(Matrix *a, Matrix *b) {
    int32_t m = a->rows, k = a->cols, n = b->cols;
    Matrix *c = matrix_new(m, n);

#ifdef __APPLE__
    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasNoTrans,
                (int)m, (int)n, (int)k,
                1.0f, a->data, (int)k,
                      b->data, (int)n,
                0.0f, c->data, (int)n);
#else
    /* Scalar fallback — correct but not hardware-accelerated */
    for (int32_t i = 0; i < m; i++) {
        for (int32_t j = 0; j < n; j++) {
            float acc = 0.0f;
            for (int32_t p = 0; p < k; p++)
                acc += a->data[i * k + p] * b->data[p * n + j];
            c->data[i * n + j] = acc;
        }
    }
#endif
    return c;
}

/**
 * out = a + b — element-wise addition.
 * On macOS uses vDSP_vadd (vectorised via vDSP).
 */
Matrix *matrix_add(Matrix *a, Matrix *b) {
    int32_t size = a->rows * a->cols;
    Matrix *out = matrix_new(a->rows, a->cols);

#ifdef __APPLE__
    vDSP_vadd(a->data, 1, b->data, 1, out->data, 1, (vDSP_Length)size);
#else
    for (int32_t i = 0; i < size; i++) out->data[i] = a->data[i] + b->data[i];
#endif
    return out;
}

/**
 * out = ReLU(a) = max(0, a) — element-wise.
 * On macOS uses vDSP_vthres (vectorised threshold via vDSP).
 */
Matrix *matrix_relu(Matrix *a) {
    int32_t size = a->rows * a->cols;
    Matrix *out = matrix_new(a->rows, a->cols);

#ifdef __APPLE__
    float zero = 0.0f;
    vDSP_vthres(a->data, 1, &zero, out->data, 1, (vDSP_Length)size);
#else
    for (int32_t i = 0; i < size; i++)
        out->data[i] = a->data[i] > 0.0f ? a->data[i] : 0.0f;
#endif
    return out;
}

/* ── In-place modifiers (return self for chaining) ───────────────────────────── */

Matrix *matrix_fill(Matrix *m, float val) {
    int32_t size = m->rows * m->cols;
#ifdef __APPLE__
    vDSP_vfill(&val, m->data, 1, (vDSP_Length)size);
#else
    for (int32_t i = 0; i < size; i++) m->data[i] = val;
#endif
    return m;
}

Matrix *matrix_scale(Matrix *m, float factor) {
    int32_t size = m->rows * m->cols;
#ifdef __APPLE__
    vDSP_vsmul(m->data, 1, &factor, m->data, 1, (vDSP_Length)size);
#else
    for (int32_t i = 0; i < size; i++) m->data[i] *= factor;
#endif
    return m;
}

/* ── Neural-network activations (additional) ────────────────────────────────── */

/**
 * Numerically-stable row-wise softmax.
 * Subtracts the row maximum before exponentiation to prevent overflow.
 * Each row of out sums to 1.
 */
Matrix *matrix_softmax(Matrix *a) {
    Matrix *out  = matrix_new(a->rows, a->cols);
    int32_t cols = a->cols;
    for (int32_t r = 0; r < a->rows; r++) {
        const float *src = a->data   + (int)(r * cols);
        float       *dst = out->data + (int)(r * cols);
        float mx = src[0];
        for (int32_t c = 1; c < cols; c++)
            if (src[c] > mx) mx = src[c];
        float s = 0.0f;
        for (int32_t c = 0; c < cols; c++) { dst[c] = expf(src[c] - mx); s += dst[c]; }
        for (int32_t c = 0; c < cols; c++) dst[c] /= s;
    }
    return out;
}

/**
 * Sigmoid: out[i] = 1 / (1 + exp(-in[i])) — element-wise.
 */
Matrix *matrix_sigmoid(Matrix *a) {
    int32_t size = a->rows * a->cols;
    Matrix *out  = matrix_new(a->rows, a->cols);
    for (int32_t i = 0; i < size; i++)
        out->data[i] = 1.0f / (1.0f + expf(-a->data[i]));
    return out;
}

/**
 * Tanh: out[i] = tanh(in[i]) — element-wise.
 */
Matrix *matrix_tanh(Matrix *a) {
    int32_t size = a->rows * a->cols;
    Matrix *out  = matrix_new(a->rows, a->cols);
    for (int32_t i = 0; i < size; i++)
        out->data[i] = tanhf(a->data[i]);
    return out;
}

/**
 * Transpose: result is (cols × rows) with out[j,i] = in[i,j].
 */
Matrix *matrix_transpose(Matrix *a) {
    Matrix *out = matrix_new(a->cols, a->rows);
    for (int32_t i = 0; i < a->rows; i++)
        for (int32_t j = 0; j < a->cols; j++)
            out->data[(int)(j * a->rows + i)] = a->data[(int)(i * a->cols + j)];
    return out;
}

/* ── Display ────────────────────────────────────────────────────────────────── */

void matrix_print(Matrix *m) {
    printf("Matrix(%dx%d)[", (int)m->rows, (int)m->cols);
    for (int32_t i = 0; i < m->rows; i++) {
        if (i > 0) printf(", ");
        printf("[");
        for (int32_t j = 0; j < m->cols; j++) {
            if (j > 0) printf(", ");
            printf("%g", (double)m->data[i * m->cols + j]);
        }
        printf("]");
    }
    printf("]\n");
}

char *matrix_to_string(Matrix *m) {
    /* Estimate: header (32 B) + each element (16 B) + brackets */
    int bufsz = 64 + (int)(m->rows * m->cols) * 16;
    char *buf = (char *)malloc((size_t)bufsz);
    int pos = snprintf(buf, bufsz, "Matrix(%dx%d)[", (int)m->rows, (int)m->cols);
    for (int32_t i = 0; i < m->rows; i++) {
        if (i > 0) pos += snprintf(buf + pos, bufsz - pos, ", ");
        pos += snprintf(buf + pos, bufsz - pos, "[");
        for (int32_t j = 0; j < m->cols; j++) {
            if (j > 0) pos += snprintf(buf + pos, bufsz - pos, ", ");
            pos += snprintf(buf + pos, bufsz - pos, "%g",
                            (double)m->data[i * m->cols + j]);
        }
        pos += snprintf(buf + pos, bufsz - pos, "]");
    }
    snprintf(buf + pos, bufsz - pos, "]");
    return buf;
}
