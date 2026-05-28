/**
 * Tests for stdlib/io.code
 *
 * Covers:
 *  1. write() built-in         — printf("%s", s) with no newline
 *  2. Stdout type              — write / writeln / flush via Writable + Disposable
 *  3. File I/O                 — open, write, writeln, readLine, close, isOpen
 *  4. Process.env              — read / missing env variables
 *  5. Dir.exists               — existing and non-existent paths
 *  6. main(args: string[])     — argc / argv forwarded via codelang_make_args
 *
 * Protocol rename: Writer → Writable,  Reader → Readable.
 * Both are now pure protocols without default implementations.
 *
 * Platform assumption: Unix (macOS / Linux).
 * All fixtures live in tests/fixtures/valid/.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Fixture names ─────────────────────────────────────────────────────────────

const WRITE_BUILTIN    = 'write_builtin.code';
const IO_STDOUT        = 'io_stdout.code';
const IO_FILE_RW       = 'io_file_write_read.code';
const IO_FILE_ISOPEN   = 'io_file_isopen.code';
const IO_PROCESS_ENV   = 'io_process_env.code';
const IO_DIR_EXISTS    = 'io_dir_exists.code';
const MAIN_ARGS        = 'main_args.code';
const MAIN_PROC        = 'main_proc.code';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. write() built-in
// =============================================================================

describe('write() built-in', () => {

    it('concatenates fragments without newlines and prints on one line', () => {
        const { stdout } = compileAndRun(WRITE_BUILTIN);
        // write("Hello"); write(", "); write("world"); write("!"); write("\n")
        expect(stdout).toContain('Hello, world!');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(WRITE_BUILTIN);
        expect(exitCode).toBe(0);
    });

    it('IR: uses @printf with raw "%s" format (no newline in the format string)', () => {
        const { ir } = compileToIR(WRITE_BUILTIN);
        // Raw strings (no \n) are stored in @.raw.N globals
        expect(ir).toMatch(/@\.raw\.\d+ = .*c"%s\\00"/);
    });
});

// =============================================================================
// 2. Stdout type
// =============================================================================

describe('Stdout type — Writable + Disposable (stdlib/io)', () => {

    it('write / writeln / flush produce the expected output', () => {
        const { stdout } = compileAndRun(IO_STDOUT);
        expect(stdout.trim()).toBe('Hello, world!');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(IO_STDOUT);
        expect(exitCode).toBe(0);
    });

    it('IR: Stdout_write is generated (Writable conformance)', () => {
        const { ir } = compileToIR(IO_STDOUT);
        expect(ir).toContain('@Stdout_write');
    });

    it('IR: Stdout_writeln is generated (Writable conformance)', () => {
        const { ir } = compileToIR(IO_STDOUT);
        expect(ir).toContain('@Stdout_writeln');
    });

    it('IR: Stdout_flush is generated and calls @fflush(i8* null)', () => {
        const { ir } = compileToIR(IO_STDOUT);
        expect(ir).toContain('@Stdout_flush');
        expect(ir).toMatch(/call i32 @fflush\(i8\* null\)/);
    });

    it('IR: Stdout_dispose is generated (Disposable conformance)', () => {
        // Stdout extends Disposable { fn dispose() { flush(); } }
        // dispose() is compiled even if not called in the fixture
        const { ir } = compileToIR(IO_STDOUT);
        expect(ir).toContain('@Stdout_dispose');
    });
});

// =============================================================================
// 3. File I/O
// =============================================================================

describe('File I/O (stdlib/io)', () => {

    it('write + readLine round-trips two lines correctly', () => {
        const { stdout, exitCode } = compileAndRun(IO_FILE_RW);
        expect(exitCode).toBe(0);
        const ls = lines(stdout);
        expect(ls[0]).toBe('line one');
        expect(ls[1]).toBe('line two');
    });

    it('produces exactly 2 lines of output', () => {
        const { stdout } = compileAndRun(IO_FILE_RW);
        expect(lines(stdout)).toHaveLength(2);
    });

    it('isOpen() returns true after successfully opening a file', () => {
        const { stdout } = compileAndRun(IO_FILE_ISOPEN);
        expect(lines(stdout)[0]).toBe('open');
    });

    it('isOpen() returns false when fopen fails (file does not exist)', () => {
        const { stdout } = compileAndRun(IO_FILE_ISOPEN);
        expect(lines(stdout)[1]).toBe('closed');
    });

    it('isOpen() fixture exits with code 0', () => {
        const { exitCode } = compileAndRun(IO_FILE_ISOPEN);
        expect(exitCode).toBe(0);
    });

    it('IR: File is emitted as a struct type with an i8* fp field', () => {
        const { ir } = compileToIR(IO_FILE_RW);
        expect(ir).toMatch(/%File = type \{ i8\* \}/);
    });

    it('IR: File.open calls @fopen with two i8* arguments', () => {
        const { ir } = compileToIR(IO_FILE_RW);
        expect(ir).toMatch(/call i8\* @fopen\(i8\* .*, i8\* .*/);
    });

    it('IR: File.close calls @fclose', () => {
        const { ir } = compileToIR(IO_FILE_RW);
        expect(ir).toContain('@fclose');
    });

    it('IR: File.isOpen uses pointer-null comparison (icmp ne i8* …, null)', () => {
        const { ir } = compileToIR(IO_FILE_ISOPEN);
        expect(ir).toMatch(/icmp ne i8\* .*, null/);
    });

    it('IR: File_dispose is generated (Disposable conformance → fclose)', () => {
        const { ir } = compileToIR(IO_FILE_RW);
        expect(ir).toContain('@File_dispose');
        // dispose calls fclose
        expect(ir).toContain('@fclose');
    });
});

