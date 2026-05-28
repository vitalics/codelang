/**
 * CodeLang filesystem runtime  (runtime/fs.c)
 *
 * Implements the functions declared in stdlib/fs.code:
 *   File  — read, write, append, copy, rename, delete, exists, size, touch
 *   Dir   — list, listAll, create, createAll, remove, removeAll, rename,
 *            exists, isDir, current, change, temp, home
 *   Path  — join, resolve, dirname, basename, stem, extname,
 *            isAbsolute, normalize, relative, sep, delimiter
 *   stat  — size, mtime, atime, ctime, mode, isFile, isDir, isSymlink
 *
 * Platform support: POSIX (macOS, Linux); stubs for Windows.
 *
 * Compiled with: clang -O2
 * No extra link flags (pure POSIX).
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>

#if defined(_WIN32)
#  include <direct.h>
#  include <io.h>
#  define PATH_SEP     '\\'
#  define PATH_SEP_STR "\\"
#  define PATH_DELIM   ";"
#else
#  include <unistd.h>
#  include <dirent.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <ftw.h>
#  include <pwd.h>
#  include <utime.h>
#  define PATH_SEP     '/'
#  define PATH_SEP_STR "/"
#  define PATH_DELIM   ":"
#endif

/* ── StringArray (mirrors runtime/array.c internal layout) ──────────────────
 * We re-use the same type that codelang_dir_list() returns in io.c.  The
 * opaque struct and its allocators live in runtime/array.c.
 */
typedef struct StringArray StringArray;
extern StringArray *stringarray_new(void);
extern void         stringarray_push(StringArray *arr, const char *val);

/* ── Helpers ────────────────────────────────────────────────────────────────── */

static char *fs_strdup(const char *s) {
    if (!s) return strdup("");
    size_t n = strlen(s);
    char  *p = (char *)malloc(n + 1);
    memcpy(p, s, n + 1);
    return p;
}

/* Allocate a buffer of `sz` bytes and snprintf into it. */
static char *fs_sprintf(size_t sz, const char *fmt, ...) {
    char *buf = (char *)malloc(sz);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sz, fmt, ap);
    va_end(ap);
    return buf;
}

/* Return 1 if path exists (file or directory), 0 otherwise. */
static int fs_exists_raw(const char *path) {
#if defined(_WIN32)
    return _access(path, 0) == 0 ? 1 : 0;
#else
    struct stat st;
    return (stat(path, &st) == 0) ? 1 : 0;
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * stat helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

int64_t fs_stat_size(const char *path) {
#if defined(_WIN32)
    struct _stat st;
    return (_stat(path, &st) == 0) ? (int64_t)st.st_size : -1;
#else
    struct stat st;
    return (stat(path, &st) == 0) ? (int64_t)st.st_size : -1;
#endif
}

int64_t fs_stat_mtime(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0) ? (int64_t)st.st_mtime : -1;
#else
    return -1;
#endif
}

int64_t fs_stat_atime(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0) ? (int64_t)st.st_atime : -1;
#else
    return -1;
#endif
}

int64_t fs_stat_ctime(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0) ? (int64_t)st.st_ctime : -1;
#else
    return -1;
#endif
}

int32_t fs_stat_mode(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0) ? (int32_t)(st.st_mode & 0xFFF) : -1;
#else
    return -1;
#endif
}

int32_t fs_stat_is_file(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0 && S_ISREG(st.st_mode)) ? 1 : 0;
#else
    return fs_exists_raw(path);
#endif
}

int32_t fs_stat_is_dir(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) ? 1 : 0;
#else
    struct _stat st;
    return (_stat(path, &st) == 0 && (st.st_mode & _S_IFDIR)) ? 1 : 0;
#endif
}

