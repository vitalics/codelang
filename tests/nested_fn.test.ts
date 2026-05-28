/**
 * Nested function (local fn) tests.
 *
 * Covers:
 *   - declaring a fn inside a function body and calling it
 *   - nested fn with parameters and return value
 *   - deeply nested fns (fn inside fn inside fn)
 *   - forward-reference error (calling before declaration)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR, compileExpectError } from './helpers/cli.js';

describe('nested functions — runtime', () => {
    it('greet() prints "hello world"', () => {
        const { exitCode, stdout } = compileAndRun('nested_fn.code');
        expect(exitCode).toBe(0);
        expect(stdout).toContain('hello world');
    });

    it('add(3,4) returns 7', () => {
        const { exitCode, stdout } = compileAndRun('nested_fn.code');
        expect(exitCode).toBe(0);
        expect(stdout).toContain('7');
    });

    it('deeply nested fn works', () => {
        const { exitCode, stdout } = compileAndRun('nested_fn.code');
        expect(exitCode).toBe(0);
        expect(stdout).toContain('deeply nested');
    });

    it('full output is in correct order', () => {
        const { exitCode, stdout } = compileAndRun('nested_fn.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('hello world\n7\ndeeply nested\n');
    });
});

describe('nested functions — IR structure', () => {
    it('local fn emitted as private with mangled name @main.greet', () => {
        const { ir } = compileToIR('nested_fn.code');
        expect(ir).toMatch(/define private.*@main\.greet\(\)/);
    });

    it('local fn emitted as private with mangled name @main.add', () => {
        const { ir } = compileToIR('nested_fn.code');
        expect(ir).toMatch(/define private.*@main\.add\(/);
    });

    it('deeply nested fn gets a doubly-mangled name @main.inner.innermost', () => {
        const { ir } = compileToIR('nested_fn.code');
        expect(ir).toMatch(/define private.*@main\.inner\.innermost\(\)/);
    });

    it('outer fn calls nested fn by mangled name', () => {
        const { ir } = compileToIR('nested_fn.code');
        expect(ir).toContain('call void @main.greet()');
    });
});

describe('nested functions — forward reference', () => {
    it('calling a nested fn before its declaration is a compile-time error', () => {
        const { exitCode, stderr } = compileExpectError('nested_fn_forward_ref.code');
        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/forward reference/i);
        expect(stderr).toContain('someFunction');
    });
});
