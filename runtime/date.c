/**
 * CodeLang date/time runtime — Temporal-style API with Intl formatting.
 *
 * Provides:
 *   Now            — current instant / zoned date-time helpers
 *   Instant        — nanosecond-precision Unix timestamp
 *   PlainDate      — calendar date (no time, no timezone)
 *   PlainTime      — wall-clock time (no date, no timezone)
 *   PlainDateTime  — date + time (no timezone)
 *   ZonedDateTime  — date + time + IANA timezone identifier
 *   Duration       — a span of time with year/month/day/HMS/ms components
 *   DateTimeFormat — Intl locale-aware formatter via strftime + setlocale
 *
 * Timezone implementation:
 *   Uses the POSIX TZ environment variable trick (setenv("TZ", tz_id, 1) +
 *   tzset() + localtime_r) for conversion between UTC and named timezones.
 *   This requires the system timezone database (/usr/share/zoneinfo or
 *   /usr/lib/zoneinfo) to be present.  Thread-safety note: TZ manipulation
 *   is process-global; avoid concurrent timezone conversion from multiple
 *   threads.  For production use, prefer a dedicated tz library.
 *
 * Compile: clang -O2  (POSIX; macOS & Linux)
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <locale.h>
#include <ctype.h>
#include <math.h>
#include <unistd.h>

/* ── Structures ─────────────────────────────────────────────────────────────── */

typedef struct { int64_t epoch_ns; } Instant;

typedef struct { int year; int month; int day; } PlainDate;

typedef struct {
    int hour; int minute; int second; int millisecond;
} PlainTime;

typedef struct {
    int year; int month; int day;
    int hour; int minute; int second; int millisecond;
} PlainDateTime;

typedef struct {
    int64_t  epoch_ns;
    char    *tz_id;
} ZonedDateTime;

typedef struct {
    int32_t years; int32_t months; int32_t days;
    int32_t hours; int32_t minutes; int32_t seconds;
    int32_t milliseconds;
} Duration;

typedef struct {
    char *locale;
    char *date_style;   /* "full" | "long" | "medium" | "short" | "" */
    char *time_style;   /* "full" | "long" | "medium" | "short" | "" */
    char *tz_id;
} DateTimeFormat;

/* ── Internal helpers ────────────────────────────────────────────────────────── */

/* Convert epoch_ns to a struct tm in the given IANA timezone.
 * Uses the POSIX TZ env trick; not thread-safe for concurrent tz switches. */
static void ns_to_tm(int64_t epoch_ns, const char *tz_id, struct tm *out, int *out_off_sec) {
    time_t epoch_s = (time_t)(epoch_ns / 1000000000LL);

    if (!tz_id || tz_id[0] == '\0' ||
        strcmp(tz_id, "UTC") == 0  || strcmp(tz_id, "Etc/UTC") == 0) {
        gmtime_r(&epoch_s, out);
        if (out_off_sec) *out_off_sec = 0;
        return;
    }

    /* Save old TZ */
    char *old_tz = getenv("TZ");
    char  saved[512] = "";
    if (old_tz) {
        strncpy(saved, old_tz, sizeof(saved) - 1);
        saved[sizeof(saved) - 1] = '\0';
    }

    setenv("TZ", tz_id, 1);
    tzset();
    localtime_r(&epoch_s, out);
    if (out_off_sec) *out_off_sec = (int)out->tm_gmtoff;

    /* Restore old TZ */
    if (old_tz && saved[0])
        setenv("TZ", saved, 1);
    else
        unsetenv("TZ");
    tzset();
}

/* Convert a struct tm (local wall-clock in given tz) back to epoch_ns.
 * Uses the same TZ trick; approximated for months/years arithmetic. */
static int64_t tm_to_ns(struct tm *t, const char *tz_id) {
    time_t epoch_s;

    if (!tz_id || tz_id[0] == '\0' ||
        strcmp(tz_id, "UTC") == 0  || strcmp(tz_id, "Etc/UTC") == 0) {
        /* timegm is not POSIX but available on Linux/macOS */
#ifdef __linux__
        epoch_s = timegm(t);
#else
        /* macOS / BSD: use mktime with TZ=UTC trick */
        char *old_tz = getenv("TZ");
        char  saved[512] = "";
        if (old_tz) { strncpy(saved, old_tz, sizeof(saved)-1); }
        setenv("TZ", "UTC", 1); tzset();
        epoch_s = mktime(t);
        if (old_tz && saved[0]) setenv("TZ", saved, 1); else unsetenv("TZ");
        tzset();
#endif
    } else {
        char *old_tz = getenv("TZ");
        char  saved[512] = "";
        if (old_tz) { strncpy(saved, old_tz, sizeof(saved)-1); }
        setenv("TZ", tz_id, 1); tzset();
        epoch_s = mktime(t);
        if (old_tz && saved[0]) setenv("TZ", saved, 1); else unsetenv("TZ");
        tzset();
    }
    return (int64_t)epoch_s * 1000000000LL;
}

/* Check if year is a leap year */
static int is_leap(int y) {
    return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
}

/* Days in month */
static int days_in_month(int y, int m) {
    static const int dim[] = {0,31,28,31,30,31,30,31,31,30,31,30,31};
    if (m == 2 && is_leap(y)) return 29;
    return (m >= 1 && m <= 12) ? dim[m] : 30;
}

