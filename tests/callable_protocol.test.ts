/**
 * Tests for the Callable<A, R> protocol and its implementation on Function<A, R>.
 *
 * Covers:
 *   - protocol Callable<A, R> defined in stdlib/protocols.code
 *   - Function<A, R> extends Callable — fn call(arg: A): R { return self(arg); }
 *   - f.call(arg) as sugar for f(arg) where f is a Function<int, int>
 *   - .call() works on named functions, lambdas, and composed function values
 *
 * IR structure checks verify that the specialization is emitted with the
 * correct mangled name and that self is called correctly via the fat pointer.
 *
 * Runtime checks verify the expected output values.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'callable_protocol.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('Callable protocol — IR structure', () => {
    it('Function_i32_i32_call specialization is emitted', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @Function_i32_i32_call\(\{ i8\*, i8\* \}/);
    });

    it('Function_i32_i32_call loads self and calls through the fat pointer', () => {
        const { ir } = compileToIR(FIXTURE);
        // The call implementation should extract the fn ptr and call through it
        expect(ir).toMatch(/@Function_i32_i32_call[\s\S]*bitcast i8\* %\d+ to i32 \(i32, i8\*\)\*/);
    });

    it('call sites use @Function_i32_i32_call', () => {
        const { ir } = compileToIR(FIXTURE);
        const callSites = (ir.match(/@Function_i32_i32_call/g) ?? []).length;
        // At least 4 call sites: f.call(5), g.call(4), h.call(3), incThenDouble.call(4)
        expect(callSites).toBeGreaterThanOrEqual(4);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('Callable protocol — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    it('f.call(5) where f = double == 10', () => expect(lines()[0]).toBe('10'));
    it('g.call(4) where g = lambda x*x == 16', () => expect(lines()[1]).toBe('16'));
    it('h.call(3) where h = compose(square, double) == 36', () =>
        expect(lines()[2]).toBe('36'));
    it('incThenDouble.call(4) == 10  (inc → 5, double → 10)', () =>
        expect(lines()[3]).toBe('10'));

    it('produces exactly 4 lines of output', () =>
        expect(lines()).toHaveLength(4));
    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
