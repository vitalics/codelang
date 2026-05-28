/**
 * Tests for Map<K,V> generic alias — resolves to the concrete map type for K and V.
 *
 * Covers all four variants created via Map.new() (type annotation) AND
 * Map<K,V>.new() (explicit type args, no annotation).
 *
 * Fixture: tests/fixtures/valid/map_generic.code
 *
 * Expected output (18 lines):
 *   2                              — Map<int,int>.size()     (via Map.new(), type annotation)
 *   100                            — Map<int,int>.get(10)
 *   {10: 100, 20: 200}
 *   2                              — Map<string,int>.size()  (via Map.new(), type annotation)
 *   1                              — Map<string,int>.get("x")
 *   {"x": 1, "y": 2}
 *   2                              — Map<int,string>.size()  (via Map.new(), type annotation)
 *   one                            — Map<int,string>.get(1)
 *   {1: "one", 2: "two"}
 *   2                              — Map<string,string>.size()(via Map.new(), type annotation)
 *   world                          — Map<string,string>.get("hello")
 *   {"foo": "bar", "hello": "world"}
 *   2                              — Map<int,int>.size()     (via Map<int,int>.new(), explicit)
 *   10                             — Map<int,int>.get(1)
 *   2                              — Map<string,int>.size()  (via Map<string,int>.new(), explicit)
 *   1                              — Map<string,int>.get("a")
 *   1                              — Map<string,string>.size()(via Map<string,string>.new(), explicit)
 *   v                              — Map<string,string>.get("k")
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_generic.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Map<K,V> generic — IR structure', () => {

    it('Map<int,int> uses %IntIntMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntIntMap\*/);
    });

    it('Map<string,int> uses %StringIntMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringIntMap\*/);
    });

    it('Map<int,string> uses %IntStringMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntStringMap\*/);
    });

    it('Map<string,string> uses %StringStringMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringStringMap\*/);
    });
});

// =============================================================================
// 2. Runtime — Map.new() with type annotation
// =============================================================================

describe('Map.new() with type annotation — runtime', () => {

    it('Map<int,int> size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('Map<int,int> get(10) returns 100', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('100');
    });

    it('Map<int,int> print outputs {10: 100, 20: 200}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('{10: 100, 20: 200}');
    });

    it('Map<string,int> size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('2');
    });

    it('Map<string,int> get("x") returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('1');
    });

    it('Map<string,int> print outputs {"x": 1, "y": 2}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('{"x": 1, "y": 2}');
    });

    it('Map<int,string> size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('2');
    });

    it('Map<int,string> get(1) returns "one"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('one');
    });

    it('Map<int,string> print outputs {1: "one", 2: "two"}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('{1: "one", 2: "two"}');
    });

    it('Map<string,string> size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('2');
    });

    it('Map<string,string> get("hello") returns "world"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('world');
    });

    it('Map<string,string> print outputs sorted keys', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('{"foo": "bar", "hello": "world"}');
    });
});

// =============================================================================
// 3. Runtime — Map<K,V>.new() with explicit type args (no variable annotation)
// =============================================================================

describe('Map<K,V>.new() with explicit type args — runtime', () => {

    it('Map<int,int>.new() — size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('2');
    });

    it('Map<int,int>.new() — get(1) returns 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('10');
    });

    it('Map<string,int>.new() — size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('2');
    });

    it('Map<string,int>.new() — get("a") returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('1');
    });

    it('Map<string,string>.new() — size() returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[16]).toBe('1');
    });

    it('Map<string,string>.new() — get("k") returns "v"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[17]).toBe('v');
    });
});

// =============================================================================
// 4. Overall
// =============================================================================

describe('map_generic — overall', () => {

    it('produces exactly 18 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(18);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
