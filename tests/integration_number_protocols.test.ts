/**
 * Integration tests — Number protocols (Displayable + Logical) combined with
 * switch and if statements.
 *
 * Fixture: integration_number_protocols.code
 *
 * Tests:
 *   - a.toString() used as switch subject
 *   - a.toBoolean() used as if condition
 *   - a.toBoolean() used as switch subject (bool patterns)
 *   - c.toString() for a negative number
 *   - chain: b.toString() → variable → switch
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'integration_number_protocols.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('integration — Number protocols — IR structure', () => {
    it('emits Number_toString extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define.*@Number_toString/);
    });

    it('emits Number_toBoolean extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define.*@Number_toBoolean/);
    });

    it('Number_toString calls number_to_string runtime', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i8\* @number_to_string\(%Number\*/);
    });

    it('Number_toBoolean calls number_to_bool runtime', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call.*@number_to_bool\(%Number\*/);
    });

    it('emits strcmp for string-value switch (toString result)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i32 @strcmp\(i8\*/);
    });

    it('emits bool-pattern icmp for toBoolean switch', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/icmp eq i1/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('integration — Number protocols — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // switch a.toString() { "42" => "forty-two" }
    it('switch a.toString() == "42" → "forty-two"', () =>
        expect(lines()[0]).toBe('forty-two'));

    // if a.toBoolean() → "a is truthy"
    it('if a.toBoolean() → "a is truthy"', () =>
        expect(lines()[1]).toBe('a is truthy'));

    // if b.toBoolean() else → "b is falsy"
    it('if b.toBoolean() else → "b is falsy"', () =>
        expect(lines()[2]).toBe('b is falsy'));

    // switch a.toBoolean() { true => "non-zero" }
    it('switch a.toBoolean() { true => "non-zero" } → "non-zero"', () =>
        expect(lines()[3]).toBe('non-zero'));

    // c.toString() for c = -7
    it('c.toString() where c = -7 → "-7"', () =>
        expect(lines()[4]).toBe('-7'));

    // chain: s = b.toString(); switch s { "0" => "zero string" }
    it('switch b.toString() { "0" => "zero string" } → "zero string"', () =>
        expect(lines()[5]).toBe('zero string'));

    it('produces exactly 6 lines of output', () =>
        expect(lines()).toHaveLength(6));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