/* Build a struct tm from a PlainDateTime's fields (in UTC/naive context) */
static struct tm make_tm(int y, int mo, int d, int h, int mi, int s) {
    struct tm t;
    memset(&t, 0, sizeof(t));
    t.tm_year  = y - 1900;
    t.tm_mon   = mo - 1;
    t.tm_mday  = d;
    t.tm_hour  = h;
    t.tm_min   = mi;
    t.tm_sec   = s;
    t.tm_isdst = -1;
    return t;
}

/* ── strftime format strings by style ────────────────────────────────────────── */

/* Date formats (locale-aware via strftime) */
static const char *date_fmt(const char *style) {
    if (!style || style[0] == '\0') return "";
    if (strcmp(style, "full")   == 0) return "%A, %B %e, %Y";     /* Thursday, May 28, 2026 */
    if (strcmp(style, "long")   == 0) return "%B %e, %Y";          /* May 28, 2026 */
    if (strcmp(style, "medium") == 0) return "%b %e, %Y";          /* May 28, 2026 */
    if (strcmp(style, "short")  == 0) return "%m/%d/%y";           /* 05/28/26 */
    return "%Y-%m-%d";
}

/* Time formats */
static const char *time_fmt(const char *style) {
    if (!style || style[0] == '\0') return "";
    if (strcmp(style, "full")   == 0) return "%I:%M:%S %p %Z";    /* 10:30:00 PM EDT */
    if (strcmp(style, "long")   == 0) return "%I:%M:%S %p %Z";
    if (strcmp(style, "medium") == 0) return "%I:%M:%S %p";        /* 10:30:00 PM */
    if (strcmp(style, "short")  == 0) return "%I:%M %p";           /* 10:30 PM */
    return "%H:%M:%S";
}

/* Combined format (date + " " + time, omitting empty parts) */
static char *apply_format(const char *d_style, const char *t_style,
                           const char *tz_id, struct tm *tm_val) {
    const char *df = date_fmt(d_style);
    const char *tf = time_fmt(t_style);

    char combined[256] = "";
    if (df && df[0] && tf && tf[0]) snprintf(combined, sizeof(combined), "%s, %s", df, tf);
    else if (df && df[0])           snprintf(combined, sizeof(combined), "%s", df);
    else if (tf && tf[0])           snprintf(combined, sizeof(combined), "%s", tf);
    else                            snprintf(combined, sizeof(combined), "%%Y-%%m-%%dT%%H:%%M:%%S");

    /* Apply locale if it looks like a known locale; otherwise use system default */
    char buf[512] = "";
    strftime(buf, sizeof(buf), combined, tm_val);
    (void)tz_id;
    return strdup(buf);
}

/* ── Now ─────────────────────────────────────────────────────────────────────── */

Instant *date_now_instant(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    Instant *inst = (Instant *)malloc(sizeof(Instant));
    inst->epoch_ns = (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
    return inst;
}

PlainDateTime *date_now_plain_date_time_iso(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm t;
    time_t s = (time_t)ts.tv_sec;
    localtime_r(&s, &t);

    PlainDateTime *dt = (PlainDateTime *)malloc(sizeof(PlainDateTime));
    dt->year        = t.tm_year + 1900;
    dt->month       = t.tm_mon  + 1;
    dt->day         = t.tm_mday;
    dt->hour        = t.tm_hour;
    dt->minute      = t.tm_min;
    dt->second      = t.tm_sec;
    dt->millisecond = (int)(ts.tv_nsec / 1000000LL);
    return dt;
}

ZonedDateTime *date_now_zoned_date_time_iso(const char *tz_id) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ZonedDateTime *zdt = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    zdt->epoch_ns = (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
    zdt->tz_id    = strdup(tz_id ? tz_id : "UTC");
    return zdt;
}

const char *date_now_timezone_id(void) {
    /* Try reading /etc/timezone (Debian/Ubuntu) */
    FILE *f = fopen("/etc/timezone", "r");
    if (f) {
        static char tz_buf[128];
        if (fgets(tz_buf, sizeof(tz_buf), f)) {
            fclose(f);
            /* Strip trailing newline */
            size_t len = strlen(tz_buf);
            if (len > 0 && tz_buf[len-1] == '\n') tz_buf[len-1] = '\0';
            return strdup(tz_buf);
        }
        fclose(f);
    }
    /* Try TZ environment variable */
    const char *tz = getenv("TZ");
    if (tz && tz[0]) return strdup(tz);
    /* macOS: readlink /etc/localtime → .../zoneinfo/America/New_York */
    char link[512];
    ssize_t n = readlink("/etc/localtime", link, sizeof(link) - 1);
    if (n > 0) {
        link[n] = '\0';
        const char *zi = strstr(link, "zoneinfo/");
        if (zi) return strdup(zi + 9);  /* skip "zoneinfo/" */
    }
    return strdup("UTC");
}

/* ── Instant ──────────────────────────────────────────────────────────────────── */

Instant *instant_from_epoch_ms(int64_t ms) {
    Instant *inst = (Instant *)malloc(sizeof(Instant));
    inst->epoch_ns = ms * 1000000LL;
    return inst;
}

Instant *instant_from_epoch_s(int64_t s) {
    Instant *inst = (Instant *)malloc(sizeof(Instant));
    inst->epoch_ns = s * 1000000000LL;
    return inst;
}

Instant *instant_from_iso(const char *iso) {
    struct tm t;
    memset(&t, 0, sizeof(t));
    int ms = 0;
    /* Try "YYYY-MM-DDTHH:MM:SS.mmmZ" or "YYYY-MM-DDTHH:MM:SSZ" */
    const char *p = strptime(iso, "%Y-%m-%dT%H:%M:%S", &t);
    if (p && (*p == '.' || *p == ',')) {
        p++;
        int frac = 0, digits = 0;
        while (*p && isdigit((unsigned char)*p) && digits < 3) {
            frac = frac * 10 + (*p++ - '0'); digits++;
        }
        while (digits++ < 3) frac *= 10;
        ms = frac;
        while (*p && isdigit((unsigned char)*p)) p++;
    }
    t.tm_isdst = -1;
    /* Treat as UTC */
    Instant *inst = (Instant *)malloc(sizeof(Instant));
    int64_t ns = tm_to_ns(&t, "UTC");
    inst->epoch_ns = ns + (int64_t)ms * 1000000LL;
    return inst;
}

int64_t instant_epoch_ms(Instant *inst) {
    return inst ? inst->epoch_ns / 1000000LL : 0;
}

int64_t instant_epoch_s(Instant *inst) {
    return inst ? inst->epoch_ns / 1000000000LL : 0;
}

int64_t instant_epoch_ns(Instant *inst) {
    return inst ? inst->epoch_ns : 0;
}

const char *instant_to_string(Instant *inst) {
    if (!inst) return strdup("");
    time_t s  = (time_t)(inst->epoch_ns / 1000000000LL);
    int    ms = (int)((inst->epoch_ns % 1000000000LL) / 1000000LL);
    int    ns_rem = (int)(inst->epoch_ns % 1000000LL);
    struct tm t;
    gmtime_r(&s, &t);
    char buf[64];
    if (ns_rem)
        snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03d%06dZ",
                 t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                 t.tm_hour, t.tm_min, t.tm_sec, ms, ns_rem);
    else
        snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                 t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                 t.tm_hour, t.tm_min, t.tm_sec, ms);
    return strdup(buf);
}

