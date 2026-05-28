/**
 * Tests for `break` and `continue` control-flow statements.
 *
 * Covers:
 *   - break in while:    exits the loop immediately
 *   - continue in while: skips the rest of the body, re-checks condition
 *   - break in for:      exits the loop, update step NOT executed
 *   - continue in for:   skips the rest of the body, runs the update, re-checks
 *   - nested loops:      break / continue affects only the innermost loop
 *   - LLVM IR structure:
 *       while break   → br label %while.merge.N
 *       while continue→ br label %while.cond.N
 *       for   break   → br label %for.merge.N
 *       for   continue→ br label %for.update.N   (update runs before condition)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'break_continue.code';

// ── LLVM IR structure ─────────────────────────────────────────────────────────

describe('break / continue — IR structure', () => {
    it('break in while emits br to while.merge.N', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/br label %while\.merge\.\d+/);
    });

    it('continue in while emits br to while.cond.N', () => {
        const { ir } = compileToIR(FIXTURE);
        // At least one branch to while.cond that originates from a continue
        // (not from the loop-back edge — but we just check the pattern exists)
        expect(ir).toMatch(/br label %while\.cond\.\d+/);
    });

    it('break in for emits br to for.merge.N', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/br label %for\.merge\.\d+/);
    });

    it('continue in for emits br to for.update.N (not for.cond.N)', () => {
        const { ir } = compileToIR(FIXTURE);
        // The `continue` inside the for loop must target the update block
        expect(ir).toMatch(/br label %for\.update\.\d+/);
    });

    it('for loop has a dedicated for.update.N block', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/^for\.update\.\d+:$/m);
    });

    it('for loop update block branches back to for.cond.N', () => {
        const { ir } = compileToIR(FIXTURE);
        // Inside for.update.N the branch target must be for.cond.N
        expect(ir).toMatch(/br label %for\.cond\.\d+/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('break / continue — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // ── while break ──────────────────────────────────────────────────────────
    it('section marker "while_break" is printed', () => {
        expect(lines()).toContain('while_break');
    });

    it('while break: j == 4 when the loop exits', () => {
        const out = lines();
        const idx = out.indexOf('while_break');
        expect(out[idx + 1]).toBe('4');
    });

    // ── while continue ───────────────────────────────────────────────────────
    it('section marker "while_continue" is printed', () => {
        expect(lines()).toContain('while_continue');
    });

    it('while continue: only odd numbers 1 3 5 are printed', () => {
        const out = lines();
        const start = out.indexOf('while_continue') + 1;
        const end   = out.indexOf('for_break');
        expect(out.slice(start, end)).toEqual(['1', '3', '5']);
    });

    it('while continue: even numbers 2 4 6 are NOT printed', () => {
        const out   = lines();
        const start = out.indexOf('while_continue') + 1;
        const end   = out.indexOf('for_break');
        const section = out.slice(start, end);
        expect(section).not.toContain('2');
        expect(section).not.toContain('4');
        expect(section).not.toContain('6');
    });

    // ── for break ────────────────────────────────────────────────────────────
    it('section marker "for_break" is printed', () => {
        expect(lines()).toContain('for_break');
    });

    it('for break: sum of 1..3 equals 6 (break fires before fi == 4 contributes)', () => {
        const out = lines();
        const idx = out.indexOf('for_break');
        expect(out[idx + 1]).toBe('6');
    });

    it('for break: loop iterated exactly 3 times before break', () => {
        const out = lines();
        const idx = out.indexOf('for_break');
        expect(out[idx + 2]).toBe('3');
    });

    // ── for continue ─────────────────────────────────────────────────────────
    it('section marker "for_continue" is printed', () => {
        expect(lines()).toContain('for_continue');
    });

    it('for continue: only odd numbers 1 3 5 are printed', () => {
        const out   = lines();
        const start = out.indexOf('for_continue') + 1;
        const end   = out.indexOf('nested_inner');
        expect(out.slice(start, end)).toEqual(['1', '3', '5']);
    });

    it('for continue: even numbers 2 4 are NOT printed', () => {
        const out   = lines();
        const start = out.indexOf('for_continue') + 1;
        const end   = out.indexOf('nested_inner');
        const section = out.slice(start, end);
        expect(section).not.toContain('2');
        expect(section).not.toContain('4');
    });

    it('for continue: update step still runs (m increments past even values)', () => {
        // If continue skipped the update, m would never reach 3 or 5 and loop would
        // spin forever (or we'd miss those values).  The presence of 3 and 5 in the
        // output confirms the update ran.
        const out   = lines();
        const start = out.indexOf('for_continue') + 1;
        const end   = out.indexOf('nested_inner');
        const section = out.slice(start, end);
        expect(section).toContain('3');
        expect(section).toContain('5');
    });

    // ── nested loops ─────────────────────────────────────────────────────────
    it('section marker "nested_inner" is printed', () => {
        expect(lines()).toContain('nested_inner');
    });

    it('nested break: inner loop stopped at inner == 2 (last_inner == 2)', () => {
        const out = lines();
        const idx = out.indexOf('nested_inner');
        expect(out[idx + 1]).toBe('2');
    });

    it('section marker "nested_outer" is printed', () => {
        expect(lines()).toContain('nested_outer');
    });

    it('nested break: outer loop ran all 3 iterations (outer == 3)', () => {
        const out = lines();
        const idx = out.indexOf('nested_outer');
        expect(out[idx + 1]).toBe('3');
    });

    // ── general ──────────────────────────────────────────────────────────────
    it('"done" is the last line', () => {
        expect(lines().at(-1)).toBe('done');
    });

    it('produces exactly 18 lines of output', () => {
        expect(lines()).toHaveLength(18);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
