/**
 * CodeLang HTTP/1.1 server runtime  (runtime/net_server.c)
 *
 * Express/Elysia-style minimal HTTP server for CodeLang.
 *
 * Provides:
 *   KVNode        — key-value linked list (params, query, headers)
 *   ServerRequest — parsed incoming HTTP/1.1 request
 *   ServerResponse— response built by route handlers
 *   HttpServer    — socket listener + route dispatch
 *
 * Fat-pointer ABI (matches runtime/async.c):
 *   CodeLang closures are { fn_ptr, env_ptr } — passed in two registers.
 *   Handler signature: void* (*fn)(void *env, void *req)
 *
 * Route pattern matching:
 *   Segment-by-segment; `:param` captures populate req->params.
 *   e.g. "/user/:id/posts" matches "/user/42/posts" → params["id"]="42"
 *
 * Query string:
 *   Parsed from the raw URL after '?'.  Percent-decoded values.
 *
 * Compile: clang -O2 -lpthread
 */

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <errno.h>
#include <pthread.h>
#include <poll.h>
#include <fcntl.h>
#include <ctype.h>

/* ── Fat-pointer ABI ─────────────────────────────────────────────────────── */

/*
 * A CodeLang handler fn(req: ServerRequest): ServerResponse is represented
 * as a two-field struct.  The fn field takes (env, req_ptr) and returns a
 * heap-allocated ServerResponse*.
 */
/* CodeLang lambda ABI: fn(explicit_arg, env) — the first parameter is the
 * explicit argument (ServerRequest*), the second is the closure environment.
 * This matches the IR signature: @__lambda_N(i8* %arg.0, i8* %_env) */
typedef struct {
    void *(*fn)(void *req, void *env);
    void  *env;
} HandlerFatPtr;

/* ── KVNode ──────────────────────────────────────────────────────────────── */

typedef struct KVNode {
    char          *key;
    char          *value;
    struct KVNode *next;
} KVNode;

/*
 * Upsert key→value in the list rooted at *head.
 * Returns the (possibly new) head pointer.
 */
static KVNode *kv_set(KVNode *head, const char *key, const char *value) {
    if (!key) return head;
    /* Overwrite existing entry */
    for (KVNode *n = head; n != NULL; n = n->next) {
        if (strcmp(n->key, key) == 0) {
            free(n->value);
            n->value = strdup(value ? value : "");
            return head;
        }
    }
    /* Prepend new node */
    KVNode *node = (KVNode *)malloc(sizeof(KVNode));
    node->key    = strdup(key);
    node->value  = strdup(value ? value : "");
    node->next   = head;
    return node;
}

/*
 * Look up a key in the list.
 * Returns a strdup'd copy of the value, or strdup("") if not found.
 * Caller owns the returned string.
 */
static const char *kv_get(const KVNode *head, const char *key) {
    if (!key) return strdup("");
    for (const KVNode *n = head; n != NULL; n = n->next) {
        if (strcmp(n->key, key) == 0) return strdup(n->value);
    }
    return strdup("");
}

/* Free all nodes in the list. */
static void kv_free(KVNode *head) {
    KVNode *cur = head;
    while (cur) {
        KVNode *next = cur->next;
        free(cur->key);
        free(cur->value);
        free(cur);
        cur = next;
    }
}

/* ── ServerRequest ───────────────────────────────────────────────────────── */

typedef struct {
    char   *method;   /* "GET", "POST", etc.                      */
    char   *path;     /* URL path without query, e.g. "/user/42"  */
    char   *body;     /* raw request body                         */
    KVNode *params;   /* :param captures from route pattern       */
    KVNode *query;    /* ?key=value pairs (percent-decoded)       */
    KVNode *headers;  /* request headers (lowercase names)        */
} ServerRequest;

