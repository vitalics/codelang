/**
 * CodeLang HTTP/3 / QUIC runtime — compile-safe stubs.
 *
 * A full implementation requires a QUIC library such as quiche (-lquiche)
 * or msquic (Windows).
 * These stubs allow the CodeLang compiler to link binaries that import
 * stdlib/network/http3 without crashing at build time.
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
} Http3Client;

typedef struct {
    int32_t  status;
    char    *body;
} Http3Response;

/* ── Internal helper ─────────────────────────────────────────────────────── */

static Http3Response *http3_empty_response(void) {
    Http3Response *r = (Http3Response *)malloc(sizeof(Http3Response));
    r->status = 0;
    r->body   = strdup("");
    return r;
}

/* ── Http3Client stubs ───────────────────────────────────────────────────── */

Http3Client *http3_client_connect(const char *host, int32_t port) {
    (void)host; (void)port;
    Http3Client *c = (Http3Client *)malloc(sizeof(Http3Client));
    c->dummy = 0;
    return c;
}

Http3Response *http3_client_get(Http3Client *client, const char *path) {
    (void)client; (void)path;
    return http3_empty_response();
}

Http3Response *http3_client_post(Http3Client *client, const char *path,
                                  const char *body) {
    (void)client; (void)path; (void)body;
    return http3_empty_response();
}

void http3_client_close(Http3Client *client) {
    if (client) free(client);
}

/* ── Http3Response stubs ─────────────────────────────────────────────────── */

int32_t http3_response_status(Http3Response *resp) {
    return resp ? resp->status : 0;
}

const char *http3_response_body(Http3Response *resp) {
    return (resp && resp->body) ? strdup(resp->body) : strdup("");
}

const char *http3_response_header(Http3Response *resp, const char *name) {
    (void)resp; (void)name;
    return strdup("");
}

void http3_response_free(Http3Response *resp) {
    if (!resp) return;
    if (resp->body) free(resp->body);
    free(resp);
}
