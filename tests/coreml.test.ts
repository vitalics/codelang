/**
 * CoreML + INT8/INT4 quantization tests
 *
 * Exercises stdlib/npu/apple_coreml.code on macOS:
 *   - INT8 symmetric per-tensor quantization via QuantizedMatrix.quantizeINT8(Matrix, …)
 *   - INT4 symmetric per-tensor quantization via QuantizedMatrix.quantizeINT4(Matrix, …)
 *   - Correct rows/cols dimensions
 *   - Element-level access (getINT8, getINT4)
 *   - Clipping at INT4 max value (7)
 *   - toString() output for both bit-widths
 *
 * Fixture: tests/fixtures/valid/coreml_quant.code
 *
 * Only runs on macOS (darwin) — the module is guarded by switch_import! and
 * emits a compileError! on other platforms.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── Fixture output ────────────────────────────────────────────────────────────

let lines:    string[]    = [];
let exitCode: number|null = null;

// Expected output lines (0-based index):
// 0  → q8.rows()           = "2"
// 1  → q8.cols()           = "3"
// 2  → q8.getINT8(0,0)     = "1"
// 3  → q8.getINT8(1,2)     = "1"
// 4  → print(q8)           = QuantizedMatrix(INT8, 2x3, scale=0.5, zp=0)[1, 1, 1, 1, 1, 1]
// 5  → q8n.getINT8(0,0)    = "-1"
// 6  → q8n.getINT8(0,3)    = "-1"
// 7  → q8s.rows()          = "3"
// 8  → q8s.cols()          = "2"
// 9  → q8s.getINT8(0,0)    = "2"     (scale=0.25 → round(0.5/0.25)=2)
// 10 → q4.getINT4(0,0)     = "1"
// 11 → q4.getINT4(1,2)     = "1"
// 12 → print(q4)           = QuantizedMatrix(INT4, 2x3, scale=0.5, zp=0)[1, 1, 1, 1, 1, 1]
// 13 → q4c.getINT4(0,0)    = "7"     (4.0/0.5 = 8 → clipped to 7)

beforeAll(() => {
    const result = compileAndRun('coreml_quant.code');
    exitCode     = result.exitCode;
    lines        = result.stdout.trim().split('\n');
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('coreml_quant — compilation', () => {
    it('compiles and exits 0', () => expect(exitCode).toBe(0));
    it('produces 14 output lines', () => expect(lines).toHaveLength(14));
});

// ── INT8: 2×3 matrix, all 0.5, scale=0.5 → all 1 ────────────────────────────

describe('INT8 basic — 2×3 matrix of 0.5, scale=0.5', () => {
    it('rows() === 2',         () => expect(lines[0]).toBe('2'));
    it('cols() === 3',         () => expect(lines[1]).toBe('3'));
    it('getINT8(0,0) === 1',   () => expect(lines[2]).toBe('1'));
    it('getINT8(1,2) === 1',   () => expect(lines[3]).toBe('1'));
    it('toString() is correct', () =>
        expect(lines[4]).toBe('QuantizedMatrix(INT8, 2x3, scale=0.5, zp=0)[1, 1, 1, 1, 1, 1]'));
});

// ── INT8: negative values, scale=0.5 → all -1 ────────────────────────────────

describe('INT8 negative — 1×4 matrix of -0.5, scale=0.5', () => {
    it('getINT8(0,0) === -1',  () => expect(lines[5]).toBe('-1'));
    it('getINT8(0,3) === -1',  () => expect(lines[6]).toBe('-1'));
});

// ── INT8: smaller scale=0.25 → q = 2 ─────────────────────────────────────────

describe('INT8 fine scale — 3×2 matrix of 0.5, scale=0.25', () => {
    it('rows() === 3',         () => expect(lines[7]).toBe('3'));
    it('cols() === 2',         () => expect(lines[8]).toBe('2'));
    it('getINT8(0,0) === 2',   () => expect(lines[9]).toBe('2'));
});

// ── INT4: 2×3 matrix, all 0.5, scale=0.5 → all 1 ────────────────────────────

describe('INT4 basic — 2×3 matrix of 0.5, scale=0.5', () => {
    it('getINT4(0,0) === 1',   () => expect(lines[10]).toBe('1'));
    it('getINT4(1,2) === 1',   () => expect(lines[11]).toBe('1'));
    it('toString() is correct', () =>
        expect(lines[12]).toBe('QuantizedMatrix(INT4, 2x3, scale=0.5, zp=0)[1, 1, 1, 1, 1, 1]'));
});

// ── INT4: clipping — value 8 clipped to 7 ────────────────────────────────────

describe('INT4 clipping — value 8 clipped to 7', () => {
    it('getINT4(0,0) === 7 (clipped from 8)', () => expect(lines[13]).toBe('7'));
});
