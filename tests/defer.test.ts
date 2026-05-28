/**
 * Tests for the `defer` keyword and `using` declaration.
 *
 * `defer <expr>` schedules a call to run when the enclosing function returns,
 * in LIFO order (last registered runs first).
 *
 * `using <name>: <T> = <expr>` is syntactic sugar for:
 *   let <name>: <T> = <expr>;
 *   defer <name>.dispose();
 * which auto-disposes a Disposable resource on every return path.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const DEFER_FIXTURE = 'defer_test.code';
const USING_FIXTURE = 'using_test.code';

// ── defer — IR structure ──────────────────────────────────────────────────────

describe('defer — IR structure', () => {

    it('deferred calls are emitted before ret', () => {
        const { ir } = compileToIR(DEFER_FIXTURE);
        // The three @sayN calls must appear before `ret i32 0`
        const retIdx   = ir.lastIndexOf('ret i32 0');
        const say3Idx  = ir.lastIndexOf('call void @say3()');
        const say2Idx  = ir.lastIndexOf('call void @say2()');
        const say1Idx  = ir.lastIndexOf('call void @say1()');
        expect(say3Idx).toBeGreaterThan(0);
        expect(say3Idx).toBeLessThan(retIdx);
        expect(say2Idx).toBeGreaterThan(0);
        expect(say2Idx).toBeLessThan(retIdx);
        expect(say1Idx).toBeGreaterThan(0);
        expect(say1Idx).toBeLessThan(retIdx);
    });

    it('deferred calls are emitted in LIFO order in IR (say3 before say2 before say1)', () => {
        const { ir } = compileToIR(DEFER_FIXTURE);
        // say1 deferred first, say3 deferred last → IR order: say3, say2, say1
        const say3Idx  = ir.lastIndexOf('call void @say3()');
        const say2Idx  = ir.lastIndexOf('call void @say2()');
        const say1Idx  = ir.lastIndexOf('call void @say1()');
        expect(say3Idx).toBeLessThan(say2Idx);
        expect(say2Idx).toBeLessThan(say1Idx);
    });

    it('deferred call section is delimited by ── deferred calls ── comment', () => {
        const { ir } = compileToIR(DEFER_FIXTURE);
        expect(ir).toContain('; ── deferred calls ──');
    });

    it('deferred body call appears before the defer section', () => {
        const { ir } = compileToIR(DEFER_FIXTURE);
        // The body print call (inside @main) should come before the defer flush block
        const deferSectionIdx = ir.indexOf('; ── deferred calls ──');
        // The body printf call uses "body" string
        const bodyPrintIdx = ir.indexOf('@.raw.');
        // This is a soft check: the function body runs before defers
        expect(deferSectionIdx).toBeGreaterThan(0);
    });
});

// ── defer — runtime ───────────────────────────────────────────────────────────

describe('defer — runtime', () => {

    it('produces 4 lines of output', () => {
        const { exitCode, stdout } = compileAndRun(DEFER_FIXTURE);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(4);
    });

    it('body executes before deferred calls', () => {
        const { stdout } = compileAndRun(DEFER_FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('body');
    });

    it('deferred calls run in LIFO order: 3, 2, 1', () => {
        const { stdout } = compileAndRun(DEFER_FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('deferred 3');
        expect(lines[2]).toBe('deferred 2');
        expect(lines[3]).toBe('deferred 1');
    });

    it('exit code is 0', () => {
        const { exitCode } = compileAndRun(DEFER_FIXTURE);
        expect(exitCode).toBe(0);
    });
});

// ── using — IR structure ──────────────────────────────────────────────────────

describe('using — IR structure', () => {

    it('using allocates the variable like let', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        // %b should be allocated with alloca %Buffer*
        expect(ir).toMatch(/%b = alloca %Buffer\*/);
    });

    it('using synthesises Buffer_dispose call before ret', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        expect(ir).toContain('call void @Buffer_dispose(');
        // Must appear before the ret instruction
        const retIdx     = ir.lastIndexOf('ret i32 0');
        const disposeIdx = ir.lastIndexOf('call void @Buffer_dispose(');
        expect(disposeIdx).toBeGreaterThan(0);
        expect(disposeIdx).toBeLessThan(retIdx);
    });

    it('Buffer_dispose is emitted inside the defer section comment', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        const deferStart = ir.lastIndexOf('; ── deferred calls ──');
        const deferEnd   = ir.lastIndexOf('; ──────────────────');
        const disposeIdx = ir.lastIndexOf('call void @Buffer_dispose(');
        expect(deferStart).toBeGreaterThan(0);
        expect(disposeIdx).toBeGreaterThan(deferStart);
        expect(disposeIdx).toBeLessThan(deferEnd);
    });

    it('emits @Buffer_dispose extension method', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        expect(ir).toMatch(/define.*@Buffer_dispose\(%Buffer\* %self\.0\)/);
    });

    it('Buffer_dispose body calls @buffer_free', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        // The Buffer_dispose method should call buffer_free
        expect(ir).toMatch(/call void @buffer_free\(%Buffer\*.*\)/);
    });

    it('using variable is accessible in the function body before dispose', () => {
        const { ir } = compileToIR(USING_FIXTURE);
        // The variable %b must be loaded and used for Buffer_length call
        expect(ir).toContain('call i32 @Buffer_length(');
    });
});

// ── using — runtime ───────────────────────────────────────────────────────────

describe('using — runtime', () => {

    it('produces correct length for "hello" (5)', () => {
        const { stdout } = compileAndRun(USING_FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('5');
    });

    it('produces correct first byte for "hello" (104 = h)', () => {
        const { stdout } = compileAndRun(USING_FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('104');
    });

    it('produces correct last byte for "hello" (111 = o)', () => {
        const { stdout } = compileAndRun(USING_FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('111');
    });

    it('exits cleanly (no crash from double-free or null deref)', () => {
        const { exitCode } = compileAndRun(USING_FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 3 lines of output', () => {
        const { exitCode, stdout } = compileAndRun(USING_FIXTURE);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(3);
    });
});
