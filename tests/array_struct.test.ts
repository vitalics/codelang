/**
 * Tests for Array<StructType> — PtrArray-backed arrays for user-defined structs.
 *
 * Covers:
 *  1. IR structure — %PtrArray opaque type, ptrarray_* runtime declares
 *  2. Runtime — push, length, get, print for Array<User>
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'array_struct.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Array<StructType> — IR structure', () => {

    it('emits %PtrArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%PtrArray = type opaque');
    });

    it('declares ptrarray_new : %PtrArray* ()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %PtrArray* @ptrarray_new()');
    });

    it('declares ptrarray_push : void (%PtrArray*, i8*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @ptrarray_push(%PtrArray*, i8*)');
    });

    it('declares ptrarray_get : i8* (%PtrArray*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i8* @ptrarray_get(%PtrArray*, i32)');
    });

    it('declares ptrarray_length : i32 (%PtrArray*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @ptrarray_length(%PtrArray*)');
    });

    it('emits %User type definition', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%User = type');
    });

    it('emits auto-generated User_autoToString function', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@User_autoToString');
    });

    it('emits auto-generated User_PtrArray_toString function', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@User_PtrArray_toString');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('Array<StructType> — runtime', () => {

    it('print(users) outputs [{username: "qwe"}]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[0]).toBe('[{username: "qwe"}]');
    });

    it('users.length() returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[1]).toBe('1');
    });

    it('users.get(0).username returns "qwe"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[2]).toBe('qwe');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 3 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l).toHaveLength(3);
    });
});