int32_t fs_stat_is_symlink(const char *path) {
#if !defined(_WIN32)
    struct stat st;
    return (lstat(path, &st) == 0 && S_ISLNK(st.st_mode)) ? 1 : 0;
#else
    return 0; /* Windows symlinks need special handling */
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * File operations
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Read the entire contents of a text file.
 * Returns a heap-allocated NUL-terminated string, or "" on error.
 */
char *fs_file_read(const char *path) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return fs_strdup("");

    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    rewind(fp);

    if (sz < 0) { fclose(fp); return fs_strdup(""); }

    char *buf = (char *)malloc((size_t)sz + 1);
    size_t got = fread(buf, 1, (size_t)sz, fp);
    buf[got] = '\0';
    fclose(fp);
    return buf;
}

/**
 * Write `content` to `path`, truncating any existing file.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_write(const char *path, const char *content) {
    FILE *fp = fopen(path, "wb");
    if (!fp) return 0;
    size_t len = strlen(content);
    int ok = (fwrite(content, 1, len, fp) == len);
    fclose(fp);
    return ok ? 1 : 0;
}

/**
 * Append `content` to `path` (creates the file if it does not exist).
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_append(const char *path, const char *content) {
    FILE *fp = fopen(path, "ab");
    if (!fp) return 0;
    size_t len = strlen(content);
    int ok = (fwrite(content, 1, len, fp) == len);
    fclose(fp);
    return ok ? 1 : 0;
}

/**
 * Copy `src` to `dst` (byte-for-byte).
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_copy(const char *src, const char *dst) {
    FILE *in = fopen(src, "rb");
    if (!in) return 0;
    FILE *out = fopen(dst, "wb");
    if (!out) { fclose(in); return 0; }

    char buf[65536];
    size_t n;
    int ok = 1;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) { ok = 0; break; }
    }
    if (ferror(in)) ok = 0;
    fclose(in);
    fclose(out);
    return ok ? 1 : 0;
}

/**
 * Rename / move `from` to `to`.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_rename(const char *from, const char *to) {
    return (rename(from, to) == 0) ? 1 : 0;
}

/**
 * Delete the file at `path`.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_delete(const char *path) {
    return (remove(path) == 0) ? 1 : 0;
}

/**
 * Return 1 if `path` exists (file or directory).
 */
int32_t fs_path_exists(const char *path) {
    return fs_exists_raw(path);
}

/**
 * Return the size in bytes of the file at `path`.
 * Returns -1 on error.
 */
int64_t fs_file_size(const char *path) {
    return fs_stat_size(path);
}

/**
 * Return 1 if `path` is a regular file.
 */
int32_t fs_is_file(const char *path) {
    return fs_stat_is_file(path);
}

/**
 * Create an empty file at `path` (or update its mtime if it already exists).
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_touch(const char *path) {
#if !defined(_WIN32)
    /* If file exists, update timestamps with utime(path, NULL). */
    if (fs_exists_raw(path)) {
        return (utime(path, NULL) == 0) ? 1 : 0;
    }
    /* Otherwise create it. */
    FILE *fp = fopen(path, "ab");
    if (!fp) return 0;
    fclose(fp);
    return 1;
#else
    FILE *fp = fopen(path, "ab");
    if (!fp) return 0;
    fclose(fp);
    return 1;
#endif
}

/**
 * Set POSIX permission bits on `path`.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_file_chmod(const char *path, int32_t mode) {
#if !defined(_WIN32)
    return (chmod(path, (mode_t)mode) == 0) ? 1 : 0;
#else
    (void)path; (void)mode;
    return 0;
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Dir operations
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * List entry names in `path` (excludes "." and "..").
 * Returns a heap-allocated StringArray.
 */
