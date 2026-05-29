/**
 * CodeLang WebSocket runtime — RFC 6455, ws:// only.
 *
 * Provides:
 *   WebSocket — client WebSocket connection over a plain TCP socket.
 *
 * Performs the HTTP Upgrade handshake and implements basic WebSocket
 * framing (text and binary frames, client masking required by RFC 6455).
 * Only supports ws:// (not wss://); fragmentation is not supported on
 * recv (a single frame is returned per call).
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
#include <time.h>
#include <errno.h>

/* ── WebSocket struct ────────────────────────────────────────────────────── */

typedef struct {
    int fd;
    int open;   /* 1 = connected and handshake complete */
} WebSocket;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/* Simple base64 encoder — used for Sec-WebSocket-Key */
static const char b64_chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *base64_encode(const unsigned char *src, size_t len) {
    size_t out_len = 4 * ((len + 2) / 3) + 1;
    char  *out     = (char *)malloc(out_len);
    size_t i, j = 0;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t v = ((uint32_t)src[i] << 16) | ((uint32_t)src[i+1] << 8) | src[i+2];
        out[j++] = b64_chars[(v >> 18) & 0x3f];
        out[j++] = b64_chars[(v >> 12) & 0x3f];
        out[j++] = b64_chars[(v >>  6) & 0x3f];
        out[j++] = b64_chars[(v      ) & 0x3f];
    }
    if (len - i == 2) {
        uint32_t v = ((uint32_t)src[i] << 8) | src[i+1];
        out[j++] = b64_chars[(v >> 10) & 0x3f];
        out[j++] = b64_chars[(v >>  4) & 0x3f];
        out[j++] = b64_chars[(v <<  2) & 0x3f];
        out[j++] = '=';
    } else if (len - i == 1) {
        uint32_t v = src[i];
        out[j++] = b64_chars[(v >> 2) & 0x3f];
        out[j++] = b64_chars[(v << 4) & 0x3f];
        out[j++] = '=';
        out[j++] = '=';
    }
    out[j] = '\0';
    return out;
}

/* Generate a 16-byte random key and base64-encode it */
static char *ws_make_key(void) {
    unsigned char key[16];
    srand((unsigned int)time(NULL) ^ (unsigned int)(uintptr_t)key);
    for (int i = 0; i < 16; i++) key[i] = (unsigned char)(rand() & 0xff);
    return base64_encode(key, 16);
}

/* TCP connect helper */
static int tcp_connect_ws(const char *host, const char *port_str) {
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
        close(fd); fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

/* send_all: write exactly len bytes */
static int send_all(int fd, const void *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, (const char *)buf + sent, len - sent, 0);
        if (n <= 0) return -1;
        sent += (size_t)n;
    }
    return 0;
}

/* recv_exact: read exactly len bytes */
static int recv_exact(int fd, void *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = recv(fd, (char *)buf + got, len - got, 0);
        if (n <= 0) return -1;
        got += (size_t)n;
    }
    return 0;
}

/* ── Handshake ───────────────────────────────────────────────────────────── */

/* Parses ws://host[:port]/path from url.  Returns 0 on success. */
static int parse_ws_url(const char *url, char *host, size_t hlen,
                        char *port_str, size_t plen, char *path, size_t pathlen) {
    const char *p = url;
    if (strncasecmp(p, "wss://", 6) == 0) {
        return -1; /* TLS not supported */
    } else if (strncasecmp(p, "ws://", 5) == 0) {
        p += 5;
        strncpy(port_str, "80", plen);
    } else {
        return -1;
    }

    const char *slash = strchr(p, '/');
    size_t host_part_len = slash ? (size_t)(slash - p) : strlen(p);
    char   host_part[512];
    if (host_part_len >= sizeof(host_part)) return -1;
    memcpy(host_part, p, host_part_len);
    host_part[host_part_len] = '\0';

    char *colon = strrchr(host_part, ':');
    if (colon) {
        *colon = '\0';
        strncpy(port_str, colon + 1, plen - 1);
    }
    strncpy(host, host_part, hlen - 1);
    if (slash) strncpy(path, slash, pathlen - 1);
    else       strncpy(path, "/", pathlen - 1);
    return 0;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

WebSocket *ws_connect(const char *url) {
    WebSocket *ws = (WebSocket *)malloc(sizeof(WebSocket));
    ws->fd   = -1;
    ws->open = 0;

    char host[256]    = {0};
    char port_str[16] = {0};
    char path[4096]   = {0};

    if (parse_ws_url(url, host, sizeof(host), port_str, sizeof(port_str),
                     path, sizeof(path)) != 0) {
        return ws;
    }

    int fd = tcp_connect_ws(host, port_str);
    if (fd < 0) return ws;

    char *key = ws_make_key();

    /* Send HTTP Upgrade request */
    char req[2048];
    int  req_len = snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n",
        path, host, key);
    free(key);

    if (send_all(fd, req, (size_t)req_len) < 0) { close(fd); return ws; }

    /* Read response until "\r\n\r\n" */
    char resp[4096];
    int  resp_len = 0;
    for (;;) {
        ssize_t n = recv(fd, resp + resp_len, 1, 0);
        if (n <= 0) { close(fd); return ws; }
        resp_len++;
        if (resp_len >= 4 &&
            resp[resp_len-4] == '\r' && resp[resp_len-3] == '\n' &&
            resp[resp_len-2] == '\r' && resp[resp_len-1] == '\n') {
            break;
        }
        if (resp_len >= (int)sizeof(resp) - 1) { close(fd); return ws; }
    }
    resp[resp_len] = '\0';

    /* Check for "101 Switching Protocols" */
    if (strstr(resp, "101") == NULL) { close(fd); return ws; }

    ws->fd   = fd;
    ws->open = 1;
    return ws;
}

