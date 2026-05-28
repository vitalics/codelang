/**
 * Tests for Set<T> generic alias — resolves to the concrete set type for T.
 *
 * Covers:
 *  1. Set<int>    resolves to %IntSet*
 *  2. Set<string> resolves to %StringSet*
 *  3. Set<bool>   resolves to %BoolSet*
 *  4. Set.new() with type annotation
 *  5. Set<T>.new() with explicit type args (no annotation)
 *
 * Fixture: tests/fixtures/valid/set_generic.code
 *
 * Expected output (12 lines):
 *   2          — Set<int>.size()   (via Set.new() + type annotation)
 *   {10, 20}   — Set<int> print
 *   2          — Set<string>.size() (via Set.new() + type annotation)
 *   {"x", "y"} — Set<string> print
 *   1          — Set<bool>.size()  (via Set.new() + type annotation)
 *   {true}     — Set<bool> print
 *   2          — Set<int>.size()   (via Set<int>.new() explicit type args)
 *   5          — Set<int>.at(0)    (sorted: 5 < 15)
 *   2          — Set<string>.size() (via Set<string>.new() explicit type args)
 *   bar        — Set<string>.at(0) (sorted: bar < foo)
 *   1          — Set<bool>.size()  (via Set<bool>.new() explicit type args)
 *   false      — Set<bool>.at(0)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_generic.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Set<T> generic — IR structure', () => {

    it('Set<int> uses %IntSet* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntSet\*/);
    });

    it('Set<string> uses %StringSet* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringSet\*/);
    });

    it('Set<bool> uses %BoolSet* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %BoolSet\*/);
    });
});

// =============================================================================
// 2. Runtime — Set.new() with type annotation
// =============================================================================

describe('Set.new() with type annotation — runtime', () => {

    it('Set<int>: size() returns 2 after two unique adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('Set<int>: print outputs {10, 20}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('{10, 20}');
    });

    it('Set<string>: size() returns 2 after two unique adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('2');
    });

    it('Set<string>: print outputs {"x", "y"}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('{"x", "y"}');
    });

    it('Set<bool>: size() returns 1 after two identical adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('1');
    });

    it('Set<bool>: print outputs {true}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('{true}');
    });
});

// =============================================================================
// 3. Runtime — Set<T>.new() with explicit type args (no variable annotation)
// =============================================================================

describe('Set<T>.new() with explicit type args — runtime', () => {

    it('Set<int>.new(): size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('2');
    });

    it('Set<int>.new(): at(0) returns 5 (sorted)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('5');
    });

    it('Set<string>.new(): size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('2');
    });

    it('Set<string>.new(): at(0) returns "bar" (lex sorted)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('bar');
    });

    it('Set<bool>.new(): size() returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('1');
    });

    it('Set<bool>.new(): at(0) returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('false');
    });
});

// =============================================================================
// 4. Overall
// =============================================================================

describe('set_generic — overall', () => {

    it('produces exactly 12 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(12);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
