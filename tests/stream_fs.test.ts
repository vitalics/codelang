/**
 * stdlib/stream — file I/O and Stdout/Stdin byte protocol tests.
 *
 * stream_io.code — MemoryStream as print-capture sink + file round-trips
 * (7 expected output lines):
 *   [0]  captured       — writeln() to MemoryStream, read back
 *   [1]  hello from file — toFile() then fromFile()
 *   [2]  hello from file — second fromFile() confirms persistence
 *   [3]  appended        — appendToFile() then fromFile()
 *   [4]  true            — toFile() return value
 *   [5]  65              — writeByte(65) captured in MemoryStream + readByte
 *   [6]  66              — writeByte(66) captured in MemoryStream + readByte
 *
 * fs_stream.code — File.createReadStream / createWriteStream / createAppendStream
 * (5 expected output lines):
 *   [0]  hello stream  — FileReadStream reads first written line
 *   [1]  written       — FileReadStream reads second written line
 *   [2]  true          — File.write() returns bool
 *   [3]  hello stream  — base line after rewrite + createAppendStream
 *   [4]  extra line    — appended line
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Shared fixture results ────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
    ir:       string;
}

let io: FixtureResult  = { exitCode: null, lines: [], ir: '' };
let fs: FixtureResult  = { exitCode: null, lines: [], ir: '' };

beforeAll(() => {
    const r = compileAndRun('stream_io.code');
    io = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

beforeAll(() => {
    const r = compileAndRun('fs_stream.code');
    fs = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

// ── stream_io: compilation ────────────────────────────────────────────────────

describe('stream_io — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(io.exitCode).toBe(0);
    });
    it('produces exactly 7 lines of output', () => {
        expect(io.lines).toHaveLength(7);
    });
});

// ── MemoryStream as print-capture sink ───────────────────────────────────────

describe('MemoryStream — writeln as print-capture sink', () => {
    it('[0] writeln() to MemoryStream, readLine() recovers the value', () => {
        expect(io.lines[0]).toBe('captured');
    });
});

// ── MemoryStream.toFile / fromFile ────────────────────────────────────────────

describe('MemoryStream — toFile / fromFile round-trip', () => {
    it('[1] fromFile() reads back what toFile() wrote', () => {
        expect(io.lines[1]).toBe('hello from file');
    });
    it('[2] second fromFile() call reads the same persisted file', () => {
        expect(io.lines[2]).toBe('hello from file');
    });
    it('[4] toFile() returns true on success', () => {
        expect(io.lines[4]).toBe('true');
    });
});

// ── MemoryStream.appendToFile ─────────────────────────────────────────────────

describe('MemoryStream — appendToFile', () => {
    it('[3] appendToFile() adds content after existing file bytes', () => {
        expect(io.lines[3]).toBe('appended');
    });
});

// ── Stdout ByteWritable: writeByte ────────────────────────────────────────────

describe('Stdout.writeByte (ByteWritable) — verified via MemoryStream probe', () => {
    it('[5] writeByte(65) captured as 65', () => {
        expect(io.lines[5]).toBe('65');
    });
    it('[6] writeByte(66) captured as 66', () => {
        expect(io.lines[6]).toBe('66');
    });
});

// ── fs_stream: compilation ────────────────────────────────────────────────────

describe('fs_stream — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(fs.exitCode).toBe(0);
    });
    it('produces exactly 5 lines of output', () => {
        expect(fs.lines).toHaveLength(5);
    });
});

// ── File.createWriteStream + File.createReadStream ───────────────────────────

describe('File.createWriteStream + File.createReadStream', () => {
    it('[0] FileReadStream reads first line written by FileWriteStream', () => {
        expect(fs.lines[0]).toBe('hello stream');
    });
    it('[1] FileReadStream reads second line written by FileWriteStream', () => {
        expect(fs.lines[1]).toBe('written');
    });
    it('[2] File.write() returns true on success', () => {
        expect(fs.lines[2]).toBe('true');
    });
});

// ── File.createAppendStream ───────────────────────────────────────────────────

describe('File.createAppendStream', () => {
    it('[3] base line is intact after createAppendStream', () => {
        expect(fs.lines[3]).toBe('hello stream');
    });
    it('[4] appended line follows the base line', () => {
        expect(fs.lines[4]).toBe('extra line');
    });
});

// ── IR structure ──────────────────────────────────────────────────────────────

describe('stream_io — IR declarations (new file / Stdout / Stdin helpers)', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('stream_io.code');
        ir = r.ir;
    }, 30_000);

    it('IR: declares @memstream_from_file', () => {
        expect(ir).toMatch(/declare %MemoryStream\* @memstream_from_file\(i8\*\)/);
    });
    it('IR: declares @memstream_to_file', () => {
        expect(ir).toMatch(/declare i32 @memstream_to_file\(%MemoryStream\*, i8\*\)/);
    });
    it('IR: declares @memstream_append_to_file', () => {
        expect(ir).toMatch(/declare i32 @memstream_append_to_file\(%MemoryStream\*, i8\*\)/);
    });
    it('IR: declares @stdout_write_byte', () => {
        expect(ir).toMatch(/declare void @stdout_write_byte\(i32\)/);
    });
    it('IR: declares @stdout_write_bytes', () => {
        expect(ir).toMatch(/declare void @stdout_write_bytes\(%Buffer\*\)/);
    });
    it('IR: declares @stdin_read_byte', () => {
        expect(ir).toMatch(/declare i32 @stdin_read_byte\(\)/);
    });
    it('IR: declares @stdin_read', () => {
        expect(ir).toMatch(/declare %Buffer\* @stdin_read\(i32\)/);
    });
});

describe('fs_stream — IR declarations (FileReadStream / FileWriteStream)', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('fs_stream.code');
        ir = r.ir;
    }, 30_000);

    it('IR: declares @frs_open (via File.createReadStream)', () => {
        expect(ir).toMatch(/declare i8\* @frs_open\(i8\*, i32\)/);
    });
    it('IR: declares @frs_read_line (via FileReadStream.readLine)', () => {
        expect(ir).toMatch(/declare i8\* @frs_read_line\(i8\*\)/);
    });
    it('IR: declares @fws_open (via File.createWriteStream)', () => {
        expect(ir).toMatch(/declare i8\* @fws_open\(i8\*, i32\)/);
    });
    it('IR: declares @fws_write (via FileWriteStream.write)', () => {
        expect(ir).toMatch(/declare void @fws_write\(i8\*, i8\*\)/);
    });
    it('IR: declares @fws_free (via FileWriteStream.free)', () => {
        expect(ir).toMatch(/declare void @fws_free\(i8\*\)/);
    });
});
