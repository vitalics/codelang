/**
 * Tests for the "void function must not return a value" validator rule.
 *
 * The core bug: code like
 *
 *   fn lol(): void { return 1; }
 *
 * previously silently produced invalid LLVM IR (`ret i32 1` in a void
 * function), which was then rejected by clang with a cryptic low-level error:
 *
 *   error: value doesn't match function result type 'void'
 *   ret i32 1
 *
 * The validator now catches this at the semantic level and reports a clear
 * CodeLang error before the IR is ever generated.
 *
 * Covers:
 *   - `void` extension method returning a value (the original bug)
 *   - Top-level `void` function returning a value
 *   - Nested return inside an `if` block inside a void function
 *   - Bare `return;` inside a void function — must be accepted
 *   - Error message content: function name, "return type is void", help hint
 *   - Exact source underline points to the return *value* (not the keyword)
 *   - Regression: non-void functions returning values still compile
 */

import { describe, it, expect } from 'vitest';
import { compileExpectError, compileToIR, compileAndRun } from './helpers/cli.js';

// ── Programs that must be rejected ───────────────────────────────────────────

describe('void return — extension method (original clang bug)', () => {
    it('is rejected with a non-zero exit code', () => {
        const result = compileExpectError('void_return_value.code');
        expect(result.exitCode).toBe(1);
    });

    it('error mentions the function name', () => {
        const { stderr } = compileExpectError('void_return_value.code');
        expect(stderr).toContain("function 'lol'");
    });

    it('error mentions "return type is void"', () => {
        const { stderr } = compileExpectError('void_return_value.code');
        expect(stderr).toContain('return type is void');
    });

    it('error includes help to use bare return or change signature', () => {
        const { stderr } = compileExpectError('void_return_value.code');
        expect(stderr).toContain("bare 'return;'");
    });

    it('does NOT reach clang — no "value doesn\'t match function result type" message', () => {
        const result = compileExpectError('void_return_value.code');
        const combined = result.stdout + result.stderr;
        expect(combined).not.toContain("value doesn't match function result type");
        expect(combined).not.toContain('clang failed');
    });

    it('error mentions "cannot return a value"', () => {
        const { stderr } = compileExpectError('void_return_value.code');
        expect(stderr).toContain('Cannot return a value');
    });
});

describe('void return — top-level void function', () => {
    it('is rejected with a non-zero exit code', () => {
        const result = compileExpectError('void_return_value_fn.code');
        expect(result.exitCode).toBe(1);
    });

    it('error mentions the function name', () => {
        const { stderr } = compileExpectError('void_return_value_fn.code');
        expect(stderr).toContain("function 'greet'");
    });

    it('help suggests the inferred type "int"', () => {
        const { stderr } = compileExpectError('void_return_value_fn.code');
        expect(stderr).toContain("'int'");
    });
});

describe('void return — nested inside if-block', () => {
    it('is rejected even when the return is in a nested block', () => {
        const result = compileExpectError('void_return_value_nested.code');
        expect(result.exitCode).toBe(1);
    });

    it('error mentions the enclosing function name, not the if-block', () => {
        const { stderr } = compileExpectError('void_return_value_nested.code');
        expect(stderr).toContain("function 'checkSign'");
    });

    it('error points to the nested return value (not the outer fn declaration)', () => {
        const { stderr } = compileExpectError('void_return_value_nested.code');
        // The caret underline should appear on the `return 1` line
        expect(stderr).toContain('return 1');
    });
});

// ── Programs that must be accepted ───────────────────────────────────────────

describe('void return — bare return; is accepted', () => {
    it('compiles without error', () => {
        expect(compileToIR('void_return_bare.code').exitCode).toBe(0);
    });

    it('runs correctly: earlyExit(-1) prints nothing, earlyExit(42) prints 42', () => {
        const { exitCode, stdout } = compileAndRun('void_return_bare.code');
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('42');
    });
});

describe('void return — non-void functions are not affected', () => {
    it('a function returning int still compiles', () => {
        expect(compileToIR('hello.code').exitCode).toBe(0);
    });

    it('params.code (int return) still compiles', () => {
        expect(compileToIR('params.code').exitCode).toBe(0);
    });
});

// ── IR structure — no `ret i32` in void function ──────────────────────────────

describe('void return — IR never emits ret <value> for void functions', () => {
    it('void_return_bare.code emits ret void (not ret i32)', () => {
        const { ir } = compileToIR('void_return_bare.code');
        // The early-exit path should use `ret void`
        expect(ir).toContain('ret void');
        // There should be no `ret i32` or `ret i8*` in the earlyExit function
        const earlyExitMatch = ir.match(/define[^{]+earlyExit[^{]*\{([\s\S]*?)\n\}/);
        if (earlyExitMatch) {
            expect(earlyExitMatch[1]).not.toMatch(/ret i32|ret i64|ret i8\*/);
        }
    });
});
