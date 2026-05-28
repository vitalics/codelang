/**
 * Tests for stdlib/c-interop.code
 *
 * Covers three layers:
 *  1. IR structure — type aliases resolve to correct LLVM IR types;
 *                    every extern function produces a properly-typed `declare`.
 *  2. String functions  — strlen, strcmp, strncmp, strdup
 *  3. Math functions    — abs (i32), labs (i64)
 *  4. Memory management — malloc, calloc, free (no-crash), memcmp
 *  5. Environment       — getenv
 *
 * Platform assumption: LP64 (macOS / Linux, x86-64 or aarch64).
 * All fixtures live in tests/fixtures/valid/.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── Fixture names ─────────────────────────────────────────────────────────────

const DECLS   = 'c_interop_decls.code';
const STRLEN  = 'c_interop_strlen.code';
const STRCMP  = 'c_interop_strcmp.code';
const ABS     = 'c_interop_abs.code';
const MEMORY  = 'c_interop_memory.code';
const STRDUP  = 'c_interop_strdup.code';
const GETENV  = 'c_interop_getenv.code';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR — type aliases
// =============================================================================

describe('c-interop — type aliases (IR)', () => {

    it('C_Int  variable uses i32 alloca', () => {
        const { ir } = compileToIR(DECLS);
        // const ci: C_Int = 42  → alloca i32
        expect(ir).toMatch(/%ci = alloca i32/);
    });

    it('C_Long variable uses i64 alloca', () => {
        const { ir } = compileToIR(DECLS);
        // const cl: C_Long = 100  → alloca i64
        expect(ir).toMatch(/%cl = alloca i64/);
    });

    it('C_Float variable uses float alloca', () => {
        const { ir } = compileToIR(DECLS);
        // const cf: C_Float = 1.5  → alloca float
        expect(ir).toMatch(/%cf = alloca float/);
    });

    it('C_Double variable uses double alloca', () => {
        const { ir } = compileToIR(DECLS);
        // const cd: C_Double = 2.5  → alloca double
        expect(ir).toMatch(/%cd = alloca double/);
    });

    it('C_SizeT variable uses i64 alloca (unsigned 64-bit)', () => {
        const { ir } = compileToIR(DECLS);
        // C_SizeT = UInt64  → internal sentinel "u64"  → toLLVM → i64
        expect(ir).toMatch(/%csz = alloca i64/);
    });

    it('C_Str variable uses i8* alloca', () => {
        const { ir } = compileToIR(DECLS);
        // C_Str = intrinsic("i8*")
        expect(ir).toMatch(/%cs = alloca i8\*/);
    });

    it('C_VoidPtr variable uses i8* alloca', () => {
        const { ir } = compileToIR(DECLS);
        // C_VoidPtr = intrinsic("i8*")
        expect(ir).toMatch(/%cv = alloca i8\*/);
    });
});

// =============================================================================
// 2. IR — extern function declare signatures
// =============================================================================

