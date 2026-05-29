/**
 * CodeLang DNS runtime — getaddrinfo / getnameinfo wrappers.
 *
 * Provides:
 *   Dns — static namespace with forward and reverse DNS lookups.
 *
 * All returned strings are strdup()'d heap allocations.
 *
 * Compile: clang -O2   (libc on both Linux and macOS)
 */

#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>

/* ── Dns ─────────────────────────────────────────────────────────────────── */

/* Resolve host to its first A or AAAA record.
 * Returns IP string on success, "" on failure. */
const char *dns_lookup(const char *host) {
    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, NULL, &hints, &res) != 0) return strdup("");

    char buf[INET6_ADDRSTRLEN];
    const char *result = strdup("");

    for (struct addrinfo *rp = res; rp != NULL; rp = rp->ai_next) {
        void *addr_ptr = NULL;
        if (rp->ai_family == AF_INET) {
            addr_ptr = &((struct sockaddr_in *)rp->ai_addr)->sin_addr;
        } else if (rp->ai_family == AF_INET6) {
            addr_ptr = &((struct sockaddr_in6 *)rp->ai_addr)->sin6_addr;
        }
        if (addr_ptr && inet_ntop(rp->ai_family, addr_ptr, buf, sizeof(buf))) {
            free((void *)result);
            result = strdup(buf);
            break;
        }
    }
    freeaddrinfo(res);
    return result;
}

/* Resolve host to all A/AAAA records, comma-separated.
 * Returns "" on failure or when no records exist. */
const char *dns_lookup_all(const char *host) {
    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, NULL, &hints, &res) != 0) return strdup("");

    /* Build comma-separated list */
    char  combined[8192];
    int   combined_len = 0;
    combined[0] = '\0';

    char buf[INET6_ADDRSTRLEN];
    for (struct addrinfo *rp = res; rp != NULL; rp = rp->ai_next) {
        void *addr_ptr = NULL;
        if (rp->ai_family == AF_INET) {
            addr_ptr = &((struct sockaddr_in *)rp->ai_addr)->sin_addr;
        } else if (rp->ai_family == AF_INET6) {
            addr_ptr = &((struct sockaddr_in6 *)rp->ai_addr)->sin6_addr;
        }
        if (addr_ptr && inet_ntop(rp->ai_family, addr_ptr, buf, sizeof(buf))) {
            if (combined_len > 0 && combined_len < (int)sizeof(combined) - 1) {
                combined[combined_len++] = ',';
                combined[combined_len]   = '\0';
            }
            int rem = (int)sizeof(combined) - combined_len - 1;
            if (rem > 0) {
                strncat(combined, buf, (size_t)rem);
                combined_len = (int)strlen(combined);
            }
        }
    }
    freeaddrinfo(res);
    return strdup(combined);
}

/* Reverse-lookup an IP address to its canonical hostname.
 * Returns the hostname or "" on failure. */
const char *dns_reverse(const char *ip) {
    struct sockaddr_storage ss;
    memset(&ss, 0, sizeof(ss));

    /* Try IPv4 first, then IPv6 */
    struct sockaddr_in  *s4 = (struct sockaddr_in  *)&ss;
    struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&ss;
    socklen_t sslen;

    if (inet_pton(AF_INET, ip, &s4->sin_addr) == 1) {
        s4->sin_family = AF_INET;
        sslen          = sizeof(struct sockaddr_in);
    } else if (inet_pton(AF_INET6, ip, &s6->sin6_addr) == 1) {
        s6->sin6_family = AF_INET6;
        sslen           = sizeof(struct sockaddr_in6);
    } else {
        return strdup("");
    }

    char host[NI_MAXHOST];
    if (getnameinfo((struct sockaddr *)&ss, sslen,
                    host, sizeof(host),
                    NULL, 0, 0) != 0) {
        return strdup("");
    }
    return strdup(host);
}
