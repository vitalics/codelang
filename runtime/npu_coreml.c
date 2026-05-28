/**
 * CodeLang CoreML + Quantization runtime  (runtime/npu_coreml.c)
 *
 * Provides hardware-accelerated inference via Apple Core ML and symmetric
 * INT8/INT4 quantization for weight compression and ANE dispatch.
 *
 * ── Backend ───────────────────────────────────────────────────────────────────
 *   Inference  → Core ML framework (MLModel / MLPredictionOptions)
 *                ANE / GPU / CPU target selected automatically by Core ML
 *   INT8 quant → symmetric per-tensor: q = round(x/scale) + zp, clipped [-128,127]
 *   INT4 quant → symmetric per-tensor: q clipped [-8,7], packed 2 nibbles/byte
 *   Dequant    → x = scale * (q − zero_point)  (returns heap-allocated float32*)
 *
 * ── Build ────────────────────────────────────────────────────────────────────
 *   macOS: clang -O2 -framework CoreML -framework Foundation npu_coreml.c
 *   Linux: (not supported — coreml_model_* stubs abort with an error message)
 *
 * ── Types ────────────────────────────────────────────────────────────────────
 *   coreml_model_t    — opaque pointer to loaded MLModel (ObjC object via void*)
 *   QuantizedMatrix   — rows×cols INT8 buffer + scale + zero_point metadata
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

/* ── Platform guard ──────────────────────────────────────────────────────────── */

#ifdef __APPLE__
#  include <objc/runtime.h>
#  include <objc/message.h>
#endif

/* ── Forward declaration for Matrix (mirrors runtime/npu.c) ─────────────────── */
/* Used by the matrix bridge functions below so callers can pass Matrix* directly
   instead of raw float*.  Must stay in sync with the struct in npu.c.           */
typedef struct {
    float   *data;
    int32_t  rows;
    int32_t  cols;
} NpuMatrix;

/* ══════════════════════════════════════════════════════════════════════════════
 * Internal types
 * ══════════════════════════════════════════════════════════════════════════════ */

typedef struct {
    void    *mlmodel;   /* id<MLModel> — ObjC object, NULL on non-Apple */
} coreml_model_t;

typedef struct {
    int8_t  *data;          /* quantized payload                           */
    int32_t  rows;
    int32_t  cols;
    float    scale;         /* quantization scale  (positive)              */
    int32_t  zero_point;    /* zero-point (0 for symmetric)                */
    int32_t  bits;          /* 8 or 4                                      */
} QuantizedMatrix;

/* ══════════════════════════════════════════════════════════════════════════════
 * CoreML model lifecycle
 * ══════════════════════════════════════════════════════════════════════════════ */

coreml_model_t *coreml_model_load(const char *path) {
    coreml_model_t *m = (coreml_model_t *)calloc(1, sizeof(coreml_model_t));

#ifdef __APPLE__
    /* Load the .mlpackage / .mlmodel using ObjC runtime to avoid a direct
       CoreML header dependency in C translation units. */
    Class NSString_class = objc_getClass("NSString");
    Class NSURL_class    = objc_getClass("NSURL");
    Class MLModel_class  = objc_getClass("MLModel");

    if (!MLModel_class) {
        fprintf(stderr, "[coreml] CoreML framework not linked — model load failed\n");
        return m;
    }

    /* NSString *nsPath = [NSString stringWithUTF8String:path] */
    id nsPath = ((id (*)(id, SEL, const char *))objc_msgSend)(
        (id)NSString_class,
        sel_registerName("stringWithUTF8String:"),
        path);

    /* NSURL *url = [NSURL fileURLWithPath:nsPath] */
    id url = ((id (*)(id, SEL, id))objc_msgSend)(
        (id)NSURL_class,
        sel_registerName("fileURLWithPath:"),
        nsPath);

    /* MLModel *model = [MLModel modelWithContentsOfURL:url error:nil] */
    id model = ((id (*)(id, SEL, id, id *))objc_msgSend)(
        (id)MLModel_class,
        sel_registerName("modelWithContentsOfURL:error:"),
        url, NULL);

    m->mlmodel = (void *)model;
#else
    fprintf(stderr, "[coreml] Core ML is only available on macOS\n");
#endif

    return m;
}

