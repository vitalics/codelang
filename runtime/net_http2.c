/**
 * CodeLang HTTP/2 runtime — compile-safe stubs.
 *
 * A full implementation requires nghttp2 (-lnghttp2).
 * These stubs allow the CodeLang compiler to link binaries that import
 * stdlib/network/http2 without crashing at build time.
 * All functions return safe zero/NULL/"" values.
 *
 * Compile: clang -O2   (no extra libraries required for stubs)
 */

#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── Structures ──────────────────────────────────────────────────────────── */

typedef struct {
    int dummy;
} Http2Client;

typedef struct {
    int32_t  status;
    char    *body;
} Http2Response;

/* ── Internal helper ─────────────────────────────────────────────────────── */

static Http2Response *http2_empty_response(void) {
    Http2Response *r = (Http2Response *)malloc(sizeof(Http2Response));
    r->status = 0;
    r->body   = strdup("");
    return r;
}

/* ── Http2Client stubs ───────────────────────────────────────────────────── */

Http2Client *http2_client_connect(const char *host, int32_t port) {
    (void)host; (void)port;
    Http2Client *c = (Http2Client *)malloc(sizeof(Http2Client));
    c->dummy = 0;
    return c;
}

Http2Response *http2_client_get(Http2Client *client, const char *path,
                                 const char *headers) {
    (void)client; (void)path; (void)headers;
    return http2_empty_response();
}

Http2Response *http2_client_post(Http2Client *client, const char *path,
                                  const char *headers, const char *body) {
    (void)client; (void)path; (void)headers; (void)body;
    return http2_empty_response();
}

void http2_client_close(Http2Client *client) {
    if (client) free(client);
}

/* ── Http2Response stubs ─────────────────────────────────────────────────── */

int32_t http2_response_status(Http2Response *resp) {
    return resp ? resp->status : 0;
}

const char *http2_response_body(Http2Response *resp) {
    return (resp && resp->body) ? strdup(resp->body) : strdup("");
}

const char *http2_response_header(Http2Response *resp, const char *name) {
    (void)resp; (void)name;
    return strdup("");
}

void http2_response_free(Http2Response *resp) {
    if (!resp) return;
    if (resp->body) free(resp->body);
    free(resp);
}