/* Send a WebSocket frame.
 * opcode: 0x01 = text, 0x02 = binary, 0x08 = close */
static void ws_send_frame(WebSocket *ws, int opcode, const char *data) {
    if (!ws || ws->fd < 0 || !data) return;
    size_t payload_len = strlen(data);

    /* Build frame header */
    unsigned char header[14];
    int header_len = 0;
    header[header_len++] = (unsigned char)(0x80 | (opcode & 0x0f)); /* FIN + opcode */

    /* Mask bit always set for client frames (RFC 6455 §5.3) */
    if (payload_len < 126) {
        header[header_len++] = (unsigned char)(0x80 | payload_len);
    } else if (payload_len < 65536) {
        header[header_len++] = (unsigned char)(0x80 | 126);
        header[header_len++] = (unsigned char)((payload_len >> 8) & 0xff);
        header[header_len++] = (unsigned char)( payload_len       & 0xff);
    } else {
        header[header_len++] = (unsigned char)(0x80 | 127);
        for (int i = 7; i >= 0; i--)
            header[header_len++] = (unsigned char)((payload_len >> (i * 8)) & 0xff);
    }

    /* 4-byte masking key */
    unsigned char mask[4];
    unsigned int r = (unsigned int)time(NULL);
    mask[0] = (unsigned char)(r & 0xff);
    mask[1] = (unsigned char)((r >> 8)  & 0xff);
    mask[2] = (unsigned char)((r >> 16) & 0xff);
    mask[3] = (unsigned char)((r >> 24) & 0xff);
    header[header_len++] = mask[0];
    header[header_len++] = mask[1];
    header[header_len++] = mask[2];
    header[header_len++] = mask[3];

    /* Mask payload */
    unsigned char *masked = (unsigned char *)malloc(payload_len);
    for (size_t i = 0; i < payload_len; i++)
        masked[i] = (unsigned char)data[i] ^ mask[i & 3];

    send_all(ws->fd, header, (size_t)header_len);
    send_all(ws->fd, masked, payload_len);
    free(masked);
}

void ws_send(WebSocket *ws, const char *msg) {
    ws_send_frame(ws, 0x01, msg);
}

void ws_send_binary(WebSocket *ws, const char *data) {
    ws_send_frame(ws, 0x02, data);
}

const char *ws_recv(WebSocket *ws) {
    if (!ws || ws->fd < 0 || !ws->open) return strdup("");

    /* Read 2-byte base header */
    unsigned char h2[2];
    if (recv_exact(ws->fd, h2, 2) < 0) { ws->open = 0; return strdup(""); }

    /* int fin  = (h2[0] >> 7) & 1; */
    int opcode = h2[0] & 0x0f;
    int masked  = (h2[1] >> 7) & 1;
    uint64_t payload_len = h2[1] & 0x7f;

    if (payload_len == 126) {
        unsigned char ext[2];
        if (recv_exact(ws->fd, ext, 2) < 0) { ws->open = 0; return strdup(""); }
        payload_len = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (payload_len == 127) {
        unsigned char ext[8];
        if (recv_exact(ws->fd, ext, 8) < 0) { ws->open = 0; return strdup(""); }
        payload_len = 0;
        for (int i = 0; i < 8; i++) payload_len = (payload_len << 8) | ext[i];
    }

    unsigned char mask[4] = {0, 0, 0, 0};
    if (masked) {
        if (recv_exact(ws->fd, mask, 4) < 0) { ws->open = 0; return strdup(""); }
    }

    /* Read payload */
    char *buf = (char *)malloc(payload_len + 1);
    if (payload_len > 0 && recv_exact(ws->fd, buf, (size_t)payload_len) < 0) {
        free(buf); ws->open = 0; return strdup("");
    }
    buf[payload_len] = '\0';

    /* Unmask if needed */
    if (masked) {
        for (uint64_t i = 0; i < payload_len; i++)
            buf[i] ^= mask[i & 3];
    }

    /* Handle close frame */
    if (opcode == 0x08) {
        ws->open = 0;
        /* Send close frame back */
        ws_send_frame(ws, 0x08, "");
        free(buf);
        return strdup("");
    }

    const char *result = strdup(buf);
    free(buf);
    return result;
}

void ws_close(WebSocket *ws) {
    if (!ws) return;
    if (ws->fd >= 0 && ws->open) {
        ws_send_frame(ws, 0x08, "");
    }
    if (ws->fd >= 0) { close(ws->fd); ws->fd = -1; }
    ws->open = 0;
    free(ws);
}

int32_t ws_is_open(WebSocket *ws) {
    return (ws && ws->open) ? 1 : 0;
}
