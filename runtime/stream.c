/**
 * CodeLang Stream runtime — in-memory and string-backed streams.
 *
 * Provides the C-level backing for stdlib/stream.code:
 *
 *   MemoryStream  — a growable in-memory byte buffer with independent
 *                   read (rpos) and write (len) positions.  Supports both
 *                   text (Readable / Writable) and binary (ByteReadable /
 *                   ByteWritable) protocol operations.
 *
 *   StringReader  — a read-only cursor over a heap copy of a string.
 *                   Implements Readable and ByteReadable.
 *
 * Buffer interop: Buffer is defined in runtime/string.c.  We re-declare
 * its struct layout here (keeping them in sync) and use extern declarations
 * for the buffer_* helpers so the linker resolves them from string.c.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── Buffer interop ──────────────────────────────────────────────────────────
 * Buffer is the canonical byte-sequence type, defined in runtime/string.c.
 * We re-declare the struct layout so stream.c can construct Buffer objects
 * without a separate header file (following the pattern of other runtime files).
 */
typedef struct Buffer {
    uint8_t  freed;
    uint8_t *data;
    int32_t  len;
} Buffer;

extern Buffer  *buffer_new(int32_t len);
extern void     buffer_free(Buffer *b);
extern uint8_t  buffer_get(Buffer *b, int32_t i);
extern void     buffer_set(Buffer *b, int32_t i, uint8_t v);

