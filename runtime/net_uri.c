/*
 * runtime/net_uri.c — URI / URL parsing and construction (RFC 3986).
 *
 * Implements the C backend for stdlib/network/uri.code.
 *
 * Covers:
 *   • Uri          — parsed / constructed URI value
 *   • UriSearchParams — mutable query-string map
 *   • Percent-encoding / decoding helpers
 *
 * All returned strings are heap-allocated (strdup/malloc).  Callers own them
 * for the lifetime of the Uri/UriSearchParams and must NOT free them directly;
 * uri_free / uri_params_free tears down everything at once.
 *
 * No third-party dependencies — POSIX / C99 only.
 */

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Internal structs ─────────────────────────────────────────────────────── */

typedef struct Uri {
    char *scheme;
    char *username;
    char *password;
    char *hostname;
    int   port;
    char *pathname;
    char *query;    /* WITHOUT leading '?' */
    char *fragment; /* WITHOUT leading '#' */
} Uri;

typedef struct KVNode {
    char           *key;
    char           *value;
    struct KVNode  *next;
} KVNode;

typedef struct UriSearchParams {
    KVNode *head;
} UriSearchParams;

/* ── Small helpers ────────────────────────────────────────────────────────── */

static char *dup(const char *s) {
    return s ? strdup(s) : strdup("");
}

static char *dup_or_empty(const char *s, size_t len) {
    char *r = malloc(len + 1);
    if (!r) return strdup("");
    memcpy(r, s, len);
    r[len] = '\0';
    return r;
}

/* ── Percent-encoding ─────────────────────────────────────────────────────── */

/* Returns 1 if `c` is an RFC 3986 unreserved character (never encoded). */
static int is_unreserved(unsigned char c) {
    return isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~';
}

char *uri_encode_component(const char *s) {
    if (!s) return strdup("");
    size_t n = strlen(s);
    /* Worst case: every byte → %XX (3 chars). */
    char *out = malloc(n * 3 + 1);
    if (!out) return strdup("");
    char *p = out;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (is_unreserved(c)) {
            *p++ = (char)c;
        } else if (c == ' ') {
            /* application/x-www-form-urlencoded uses %20 */
            *p++ = '%'; *p++ = '2'; *p++ = '0';
        } else {
            p += sprintf(p, "%%%02X", c);
        }
    }
    *p = '\0';
    return out;
}

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

