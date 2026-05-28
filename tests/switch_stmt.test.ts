/**
 * Tests for SwitchStatement — the `switch` statement form.
 *
 * Covers:
 *  1. String pattern dispatch
 *  2. Integer pattern dispatch
 *  3. Bool pattern dispatch
 *  4. else (catch-all) arm
 *  5. IR structure (chained branches, merge label)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const SWITCH_STMT = 'switch_stmt.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. String patterns
// =============================================================================

describe('SwitchStatement — string patterns', () => {

    it('compiles and exits with code 0', () => {
        const { exitCode } = compileAndRun(SWITCH_STMT);
        expect(exitCode).toBe(0);
    });

    it('matches "hello" → "greeting"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[0]).toBe('greeting');
    });

    it('matches "bye" → "farewell"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[1]).toBe('farewell');
    });

    it('unmatched string falls through to else → "other"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[2]).toBe('other');
    });
});

// =============================================================================
// 2. Integer patterns
// =============================================================================

describe('SwitchStatement — integer patterns', () => {

    it('matches 1 → "one"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[3]).toBe('one');
    });

    it('matches 2 → "two"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[4]).toBe('two');
    });

    it('matches 100 → "hundred"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[5]).toBe('hundred');
    });

    it('unmatched int falls through to else → "other"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[6]).toBe('other');
    });
});

// =============================================================================
// 3. Bool patterns
// =============================================================================

describe('SwitchStatement — bool patterns', () => {

    it('matches true → "yes"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[7]).toBe('yes');
    });

    it('matches false → "no"', () => {
        const { stdout } = compileAndRun(SWITCH_STMT);
        expect(lines(stdout)[8]).toBe('no');
    });
});

// =============================================================================
// 4. IR structure
// =============================================================================

describe('SwitchStatement — IR structure', () => {

    it('emits sw.check labels for each non-else pattern arm', () => {
        const { ir } = compileToIR(SWITCH_STMT);
        expect(ir).toMatch(/sw\.check\.\d+\.\d+:/);
    });

    it('emits sw.arm labels for each arm body', () => {
        const { ir } = compileToIR(SWITCH_STMT);
        expect(ir).toMatch(/sw\.arm\.\d+\.\d+:/);
    });

    it('emits a sw.merge label for the continuation block', () => {
        const { ir } = compileToIR(SWITCH_STMT);
        expect(ir).toMatch(/sw\.merge\.\d+:/);
    });

    it('uses strcmp for string pattern comparison', () => {
        const { ir } = compileToIR(SWITCH_STMT);
        expect(ir).toMatch(/call i32 @strcmp/);
    });

    it('uses icmp eq for integer pattern comparison', () => {
        const { ir } = compileToIR(SWITCH_STMT);
        expect(ir).toMatch(/icmp eq i32/);
    });
});
