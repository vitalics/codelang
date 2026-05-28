/**
 * CodeLang I/O runtime helpers.
 *
 * Provides C-level helpers for the stdlib/io.code module:
 *   codelang_readline()            read one line from stdin, strip \n
 *   codelang_readall()             read all of stdin until EOF
 *   codelang_file_readline(fp)     read one line from an open FILE*
 *   codelang_file_readall(fp)      read all remaining bytes from a FILE*
 *   codelang_dir_list(path)        list directory entries → StringArray*
 *   codelang_path_exists(path)     1 if path exists, 0 otherwise
 *   codelang_getcwd()              return heap-allocated current dir
 *   codelang_make_args(argc,argv)  convert argv → StringArray*
 *   codelang_terminal_enable_raw() put terminal in raw mode
 *   codelang_terminal_disable_raw() restore normal terminal mode
 *   codelang_terminal_rows()       current terminal row count
 *   codelang_terminal_cols()       current terminal column count
 *
 * Platforms:
 *   macOS / Linux  — POSIX (termios, dirent, unistd, sys/ioctl)
 *   Windows 10+    — Win32 API + <conio.h>; ANSI/VT100 via
 *                    ENABLE_VIRTUAL_TERMINAL_PROCESSING (requires Win10 1511+)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

/* ── Platform-specific headers ───────────────────────────────────────────── */

#ifdef _WIN32
#  include <windows.h>
#  include <conio.h>      /* _getch()                          */
#  include <direct.h>     /* _getcwd()                         */
#  include <io.h>         /* _access()                         */
#else
#  include <unistd.h>
#  include <dirent.h>
#  include <sys/stat.h>
#  include <sys/ioctl.h>
#  include <termios.h>
#endif

/* ── StringArray forward declaration (defined in runtime/array.c) ─────────── */

typedef struct StringArray StringArray;
extern StringArray *stringarray_new(void);
extern void         stringarray_push(StringArray *arr, const char *val);

/* ══════════════════════════════════════════════════════════════════════════════
 * stdin helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Read one line from stdin.
 * Strips the trailing newline if present.
 * Returns a heap-allocated NUL-terminated string (caller is responsible for
 * freeing it, though in most CodeLang programs the GC-like pattern lets it
 * leak — same as other string helpers in the runtime).
 * Returns "" on EOF or error.
 */
char *codelang_readline(void) {
    char *buf = (char *)malloc(4096);
    if (!buf) return (char *)"";
    if (!fgets(buf, 4096, stdin)) {
        free(buf);
        return (char *)"";
    }
    /* Strip trailing newline (and \r\n on Windows) */
    size_t len = strlen(buf);
    if (len > 0 && buf[len - 1] == '\n') buf[--len] = '\0';
    if (len > 0 && buf[len - 1] == '\r') buf[--len] = '\0';
    return buf;
}

/**
 * Read all of stdin until EOF.
 * Returns a heap-allocated NUL-terminated string.
 * Returns "" on error.
 */
