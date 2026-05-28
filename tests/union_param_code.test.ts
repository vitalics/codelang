/**
 * Tests for the `string | Code` union parameter type.
 *
 * Key points:
 *   • `Code` is declared in stdlib/reflection.code as `intrinsic("i8*")` —
 *     the same LLVM type as `string`.
 *   • A parameter typed `string | Code` accepts either variant without a cast.
 *   • The LLVM function signature uses `i8*` for such a parameter.
 *
 * Fixture: union_param_code.code
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

function lines(fixture: string): string[] {
    return compileAndRun(fixture).stdout.trim().split('\n');
}

// =============================================================================
// 1. Runtime behaviour
// =============================================================================

describe('union param (string | Code) — runtime output', () => {
    it('call with plain string literal: label is "from string:"', () =>
        expect(lines('union_param_code.code')[0]).toBe('from string:'));

    it('call with plain string literal: src is "hello from string"', () =>
        expect(lines('union_param_code.code')[1]).toBe('hello from string'));

    it('call with Code binding: label is "from Code:"', () =>
        expect(lines('union_param_code.code')[2]).toBe('from Code:'));

    it('call with Code binding: src is "hello from Code"', () =>
        expect(lines('union_param_code.code')[3]).toBe('hello from Code'));

    it('call with Code from template literal: label is "from template:"', () =>
        expect(lines('union_param_code.code')[4]).toBe('from template:'));

    it('call with Code from template literal: src is "hello world"', () =>
        expect(lines('union_param_code.code')[5]).toBe('hello world'));
});

describe('union param (string | Code) — output and exit', () => {
    it('produces exactly 6 lines', () =>
        expect(lines('union_param_code.code')).toHaveLength(6));

    it('exits with code 0', () =>
        expect(compileAndRun('union_param_code.code').exitCode).toBe(0));
});

// =============================================================================
// 2. IR structure
// =============================================================================

describe('union param (string | Code) — IR structure', () => {
    it('describe() is compiled with i8* for the src parameter', () => {
        const { ir } = compileToIR('union_param_code.code');
        // The LLVM function signature must use i8* for both parameters
        expect(ir).toMatch(/define.*@describe\(i8\* %arg\.0, i8\* %arg\.1\)/);
    });

    it('Code binding is allocated as i8*', () => {
        const { ir } = compileToIR('union_param_code.code');
        expect(ir).toMatch(/%code = alloca i8\*, align 8/);
    });

    it('generated Code binding is allocated as i8*', () => {
        const { ir } = compileToIR('union_param_code.code');
        expect(ir).toMatch(/%generated = alloca i8\*, align 8/);
    });

    it('all three call sites use i8* arguments', () => {
        const { ir } = compileToIR('union_param_code.code');
        const calls = (ir.match(/call void @describe\(/g) ?? []);
        expect(calls).toHaveLength(3);
    });
});
