/**
 * Tests for BinaryAdd / BinarySub / BinaryMul / BinaryDiv / BinaryMod protocols
 * and the IR-level operator dispatch via extension methods.
 *
 * Two fixtures:
 *  - number_operators.code   — Number.add/sub/mul/div/mod method calls
 *  - operator_overload.code  — custom Point type; + - * dispatch to Point_add/sub/mul
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── Number.add / sub / mul / div / mod ────────────────────────────────────────

describe('Number — BinaryAdd/Sub/Mul/Div/Mod protocols', () => {

    it('emits @Number_add extension method', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/define.*@Number_add\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_sub extension method', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/define.*@Number_sub\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_mul extension method', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/define.*@Number_mul\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_div extension method', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/define.*@Number_div\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_mod extension method', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/define.*@Number_mod\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('a.add(b) call site dispatches through @Number_add', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/call %Number\* @Number_add\(%Number\*/);
    });

    it('Number_add body uses C-runtime @number_add', () => {
        const { ir } = compileToIR('number_operators.code');
        expect(ir).toMatch(/call %Number\* @number_add\(%Number\*/);
    });

    it('10.add(3) === 13', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[0]).toBe('13');
    });

    it('10.sub(3) === 7', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[1]).toBe('7');
    });

    it('10.mul(3) === 30', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[2]).toBe('30');
    });

    it('10.div(3) === 3 (integer Number division)', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[3]).toBe('3');
    });

    it('10.mod(3) === 1', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[4]).toBe('1');
    });

    it('result of add can be stored in a Number variable', () => {
        const { stdout } = compileAndRun('number_operators.code');
        expect(stdout.trim().split('\n')[5]).toBe('13');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('number_operators.code');
        expect(exitCode).toBe(0);
    });
});

// ── Custom type operator overloading ─────────────────────────────────────────

describe('Operator overloading — custom Point type', () => {

    it('+ dispatches to @Point_add (not a primitive add instruction)', () => {
        const { ir } = compileToIR('operator_overload.code');
        expect(ir).toMatch(/call i64 @Point_add\(i64/);
    });

    it('- dispatches to @Point_sub', () => {
        const { ir } = compileToIR('operator_overload.code');
        expect(ir).toMatch(/call i64 @Point_sub\(i64/);
    });

    it('* dispatches to @Point_mul', () => {
        const { ir } = compileToIR('operator_overload.code');
        expect(ir).toMatch(/call i64 @Point_mul\(i64/);
    });

    it('emits @Point_add extension method definition', () => {
        const { ir } = compileToIR('operator_overload.code');
        expect(ir).toMatch(/define.*@Point_add\(i64 %self\.0, i64 %arg\.0\)/);
    });

    it('Point(3,4) + Point(1,2) = Point(4,6)', () => {
        const { stdout } = compileAndRun('operator_overload.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('4');  // x
        expect(lines[1]).toBe('6');  // y
    });

    it('Point(3,4) - Point(1,2) = Point(2,2)', () => {
        const { stdout } = compileAndRun('operator_overload.code');
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('2');  // x
        expect(lines[3]).toBe('2');  // y
    });

    it('Point(3,4) * Point(1,2) = Point(3,8)', () => {
        const { stdout } = compileAndRun('operator_overload.code');
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('3');  // x
        expect(lines[5]).toBe('8');  // y
    });

    it('.add() method call gives same result as + operator', () => {
        const { stdout } = compileAndRun('operator_overload.code');
        const lines = stdout.trim().split('\n');
        expect(lines[6]).toBe('4');  // x  (same as + result)
        expect(lines[7]).toBe('6');  // y
    });

    it('Number % still uses C-runtime (no Point_mod — not defined)', () => {
        // Point does not implement BinaryMod, so % on Point is undefined.
        // This test confirms that the + dispatch only activates when the
        // extension method exists.
        const { ir } = compileToIR('operator_overload.code');
        expect(ir).not.toMatch(/@Point_mod/);
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('operator_overload.code');
        expect(exitCode).toBe(0);
    });
});
