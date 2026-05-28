/**
 * Validator tests
 *
 * Verifies that the semantic validator rejects invalid programs with the
 * correct error messages and a non-zero exit code, and that valid programs
 * produce no errors.
 */

import { describe, it, expect } from 'vitest';
import { compileExpectError, compileToIR } from './helpers/cli.js';

// ── Programs that must be rejected ───────────────────────────────────────────

describe('validator — const variable', () => {
    it('rejects reassignment to a const variable', () => {
        const result = compileExpectError('const_reassign.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Cannot assign to 'x'");
        expect(result.stderr).toContain('const');
    });

    it('rejects a const binding without an initializer', () => {
        const result = compileExpectError('const_no_init.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("'const' binding 'x' must be initialized");
        expect(result.stderr).toContain("Use 'let'");
    });
});

describe('validator — const parameter', () => {
    it('rejects reassignment to a const parameter', () => {
        const result = compileExpectError('const_param.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Cannot assign to 'val'");
        expect(result.stderr).toContain("'const' parameter");
    });
});

describe('validator — const fn purity', () => {
    it('rejects print() inside a const fn', () => {
        const result = compileExpectError('const_fn_print.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('runtime side-effect');
        expect(result.stderr).toContain('const fn');
    });
});

// ── Protocol conformance ─────────────────────────────────────────────────────

describe('validator — protocol conformance', () => {

    it('rejects return type mismatch (void required, int given)', () => {
        const result = compileExpectError('protocol_return_type_mismatch.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Protocol conformance error');
        expect(result.stderr).toContain("method 'lol'");
        expect(result.stderr).toContain("return type mismatch");
        expect(result.stderr).toContain("'int'");
        expect(result.stderr).toContain("'void'");
    });

    it('rejects missing required method implementation', () => {
        const result = compileExpectError('protocol_missing_method.code');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("does not implement required method 'draw'");
        expect(result.stderr).toContain("protocol 'Drawable'");
    });

});

// ── Programs that must be accepted ───────────────────────────────────────────
//
// We compile to IR only (--ir) so we get fast pass/fail feedback without
// waiting for clang.

describe('validator — valid programs are accepted', () => {
    it('accepts hello.code', () => {
        expect(compileToIR('hello.code').exitCode).toBe(0);
    });

    it('accepts let_reassign.code', () => {
        expect(compileToIR('let_reassign.code').exitCode).toBe(0);
    });

    it('accepts const_var.code', () => {
        expect(compileToIR('const_var.code').exitCode).toBe(0);
    });

    it('accepts multi_print.code', () => {
        expect(compileToIR('multi_print.code').exitCode).toBe(0);
    });

    it('accepts typed_vars.code', () => {
        expect(compileToIR('typed_vars.code').exitCode).toBe(0);
    });

    it('accepts const_fn_pure.code', () => {
        expect(compileToIR('const_fn_pure.code').exitCode).toBe(0);
    });

    it('accepts params.code', () => {
        expect(compileToIR('params.code').exitCode).toBe(0);
    });

    it('accepts protocol_conformance.code (correct implementation)', () => {
        expect(compileToIR('protocol_conformance.code').exitCode).toBe(0);
    });
});
