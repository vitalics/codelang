/**
 * Integration tests — Callable protocol / Function<A,R>.call()
 *
 * Fixture: integration_callable_protocol.code
 *
 * Tests:
 *   - const f: Function<int,int> = double; f.call(5) → 10
 *   - Reassign to a different function and call
 *   - .call() on the result of compose()
 *   - switch on .call() result
 *   - .call() as argument to apply()
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'integration_callable_protocol.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('integration — Callable protocol — IR structure', () => {
    it('emits monomorphized Function_call extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        // Generic specialization: Function<int,int> → Function_i32_i32_call
        expect(ir).toMatch(/define.*@Function_i32_i32_call/);
    });

    it('Function_call uses indirect call (fat pointer)', () => {
        const { ir } = compileToIR(FIXTURE);
        // The call method body invokes the fat pointer
        expect(ir).toMatch(/extractvalue \{ i8\*, i8\* \}/);
    });

    it('emits icmp eq i32 for integer-pattern switch on .call() result', () => {
        const { ir } = compileToIR(FIXTURE);
        // switch k.call(5) { 25 => … } → integer comparison
        expect(ir).toMatch(/icmp eq i32.*25/);
    });

    it('imports compose from stdlib', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@compose/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('integration — Callable protocol — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // const f: Function<int,int> = double; f.call(5) = 10; f.call(0) = 0
    it('f.call(5) on double → 10', () => expect(lines()[0]).toBe('10'));
    it('f.call(0) on double → 0', () => expect(lines()[1]).toBe('0'));

    // const g: Function<int,int> = square; g.call(4) = 16
    it('g.call(4) on square → 16', () => expect(lines()[2]).toBe('16'));

    // const h = compose(double, inc); h.call(3) = double(inc(3)) = double(4) = 8
    it('compose(double, inc).call(3) → 8', () => expect(lines()[3]).toBe('8'));

    // switch k.call(5) { 25 => "five-squared" } where k = square
    it('switch k.call(5) { 25 => "five-squared" } → "five-squared"', () =>
        expect(lines()[4]).toBe('five-squared'));

    // apply(double, f.call(3)) = apply(double, 6) = 12
    it('apply(double, f.call(3)) → 12', () => expect(lines()[5]).toBe('12'));

    it('produces exactly 6 lines of output', () =>
        expect(lines()).toHaveLength(6));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
