/**
 * Advanced SIMD tests — geometry, lighting, color, batch ops
 *
 * Covers Float2 / Float4 / Float8 / Float16 methods not exercised by
 * simd.test.ts (simd_basic.code):
 *
 *   simd_geometry  — Float2: perp, reflect, distance, lerp, cross, clamp, rotate
 *   simd_lighting  — Float4: dot3, normalize3, reflect3, cross3, distance3
 *   simd_color     — Float4: lerp, clamp, element-wise multiply, abs
 *   simd_batch     — Float8 / Float16: dot, lerp, min, max, abs, sum, get
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── per-fixture result slots ─────────────────────────────────────────────────

let geoLines:    string[]    = [];
let geoExit:     number|null = null;

let litLines:    string[]    = [];
let litExit:     number|null = null;

let colLines:    string[]    = [];
let colExit:     number|null = null;

let batLines:    string[]    = [];
let batExit:     number|null = null;

// ── compile all four fixtures up-front ───────────────────────────────────────

beforeAll(() => {
    const geo  = compileAndRun('simd_geometry.code');
    geoExit    = geo.exitCode;
    geoLines   = geo.stdout.trim().split('\n');
}, 300_000);

beforeAll(() => {
    const lit  = compileAndRun('simd_lighting.code');
    litExit    = lit.exitCode;
    litLines   = lit.stdout.trim().split('\n');
}, 300_000);

beforeAll(() => {
    const col  = compileAndRun('simd_color.code');
    colExit    = col.exitCode;
    colLines   = col.stdout.trim().split('\n');
}, 300_000);

beforeAll(() => {
    const bat  = compileAndRun('simd_batch.code');
    batExit    = bat.exitCode;
    batLines   = bat.stdout.trim().split('\n');
}, 300_000);

// ══════════════════════════════════════════════════════════════════════════════
// simd_geometry — Float2 geometry methods
// ══════════════════════════════════════════════════════════════════════════════

describe('simd_geometry — compilation', () => {
    it('exits with code 0', () => expect(geoExit).toBe(0));
});

describe('Float2 — perp (rotate 90° CCW)', () => {
    // perp(3, 4) = (-4, 3)
    it('pp.x() === -4', () => expect(geoLines[0]).toBe('-4'));
    it('pp.y() ===  3', () => expect(geoLines[1]).toBe('3'));
});

describe('Float2 — reflect off floor normal', () => {
    // reflect((1,-1), unitY) = (1, 1)
    it('ref.x() === 1', () => expect(geoLines[2]).toBe('1'));
    it('ref.y() === 1', () => expect(geoLines[3]).toBe('1'));
});

describe('Float2 — distance', () => {
    // distance((0,0), (3,4)) = 5
    it('distance === 5', () => expect(geoLines[4]).toBe('5'));
});

describe('Float2 — lerp midpoint', () => {
    // lerp((0,0), (10,20), 0.5) = Float2(5, 10)
    it('mid === Float2(5, 10)', () => expect(geoLines[5]).toBe('Float2(5, 10)'));
});

describe('Float2 — 2D cross product', () => {
    // unitX × unitY = 1
    it('cross(unitX, unitY) === 1', () => expect(geoLines[6]).toBe('1'));
});

describe('Float2 — clamp to unit square', () => {
    // clamp((-1,2), (0,0), (1,1)) = Float2(0, 1)
    it('clamp === Float2(0, 1)', () => expect(geoLines[7]).toBe('Float2(0, 1)'));
});

describe('Float2 — rotate (1.5 rad CCW)', () => {
    // rotate(unitX, 1.5).y ≈ sin(1.5) ≈ 0.9975
    it('rotated.y() ≈ sin(1.5)', () =>
        expect(parseFloat(geoLines[8])).toBeCloseTo(Math.sin(1.5), 4));
});

// ══════════════════════════════════════════════════════════════════════════════
// simd_lighting — Float4 lighting methods
// ══════════════════════════════════════════════════════════════════════════════

describe('simd_lighting — compilation', () => {
    it('exits with code 0', () => expect(litExit).toBe(0));
});

describe('Float4 — dot3 (Lambertian diffuse)', () => {
    // normal=unitY · lightUp=unitY  = 1  (full illumination)
    it('unitY.dot3(unitY) === 1', () => expect(litLines[0]).toBe('1'));
    // normal=unitY · lightSide=unitX = 0  (grazing angle)
    it('unitY.dot3(unitX) === 0', () => expect(litLines[1]).toBe('0'));
});

describe('Float4 — reflect3 (specular bounce)', () => {
    // incident (1,-1,0).normalize3() reflected off unitY  →  y ≈ 1/√2 ≈ 0.707
    it('reflected.y() ≈ 0.707', () =>
        expect(parseFloat(litLines[2])).toBeCloseTo(Math.SQRT2 / 2, 4));
});

describe('Float4 — normalize3', () => {
    // (0,3,4,0).normalize3()  →  (0, 0.6, 0.8, 0)
    it('unit3.y() ≈ 0.6', () =>
        expect(parseFloat(litLines[3])).toBeCloseTo(0.6, 4));
    it('unit3.z() ≈ 0.8', () =>
        expect(parseFloat(litLines[4])).toBeCloseTo(0.8, 4));
});

describe('Float4 — cross3 (right-hand rule)', () => {
    // unitY × unitZ = unitX = Float4(1, 0, 0, 0)
    it('unitY.cross3(unitZ) === Float4(1, 0, 0, 0)', () =>
        expect(litLines[5]).toBe('Float4(1, 0, 0, 0)'));
});

describe('Float4 — distance3', () => {
    // distance3((0,0,0), (1,2,2)) = sqrt(1+4+4) = 3
    it('distance3 === 3', () => expect(litLines[6]).toBe('3'));
});

// ══════════════════════════════════════════════════════════════════════════════
// simd_color — Float4 RGBA operations
// ══════════════════════════════════════════════════════════════════════════════

describe('simd_color — compilation', () => {
    it('exits with code 0', () => expect(colExit).toBe(0));
});

describe('Float4 — lerp (alpha blend)', () => {
    // lerp(red, blue, 0.5) = Float4(0.5, 0, 0.5, 1)
    it('blend === Float4(0.5, 0, 0.5, 1)', () =>
        expect(colLines[0]).toBe('Float4(0.5, 0, 0.5, 1)'));
});

describe('Float4 — clamp (tone mapping)', () => {
    // over-bright R=1.5 → 1
    it('ldr.x() === 1',  () => expect(colLines[1]).toBe('1'));
    // negative B=-0.2 → 0
    it('ldr.z() === 0',  () => expect(colLines[2]).toBe('0'));
});

describe('Float4 — multiply then clamp (exposure)', () => {
    // 0.6 * 2.0 = 1.2 → clamped to 1
    it('toned.z() === 1', () => expect(colLines[3]).toBe('1'));
});

describe('Float4 — abs (difference matte)', () => {
    // |0.25 - 0.75| = 0.5 (exact float32)
    it('matte.x() === 0.5', () => expect(colLines[4]).toBe('0.5'));
    // |0.75 - 0.25| = 0.5 (exact float32)
    it('matte.y() === 0.5', () => expect(colLines[5]).toBe('0.5'));
});

// ══════════════════════════════════════════════════════════════════════════════
// simd_batch — Float8 / Float16 wide-vector operations
// ══════════════════════════════════════════════════════════════════════════════

describe('simd_batch — compilation', () => {
    it('exits with code 0', () => expect(batExit).toBe(0));
});

describe('Float8 — dot product', () => {
    // [1..8] · [1..1] = 36
    it('w8.dot(ones8) === 36', () => expect(batLines[0]).toBe('36'));
});

describe('Float8 — lerp to midpoint', () => {
    // lerp(zero, one, 0.5).sum() = 4
    it('mid8.sum() === 4', () => expect(batLines[1]).toBe('4'));
});

describe('Float8 — min / max', () => {
    // min(splat(3), splat(5)).sum() = 24
    it('lo8.min(hi8).sum() === 24', () => expect(batLines[2]).toBe('24'));
    // max(splat(3), splat(5)).sum() = 40
    it('lo8.max(hi8).sum() === 40', () => expect(batLines[3]).toBe('40'));
});

describe('Float8 — abs', () => {
    // abs([-1..-8]).sum() = 36
    it('neg8.abs().sum() === 36', () => expect(batLines[4]).toBe('36'));
});

describe('Float16 — sum of ones', () => {
    // Float16.one().sum() = 16
    it('ones16.sum() === 16', () => expect(batLines[5]).toBe('16'));
});

describe('Float16 — dot with ones', () => {
    // [1..16] · [1..1] = 136
    it('w16.dot(ones16) === 136', () => expect(batLines[6]).toBe('136'));
});

describe('Float16 — lerp single lane', () => {
    // lerp(0, 10, 0.5).get(0) = 5
    it('mid16.get(0) === 5', () => expect(batLines[7]).toBe('5'));
});