ZonedDateTime *instant_to_zoned_date_time_iso(Instant *inst, const char *tz_id) {
    ZonedDateTime *zdt = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    zdt->epoch_ns = inst ? inst->epoch_ns : 0;
    zdt->tz_id    = strdup(tz_id ? tz_id : "UTC");
    return zdt;
}

Instant *instant_add(Instant *inst, Duration *dur) {
    Instant *r = (Instant *)malloc(sizeof(Instant));
    int64_t delta_ns =
        (int64_t)dur->hours   * 3600000000000LL +
        (int64_t)dur->minutes *   60000000000LL +
        (int64_t)dur->seconds *    1000000000LL +
        (int64_t)dur->milliseconds * 1000000LL  +
        /* year/month/day: approximate, use 365d/30d */
        (int64_t)dur->years  * 365LL * 86400000000000LL +
        (int64_t)dur->months *  30LL * 86400000000000LL +
        (int64_t)dur->days        *    86400000000000LL;
    r->epoch_ns = inst->epoch_ns + delta_ns;
    return r;
}

Instant *instant_subtract(Instant *inst, Duration *dur) {
    Duration neg = *dur;
    neg.years *= -1; neg.months *= -1; neg.days *= -1;
    neg.hours *= -1; neg.minutes *= -1; neg.seconds *= -1; neg.milliseconds *= -1;
    return instant_add(inst, &neg);
}

Duration *instant_until(Instant *a, Instant *b) {
    Duration *d = (Duration *)calloc(1, sizeof(Duration));
    int64_t diff_ms = (b->epoch_ns - a->epoch_ns) / 1000000LL;
    int sign = (diff_ms < 0) ? -1 : 1;
    int64_t abs_ms = diff_ms < 0 ? -diff_ms : diff_ms;
    d->seconds      = (int32_t)(sign * (int64_t)(abs_ms / 1000 % 60));
    d->minutes      = (int32_t)(sign * (int64_t)(abs_ms / 60000 % 60));
    d->hours        = (int32_t)(sign * (int64_t)(abs_ms / 3600000 % 24));
    d->days         = (int32_t)(sign * (int64_t)(abs_ms / 86400000));
    d->milliseconds = (int32_t)(sign * (int64_t)(abs_ms % 1000));
    return d;
}

int32_t instant_compare(Instant *a, Instant *b) {
    if (a->epoch_ns < b->epoch_ns) return -1;
    if (a->epoch_ns > b->epoch_ns) return  1;
    return 0;
}

void instant_free(Instant *inst) { free(inst); }

/* ── PlainDate ────────────────────────────────────────────────────────────────── */

PlainDate *plain_date_from(int32_t y, int32_t m, int32_t d) {
    PlainDate *pd = (PlainDate *)malloc(sizeof(PlainDate));
    pd->year = y; pd->month = m; pd->day = d;
    return pd;
}

PlainDate *plain_date_from_iso(const char *iso) {
    int y = 0, m = 1, d = 1;
    sscanf(iso, "%d-%d-%d", &y, &m, &d);
    return plain_date_from(y, m, d);
}

int32_t plain_date_year(PlainDate *pd)  { return pd->year;  }
int32_t plain_date_month(PlainDate *pd) { return pd->month; }
int32_t plain_date_day(PlainDate *pd)   { return pd->day;   }

