/**
 * Integration tests — switch with closure / higher-order function subjects.
 *
 * Fixture: integration_switch_closures.code
 *
 * Tests:
 *   - switch on the result of calling a closure (add5(3) = 8)
 *   - switch on the result of apply() (apply(add10, 5) = 15)
 *   - switch on the result of compose() (doubleThenSquare(3) = 36)
 *   - switch on the result of identity()
 *   - Proper fnReturnType inference for closures without explicit annotations
 *   - Local (nested) function wrappers use mangled names
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'integration_switch_closures.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('integration — switch + closures — IR structure', () => {
    it('emits indirect calls through fat pointers', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/extractvalue \{ i8\*, i8\* \}/);
    });

    it('emits compose specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@compose_i32_i32_i32/);
    });

    it('nested function wrapper uses mangled name (main.double)', () => {
        const { ir } = compileToIR(FIXTURE);
        // The wrapper should call the mangled local function
        expect(ir).toMatch(/@main\.double/);
    });

    it('nested function wrapper uses mangled name (main.square)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@main\.square/);
    });

    it('switch arms use icmp eq i32 for integer results from closures', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/icmp eq i32/);
    });

    it('switch result alloca stores i8* (string arms)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i8\*/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('integration — switch + closures — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // switch add5(3) { 8 => "eight" }  (5+3=8)
    it('switch add5(3) { 8 => "eight" } → "eight"', () =>
        expect(lines()[0]).toBe('eight'));

    // switch apply(add10, 5) { 15 => "fifteen" }  (10+5=15)
    it('switch apply(add10, 5) { 15 => "fifteen" } → "fifteen"', () =>
        expect(lines()[1]).toBe('fifteen'));

    // switch doubleThenSquare(3) { 36 => "thirty-six" }  ((3*2)^2 = 36)
    it('switch compose(square, double)(3) { 36 => "thirty-six" } → "thirty-six"', () =>
        expect(lines()[2]).toBe('thirty-six'));

    // switch identity(42) { 42 => "identity works" }
    it('switch identity(42) { 42 => "identity works" } → "identity works"', () =>
        expect(lines()[3]).toBe('identity works'));

    it('produces exactly 4 lines of output', () =>
        expect(lines()).toHaveLength(4));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