/* Allocate a Buffer* and copy `len` bytes from `src` into it. */
static Buffer *stream_make_buffer(const uint8_t *src, int32_t len) {
    Buffer *b = buffer_new(len);
    if (!b) return buffer_new(0);
    for (int32_t i = 0; i < len; i++) buffer_set(b, i, src[i]);
    return b;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * MemoryStream
 *
 * Layout: { freed, data[], cap, len, rpos }
 *
 *   data  — heap-allocated byte buffer (grows by doubling)
 *   cap   — allocated capacity (bytes)
 *   len   — write head: number of valid bytes in data
 *   rpos  — read head: current read position (always ≤ len)
 *
 * Writing advances `len`; reading advances `rpos`.
 * reset() sets rpos = 0; seek(pos) sets rpos = pos (clamped to [0, len]).
 * ═══════════════════════════════════════════════════════════════════════════ */

#define MS_INIT_CAP 64

typedef struct {
    uint8_t  freed;
    uint8_t *data;
    int32_t  cap;
    int32_t  len;   /* write head */
    int32_t  rpos;  /* read head  */
} MemoryStream;

static void ms_ensure(MemoryStream *s, int32_t extra) {
    if (!s || s->freed) return;
    if (s->len + extra <= s->cap) return;
    int32_t new_cap = s->cap ? s->cap * 2 : MS_INIT_CAP;
    while (new_cap < s->len + extra) new_cap *= 2;
    s->data = (uint8_t *)realloc(s->data, (size_t)new_cap);
    s->cap  = new_cap;
}

MemoryStream *memstream_new(void) {
    MemoryStream *s = (MemoryStream *)calloc(1, sizeof(MemoryStream));
    s->freed = 0;
    s->data  = (uint8_t *)malloc(MS_INIT_CAP);
    s->cap   = MS_INIT_CAP;
    s->len   = 0;
    s->rpos  = 0;
    return s;
}

/* Create a MemoryStream pre-loaded with the bytes of a string. */
MemoryStream *memstream_from_string(const char *str) {
    MemoryStream *s = memstream_new();
    if (!str) return s;
    int32_t n = (int32_t)strlen(str);
    ms_ensure(s, n);
    memcpy(s->data, str, (size_t)n);
    s->len  = n;
    s->rpos = 0;
    return s;
}

/* Create a MemoryStream pre-loaded with the bytes of a Buffer. */
MemoryStream *memstream_from_buffer(Buffer *buf) {
    MemoryStream *s = memstream_new();
    if (!buf) return s;
    int32_t n = buf->len;
    ms_ensure(s, n);
    memcpy(s->data, buf->data, (size_t)n);
    s->len  = n;
    s->rpos = 0;
    return s;
}

/* Append a NUL-terminated string to the stream. */
void memstream_write_str(MemoryStream *s, const char *str) {
    if (!s || s->freed || !str) return;
    int32_t n = (int32_t)strlen(str);
    if (n == 0) return;
    ms_ensure(s, n);
    memcpy(s->data + s->len, str, (size_t)n);
    s->len += n;
}

/* Append all bytes of a Buffer to the stream. */
void memstream_write_bytes(MemoryStream *s, Buffer *buf) {
    if (!s || s->freed || !buf) return;
    int32_t n = buf->len;
    if (n == 0) return;
    ms_ensure(s, n);
    memcpy(s->data + s->len, buf->data, (size_t)n);
    s->len += n;
}

/* Append a single byte (0–255) to the stream. */
void memstream_write_byte(MemoryStream *s, int32_t b) {
    if (!s || s->freed) return;
    ms_ensure(s, 1);
    s->data[s->len++] = (uint8_t)(b & 0xFF);
}

/*
 * Read up to `n` bytes starting at `rpos` and return them as a new Buffer.
 * Advances rpos by the number of bytes actually read.
 * Returns an empty Buffer at EOF.
 */
Buffer *memstream_read(MemoryStream *s, int32_t n) {
    if (!s || s->freed || n <= 0 || s->rpos >= s->len)
        return buffer_new(0);
    int32_t avail = s->len - s->rpos;
    int32_t take  = n < avail ? n : avail;
    Buffer *b = stream_make_buffer(s->data + s->rpos, take);
    s->rpos += take;
    return b;
}

/*
 * Read one byte from the stream.
 * Returns the byte value (0–255), or -1 at EOF.
 */
int32_t memstream_read_byte(MemoryStream *s) {
    if (!s || s->freed || s->rpos >= s->len) return -1;
    return (int32_t)(s->data[s->rpos++]);
}

/*
 * Read bytes from rpos up to (but not including) the next '\n', or to the
 * end of the stream.  Advances rpos past the '\n'.
 * Returns a heap-allocated, NUL-terminated string.
 * Returns "" at EOF.
 */
char *memstream_read_line(MemoryStream *s) {
    if (!s || s->freed || s->rpos >= s->len) return (char *)"";
    int32_t start = s->rpos;
    int32_t end   = start;
    while (end < s->len && s->data[end] != '\n') end++;
    /* end points at '\n' or s->len */
    int32_t line_len = end - start;
    char *out = (char *)malloc((size_t)line_len + 1);
    memcpy(out, s->data + start, (size_t)line_len);
    /* Strip trailing '\r' for CRLF inputs */
    if (line_len > 0 && out[line_len - 1] == '\r') line_len--;
    out[line_len] = '\0';
    /* Advance past '\n' */
    s->rpos = end < s->len ? end + 1 : s->len;
    return out;
}

/*
 * Read all remaining bytes from rpos to the end of the stream.
 * Returns a heap-allocated, NUL-terminated string.
 * Returns "" if already at EOF.
 */
char *memstream_read_all(MemoryStream *s) {
    if (!s || s->freed || s->rpos >= s->len) return (char *)"";
    int32_t n   = s->len - s->rpos;
    char   *out = (char *)malloc((size_t)n + 1);
    memcpy(out, s->data + s->rpos, (size_t)n);
    out[n]   = '\0';
    s->rpos  = s->len;
    return out;
}

/* Total bytes written (write head position). */
int32_t memstream_length(MemoryStream *s) {
    if (!s || s->freed) return 0;
    return s->len;
}

/* Current read head position. */
int32_t memstream_position(MemoryStream *s) {
    if (!s || s->freed) return 0;
    return s->rpos;
}

/* Set the read head to `pos` (clamped to [0, len]). */
void memstream_seek(MemoryStream *s, int32_t pos) {
    if (!s || s->freed) return;
    if (pos < 0)     pos = 0;
    if (pos > s->len) pos = s->len;
    s->rpos = pos;
}

/* Reset read head to the beginning of the stream. */
void memstream_reset(MemoryStream *s) {
    if (!s || s->freed) return;
    s->rpos = 0;
}

/* Return a snapshot Buffer of all written bytes (a copy — independent of the stream). */
Buffer *memstream_to_buffer(MemoryStream *s) {
    if (!s || s->freed || s->len == 0) return buffer_new(0);
    return stream_make_buffer(s->data, s->len);
}

/*
 * Flush is a no-op for MemoryStream (all writes are immediately committed).
 * Provided so MemoryStream satisfies the Writable protocol.
 */
void memstream_flush(MemoryStream *s) {
    (void)s; /* nothing to do */
}

void memstream_free(MemoryStream *s) {
    if (!s) return;
    if (s->freed) {
        fprintf(stderr, "double-free: MemoryStream\n");
        abort();
    }
    s->freed = 1;
    free(s->data);
    s->data = NULL;
    free(s);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * StringReader
 *
 * A read-only cursor over a heap copy of a string.
 * Satisfies Readable and ByteReadable.
 * ═══════════════════════════════════════════════════════════════════════════ */

typedef struct {
    uint8_t  freed;
    char    *buf;   /* owned heap copy of the original string */
    int32_t  len;
    int32_t  pos;
} StringReader;

StringReader *string_reader_new(const char *str) {
    StringReader *r = (StringReader *)calloc(1, sizeof(StringReader));
    r->freed = 0;
    if (!str) str = "";
    int32_t n = (int32_t)strlen(str);
    r->buf = (char *)malloc((size_t)n + 1);
    memcpy(r->buf, str, (size_t)n + 1);
    r->len = n;
    r->pos = 0;
    return r;
}

/*
 * Read bytes from pos up to (but not including) the next '\n', or to the
 * end of the string.  Advances pos past the '\n'.
 * Returns "" at EOF.
 */
char *string_reader_read_line(StringReader *r) {
    if (!r || r->freed || r->pos >= r->len) return (char *)"";
    int32_t start = r->pos;
    int32_t end   = start;
    while (end < r->len && r->buf[end] != '\n') end++;
    int32_t line_len = end - start;
    char *out = (char *)malloc((size_t)line_len + 1);
    memcpy(out, r->buf + start, (size_t)line_len);
    if (line_len > 0 && out[line_len - 1] == '\r') line_len--;
    out[line_len] = '\0';
    r->pos = end < r->len ? end + 1 : r->len;
    return out;
}

/* Read all remaining bytes as a string. Returns "" at EOF. */
char *string_reader_read_all(StringReader *r) {
    if (!r || r->freed || r->pos >= r->len) return (char *)"";
    int32_t n   = r->len - r->pos;
    char   *out = (char *)malloc((size_t)n + 1);
    memcpy(out, r->buf + r->pos, (size_t)n);
    out[n]  = '\0';
    r->pos  = r->len;
    return out;
}

/* Read one byte. Returns the byte value (0–255) or -1 at EOF. */
int32_t string_reader_read_byte(StringReader *r) {
    if (!r || r->freed || r->pos >= r->len) return -1;
    return (int32_t)(uint8_t)(r->buf[r->pos++]);
}

/*
 * Read up to `n` bytes as a Buffer.
 * Returns an empty Buffer at EOF.
 */
Buffer *string_reader_read(StringReader *r, int32_t n) {
    if (!r || r->freed || n <= 0 || r->pos >= r->len)
        return buffer_new(0);
    int32_t avail = r->len - r->pos;
    int32_t take  = n < avail ? n : avail;
    Buffer *b = stream_make_buffer((const uint8_t *)(r->buf + r->pos), take);
    r->pos += take;
    return b;
}

/* Total byte length of the underlying string. */
int32_t string_reader_length(StringReader *r) {
    if (!r || r->freed) return 0;
    return r->len;
}

/* Current read position. */
int32_t string_reader_position(StringReader *r) {
    if (!r || r->freed) return 0;
    return r->pos;
}

/* Set the read position (clamped to [0, len]). */
void string_reader_seek(StringReader *r, int32_t pos) {
    if (!r || r->freed) return;
    if (pos < 0)     pos = 0;
    if (pos > r->len) pos = r->len;
    r->pos = pos;
}

/* Reset the read position to the beginning. */
void string_reader_reset(StringReader *r) {
    if (!r || r->freed) return;
    r->pos = 0;
}

void string_reader_free(StringReader *r) {
    if (!r) return;
    if (r->freed) {
        fprintf(stderr, "double-free: StringReader\n");
        abort();
    }
    r->freed = 1;
    free(r->buf);
    r->buf = NULL;
    free(r);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * File byte-level helpers
 *
 * Wraps fgetc / fputc / fread / fwrite for the File extensions defined in
 * stdlib/stream.code.  The FILE* is passed as a void* (C_VoidPtr in CodeLang).
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Read up to `n` bytes from an open FILE* and return them as a Buffer. */
Buffer *stream_file_read(void *fp, int32_t n) {
    if (!fp || n <= 0) return buffer_new(0);
    Buffer *b = buffer_new(n);
    int32_t got = (int32_t)fread(b->data, 1, (size_t)n, (FILE *)fp);
    b->len = got;
    return b;
}

/* Read one byte from an open FILE*.  Returns -1 on EOF. */
int32_t stream_file_read_byte(void *fp) {
    if (!fp) return -1;
    return fgetc((FILE *)fp);
}

/* Write all bytes of a Buffer to an open FILE*. */
void stream_file_write_bytes(void *fp, Buffer *buf) {
    if (!fp || !buf || buf->len == 0) return;
    fwrite(buf->data, 1, (size_t)buf->len, (FILE *)fp);
}

/* Write a single byte to an open FILE*. */
void stream_file_write_byte(void *fp, int32_t b) {
    if (!fp) return;
    fputc(b & 0xFF, (FILE *)fp);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * MemoryStream ↔ filesystem
 *
 * These helpers let a MemoryStream be serialised to / deserialised from a
 * regular file, bridging the stream API with persistent storage.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Create a MemoryStream pre-loaded with every byte of `path`.
 * The file is read in binary mode; the stream's read head starts at 0.
 * Returns an empty stream if the file cannot be opened.
 */
MemoryStream *memstream_from_file(const char *path) {
    MemoryStream *s = memstream_new();
    if (!path) return s;
    FILE *fp = fopen(path, "rb");
    if (!fp) return s;
    uint8_t chunk[4096];
    size_t n;
    while ((n = fread(chunk, 1, sizeof(chunk), fp)) > 0) {
        ms_ensure(s, (int32_t)n);
        memcpy(s->data + s->len, chunk, n);
        s->len += (int32_t)n;
    }
    fclose(fp);
    s->rpos = 0;
    return s;
}

/**
 * Write all buffered bytes to `path`, creating or truncating the file.
 * Returns 1 on success, 0 on failure.
 */
int32_t memstream_to_file(MemoryStream *s, const char *path) {
    if (!s || s->freed || !path) return 0;
    FILE *fp = fopen(path, "wb");
    if (!fp) return 0;
    if (s->len > 0) fwrite(s->data, 1, (size_t)s->len, fp);
    fclose(fp);
    return 1;
}

/**
 * Append all buffered bytes to `path`.  Creates the file if it does not exist.
 * Returns 1 on success, 0 on failure.
 */
int32_t memstream_append_to_file(MemoryStream *s, const char *path) {
    if (!s || s->freed || !path) return 0;
    FILE *fp = fopen(path, "ab");
    if (!fp) return 0;
    if (s->len > 0) fwrite(s->data, 1, (size_t)s->len, fp);
    fclose(fp);
    return 1;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Stdout / Stdin byte-level helpers
 *
 * Expose byte-granular I/O on the two standard streams so that Stdout and
 * Stdin can satisfy ByteWritable / ByteReadable in stdlib/stream.code.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Write a single byte (0–255) to stdout. */
void stdout_write_byte(int32_t b) {
    fputc(b & 0xFF, stdout);
}

/** Write all bytes of a Buffer to stdout. */
void stdout_write_bytes(Buffer *buf) {
    if (!buf || buf->len == 0) return;
    fwrite(buf->data, 1, (size_t)buf->len, stdout);
}

/** Read one byte from stdin.  Returns -1 on EOF. */
int32_t stdin_read_byte(void) {
    return fgetc(stdin);
}

/** Read up to `n` bytes from stdin and return them as a Buffer. */
Buffer *stdin_read(int32_t n) {
    if (n <= 0) return buffer_new(0);
    Buffer *b = buffer_new(n);
    int32_t got = 0;
    int c;
    while (got < n && (c = fgetc(stdin)) != EOF) {
        buffer_set(b, got++, (uint8_t)c);
    }
    b->len = got;
    return b;
}