StringArray *fs_dir_list(const char *path) {
    StringArray *arr = stringarray_new();
#if !defined(_WIN32)
    DIR *dp = opendir(path);
    if (!dp) return arr;
    struct dirent *de;
    while ((de = readdir(dp)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        stringarray_push(arr, de->d_name);
    }
    closedir(dp);
#endif
    return arr;
}

/* Internal recursive helper for fs_dir_list_recursive. */
#if !defined(_WIN32)
static void fs_list_recursive(const char *base, const char *rel, StringArray *arr) {
    /* Build the full path: base/rel */
    size_t blen = strlen(base), rlen = strlen(rel);
    char *full;
    if (rlen == 0) {
        full = fs_strdup(base);
    } else {
        full = (char *)malloc(blen + 1 + rlen + 1);
        snprintf(full, blen + 1 + rlen + 1, "%s/%s", base, rel);
    }

    DIR *dp = opendir(full);
    if (!dp) { free(full); return; }

    struct dirent *de;
    while ((de = readdir(dp)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        /* Build relative entry path */
        char *entry;
        if (rlen == 0) {
            entry = fs_strdup(de->d_name);
        } else {
            size_t elen = strlen(de->d_name);
            entry = (char *)malloc(rlen + 1 + elen + 1);
            snprintf(entry, rlen + 1 + elen + 1, "%s/%s", rel, de->d_name);
        }
        stringarray_push(arr, entry);
        /* Build full path for stat */
        size_t flen = strlen(full), dlen = strlen(de->d_name);
        char *child = (char *)malloc(flen + 1 + dlen + 1);
        snprintf(child, flen + 1 + dlen + 1, "%s/%s", full, de->d_name);
        struct stat st;
        if (stat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
            fs_list_recursive(base, entry, arr);
        }
        free(child);
        free(entry);
    }
    closedir(dp);
    free(full);
}
#endif

/**
 * Recursively list all paths under `path` (relative to `path`).
 * Returns a heap-allocated StringArray.
 */
StringArray *fs_dir_list_recursive(const char *path) {
    StringArray *arr = stringarray_new();
#if !defined(_WIN32)
    fs_list_recursive(path, "", arr);
#endif
    return arr;
}

/**
 * Create directory `path` with mode 0755.
 * Returns 1 on success (or if it already exists), 0 on failure.
 */
int32_t fs_dir_create(const char *path) {
#if !defined(_WIN32)
    if (mkdir(path, 0755) == 0) return 1;
    return (errno == EEXIST) ? 1 : 0;
#else
    return (_mkdir(path) == 0 || errno == EEXIST) ? 1 : 0;
#endif
}

/**
 * Create `path` and all missing parent directories (like mkdir -p).
 * Returns 1 on success, 0 on any failure.
 */
int32_t fs_dir_create_all(const char *path) {
    char *tmp = fs_strdup(path);
    size_t len = strlen(tmp);
    /* Strip trailing slash */
    if (len > 1 && (tmp[len-1] == '/' || tmp[len-1] == '\\')) tmp[--len] = '\0';

    for (size_t i = 1; i <= len; i++) {
        if (tmp[i] == '/' || tmp[i] == '\\' || tmp[i] == '\0') {
            char saved = tmp[i];
            tmp[i] = '\0';
            int rc = fs_dir_create(tmp);
            tmp[i] = saved;
            if (!rc) { free(tmp); return 0; }
        }
    }
    free(tmp);
    return 1;
}

/**
 * Remove an empty directory.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_dir_remove(const char *path) {
    return (rmdir(path) == 0) ? 1 : 0;
}

/* Internal nftw callback for fs_dir_remove_all. */
#if !defined(_WIN32)
static int fs_remove_cb(const char *fpath, const struct stat *sb,
                         int typeflag, struct FTW *ftwbuf) {
    (void)sb; (void)typeflag; (void)ftwbuf;
    return remove(fpath);
}
#endif

/**
 * Remove `path` and all its contents recursively (like rm -rf).
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_dir_remove_all(const char *path) {
#if !defined(_WIN32)
    return (nftw(path, fs_remove_cb, 64, FTW_DEPTH | FTW_PHYS) == 0) ? 1 : 0;
#else
    (void)path;
    return 0;
#endif
}

/**
 * Return 1 if `path` is an existing directory.
 */
int32_t fs_is_dir(const char *path) {
    return fs_stat_is_dir(path);
}

/**
 * Return the current working directory as a heap-allocated string.
 */
char *fs_getcwd(void) {
#if !defined(_WIN32)
    char buf[4096];
    if (getcwd(buf, sizeof(buf))) return fs_strdup(buf);
    return fs_strdup(".");
#else
    char buf[4096];
    if (_getcwd(buf, sizeof(buf))) return fs_strdup(buf);
    return fs_strdup(".");
#endif
}

/**
 * Change the current working directory to `path`.
 * Returns 1 on success, 0 on failure.
 */
int32_t fs_chdir(const char *path) {
#if !defined(_WIN32)
    return (chdir(path) == 0) ? 1 : 0;
#else
    return (_chdir(path) == 0) ? 1 : 0;
#endif
}

/**
 * Return the system temporary directory.
 */
char *fs_tmpdir(void) {
#if defined(__APPLE__) || defined(__linux__)
    const char *t = getenv("TMPDIR");
    if (t) return fs_strdup(t);
    return fs_strdup("/tmp");
#elif defined(_WIN32)
    char buf[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, buf);
    return n ? fs_strdup(buf) : fs_strdup("C:\\Temp");
#else
    return fs_strdup("/tmp");
#endif
}

/**
 * Return the home directory of the current user.
 */
char *fs_homedir(void) {
#if !defined(_WIN32)
    const char *h = getenv("HOME");
    if (h) return fs_strdup(h);
    struct passwd *pw = getpwuid(getuid());
    return pw ? fs_strdup(pw->pw_dir) : fs_strdup(".");
#else
    const char *h = getenv("USERPROFILE");
    return fs_strdup(h ? h : "C:\\Users\\user");
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Path operations  (pure string manipulation — no syscalls)
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Join two path segments, inserting a separator if needed.
 * e.g. ("/usr/local", "bin") → "/usr/local/bin"
 *       ("/usr/local/", "bin") → "/usr/local/bin"
 */
char *fs_path_join(const char *a, const char *b) {
    size_t la = strlen(a), lb = strlen(b);
    int has_sep = (la > 0 && (a[la-1] == '/' || a[la-1] == '\\'));
    size_t total = la + (has_sep ? 0 : 1) + lb + 1;
    char *out = (char *)malloc(total);
    if (has_sep) {
        snprintf(out, total, "%s%s", a, b);
    } else {
        snprintf(out, total, "%s%c%s", a, PATH_SEP, b);
    }
    return out;
}

/**
 * Resolve `path` to an absolute path (relative to cwd).
 * Equivalent to realpath(3) where possible; falls back to cwd + sep + path.
 */
char *fs_path_resolve(const char *path) {
#if !defined(_WIN32)
    char buf[4096];
    if (realpath(path, buf)) return fs_strdup(buf);
    /* Fallback: prepend cwd */
    char cwd[4096];
    if (!getcwd(cwd, sizeof(cwd))) return fs_strdup(path);
    size_t n = strlen(cwd) + 1 + strlen(path) + 1;
    char *out = (char *)malloc(n);
    snprintf(out, n, "%s/%s", cwd, path);
    return out;
#else
    char buf[MAX_PATH];
    if (GetFullPathNameA(path, MAX_PATH, buf, NULL)) return fs_strdup(buf);
    return fs_strdup(path);
#endif
}

/**
 * Return the directory component of `path` (all but the last segment).
 * e.g. "/usr/local/bin" → "/usr/local"
 *      "file.txt"       → "."
 */
char *fs_path_dirname(const char *path) {
    char *tmp = fs_strdup(path);
    /* Find the last separator */
    char *last = NULL;
    for (char *p = tmp; *p; p++) {
        if (*p == '/' || *p == '\\') last = p;
    }
    if (!last)         { free(tmp); return fs_strdup("."); }
    if (last == tmp)   { free(tmp); return fs_strdup(PATH_SEP_STR); }
    *last = '\0';
    char *out = fs_strdup(tmp);
    free(tmp);
    return out;
}

/**
 * Return the last segment of `path` (including extension).
 * e.g. "/usr/local/bin" → "bin"
 *      "/home/user/file.txt" → "file.txt"
 */
char *fs_path_basename(const char *path) {
    const char *last = path;
    for (const char *p = path; *p; p++) {
        if (*p == '/' || *p == '\\') last = p + 1;
    }
    return fs_strdup(last);
}

/**
 * Return the last segment of `path` WITHOUT its extension.
 * e.g. "file.txt" → "file"
 *      "/a/b/main.code" → "main"
 */
char *fs_path_stem(const char *path) {
    char *base = fs_path_basename(path);
    /* Find last '.' in base */
    char *dot = strrchr(base, '.');
    if (dot && dot != base) *dot = '\0';
    return base; /* caller frees */
}

/**
 * Return the extension of `path` including the dot.
 * e.g. "file.txt" → ".txt"
 *      "archive.tar.gz" → ".gz"
 *      "Makefile"       → ""
 */
char *fs_path_extname(const char *path) {
    char *base = fs_path_basename(path);
    char *dot  = strrchr(base, '.');
    char *out  = (dot && dot != base) ? fs_strdup(dot) : fs_strdup("");
    free(base);
    return out;
}

/**
 * Return 1 if `path` is an absolute path.
 */
int32_t fs_path_is_absolute(const char *path) {
    if (!path || !*path) return 0;
#if defined(_WIN32)
    /* C:\..., \\server\... */
    return (path[0] == '\\' || (path[1] == ':' && (path[2] == '\\' || path[2] == '/'))) ? 1 : 0;
#else
    return (path[0] == '/') ? 1 : 0;
#endif
}

/**
 * Normalize `path`: collapse //., resolve single .., remove trailing slash.
 * Not a full realpath — does not access the filesystem.
 */
char *fs_path_normalize(const char *path) {
    if (!path || !*path) return fs_strdup(".");
    size_t len = strlen(path);
    /* Work in a writable buffer */
    char *buf = (char *)malloc(len + 2);
    memcpy(buf, path, len + 1);

    /* Split into components, skip empty and "." */
    /* Rebuild with simple // and trailing / removal */
    /* Replace multiple slashes with one */
    char *out = (char *)malloc(len + 2);
    int o = 0;
    int leading = (buf[0] == '/') ? 1 : 0;
    if (leading) out[o++] = '/';

    char *tok = strtok(buf, "/");
    int first = 1;
    while (tok) {
        if (strcmp(tok, ".") == 0) { tok = strtok(NULL, "/"); continue; }
        if (!first) out[o++] = '/';
        size_t tlen = strlen(tok);
        memcpy(out + o, tok, tlen);
        o += (int)tlen;
        first = 0;
        tok = strtok(NULL, "/");
    }
    if (o == 0 && !leading) out[o++] = '.';
    out[o] = '\0';
    free(buf);
    return out;
}

/**
 * Compute the relative path from `from` to `to`.
 * Both paths are treated as directories.
 * e.g. ("/a/b/c", "/a/d/e") → "../../d/e"
 */
char *fs_path_relative(const char *from, const char *to) {
#if !defined(_WIN32)
    /* Simple POSIX implementation using common-prefix matching. */
    char *af = fs_path_resolve(from);
    char *at = fs_path_resolve(to);

    /* Find common prefix length (up to a '/' boundary). */
    size_t common = 0, i = 0;
    while (af[i] && at[i] && af[i] == at[i]) {
        if (af[i] == '/') common = i + 1;
        i++;
    }
    if (!af[i] && !at[i]) { free(af); free(at); return fs_strdup("."); }

    /* Count remaining '/' in af after common → number of ".." needed. */
    int ups = 0;
    for (size_t j = common; af[j]; j++) {
        if (af[j] == '/') ups++;
    }
    if (af[common]) ups++; /* one more for the current segment */

    const char *rest = at + common;

    /* Build "../../../rest" */
    size_t sz = (size_t)ups * 3 + strlen(rest) + 2;
    char *out = (char *)malloc(sz);
    out[0] = '\0';
    for (int u = 0; u < ups; u++) {
        strncat(out, (u > 0) ? "/../" : "../", sz - strlen(out) - 1);
    }
    if (*rest) strncat(out, rest, sz - strlen(out) - 1);
    if (!*out) { free(af); free(at); free(out); return fs_strdup("."); }

    free(af);
    free(at);
    return out;
#else
    (void)from; (void)to;
    return fs_strdup(".");
#endif
}

/** Path separator character as a string ("/" on POSIX, "\\" on Windows). */
char *fs_path_sep(void) {
    return fs_strdup(PATH_SEP_STR);
}

/** PATH environment delimiter (":" on POSIX, ";" on Windows). */
char *fs_path_delimiter(void) {
    return fs_strdup(PATH_DELIM);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FileReadStream — lazy file-backed pull reader
 *
 * Reads a file incrementally via stdio — unlike File.read() the whole file
 * is never loaded into memory.  Backed by an fopen("rb") FILE*.
 *
 *   frs_open(path, hwm)   open; hwm = default chunk size hint (ignored internally
 *                          but stored so CodeLang can pass it through)
 *   frs_read(s, n)        read up to n bytes → heap string (NUL-terminated)
 *   frs_read_byte(s)      read one byte (0–255) or -1 at EOF
 *   frs_read_line(s)      read up to the next '\n' → string (strip '\n'/'\r\n')
 *   frs_read_all(s)       read all remaining bytes → string
 *   frs_at_end(s)         1 if at EOF (or closed), 0 otherwise
 *   frs_close(s)          fclose without freeing the struct
 *   frs_free(s)           fclose + free the struct (double-free guard)
 * ═══════════════════════════════════════════════════════════════════════════ */

#define FRS_LINE_INIT 256

typedef struct {
    uint8_t  freed;
    FILE    *fp;     /* NULL when closed or file not found */
    int32_t  hwm;    /* default chunk hint */
} FileReadStream;

FileReadStream *frs_open(const char *path, int32_t hwm) {
    FileReadStream *s = (FileReadStream *)calloc(1, sizeof(FileReadStream));
    s->freed = 0;
    s->hwm   = hwm > 0 ? hwm : 65536;
    if (path) s->fp = fopen(path, "rb");
    return s;
}

/*
 * Read up to `n` bytes from the current file position.
 * Returns a heap-allocated, NUL-terminated string of the bytes read.
 * Returns "" on EOF, closed stream, or n <= 0.
 */
char *frs_read(FileReadStream *s, int32_t n) {
    if (!s || s->freed || !s->fp || n <= 0 || feof(s->fp)) return fs_strdup("");
    char   *buf = (char *)malloc((size_t)n + 1);
    int32_t got = (int32_t)fread(buf, 1, (size_t)n, s->fp);
    buf[got] = '\0';
    if (got == 0) { free(buf); return fs_strdup(""); }
    return buf;
}

/* Read one byte.  Returns the byte value (0–255) or -1 at EOF / closed. */
int32_t frs_read_byte(FileReadStream *s) {
    if (!s || s->freed || !s->fp) return -1;
    return fgetc(s->fp);
}

/*
 * Read bytes from the current position up to (and consuming) the next '\n'.
 * Returns the line content without the newline character.
 * Strips a trailing '\r' for CRLF inputs.
 * Returns "" when the stream is at EOF before any character is read.
 */
char *frs_read_line(FileReadStream *s) {
    if (!s || s->freed || !s->fp || feof(s->fp)) return fs_strdup("");
    size_t cap = FRS_LINE_INIT;
    char  *buf = (char *)malloc(cap);
    size_t len = 0;
    int    c;
    while ((c = fgetc(s->fp)) != EOF && c != '\n') {
        if (len + 2 >= cap) { cap *= 2; buf = (char *)realloc(buf, cap); }
        buf[len++] = (char)c;
    }
    /* EOF with no bytes consumed — signal end-of-file */
    if (c == EOF && len == 0) { free(buf); return fs_strdup(""); }
    /* Strip trailing '\r' for Windows CRLF */
    if (len > 0 && buf[len - 1] == '\r') len--;
    buf[len] = '\0';
    return buf;
}

/*
 * Read all remaining bytes from the current position to EOF.
 * Returns a heap-allocated, NUL-terminated string.
 * Returns "" if the stream is already at EOF or closed.
 */
char *frs_read_all(FileReadStream *s) {
    if (!s || s->freed || !s->fp || feof(s->fp)) return fs_strdup("");
    size_t  cap = 4096;
    char   *out = (char *)malloc(cap);
    size_t  len = 0;
    uint8_t chunk[4096];
    size_t  n;
    while ((n = fread(chunk, 1, sizeof(chunk), s->fp)) > 0) {
        if (len + n + 1 > cap) {
            while (cap < len + n + 1) cap *= 2;
            out = (char *)realloc(out, cap);
        }
        memcpy(out + len, chunk, n);
        len += n;
    }
    out[len] = '\0';
    return out;
}

/*
 * Return 1 if the stream is at or past EOF (or closed), 0 otherwise.
 * Implemented by peeking one byte and un-getting it if not at EOF.
 */
int32_t frs_at_end(FileReadStream *s) {
    if (!s || s->freed || !s->fp) return 1;
    int c = fgetc(s->fp);
    if (c == EOF) return 1;
    ungetc(c, s->fp);
    return 0;
}

/* Close the underlying file without freeing the struct. */
void frs_close(FileReadStream *s) {
    if (!s || s->freed) return;
    if (s->fp) { fclose(s->fp); s->fp = NULL; }
}

/* Close the underlying file and free the struct (double-free guard). */
void frs_free(FileReadStream *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: FileReadStream\n"); abort(); }
    s->freed = 1;
    if (s->fp) { fclose(s->fp); s->fp = NULL; }
    free(s);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FileWriteStream — file-backed buffered writer
 *
 * Wraps a stdio FILE* opened for writing ("wb") or appending ("ab").
 * All writes go through stdio's internal buffer; call fws_flush() or
 * fws_free() (which calls fclose, which flushes) to commit data.
 *
 *   fws_open(path, append)   open; append=0→"wb" (truncate), append=1→"ab"
 *   fws_write(s, text)       fputs — write a NUL-terminated string
 *   fws_write_byte(s, b)     fputc — write one byte (0–255)
 *   fws_flush(s)             fflush — commit buffered data to the OS
 *   fws_close(s)             fclose without freeing the struct
 *   fws_free(s)              fclose + free the struct (double-free guard)
 * ═══════════════════════════════════════════════════════════════════════════ */

typedef struct {
    uint8_t  freed;
    FILE    *fp;    /* NULL when closed or path not writable */
} FileWriteStream;

FileWriteStream *fws_open(const char *path, int32_t append) {
    FileWriteStream *s = (FileWriteStream *)calloc(1, sizeof(FileWriteStream));
    s->freed = 0;
    if (path) s->fp = fopen(path, append ? "ab" : "wb");
    return s;
}

/* Write a NUL-terminated string to the stream. */
void fws_write(FileWriteStream *s, const char *text) {
    if (!s || s->freed || !s->fp || !text) return;
    fputs(text, s->fp);
}

/* Write a single byte (0–255) to the stream. */
void fws_write_byte(FileWriteStream *s, int32_t b) {
    if (!s || s->freed || !s->fp) return;
    fputc(b & 0xFF, s->fp);
}

/* Flush the stdio buffer to the OS. */
void fws_flush(FileWriteStream *s) {
    if (!s || s->freed || !s->fp) return;
    fflush(s->fp);
}

/* Close the underlying file without freeing the struct. */
void fws_close(FileWriteStream *s) {
    if (!s || s->freed) return;
    if (s->fp) { fclose(s->fp); s->fp = NULL; }
}

/* Close the underlying file and free the struct (double-free guard).
 * fclose() flushes the stdio buffer automatically, so an explicit flush()
 * before free() is not required. */
void fws_free(FileWriteStream *s) {
    if (!s) return;
    if (s->freed) { fprintf(stderr, "double-free: FileWriteStream\n"); abort(); }
    s->freed = 1;
    if (s->fp) { fclose(s->fp); s->fp = NULL; }
    free(s);
}