char *uri_decode_component(const char *s) {
    if (!s) return strdup("");
    size_t n = strlen(s);
    char *out = malloc(n + 1);
    if (!out) return strdup("");
    char *p = out;
    for (size_t i = 0; i < n; ) {
        if (s[i] == '%' && i + 2 < n) {
            int hi = hex_val(s[i + 1]);
            int lo = hex_val(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                *p++ = (char)((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if (s[i] == '+') {
            *p++ = ' ';
        } else {
            *p++ = s[i];
        }
        i++;
    }
    *p = '\0';
    return out;
}

/* ── RFC 3986 URI parser ──────────────────────────────────────────────────── */

/*
 * Grammar (simplified):
 *   URI = scheme ":" hier-part [ "?" query ] [ "#" fragment ]
 *   hier-part = "//" authority path-abempty | path-absolute | path-rootless | ""
 *   authority = [ userinfo "@" ] host [ ":" port ]
 *   userinfo  = *( unreserved / pct-encoded / sub-delims / ":" )
 *
 * Relative references (no scheme) are also accepted.
 */
Uri *uri_parse(const char *raw) {
    Uri *u = calloc(1, sizeof(Uri));
    if (!u || !raw) {
        if (u) {
            u->scheme = strdup(""); u->username = strdup("");
            u->password = strdup(""); u->hostname = strdup("");
            u->pathname = strdup("/"); u->query = strdup("");
            u->fragment = strdup("");
        }
        return u;
    }

    const char *s = raw;
    const char *end = s + strlen(s);

    /* ── scheme ── */
    {
        /* Scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) */
        const char *p = s;
        while (p < end && (isalpha((unsigned char)*p) || (p > s && (isdigit((unsigned char)*p) || *p == '+' || *p == '-' || *p == '.')))) p++;
        if (p > s && p < end && *p == ':') {
            u->scheme = dup_or_empty(s, (size_t)(p - s));
            s = p + 1; /* skip ':' */
        } else {
            u->scheme = strdup("");
        }
    }

    /* ── fragment (strip from end first) ── */
    {
        const char *frag = strchr(s, '#');
        if (frag) {
            u->fragment = strdup(frag + 1);
            end = frag;
        } else {
            u->fragment = strdup("");
        }
    }

    /* ── query (strip from remaining end) ── */
    {
        /* Search only within [s, end) */
        const char *q = NULL;
        for (const char *p = s; p < end; p++) {
            if (*p == '?') { q = p; break; }
        }
        if (q) {
            u->query = dup_or_empty(q + 1, (size_t)(end - q - 1));
            end = q;
        } else {
            u->query = strdup("");
        }
    }

    /* ── authority ── */
    u->username = strdup("");
    u->password = strdup("");
    u->hostname = strdup("");
    u->port     = 0;

    if (s + 1 < end && s[0] == '/' && s[1] == '/') {
        s += 2; /* skip "//" */

        /* Find end of authority (next '/' or end-of-string within [s, end)) */
        const char *auth_end = end;
        for (const char *p = s; p < end; p++) {
            if (*p == '/') { auth_end = p; break; }
        }

        /* userinfo: everything before the last '@' in authority */
        const char *at = NULL;
        for (const char *p = auth_end - 1; p >= s; p--) {
            if (*p == '@') { at = p; break; }
        }
        if (at) {
            /* split user:pass */
            const char *colon = memchr(s, ':', (size_t)(at - s));
            if (colon) {
                u->username = dup_or_empty(s, (size_t)(colon - s));
                u->password = dup_or_empty(colon + 1, (size_t)(at - colon - 1));
            } else {
                u->username = dup_or_empty(s, (size_t)(at - s));
                /* password stays "" */
            }
            s = at + 1;
        }

        /* host[:port] */
        if (s < auth_end && *s == '[') {
            /* IPv6 literal */
            const char *close = memchr(s, ']', (size_t)(auth_end - s));
            if (close) {
                u->hostname = dup_or_empty(s, (size_t)(close - s + 1));
                s = close + 1;
                if (s < auth_end && *s == ':') {
                    s++;
                    u->port = (int)strtol(s, NULL, 10);
                }
            } else {
                u->hostname = dup_or_empty(s, (size_t)(auth_end - s));
            }
        } else {
            /* Find last ':' for port (IPv4 / hostname) */
            const char *port_colon = NULL;
            for (const char *p = auth_end - 1; p >= s; p--) {
                if (*p == ':') { port_colon = p; break; }
            }
            if (port_colon) {
                /* Only treat as port if all chars after ':' are digits */
                int all_digit = 1;
                for (const char *p = port_colon + 1; p < auth_end; p++) {
                    if (!isdigit((unsigned char)*p)) { all_digit = 0; break; }
                }
                if (all_digit && port_colon + 1 < auth_end) {
                    u->hostname = dup_or_empty(s, (size_t)(port_colon - s));
                    u->port     = (int)strtol(port_colon + 1, NULL, 10);
                } else {
                    u->hostname = dup_or_empty(s, (size_t)(auth_end - s));
                }
            } else {
                u->hostname = dup_or_empty(s, (size_t)(auth_end - s));
            }
        }

        s = auth_end;
    }

    /* ── pathname ── */
    if (s < end) {
        u->pathname = dup_or_empty(s, (size_t)(end - s));
    } else {
        u->pathname = strdup("");
    }
    /* Normalize: empty path → "/" when authority was present */
    if (u->hostname[0] != '\0' && u->pathname[0] == '\0') {
        free(u->pathname);
        u->pathname = strdup("/");
    }

    return u;
}

/* ── Constructor ──────────────────────────────────────────────────────────── */

Uri *uri_new(const char *scheme, const char *username, const char *password,
             const char *hostname, int port,
             const char *pathname, const char *query, const char *fragment) {
    Uri *u      = malloc(sizeof(Uri));
    if (!u) return NULL;
    u->scheme   = dup(scheme);
    u->username = dup(username);
    u->password = dup(password);
    u->hostname = dup(hostname);
    u->port     = port;
    u->pathname = dup(pathname);
    u->query    = dup(query);
    u->fragment = dup(fragment);
    return u;
}

/* ── Getters ──────────────────────────────────────────────────────────────── */

char *uri_scheme(Uri *u)   { return u ? dup(u->scheme)   : strdup(""); }
char *uri_username(Uri *u) { return u ? dup(u->username) : strdup(""); }
char *uri_password(Uri *u) { return u ? dup(u->password) : strdup(""); }

char *uri_hostname(Uri *u) { return u ? dup(u->hostname) : strdup(""); }

char *uri_host(Uri *u) {
    if (!u) return strdup("");
    if (u->port > 0) {
        char buf[1024];
        snprintf(buf, sizeof(buf), "%s:%d", u->hostname, u->port);
        return strdup(buf);
    }
    return dup(u->hostname);
}

int   uri_port(Uri *u) { return u ? u->port : 0; }

char *uri_pathname(Uri *u) {
    if (!u) return strdup("/");
    if (u->pathname[0] == '\0') return strdup("/");
    return dup(u->pathname);
}

char *uri_search(Uri *u) {
    if (!u || u->query[0] == '\0') return strdup("");
    char buf[4096];
    snprintf(buf, sizeof(buf), "?%s", u->query);
    return strdup(buf);
}

char *uri_hash(Uri *u) {
    if (!u || u->fragment[0] == '\0') return strdup("");
    char buf[4096];
    snprintf(buf, sizeof(buf), "#%s", u->fragment);
    return strdup(buf);
}

char *uri_origin(Uri *u) {
    if (!u || u->scheme[0] == '\0' || u->hostname[0] == '\0') return strdup("");
    char buf[2048];
    if (u->port > 0) {
        snprintf(buf, sizeof(buf), "%s://%s:%d", u->scheme, u->hostname, u->port);
    } else {
        snprintf(buf, sizeof(buf), "%s://%s", u->scheme, u->hostname);
    }
    return strdup(buf);
}

/* ── Serialise ────────────────────────────────────────────────────────────── */

static char *build_href(Uri *u) {
    /* Upper bound: all parts + separators */
    size_t cap = 4096;
    char *buf  = malloc(cap);
    if (!buf) return strdup("");
    buf[0] = '\0';
    size_t pos = 0;

#define APPEND(fmt, ...)                                                          \
    do {                                                                           \
        int wrote = snprintf(buf + pos, cap - pos, fmt, ##__VA_ARGS__);           \
        if (wrote > 0) pos += (size_t)wrote;                                      \
    } while (0)

    if (u->scheme[0]) APPEND("%s:", u->scheme);

    if (u->hostname[0]) {
        APPEND("//");
        if (u->username[0]) {
            APPEND("%s", u->username);
            if (u->password[0]) APPEND(":%s", u->password);
            APPEND("@");
        }
        APPEND("%s", u->hostname);
        if (u->port > 0) APPEND(":%d", u->port);
    }

    if (u->pathname[0]) APPEND("%s", u->pathname);
    else if (u->hostname[0]) APPEND("/");

    if (u->query[0])    APPEND("?%s", u->query);
    if (u->fragment[0]) APPEND("#%s", u->fragment);

#undef APPEND
    return buf;
}

char *uri_href(Uri *u)      { return u ? build_href(u) : strdup(""); }
char *uri_to_string(Uri *u) { return u ? build_href(u) : strdup(""); }

/* ── Non-destructive builders ─────────────────────────────────────────────── */

static Uri *uri_clone(Uri *u) {
    if (!u) return NULL;
    return uri_new(u->scheme, u->username, u->password,
                   u->hostname, u->port, u->pathname, u->query, u->fragment);
}

Uri *uri_with_scheme(Uri *u, const char *scheme) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->scheme); n->scheme = dup(scheme); return n;
}
Uri *uri_with_username(Uri *u, const char *username) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->username); n->username = dup(username); return n;
}
Uri *uri_with_password(Uri *u, const char *password) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->password); n->password = dup(password); return n;
}
Uri *uri_with_hostname(Uri *u, const char *hostname) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->hostname); n->hostname = dup(hostname); return n;
}
Uri *uri_with_port(Uri *u, int port) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    n->port = port; return n;
}
Uri *uri_with_pathname(Uri *u, const char *pathname) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->pathname); n->pathname = dup(pathname); return n;
}
Uri *uri_with_search(Uri *u, const char *query) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->query); n->query = dup(query); return n;
}
Uri *uri_with_hash(Uri *u, const char *fragment) {
    Uri *n = uri_clone(u); if (!n) return NULL;
    free(n->fragment); n->fragment = dup(fragment); return n;
}

