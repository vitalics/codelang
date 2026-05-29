/**
 * CodeLang OS runtime — system / hardware information.
 *
 * Inspired by Node.js's `os` module.
 *
 * Sections
 *   1. Compile-time constants  — arch, platform, endianness, EOL, devNull
 *   2. OS identity             — type, release, version          (uname)
 *   3. Machine                 — hostname, homedir, tmpdir, uptime
 *   4. Memory                  — freemem, totalmem               (bytes as int64)
 *   5. CPU                     — count, model, speed
 *   6. User                    — username, uid, gid
 *   7. GPU                     — count, model                    (best-effort)
 *   8. NPU                     — has_npu, name                   (Apple Silicon / ANE)
 *
 * Platform support: macOS (primary), Linux, stub for others.
 * No extra link flags needed — only POSIX + sysctl (macOS).
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#if defined(__APPLE__)
#   include <sys/sysctl.h>
#   include <sys/types.h>
#   include <mach/mach.h>
#elif defined(__linux__)
#   include <sys/sysinfo.h>
#endif

#include <unistd.h>
#include <sys/utsname.h>
#include <pwd.h>

/* ── helpers ─────────────────────────────────────────────────────────────── */

static char *os_strdup(const char *s) {
    if (!s) return strdup("unknown");
    size_t len = strlen(s);
    char  *p   = (char *)malloc(len + 1);
    memcpy(p, s, len + 1);
    return p;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Compile-time constants
 * ═══════════════════════════════════════════════════════════════════════════ */

const char *os_arch(void) {
#if defined(__aarch64__) || defined(__arm64__)
    return "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
    return "x64";
#elif defined(__i386__)  || defined(_M_IX86)
    return "x86";
#elif defined(__arm__)   || defined(_M_ARM)
    return "arm";
#elif defined(__riscv)
    return "riscv64";
#else
    return "unknown";
#endif
}

const char *os_platform(void) {
#if defined(__APPLE__)
    return "darwin";
#elif defined(__linux__)
    return "linux";
#elif defined(_WIN32)
    return "win32";
#elif defined(__FreeBSD__)
    return "freebsd";
#else
    return "unknown";
#endif
}

const char *os_endianness(void) {
    /* Runtime probe — correct for any architecture */
    const uint16_t probe = 1;
    return (*(const uint8_t *)&probe == 1) ? "LE" : "BE";
}

const char *os_eol(void) {
#if defined(_WIN32)
    return "\r\n";
#else
    return "\n";
#endif
}

const char *os_dev_null(void) {
#if defined(_WIN32)
    return "\\\\.\\NUL";
#else
    return "/dev/null";
#endif
}

/* os_target — LLVM-style target triple as a string, fully resolved at compile time.
 *
 * Format:  <arch>-<vendor>-<os>
 * Used internally; the CodeLang API exposes the typed Target enum instead.
 */
const char *os_target(void) {
#if   (defined(__aarch64__) || defined(__arm64__)) && defined(__APPLE__)
    return "arm64-apple-darwin";
#elif defined(__x86_64__) && defined(__APPLE__)
    return "x86_64-apple-darwin";
#elif defined(__aarch64__) || defined(__arm64__)
    return "aarch64-unknown-linux";
#elif defined(__x86_64__) || defined(_M_X64)
    return "x86_64-unknown-linux";
#elif defined(_WIN32)
    return "x86_64-pc-windows";
#elif defined(__FreeBSD__)
    return "x86_64-unknown-freebsd";
#else
    return "unknown-unknown-unknown";
#endif
}

/* os_target_tag — integer discriminant for the Target enum.
 *
 * Tag values mirror the CodeLang enum declaration order:
 *   0  Arm64AppleDarwin    arm64-apple-darwin
 *   1  X8664AppleDarwin    x86_64-apple-darwin
 *   2  Aarch64UnknownLinux aarch64-unknown-linux
 *   3  X8664UnknownLinux   x86_64-unknown-linux
 *   4  X8664PcWindows      x86_64-pc-windows
 *   5  X8664UnknownFreebsd x86_64-unknown-freebsd
 *   6  Unknown             unknown-unknown-unknown
 *
 * All branches resolved by the C preprocessor — zero runtime cost.
 */
int os_target_tag(void) {
#if   (defined(__aarch64__) || defined(__arm64__)) && defined(__APPLE__)
    return 0;
#elif defined(__x86_64__) && defined(__APPLE__)
    return 1;
#elif defined(__aarch64__) || defined(__arm64__)
    return 2;
#elif defined(__x86_64__) || defined(_M_X64)
    return 3;
#elif defined(_WIN32)
    return 4;
#elif defined(__FreeBSD__)
    return 5;
#else
    return 6;
#endif
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. OS identity  (uname)
 * ═══════════════════════════════════════════════════════════════════════════ */

static struct utsname g_uname;
static int            g_uname_ok = -1;

static void ensure_uname(void) {
    if (g_uname_ok < 0)
        g_uname_ok = uname(&g_uname);
}

const char *os_type(void) {
    ensure_uname();
    return g_uname_ok == 0 ? g_uname.sysname : "unknown";
}

const char *os_release(void) {
    ensure_uname();
    return g_uname_ok == 0 ? g_uname.release : "unknown";
}

const char *os_version(void) {
    ensure_uname();
    return g_uname_ok == 0 ? g_uname.version : "unknown";
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Machine
 * ═══════════════════════════════════════════════════════════════════════════ */

const char *os_hostname(void) {
    static char buf[256];
    if (gethostname(buf, sizeof(buf)) == 0) return buf;
    return "unknown";
}

const char *os_homedir(void) {
    const char *h = getenv("HOME");
    if (h) return h;
    struct passwd *pw = getpwuid(getuid());
    return pw ? pw->pw_dir : "/";
}

const char *os_tmpdir(void) {
    const char *t = getenv("TMPDIR");
    if (t) {
        /* TMPDIR on macOS often has a trailing slash — strip it */
        static char buf[512];
        strncpy(buf, t, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
        size_t n = strlen(buf);
        if (n > 1 && buf[n - 1] == '/') buf[n - 1] = '\0';
        return buf;
    }
#if defined(__APPLE__)
    return "/tmp";
#elif defined(__linux__)
    return "/tmp";
#else
    return "/tmp";
#endif
}

int64_t os_uptime(void) {
#if defined(__APPLE__)
    struct timeval boottime;
    size_t len = sizeof(boottime);
    if (sysctlbyname("kern.boottime", &boottime, &len, NULL, 0) == 0) {
        struct timeval now;
        gettimeofday(&now, NULL);
        return (int64_t)(now.tv_sec - boottime.tv_sec);
    }
    return 0;
#elif defined(__linux__)
    struct sysinfo si;
    if (sysinfo(&si) == 0) return (int64_t)si.uptime;
    return 0;
#else
    return 0;
#endif
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Memory  (bytes as int64)
 * ═══════════════════════════════════════════════════════════════════════════ */

int64_t os_totalmem(void) {
#if defined(__APPLE__)
    int64_t mem = 0;
    size_t  len = sizeof(mem);
    if (sysctlbyname("hw.memsize", &mem, &len, NULL, 0) == 0) return mem;
    return 0;
#elif defined(__linux__)
    struct sysinfo si;
    if (sysinfo(&si) == 0)
        return (int64_t)si.totalram * (int64_t)si.mem_unit;
    return 0;
#else
    return 0;
#endif
}

int64_t os_freemem(void) {
#if defined(__APPLE__)
    mach_port_t           host   = mach_host_self();
    vm_size_t             pgsz   = 0;
    host_page_size(host, &pgsz);
    vm_statistics64_data_t stats;
    mach_msg_type_number_t cnt   = HOST_VM_INFO64_COUNT;
    if (host_statistics64(host, HOST_VM_INFO64,
                          (host_info64_t)&stats, &cnt) == KERN_SUCCESS) {
        return (int64_t)(stats.free_count + stats.inactive_count) * (int64_t)pgsz;
    }
    return 0;
#elif defined(__linux__)
    struct sysinfo si;
    if (sysinfo(&si) == 0)
        return (int64_t)si.freeram * (int64_t)si.mem_unit;
    return 0;
#else
    return 0;
#endif
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. CPU
 * ═══════════════════════════════════════════════════════════════════════════ */

int32_t os_cpu_count(void) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return (n > 0) ? (int32_t)n : 1;
}

const char *os_cpu_model(void) {
    static char buf[256] = "";
    if (buf[0]) return buf;

#if defined(__APPLE__)
    size_t len = sizeof(buf);
    if (sysctlbyname("machdep.cpu.brand_string", buf, &len, NULL, 0) == 0)
        return buf;
    /* ARM / Apple Silicon fallback */
    len = sizeof(buf);
    if (sysctlbyname("hw.model", buf, &len, NULL, 0) == 0)
        return buf;
#elif defined(__linux__)
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            if (strncmp(line, "model name", 10) == 0) {
                char *col = strchr(line, ':');
                if (col) {
                    col += 2;
                    size_t n = strlen(col);
                    if (n > 0 && col[n-1] == '\n') col[n-1] = '\0';
                    strncpy(buf, col, sizeof(buf) - 1);
                    fclose(f);
                    return buf;
                }
            }
        }
        fclose(f);
    }
#endif

    strncpy(buf, "Unknown CPU", sizeof(buf) - 1);
    return buf;
}

int32_t os_cpu_speed(void) {
    /* Returns MHz. */
#if defined(__APPLE__)
    int64_t freq = 0;
    size_t  len  = sizeof(freq);
    /* hw.cpufrequency not available on Apple Silicon; use hw.tbfrequency as proxy */
    if (sysctlbyname("hw.cpufrequency", &freq, &len, NULL, 0) == 0)
        return (int32_t)(freq / 1000000LL);
    /* Apple Silicon: get from hw.tbfrequency (timebase) — approximation */
    if (sysctlbyname("hw.tbfrequency", &freq, &len, NULL, 0) == 0 && freq > 0)
        return (int32_t)(freq / 1000000LL);
    return 0;
#elif defined(__linux__)
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            if (strncmp(line, "cpu MHz", 7) == 0) {
                char *col = strchr(line, ':');
                if (col) {
                    fclose(f);
                    return (int32_t)atof(col + 2);
                }
            }
        }
        fclose(f);
    }
    return 0;
#else
    return 0;
#endif
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. User
 * ═══════════════════════════════════════════════════════════════════════════ */

const char *os_username(void) {
    struct passwd *pw = getpwuid(getuid());
    if (pw) return pw->pw_name;
    const char *u = getenv("USER");
    return u ? u : "unknown";
}

int32_t os_uid(void) {
    return (int32_t)getuid();
}

int32_t os_gid(void) {
    return (int32_t)getgid();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. GPU  (best-effort, no extra frameworks)
 * ═══════════════════════════════════════════════════════════════════════════ */

/* os_gpu_is_available() — compile-time guarantee via preprocessor.
 *
 * Returns 1 when the build target is known to have a GPU:
 *   macOS        → always 1 (all Metal-capable Macs have at least one GPU)
 *   Linux x86-64 → 1 (desktop/server assumption; override with runtime check)
 *   Linux arm64  → 1 (e.g. Raspberry Pi 4+, Jetson, Apple Silicon)
 *   Windows      → 1 (all modern Windows systems have GPU drivers)
 *   other        → 0 (conservative)
 *
 * The function body is a single `return <constant>` so the C compiler
 * (clang) folds it to an immediate at -O0+, making it truly compile-time.
 */
int32_t os_gpu_is_available(void) {
#if defined(__APPLE__)
    return 1;   /* macOS: Metal always present */
#elif defined(__linux__)
    return 1;   /* Linux desktop/embedded: assume GPU */
#elif defined(_WIN32)
    return 1;   /* Windows: DirectX/Vulkan driver assumed */
#else
    return 0;
#endif
}

/* os_npu_is_available() — compile-time guarantee via preprocessor.
 *
 * Returns 1 only when the build target is *guaranteed* to include
 * a dedicated neural-processing unit:
 *   macOS arm64  → 1 (all Apple Silicon: M1/M2/M3/… always have ANE)
 *   others       → 0 (no compile-time NPU guarantee)
 *
 * Runtime detection (os_has_npu) may return 1 on additional platforms
 * (Qualcomm Hexagon, Intel Meteor Lake NPU) that cannot be proven at
 * compile time without feature-test macros from the vendor SDK.
 */
int32_t os_npu_is_available(void) {
#if defined(__APPLE__) && defined(__aarch64__)
    return 1;   /* Apple Silicon: Neural Engine always present */
#else
    return 0;
#endif
}

static char    g_gpu_model[512] = "";
static int32_t g_gpu_count      = -1;

static void init_gpu(void) {
    if (g_gpu_count >= 0) return;

#if defined(__APPLE__)
    /* Apple Silicon: integrated GPU is part of the M-series SoC */
    char brand[256] = "";
    size_t len = sizeof(brand);
    if (sysctlbyname("machdep.cpu.brand_string", brand, &len, NULL, 0) == 0
        && strstr(brand, "Apple") != NULL) {
        snprintf(g_gpu_model, sizeof(g_gpu_model), "%s GPU", brand);
        g_gpu_count = 1;
        return;
    }
    /* Intel Mac fallback: use hw.model */
    len = sizeof(brand);
    if (sysctlbyname("hw.model", brand, &len, NULL, 0) == 0) {
        snprintf(g_gpu_model, sizeof(g_gpu_model), "GPU (%s)", brand);
        g_gpu_count = 1;
        return;
    }
    strncpy(g_gpu_model, "Unknown GPU", sizeof(g_gpu_model) - 1);
    g_gpu_count = 1;

#elif defined(__linux__)
    /* Try /sys/class/drm for render nodes (d128, d129, ...) */
    int32_t count = 0;
    for (int i = 128; i < 136; i++) {
        char path[64];
        snprintf(path, sizeof(path), "/sys/class/drm/renderD%d", i);
        if (access(path, F_OK) == 0) count++;
    }
    if (count > 0) {
        g_gpu_count = count;
        /* Try to read vendor name from first card */
        FILE *f = fopen("/sys/class/drm/card0/device/label", "r");
        if (!f) f = fopen("/sys/class/drm/card0/device/uevent", "r");
        if (f) {
            char line[256];
            while (fgets(line, sizeof(line), f)) {
                if (strncmp(line, "DRIVER=", 7) == 0) {
                    line[strcspn(line, "\n")] = '\0';
                    snprintf(g_gpu_model, sizeof(g_gpu_model), "GPU (%s)", line + 7);
                    fclose(f);
                    return;
                }
            }
            fclose(f);
        }
        strncpy(g_gpu_model, "GPU (DRM device)", sizeof(g_gpu_model) - 1);
    } else {
        g_gpu_count = 0;
        strncpy(g_gpu_model, "None", sizeof(g_gpu_model) - 1);
    }

#else
    g_gpu_count = 0;
    strncpy(g_gpu_model, "None", sizeof(g_gpu_model) - 1);
#endif
}

int32_t os_gpu_count(void) {
    init_gpu();
    return g_gpu_count;
}

const char *os_gpu_model(int32_t i) {
    init_gpu();
    (void)i;   /* single-GPU for now; multi-GPU future work */
    return g_gpu_model;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. NPU  (Apple Neural Engine / other accelerators)
 * ═══════════════════════════════════════════════════════════════════════════ */

int32_t os_has_npu(void) {
#if defined(__APPLE__)
    char brand[256] = "";
    size_t len = sizeof(brand);
    if (sysctlbyname("machdep.cpu.brand_string", brand, &len, NULL, 0) == 0) {
        /* Apple Neural Engine present on A11 Bionic (2017) and all M-series chips */
        if (strstr(brand, "Apple M") != NULL) return 1;
        /* A-series: A11 and later.  We cannot easily check version from brand_string
           alone, so accept any "Apple A" as a conservative approximation. */
        if (strstr(brand, "Apple A") != NULL) return 1;
    }
    return 0;
#elif defined(__linux__)
    /* Check for Qualcomm Hexagon NPU or Intel NPU (basic) */
    if (access("/dev/qcom_npu0", F_OK) == 0) return 1;
    if (access("/sys/bus/platform/drivers/qcom_npu", F_OK) == 0) return 1;
    /* Intel NPU (Meteor Lake+) */
    if (access("/sys/class/accel/accel0", F_OK) == 0) return 1;
    return 0;
#else
    return 0;
#endif
}

const char *os_npu_name(void) {
    static char buf[128] = "";
    if (buf[0]) return buf;

#if defined(__APPLE__)
    char brand[256] = "";
    size_t len = sizeof(brand);
    if (sysctlbyname("machdep.cpu.brand_string", brand, &len, NULL, 0) == 0) {
        if (strstr(brand, "Apple M") != NULL || strstr(brand, "Apple A") != NULL) {
            snprintf(buf, sizeof(buf), "%s Neural Engine", brand);
            return buf;
        }
    }
    strncpy(buf, "None", sizeof(buf) - 1);
#elif defined(__linux__)
    if (access("/dev/qcom_npu0", F_OK) == 0) {
        strncpy(buf, "Qualcomm Hexagon NPU", sizeof(buf) - 1);
    } else if (access("/sys/class/accel/accel0", F_OK) == 0) {
        strncpy(buf, "Intel NPU", sizeof(buf) - 1);
    } else {
        strncpy(buf, "None", sizeof(buf) - 1);
    }
#else
    strncpy(buf, "None", sizeof(buf) - 1);
#endif
    return buf;
}