describe('c-interop — extern declarations (IR)', () => {

    // ── Memory management ─────────────────────────────────────────────────

    it('declares malloc  : i8* (i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @malloc(i64)');
    });

    it('declares calloc  : i8* (i64, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @calloc(i64, i64)');
    });

    it('declares realloc : i8* (i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @realloc(i8*, i64)');
    });

    it('declares free    : void (i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare void @free(i8*)');
    });

    // ── Memory operations ─────────────────────────────────────────────────

    it('declares memcpy  : i8* (i8*, i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @memcpy(i8*, i8*, i64)');
    });

    it('declares memmove : i8* (i8*, i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @memmove(i8*, i8*, i64)');
    });

    it('declares memset  : i8* (i8*, i32, i64)', () => {
        const { ir } = compileToIR(DECLS);
        // val is C_Int (i32); n is C_SizeT (u64 → i64)
        expect(ir).toContain('declare i8* @memset(i8*, i32, i64)');
    });

    it('declares memcmp  : i32 (i8*, i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i32 @memcmp(i8*, i8*, i64)');
    });

    // ── C string operations ───────────────────────────────────────────────

    it('declares strlen  : i64 (i8*) — returns C_SizeT (unsigned 64-bit)', () => {
        const { ir } = compileToIR(DECLS);
        // C_SizeT = UInt64 → toLLVM → i64
        expect(ir).toContain('declare i64 @strlen(i8*)');
    });

    it('declares strcmp  : i32 (i8*, i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i32 @strcmp(i8*, i8*)');
    });

    it('declares strncmp : i32 (i8*, i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        // n is C_SizeT (u64 → i64)
        expect(ir).toContain('declare i32 @strncmp(i8*, i8*, i64)');
    });

    it('declares strcpy  : i8* (i8*, i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @strcpy(i8*, i8*)');
    });

    it('declares strncpy : i8* (i8*, i8*, i64)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @strncpy(i8*, i8*, i64)');
    });

    it('declares strcat  : i8* (i8*, i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @strcat(i8*, i8*)');
    });

    it('declares strdup  : i8* (i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @strdup(i8*)');
    });

    // ── Integer math ──────────────────────────────────────────────────────

    it('declares abs  : i32 (i32) — C_Int in, C_Int out', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i32 @abs(i32)');
    });

    it('declares labs : i64 (i64) — C_Long in, C_Long out', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i64 @labs(i64)');
    });

    // ── Process control ───────────────────────────────────────────────────

    it('declares exit  : void (i32)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare void @exit(i32)');
    });

    it('declares abort : void ()', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare void @abort()');
    });

    // ── Environment ───────────────────────────────────────────────────────

    it('declares getenv : i8* (i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i8* @getenv(i8*)');
    });

    it('declares putenv : i32 (i8*)', () => {
        const { ir } = compileToIR(DECLS);
        expect(ir).toContain('declare i32 @putenv(i8*)');
    });
});

// =============================================================================
// 3. Runtime — strlen
// =============================================================================

describe('c-interop — strlen (runtime)', () => {

    it('strlen("Hello, World!") === 13', () => {
        const { stdout } = compileAndRun(STRLEN);
        expect(lines(stdout)[0]).toBe('13');
    });

    it('strlen("") === 0  (empty string)', () => {
        const { stdout } = compileAndRun(STRLEN);
        expect(lines(stdout)[1]).toBe('0');
    });

    it('strlen("abc") === 3', () => {
        const { stdout } = compileAndRun(STRLEN);
        expect(lines(stdout)[2]).toBe('3');
    });

    it('strlen("Привет") === 12  (UTF-8 bytes, not codepoints)', () => {
        // 6 Cyrillic codepoints × 2 bytes each = 12 raw bytes
        const { stdout } = compileAndRun(STRLEN);
        expect(lines(stdout)[3]).toBe('12');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(STRLEN);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 4 lines of output', () => {
        const { stdout } = compileAndRun(STRLEN);
        expect(lines(stdout)).toHaveLength(4);
    });
});

// =============================================================================
// 4. Runtime — strcmp / strncmp
// =============================================================================

