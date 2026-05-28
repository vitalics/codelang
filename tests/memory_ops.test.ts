/**
 * Tests for the three memory / address primitives:
 *
 *   addressOf(expr)   → Int64   runtime address of a value
 *   sizeOf!(T)        → int     compile-time byte size of type T
 *   typeId!(T)        → Int64   compile-time stable djb2 hash of the type name
 *
 * Additionally verifies that typeAddress(expr) — which delegates to
 * typeInfo + addressOf — compiles cleanly.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// sizeOf! — IR checks
// ─────────────────────────────────────────────────────────────────────────────

describe('sizeOf! — IR', () => {
    it('produces i32 integer constants (no heap allocation)', () => {
        const { ir } = compileToIR('memory_ops.code');
        // sizeOf! results must be folded to i32 constants — 1, 4, 8
        expect(ir).toMatch(/i32 1/);
        expect(ir).toMatch(/i32 4/);
        expect(ir).toMatch(/i32 8/);
    });

    it('inferred type of sizeOf! is i32, not a pointer', () => {
        const { ir } = compileToIR('memory_ops.code');
        // No alloca for sizeOf results (they are compile-time constants)
        expect(ir).not.toMatch(/alloca.*sz_bool/);
        expect(ir).not.toMatch(/alloca.*sz_int/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// typeId! — IR checks
// ─────────────────────────────────────────────────────────────────────────────

describe('typeId! — IR', () => {
    it('produces i64 integer constants', () => {
        const { ir } = compileToIR('memory_ops.code');
        // typeId! returns i64 → alloca i64 entries in the IR
        expect(ir).toMatch(/alloca i64/);
    });

    it('does not emit any function call for typeId!', () => {
        const { ir } = compileToIR('memory_ops.code');
        // typeId! is purely compile-time — no @typeId call in IR
        expect(ir).not.toMatch(/@typeId/i);
        expect(ir).not.toMatch(/@type_id/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// addressOf — IR checks
// ─────────────────────────────────────────────────────────────────────────────

describe('addressOf — IR', () => {
    it('emits ptrtoint instruction for pointer-typed values', () => {
        const { ir } = compileToIR('memory_ops.code');
        // Point is a %Point* (heap pointer) → ptrtoint %Point* to i64
        expect(ir).toMatch(/ptrtoint %Point\* .+ to i64/);
    });

    it('emits alloca+store+ptrtoint for scalar values', () => {
        const { ir } = compileToIR('memory_ops.code');
        // Scalar int → alloca i32, store, ptrtoint i32* to i64
        expect(ir).toMatch(/ptrtoint i32\* .+ to i64/);
    });

    it('result type is i64 (stored in alloca i64 slots)', () => {
        const { ir } = compileToIR('memory_ops.code');
        expect(ir).toMatch(/alloca i64/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// sizeOf! — runtime values
// ─────────────────────────────────────────────────────────────────────────────

describe('sizeOf! — runtime values', () => {
    it('bool → 1', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[0]).toBe('1');
    });

    it('int → 4', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[1]).toBe('4');
    });

    it('float (= Float64 = double) → 8', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[2]).toBe('8');
    });

    it('string (pointer) → 8', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[3]).toBe('8');
    });

    it('Int64 → 8', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[4]).toBe('8');
    });

    it('Point { x: int, y: int } → 8 (4+4, no trailing pad)', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[5]).toBe('8');
    });

    it('Mixed { flag: bool, value: int } → 8 (1+3pad+4)', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[6]).toBe('8');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// typeId! — runtime values
// ─────────────────────────────────────────────────────────────────────────────

describe('typeId! — runtime values', () => {
    it('same type always yields the same id', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[7]).toBe('true');   // id_int == typeId!(int)
        expect(lines(stdout)[8]).toBe('true');   // id_str == typeId!(string)
        expect(lines(stdout)[9]).toBe('true');   // id_point == typeId!(Point)
    });

    it('different types yield different ids', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[10]).toBe('false');  // id_int == id_str  → false
        expect(lines(stdout)[11]).toBe('false');  // id_int == id_bool → false
        expect(lines(stdout)[12]).toBe('false');  // id_int == id_float → false
        expect(lines(stdout)[13]).toBe('false');  // id_int == id_point → false
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// addressOf — runtime values
// ─────────────────────────────────────────────────────────────────────────────

describe('addressOf — runtime values (scalars)', () => {
    it('address of a scalar is non-zero', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[14]).toBe('true');  // addr_a != 0
        expect(lines(stdout)[15]).toBe('true');  // addr_b != 0
    });

    it('two different scalar variables have different addresses', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[16]).toBe('true');  // addr_a != addr_b
    });
});

describe('addressOf — runtime values (heap structs)', () => {
    it('address of a heap-allocated struct is non-zero', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[17]).toBe('true');  // addr_p != 0
        expect(lines(stdout)[18]).toBe('true');  // addr_q != 0
    });

    it('two different struct instances have different addresses', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[19]).toBe('true');  // addr_p != addr_q
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// sizeOf! for stride arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('sizeOf! stride arithmetic', () => {
    it('addressOf(a) + sizeOf!(int) advances by exactly 4 bytes', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[20]).toBe('true');  // next - base == stride
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time constant usage
// ─────────────────────────────────────────────────────────────────────────────

describe('sizeOf! and typeId! as compile-time constants', () => {
    it('sizeOf!(int) can be stored in a typed const int and equals 4', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[21]).toBe('true');  // elem_size == 4
    });

    it('typeId!(int) is a non-zero stable hash', () => {
        const { stdout } = compileAndRun('memory_ops.code');
        expect(lines(stdout)[22]).toBe('true');  // type_tag != 0
    });
});