int32_t plain_date_day_of_week(PlainDate *pd) {
    /* Tomohiko Sakamoto's algorithm; 0=Sun, convert to ISO: 1=Mon..7=Sun */
    static const int t[] = {0,3,2,5,0,3,5,1,4,6,2,4};
    int y = pd->year, m = pd->month, d = pd->day;
    if (m < 3) y--;
    int dow = (y + y/4 - y/100 + y/400 + t[m-1] + d) % 7;
    /* 0=Sun→7, 1=Mon→1 */
    return dow == 0 ? 7 : dow;
}

int32_t plain_date_day_of_year(PlainDate *pd) {
    static const int cum[] = {0,0,31,59,90,120,151,181,212,243,273,304,334};
    int extra = (pd->month > 2 && is_leap(pd->year)) ? 1 : 0;
    return cum[pd->month] + pd->day + extra;
}

int32_t plain_date_days_in_month(PlainDate *pd) {
    return days_in_month(pd->year, pd->month);
}

int32_t plain_date_days_in_year(PlainDate *pd) {
    return is_leap(pd->year) ? 366 : 365;
}

int32_t plain_date_in_leap_year(PlainDate *pd) {
    return is_leap(pd->year) ? 1 : 0;
}

const char *plain_date_to_string(PlainDate *pd) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d", pd->year, pd->month, pd->day);
    return strdup(buf);
}

PlainDate *plain_date_add(PlainDate *pd, Duration *dur) {
    int y = pd->year + dur->years;
    int m = pd->month + dur->months;
    int d = pd->day + dur->days;
    /* Carry months */
    while (m > 12) { m -= 12; y++; }
    while (m < 1)  { m += 12; y--; }
    /* Clamp day to month length */
    int dim = days_in_month(y, m);
    if (d > dim) d = dim;
    if (d < 1)   d = 1;
    /* Add day offset from hours/minutes/seconds (rare but correct) */
    struct tm t = make_tm(y, m, d, 0, 0, 0);
    int64_t extra_days =
        (int64_t)dur->hours / 24 +
        (int64_t)dur->minutes / 1440 +
        (int64_t)dur->seconds / 86400;
    t.tm_mday += (int)extra_days;
    mktime(&t);  /* normalise */
    PlainDate *r = (PlainDate *)malloc(sizeof(PlainDate));
    r->year = t.tm_year + 1900; r->month = t.tm_mon + 1; r->day = t.tm_mday;
    return r;
}

PlainDate *plain_date_subtract(PlainDate *pd, Duration *dur) {
    Duration neg = *dur;
    neg.years *= -1; neg.months *= -1; neg.days *= -1;
    neg.hours *= -1; neg.minutes *= -1; neg.seconds *= -1; neg.milliseconds *= -1;
    return plain_date_add(pd, &neg);
}

Duration *plain_date_until(PlainDate *a, PlainDate *b) {
    struct tm ta = make_tm(a->year, a->month, a->day, 0, 0, 0);
    struct tm tb = make_tm(b->year, b->month, b->day, 0, 0, 0);
    setenv("TZ", "UTC", 1); tzset();
    time_t sa = mktime(&ta), sb = mktime(&tb);
    unsetenv("TZ"); tzset();
    int64_t diff_days = (int64_t)((double)(sb - sa) / 86400.0 + 0.5);
    Duration *d = (Duration *)calloc(1, sizeof(Duration));
    d->days = (int32_t)diff_days;
    return d;
}

int32_t plain_date_compare(PlainDate *a, PlainDate *b) {
    if (a->year  != b->year)  return a->year  < b->year  ? -1 : 1;
    if (a->month != b->month) return a->month < b->month ? -1 : 1;
    if (a->day   != b->day)   return a->day   < b->day   ? -1 : 1;
    return 0;
}

void plain_date_free(PlainDate *pd) { free(pd); }

/* ── PlainTime ────────────────────────────────────────────────────────────────── */

PlainTime *plain_time_from(int32_t h, int32_t mi, int32_t s, int32_t ms) {
    PlainTime *pt = (PlainTime *)malloc(sizeof(PlainTime));
    pt->hour = h; pt->minute = mi; pt->second = s; pt->millisecond = ms;
    return pt;
}

PlainTime *plain_time_from_iso(const char *iso) {
    int h = 0, mi = 0, s = 0, ms = 0;
    sscanf(iso, "%d:%d:%d.%d", &h, &mi, &s, &ms);
    return plain_time_from(h, mi, s, ms);
}

int32_t plain_time_hour(PlainTime *pt)        { return pt->hour; }
int32_t plain_time_minute(PlainTime *pt)      { return pt->minute; }
int32_t plain_time_second(PlainTime *pt)      { return pt->second; }
int32_t plain_time_millisecond(PlainTime *pt) { return pt->millisecond; }

const char *plain_time_to_string(PlainTime *pt) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d.%03d",
             pt->hour, pt->minute, pt->second, pt->millisecond);
    return strdup(buf);
}

int32_t plain_time_compare(PlainTime *a, PlainTime *b) {
    int64_t ma = (int64_t)a->hour*3600000 + a->minute*60000 + a->second*1000 + a->millisecond;
    int64_t mb = (int64_t)b->hour*3600000 + b->minute*60000 + b->second*1000 + b->millisecond;
    return (ma < mb) ? -1 : (ma > mb) ? 1 : 0;
}

void plain_time_free(PlainTime *pt) { free(pt); }

/* ── PlainDateTime ───────────────────────────────────────────────────────────── */

