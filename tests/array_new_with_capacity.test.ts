/**
 * Tests for IntArray.newWithCapacity() and StringArray.newWithCapacity().
 *
 * Verifies:
 *   - The factory returns an empty array (length == 0)
 *   - push() works normally and grows past the reserved capacity
 *   - Existing get/set/length/free methods work on the resulting array
 *   - IR declares @intarray_new_with_capacity and @stringarray_new_with_capacity
 *   - %IntArray = type opaque and %StringArray = type opaque are emitted
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'array_new_with_capacity.code';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lines(): string[] {
    return compileAndRun(FIXTURE).stdout.trim().split('\n');
}

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('newWithCapacity — IntArray runtime', () => {
    it('length is 0 immediately after creation', () =>
        expect(lines()[0]).toBe('0'));

    it('push 3 elements → length == 3', () =>
        expect(lines()[1]).toBe('3'));

    it('get(0) returns first pushed value', () =>
        expect(lines()[2]).toBe('10'));

    it('get(2) returns third pushed value', () =>
        expect(lines()[3]).toBe('30'));

    it('can push past original reserved capacity — length still correct', () =>
        expect(lines()[4]).toBe('3'));

    it('get(2) correct after overflow growth', () =>
        expect(lines()[5]).toBe('3'));

    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});

describe('newWithCapacity — StringArray runtime', () => {
    it('StringArray.newWithCapacity length is 0', () =>
        expect(lines()[6]).toBe('0'));

    it('push 2 strings → length == 2', () =>
        expect(lines()[7]).toBe('2'));

    it('get(0) returns first pushed string', () =>
        expect(lines()[8]).toBe('hello'));
});

describe('newWithCapacity — full output', () => {
    it('produces exactly 9 lines', () =>
        expect(lines()).toHaveLength(9));

    it('full output matches expected', () =>
        expect(compileAndRun(FIXTURE).stdout).toBe(
            '0\n3\n10\n30\n3\n3\n0\n2\nhello\n'
        ));
});

// ── IR structure ──────────────────────────────────────────────────────────────

describe('newWithCapacity — IR', () => {
    it('declares @intarray_new_with_capacity(i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare %IntArray\* @intarray_new_with_capacity\(i32\)/);
    });

    it('declares @stringarray_new_with_capacity(i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare %StringArray\* @stringarray_new_with_capacity\(i32\)/);
    });

    it('emits %IntArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%IntArray = type opaque');
    });

    it('emits %StringArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%StringArray = type opaque');
    });

    it('calls @intarray_new_with_capacity in IR body', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call %IntArray\* @intarray_new_with_capacity\(i32/);
    });

    it('calls @stringarray_new_with_capacity in IR body', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call %StringArray\* @stringarray_new_with_capacity\(i32/);
    });
});