/* ── Predicates ───────────────────────────────────────────────────────────── */

int uri_is_absolute(Uri *u) {
    return (u && u->scheme[0] != '\0') ? 1 : 0;
}

/* ── RFC 3986 §5.2.2 reference resolution ────────────────────────────────── */

Uri *uri_resolve(Uri *base, Uri *ref) {
    if (!base || !ref) return uri_clone(ref ? ref : base);

    /* If ref has a scheme it IS absolute — return as-is. */
    if (ref->scheme[0] != '\0') return uri_clone(ref);

    Uri *t = calloc(1, sizeof(Uri));
    if (!t) return NULL;

    if (ref->hostname[0] != '\0') {
        /* ref has authority */
        t->scheme   = dup(base->scheme);
        t->username = dup(ref->username);
        t->password = dup(ref->password);
        t->hostname = dup(ref->hostname);
        t->port     = ref->port;
        t->pathname = dup(ref->pathname);
        t->query    = dup(ref->query);
    } else {
        t->scheme   = dup(base->scheme);
        t->username = dup(base->username);
        t->password = dup(base->password);
        t->hostname = dup(base->hostname);
        t->port     = base->port;

        if (ref->pathname[0] == '\0') {
            t->pathname = dup(base->pathname);
            t->query    = (ref->query[0] != '\0') ? dup(ref->query) : dup(base->query);
        } else {
            if (ref->pathname[0] == '/') {
                t->pathname = dup(ref->pathname);
            } else {
                /* merge: take base path up to (and including) last '/' */
                const char *last_slash = strrchr(base->pathname, '/');
                if (last_slash) {
                    size_t prefix_len = (size_t)(last_slash - base->pathname + 1);
                    size_t ref_len    = strlen(ref->pathname);
                    char *merged      = malloc(prefix_len + ref_len + 1);
                    if (merged) {
                        memcpy(merged, base->pathname, prefix_len);
                        memcpy(merged + prefix_len, ref->pathname, ref_len);
                        merged[prefix_len + ref_len] = '\0';
                    } else {
                        merged = strdup(ref->pathname);
                    }
                    t->pathname = merged;
                } else {
                    t->pathname = dup(ref->pathname);
                }
            }
            t->query = dup(ref->query);
        }
    }
    t->fragment = dup(ref->fragment);
    return t;
}