PlainDateTime *plain_date_time_from(int32_t y, int32_t mo, int32_t d,
                                    int32_t h, int32_t mi, int32_t s, int32_t ms) {
    PlainDateTime *dt = (PlainDateTime *)malloc(sizeof(PlainDateTime));
    dt->year = y; dt->month = mo; dt->day = d;
    dt->hour = h; dt->minute = mi; dt->second = s; dt->millisecond = ms;
    return dt;
}

PlainDateTime *plain_date_time_from_iso(const char *iso) {
    struct tm t;
    memset(&t, 0, sizeof(t));
    int ms = 0;
    const char *p = strptime(iso, "%Y-%m-%dT%H:%M:%S", &t);
    if (!p) p = strptime(iso, "%Y-%m-%d %H:%M:%S", &t);
    if (p && (*p == '.' || *p == ',')) {
        p++;
        int frac = 0, digits = 0;
        while (*p && isdigit((unsigned char)*p) && digits < 3) {
            frac = frac * 10 + (*p++ - '0'); digits++;
        }
        while (digits++ < 3) frac *= 10;
        ms = frac;
    }
    return plain_date_time_from(t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                                 t.tm_hour, t.tm_min, t.tm_sec, ms);
}

int32_t plain_date_time_year(PlainDateTime *dt)        { return dt->year; }
int32_t plain_date_time_month(PlainDateTime *dt)       { return dt->month; }
int32_t plain_date_time_day(PlainDateTime *dt)         { return dt->day; }
int32_t plain_date_time_hour(PlainDateTime *dt)        { return dt->hour; }
int32_t plain_date_time_minute(PlainDateTime *dt)      { return dt->minute; }
int32_t plain_date_time_second(PlainDateTime *dt)      { return dt->second; }
int32_t plain_date_time_millisecond(PlainDateTime *dt) { return dt->millisecond; }

PlainDate *plain_date_time_to_date(PlainDateTime *dt) {
    return plain_date_from(dt->year, dt->month, dt->day);
}

PlainTime *plain_date_time_to_time(PlainDateTime *dt) {
    return plain_time_from(dt->hour, dt->minute, dt->second, dt->millisecond);
}

const char *plain_date_time_to_string(PlainDateTime *dt) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
             dt->year, dt->month, dt->day,
             dt->hour, dt->minute, dt->second, dt->millisecond);
    return strdup(buf);
}

ZonedDateTime *plain_date_time_to_zoned(PlainDateTime *dt, const char *tz_id) {
    struct tm t = make_tm(dt->year, dt->month, dt->day,
                          dt->hour, dt->minute, dt->second);
    int64_t ns = tm_to_ns(&t, tz_id) + (int64_t)dt->millisecond * 1000000LL;
    ZonedDateTime *zdt = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    zdt->epoch_ns = ns;
    zdt->tz_id    = strdup(tz_id ? tz_id : "UTC");
    return zdt;
}

PlainDateTime *plain_date_time_add(PlainDateTime *dt, Duration *dur) {
    /* Convert to a moment, add, convert back — naive (no DST gap handling) */
    struct tm t = make_tm(dt->year, dt->month, dt->day,
                          dt->hour, dt->minute, dt->second);
    t.tm_year  += dur->years;
    t.tm_mon   += dur->months;
    t.tm_mday  += dur->days;
    t.tm_hour  += dur->hours;
    t.tm_min   += dur->minutes;
    t.tm_sec   += dur->seconds;
    mktime(&t);
    int ms = dt->millisecond + dur->milliseconds;
    int carry_s = ms / 1000;
    ms = ms % 1000;
    if (ms < 0) { ms += 1000; carry_s--; }
    t.tm_sec += carry_s;
    mktime(&t);
    return plain_date_time_from(t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                                 t.tm_hour, t.tm_min, t.tm_sec, ms);
}

PlainDateTime *plain_date_time_subtract(PlainDateTime *dt, Duration *dur) {
    Duration neg = *dur;
    neg.years *= -1; neg.months *= -1; neg.days *= -1;
    neg.hours *= -1; neg.minutes *= -1; neg.seconds *= -1; neg.milliseconds *= -1;
    return plain_date_time_add(dt, &neg);
}

int32_t plain_date_time_compare(PlainDateTime *a, PlainDateTime *b) {
    struct tm ta = make_tm(a->year, a->month, a->day, a->hour, a->minute, a->second);
    struct tm tb = make_tm(b->year, b->month, b->day, b->hour, b->minute, b->second);
    setenv("TZ", "UTC", 1); tzset();
    time_t sa = mktime(&ta), sb = mktime(&tb);
    unsetenv("TZ"); tzset();
    if (sa != sb) return sa < sb ? -1 : 1;
    if (a->millisecond != b->millisecond)
        return a->millisecond < b->millisecond ? -1 : 1;
    return 0;
}

void plain_date_time_free(PlainDateTime *dt) { free(dt); }

/* ── ZonedDateTime ───────────────────────────────────────────────────────────── */

ZonedDateTime *zoned_date_time_from(Instant *inst, const char *tz_id) {
    ZonedDateTime *zdt = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    zdt->epoch_ns = inst ? inst->epoch_ns : 0;
    zdt->tz_id    = strdup(tz_id ? tz_id : "UTC");
    return zdt;
}