// =============================================================================
// 4. Process.env
// =============================================================================

describe('Process.env (stdlib/io)', () => {

    it('Process.env("HOME") returns a non-empty string', () => {
        const { stdout } = compileAndRun(IO_PROCESS_ENV);
        expect(lines(stdout)[0]).toBe('has-home');
    });

    it('Process.env of an unset variable returns empty string ""', () => {
        const { stdout } = compileAndRun(IO_PROCESS_ENV);
        expect(lines(stdout)[1]).toBe('no-var');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(IO_PROCESS_ENV);
        expect(exitCode).toBe(0);
    });

    it('IR: calls @getenv with an i8* argument', () => {
        const { ir } = compileToIR(IO_PROCESS_ENV);
        expect(ir).toMatch(/call i8\* @getenv\(i8\*/);
    });

    it('IR: null-check uses icmp eq i8* …, null (pointer comparison, not integer)', () => {
        const { ir } = compileToIR(IO_PROCESS_ENV);
        // Process.env checks `val == 0` which must lower to `icmp eq i8* %val, null`
        expect(ir).toMatch(/icmp eq i8\* .*, null/);
    });
});

// =============================================================================
// 5. Dir.exists
// =============================================================================

describe('Dir.exists (stdlib/io)', () => {

    it('Dir.exists("/tmp") returns true', () => {
        const { stdout } = compileAndRun(IO_DIR_EXISTS);
        expect(lines(stdout)[0]).toBe('tmp-exists');
    });

    it('Dir.exists of a non-existent path returns false', () => {
        const { stdout } = compileAndRun(IO_DIR_EXISTS);
        expect(lines(stdout)[1]).toBe('missing-absent');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(IO_DIR_EXISTS);
        expect(exitCode).toBe(0);
    });

    it('IR: calls @codelang_path_exists with an i8* path argument', () => {
        const { ir } = compileToIR(IO_DIR_EXISTS);
        expect(ir).toMatch(/call i32 @codelang_path_exists\(i8\*/);
    });
});

// =============================================================================
// 6. main(args: string[])
// =============================================================================

describe('main(args: string[]) — CLI argument forwarding', () => {

    it('args.length() counts the binary + supplied arguments', () => {
        const { stdout } = compileAndRun(MAIN_ARGS);
        // compileAndRun passes no extra args → argc = 1 (binary path only)
        const len = parseInt(lines(stdout)[0], 10);
        expect(len).toBe(1);
    });

    it('args.get(0) is the binary path (non-empty string)', () => {
        const { stdout } = compileAndRun(MAIN_ARGS);
        const arg0 = lines(stdout)[1];
        expect(arg0.length).toBeGreaterThan(0);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(MAIN_ARGS);
        expect(exitCode).toBe(0);
    });

    it('IR: main is defined with i32 argc and i8** argv parameters', () => {
        const { ir } = compileToIR(MAIN_ARGS);
        expect(ir).toMatch(/define i32 @main\(i32 %argc, i8\*\* %argv\)/);
    });

    it('IR: codelang_make_args is called to convert argc/argv → StringArray*', () => {
        const { ir } = compileToIR(MAIN_ARGS);
        expect(ir).toMatch(/call %StringArray\* @codelang_make_args\(i32 %argc, i8\*\* %argv\)/);
    });
});

// =============================================================================
// 7. main(proc: Process)
// =============================================================================

describe('main(proc: Process) — process descriptor entry point', () => {

    it('compiles and exits with code 0', () => {
        const { exitCode } = compileAndRun(MAIN_PROC);
        expect(exitCode).toBe(0);
    });

    it('proc.args.length() counts the binary + supplied arguments', () => {
        const { stdout } = compileAndRun(MAIN_PROC);
        const len = parseInt(lines(stdout)[0], 10);
        expect(len).toBe(1);
    });

    it('proc.args.get(0) is the binary path (non-empty string)', () => {
        const { stdout } = compileAndRun(MAIN_PROC);
        const arg0 = lines(stdout)[1];
        expect(arg0.length).toBeGreaterThan(0);
    });

    it('IR: main is defined with i32 argc and i8** argv parameters', () => {
        const { ir } = compileToIR(MAIN_PROC);
        expect(ir).toMatch(/define i32 @main\(i32 %argc, i8\*\* %argv\)/);
    });

    it('IR: codelang_make_args is called to build the args field', () => {
        const { ir } = compileToIR(MAIN_PROC);
        expect(ir).toMatch(/call %StringArray\* @codelang_make_args\(i32 %argc, i8\*\* %argv\)/);
    });

    it('IR: a %Process* is heap-allocated and stored into the param alloca', () => {
        const { ir } = compileToIR(MAIN_PROC);
        expect(ir).toMatch(/%__proc_ptr\s+=\s+bitcast i8\* .* to %Process\*/);
    });

    it('IR: Process struct type is emitted with three pointer fields', () => {
        const { ir } = compileToIR(MAIN_PROC);
        expect(ir).toMatch(/%Process = type \{ %StringArray\*, %Stdin\*, %Stdout\* \}/);
    });
});