/* ── Destructor ───────────────────────────────────────────────────────────── */

void uri_free(Uri *u) {
    if (!u) return;
    free(u->scheme); free(u->username); free(u->password);
    free(u->hostname); free(u->pathname); free(u->query); free(u->fragment);
    free(u);
}

/* ══ UriSearchParams ══════════════════════════════════════════════════════════
 *
 * Stores key=value pairs as a singly-linked list (insertion order preserved).
 * Duplicate keys are supported (append).
 */

/* ── Decode a single query-string token (percent-decode + '+' → space) ── */

static char *param_decode(const char *s, size_t len) {
    char *tmp = dup_or_empty(s, len);
    char *dec = uri_decode_component(tmp);
    free(tmp);
    return dec;
}

/* ── Parse "key=val&key2=val2" into a UriSearchParams ─────────────────── */

UriSearchParams *uri_params_parse(const char *query) {
    UriSearchParams *p = calloc(1, sizeof(UriSearchParams));
    if (!p || !query || query[0] == '\0') return p;

    const char *src = query;
    while (*src) {
        /* Find '&' or end */
        const char *amp = strchr(src, '&');
        if (!amp) amp = src + strlen(src);

        /* Split at '=' */
        const char *eq = memchr(src, '=', (size_t)(amp - src));
        char *key, *val;
        if (eq) {
            key = param_decode(src, (size_t)(eq - src));
            val = param_decode(eq + 1, (size_t)(amp - eq - 1));
        } else {
            key = param_decode(src, (size_t)(amp - src));
            val = strdup("");
        }

        KVNode *node = malloc(sizeof(KVNode));
        if (node) {
            node->key   = key;
            node->value = val;
            node->next  = NULL;
            /* Append to end of list */
            if (!p->head) {
                p->head = node;
            } else {
                KVNode *tail = p->head;
                while (tail->next) tail = tail->next;
                tail->next = node;
            }
        } else {
            free(key); free(val);
        }

        src = (*amp == '&') ? amp + 1 : amp;
    }
    return p;
}

/* ── Getters ──────────────────────────────────────────────────────────────── */

char *uri_params_get(UriSearchParams *p, const char *key) {
    if (!p || !key) return strdup("");
    for (KVNode *n = p->head; n; n = n->next) {
        if (strcmp(n->key, key) == 0) return dup(n->value);
    }
    return strdup("");
}

char *uri_params_get_all(UriSearchParams *p, const char *key) {
    if (!p || !key) return strdup("");
    /* Collect all values into a comma-separated string */
    size_t cap = 256, pos = 0;
    char *out  = malloc(cap);
    if (!out) return strdup("");
    out[0] = '\0';
    int first = 1;
    for (KVNode *n = p->head; n; n = n->next) {
        if (strcmp(n->key, key) != 0) continue;
        size_t vlen = strlen(n->value);
        size_t need = pos + vlen + 2;
        if (need > cap) {
            cap = need * 2;
            char *r = realloc(out, cap);
            if (!r) { free(out); return strdup(""); }
            out = r;
        }
        if (!first) { out[pos++] = ','; out[pos] = '\0'; }
        memcpy(out + pos, n->value, vlen + 1);
        pos  += vlen;
        first = 0;
    }
    return out;
}