ZonedDateTime *zoned_date_time_from_iso(const char *iso) {
    /* Parse "YYYY-MM-DDTHH:MM:SS+HH:MM[Tz/Name]" or with Z */
    struct tm t;
    memset(&t, 0, sizeof(t));
    int ms = 0;
    char tz_buf[128] = "UTC";
    const char *p = strptime(iso, "%Y-%m-%dT%H:%M:%S", &t);
    if (p && (*p == '.' || *p == ',')) {
        p++;
        int frac = 0, digits = 0;
        while (*p && isdigit((unsigned char)*p) && digits < 3) {
            frac = frac * 10 + (*p++ - '0'); digits++;
        }
        while (digits++ < 3) frac *= 10;
        ms = frac;
        while (*p && isdigit((unsigned char)*p)) p++;
    }
    /* Parse timezone offset or 'Z' */
    int off_sec = 0;
    if (p && *p == 'Z') {
        p++;
    } else if (p && (*p == '+' || *p == '-')) {
        int sign = (*p++ == '+') ? 1 : -1;
        int oh = 0, om = 0;
        sscanf(p, "%02d:%02d", &oh, &om);
        off_sec = sign * (oh * 3600 + om * 60);
        while (*p && *p != '[') p++;
    }
    /* IANA timezone in brackets: [America/New_York] */
    if (p && *p == '[') {
        p++;
        size_t i = 0;
        while (*p && *p != ']' && i < sizeof(tz_buf)-1) tz_buf[i++] = *p++;
        tz_buf[i] = '\0';
    }
    t.tm_isdst = -1;
    /* Convert using the offset to get UTC epoch */
    setenv("TZ", "UTC", 1); tzset();
    time_t s = mktime(&t);
    unsetenv("TZ"); tzset();
    int64_t ns = ((int64_t)s - (int64_t)off_sec) * 1000000000LL +
                 (int64_t)ms * 1000000LL;
    ZonedDateTime *zdt = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    zdt->epoch_ns = ns;
    zdt->tz_id    = strdup(tz_buf);
    return zdt;
}

static struct tm zdt_to_tm(ZonedDateTime *zdt) {
    struct tm t;
    memset(&t, 0, sizeof(t));
    ns_to_tm(zdt->epoch_ns, zdt->tz_id, &t, NULL);
    return t;
}

int32_t zoned_date_time_year(ZonedDateTime *zdt)        { struct tm t = zdt_to_tm(zdt); return t.tm_year + 1900; }
int32_t zoned_date_time_month(ZonedDateTime *zdt)       { struct tm t = zdt_to_tm(zdt); return t.tm_mon + 1; }
int32_t zoned_date_time_day(ZonedDateTime *zdt)         { struct tm t = zdt_to_tm(zdt); return t.tm_mday; }
int32_t zoned_date_time_hour(ZonedDateTime *zdt)        { struct tm t = zdt_to_tm(zdt); return t.tm_hour; }
int32_t zoned_date_time_minute(ZonedDateTime *zdt)      { struct tm t = zdt_to_tm(zdt); return t.tm_min; }
int32_t zoned_date_time_second(ZonedDateTime *zdt)      { struct tm t = zdt_to_tm(zdt); return t.tm_sec; }
int32_t zoned_date_time_millisecond(ZonedDateTime *zdt) {
    return (int32_t)((zdt->epoch_ns % 1000000000LL) / 1000000LL);
}

const char *zoned_date_time_timezone_id(ZonedDateTime *zdt) {
    return strdup(zdt->tz_id ? zdt->tz_id : "UTC");
}

int64_t zoned_date_time_epoch_ms(ZonedDateTime *zdt) {
    return zdt->epoch_ns / 1000000LL;
}

Instant *zoned_date_time_to_instant(ZonedDateTime *zdt) {
    Instant *inst = (Instant *)malloc(sizeof(Instant));
    inst->epoch_ns = zdt->epoch_ns;
    return inst;
}

PlainDate *zoned_date_time_to_plain_date(ZonedDateTime *zdt) {
    struct tm t = zdt_to_tm(zdt);
    return plain_date_from(t.tm_year+1900, t.tm_mon+1, t.tm_mday);
}

PlainTime *zoned_date_time_to_plain_time(ZonedDateTime *zdt) {
    struct tm t = zdt_to_tm(zdt);
    int ms = (int)((zdt->epoch_ns % 1000000000LL) / 1000000LL);
    return plain_time_from(t.tm_hour, t.tm_min, t.tm_sec, ms);
}

PlainDateTime *zoned_date_time_to_plain_date_time(ZonedDateTime *zdt) {
    struct tm t = zdt_to_tm(zdt);
    int ms = (int)((zdt->epoch_ns % 1000000000LL) / 1000000LL);
    return plain_date_time_from(t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                                 t.tm_hour, t.tm_min, t.tm_sec, ms);
}

ZonedDateTime *zoned_date_time_with_timezone(ZonedDateTime *zdt, const char *tz_id) {
    ZonedDateTime *r = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    r->epoch_ns = zdt->epoch_ns;
    r->tz_id    = strdup(tz_id ? tz_id : "UTC");
    return r;
}

const char *zoned_date_time_to_string(ZonedDateTime *zdt) {
    struct tm t;
    int off_sec = 0;
    ns_to_tm(zdt->epoch_ns, zdt->tz_id, &t, &off_sec);
    int ms = (int)((zdt->epoch_ns % 1000000000LL) / 1000000LL);
    if (ms < 0) ms = -ms;
    int off_h = abs(off_sec) / 3600;
    int off_m = (abs(off_sec) % 3600) / 60;
    char sign = (off_sec >= 0) ? '+' : '-';
    char buf[80];
    if (zdt->tz_id && strcmp(zdt->tz_id, "UTC") != 0)
        snprintf(buf, sizeof(buf),
                 "%04d-%02d-%02dT%02d:%02d:%02d.%03d%c%02d:%02d[%s]",
                 t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                 t.tm_hour, t.tm_min, t.tm_sec, ms,
                 sign, off_h, off_m, zdt->tz_id);
    else
        snprintf(buf, sizeof(buf),
                 "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                 t.tm_year+1900, t.tm_mon+1, t.tm_mday,
                 t.tm_hour, t.tm_min, t.tm_sec, ms);
    return strdup(buf);
}

