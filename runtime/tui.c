/**
 * runtime/tui.c — Cell-buffer backend for stdlib/tui.code
 *
 * Implements an off-screen TUI cell buffer with efficient diff-based
 * terminal rendering (only changed cells are flushed to stdout).
 *
 * Coordinate system: (x, y) are 0-based cell positions within the buffer.
 * ANSI terminal coordinates are 1-based; the render functions add +1.
 *
 * Key functions:
 *   tui_buffer_new(w, h)           — allocate a cell buffer (cells init'd to "dirty")
 *   tui_buffer_free(buf)           — release memory
 *   tui_buffer_reset(buf)          — fill every cell with space / default style
 *   tui_buffer_width(buf)          — buffer column count
 *   tui_buffer_height(buf)         — buffer row count
 *   tui_buffer_set_cell(buf,x,y,sym,fg,bg,mods)  — write a single cell
 *   tui_buffer_get_symbol(buf,x,y) — read the symbol stored in a cell
 *   tui_buffer_get_fg/bg/mods      — read style fields of a cell
 *   tui_buffer_write_str(…)        — write a UTF-8 string across consecutive cells
 *   tui_buffer_fill_area(…)        — fill a rectangular region with one cell
 *   tui_buffer_render_diff(cur,prev) — emit ANSI to update changed cells
 *   tui_buffer_render_full(buf)    — emit ANSI for every cell (full redraw)
 *   tui_buffer_copy(src,dst)       — copy cells from src into dst (for double-buf swap)
 *   tui_str_display_width(s)       — visible cell width of a UTF-8 string
 *   tui_str_char_at(s,i)           — extract the i-th visible character
 *
 * Style modifiers (mods bitmask):
 *   1 = bold   2 = underline   4 = reversed   8 = dim   16 = italic
 *
 * Colors: 0-7 standard ANSI, 8-15 bright (90-97 / 100-107 escape range).
 * fg = -1 and bg = -1 mean "use terminal default colour".
 *
 * ANSI / VT100 notes:
 *   On Windows 10 1511+, ENABLE_VIRTUAL_TERMINAL_PROCESSING must be set
 *   before calling these functions.  codelang_terminal_enable_raw() in
 *   runtime/io.c does this automatically.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── Cell / Buffer structs ───────────────────────────────────────────────── */

#define TUI_SYM_BYTES 8   /* max bytes per cell: covers any BMP code point   */

typedef struct TuiCell {
    char    symbol[TUI_SYM_BYTES]; /* UTF-8 text, NUL-terminated               */
    int32_t fg;                    /* -1 = terminal default, 0-15 = ANSI color  */
    int32_t bg;                    /* -1 = terminal default, 0-15 = ANSI color  */
    int32_t mods;                  /* modifier bitmask (bold=1, ul=2, rev=4 …)  */
} TuiCell;

typedef struct TuiBuffer {
    int32_t  width;
    int32_t  height;
    TuiCell *cells;   /* row-major: cells[y * width + x]                       */
} TuiBuffer;

/* ── UTF-8 helpers ───────────────────────────────────────────────────────── */

/**
 * Copy one UTF-8 character from `p` into `sym` (up to TUI_SYM_BYTES-1 bytes).
 * Returns the number of bytes consumed from `p`, or 0 if at NUL / error.
 */
static int utf8_copy_char(const char *p, char sym[TUI_SYM_BYTES]) {
    memset(sym, 0, TUI_SYM_BYTES);
    if (!p || !*p) return 0;
    unsigned char c = (unsigned char)*p;
    int bytes;
    if      (c < 0x80) bytes = 1;
    else if (c < 0xE0) bytes = 2;
    else if (c < 0xF0) bytes = 3;
    else               bytes = 4;
    /* Clamp to available buffer space */
    if (bytes >= TUI_SYM_BYTES) bytes = TUI_SYM_BYTES - 1;
    for (int i = 0; i < bytes; i++) {
        if (!p[i]) break;
        sym[i] = p[i];
    }
    return bytes;
}

/**
 * Count visible terminal cells needed by UTF-8 string `s`.
 * Counts code points (not bytes), treating non-continuation bytes as 1 cell.
 * CJK wide characters are NOT detected — they count as 1.
 */
