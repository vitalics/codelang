/**
 * Tests for && (and) and || (or) compound boolean conditions.
 *
 * Covers:
 *   - Basic && / || semantics
 *   - Short-circuit evaluation: left=false → right not evaluated for &&;
 *                               left=true  → right not evaluated for ||
 *   - Chained && and chained ||
 *   - Mixed precedence (&&  binds tighter than ||)
 *   - Compound conditions in `while` loops
 *   - LLVM IR structure: phi-node based short-circuit blocks
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('boolean &&/|| — IR structure', () => {
    it('&& emits an and.rhs.N basic block', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/^and\.rhs\.\d+:$/m);
    });

    it('&& emits an and.merge.N basic block', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/^and\.merge\.\d+:$/m);
    });

    it('|| emits an or.rhs.N basic block', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/^or\.rhs\.\d+:$/m);
    });

    it('|| emits an or.merge.N basic block', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/^or\.merge\.\d+:$/m);
    });

    it('&& merge block uses phi [ false, ... ] for the short-circuit path', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/phi i1 \[ false, %[\w.]+\s*\]/);
    });

    it('|| merge block uses phi [ true, ... ] for the short-circuit path', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        expect(ir).toMatch(/phi i1 \[ true, %[\w.]+\s*\]/);
    });

    it('&& branches to rhs on true, to merge on false (left-block br)', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        // br i1 <reg>, label %and.rhs.N, label %and.merge.N
        expect(ir).toMatch(/br i1 %\d+, label %and\.rhs\.\d+, label %and\.merge\.\d+/);
    });

    it('|| branches to merge on true, to rhs on false (left-block br)', () => {
        const { ir } = compileToIR('boolean_and_or.code');
        // br i1 <reg>, label %or.merge.N, label %or.rhs.N
        expect(ir).toMatch(/br i1 %\d+, label %or\.merge\.\d+, label %or\.rhs\.\d+/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('boolean &&/|| — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun('boolean_and_or.code');
        return stdout.trim().split('\n');
    }

    it('true && true executes the then-block', () => {
        expect(lines()).toContain('and_tt');
    });

    it('true && false does not execute the then-block', () => {
        expect(lines()).not.toContain('WRONG');
    });

    it('true || false executes the then-block', () => {
        expect(lines()).toContain('or_tf');
    });

    it('false || true executes the then-block', () => {
        expect(lines()).toContain('or_ft');
    });

    it('chained true && true && true executes the then-block', () => {
        expect(lines()).toContain('chain_ttt');
    });

    it('&&/|| precedence: (a==1 && b==99) || c==3 evaluates to true', () => {
        // false || true → true
        expect(lines()).toContain('mixed1');
    });

    it('&&/|| precedence: a==99 || (b==2 && c==3) evaluates to true', () => {
        // false || true → true
        expect(lines()).toContain('mixed2');
    });

    it('while loop with && condition iterates the correct number of times', () => {
        // n=0, loop while n<3 && a==1, increments n each iteration → n=3
        expect(lines()).toContain('3');
    });

    it('prints "done" as the final line', () => {
        expect(lines().at(-1)).toBe('done');
    });

    it('produces exactly 8 lines of output', () => {
        // and_tt, or_tf, or_ft, chain_ttt, mixed1, mixed2, 3, done
        expect(lines()).toHaveLength(8);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun('boolean_and_or.code');
        expect(exitCode).toBe(0);
    });
});