ZonedDateTime *zoned_date_time_add(ZonedDateTime *zdt, Duration *dur) {
    /* Add calendar components in the wall-clock timezone, then re-anchor */
    struct tm t = zdt_to_tm(zdt);
    t.tm_year  += dur->years;
    t.tm_mon   += dur->months;
    t.tm_mday  += dur->days;
    t.tm_hour  += dur->hours;
    t.tm_min   += dur->minutes;
    t.tm_sec   += dur->seconds;
    t.tm_isdst  = -1;
    int64_t ns = tm_to_ns(&t, zdt->tz_id) + (int64_t)dur->milliseconds * 1000000LL;
    int ms = (int)((zdt->epoch_ns % 1000000000LL) / 1000000LL);
    ns += (int64_t)ms * 1000000LL;  /* carry original sub-second part */
    ZonedDateTime *r = (ZonedDateTime *)malloc(sizeof(ZonedDateTime));
    r->epoch_ns = ns;
    r->tz_id    = strdup(zdt->tz_id ? zdt->tz_id : "UTC");
    return r;
}

ZonedDateTime *zoned_date_time_subtract(ZonedDateTime *zdt, Duration *dur) {
    Duration neg = *dur;
    neg.years *= -1; neg.months *= -1; neg.days *= -1;
    neg.hours *= -1; neg.minutes *= -1; neg.seconds *= -1; neg.milliseconds *= -1;
    return zoned_date_time_add(zdt, &neg);
}

int32_t zoned_date_time_compare(ZonedDateTime *a, ZonedDateTime *b) {
    if (a->epoch_ns < b->epoch_ns) return -1;
    if (a->epoch_ns > b->epoch_ns) return  1;
    return 0;
}

void zoned_date_time_free(ZonedDateTime *zdt) {
    if (!zdt) return;
    free(zdt->tz_id);
    free(zdt);
}

/* ── Duration ────────────────────────────────────────────────────────────────── */

Duration *duration_from(int32_t y, int32_t mo, int32_t d,
                         int32_t h, int32_t mi, int32_t s, int32_t ms) {
    Duration *dur = (Duration *)malloc(sizeof(Duration));
    dur->years = y; dur->months = mo; dur->days = d;
    dur->hours = h; dur->minutes = mi; dur->seconds = s; dur->milliseconds = ms;
    return dur;
}

Duration *duration_from_iso(const char *iso) {
    /* Parse P[n]Y[n]M[n]DT[n]H[n]M[n[.f]]S */
    Duration *dur = (Duration *)calloc(1, sizeof(Duration));
    const char *p = iso;
    if (!p || *p != 'P') return dur;
    p++;
    int in_time = 0;
    while (*p) {
        if (*p == 'T') { in_time = 1; p++; continue; }
        int sign = 1;
        if (*p == '-') { sign = -1; p++; }
        long val = 0;
        while (*p && isdigit((unsigned char)*p)) val = val * 10 + (*p++ - '0');
        int frac_ms = 0;
        if (*p == '.' || *p == ',') {
            p++;
            int frac = 0, digits = 0;
            while (*p && isdigit((unsigned char)*p) && digits < 3) {
                frac = frac * 10 + (*p++ - '0'); digits++;
            }
            while (digits++ < 3) frac *= 10;
            frac_ms = frac;
            while (*p && isdigit((unsigned char)*p)) p++;
        }
        char unit = *p ? *p++ : 0;
        val *= sign;
        if (!in_time) {
            if (unit == 'Y') dur->years  = (int32_t)val;
            if (unit == 'M') dur->months = (int32_t)val;
            if (unit == 'D') dur->days   = (int32_t)val;
        } else {
            if (unit == 'H') dur->hours   = (int32_t)val;
            if (unit == 'M') dur->minutes = (int32_t)val;
            if (unit == 'S') { dur->seconds = (int32_t)val; dur->milliseconds = frac_ms; }
        }
    }
    return dur;
}

int32_t duration_years(Duration *d)        { return d->years; }
int32_t duration_months(Duration *d)       { return d->months; }
int32_t duration_days(Duration *d)         { return d->days; }
int32_t duration_hours(Duration *d)        { return d->hours; }
int32_t duration_minutes(Duration *d)      { return d->minutes; }
int32_t duration_seconds(Duration *d)      { return d->seconds; }
int32_t duration_milliseconds(Duration *d) { return d->milliseconds; }

int64_t duration_total_ms(Duration *d) {
    return
        (int64_t)d->years        * 365LL * 24 * 3600 * 1000 +
        (int64_t)d->months       *  30LL * 24 * 3600 * 1000 +
        (int64_t)d->days               * 24LL * 3600 * 1000 +
        (int64_t)d->hours                    * 3600LL * 1000 +
        (int64_t)d->minutes                     * 60LL * 1000 +
        (int64_t)d->seconds                          * 1000LL +
        (int64_t)d->milliseconds;
}

