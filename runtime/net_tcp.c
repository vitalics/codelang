/**
 * CodeLang TCP runtime — POSIX blocking sockets.
 *
 * Provides:
 *   TcpStream   — connected TCP socket (client or accepted peer).
 *   TcpListener — bound, listening TCP server socket.
 *
 * All returned strings are strdup()'d heap allocations; callers must not free
 * them directly (the runtime owns them through the struct lifetime).
 *
 * Compile: clang -O2   (links against libc on both Linux and macOS)
 */

#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <errno.h>

/* ── TcpStream ───────────────────────────────────────────────────────────── */

typedef struct {
    int fd;
} TcpStream;

typedef struct {
    int fd;
} TcpListener;

/* ── Internal helpers ────────────────────────────────────────────────────── */

/* Format a sockaddr as "host:port" into a heap-allocated string. */
static const char *addr_to_str(struct sockaddr_storage *ss) {
    char host[256];
    char port[32];
    if (getnameinfo((struct sockaddr *)ss, sizeof(*ss),
                    host, sizeof(host),
                    port, sizeof(port),
                    NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
        return strdup("");
    }
    size_t len = strlen(host) + 1 + strlen(port) + 1;
    char  *buf = (char *)malloc(len);
    snprintf(buf, len, "%s:%s", host, port);
    return buf;
}

/* ── TcpStream public API ────────────────────────────────────────────────── */

TcpStream *tcp_stream_connect(const char *host, int32_t port) {
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", (int)port);

    struct addrinfo hints, *res, *rp;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    TcpStream *s = (TcpStream *)malloc(sizeof(TcpStream));
    s->fd = -1;

    if (getaddrinfo(host, port_str, &hints, &res) != 0) return s;

    for (rp = res; rp != NULL; rp = rp->ai_next) {
        int fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) {
            s->fd = fd;
            break;
        }
        close(fd);
    }
    freeaddrinfo(res);
    return s;
}

const char *tcp_stream_read(TcpStream *s) {
    if (!s || s->fd < 0) return strdup("");
    char   buf[4096];
    ssize_t n = recv(s->fd, buf, sizeof(buf) - 1, 0);
    if (n <= 0) return strdup("");
    buf[n] = '\0';
    return strdup(buf);
}

void tcp_stream_write(TcpStream *s, const char *data) {
    if (!s || s->fd < 0 || !data) return;
    size_t  total = strlen(data);
    size_t  sent  = 0;
    while (sent < total) {
        ssize_t n = send(s->fd, data + sent, total - sent, 0);
        if (n <= 0) break;
        sent += (size_t)n;
    }
}

void tcp_stream_close(TcpStream *s) {
    if (!s) return;
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    free(s);
}

const char *tcp_stream_local_addr(TcpStream *s) {
    if (!s || s->fd < 0) return strdup("");
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (getsockname(s->fd, (struct sockaddr *)&ss, &len) < 0) return strdup("");
    return addr_to_str(&ss);
}

const char *tcp_stream_peer_addr(TcpStream *s) {
    if (!s || s->fd < 0) return strdup("");
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (getpeername(s->fd, (struct sockaddr *)&ss, &len) < 0) return strdup("");
    return addr_to_str(&ss);
}

/* ── TcpListener public API ──────────────────────────────────────────────── */

TcpListener *tcp_listener_bind(const char *host, int32_t port) {
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", (int)port);

    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags    = AI_PASSIVE;

    TcpListener *l = (TcpListener *)malloc(sizeof(TcpListener));
    l->fd = -1;

    if (getaddrinfo(host && host[0] ? host : NULL, port_str, &hints, &res) != 0) return l;

    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd >= 0) {
        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        if (bind(fd, res->ai_addr, res->ai_addrlen) == 0 && listen(fd, 128) == 0) {
            l->fd = fd;
        } else {
            close(fd);
        }
    }
    freeaddrinfo(res);
    return l;
}

TcpStream *tcp_listener_accept(TcpListener *l) {
    TcpStream *s = (TcpStream *)malloc(sizeof(TcpStream));
    s->fd = -1;
    if (!l || l->fd < 0) return s;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    int fd = accept(l->fd, (struct sockaddr *)&ss, &len);
    if (fd >= 0) s->fd = fd;
    return s;
}

void tcp_listener_close(TcpListener *l) {
    if (!l) return;
    if (l->fd >= 0) { close(l->fd); l->fd = -1; }
    free(l);
}

const char *tcp_listener_addr(TcpListener *l) {
    if (!l || l->fd < 0) return strdup("");
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (getsockname(l->fd, (struct sockaddr *)&ss, &len) < 0) return strdup("");
    return addr_to_str(&ss);
}