describe('c-interop — strcmp / strncmp (runtime)', () => {

    it('strcmp("abc", "abc") === 0  (equal strings)', () => {
        const { stdout } = compileAndRun(STRCMP);
        expect(lines(stdout)[0]).toBe('0');
    });

    it('strcmp("abc", "abd") < 0  ("abc" sorts before "abd")', () => {
        const { stdout } = compileAndRun(STRCMP);
        expect(parseInt(lines(stdout)[1], 10)).toBeLessThan(0);
    });

    it('strcmp("abd", "abc") > 0  ("abd" sorts after "abc")', () => {
        const { stdout } = compileAndRun(STRCMP);
        expect(parseInt(lines(stdout)[2], 10)).toBeGreaterThan(0);
    });

    it('strncmp("hello", "help", 3) === 0  (first 3 bytes "hel" are equal)', () => {
        const { stdout } = compileAndRun(STRCMP);
        expect(lines(stdout)[3]).toBe('0');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(STRCMP);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 5. Runtime — abs / labs
// =============================================================================

describe('c-interop — abs / labs (runtime)', () => {

    it('abs(-7) === 7', () => {
        const { stdout } = compileAndRun(ABS);
        expect(lines(stdout)[0]).toBe('7');
    });

    it('abs(7) === 7  (identity on positive input)', () => {
        const { stdout } = compileAndRun(ABS);
        expect(lines(stdout)[1]).toBe('7');
    });

    it('abs(0) === 0', () => {
        const { stdout } = compileAndRun(ABS);
        expect(lines(stdout)[2]).toBe('0');
    });

    it('labs(-1000) === 1000', () => {
        const { stdout } = compileAndRun(ABS);
        expect(lines(stdout)[3]).toBe('1000');
    });

    it('labs(2147483648) === 2147483648  (value exceeds i32 max, fits in i64)', () => {
        const { stdout } = compileAndRun(ABS);
        expect(lines(stdout)[4]).toBe('2147483648');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(ABS);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 6. Runtime — memory management
// =============================================================================

describe('c-interop — memory management (runtime)', () => {

    it('malloc(128) + free does not crash', () => {
        const { exitCode, stdout } = compileAndRun(MEMORY);
        expect(exitCode).toBe(0);
        expect(lines(stdout)[0]).toBe('1');
    });

    it('calloc(4, 16) + free does not crash', () => {
        const { stdout } = compileAndRun(MEMORY);
        expect(lines(stdout)[1]).toBe('2');
    });

    it('memcmp of identical byte regions returns 0', () => {
        const { stdout } = compileAndRun(MEMORY);
        expect(lines(stdout)[2]).toBe('0');
    });

    it('IR: malloc is called with i64 size argument (C_SizeT)', () => {
        const { ir } = compileToIR(MEMORY);
        expect(ir).toMatch(/call i8\* @malloc\(i64/);
    });

    it('IR: free is called with i8* pointer (C_VoidPtr)', () => {
        const { ir } = compileToIR(MEMORY);
        expect(ir).toMatch(/call void @free\(i8\*/);
    });

    it('IR: memcmp is called with (i8*, i8*, i64) arguments', () => {
        const { ir } = compileToIR(MEMORY);
        expect(ir).toMatch(/call i32 @memcmp\(i8\* .+, i8\* .+, i64/);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(MEMORY);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 3 lines of output', () => {
        const { stdout } = compileAndRun(MEMORY);
        expect(lines(stdout)).toHaveLength(3);
    });
});

// =============================================================================
// 7. Runtime — strdup
// =============================================================================

describe('c-interop — strdup (runtime)', () => {

    it('strlen of strdup("hello") === 5', () => {
        const { stdout } = compileAndRun(STRDUP);
        expect(lines(stdout)[0]).toBe('5');
    });

    it('free(strdup result) does not crash', () => {
        const { exitCode, stdout } = compileAndRun(STRDUP);
        expect(exitCode).toBe(0);
        expect(lines(stdout)[1]).toBe('1');
    });

    it('IR: strdup is called with i8* argument', () => {
        const { ir } = compileToIR(STRDUP);
        expect(ir).toMatch(/call i8\* @strdup\(i8\*/);
    });

    it('IR: result of strdup is stored in i8* alloca', () => {
        const { ir } = compileToIR(STRDUP);
        expect(ir).toMatch(/alloca i8\*/);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(STRDUP);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 8. Runtime — getenv
// =============================================================================

describe('c-interop — getenv (runtime)', () => {

    it('getenv("HOME") returns a non-empty string (strlen > 0)', () => {
        const { stdout, exitCode } = compileAndRun(GETENV);
        expect(exitCode).toBe(0);
        const len = parseInt(lines(stdout)[0], 10);
        expect(len).toBeGreaterThan(0);
    });

    it('IR: getenv is called with i8* argument and returns i8*', () => {
        const { ir } = compileToIR(GETENV);
        expect(ir).toMatch(/call i8\* @getenv\(i8\*/);
    });

    it('IR: result of getenv is stored in i8* alloca (C_Str)', () => {
        const { ir } = compileToIR(GETENV);
        // home variable has type C_Str = i8*
        expect(ir).toMatch(/%home = alloca i8\*/);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(GETENV);
        expect(exitCode).toBe(0);
    });
});