char *codelang_readall(void) {
    size_t cap = 4096, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return (char *)"";
    int c;
    while ((c = fgetc(stdin)) != EOF) {
        if (len + 1 >= cap) {
            cap *= 2;
            char *tmp = (char *)realloc(buf, cap);
            if (!tmp) break;
            buf = tmp;
        }
        buf[len++] = (char)c;
    }
    buf[len] = '\0';
    return buf;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * File helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Read one line from an already-open FILE*.
 * Strips the trailing newline. Returns "" on EOF or error.
 */
char *codelang_file_readline(void *fp) {
    if (!fp) return (char *)"";
    char *buf = (char *)malloc(4096);
    if (!buf) return (char *)"";
    if (!fgets(buf, 4096, (FILE *)fp)) {
        free(buf);
        return (char *)"";
    }
    size_t len = strlen(buf);
    if (len > 0 && buf[len - 1] == '\n') buf[--len] = '\0';
    if (len > 0 && buf[len - 1] == '\r') buf[--len] = '\0';
    return buf;
}

/**
 * Read all remaining bytes from an already-open FILE*.
 * Returns heap-allocated NUL-terminated string.
 */
char *codelang_file_readall(void *fp) {
    if (!fp) return (char *)"";
    size_t cap = 4096, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return (char *)"";
    int c;
    while ((c = fgetc((FILE *)fp)) != EOF) {
        if (len + 1 >= cap) {
            cap *= 2;
            char *tmp = (char *)realloc(buf, cap);
            if (!tmp) break;
            buf = tmp;
        }
        buf[len++] = (char)c;
    }
    buf[len] = '\0';
    return buf;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Directory helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * List all entries in `path` (excluding "." and "..").
 * Returns a StringArray* owned by the caller.
 */
StringArray *codelang_dir_list(const char *path) {
    StringArray *arr = stringarray_new();
#ifdef _WIN32
    WIN32_FIND_DATAA fd;
    char pattern[4096];
    /* Append \* glob pattern */
    snprintf(pattern, sizeof(pattern), "%s\\*", path);
    HANDLE h = FindFirstFileA(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return arr;
    do {
        if (strcmp(fd.cFileName, ".") == 0) continue;
        if (strcmp(fd.cFileName, "..") == 0) continue;
        stringarray_push(arr, fd.cFileName);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR *d = opendir(path);
    if (!d) return arr;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0) continue;
        if (strcmp(ent->d_name, "..") == 0) continue;
        stringarray_push(arr, ent->d_name);
    }
    closedir(d);
#endif
    return arr;
}

/**
 * Returns 1 if `path` exists (file or directory), 0 otherwise.
 */
int32_t codelang_path_exists(const char *path) {
#ifdef _WIN32
    return (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
#else
    struct stat st;
    return (stat(path, &st) == 0) ? 1 : 0;
#endif
}

/**
 * Returns a heap-allocated string containing the current working directory.
 * Returns "" on error.
 */
char *codelang_getcwd(void) {
    char *buf = (char *)malloc(4096);
    if (!buf) return (char *)"";
#ifdef _WIN32
    if (!_getcwd(buf, 4096)) {
#else
    if (!getcwd(buf, 4096)) {
#endif
        free(buf);
        return (char *)"";
    }
    return buf;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Process helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Convert C's argc/argv into a CodeLang StringArray*.
 * Called by the generated main when `fn main(args: string[])` is used.
 */
StringArray *codelang_make_args(int argc, char **argv) {
    StringArray *arr = stringarray_new();
    for (int i = 0; i < argc; i++) {
        stringarray_push(arr, argv[i]);
    }
    return arr;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Terminal helpers
 * ══════════════════════════════════════════════════════════════════════════════ */

/* Saved original terminal state — restored on codelang_terminal_disable_raw() */
#ifdef _WIN32
static DWORD  _saved_console_mode_in  = 0;
static DWORD  _saved_console_mode_out = 0;
static HANDLE _console_in             = INVALID_HANDLE_VALUE;
static HANDLE _console_out            = INVALID_HANDLE_VALUE;
#else
static struct termios _saved_termios;
#endif
static int _raw_mode_active = 0;

/**
 * Enable terminal raw mode (character-by-character, no echo).
 * Saves the current terminal state so it can be restored.
 *
 * On Windows 10 1511+, also enables ENABLE_VIRTUAL_TERMINAL_PROCESSING so
 * that ANSI/VT100 escape sequences work in the console output.
 */
void codelang_terminal_enable_raw(void) {
    if (_raw_mode_active) return;
#ifdef _WIN32
    _console_in  = GetStdHandle(STD_INPUT_HANDLE);
    _console_out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (_console_in  == INVALID_HANDLE_VALUE) return;
    if (_console_out == INVALID_HANDLE_VALUE) return;

    /* Save current modes */
    GetConsoleMode(_console_in,  &_saved_console_mode_in);
    GetConsoleMode(_console_out, &_saved_console_mode_out);

    /* Raw input: disable line input, echo, and processed input;
     * enable virtual-terminal (VT) input sequences */
    DWORD raw_in = (_saved_console_mode_in
        & ~(DWORD)(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
        | (DWORD)(ENABLE_VIRTUAL_TERMINAL_INPUT);
    SetConsoleMode(_console_in, raw_in);

    /* Enable VT100/ANSI escape codes on output (Win10 1511+) */
    SetConsoleMode(_console_out,
        _saved_console_mode_out | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT);
#else
    if (tcgetattr(STDIN_FILENO, &_saved_termios) != 0) return;

    struct termios raw = _saved_termios;
    /* Input flags: no break, no CR→NL, no parity, no strip char, no XON/XOFF */
    raw.c_iflag &= (tcflag_t)~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    /* Output flags: disable post-processing */
    raw.c_oflag &= (tcflag_t)~(OPOST);
    /* Control flags: set 8-bit chars */
    raw.c_cflag |= (CS8);
    /* Local flags: no echo, no canonical, no signals, no extended processing */
    raw.c_lflag &= (tcflag_t)~(ECHO | ICANON | IEXTEN | ISIG);
    /* Read returns after 1 byte, no timeout */
    raw.c_cc[VMIN]  = 1;
    raw.c_cc[VTIME] = 0;

    tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);
#endif
    _raw_mode_active = 1;
}

/**
 * Disable raw mode and restore the saved terminal settings.
 */
void codelang_terminal_disable_raw(void) {
    if (!_raw_mode_active) return;
#ifdef _WIN32
    if (_console_in  != INVALID_HANDLE_VALUE)
        SetConsoleMode(_console_in,  _saved_console_mode_in);
    if (_console_out != INVALID_HANDLE_VALUE)
        SetConsoleMode(_console_out, _saved_console_mode_out);
#else
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &_saved_termios);
#endif
    _raw_mode_active = 0;
}

/**
 * Returns the terminal height in rows (0 if not a terminal or on error).
 */
int32_t codelang_terminal_rows(void) {
#ifdef _WIN32
    CONSOLE_SCREEN_BUFFER_INFO csbi;
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!GetConsoleScreenBufferInfo(h, &csbi)) return 0;
    return (int32_t)(csbi.srWindow.Bottom - csbi.srWindow.Top + 1);
#else
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) != 0) return 0;
    return (int32_t)ws.ws_row;
#endif
}

/**
 * Returns the terminal width in columns (0 if not a terminal or on error).
 */
int32_t codelang_terminal_cols(void) {
#ifdef _WIN32
    CONSOLE_SCREEN_BUFFER_INFO csbi;
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!GetConsoleScreenBufferInfo(h, &csbi)) return 0;
    return (int32_t)(csbi.srWindow.Right - csbi.srWindow.Left + 1);
#else
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) != 0) return 0;
    return (int32_t)ws.ws_col;
#endif
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Terminal cursor / screen helpers (ANSI / VT100)
 *
 * These use printf() with VT100 escape sequences.
 * On Windows 10 1511+ they work after codelang_terminal_enable_raw() has
 * called SetConsoleMode(…, ENABLE_VIRTUAL_TERMINAL_PROCESSING).
 * ══════════════════════════════════════════════════════════════════════════════ */

/** Move cursor to (row, col) — 1-based. */
void codelang_terminal_move_to(int32_t row, int32_t col) {
    printf("\x1b[%d;%dH", (int)row, (int)col);
}

/** Clear the entire screen and move cursor to top-left. */
void codelang_terminal_clear(void) {
    printf("\x1b[2J\x1b[H");
    fflush(stdout);
}

/** Erase from cursor to end of current line. */
void codelang_terminal_clear_line(void) {
    printf("\x1b[2K\r");
}

/** Hide the text cursor. */
void codelang_terminal_hide_cursor(void) {
    printf("\x1b[?25l");
    fflush(stdout);
}

/** Show the text cursor. */
void codelang_terminal_show_cursor(void) {
    printf("\x1b[?25h");
    fflush(stdout);
}

/**
 * Set foreground color.
 * color: 0=black 1=red 2=green 3=yellow 4=blue 5=magenta 6=cyan 7=white
 *        8=bright_black … 15=bright_white  (adds ANSI bold/bright modifier)
 */
void codelang_terminal_set_fg(int32_t color) {
    if (color < 8) {
        printf("\x1b[%dm", 30 + (int)color);
    } else {
        printf("\x1b[%d;1m", 30 + (int)(color - 8));
    }
}

/**
 * Set background color (same 0-15 palette as set_fg).
 */
void codelang_terminal_set_bg(int32_t color) {
    if (color < 8) {
        printf("\x1b[%dm", 40 + (int)color);
    } else {
        printf("\x1b[%d;1m", 40 + (int)(color - 8));
    }
}

/** Reset all text attributes (color, bold, etc.) to default. */
void codelang_terminal_reset_style(void) {
    printf("\x1b[0m");
}

/** Enable bold text. */
void codelang_terminal_bold(void) {
    printf("\x1b[1m");
}

/** Enable underline. */
void codelang_terminal_underline(void) {
    printf("\x1b[4m");
}

/** Reverse foreground and background colors. */
void codelang_terminal_reverse(void) {
    printf("\x1b[7m");
}

/** Save cursor position. */
void codelang_terminal_save_cursor(void) {
    printf("\x1b[s");
}

/** Restore previously saved cursor position. */
void codelang_terminal_restore_cursor(void) {
    printf("\x1b[u");
}

/**
 * Read a single key press in raw mode.
 * Returns a static string describing the key:
 *   "up" "down" "left" "right"          arrow keys
 *   "enter"  "backspace"  "escape"       special keys
 *   "ctrl-c" "ctrl-d" "ctrl-z"          control keys
 *   "f1".."f4"                           function keys
 *   single character string otherwise   e.g. "a", "1", " "
 * Returns "" on read error or timeout.
 *
 * NOTE: terminal must be in raw mode (codelang_terminal_enable_raw) first.
 *
 * Windows notes:
 *   _getch() returns 0x00 or 0xE0 as a prefix for extended / function keys,
 *   followed by a scan-code byte.  Arrow keys use the 0xE0 prefix.
 */
const char *codelang_terminal_read_key(void) {
    static char ch_buf[2];

#ifdef _WIN32
    int c = _getch();
    if (c == 0 || c == 0xE0) {
        /* Extended key — read second (scan-code) byte */
        int ext = _getch();
        switch (ext) {
            case 0x48: return "up";
            case 0x50: return "down";
            case 0x4B: return "left";
            case 0x4D: return "right";
            case 0x47: return "home";
            case 0x4F: return "end";
            case 0x49: return "page-up";
            case 0x51: return "page-down";
            case 0x53: return "delete";
            /* Function keys (F1-F4) under the 0x00 prefix */
            case 0x3B: return "f1";
            case 0x3C: return "f2";
            case 0x3D: return "f3";
            case 0x3E: return "f4";
            default:   return "";
        }
    }
    switch (c) {
        case 27:  return "escape";
        case 13:  return "enter";
        case 8:
        case 127: return "backspace";
        case 3:   return "ctrl-c";
        case 4:   return "ctrl-d";
        case 26:  return "ctrl-z";
        default:
            ch_buf[0] = (char)c;
            ch_buf[1] = '\0';
            return ch_buf;
    }

#else  /* POSIX */

    unsigned char buf[16];
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf) - 1);
    if (n <= 0) return "";

    if (n == 1) {
        switch ((unsigned char)buf[0]) {
            case 27:  return "escape";
            case 13:
            case 10:  return "enter";
            case 127: return "backspace";
            case 3:   return "ctrl-c";
            case 4:   return "ctrl-d";
            case 26:  return "ctrl-z";
            default:
                ch_buf[0] = (char)buf[0];
                ch_buf[1] = '\0';
                return ch_buf;
        }
    }

    /* Multi-byte starting with a printable char (e.g. "q\n" from a pipe)
     * — treat first byte as the key. */
    if (n >= 2 && buf[0] != 27) {
        unsigned char c = buf[0];
        if (c == 13 || c == 10) return "enter";
        if (c == 127) return "backspace";
        if (c == 3)   return "ctrl-c";
        if (c == 4)   return "ctrl-d";
        ch_buf[0] = (char)c;
        ch_buf[1] = '\0';
        return ch_buf;
    }

    /* ESC [ sequences (arrow keys, function keys, etc.) */
    if (n >= 3 && buf[0] == 27 && buf[1] == '[') {
        switch (buf[2]) {
            case 'A': return "up";
            case 'B': return "down";
            case 'C': return "right";
            case 'D': return "left";
            case 'H': return "home";
            case 'F': return "end";
            case '5': if (n >= 4 && buf[3] == '~') return "page-up";   break;
            case '6': if (n >= 4 && buf[3] == '~') return "page-down"; break;
            case '3': if (n >= 4 && buf[3] == '~') return "delete";    break;
        }
    }

    /* ESC O sequences (function keys on some terminals) */
    if (n >= 3 && buf[0] == 27 && buf[1] == 'O') {
        switch (buf[2]) {
            case 'P': return "f1";
            case 'Q': return "f2";
            case 'R': return "f3";
            case 'S': return "f4";
        }
    }

    return "";
#endif
}