ServerRequest *sr_new(const char *method, const char *path, const char *body) {
    ServerRequest *r = (ServerRequest *)malloc(sizeof(ServerRequest));
    r->method  = strdup(method ? method : "GET");
    r->path    = strdup(path   ? path   : "/");
    r->body    = strdup(body   ? body   : "");
    r->params  = NULL;
    r->query   = NULL;
    r->headers = NULL;
    return r;
}

const char *sr_method(ServerRequest *r)  { return (r && r->method) ? strdup(r->method) : strdup(""); }
const char *sr_path(ServerRequest *r)    { return (r && r->path)   ? strdup(r->path)   : strdup(""); }
const char *sr_body(ServerRequest *r)    { return (r && r->body)   ? strdup(r->body)   : strdup(""); }

const char *sr_param(ServerRequest *r, const char *key)  { return r ? kv_get(r->params,  key) : strdup(""); }
const char *sr_query(ServerRequest *r, const char *key)  { return r ? kv_get(r->query,   key) : strdup(""); }
const char *sr_header(ServerRequest *r, const char *key) { return r ? kv_get(r->headers, key) : strdup(""); }

void sr_set_param(ServerRequest *r, const char *key, const char *value) {
    if (r) r->params = kv_set(r->params, key, value);
}

void sr_free(ServerRequest *r) {
    if (!r) return;
    free(r->method);
    free(r->path);
    free(r->body);
    kv_free(r->params);
    kv_free(r->query);
    kv_free(r->headers);
    free(r);
}

/* ── ServerResponse ──────────────────────────────────────────────────────── */

typedef struct {
    int32_t  status;
    char    *body;
    KVNode  *headers;
} ServerResponse;

ServerResponse *resp_new(void) {
    ServerResponse *r = (ServerResponse *)malloc(sizeof(ServerResponse));
    r->status  = 200;
    r->body    = strdup("");
    r->headers = NULL;
    return r;
}

ServerResponse *resp_ok(const char *body) {
    ServerResponse *r = resp_new();
    free(r->body);
    r->body = strdup(body ? body : "");
    return r;
}

ServerResponse *resp_json(const char *body) {
    ServerResponse *r = resp_ok(body);
    r->headers = kv_set(r->headers, "Content-Type", "application/json");
    return r;
}

ServerResponse *resp_error(int32_t code, const char *body) {
    ServerResponse *r = resp_new();
    r->status = code;
    free(r->body);
    r->body = strdup(body ? body : "");
    return r;
}

ServerResponse *resp_set_status(ServerResponse *r, int32_t code) {
    if (r) r->status = code;
    return r;
}

ServerResponse *resp_set_header(ServerResponse *r, const char *key, const char *value) {
    if (r) r->headers = kv_set(r->headers, key, value);
    return r;
}

ServerResponse *resp_set_body(ServerResponse *r, const char *body) {
    if (r) {
        free(r->body);
        r->body = strdup(body ? body : "");
    }
    return r;
}

int32_t     resp_status(ServerResponse *r)               { return r ? r->status : 500; }
const char *resp_body(ServerResponse *r)                 { return (r && r->body) ? strdup(r->body) : strdup(""); }
const char *resp_header(ServerResponse *r, const char *key) { return r ? kv_get(r->headers, key) : strdup(""); }

void resp_free(ServerResponse *r) {
    if (!r) return;
    free(r->body);
    kv_free(r->headers);
    free(r);
}

/* ── Route + HttpServer ──────────────────────────────────────────────────── */

#define MAX_ROUTES 64

typedef struct {
    char          method[16];
    char          pattern[256];
    HandlerFatPtr handler;
} Route;

typedef struct {
    Route        routes[MAX_ROUTES];
    int          route_count;
    int          server_fd;    /* listening socket fd; -1 = not bound */
    volatile int stop_flag;
    pthread_t    thread;
    int          threaded;     /* 1 if server_listen_async was called */
    int32_t      port;         /* bound port (informational)          */
} HttpServer;

