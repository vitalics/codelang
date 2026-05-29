/**
 * CodeLang HTTP/1.1 runtime — plain TCP, no TLS.
 *
 * Provides:
 *   HttpHeaders  — linked list of name/value string pairs.
 *   HttpRequest  — method + URL + headers + body.
 *   HttpResponse — status code + body + response headers.
 *   HttpClient   — sends HTTP/1.1 requests over raw TCP sockets.
 *
 * HTTPS (port 443 / https://) is not supported; the client returns a
 * response with status 0 and body "https not supported" for such URLs.
 *
 * URL parsing supports:
 *   http://host/path
 *   http://host:port/path
 *   http://host   (path defaults to "/")
 *
 * All returned strings are strdup()'d heap allocations.
 *
 * Compile: clang -O2
 */

#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <ctype.h>
#include <errno.h>

/* ── Structures ──────────────────────────────────────────────────────────── */

typedef struct HttpHeaderNode {
    char                 *name;
    char                 *value;
    struct HttpHeaderNode *next;
} HttpHeaderNode;

typedef struct {
    HttpHeaderNode *head;
} HttpHeaders;

typedef struct {
    char        *method;
    char        *url;
    HttpHeaders *headers;
    char        *body;
} HttpRequest;

typedef struct {
    int32_t      status;
    char        *body;
    HttpHeaders *headers;
} HttpResponse;

typedef struct {
    int32_t timeout_ms;   /* connect+read timeout, 0 = no timeout */
} HttpClient;

/* ── HttpHeaders ─────────────────────────────────────────────────────────── */

HttpHeaders *http_headers_new(void) {
    HttpHeaders *h = (HttpHeaders *)malloc(sizeof(HttpHeaders));
    h->head = NULL;
    return h;
}

void http_headers_set(HttpHeaders *h, const char *name, const char *value) {
    if (!h || !name) return;
    /* Overwrite existing entry if present */
    for (HttpHeaderNode *n = h->head; n != NULL; n = n->next) {
        if (strcasecmp(n->name, name) == 0) {
            free(n->value);
            n->value = strdup(value ? value : "");
            return;
        }
    }
    HttpHeaderNode *node = (HttpHeaderNode *)malloc(sizeof(HttpHeaderNode));
    node->name  = strdup(name);
    node->value = strdup(value ? value : "");
    node->next  = h->head;
    h->head     = node;
}

const char *http_headers_get(HttpHeaders *h, const char *name) {
    if (!h || !name) return strdup("");
    for (HttpHeaderNode *n = h->head; n != NULL; n = n->next) {
        if (strcasecmp(n->name, name) == 0) return strdup(n->value);
    }
    return strdup("");
}

static void http_headers_free_impl(HttpHeaders *h) {
    if (!h) return;
    HttpHeaderNode *cur = h->head;
    while (cur) {
        HttpHeaderNode *next = cur->next;
        free(cur->name);
        free(cur->value);
        free(cur);
        cur = next;
    }
    free(h);
}

void http_headers_free(HttpHeaders *h) {
    http_headers_free_impl(h);
}

/* ── HttpRequest ─────────────────────────────────────────────────────────── */

HttpRequest *http_request_new(const char *method, const char *url) {
    HttpRequest *r = (HttpRequest *)malloc(sizeof(HttpRequest));
    r->method  = strdup(method ? method : "GET");
    r->url     = strdup(url    ? url    : "");
    r->headers = http_headers_new();
    r->body    = strdup("");
    return r;
}

HttpRequest *http_request_set_header(HttpRequest *req, const char *name, const char *value) {
    if (req) http_headers_set(req->headers, name, value);
    return req;
}

HttpRequest *http_request_set_body(HttpRequest *req, const char *body) {
    if (req) {
        free(req->body);
        req->body = strdup(body ? body : "");
    }
    return req;
}

void http_request_free(HttpRequest *req) {
    if (!req) return;
    free(req->method);
    free(req->url);
    http_headers_free_impl(req->headers);
    free(req->body);
    free(req);
}

/* ── HttpResponse ────────────────────────────────────────────────────────── */

static HttpResponse *http_response_new_empty(void) {
    HttpResponse *r = (HttpResponse *)malloc(sizeof(HttpResponse));
    r->status  = 0;
    r->body    = strdup("");
    r->headers = http_headers_new();
    return r;
}