int32_t tui_str_display_width(const char *s) {
    if (!s) return 0;
    int32_t n = 0;
    while (*s) {
        unsigned char c = (unsigned char)*s;
        if (c < 0x80 || c >= 0xC0) n++;   /* leading byte = new code point */
        s++;
    }
    return n;
}

/**
 * Return a static string containing the i-th visible character of `s`.
 * Not re-entrant; fine for single-threaded CodeLang programs.
 */
const char *tui_str_char_at(const char *s, int32_t i) {
    static char out[TUI_SYM_BYTES];
    memset(out, 0, TUI_SYM_BYTES);
    if (!s || i < 0) return "";
    int32_t idx = 0;
    while (*s) {
        unsigned char c = (unsigned char)*s;
        if (c < 0x80 || c >= 0xC0) {           /* leading byte */
            if (idx == i) {
                utf8_copy_char(s, out);
                return out;
            }
            idx++;
        }
        s++;
    }
    return "";
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

/**
 * Allocate a new TuiBuffer of `w` x `h` cells.
 * Cells are initialised with symbol="" so the first diff renders everything.
 */
TuiBuffer *tui_buffer_new(int32_t w, int32_t h) {
    TuiBuffer *buf = (TuiBuffer *)malloc(sizeof(TuiBuffer));
    if (!buf) return NULL;
    buf->width  = w > 0 ? w : 1;
    buf->height = h > 0 ? h : 1;
    buf->cells  = (TuiCell *)calloc((size_t)(buf->width * buf->height), sizeof(TuiCell));
    if (!buf->cells) { free(buf); return NULL; }
    /* calloc zeroes everything: symbol="", fg=0, bg=0, mods=0.
     * Set fg/bg to -1 (default) so the initial state is "empty/dirty". */
    for (int i = 0; i < buf->width * buf->height; i++) {
        buf->cells[i].fg = -1;
        buf->cells[i].bg = -1;
    }
    return buf;
}

void tui_buffer_free(TuiBuffer *buf) {
    if (!buf) return;
    free(buf->cells);
    free(buf);
}

/* ── Accessors ───────────────────────────────────────────────────────────── */

int32_t tui_buffer_width(const TuiBuffer *buf)  { return buf ? buf->width  : 0; }
int32_t tui_buffer_height(const TuiBuffer *buf) { return buf ? buf->height : 0; }

/**
 * Reset every cell to: symbol=" ", fg=-1, bg=-1, mods=0.
 * Call this at the start of every frame (beginFrame).
 */
void tui_buffer_reset(TuiBuffer *buf) {
    if (!buf) return;
    for (int i = 0; i < buf->width * buf->height; i++) {
        buf->cells[i].symbol[0] = ' ';
        buf->cells[i].symbol[1] = '\0';
        buf->cells[i].fg   = -1;
        buf->cells[i].bg   = -1;
        buf->cells[i].mods = 0;
    }
}

/** Write a single cell at (x, y).  Out-of-bounds writes are silently ignored. */
void tui_buffer_set_cell(TuiBuffer *buf, int32_t x, int32_t y,
                         const char *sym, int32_t fg, int32_t bg, int32_t mods) {
    if (!buf || x < 0 || y < 0 || x >= buf->width || y >= buf->height) return;
    TuiCell *cell = &buf->cells[y * buf->width + x];
    if (sym && *sym) {
        strncpy(cell->symbol, sym, TUI_SYM_BYTES - 1);
        cell->symbol[TUI_SYM_BYTES - 1] = '\0';
    } else {
        cell->symbol[0] = ' '; cell->symbol[1] = '\0';
    }
    cell->fg   = fg;
    cell->bg   = bg;
    cell->mods = mods;
}

const char *tui_buffer_get_symbol(const TuiBuffer *buf, int32_t x, int32_t y) {
    if (!buf || x < 0 || y < 0 || x >= buf->width || y >= buf->height) return " ";
    return buf->cells[y * buf->width + x].symbol;
}

int32_t tui_buffer_get_fg(const TuiBuffer *buf, int32_t x, int32_t y) {
    if (!buf || x < 0 || y < 0 || x >= buf->width || y >= buf->height) return -1;
    return buf->cells[y * buf->width + x].fg;
}
int32_t tui_buffer_get_bg(const TuiBuffer *buf, int32_t x, int32_t y) {
    if (!buf || x < 0 || y < 0 || x >= buf->width || y >= buf->height) return -1;
    return buf->cells[y * buf->width + x].bg;
}
int32_t tui_buffer_get_mods(const TuiBuffer *buf, int32_t x, int32_t y) {
    if (!buf || x < 0 || y < 0 || x >= buf->width || y >= buf->height) return 0;
    return buf->cells[y * buf->width + x].mods;
}

/* ── Bulk write helpers ──────────────────────────────────────────────────── */

/**
 * Write the UTF-8 string `s` into consecutive cells starting at (x, y).
 * Writes at most `max_width` visible characters.
 * Does NOT wrap — stops at right edge of buffer or max_width.
 */
void tui_buffer_write_str(TuiBuffer *buf, int32_t x, int32_t y, int32_t max_width,
                           const char *s, int32_t fg, int32_t bg, int32_t mods) {
    if (!buf || !s || max_width <= 0 || y < 0 || y >= buf->height) return;
    int32_t col = 0;
    const char *p = s;
    char sym[TUI_SYM_BYTES];
    while (*p && col < max_width) {
        int32_t cx = x + col;
        if (cx >= buf->width) break;
        int bytes = utf8_copy_char(p, sym);
        if (bytes == 0) break;
        tui_buffer_set_cell(buf, cx, y, sym, fg, bg, mods);
        p += bytes;
        col++;
    }
}

/** Fill a rectangular region (x, y, w, h) with one symbol and one style. */
void tui_buffer_fill_area(TuiBuffer *buf, int32_t x, int32_t y, int32_t w, int32_t h,
                           const char *sym, int32_t fg, int32_t bg, int32_t mods) {
    if (!buf) return;
    for (int32_t row = y; row < y + h; row++)
        for (int32_t col = x; col < x + w; col++)
            tui_buffer_set_cell(buf, col, row, sym, fg, bg, mods);
}

/**
 * Render the UTF-8 string `text` into the area (x, y, w, h) of `buf`.
 * If `do_wrap` is non-zero, characters wrap at column boundaries.
 * '\n' always moves to the next row.
 */
void tui_paragraph_render(const char *text, int32_t fg, int32_t bg, int32_t mods,
                           int32_t x, int32_t y, int32_t w, int32_t h,
                           TuiBuffer *buf, int32_t do_wrap) {
    if (!text || !buf || w <= 0 || h <= 0) return;
    int32_t row = 0, col = 0;
    const char *p = text;
    char sym[TUI_SYM_BYTES];
    while (*p && row < h) {
        if ((unsigned char)*p == '\n') {
            row++; col = 0; p++;
            continue;
        }
        if (col >= w) {
            if (do_wrap) { row++; col = 0; }
            else { while (*p && *p != '\n') p++; continue; }
            if (row >= h) break;
        }
        int bytes = utf8_copy_char(p, sym);
        if (bytes == 0) break;
        tui_buffer_set_cell(buf, x + col, y + row, sym, fg, bg, mods);
        p += bytes;
        col++;
    }
}

/**
 * Render a progress gauge into one row at (x, y) of width `w`.
 * ratio = 0..100 (percent filled).
 * label_str = center label; if NULL or empty, defaults to "XX%".
 * filled/empty styles control the two halves; the label is split at the fill
 * boundary so each label character uses the style of the cell beneath it.
 */
void tui_gauge_render(TuiBuffer *buf,
                      int32_t x, int32_t y, int32_t w,
                      int32_t ratio, const char *label_str,
                      int32_t empty_fg,  int32_t empty_bg,  int32_t empty_mods,
                      int32_t filled_fg, int32_t filled_bg, int32_t filled_mods) {
    if (!buf || w <= 0 || y < 0 || y >= buf->height) return;
    int32_t filled = (w * ratio) / 100;
    if (filled > w) filled = w;
    if (filled < 0) filled = 0;

    /* Lay down the background */
    for (int32_t i = 0; i < w; i++) {
        if (i < filled)
            tui_buffer_set_cell(buf, x + i, y, " ", filled_fg, filled_bg, filled_mods);
        else
            tui_buffer_set_cell(buf, x + i, y, " ", empty_fg, empty_bg, empty_mods);
    }

    /* Overlay the label */
    char default_lbl[16];
    const char *lbl = label_str;
    if (!lbl || !*lbl) {
        snprintf(default_lbl, sizeof(default_lbl), "%d%%", (int)ratio);
        lbl = default_lbl;
    }
    int32_t llen = tui_str_display_width(lbl);
    if (llen > 0 && llen <= w) {
        int32_t lx = (w - llen) / 2;
        const char *p = lbl;
        char sym[TUI_SYM_BYTES];
        for (int32_t i = 0; i < llen && *p; i++) {
            int bytes = utf8_copy_char(p, sym);
            if (!bytes) break;
            int32_t cx = x + lx + i;
            if (lx + i < filled)
                tui_buffer_set_cell(buf, cx, y, sym, filled_bg == -1 ? 7 : filled_bg,
                                    filled_fg == -1 ? -1 : filled_fg, filled_mods);
            else
                tui_buffer_set_cell(buf, cx, y, sym, empty_fg, empty_bg, empty_mods);
            p += bytes;
        }
    }
}

/* ── ANSI rendering ──────────────────────────────────────────────────────── */

/** Emit ANSI color/style codes for one cell.  Always resets first. */
static void emit_style(int32_t fg, int32_t bg, int32_t mods) {
    printf("\x1b[0m");                                           /* reset  */
    if (fg >= 0  && fg  < 8)  printf("\x1b[%dm", 30 + fg);     /* std fg */
    if (fg >= 8  && fg  < 16) printf("\x1b[%dm", 90 + fg - 8); /* brt fg */
    if (bg >= 0  && bg  < 8)  printf("\x1b[%dm", 40 + bg);     /* std bg */
    if (bg >= 8  && bg  < 16) printf("\x1b[%dm",100 + bg - 8); /* brt bg */
    if (mods &  1) printf("\x1b[1m");   /* bold      */
    if (mods &  2) printf("\x1b[4m");   /* underline */
    if (mods &  4) printf("\x1b[7m");   /* reversed  */
    if (mods &  8) printf("\x1b[2m");   /* dim       */
    if (mods & 16) printf("\x1b[3m");   /* italic    */
}

/**
 * Diff-render: write to the terminal only the cells that differ from `prev`.
 * Pass prev = NULL to force a full redraw of every cell.
 */
void tui_buffer_render_diff(TuiBuffer *current, TuiBuffer *prev) {
    if (!current) return;
    int32_t last_fg   = -2;   /* -2 = "no style emitted yet" */
    int32_t last_bg   = -2;
    int32_t last_mods = -2;

    for (int32_t ry = 0; ry < current->height; ry++) {
        for (int32_t rx = 0; rx < current->width; rx++) {
            TuiCell *cur = &current->cells[ry * current->width + rx];
            TuiCell *old = (prev &&
                            rx < prev->width &&
                            ry < prev->height)
                           ? &prev->cells[ry * prev->width + rx]
                           : NULL;

            /* Skip identical cells */
            if (old && memcmp(cur, old, sizeof(TuiCell)) == 0) continue;

            /* Move cursor to this cell (1-based ANSI coords) */
            printf("\x1b[%d;%dH", ry + 1, rx + 1);

            /* Emit style only when it changes (reduces escape traffic) */
            if (cur->fg != last_fg || cur->bg != last_bg || cur->mods != last_mods) {
                emit_style(cur->fg, cur->bg, cur->mods);
                last_fg   = cur->fg;
                last_bg   = cur->bg;
                last_mods = cur->mods;
            }

            /* Write the symbol (or a plain space if empty) */
            const char *sym = (cur->symbol[0] != '\0') ? cur->symbol : " ";
            printf("%s", sym);
        }
    }

    printf("\x1b[0m");   /* reset style after render */
    fflush(stdout);
}

/** Full render — equivalent to diff against NULL (draws every cell). */
void tui_buffer_render_full(TuiBuffer *buf) {
    tui_buffer_render_diff(buf, NULL);
}

/**
 * Copy all cells from `src` into `dst`.
 * When buffers differ in size only the overlapping region is copied.
 * Used by Tui.endFrame() to keep `prev` in sync with `current`.
 */
void tui_buffer_copy(TuiBuffer *src, TuiBuffer *dst) {
    if (!src || !dst) return;
    int32_t min_w = src->width  < dst->width  ? src->width  : dst->width;
    int32_t min_h = src->height < dst->height ? src->height : dst->height;
    for (int32_t ry = 0; ry < min_h; ry++)
        for (int32_t rx = 0; rx < min_w; rx++)
            dst->cells[ry * dst->width + rx] = src->cells[ry * src->width + rx];
}
