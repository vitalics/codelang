/**
 * Tests for generic collection construction syntax:
 *
 *   let s: Set<int> = Set.new()       — type annotation, no type args on receiver
 *   let s = Set<string>.new()         — explicit type args, no annotation
 *   let m: Map<int,int> = Map.new()   — Map type annotation
 *   let m = Map<string,int>.new()     — explicit Map type args
 *
 * Fixture: tests/fixtures/valid/generic_new_syntax.code
 *
 * Expected output (9 lines):
 *   3       — Set<int> via Set.new() + type annotation: size after 3 adds
 *   2       — Set<string> via Set<string>.new(): size after 2 adds
 *   hello   — Set<string>.at(0) (lex-sorted: hello < world)
 *   2       — Map<int,int> via Map.new() + type annotation: size after 2 puts
 *   10      — Map<int,int>.get(1)
 *   2       — Map<string,int> via Map<string,int>.new(): size after 2 puts
 *   1       — Map<string,int>.get("a")
 *   1       — Map<string,string> via Map<string,string>.new(): size after 1 put
 *   v       — Map<string,string>.get("k")
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'generic_new_syntax.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Generic new() syntax — IR structure', () => {

    it('Set.new() with int annotation produces %IntSet* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntSet\*/);
    });

    it('Set<string>.new() produces %StringSet* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringSet\*/);
    });

    it('Map.new() with Map<int,int> annotation produces %IntIntMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntIntMap\*/);
    });

    it('Map<string,int>.new() produces %StringIntMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringIntMap\*/);
    });

    it('Map<string,string>.new() produces %StringStringMap* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringStringMap\*/);
    });

    it('emits no WARNING for unresolved Set.new() or Map.new()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).not.toMatch(/WARNING.*Set.*new/);
        expect(ir).not.toMatch(/WARNING.*Map.*new/);
    });
});

// =============================================================================
// 2. Runtime — Set.new() with type annotation / Set<T>.new() with type args
// =============================================================================

describe('Set.new() and Set<T>.new() — runtime', () => {

    it('Set<int> via Set.new(): size() returns 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('Set<string> via Set<string>.new(): size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('2');
    });

    it('Set<string> at(0) returns "hello" (lex order)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('hello');
    });
});

// =============================================================================
// 3. Runtime — Map.new() with type annotation / Map<K,V>.new() with type args
// =============================================================================

describe('Map.new() and Map<K,V>.new() — runtime', () => {

    it('Map<int,int> via Map.new(): size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('2');
    });

    it('Map<int,int> via Map.new(): get(1) returns 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('10');
    });

    it('Map<string,int> via Map<string,int>.new(): size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('2');
    });

    it('Map<string,int> via Map<string,int>.new(): get("a") returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('1');
    });

    it('Map<string,string> via Map<string,string>.new(): size() returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('1');
    });

    it('Map<string,string> via Map<string,string>.new(): get("k") returns "v"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('v');
    });
});

// =============================================================================
// 4. Overall
// =============================================================================

describe('generic_new_syntax — overall', () => {

    it('produces exactly 9 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(9);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