int32_t http_response_status(HttpResponse *resp) {
    return resp ? resp->status : 0;
}

const char *http_response_body(HttpResponse *resp) {
    return (resp && resp->body) ? strdup(resp->body) : strdup("");
}

const char *http_response_header(HttpResponse *resp, const char *name) {
    if (!resp) return strdup("");
    return http_headers_get(resp->headers, name);
}

void http_response_free(HttpResponse *resp) {
    if (!resp) return;
    free(resp->body);
    http_headers_free_impl(resp->headers);
    free(resp);
}

/* ── URL parsing ─────────────────────────────────────────────────────────── */

typedef struct {
    int   is_https;
    char  host[256];
    char  port_str[16];
    char  path[4096];
} ParsedURL;

static int parse_url(const char *url, ParsedURL *out) {
    memset(out, 0, sizeof(*out));
    out->is_https = 0;

    const char *p = url;
    if (strncasecmp(p, "https://", 8) == 0) {
        out->is_https = 1;
        p += 8;
        strncpy(out->port_str, "443", sizeof(out->port_str) - 1);
    } else if (strncasecmp(p, "http://", 7) == 0) {
        p += 7;
        strncpy(out->port_str, "80", sizeof(out->port_str) - 1);
    } else {
        return -1;
    }

    /* Extract host (and optional :port), up to '/' or end */
    const char *slash = strchr(p, '/');
    size_t host_part_len = slash ? (size_t)(slash - p) : strlen(p);
    char host_part[512];
    if (host_part_len >= sizeof(host_part)) return -1;
    memcpy(host_part, p, host_part_len);
    host_part[host_part_len] = '\0';

    /* Check for port in host:port */
    char *colon = strrchr(host_part, ':');
    if (colon) {
        *colon = '\0';
        strncpy(out->port_str, colon + 1, sizeof(out->port_str) - 1);
    }
    strncpy(out->host, host_part, sizeof(out->host) - 1);

    /* Extract path */
    if (slash) {
        strncpy(out->path, slash, sizeof(out->path) - 1);
    } else {
        strncpy(out->path, "/", sizeof(out->path) - 1);
    }
    return 0;
}

/* ── TCP connect helper ──────────────────────────────────────────────────── */

