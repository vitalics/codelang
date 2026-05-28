/**
 * NPU / Matrix tests — hardware-accelerated matrix operations.
 *
 * On Apple Silicon the Accelerate framework routes work to the AMX coprocessor
 * (matrix multiply) and vDSP unit (element-wise operations).  On Linux the
 * same code path uses a scalar C fallback so the tests are platform-agnostic.
 *
 * Covers: construction, element access, matrix multiply (cblas_sgemm),
 *         identity matrix, ReLU activation (vDSP_vthres), element-wise add,
 *         scale, toString / Displayable, and IR shape.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

let lines:    string[]    = [];
let ir:       string      = '';
let exitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun('npu_basic.code');
    exitCode = r.exitCode;
    lines    = r.stdout.trim().split('\n');
    ir       = r.ir;
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('npu_basic — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(exitCode).toBe(0);
    });
    it('produces 20 lines of output', () => {
        expect(lines).toHaveLength(20);
    });
});

// ── Matrix multiply (cblas_sgemm / AMX) ──────────────────────────────────────

describe('Matrix.multiply — hardware-accelerated GEMM', () => {
    it('C[0,0] = 58  (1×7 + 2×9 + 3×11)', () => expect(lines[0]).toBe('58'));
    it('C[0,1] = 64  (1×8 + 2×10 + 3×12)', () => expect(lines[1]).toBe('64'));
    it('C[1,0] = 139 (4×7 + 5×9 + 6×11)', () => expect(lines[2]).toBe('139'));
    it('C[1,1] = 154 (4×8 + 5×10 + 6×12)', () => expect(lines[3]).toBe('154'));
});

// ── Displayable / toString ────────────────────────────────────────────────────

describe('Matrix — toString (Displayable)', () => {
    it('print(c) → "Matrix(2x2)[[58, 64], [139, 154]]"', () => {
        expect(lines[4]).toBe('Matrix(2x2)[[58, 64], [139, 154]]');
    });
});

// ── Dimensions ───────────────────────────────────────────────────────────────

describe('Matrix — rows / cols', () => {
    it('c.rows() === 2', () => expect(lines[5]).toBe('2'));
    it('c.cols() === 2', () => expect(lines[6]).toBe('2'));
});

// ── Identity matrix ───────────────────────────────────────────────────────────

describe('Matrix.identity', () => {
    it('id[0,0] === 1', () => expect(lines[7]).toBe('1'));
    it('id[0,1] === 0', () => expect(lines[8]).toBe('0'));
    it('id[1,1] === 1', () => expect(lines[9]).toBe('1'));
    it('id[2,2] === 1', () => expect(lines[10]).toBe('1'));
});

// ── ReLU activation (vDSP_vthres / element-wise) ─────────────────────────────

describe('Matrix.relu — activation function', () => {
    it('relu(-1) === 0', () => expect(lines[11]).toBe('0'));
    it('relu( 2) === 2', () => expect(lines[12]).toBe('2'));
    it('relu(-3) === 0', () => expect(lines[13]).toBe('0'));
    it('relu( 4) === 4', () => expect(lines[14]).toBe('4'));
});

// ── Element-wise add ─────────────────────────────────────────────────────────

describe('Matrix.add — element-wise addition', () => {
    it('ones(2,2) + ones(2,2): [0,0] === 2', () => expect(lines[15]).toBe('2'));
    it('ones(2,2) + ones(2,2): [1,1] === 2', () => expect(lines[16]).toBe('2'));
});

// ── Scale ─────────────────────────────────────────────────────────────────────

describe('Matrix.scale — in-place scalar multiply', () => {
    it('ones(1,3).scale(5)[0] === 5', () => expect(lines[17]).toBe('5'));
    it('ones(1,3).scale(5)[1] === 5', () => expect(lines[18]).toBe('5'));
    it('ones(1,3).scale(5)[2] === 5', () => expect(lines[19]).toBe('5'));
});

// ── IR shape ─────────────────────────────────────────────────────────────────

describe('LLVM IR — Matrix opaque type', () => {
    it('emits %Matrix = type opaque', () => {
        expect(ir).toContain('%Matrix = type opaque');
    });
    it('declares matrix_new with %Matrix* return', () => {
        expect(ir).toContain('declare %Matrix* @matrix_new(i32, i32)');
    });
    it('declares matrix_multiply with %Matrix* args and return', () => {
        expect(ir).toContain('declare %Matrix* @matrix_multiply(%Matrix*, %Matrix*)');
    });
    it('declares matrix_to_string returning i8*', () => {
        expect(ir).toContain('declare i8* @matrix_to_string(%Matrix*)');
    });
});
