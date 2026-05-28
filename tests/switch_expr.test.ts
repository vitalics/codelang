/**
 * Tests for the switch expression.
 *
 * switch subject { pattern => arm, … else => arm }
 *
 * Covers:
 *   - String patterns  ("foo" => …)
 *   - Integer patterns (42 => …)
 *   - Bool patterns    (true/false => …)
 *   - else catch-all arm
 *   - Expression arms  (bare value)
 *   - Block arms       ({ return …; } — early function return)
 *   - Generated IR structure (alloca result slot, strcmp for strings, icmp for ints/bools)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'switch_expr.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('switch expression — IR structure', () => {
    it('allocates an i8* result slot for string-result switch', () => {
        const { ir } = compileToIR(FIXTURE);
        // At least one alloca i8* for the switch result
        expect(ir).toMatch(/alloca i8\*/);
    });

    it('string patterns emit strcmp calls', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i32 @strcmp\(i8\*/);
    });

    it('integer patterns emit icmp eq i32', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/icmp eq i32/);
    });

    it('bool patterns emit icmp eq i1', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/icmp eq i1/);
    });

    it('switch labels are emitted (switch.arm, switch.merge)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/switch\.arm\.\d+\.\d+:/);
        expect(ir).toMatch(/switch\.merge\.\d+:/);
    });

    it('strcmp is declared when string patterns are used', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @strcmp\(i8\*, i8\*\)/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('switch expression — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // String patterns in main()
    it('else arm: switch "other" { "qwe"=>…, "asd"=>…, else=>"world" } == "world"', () =>
        expect(lines()[0]).toBe('world'));

    // Block arm via classify()
    it('expression arm: classify("asd") == "hello"', () =>
        expect(lines()[1]).toBe('hello'));
    it('block arm with return: classify("qwe") == "got qwe"', () =>
        expect(lines()[2]).toBe('got qwe'));
    it('else arm: classify("zzz") == "world"', () =>
        expect(lines()[3]).toBe('world'));

    // Integer patterns
    it('int pattern: switch 2 { 1=>…, 2=>"two", 3=>…, else=>… } == "two"', () =>
        expect(lines()[4]).toBe('two'));

    // Bool patterns
    it('bool pattern: switch true { true=>"yes", false=>"no" } == "yes"', () =>
        expect(lines()[5]).toBe('yes'));

    // First arm matches
    it('first arm: switch "qwe" { "qwe"=>"matched", else=>"nope" } == "matched"', () =>
        expect(lines()[6]).toBe('matched'));

    // Else catches unknown string
    it('else: switch "zzz" { "aaa"=>…, "bbb"=>…, else=>"default" } == "default"', () =>
        expect(lines()[7]).toBe('default'));

    it('produces exactly 8 lines of output', () =>
        expect(lines()).toHaveLength(8));
    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