static int tcp_connect(const char *host, const char *port_str) {
    struct addrinfo hints, *res, *rp;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, port_str, &hints, &res) != 0) return -1;

    int fd = -1;
    for (rp = res; rp != NULL; rp = rp->ai_next) {
        fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

/* ── Raw HTTP/1.1 send ───────────────────────────────────────────────────── */

static HttpResponse *do_http(const char *method, const char *url,
                              HttpHeaders *extra_headers, const char *body) {
    HttpResponse *resp = http_response_new_empty();

    ParsedURL pu;
    if (parse_url(url, &pu) < 0) {
        free(resp->body);
        resp->body   = strdup("invalid url");
        resp->status = 0;
        return resp;
    }
    if (pu.is_https) {
        free(resp->body);
        resp->body   = strdup("https not supported");
        resp->status = 0;
        return resp;
    }

    int fd = tcp_connect(pu.host, pu.port_str);
    if (fd < 0) {
        free(resp->body);
        resp->body   = strdup("connection failed");
        resp->status = 0;
        return resp;
    }

    /* Build request */
    char req_buf[65536];
    int  req_len = 0;
    size_t body_len = body ? strlen(body) : 0;

    req_len += snprintf(req_buf + req_len, sizeof(req_buf) - (size_t)req_len,
                        "%s %s HTTP/1.1\r\n"
                        "Host: %s\r\n"
                        "Connection: close\r\n",
                        method, pu.path, pu.host);

    /* Extra headers */
    if (extra_headers) {
        for (HttpHeaderNode *n = extra_headers->head; n != NULL; n = n->next) {
            req_len += snprintf(req_buf + req_len, sizeof(req_buf) - (size_t)req_len,
                                "%s: %s\r\n", n->name, n->value);
        }
    }

    if (body_len > 0) {
        req_len += snprintf(req_buf + req_len, sizeof(req_buf) - (size_t)req_len,
                            "Content-Length: %zu\r\n", body_len);
    }
    req_len += snprintf(req_buf + req_len, sizeof(req_buf) - (size_t)req_len, "\r\n");

    /* Write request line + headers */
    size_t written = 0;
    while (written < (size_t)req_len) {
        ssize_t n = send(fd, req_buf + written, (size_t)req_len - written, 0);
        if (n <= 0) { close(fd); return resp; }
        written += (size_t)n;
    }
    /* Write body */
    if (body && body_len > 0) {
        written = 0;
        while (written < body_len) {
            ssize_t n = send(fd, body + written, body_len - written, 0);
            if (n <= 0) break;
            written += (size_t)n;
        }
    }

    /* Read response into a dynamic buffer */
    size_t  rbuf_cap  = 65536;
    size_t  rbuf_len  = 0;
    char   *rbuf      = (char *)malloc(rbuf_cap);

    for (;;) {
        if (rbuf_len + 4096 > rbuf_cap) {
            rbuf_cap *= 2;
            rbuf = (char *)realloc(rbuf, rbuf_cap);
        }
        ssize_t n = recv(fd, rbuf + rbuf_len, 4096, 0);
        if (n <= 0) break;
        rbuf_len += (size_t)n;
    }
    close(fd);
    rbuf[rbuf_len] = '\0';

    /* Parse status line: "HTTP/1.x NNN ..." */
    char *nl = strstr(rbuf, "\r\n");
    if (nl) {
        int status = 0;
        sscanf(rbuf, "HTTP/%*s %d", &status);
        resp->status = (int32_t)status;
    }

    /* Parse headers until blank line */
    char *header_start = strstr(rbuf, "\r\n");
    char *body_start   = strstr(rbuf, "\r\n\r\n");
    if (header_start && body_start) {
        header_start += 2; /* skip first \r\n */
        char *cur = header_start;
        while (cur < body_start + 2) {
            char *end = strstr(cur, "\r\n");
            /* body_start points to the \r\n that ends the last header line
             * (= first \r of the \r\n\r\n terminator).  Using > (not >=) ensures
             * the last header line is parsed before we exit the loop. */
            if (!end || end > body_start) break;
            /* Parse "Name: Value" */
            char *colon = memchr(cur, ':', (size_t)(end - cur));
            if (colon) {
                size_t nlen = (size_t)(colon - cur);
                char  *hname = (char *)malloc(nlen + 1);
                memcpy(hname, cur, nlen);
                hname[nlen] = '\0';
                const char *hval = colon + 1;
                while (*hval == ' ') hval++;
                size_t vlen = (size_t)(end - hval);
                char  *hvalue = (char *)malloc(vlen + 1);
                memcpy(hvalue, hval, vlen);
                hvalue[vlen] = '\0';
                http_headers_set(resp->headers, hname, hvalue);
                free(hname);
                free(hvalue);
            }
            cur = end + 2;
        }

        /* Body */
        char *b = body_start + 4;
        free(resp->body);
        resp->body = strdup(b);
    } else if (rbuf_len > 0) {
        free(resp->body);
        resp->body = strdup(rbuf);
    }

    free(rbuf);
    return resp;
}

/* ── HttpClient ──────────────────────────────────────────────────────────── */

HttpClient *http_client_new(void) {
    HttpClient *c = (HttpClient *)malloc(sizeof(HttpClient));
    c->timeout_ms = 30000;
    return c;
}

HttpResponse *http_client_get(HttpClient *client, const char *url) {
    (void)client;
    return do_http("GET", url, NULL, NULL);
}

HttpResponse *http_client_post(HttpClient *client, const char *url, const char *body) {
    (void)client;
    HttpHeaders *h = http_headers_new();
    if (body && strlen(body) > 0)
        http_headers_set(h, "Content-Type", "application/octet-stream");
    HttpResponse *r = do_http("POST", url, h, body);
    http_headers_free_impl(h);
    return r;
}

HttpResponse *http_client_send(HttpClient *client, HttpRequest *req) {
    (void)client;
    if (!req) return http_response_new_empty();
    return do_http(req->method, req->url, req->headers, req->body);
}

void http_client_set_timeout(HttpClient *client, int32_t ms) {
    if (client) client->timeout_ms = ms;
}

void http_client_free(HttpClient *client) {
    if (client) free(client);
}