int uri_params_has(UriSearchParams *p, const char *key) {
    if (!p || !key) return 0;
    for (KVNode *n = p->head; n; n = n->next) {
        if (strcmp(n->key, key) == 0) return 1;
    }
    return 0;
}

/* ── Mutators ─────────────────────────────────────────────────────────────── */

void uri_params_set(UriSearchParams *p, const char *key, const char *value) {
    if (!p || !key) return;
    /*
     * WHATWG URLSearchParams.set() semantics:
     *   • Replace the first occurrence of key in-place (preserving its position).
     *   • Remove all subsequent occurrences of key.
     * If key does not exist, append it.
     */
    KVNode *first = NULL; /* first match (updated in place) */
    KVNode **cur = &p->head;
    while (*cur) {
        if (strcmp((*cur)->key, key) == 0) {
            if (!first) {
                /* Replace value in place */
                free((*cur)->value);
                (*cur)->value = dup(value ? value : "");
                first = *cur;
                cur = &(*cur)->next;
            } else {
                /* Remove subsequent duplicates */
                KVNode *del = *cur;
                *cur = del->next;
                free(del->key); free(del->value); free(del);
            }
        } else {
            cur = &(*cur)->next;
        }
    }
    if (!first) {
        /* Key was absent — append */
        KVNode *node = malloc(sizeof(KVNode));
        if (!node) return;
        node->key   = dup(key);
        node->value = dup(value ? value : "");
        node->next  = NULL;
        if (!p->head) {
            p->head = node;
        } else {
            KVNode *tail = p->head;
            while (tail->next) tail = tail->next;
            tail->next = node;
        }
    }
}

void uri_params_append(UriSearchParams *p, const char *key, const char *value) {
    if (!p || !key) return;
    KVNode *node = malloc(sizeof(KVNode));
    if (!node) return;
    node->key   = dup(key);
    node->value = dup(value ? value : "");
    node->next  = NULL;
    if (!p->head) {
        p->head = node;
    } else {
        KVNode *tail = p->head;
        while (tail->next) tail = tail->next;
        tail->next = node;
    }
}

void uri_params_delete(UriSearchParams *p, const char *key) {
    if (!p || !key) return;
    KVNode **cur = &p->head;
    while (*cur) {
        if (strcmp((*cur)->key, key) == 0) {
            KVNode *del = *cur;
            *cur = del->next;
            free(del->key); free(del->value); free(del);
        } else {
            cur = &(*cur)->next;
        }
    }
}

/* ── Serialise ────────────────────────────────────────────────────────────── */

char *uri_params_to_string(UriSearchParams *p) {
    if (!p || !p->head) return strdup("");

    size_t cap = 256, pos = 0;
    char *out  = malloc(cap);
    if (!out) return strdup("");
    out[0] = '\0';

    int first = 1;
    for (KVNode *n = p->head; n; n = n->next) {
        char *ek = uri_encode_component(n->key);
        char *ev = uri_encode_component(n->value);
        size_t need = pos + strlen(ek) + strlen(ev) + 3; /* '=' + '&' + '\0' */
        if (need > cap) {
            cap = need * 2;
            char *r = realloc(out, cap);
            if (!r) { free(out); free(ek); free(ev); return strdup(""); }
            out = r;
        }
        if (!first) out[pos++] = '&';
        size_t klen = strlen(ek);
        memcpy(out + pos, ek, klen); pos += klen;
        out[pos++] = '=';
        size_t vlen = strlen(ev);
        memcpy(out + pos, ev, vlen); pos += vlen;
        out[pos] = '\0';
        free(ek); free(ev);
        first = 0;
    }
    return out;
}

/* ── Destructor ───────────────────────────────────────────────────────────── */

void uri_params_free(UriSearchParams *p) {
    if (!p) return;
    KVNode *n = p->head;
    while (n) {
        KVNode *next = n->next;
        free(n->key); free(n->value); free(n);
        n = next;
    }
    free(p);
}

/* Also expose uri_search_params(Uri*) — build UriSearchParams from uri's query */
UriSearchParams *uri_search_params(Uri *u) {
    if (!u) return uri_params_parse("");
    return uri_params_parse(u->query);
}
