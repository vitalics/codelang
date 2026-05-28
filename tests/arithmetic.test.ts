/**
 * Arithmetic edge-case tests.
 *
 * Covers: operator precedence, integer division (truncation toward zero),
 * modulo sign convention, and signed arithmetic with negative values.
 * These behaviours differ from Python/Ruby (floor division) and expose
 * common compiler bugs around operation ordering and sign handling.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

describe('arithmetic — operator precedence', () => {
    it('* binds tighter than + : 2+3*4 = 14', () => {
        const { exitCode, stdout } = compileAndRun('arith_precedence.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('14\n20\n4\n26\n');
    });

    it('IR: mul instruction appears before add in 2+3*4', () => {
        const { ir } = compileToIR('arith_precedence.code');
        // mul must come before the first add in the IR text
        const mulIdx = ir.indexOf('mul i32');
        const addIdx = ir.indexOf('add i32');
        expect(mulIdx).toBeGreaterThanOrEqual(0);
        expect(addIdx).toBeGreaterThanOrEqual(0);
        expect(mulIdx).toBeLessThan(addIdx);
    });
});

describe('arithmetic — integer division and modulo', () => {
    it('integer division truncates toward zero: 7/2=3, 100/7=14', () => {
        const { exitCode, stdout } = compileAndRun('arith_div_mod.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('3\n1\n3\n14\n2\n');
    });

    it('IR: uses sdiv (signed) not udiv for integer /', () => {
        const { ir } = compileToIR('arith_div_mod.code');
        expect(ir).toMatch(/sdiv i32/);
        expect(ir).not.toMatch(/udiv/);
    });

    it('IR: uses srem (signed) not urem for integer %', () => {
        const { ir } = compileToIR('arith_div_mod.code');
        expect(ir).toMatch(/srem i32/);
        expect(ir).not.toMatch(/urem/);
    });
});

describe('arithmetic — signed division/modulo with negatives', () => {
    it('(-7)/2=-3 (truncates toward 0, not floor), (-7)%3=-1, 7%(-3)=1', () => {
        const { exitCode, stdout } = compileAndRun('arith_negative.code');
        expect(exitCode).toBe(0);
        // The C standard / LLVM sdiv truncates toward zero:
        //   (-7) / 2  = -3  (Python gives -4)
        //   (-7) % 3  = -1  (Python gives 2)
        //    7  % (-3) = 1  (Python gives -2)
        expect(stdout).toBe('-3\n-1\n1\n');
    });
});