const char *duration_to_string(Duration *d) {
    char buf[80];
    char *p = buf;
    *p++ = 'P';
    if (d->years)   { p += sprintf(p, "%dY", d->years);  }
    if (d->months)  { p += sprintf(p, "%dM", d->months); }
    if (d->days)    { p += sprintf(p, "%dD", d->days);   }
    if (d->hours || d->minutes || d->seconds || d->milliseconds) {
        *p++ = 'T';
        if (d->hours)   { p += sprintf(p, "%dH", d->hours);   }
        if (d->minutes) { p += sprintf(p, "%dM", d->minutes); }
        if (d->seconds || d->milliseconds) {
            if (d->milliseconds)
                p += sprintf(p, "%d.%03dS", d->seconds, abs(d->milliseconds));
            else
                p += sprintf(p, "%dS", d->seconds);
        }
    }
    if (p == buf + 1) { *p++ = '0'; *p++ = 'D'; }  /* P0D for zero duration */
    *p = '\0';
    return strdup(buf);
}

Duration *duration_negate(Duration *d) {
    return duration_from(-d->years, -d->months, -d->days,
                         -d->hours, -d->minutes, -d->seconds, -d->milliseconds);
}

Duration *duration_abs(Duration *d) {
    return duration_from(
        d->years  < 0 ? -d->years  : d->years,
        d->months < 0 ? -d->months : d->months,
        d->days   < 0 ? -d->days   : d->days,
        d->hours  < 0 ? -d->hours  : d->hours,
        d->minutes< 0 ? -d->minutes: d->minutes,
        d->seconds< 0 ? -d->seconds: d->seconds,
        d->milliseconds < 0 ? -d->milliseconds : d->milliseconds);
}

void duration_free(Duration *d) { free(d); }

/* ── DateTimeFormat (Intl) ───────────────────────────────────────────────────── */

DateTimeFormat *dtf_new(const char *locale) {
    DateTimeFormat *fmt = (DateTimeFormat *)malloc(sizeof(DateTimeFormat));
    fmt->locale     = strdup(locale ? locale : "");
    fmt->date_style = strdup("medium");
    fmt->time_style = strdup("");
    fmt->tz_id      = strdup("UTC");
    return fmt;
}

DateTimeFormat *dtf_date_style(DateTimeFormat *fmt, const char *style) {
    free(fmt->date_style);
    fmt->date_style = strdup(style ? style : "");
    return fmt;
}

DateTimeFormat *dtf_time_style(DateTimeFormat *fmt, const char *style) {
    free(fmt->time_style);
    fmt->time_style = strdup(style ? style : "");
    return fmt;
}

DateTimeFormat *dtf_timezone(DateTimeFormat *fmt, const char *tz_id) {
    free(fmt->tz_id);
    fmt->tz_id = strdup(tz_id ? tz_id : "UTC");
    return fmt;
}

/* Apply locale then reset */
static char *fmt_with_locale(const char *locale, const char *d_style,
                              const char *t_style, const char *tz_id,
                              struct tm *tm_val) {
    /* Set locale for LC_TIME */
    char locale_with_enc[128];
    /* Try locale as-is, then with .UTF-8 suffix */
    snprintf(locale_with_enc, sizeof(locale_with_enc), "%s.UTF-8", locale);
    char *prev = setlocale(LC_TIME, NULL);
    char  prev_buf[128] = "";
    if (prev) strncpy(prev_buf, prev, sizeof(prev_buf)-1);

    if (!setlocale(LC_TIME, locale_with_enc))
        setlocale(LC_TIME, locale);  /* fallback: try bare locale */

    char *result = apply_format(d_style, t_style, tz_id, tm_val);

    /* Restore locale */
    setlocale(LC_TIME, prev_buf[0] ? prev_buf : "");
    return result;
}

const char *dtf_format_zdt(DateTimeFormat *fmt, ZonedDateTime *zdt) {
    const char *tz = (fmt->tz_id && fmt->tz_id[0]) ? fmt->tz_id : zdt->tz_id;
    struct tm t;
    ns_to_tm(zdt->epoch_ns, tz, &t, NULL);
    return fmt_with_locale(fmt->locale, fmt->date_style, fmt->time_style, tz, &t);
}

const char *dtf_format_instant(DateTimeFormat *fmt, Instant *inst) {
    const char *tz = (fmt->tz_id && fmt->tz_id[0]) ? fmt->tz_id : "UTC";
    struct tm t;
    ns_to_tm(inst->epoch_ns, tz, &t, NULL);
    return fmt_with_locale(fmt->locale, fmt->date_style, fmt->time_style, tz, &t);
}

const char *dtf_format_plain_date(DateTimeFormat *fmt, PlainDate *d) {
    struct tm t = make_tm(d->year, d->month, d->day, 0, 0, 0);
    mktime(&t);
    return fmt_with_locale(fmt->locale, fmt->date_style, "", NULL, &t);
}

const char *dtf_format_plain_date_time(DateTimeFormat *fmt, PlainDateTime *dt) {
    struct tm t = make_tm(dt->year, dt->month, dt->day,
                          dt->hour, dt->minute, dt->second);
    mktime(&t);
    return fmt_with_locale(fmt->locale, fmt->date_style, fmt->time_style, NULL, &t);
}

void dtf_free(DateTimeFormat *fmt) {
    if (!fmt) return;
    free(fmt->locale);
    free(fmt->date_style);
    free(fmt->time_style);
    free(fmt->tz_id);
    free(fmt);
}
