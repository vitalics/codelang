/**
 * Regression tests for built-in methods on primitive types and their dispatch
 * inside template-string holes and generic specializations.
 *
 * Fixtures covered:
 *   int_methods.code                    — int.toString() / int.length()
 *   float_methods.code                  — float.toString()
 *   template_method_call.code           — method calls inside $"..." holes
 *   generics_displayable.code           — fn<T extends Displayable> specialization
 *   generics_displayable_countable.code — fn<T extends Displayable, Countable>
 *                                         (reproduces the examples/01_simple.code scenario)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── int built-in methods ──────────────────────────────────────────────────────
//
// int.toString()  → decimal string, e.g.  10 → "10",  0 → "0",  -42 → "-42"
// int.length()    → digit count (sign counts as one digit):
//                      10 → 2,  0 → 1,  -42 → 3,  100 → 3,  1 → 1

describe('int built-in methods — runtime', () => {
    function lines(): string[] {
        return compileAndRun('int_methods.code').stdout.trim().split('\n');
    }

    // toString() correctness
    it('(10).toString()  == "10"',  () => expect(lines()[0]).toBe('10'));
    it('(0).toString()   == "0"',   () => expect(lines()[1]).toBe('0'));
    it('(-42).toString() == "-42"', () => expect(lines()[2]).toBe('-42'));

    // length() — number of decimal digits, sign counts
    it('(10).length()  == 2',  () => expect(lines()[3]).toBe('2'));
    it('(0).length()   == 1',  () => expect(lines()[4]).toBe('1'));
    it('(-42).length() == 3',  () => expect(lines()[5]).toBe('3'));
    it('(100).length() == 3',  () => expect(lines()[6]).toBe('3'));
    it('(1).length()   == 1',  () => expect(lines()[7]).toBe('1'));

    it('produces exactly 8 lines of output', () =>
        expect(lines()).toHaveLength(8));
    it('exits with code 0', () =>
        expect(compileAndRun('int_methods.code').exitCode).toBe(0));
});

describe('int built-in methods — IR', () => {
    it('declares @int_to_string(i32)', () => {
        const { ir } = compileToIR('int_methods.code');
        expect(ir).toMatch(/declare i8\* @int_to_string\(i32\)/);
    });

    it('declares @int_digit_count(i32)', () => {
        const { ir } = compileToIR('int_methods.code');
        expect(ir).toMatch(/declare i32 @int_digit_count\(i32\)/);
    });

    it('calls @int_to_string in the IR body', () => {
        const { ir } = compileToIR('int_methods.code');
        expect(ir).toMatch(/call i8\* @int_to_string\(i32/);
    });

    it('calls @int_digit_count in the IR body', () => {
        const { ir } = compileToIR('int_methods.code');
        expect(ir).toMatch(/call i32 @int_digit_count\(i32/);
    });
});

// ── float built-in methods ────────────────────────────────────────────────────
//
// float.toString()  → decimal string using %.15g formatting (no trailing zeros):
//   3.14 → "3.14",  0.0 → "0",  -2.5 → "-2.5"

describe('float built-in methods — runtime', () => {
    function lines(): string[] {
        return compileAndRun('float_methods.code').stdout.trim().split('\n');
    }

    it('(3.14).toString()  == "3.14"', () => expect(lines()[0]).toBe('3.14'));
    it('(0.0).toString()   == "0"',    () => expect(lines()[1]).toBe('0'));
    it('(-2.5).toString()  == "-2.5"', () => expect(lines()[2]).toBe('-2.5'));

    it('produces exactly 3 lines of output', () =>
        expect(lines()).toHaveLength(3));
    it('exits with code 0', () =>
        expect(compileAndRun('float_methods.code').exitCode).toBe(0));
});

describe('float built-in methods — IR', () => {
    it('declares @float_to_string(double)', () => {
        const { ir } = compileToIR('float_methods.code');
        expect(ir).toMatch(/declare i8\* @float_to_string\(double\)/);
    });

    it('calls @float_to_string in the IR body', () => {
        const { ir } = compileToIR('float_methods.code');
        expect(ir).toMatch(/call i8\* @float_to_string\(double/);
    });
});

// ── Method calls inside template-string holes ─────────────────────────────────
//
// Regression: {x.toString()} and {x.length()} inside $"..." previously produced
// "undef" because emitMiniExpr only handled struct field accesses, not method
// calls on primitive types.

describe('template string holes — method calls (runtime)', () => {
    function lines(): string[] {
        return compileAndRun('template_method_call.code').stdout.trim().split('\n');
    }

    it('{n.toString()} in template hole evaluates to "42"', () =>
        expect(lines()[0]).toBe('n.toString()=42'));

    it('{n.length()} in template hole evaluates to "2"', () =>
        expect(lines()[1]).toBe('n.length()=2'));

    it('{f.toString()} in template hole evaluates to "1.5"', () =>
        expect(lines()[2]).toBe('f.toString()=1.5'));

    it('{s.toString()} in template hole evaluates to "hello"', () =>
        expect(lines()[3]).toBe('s.toString()=hello'));

    it('{s.length()} in template hole evaluates to "5"', () =>
        expect(lines()[4]).toBe('s.length()=5'));

    it('combined template with multiple method-call holes', () =>
        expect(lines()[5]).toBe('int=42 digits=2 float=1.5'));

    it('produces 6 lines with no "undef" anywhere', () => {
        const { stdout } = compileAndRun('template_method_call.code');
        expect(stdout).not.toContain('undef');
        expect(stdout.trim().split('\n')).toHaveLength(6);
    });

    it('exits with code 0', () =>
        expect(compileAndRun('template_method_call.code').exitCode).toBe(0));
});

describe('template string holes — method calls (IR)', () => {
    it('declares @int_to_string for {n.toString()} hole', () => {
        const { ir } = compileToIR('template_method_call.code');
        expect(ir).toMatch(/declare i8\* @int_to_string\(i32\)/);
    });

    it('declares @int_digit_count for {n.length()} hole', () => {
        const { ir } = compileToIR('template_method_call.code');
        expect(ir).toMatch(/declare i32 @int_digit_count\(i32\)/);
    });

    it('declares @float_to_string for {f.toString()} hole', () => {
        const { ir } = compileToIR('template_method_call.code');
        expect(ir).toMatch(/declare i8\* @float_to_string\(double\)/);
    });

    it('no store of undef in main (no phantom undef values)', () => {
        const { ir } = compileToIR('template_method_call.code');
        // Undef appearing as a stored value is the failure signature
        expect(ir).not.toMatch(/store i8\* undef/);
    });
});

// ── Generic fn<T extends Displayable> specialization ─────────────────────────
//
// fn describe<T extends Displayable>(const item: T) { print($"value: {item.toString()}"); }
//
// Must specialize for T = int, float, string, bool and produce correct output.

describe('generics — Displayable bound (runtime)', () => {
    function lines(): string[] {
        return compileAndRun('generics_displayable.code').stdout.trim().split('\n');
    }

    it('describe(99)     prints "value: 99"',    () => expect(lines()[0]).toBe('value: 99'));
    it('describe(3.14)   prints "value: 3.14"',  () => expect(lines()[1]).toBe('value: 3.14'));
    it('describe("world") prints "value: world"', () => expect(lines()[2]).toBe('value: world'));
    it('describe(true)   prints "value: true"',  () => expect(lines()[3]).toBe('value: true'));

    it('produces exactly 4 lines', () => expect(lines()).toHaveLength(4));
    it('exits with code 0', () =>
        expect(compileAndRun('generics_displayable.code').exitCode).toBe(0));
});

describe('generics — Displayable bound (IR)', () => {
    it('emits @describe_i32 specialization for int argument', () => {
        const { ir } = compileToIR('generics_displayable.code');
        expect(ir).toMatch(/define .* @describe_i32\(i32/);
    });

    it('emits @describe_f64 specialization for float argument', () => {
        const { ir } = compileToIR('generics_displayable.code');
        expect(ir).toMatch(/define .* @describe_f64\(double/);
    });

    it('emits @describe_str specialization for string argument', () => {
        const { ir } = compileToIR('generics_displayable.code');
        expect(ir).toMatch(/define .* @describe_str\(i8\*/);
    });

    it('emits @describe_bool specialization for bool argument', () => {
        const { ir } = compileToIR('generics_displayable.code');
        expect(ir).toMatch(/define .* @describe_bool\(i1/);
    });

    it('@describe_i32 body contains @int_to_string call', () => {
        const { ir } = compileToIR('generics_displayable.code');
        // The template hole {item.toString()} dispatches to int_to_string for i32
        expect(ir).toMatch(/@describe_i32[\s\S]*@int_to_string/);
    });

    it('no undef stored as template-hole result in any specialization', () => {
        const { ir } = compileToIR('generics_displayable.code');
        expect(ir).not.toMatch(/store i8\* undef/);
    });
});

