/**
 * Integration tests — switch inside loops / switch as function argument.
 *
 * Fixture: integration_switch_loop.code
 *
 * Tests:
 *   - Function that returns via switch (classify)
 *   - switch used as a direct function-call return value
 *   - switch inside a while loop (accumulate per-iteration results)
 *   - switch used as argument to print() directly (inline switch)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'integration_switch_loop.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('integration — switch + loop — IR structure', () => {
    it('emits a while-loop back-edge branch', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/br i1.*while/);
    });

    it('emits switch arms inside the loop body', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/switch\.arm\.\d+\.\d+:/g) ?? [];
        // Multiple switch instances (classify fn + loop body + inline)
        expect(matches.length).toBeGreaterThan(4);
    });

    it('emits icmp eq i32 for integer switch patterns', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/icmp eq i32/);
    });

    it('alloca for loop counter i', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%i = alloca i32/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('integration — switch + loop — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // classify() called directly as a return-switch function
    it('classify(1) → "one"',  () => expect(lines()[0]).toBe('one'));
    it('classify(2) → "two"',  () => expect(lines()[1]).toBe('two'));
    it('classify(3) → "three"',() => expect(lines()[2]).toBe('three'));
    it('classify(99) → "many"',() => expect(lines()[3]).toBe('many'));

    // while i <= 4: switch i …
    it('loop i=1 → "one"',   () => expect(lines()[4]).toBe('one'));
    it('loop i=2 → "two"',   () => expect(lines()[5]).toBe('two'));
    it('loop i=3 → "three"', () => expect(lines()[6]).toBe('three'));
    it('loop i=4 → "other"', () => expect(lines()[7]).toBe('other'));

    // print(switch 7 { 7 => "lucky" }) — inline switch as argument
    it('print(switch 7 { 7 => "lucky" }) → "lucky"', () =>
        expect(lines()[8]).toBe('lucky'));

    it('produces exactly 9 lines of output', () =>
        expect(lines()).toHaveLength(9));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
