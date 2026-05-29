/**
 * stdlib/stream tests — MemoryStream, StringReader, Buffer roundtrip.
 *
 * Two fixture files exercise the complete stream API:
 *
 * stream_basic.code — text-level operations (10 expected output lines):
 *   [0]  hello       — MemoryStream.write + readLine
 *   [1]  world       — second readLine across newline boundary
 *   [2]  13          — length() after writing "hello\nworld\n"
 *   [3]  0           — position() after reset()
 *   [4]  104         — readByte() for 'h'
 *   [5]  line one    — StringReader.from + readLine
 *   [6]  line two    — second readLine
 *   [7]  line three  — third readLine
 *   [8]  foo         — MemoryStream.from + readLine
 *   [9]  bar         — second readLine from MemoryStream.from
 *
 * stream_bytes.code — byte-level and Buffer operations (6 expected output lines):
 *   [0]  72          — writeByte('H') + readByte()
 *   [1]  105         — writeByte('i') + readByte()
 *   [2]  true        — ms.toBuffer().equals(string.toBuffer()) roundtrip
 *   [3]  4           — read(4).length() reads exactly 4 bytes
 *   [4]  0           — StringReader.reset() → position() == 0
 *   [5]  baz         — MemoryStream.from("baz").readAll()
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Shared fixture results ────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
    ir:       string;
}

let basic: FixtureResult = { exitCode: null, lines: [], ir: '' };
let bytes: FixtureResult = { exitCode: null, lines: [], ir: '' };

beforeAll(() => {
    const r = compileAndRun('stream_basic.code');
    basic = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

beforeAll(() => {
    const r = compileAndRun('stream_bytes.code');
    bytes = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('stream_basic — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(basic.exitCode).toBe(0);
    });
    it('produces exactly 10 lines of output', () => {
        expect(basic.lines).toHaveLength(10);
    });
});

describe('stream_bytes — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(bytes.exitCode).toBe(0);
    });
    it('produces exactly 6 lines of output', () => {
        expect(bytes.lines).toHaveLength(6);
    });
});

// ── MemoryStream: text write / read ──────────────────────────────────────────

describe('MemoryStream — write + readLine', () => {
    it('[0] readLine() returns first line', () => {
        expect(basic.lines[0]).toBe('hello');
    });
    it('[1] readLine() returns second line', () => {
        expect(basic.lines[1]).toBe('world');
    });
});

// ── MemoryStream: length / position / reset ───────────────────────────────────

describe('MemoryStream — length / position / reset', () => {
    it('[2] length() returns total bytes written', () => {
        expect(basic.lines[2]).toBe('13');
    });
    it('[3] position() is 0 after reset()', () => {
        expect(basic.lines[3]).toBe('0');
    });
});

// ── MemoryStream: readByte ─────────────────────────────────────────────────────

describe('MemoryStream — readByte', () => {
    it('[4] readByte() after reset() returns first byte (\'h\' = 104)', () => {
        expect(basic.lines[4]).toBe('104');
    });
});

// ── StringReader ──────────────────────────────────────────────────────────────

describe('StringReader — readLine', () => {
    it('[5] first readLine() from StringReader.from()', () => {
        expect(basic.lines[5]).toBe('line one');
    });
    it('[6] second readLine()', () => {
        expect(basic.lines[6]).toBe('line two');
    });
    it('[7] third readLine()', () => {
        expect(basic.lines[7]).toBe('line three');
    });
});

// ── MemoryStream.from ─────────────────────────────────────────────────────────

describe('MemoryStream.from(string)', () => {
    it('[8] readLine() from pre-loaded stream', () => {
        expect(basic.lines[8]).toBe('foo');
    });
    it('[9] second readLine() from pre-loaded stream', () => {
        expect(basic.lines[9]).toBe('bar');
    });
});

// ── MemoryStream: writeByte / readByte ────────────────────────────────────────

describe('MemoryStream — writeByte / readByte', () => {
    it('[0] readByte() returns 72 (\'H\')', () => {
        expect(bytes.lines[0]).toBe('72');
    });
    it('[1] readByte() returns 105 (\'i\')', () => {
        expect(bytes.lines[1]).toBe('105');
    });
});

// ── MemoryStream: toBuffer roundtrip ──────────────────────────────────────────

describe('MemoryStream — toBuffer / Buffer.equals', () => {
    it('[2] ms.toBuffer() equals string.toBuffer() for same content', () => {
        expect(bytes.lines[2]).toBe('true');
    });
});

// ── MemoryStream: read(n) ─────────────────────────────────────────────────────

describe('MemoryStream — read(n) returns Buffer', () => {
    it('[3] read(4).length() is 4', () => {
        expect(bytes.lines[3]).toBe('4');
    });
});

// ── StringReader: reset / position ───────────────────────────────────────────

describe('StringReader — reset / position', () => {
    it('[4] position() is 0 after reset()', () => {
        expect(bytes.lines[4]).toBe('0');
    });
});

// ── MemoryStream.from + readAll ───────────────────────────────────────────────

describe('MemoryStream.from + readAll', () => {
    it('[5] readAll() returns the entire preloaded string', () => {
        expect(bytes.lines[5]).toBe('baz');
    });
});

// ── IR structure ──────────────────────────────────────────────────────────────

describe('stream — IR declarations', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('stream_basic.code');
        ir = r.ir;
    }, 30_000);

    it('IR: emits %MemoryStream opaque type', () => {
        expect(ir).toMatch(/%MemoryStream = type opaque/);
    });
    it('IR: emits %StringReader opaque type', () => {
        expect(ir).toMatch(/%StringReader = type opaque/);
    });
    it('IR: declares @memstream_new', () => {
        expect(ir).toMatch(/declare %MemoryStream\* @memstream_new\(\)/);
    });
    it('IR: declares @memstream_write_str', () => {
        expect(ir).toMatch(/declare void @memstream_write_str\(%MemoryStream\*, i8\*\)/);
    });
    it('IR: declares @memstream_read_line', () => {
        expect(ir).toMatch(/declare i8\* @memstream_read_line\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_read_all', () => {
        expect(ir).toMatch(/declare i8\* @memstream_read_all\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_read', () => {
        expect(ir).toMatch(/declare %Buffer\* @memstream_read\(%MemoryStream\*, i32\)/);
    });
    it('IR: declares @memstream_read_byte', () => {
        expect(ir).toMatch(/declare i32 @memstream_read_byte\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_write_byte', () => {
        expect(ir).toMatch(/declare void @memstream_write_byte\(%MemoryStream\*, i32\)/);
    });
    it('IR: declares @memstream_to_buffer', () => {
        expect(ir).toMatch(/declare %Buffer\* @memstream_to_buffer\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_free', () => {
        expect(ir).toMatch(/declare void @memstream_free\(%MemoryStream\*\)/);
    });
    it('IR: declares @string_reader_new', () => {
        expect(ir).toMatch(/declare %StringReader\* @string_reader_new\(i8\*\)/);
    });
    it('IR: declares @string_reader_read_line', () => {
        expect(ir).toMatch(/declare i8\* @string_reader_read_line\(%StringReader\*\)/);
    });
    it('IR: declares @string_reader_free', () => {
        expect(ir).toMatch(/declare void @string_reader_free\(%StringReader\*\)/);
    });
    it('IR: declares @memstream_from_string', () => {
        expect(ir).toMatch(/declare %MemoryStream\* @memstream_from_string\(i8\*\)/);
    });
    it('IR: declares @memstream_length', () => {
        expect(ir).toMatch(/declare i32 @memstream_length\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_position', () => {
        expect(ir).toMatch(/declare i32 @memstream_position\(%MemoryStream\*\)/);
    });
    it('IR: declares @memstream_reset', () => {
        expect(ir).toMatch(/declare void @memstream_reset\(%MemoryStream\*\)/);
    });
    it('IR: declares @string_reader_position', () => {
        expect(ir).toMatch(/declare i32 @string_reader_position\(%StringReader\*\)/);
    });
    it('IR: declares @string_reader_reset', () => {
        expect(ir).toMatch(/declare void @string_reader_reset\(%StringReader\*\)/);
    });
});
