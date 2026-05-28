/**
 * IR generation tests
 *
 * Compiles fixture programs to LLVM IR (--ir, skips clang) and checks that
 * the emitted text matches expected structural patterns.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR } from './helpers/cli.js';

// ── Module structure ──────────────────────────────────────────────────────────

describe('IR — module structure', () => {
    it('emits a module header with the source filename', () => {
        const { ir, exitCode } = compileToIR('hello.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/^; ModuleID = 'hello\.code'/m);
        expect(ir).toMatch(/^source_filename = "hello\.code"/m);
    });

    it('declares printf', () => {
        const { ir } = compileToIR('hello.code');
        expect(ir).toContain('declare i32 @printf(i8*, ...)');
    });
});

// ── print() → printf call ─────────────────────────────────────────────────────

describe('IR — print() statement', () => {
    it('emits a call to @printf for print()', () => {
        const { ir } = compileToIR('hello.code');
        expect(ir).toMatch(/call i32 \(i8\*, \.\.\.\) @printf/);
    });

    it('stores string literals as global byte arrays', () => {
        const { ir } = compileToIR('hello.code');
        // e.g. @.str.0 = private unnamed_addr constant [18 x i8] c"Hello, CodeLang!..."
        expect(ir).toMatch(/@\.str\.\d+ = private unnamed_addr constant \[\d+ x i8\]/);
    });

    it('uses getelementptr to pass a string to printf', () => {
        const { ir } = compileToIR('hello.code');
        expect(ir).toContain('getelementptr inbounds');
    });

    it('emits one @printf call per print() statement', () => {
        const { ir } = compileToIR('multi_print.code');
        const calls = (ir.match(/call i32 .* @printf/g) ?? []).length;
        expect(calls).toBe(2);
    });
});

// ── Function shapes ───────────────────────────────────────────────────────────

describe('IR — function definitions', () => {
    it('emits define i32 @main for the entry point', () => {
        const { ir } = compileToIR('hello.code');
        expect(ir).toMatch(/define i32 @main\(\)/);
    });

    it('main always returns i32 0 (implicit)', () => {
        const { ir } = compileToIR('hello.code');
        expect(ir).toContain('ret i32 0');
    });

    it('marks a const fn with the readnone attribute group', () => {
        const { ir } = compileToIR('const_fn_pure.code');
        // The function definition must reference #0
        expect(ir).toMatch(/define .* @label\(.*\) #0/);
        // And the attribute group must list readnone
        expect(ir).toMatch(/attributes #0 = \{.*readnone.*\}/);
    });

    it('does NOT attach #0 to a plain fn', () => {
        const { ir } = compileToIR('hello.code');
        // No attribute group should be emitted when there are no const fns
        expect(ir).not.toContain('attributes #0');
    });
});

// ── Variable declarations ─────────────────────────────────────────────────────

describe('IR — variable declarations', () => {
    it('allocates a let variable via alloca', () => {
        const { ir } = compileToIR('let_reassign.code');
        expect(ir).toMatch(/%msg = alloca i8\*/);
    });

    it('stores the initial value with a store instruction', () => {
        const { ir } = compileToIR('let_reassign.code');
        expect(ir).toMatch(/store i8\* .*, i8\*\* %msg/);
    });

    it('emits a second store on reassignment', () => {
        const { ir } = compileToIR('let_reassign.code');
        // Two stores to %msg: initial + reassignment
        const stores = (ir.match(/store i8\* .*, i8\*\* %msg/g) ?? []).length;
        expect(stores).toBe(2);
    });

    it('loads a variable reference before passing to printf', () => {
        const { ir } = compileToIR('let_reassign.code');
        expect(ir).toMatch(/load i8\*, i8\*\* %msg/);
    });

    it('allocates a const variable the same way as let', () => {
        // const immutability is a language-level rule, not an IR-level one
        const { ir } = compileToIR('const_var.code');
        expect(ir).toMatch(/%greeting = alloca i8\*/);
    });

    it('allocates typed int/bool variables with correct LLVM types', () => {
        const { ir } = compileToIR('typed_vars.code');
        expect(ir).toMatch(/%count = alloca i32/);
        expect(ir).toMatch(/%active = alloca i1/);
    });
});

// ── Parameters ────────────────────────────────────────────────────────────────

describe('IR — function parameters', () => {
    it('passes incoming args as %arg.N and allocates them via alloca', () => {
        const { ir } = compileToIR('params.code');
        // Parameter 0 should be named %arg.0 in the signature
        expect(ir).toMatch(/define .* @greet\(i8\* %arg\.0\)/);
        // And then allocated on the stack
        expect(ir).toMatch(/%msg = alloca i8\*/);
        expect(ir).toMatch(/store i8\* %arg\.0, i8\*\* %msg/);
    });
});
