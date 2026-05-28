/**
 * Tests for Number implementing Displayable and Logical protocols.
 *
 * Covers:
 *   - Displayable: Number.toString() returns decimal string representation
 *   - Logical:     Number.toBoolean() returns false for 0/NaN, true otherwise
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'number_protocols.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('Number protocols — IR structure', () => {
    it('Number extends Displayable — Number_toString is emitted', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @Number_toString\(%Number\*/);
    });

    it('Number extends Logical — Number_toBoolean is emitted', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @Number_toBoolean\(%Number\*/);
    });

    it('toString calls number_to_string runtime function', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Number_toString[\s\S]*call.*@number_to_string/);
    });

    it('toBoolean calls number_to_bool runtime function', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Number_toBoolean[\s\S]*call.*@number_to_bool/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('Number protocols — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    it('Number(42).toString() == "42"',     () => expect(lines()[0]).toBe('42'));
    it('Number(0).toString()  == "0"',      () => expect(lines()[1]).toBe('0'));
    it('Number(3).toString()  == "3"',      () => expect(lines()[2]).toBe('3'));

    it('Number(42).toBoolean() == true  → true', () => expect(lines()[3]).toBe('true'));
    it('Number(0).toBoolean()  == false → false', () => expect(lines()[4]).toBe('false'));
    it('Number(3).toBoolean()  == true  → true', () => expect(lines()[5]).toBe('true'));

    it('produces exactly 6 lines of output', () =>
        expect(lines()).toHaveLength(6));
    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
