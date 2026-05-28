/**
 * NPU inference tests — 2-layer MLP forward pass.
 *
 * Architecture: 1×3 input → W1(3×4)+ReLU → W2(4×2)+softmax → 1×2 probs.
 *
 * Covers: softmax activation, chained method calls (.multiply().relu()),
 *         batch GEMM (4×3 input matrix), and end-to-end inference decisions.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

let lines:    string[]    = [];
let exitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun('npu_inference.code');
    exitCode = r.exitCode;
    lines    = r.stdout.trim().split('\n');
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('npu_inference — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(exitCode).toBe(0);
    });
    it('produces 20 lines of output', () => {
        expect(lines).toHaveLength(20);
    });
});

// ── Layer-1 forward values ────────────────────────────────────────────────────

describe('Layer 1 — hidden values h1 (before ReLU)', () => {
    it('h1[0,0] ≈ 0.30  (0.1×0.4 + 0.9×0.3 + 0.1×(−0.1))', () => {
        expect(parseFloat(lines[0])).toBeCloseTo(0.30, 4);
    });
    it('h1[0,1] ≈ 0.46  (0.1×(−0.2) + 0.9×0.5 + 0.1×0.3)', () => {
        expect(parseFloat(lines[1])).toBeCloseTo(0.46, 4);
    });
    it('h1[0,2] ≈ −0.23 (0.1×0.8 + 0.9×(−0.4) + 0.1×0.5)', () => {
        expect(parseFloat(lines[2])).toBeCloseTo(-0.23, 4);
    });
    it('h1[0,3] ≈ 0.62  (0.1×0.1 + 0.9×0.7 + 0.1×(−0.2))', () => {
        expect(parseFloat(lines[3])).toBeCloseTo(0.62, 4);
    });
});

// ── ReLU ─────────────────────────────────────────────────────────────────────

describe('Layer 1 — after ReLU', () => {
    it('relu(h1[0,0]) ≈ 0.30 (positive, unchanged)', () => {
        expect(parseFloat(lines[4])).toBeCloseTo(0.30, 4);
    });
    it('relu(h1[0,1]) ≈ 0.46 (positive, unchanged)', () => {
        expect(parseFloat(lines[5])).toBeCloseTo(0.46, 4);
    });
    it('relu(h1[0,2]) === 0  (negative clamped to 0)', () => {
        expect(parseFloat(lines[6])).toBe(0);
    });
    it('relu(h1[0,3]) ≈ 0.62 (positive, unchanged)', () => {
        expect(parseFloat(lines[7])).toBeCloseTo(0.62, 4);
    });
});

// ── Layer-2 logits ────────────────────────────────────────────────────────────

describe('Layer 2 — logits before softmax', () => {
    it('logit[0] ≈ 0.676', () => {
        expect(parseFloat(lines[8])).toBeCloseTo(0.676, 3);
    });
    it('logit[1] ≈ 0.030', () => {
        expect(parseFloat(lines[9])).toBeCloseTo(0.030, 3);
    });
});

// ── Softmax probabilities (sample 1) ─────────────────────────────────────────

describe('Softmax — sample 1 probabilities', () => {
    it('P(healthy)     ≈ 0.656 (dominant class)', () => {
        expect(parseFloat(lines[10])).toBeCloseTo(0.656, 2);
    });
    it('P(maintenance) ≈ 0.344', () => {
        expect(parseFloat(lines[11])).toBeCloseTo(0.344, 2);
    });
    it('probabilities sum to 1', () => {
        expect(parseFloat(lines[10]) + parseFloat(lines[11])).toBeCloseTo(1.0, 5);
    });
});

// ── Classification decision (sample 1) ───────────────────────────────────────

describe('Decision — sample 1 ([0.1, 0.9, 0.1])', () => {
    it('predicts "healthy"', () => {
        expect(lines[12]).toBe('healthy');
    });
});

// ── Softmax probabilities (sample 2) ─────────────────────────────────────────

describe('Softmax — sample 2 probabilities', () => {
    it('P(healthy)     ≈ 0.408', () => {
        expect(parseFloat(lines[13])).toBeCloseTo(0.408, 2);
    });
    it('P(maintenance) ≈ 0.592 (dominant class)', () => {
        expect(parseFloat(lines[14])).toBeCloseTo(0.592, 2);
    });
    it('probabilities sum to 1', () => {
        expect(parseFloat(lines[13]) + parseFloat(lines[14])).toBeCloseTo(1.0, 5);
    });
});

// ── Classification decision (sample 2) ───────────────────────────────────────

describe('Decision — sample 2 ([0.5, 0.3, 0.8])', () => {
    it('predicts "maintenance"', () => {
        expect(lines[15]).toBe('maintenance');
    });
});

// ── Batch inference ───────────────────────────────────────────────────────────

describe('Batch inference — 4×3 input, 4×2 output', () => {
    it('batch row 0 (low vibration) → P(healthy) > 0.5', () => {
        expect(parseFloat(lines[16])).toBeGreaterThan(0.5);
    });
    it('batch row 0 probabilities sum to 1', () => {
        expect(parseFloat(lines[16]) + parseFloat(lines[17])).toBeCloseTo(1.0, 5);
    });
    it('batch row 1 (high vibration+current) → P(maintenance) > 0.5', () => {
        expect(parseFloat(lines[19])).toBeGreaterThan(0.5);
    });
    it('batch row 1 probabilities sum to 1', () => {
        expect(parseFloat(lines[18]) + parseFloat(lines[19])).toBeCloseTo(1.0, 5);
    });
});
