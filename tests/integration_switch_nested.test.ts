/**
 * Integration tests — nested switch / switch-on-computed-value / switch + if
 *
 * Fixture: integration_switch_nested.code
 *
 * Tests:
 *   - Calling a function that returns via switch (grade / describe)
 *   - Inline nested: switch on the result of a function call
 *   - switch + if combination
 *   - switch whose subject is an arithmetic expression (3 * 4)
 *   - Multiple independent switches in sequence
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'integration_switch_nested.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('integration — nested switch — IR structure', () => {
    it('emits multiple switch.arm blocks', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/switch\.arm\.\d+\.\d+:/g) ?? [];
        expect(matches.length).toBeGreaterThan(4);
    });

    it('emits multiple switch.merge blocks', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/switch\.merge\.\d+:/g) ?? [];
        expect(matches.length).toBeGreaterThan(3);
    });

    it('emits strcmp for string pattern matching', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i32 @strcmp\(i8\*/);
    });

    it('declares strcmp when string patterns are used', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @strcmp\(i8\*, i8\*\)/);
    });

    it('emits integer comparison (arithmetic subject 3*4)', () => {
        const { ir } = compileToIR(FIXTURE);
        // 3*4 = 12 as arithmetic subject → icmp eq i32 …, 12
        expect(ir).toMatch(/icmp eq i32.*12/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('integration — nested switch — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // grade(80) → "B" passed to describe(g) → "good"
    it('grade(80) → "B"', () => expect(lines()[0]).toBe('B'));
    it('describe(grade(80)) → "good"', () => expect(lines()[1]).toBe('good'));

    // Inline nested switch: switch grade(90) { "A" => "top", … }
    it('switch grade(90) { "A" => "top" } → "top"', () => expect(lines()[2]).toBe('top'));

    // switch + if: x=5 → category="large" → print "big number"
    it('switch x { else => "large" } + if category == "large" → "big number"', () =>
        expect(lines()[3]).toBe('big number'));

    // switch 3*4 { 12 => "twelve" }
    it('switch 3*4 { 12 => "twelve" } → "twelve"', () => expect(lines()[4]).toBe('twelve'));

    // Multiple sequential switches
    it('switch 1 { 1 => "one" } → "one"', () => expect(lines()[5]).toBe('one'));
    it('switch 2 { 2 => "two" } → "two"', () => expect(lines()[6]).toBe('two'));
    it('switch 3 { 3 => "three" } → "three"', () => expect(lines()[7]).toBe('three'));

    it('produces exactly 8 lines of output', () =>
        expect(lines()).toHaveLength(8));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