// ── Generic fn<T extends Displayable, Countable> — regression for 01_simple.code
//
// fn process<T extends Displayable, Countable>(const item: T) {
//     print($"display: {item.toString()}, length: {item.length()}");
// }
//
// This is the exact pattern from examples/01_simple.code that was broken.
// The comma creates two type params (T + unused Countable), so the int
// specialization suffix is _i32_str.  Both {item.toString()} and {item.length()}
// must resolve to real values, not undef.

describe('generics — Displayable + Countable bound (runtime)', () => {
    function lines(): string[] {
        return compileAndRun('generics_displayable_countable.code').stdout.trim().split('\n');
    }

    it('process(10)   prints "display: 10, length: 2"',   () => expect(lines()[0]).toBe('display: 10, length: 2'));
    it('process(0)    prints "display: 0, length: 1"',    () => expect(lines()[1]).toBe('display: 0, length: 1'));
    it('process(-5)   prints "display: -5, length: 2"',   () => expect(lines()[2]).toBe('display: -5, length: 2'));
    it('process(100)  prints "display: 100, length: 3"',  () => expect(lines()[3]).toBe('display: 100, length: 3'));

    it('produces exactly 4 lines', () => expect(lines()).toHaveLength(4));

    it('output contains no "undef"', () => {
        const { stdout } = compileAndRun('generics_displayable_countable.code');
        expect(stdout).not.toContain('undef');
    });

    it('exits with code 0', () =>
        expect(compileAndRun('generics_displayable_countable.code').exitCode).toBe(0));
});

describe('generics — Displayable + Countable bound (IR)', () => {
    it('emits a process specialization for int', () => {
        const { ir } = compileToIR('generics_displayable_countable.code');
        // Comma syntax → two type params: T=int (i32), Countable=str (i8*)
        // giving the suffix _i32_str
        expect(ir).toMatch(/define .* @process_i32_str\(/);
    });

    it('@process_i32_str calls @int_to_string for {item.toString()} hole', () => {
        const { ir } = compileToIR('generics_displayable_countable.code');
        expect(ir).toMatch(/@process_i32_str[\s\S]*@int_to_string/);
    });

    it('@process_i32_str calls @int_digit_count for {item.length()} hole', () => {
        const { ir } = compileToIR('generics_displayable_countable.code');
        expect(ir).toMatch(/@process_i32_str[\s\S]*@int_digit_count/);
    });

    it('no undef stored as template-hole result', () => {
        const { ir } = compileToIR('generics_displayable_countable.code');
        expect(ir).not.toMatch(/store i8\* undef/);
    });
});
