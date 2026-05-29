/**
 * CodeLang UDP runtime — POSIX datagram sockets.
 *
 * Provides:
 *   UdpSocket — bound UDP socket with send, recv, and broadcast support.
 *
 * recv() returns "host:port|data" so the caller can extract both the
 * sender address and the payload in a single call.
 *
 * All returned strings are strdup()'d heap allocations.
 *
 * Compile: clang -O2   (libc on both Linux and macOS)
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

/* ── UdpSocket ───────────────────────────────────────────────────────────── */

typedef struct {
    int fd;
} UdpSocket;

/* ── Public API ──────────────────────────────────────────────────────────── */

UdpSocket *udp_socket_bind(const char *host, int32_t port) {
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", (int)port);

    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_flags    = AI_PASSIVE;

    UdpSocket *s = (UdpSocket *)malloc(sizeof(UdpSocket));
    s->fd = -1;

    if (getaddrinfo(host && host[0] ? host : NULL, port_str, &hints, &res) != 0) return s;

    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd >= 0) {
        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        if (bind(fd, res->ai_addr, res->ai_addrlen) == 0) {
            s->fd = fd;
        } else {
            close(fd);
        }
    }
    freeaddrinfo(res);
    return s;
}

void udp_socket_send(UdpSocket *s, const char *data, const char *host, int32_t port) {
    if (!s || s->fd < 0 || !data || !host) return;

    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", (int)port);

    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;

    if (getaddrinfo(host, port_str, &hints, &res) != 0) return;
    sendto(s->fd, data, strlen(data), 0, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
}

/* Returns "sender_host:sender_port|data" or "" on error. */
const char *udp_socket_recv(UdpSocket *s) {
    if (!s || s->fd < 0) return strdup("");

    char buf[65536];
    struct sockaddr_storage ss;
    socklen_t               sslen = sizeof(ss);

    ssize_t n = recvfrom(s->fd, buf, sizeof(buf) - 1, 0,
                         (struct sockaddr *)&ss, &sslen);
    if (n < 0) return strdup("");
    buf[n] = '\0';

    char sender_host[256];
    char sender_port[32];
    if (getnameinfo((struct sockaddr *)&ss, sslen,
                    sender_host, sizeof(sender_host),
                    sender_port, sizeof(sender_port),
                    NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
        sender_host[0] = '\0';
        sender_port[0] = '\0';
    }

    /* Format: "host:port|data" */
    size_t needed = strlen(sender_host) + 1 + strlen(sender_port) + 1 + (size_t)n + 1;
    char  *result = (char *)malloc(needed);
    snprintf(result, needed, "%s:%s|%s", sender_host, sender_port, buf);
    return result;
}

void udp_socket_set_broadcast(UdpSocket *s, int32_t enabled) {
    if (!s || s->fd < 0) return;
    int val = (enabled != 0) ? 1 : 0;
    setsockopt(s->fd, SOL_SOCKET, SO_BROADCAST, &val, sizeof(val));
}

void udp_socket_close(UdpSocket *s) {
    if (!s) return;
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    free(s);
}

const char *udp_socket_addr(UdpSocket *s) {
    if (!s || s->fd < 0) return strdup("");
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (getsockname(s->fd, (struct sockaddr *)&ss, &len) < 0) return strdup("");

    char host[256];
    char port[32];
    if (getnameinfo((struct sockaddr *)&ss, len,
                    host, sizeof(host),
                    port, sizeof(port),
                    NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
        return strdup("");
    }
    size_t needed = strlen(host) + 1 + strlen(port) + 1;
    char  *result = (char *)malloc(needed);
    snprintf(result, needed, "%s:%s", host, port);
    return result;
}