void coreml_model_free(coreml_model_t *m) {
    if (!m) return;
#ifdef __APPLE__
    if (m->mlmodel) {
        /* [model release] */
        ((void (*)(id, SEL))objc_msgSend)(
            (id)m->mlmodel, sel_registerName("release"));
    }
#endif
    free(m);
}

void coreml_model_predict(
    coreml_model_t *model,
    const float    *input,
    int32_t         input_len,
    float          *output,
    int32_t         output_len)
{
#ifdef __APPLE__
    if (!model || !model->mlmodel) {
        fprintf(stderr, "[coreml] predict called on null model\n");
        return;
    }
    /* Production usage would wrap input in MLFeatureProvider and call
       [model predictionFromFeatures:options:error:].
       This stub copies input to output for integration testing. */
    int32_t n = input_len < output_len ? input_len : output_len;
    memcpy(output, input, (size_t)n * sizeof(float));
    fprintf(stderr, "[coreml] predict: stub — implement MLFeatureProvider wrap for production\n");
#else
    fprintf(stderr, "[coreml] predict: not supported on this platform\n");
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * INT8 symmetric per-tensor quantization
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Quantize a float32 buffer to INT8.
 * Formula: q = round(x / scale) + zero_point, clipped to [-128, 127].
 */
QuantizedMatrix *coreml_quantize_int8(
    const float *src,
    int32_t      rows,
    int32_t      cols,
    float        scale,
    int32_t      zero_point)
{
    QuantizedMatrix *q = (QuantizedMatrix *)malloc(sizeof(QuantizedMatrix));
    int32_t n = rows * cols;
    q->data       = (int8_t *)malloc((size_t)n);
    q->rows       = rows;
    q->cols       = cols;
    q->scale      = scale;
    q->zero_point = zero_point;
    q->bits       = 8;

    float inv_scale = (scale > 0.0f) ? (1.0f / scale) : 0.0f;
    for (int32_t i = 0; i < n; i++) {
        float  fq  = roundf(src[i] * inv_scale) + (float)zero_point;
        int32_t qi = (int32_t)fq;
        if (qi < -128) qi = -128;
        if (qi >  127) qi =  127;
        q->data[i] = (int8_t)qi;
    }
    return q;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * INT4 symmetric per-tensor quantization  (2 nibbles per byte, signed)
 *
 * Nibble encoding: high nibble = even element, low nibble = odd element.
 * Value range: [-8, 7].
 * ══════════════════════════════════════════════════════════════════════════════ */

QuantizedMatrix *coreml_quantize_int4(
    const float *src,
    int32_t      rows,
    int32_t      cols,
    float        scale,
    int32_t      zero_point)
{
    int32_t n    = rows * cols;
    /* Round up to nearest even byte count */
    int32_t nb   = (n + 1) / 2;

    QuantizedMatrix *q = (QuantizedMatrix *)malloc(sizeof(QuantizedMatrix));
    q->data       = (int8_t *)calloc((size_t)nb, 1);
    q->rows       = rows;
    q->cols       = cols;
    q->scale      = scale;
    q->zero_point = zero_point;
    q->bits       = 4;

    float inv_scale = (scale > 0.0f) ? (1.0f / scale) : 0.0f;
    for (int32_t i = 0; i < n; i++) {
        float  fq  = roundf(src[i] * inv_scale) + (float)zero_point;
        int32_t qi = (int32_t)fq;
        if (qi < -8) qi = -8;
        if (qi >  7) qi =  7;

        int32_t byte_idx = i / 2;
        if (i % 2 == 0) {
            /* Even element → high nibble */
            q->data[byte_idx] = (int8_t)((qi & 0x0F) << 4);
        } else {
            /* Odd element → low nibble */
            q->data[byte_idx] |= (int8_t)(qi & 0x0F);
        }
    }
    return q;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Matrix bridge functions
 *
 * These accept NpuMatrix* (the opaque CodeLang Matrix type) so that CodeLang
 * callers can pass a Matrix directly rather than a raw float pointer.
 * Internally they delegate to the float* overloads above.
 * ══════════════════════════════════════════════════════════════════════════════ */

QuantizedMatrix *coreml_quantize_int8_matrix(
    NpuMatrix *m, float scale, int32_t zero_point)
{
    return coreml_quantize_int8(m->data, m->rows, m->cols, scale, zero_point);
}

QuantizedMatrix *coreml_quantize_int4_matrix(
    NpuMatrix *m, float scale, int32_t zero_point)
{
    return coreml_quantize_int4(m->data, m->rows, m->cols, scale, zero_point);
}

/** Run Core ML prediction, reading from and writing to NpuMatrix buffers. */
void coreml_model_predict_matrix(
    coreml_model_t *model,
    NpuMatrix      *input,
    NpuMatrix      *output)
{
    coreml_model_predict(model,
        input->data,  input->rows  * input->cols,
        output->data, output->rows * output->cols);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Dequantization: INT8/INT4 → float32
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns a heap-allocated float32 buffer of size q->rows * q->cols.
 * Formula: x = scale * (q - zero_point).
 * Caller is responsible for free()-ing the returned pointer.
 */
float *coreml_dequantize(const QuantizedMatrix *q) {
    int32_t n   = q->rows * q->cols;
    float  *out = (float *)malloc((size_t)n * sizeof(float));

    if (q->bits == 8) {
        for (int32_t i = 0; i < n; i++)
            out[i] = q->scale * ((float)q->data[i] - (float)q->zero_point);
    } else {
        /* INT4 — unpack nibbles */
        for (int32_t i = 0; i < n; i++) {
            int32_t byte_idx = i / 2;
            int32_t nibble;
            if (i % 2 == 0) {
                nibble = (int32_t)((q->data[byte_idx] >> 4) & 0x0F);
            } else {
                nibble = (int32_t)(q->data[byte_idx] & 0x0F);
            }
            /* Sign-extend from 4 bits */
            if (nibble >= 8) nibble -= 16;
            out[i] = q->scale * ((float)nibble - (float)q->zero_point);
        }
    }
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * QuantizedMatrix accessors
 * ══════════════════════════════════════════════════════════════════════════════ */

int32_t coreml_qmatrix_rows(const QuantizedMatrix *q)        { return q->rows; }
int32_t coreml_qmatrix_cols(const QuantizedMatrix *q)        { return q->cols; }
float   coreml_qmatrix_scale(const QuantizedMatrix *q)       { return q->scale; }
int32_t coreml_qmatrix_zero_point(const QuantizedMatrix *q)  { return q->zero_point; }

/** Read INT8 element at (row, col): value in [-128, 127]. */
int32_t coreml_qmatrix_get_int8(const QuantizedMatrix *q, int32_t row, int32_t col) {
    return (int32_t)q->data[row * q->cols + col];
}

/** Read INT4 nibble at logical (row, col): value in [-8, 7]. */
int32_t coreml_qmatrix_get_int4(const QuantizedMatrix *q, int32_t row, int32_t col) {
    int32_t i        = row * q->cols + col;
    int32_t byte_idx = i / 2;
    int32_t nibble   = (i % 2 == 0)
        ? (int32_t)((q->data[byte_idx] >> 4) & 0x0F)
        : (int32_t)( q->data[byte_idx]        & 0x0F);
    if (nibble >= 8) nibble -= 16;
    return nibble;
}

void coreml_qmatrix_free(QuantizedMatrix *q) {
    if (!q) return;
    free(q->data);
    free(q);
}

char *coreml_qmatrix_to_string(const QuantizedMatrix *q) {
    int32_t n      = q->rows * q->cols;
    /* Max per element: "-128, " → 6 chars; plus header ≈ 64 bytes */
    int     bufsz  = 64 + n * 6;
    char   *buf    = (char *)malloc((size_t)bufsz);
    int     pos    = snprintf(buf, bufsz,
        "QuantizedMatrix(INT%d, %dx%d, scale=%g, zp=%d)[",
        (int)q->bits, (int)q->rows, (int)q->cols,
        (double)q->scale, (int)q->zero_point);

    for (int32_t i = 0; i < n && pos < bufsz - 8; i++) {
        if (i > 0) pos += snprintf(buf + pos, bufsz - pos, ", ");
        int32_t v = (q->bits == 8)
            ? coreml_qmatrix_get_int8(q, i / q->cols, i % q->cols)
            : coreml_qmatrix_get_int4(q, i / q->cols, i % q->cols);
        pos += snprintf(buf + pos, bufsz - pos, "%d", (int)v);
    }
    snprintf(buf + pos, bufsz - pos, "]");
    return buf;
}
