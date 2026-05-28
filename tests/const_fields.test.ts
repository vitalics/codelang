/**
 * Tests for the two orthogonal `const` features on struct fields.
 *
 * ── Feature 1: `const` field modifier ────────────────────────────────────────
 *   type Point { const x: int; const y: int }
 *   • Parsed as FieldDeclaration.readonly = true
 *   • Same LLVM type as the non-const variant
 *   • Reflected as isConst = 1 in typeInfo metadata
 *
 * ── Feature 2: `const T` type qualifier ──────────────────────────────────────
 *   type Foo { x: const int }     → i32  (same LLVM type, constraint is type-system only)
 *   type Bar { x: const Number }  → i64  (prevents %Number* heap allocation / BigInt upscale)
 *   • TypeReference.constQualified = true
 *   • structFieldMap entry gains constType = true
 *   • Only Number changes its LLVM representation; all other types stay the same
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// IR-level checks
// ─────────────────────────────────────────────────────────────────────────────

describe('const field modifier — IR', () => {
    it('const int fields still produce i32 in the struct layout', () => {
        const { ir } = compileToIR('const_field_modifier.code');
        // Both x and y are const int → i32
        expect(ir).toMatch(/%Point\s*=\s*type\s*\{\s*i32\s*,\s*i32\s*\}/);
    });

    it('generates a struct constructor that accepts both const fields', () => {
        const { ir } = compileToIR('const_field_modifier.code');
        // Constructor must accept two i32 parameters (for x and y)
        expect(ir).toMatch(/@Point_new\(i32 %arg\.0, i32 %arg\.1\)/);
    });
});

describe('const type qualifier — IR', () => {
    it('const int still resolves to i32 in the struct layout', () => {
        const { ir } = compileToIR('const_type_qualifier.code');
        expect(ir).toMatch(/%ImmutablePoint\s*=\s*type\s*\{\s*i32\s*,\s*i32\s*\}/);
    });

    it('const Number resolves to i64 instead of %Number*', () => {
        const { ir } = compileToIR('const_type_qualifier.code');
        // FixedCounter.count: const Number → i64
        expect(ir).toMatch(/%FixedCounter\s*=\s*type\s*\{\s*i64\s*\}/);
    });

    it('const Number constructor accepts i64 parameter, not %Number*', () => {
        const { ir } = compileToIR('const_type_qualifier.code');
        expect(ir).toMatch(/@FixedCounter_new\(i64 %arg\.0\)/);
    });

    it('const Number field is stored with store i64 instruction', () => {
        const { ir } = compileToIR('const_type_qualifier.code');
        expect(ir).toMatch(/store i64 100/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('const field modifier — runtime', () => {
    it('prints both readonly fields correctly', () => {
        const { stdout } = compileAndRun('const_field_modifier.code');
        const out = lines(stdout);
        expect(out[0]).toBe('7');
        expect(out[1]).toBe('13');
    });
});

describe('const type qualifier — runtime', () => {
    it('prints const int fields correctly', () => {
        const { stdout } = compileAndRun('const_type_qualifier.code');
        const out = lines(stdout);
        expect(out[0]).toBe('5');
        expect(out[1]).toBe('9');
    });

    it('prints const Number field correctly', () => {
        const { stdout } = compileAndRun('const_type_qualifier.code');
        const out = lines(stdout);
        expect(out[2]).toBe('100');
    });
});