HttpServer *server_new(void) {
    HttpServer *s = (HttpServer *)calloc(1, sizeof(HttpServer));
    s->server_fd   = -1;
    s->route_count = 0;
    s->stop_flag   = 0;
    s->threaded    = 0;
    s->port        = 0;
    return s;
}

void server_add_route(HttpServer *s, const char *method, const char *pattern,
                      HandlerFatPtr handler) {
    if (!s || s->route_count >= MAX_ROUTES) return;
    Route *r = &s->routes[s->route_count++];
    strncpy(r->method,  method  ? method  : "GET",  sizeof(r->method)  - 1);
    strncpy(r->pattern, pattern ? pattern : "/",    sizeof(r->pattern) - 1);
    r->method[sizeof(r->method) - 1]   = '\0';
    r->pattern[sizeof(r->pattern) - 1] = '\0';
    r->handler = handler;
}

/* ── URL percent-decoding ────────────────────────────────────────────────── */

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/*
 * Decode a percent-encoded string into a newly allocated buffer.
 * '+' is decoded as ' ' (application/x-www-form-urlencoded).
 * Caller must free() the result.
 */
static char *url_decode(const char *src, size_t len) {
    char *out = (char *)malloc(len + 1);
    size_t oi = 0;
    for (size_t i = 0; i < len; ) {
        if (src[i] == '%' && i + 2 < len) {
            int hi = hex_val(src[i + 1]);
            int lo = hex_val(src[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out[oi++] = (char)((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if (src[i] == '+') {
            out[oi++] = ' ';
            i++;
            continue;
        }
        out[oi++] = src[i++];
    }
    out[oi] = '\0';
    return out;
}

/* ── Query string parser ─────────────────────────────────────────────────── */

/*
 * Parse "key=value&key2=value2" from `qs` (must NOT include the leading '?').
 * Populates req->query.
 */
static void parse_query(ServerRequest *req, const char *qs) {
    if (!qs || !*qs) return;
    const char *p = qs;
    while (*p) {
        /* Find '=' */
        const char *eq = strchr(p, '=');
        if (!eq) break;
        size_t klen = (size_t)(eq - p);
        char  *key  = url_decode(p, klen);

        p = eq + 1;
        /* Find '&' or end */
        const char *amp = strchr(p, '&');
        size_t vlen = amp ? (size_t)(amp - p) : strlen(p);
        char  *val  = url_decode(p, vlen);

        req->query = kv_set(req->query, key, val);
        free(key);
        free(val);

        p = amp ? amp + 1 : p + vlen;
    }
}

/* ── Route pattern matching ──────────────────────────────────────────────── */

/*
 * Compare `pattern` against `path` segment by segment.
 * Segments starting with ':' capture the matching path segment into req->params.
 * Returns 1 on match, 0 on mismatch.
 */
static int route_match(const char *pattern, const char *path, ServerRequest *req) {
    /* Work on mutable copies */
    char *pat_buf  = strdup(pattern);
    char *path_buf = strdup(path);

    /* Tokenise both by '/' */
    char *pat_segs[128],  *path_segs[128];
    int   pat_cnt = 0,     path_cnt = 0;

    char *tok, *save;

    tok = strtok_r(pat_buf, "/", &save);
    while (tok && pat_cnt < 127) { pat_segs[pat_cnt++] = tok; tok = strtok_r(NULL, "/", &save); }

    tok = strtok_r(path_buf, "/", &save);
    while (tok && path_cnt < 127) { path_segs[path_cnt++] = tok; tok = strtok_r(NULL, "/", &save); }

    int matched = 1;
    if (pat_cnt != path_cnt) {
        matched = 0;
        goto done;
    }
    for (int i = 0; i < pat_cnt; i++) {
        if (pat_segs[i][0] == ':') {
            /* Capture param */
            sr_set_param(req, pat_segs[i] + 1, path_segs[i]);
        } else if (strcmp(pat_segs[i], path_segs[i]) != 0) {
            matched = 0;
            goto done;
        }
    }

done:
    free(pat_buf);
    free(path_buf);
    return matched;
}

/* ── HTTP status reason phrase ───────────────────────────────────────────── */

static const char *status_reason(int32_t code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 202: return "Accepted";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 410: return "Gone";
        case 422: return "Unprocessable Entity";
        case 429: return "Too Many Requests";
        case 500: return "Internal Server Error";
        case 501: return "Not Implemented";
        case 502: return "Bad Gateway";
        case 503: return "Service Unavailable";
        default:  return "Unknown";
    }
}

/* ── send_response ───────────────────────────────────────────────────────── */

/*
 * Serialise `resp` as HTTP/1.1 and write it to the client socket `fd`.
 * Always includes Content-Length and Connection: close.
 */
static void send_response(int fd, ServerResponse *resp) {
    if (!resp) return;

    const char *body    = resp->body ? resp->body : "";
    size_t      bodylen = strlen(body);
    const char *reason  = status_reason(resp->status);

    /* Build status line + mandatory headers */
    char hdr[4096];
    int  hlen = snprintf(hdr, sizeof(hdr),
                         "HTTP/1.1 %d %s\r\n"
                         "Content-Length: %zu\r\n"
                         "Connection: close\r\n",
                         (int)resp->status, reason, bodylen);

    /* Append custom headers */
    for (KVNode *n = resp->headers; n != NULL; n = n->next) {
        int written = snprintf(hdr + hlen, sizeof(hdr) - (size_t)hlen,
                               "%s: %s\r\n", n->key, n->value);
        if (written > 0) hlen += written;
        if ((size_t)hlen >= sizeof(hdr) - 4) break; /* guard overflow */
    }

    /* Blank line */
    hlen += snprintf(hdr + hlen, sizeof(hdr) - (size_t)hlen, "\r\n");

    /* Write headers */
    size_t sent = 0;
    while (sent < (size_t)hlen) {
        ssize_t n = send(fd, hdr + sent, (size_t)hlen - sent, 0);
        if (n <= 0) return;
        sent += (size_t)n;
    }

    /* Write body */
    if (bodylen > 0) {
        sent = 0;
        while (sent < bodylen) {
            ssize_t n = send(fd, body + sent, bodylen - sent, 0);
            if (n <= 0) return;
            sent += (size_t)n;
        }
    }
}

/* ── parse_request ───────────────────────────────────────────────────────── */

/*
 * Read and parse an HTTP/1.1 request from client socket `fd`.
 * Returns a heap-allocated ServerRequest on success, NULL on error.
 */
static ServerRequest *parse_request(int fd) {
    /* --- Step 1: read until \r\n\r\n (end of headers) --- */
    size_t  cap = 8192;
    size_t  len = 0;
    char   *buf = (char *)malloc(cap);

    for (;;) {
        if (len + 1 >= cap) {
            cap *= 2;
            buf  = (char *)realloc(buf, cap);
        }
        ssize_t n = recv(fd, buf + len, 1, 0);
        if (n <= 0) { free(buf); return NULL; }
        len++;
        buf[len] = '\0';
        if (len >= 4 && memcmp(buf + len - 4, "\r\n\r\n", 4) == 0) break;
        /* Safety limit: max 64 KiB headers */
        if (len > 65536) { free(buf); return NULL; }
    }

    /* --- Step 2: parse request line --- */
    char *nl = strstr(buf, "\r\n");
    if (!nl) { free(buf); return NULL; }

    char method_raw[16]  = {0};
    char raw_url[4096]   = {0};
    char proto[16]       = {0};

    /* Parse "METHOD raw_url HTTP/x.y" */
    if (sscanf(buf, "%15s %4095s %15s", method_raw, raw_url, proto) < 2) {
        free(buf);
        return NULL;
    }

    /* Split raw_url into path + query */
    char path_part[4096] = {0};
    char qs_part[4096]   = {0};
    char *qmark = strchr(raw_url, '?');
    if (qmark) {
        size_t plen = (size_t)(qmark - raw_url);
        if (plen >= sizeof(path_part)) plen = sizeof(path_part) - 1;
        memcpy(path_part, raw_url, plen);
        path_part[plen] = '\0';
        strncpy(qs_part, qmark + 1, sizeof(qs_part) - 1);
    } else {
        strncpy(path_part, raw_url, sizeof(path_part) - 1);
    }

    ServerRequest *req = sr_new(method_raw, path_part, "");

    /* --- Step 3: parse headers --- */
    char *header_cur   = nl + 2;           /* skip first \r\n */
    char *header_end   = strstr(header_cur, "\r\n\r\n");
    long  content_len  = 0;

    while (header_cur && header_cur < (header_end ? header_end + 2 : buf + len)) {
        char *line_end = strstr(header_cur, "\r\n");
        /* header_end points to the \r\n that ends the last header line (= first
         * \r of the \r\n\r\n terminator).  Using > (not >=) ensures the last
         * header is still parsed before we exit the loop. */
        if (!line_end || line_end > header_end) break;

        /* Parse "Name: Value" */
        char *colon = memchr(header_cur, ':', (size_t)(line_end - header_cur));
        if (colon) {
            size_t nlen = (size_t)(colon - header_cur);
            char  *hname = (char *)malloc(nlen + 1);
            memcpy(hname, header_cur, nlen);
            hname[nlen] = '\0';
            /* Lowercase the name */
            for (size_t i = 0; i < nlen; i++) hname[i] = (char)tolower((unsigned char)hname[i]);

            const char *hval = colon + 1;
            while (*hval == ' ') hval++;
            size_t vlen   = (size_t)(line_end - hval);
            char  *hvalue = (char *)malloc(vlen + 1);
            memcpy(hvalue, hval, vlen);
            hvalue[vlen] = '\0';

            req->headers = kv_set(req->headers, hname, hvalue);

            /* Track Content-Length for body read */
            if (strcasecmp(hname, "content-length") == 0) {
                content_len = atol(hvalue);
            }
            free(hname);
            free(hvalue);
        }
        header_cur = line_end + 2;
    }

    /* --- Step 4: read body --- */
    if (content_len > 0) {
        if (content_len > 16 * 1024 * 1024) content_len = 16 * 1024 * 1024; /* 16 MB cap */
        char   *body_buf = (char *)malloc((size_t)content_len + 1);
        size_t  got      = 0;
        while ((long)got < content_len) {
            ssize_t n = recv(fd, body_buf + got, (size_t)(content_len - (long)got), 0);
            if (n <= 0) break;
            got += (size_t)n;
        }
        body_buf[got] = '\0';
        free(req->body);
        req->body = body_buf;
    }

    free(buf);

    /* --- Step 5: parse query string --- */
    parse_query(req, qs_part);

    return req;
}

/* ── server_listen_impl ──────────────────────────────────────────────────── */

/*
 * Internal data passed to the server thread when using listen_async.
 */
typedef struct {
    HttpServer *server;
    int32_t     port;
} ListenArg;

static void *server_listen_impl(void *arg) {
    ListenArg  *la = (ListenArg *)arg;
    HttpServer *s  = la->server;
    int32_t     port = la->port;
    free(la);

    /* --- 1. Create socket --- */
    int sfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sfd < 0) {
        perror("net_server: socket");
        return NULL;
    }

    int yes = 1;
    setsockopt(sfd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    /* --- 2. Bind to 0.0.0.0:port --- */
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons((uint16_t)port);

    if (bind(sfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("net_server: bind");
        close(sfd);
        return NULL;
    }

    /* --- 3. Listen --- */
    if (listen(sfd, 128) < 0) {
        perror("net_server: listen");
        close(sfd);
        return NULL;
    }

    /* --- 4. Make the listening socket non-blocking --- */
    int flags = fcntl(sfd, F_GETFL, 0);
    if (flags >= 0) fcntl(sfd, F_SETFL, flags | O_NONBLOCK);

    s->server_fd = sfd;
    s->port      = port;

    /* --- 5. Accept loop --- */
    while (!s->stop_flag) {
        struct pollfd pfd;
        pfd.fd      = sfd;
        pfd.events  = POLLIN;
        pfd.revents = 0;

        int rc = poll(&pfd, 1, 500 /* ms */);
        if (rc < 0) {
            if (errno == EINTR) continue;
            perror("net_server: poll");
            break;
        }
        if (rc == 0) continue;  /* timeout — check stop_flag */
        if (!(pfd.revents & POLLIN)) continue;

        /* --- 5b. Accept connection --- */
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int cfd = accept(sfd, (struct sockaddr *)&client_addr, &client_len);
        if (cfd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            if (errno == EINTR)  continue;
            perror("net_server: accept");
            continue;
        }

        /* Make client socket blocking for simplicity */
        int cflags = fcntl(cfd, F_GETFL, 0);
        if (cflags >= 0) fcntl(cfd, F_SETFL, cflags & ~O_NONBLOCK);

        /* --- 5c. Parse request --- */
        ServerRequest *req = parse_request(cfd);
        if (!req) {
            close(cfd);
            continue;
        }

        /* --- 5d. Route dispatch --- */
        ServerResponse *resp = NULL;
        int             found = 0;

        for (int i = 0; i < s->route_count; i++) {
            Route *rt = &s->routes[i];
            if (strcasecmp(rt->method, req->method) != 0) continue;
            if (!route_match(rt->pattern, req->path, req)) continue;

            /* Call the handler fat pointer */
            /* Cast: fn(env, req) → ServerResponse* */
            /* Suppress pedantic cast warning with a union trick */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
            resp  = (ServerResponse *)rt->handler.fn((void *)req, rt->handler.env);
#pragma GCC diagnostic pop
            found = 1;
            break;
        }

        if (!found) {
            resp = resp_error(404, "Not Found");
        }

        /* --- 5e. Send response --- */
        send_response(cfd, resp);

        /* --- 5f. Cleanup --- */
        close(cfd);
        sr_free(req);
        resp_free(resp);
    }

    close(sfd);
    s->server_fd = -1;
    return NULL;
}

/* ── Public server API ───────────────────────────────────────────────────── */

/*
 * Block the calling thread and run the HTTP server on `port`.
 * Returns only after server_stop() is called from another thread.
 */
void server_listen(HttpServer *s, int32_t port) {
    if (!s) return;
    ListenArg *la = (ListenArg *)malloc(sizeof(ListenArg));
    la->server = s;
    la->port   = port;
    /* Run in the calling thread — blocks until stop */
    server_listen_impl(la);
}

/*
 * Spawn a background pthread that runs the HTTP server on `port`.
 * Returns immediately; the caller can later call server_stop() +
 * server_free() to shut down.
 */
void server_listen_async(HttpServer *s, int32_t port) {
    if (!s) return;
    s->threaded = 1;
    ListenArg *la = (ListenArg *)malloc(sizeof(ListenArg));
    la->server = s;
    la->port   = port;
    pthread_create(&s->thread, NULL, server_listen_impl, la);
}

/*
 * Signal the server loop to stop accepting new connections.
 * For blocking (server_listen) callers, call from a different thread.
 * For async callers, call before server_free().
 */
void server_stop(HttpServer *s) {
    if (!s) return;
    s->stop_flag = 1;
}

/*
 * Stop the server (if running), join the async thread (if any), and free
 * the HttpServer struct.
 */
void server_free(HttpServer *s) {
    if (!s) return;
    server_stop(s);
    if (s->threaded) {
        pthread_join(s->thread, NULL);
    }
    free(s);
}
