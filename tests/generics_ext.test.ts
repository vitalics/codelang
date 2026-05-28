/**
 * Tests for Phase 3: Generic extension method monomorphization.
 *
 * A generic `Container<T>` type backed by an opaque C struct is extended with
 * instance methods that reference the type parameter T.  The IR generator must
 * emit one concrete specialization per (type, method) combination encountered
 * in user code.
 *
 * Covers:
 *  1. Opaque type declarations (one per instantiation)
 *  2. Extern declarations for C bindings
 *  3. Specialization: zero-arg method → Container_i32_id / Container_str_id
 *  4. Specialization: T-param method  → Container_i32_replaceWith / Container_str_replaceWith
 *  5. Call sites in main use the mangled names with correct LLVM types
 *  6. No duplicate specializations (idempotent)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR } from './helpers/cli.js';

const FIXTURE = 'generics_ext.code';

// =============================================================================
// 1. Opaque type declarations
// =============================================================================

describe('Generic extension — opaque type declarations', () => {

    it('emits %Container_i32 = type opaque for Container<int>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%Container_i32 = type opaque');
    });

    it('emits %Container_str = type opaque for Container<string>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%Container_str = type opaque');
    });

    it('does NOT emit a bare %Container = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        // The unmangled base type should not appear as a standalone opaque decl
        expect(ir).not.toMatch(/^%Container = type opaque/m);
    });
});

// =============================================================================
// 2. Extern declarations (C runtime bindings)
// =============================================================================

describe('Generic extension — extern declarations', () => {

    it('declares container_new_i32 : %Container_i32* (i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %Container_i32* @container_new_i32(i32)');
    });

    it('declares container_get_i32 : i32 (%Container_i32*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @container_get_i32(%Container_i32*)');
    });

    it('declares container_new_str : %Container_str* (i8*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %Container_str* @container_new_str(i8*)');
    });

    it('declares container_get_str : i8* (%Container_str*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i8* @container_get_str(%Container_str*)');
    });
});

// =============================================================================
// 3 + 4. Specialization emission
// =============================================================================

describe('Generic extension — specialization definitions', () => {

    it('emits @Container_i32_id with correct signature', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define private %Container_i32\* @Container_i32_id\(%Container_i32\* %self\.0\)/);
    });

    it('@Container_i32_id loads self and returns it', () => {
        const { ir } = compileToIR(FIXTURE);
        // The body should load %self and ret it
        expect(ir).toMatch(/load %Container_i32\*, %Container_i32\*\* %self/);
        expect(ir).toMatch(/ret %Container_i32\* %/);
    });

    it('emits @Container_str_id with correct signature', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define private %Container_str\* @Container_str_id\(%Container_str\* %self\.0\)/);
    });

    it('@Container_str_id loads self and returns it', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/load %Container_str\*, %Container_str\*\* %self/);
        expect(ir).toMatch(/ret %Container_str\* %/);
    });

    it('emits @Container_i32_replaceWith with correct signature (T=i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(
            /define private i32 @Container_i32_replaceWith\(%Container_i32\* %self\.0, i32 %arg\.0\)/,
        );
    });

    it('@Container_i32_replaceWith returns the i32 parameter', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/ret i32 %/);
    });

    it('emits @Container_str_replaceWith with correct signature (T=i8*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(
            /define private i8\* @Container_str_replaceWith\(%Container_str\* %self\.0, i8\* %arg\.0\)/,
        );
    });

    it('@Container_str_replaceWith returns the i8* parameter', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/ret i8\* %/);
    });
});

// =============================================================================
// 5. Call sites in main
// =============================================================================

describe('Generic extension — call sites in @main', () => {

    it('main calls @Container_i32_id with %Container_i32* receiver', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call %Container_i32\* @Container_i32_id\(%Container_i32\* %/);
    });

    it('main calls @Container_i32_replaceWith with (%Container_i32*, i32) args', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i32 @Container_i32_replaceWith\(%Container_i32\* %\d+, i32 99\)/);
    });

    it('main calls @Container_str_id with %Container_str* receiver', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call %Container_str\* @Container_str_id\(%Container_str\* %/);
    });

    it('main calls @Container_str_replaceWith with (%Container_str*, i8*) args', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i8\* @Container_str_replaceWith\(%Container_str\* %\d+, i8\* /);
    });
});

// =============================================================================
// 6. Idempotency — each specialization emitted exactly once
// =============================================================================

describe('Generic extension — no duplicate specializations', () => {

    it('Container_i32_id is defined exactly once', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/define .* @Container_i32_id\b/g) ?? [];
        expect(matches).toHaveLength(1);
    });

    it('Container_str_id is defined exactly once', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/define .* @Container_str_id\b/g) ?? [];
        expect(matches).toHaveLength(1);
    });

    it('Container_i32_replaceWith is defined exactly once', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/define .* @Container_i32_replaceWith\b/g) ?? [];
        expect(matches).toHaveLength(1);
    });

    it('Container_str_replaceWith is defined exactly once', () => {
        const { ir } = compileToIR(FIXTURE);
        const matches = ir.match(/define .* @Container_str_replaceWith\b/g) ?? [];
        expect(matches).toHaveLength(1);
    });
});
