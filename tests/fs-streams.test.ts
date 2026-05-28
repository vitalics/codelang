/**
 * stdlib/fs — FileReadStream / FileWriteStream tests
 *
 * Exercises File.createReadStream(), File.createWriteStream(),
 * File.createAppendStream() and the instance methods on both stream types.
 *
 * Fixture: tests/fixtures/valid/fs_file_streams.code
 *
 * Expected output (15 lines, indices 0-14):
 *   0  Hello              FileWriteStream.write → File.read verifies
 *   1  5                  File.size after write
 *   2  Hello, World       createAppendStream adds ", World"
 *   3  12                 File.size after append ("Hello, World" = 12 bytes)
 *   4  Fresh              createWriteStream truncates existing content
 *   5  alpha              FileReadStream.readLine #1
 *   6  beta               FileReadStream.readLine #2
 *   7  gamma              FileReadStream.readLine #3
 *   8  true               FileReadStream.atEnd() after all lines consumed
 *   9  beta               read(6) skips "alpha\n"; next readLine returns "beta"
 *  10  true               readAll() drains file; atEnd() confirms EOF
 *  11  true               atEnd() on an empty file
 *  12  10                 File.size of "row1\nrow2\n" (4+1+4+1 = 10 bytes)
 *  13  row1               readLine #1 after writeln("row1")
 *  14  row2               readLine #2 after writeln("row2")
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── Fixture ───────────────────────────────────────────────────────────────────

let lines:    string[]    = [];
let exitCode: number|null = null;

beforeAll(() => {
    const result = compileAndRun('fs_file_streams.code');
    exitCode     = result.exitCode;
    lines        = result.stdout.trim().split('\n');
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('fs_file_streams — compilation', () => {
    it('compiles and exits 0',         () => expect(exitCode).toBe(0));
    it('produces 15 output lines',     () => expect(lines).toHaveLength(15));
});

// ── FileWriteStream — write / verify ─────────────────────────────────────────

describe('FileWriteStream — write', () => {
    it('write stores content correctly',   () => expect(lines[0]).toBe('Hello'));
    it('File.size matches bytes written',  () => expect(lines[1]).toBe('5'));
});

// ── FileWriteStream — createAppendStream ─────────────────────────────────────

describe('FileWriteStream — createAppendStream', () => {
    it('append adds to existing file',    () => expect(lines[2]).toBe('Hello, World'));
    it('size grows after append',         () => expect(lines[3]).toBe('12'));
});

// ── FileWriteStream — createWriteStream truncates ────────────────────────────

describe('FileWriteStream — truncate on createWriteStream', () => {
    it('createWriteStream discards old content', () => expect(lines[4]).toBe('Fresh'));
});

// ── FileReadStream — readLine ─────────────────────────────────────────────────

describe('FileReadStream — readLine', () => {
    it('readLine #1 === "alpha"',           () => expect(lines[5]).toBe('alpha'));
    it('readLine #2 === "beta"',            () => expect(lines[6]).toBe('beta'));
    it('readLine #3 === "gamma"',           () => expect(lines[7]).toBe('gamma'));
    it('atEnd() is true after all lines',   () => expect(lines[8]).toBe('true'));
});

// ── FileReadStream — read(n) advances position ────────────────────────────────

describe('FileReadStream — read(n) advances position', () => {
    it('read(6) skips "alpha\\n"; next readLine === "beta"', () => {
        expect(lines[9]).toBe('beta');
    });
});

// ── FileReadStream — readAll + atEnd ─────────────────────────────────────────

describe('FileReadStream — readAll + atEnd', () => {
    it('atEnd() is true after readAll()',   () => expect(lines[10]).toBe('true'));
});

// ── FileReadStream — empty file ───────────────────────────────────────────────

describe('FileReadStream — atEnd on empty file', () => {
    it('atEnd() is true immediately on empty file', () => expect(lines[11]).toBe('true'));
});

// ── FileWriteStream — writeln ─────────────────────────────────────────────────

describe('FileWriteStream — writeln (appends newline)', () => {
    it('writeln("row1") + writeln("row2") = 10 bytes', () => expect(lines[12]).toBe('10'));
    it('readLine #1 === "row1"',                        () => expect(lines[13]).toBe('row1'));
    it('readLine #2 === "row2"',                        () => expect(lines[14]).toBe('row2'));
});
