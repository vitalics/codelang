/**
 * Tests for nested functions combined with `defer` and `using`.
 *
 * Five fixture files are exercised:
 *
 *  1. nested_fn_defer_scoping     — each nested-fn call gets its own defer scope
 *  2. nested_fn_defer_interaction — inner defer fires before outer defer (independent scopes)
 *  3. nested_fn_using_buffer      — `using` Buffer inside a nested fn (resource management)
 *  4. nested_fn_using_early_return— `using` fires on every return path (early + normal)
 *  5. nested_fn_using_defer       — `using` + explicit `defer` inside nested fn (LIFO order)
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── 1. Defer scoping ─────────────────────────────────────────────────────────
//
// Each invocation of the nested fn `step(n)` has its own defer list.
// Deferred call fires when *that call* returns, not when main returns.
// Output per call: -(n) then n  →  total: -1 / 1 / -2 / 2 / -3 / 3

describe('nested fn + defer — scoping per call', () => {

    it('produces 6 lines of output', () => {
        const { exitCode, stdout } = compileAndRun('nested_fn_defer_scoping.code');
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(6);
    });

    it('body of step(1) prints -1 before its deferred 1', () => {
        const { stdout } = compileAndRun('nested_fn_defer_scoping.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('-1');
        expect(lines[1]).toBe('1');
    });

    it('body of step(2) prints -2 before its deferred 2', () => {
        const { stdout } = compileAndRun('nested_fn_defer_scoping.code');
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('-2');
        expect(lines[3]).toBe('2');
    });

    it('body of step(3) prints -3 before its deferred 3', () => {
        const { stdout } = compileAndRun('nested_fn_defer_scoping.code');
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('-3');
        expect(lines[5]).toBe('3');
    });

    it('full output is -1 / 1 / -2 / 2 / -3 / 3', () => {
        const { stdout } = compileAndRun('nested_fn_defer_scoping.code');
        expect(stdout).toBe('-1\n1\n-2\n2\n-3\n3\n');
    });

    it('IR: deferred call is inside @main.step, not @main', () => {
        const { ir } = compileToIR('nested_fn_defer_scoping.code');
        // Find @main.step definition
        const stepStart = ir.indexOf('define private void @main.step(');
        expect(stepStart).toBeGreaterThan(0);
        // The defer section must be inside @main.step, i.e. after its definition
        const deferInStep = ir.indexOf('; ── deferred calls ──', stepStart);
        expect(deferInStep).toBeGreaterThan(stepStart);
        // @main itself should NOT have a deferred-calls section (no defer in main)
        const mainStart  = ir.indexOf('define i32 @main()');
        const mainEnd    = ir.indexOf('\n}', mainStart);
        const deferInMain = ir.indexOf('; ── deferred calls ──', mainStart);
        // Either no defer section in main, or it's outside main's body
        expect(deferInMain === -1 || deferInMain > mainEnd).toBe(true);
    });

    it('IR: @main.step emits the deferred call before ret', () => {
        const { ir } = compileToIR('nested_fn_defer_scoping.code');
        const stepDef   = ir.indexOf('define private void @main.step(');
        const stepClose = ir.indexOf('\n}', stepDef);
        const deferIdx  = ir.indexOf('; ── deferred calls ──', stepDef);
        const retIdx    = ir.lastIndexOf('ret void', stepClose);
        expect(deferIdx).toBeGreaterThan(stepDef);
        expect(deferIdx).toBeLessThan(retIdx);
    });
});

// ── 2. Defer interaction — inner vs outer ────────────────────────────────────
//
// Outer fn (main) defers say_outer().
// Nested fn (process) defers say_inner().
// Expected order: start / process / inner / end / outer

describe('nested fn + defer — inner fires before outer', () => {

    it('exit code is 0', () => {
        const { exitCode } = compileAndRun('nested_fn_defer_interaction.code');
        expect(exitCode).toBe(0);
    });

    it('produces 5 lines of output', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')).toHaveLength(5);
    });

    it('"start" appears first', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')[0]).toBe('start');
    });

    it('"process" appears second (nested fn body)', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')[1]).toBe('process');
    });

    it('"inner" appears third — nested fn defer fires when process returns', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')[2]).toBe('inner');
    });

    it('"end" appears fourth — outer fn continues after process() call', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')[3]).toBe('end');
    });

    it('"outer" appears last — outer fn defer fires when main returns', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout.trim().split('\n')[4]).toBe('outer');
    });

    it('full output is start / process / inner / end / outer', () => {
        const { stdout } = compileAndRun('nested_fn_defer_interaction.code');
        expect(stdout).toBe('start\nprocess\ninner\nend\nouter\n');
    });

    it('IR: @main.process has its own deferred-calls section', () => {
        const { ir } = compileToIR('nested_fn_defer_interaction.code');
        const procStart = ir.indexOf('define private void @main.process()');
        expect(procStart).toBeGreaterThan(0);
        const deferInProc = ir.indexOf('; ── deferred calls ──', procStart);
        expect(deferInProc).toBeGreaterThan(procStart);
    });

    it('IR: @main also has its own deferred-calls section for say_outer', () => {
        const { ir } = compileToIR('nested_fn_defer_interaction.code');
        const mainStart = ir.indexOf('define i32 @main()');
        const mainEnd   = ir.indexOf('define private void @main.process()');
        const deferInMain = ir.indexOf('; ── deferred calls ──', mainStart);
        expect(deferInMain).toBeGreaterThan(mainStart);
        expect(deferInMain).toBeLessThan(mainEnd);
    });

    it('IR: say_inner is called inside @main.process defer section', () => {
        const { ir } = compileToIR('nested_fn_defer_interaction.code');
        const procStart = ir.indexOf('define private void @main.process()');
        const procEnd   = ir.indexOf('\n}', procStart);
        const innerCall = ir.indexOf('call void @say_inner()', procStart);
        expect(innerCall).toBeGreaterThan(procStart);
        expect(innerCall).toBeLessThan(procEnd);
    });

    it('IR: say_outer is called inside @main defer section, not inside @main.process', () => {
        const { ir } = compileToIR('nested_fn_defer_interaction.code');
        const mainStart = ir.indexOf('define i32 @main()');
        const procStart = ir.indexOf('define private void @main.process()');
        const outerCall = ir.lastIndexOf('call void @say_outer()');
        // say_outer should be called in main's body (before @main.process definition)
        expect(outerCall).toBeGreaterThan(mainStart);
        expect(outerCall).toBeLessThan(procStart);
    });
});

// ── 3. using Buffer inside nested fn ─────────────────────────────────────────
//
// `using b: Buffer` inside the nested fn allocates and auto-frees a Buffer.
// Each call is independent; the Buffer lifetime is scoped to the nested call.
// Expected output: 5 / 6 / 0 / 3

describe('nested fn + using — Buffer lifetime scoped to nested call', () => {

    it('exit code is 0', () => {
        const { exitCode } = compileAndRun('nested_fn_using_buffer.code');
        expect(exitCode).toBe(0);
    });

    it('produces 4 lines of output', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout.trim().split('\n')).toHaveLength(4);
    });

    it('byte_len("hello") = 5', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout.trim().split('\n')[0]).toBe('5');
    });

    it('byte_len("world!") = 6', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout.trim().split('\n')[1]).toBe('6');
    });

    it('byte_len("") = 0', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout.trim().split('\n')[2]).toBe('0');
    });

    it('byte_len("abc") = 3', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout.trim().split('\n')[3]).toBe('3');
    });

    it('full output is 5 / 6 / 0 / 3', () => {
        const { stdout } = compileAndRun('nested_fn_using_buffer.code');
        expect(stdout).toBe('5\n6\n0\n3\n');
    });

    it('IR: @main.byte_len allocates %Buffer*', () => {
        const { ir } = compileToIR('nested_fn_using_buffer.code');
        const fnStart = ir.indexOf('define private i32 @main.byte_len(');
        expect(fnStart).toBeGreaterThan(0);
        const allocaIdx = ir.indexOf('%b = alloca %Buffer*', fnStart);
        expect(allocaIdx).toBeGreaterThan(fnStart);
    });

    it('IR: @main.byte_len calls Buffer_dispose in its defer section', () => {
        const { ir } = compileToIR('nested_fn_using_buffer.code');
        const fnStart = ir.indexOf('define private i32 @main.byte_len(');
        const fnEnd   = ir.indexOf('\n}', fnStart);
        const disposeIdx = ir.indexOf('call void @Buffer_dispose(', fnStart);
        expect(disposeIdx).toBeGreaterThan(fnStart);
        expect(disposeIdx).toBeLessThan(fnEnd);
    });

    it('IR: Buffer_dispose call is inside the deferred-calls section of @main.byte_len', () => {
        const { ir } = compileToIR('nested_fn_using_buffer.code');
        const fnStart    = ir.indexOf('define private i32 @main.byte_len(');
        const deferStart = ir.indexOf('; ── deferred calls ──', fnStart);
        const deferEnd   = ir.indexOf('; ──────────────────', deferStart);
        const disposeIdx = ir.indexOf('call void @Buffer_dispose(', fnStart);
        expect(deferStart).toBeGreaterThan(fnStart);
        expect(disposeIdx).toBeGreaterThan(deferStart);
        expect(disposeIdx).toBeLessThan(deferEnd);
    });
});

// ── 4. using + early return inside nested fn ─────────────────────────────────
//
// `using b` in the nested fn fires on every return path, including the early
// `if n == 0 { return 0; }` branch.
// Expected output: 0 / 5 / 2

describe('nested fn + using — fires on every return path', () => {

    it('exit code is 0', () => {
        const { exitCode } = compileAndRun('nested_fn_using_early_return.code');
        expect(exitCode).toBe(0);
    });

    it('guard("") = 0 (early-return path)', () => {
        const { stdout } = compileAndRun('nested_fn_using_early_return.code');
        expect(stdout.trim().split('\n')[0]).toBe('0');
    });

    it('guard("hello") = 5 (normal-return path)', () => {
        const { stdout } = compileAndRun('nested_fn_using_early_return.code');
        expect(stdout.trim().split('\n')[1]).toBe('5');
    });

    it('guard("hi") = 2 (normal-return path)', () => {
        const { stdout } = compileAndRun('nested_fn_using_early_return.code');
        expect(stdout.trim().split('\n')[2]).toBe('2');
    });

    it('full output is 0 / 5 / 2', () => {
        const { stdout } = compileAndRun('nested_fn_using_early_return.code');
        expect(stdout).toBe('0\n5\n2\n');
    });

    it('IR: @main.guard has two ret instructions (early + normal)', () => {
        const { ir } = compileToIR('nested_fn_using_early_return.code');
        const fnStart = ir.indexOf('define private i32 @main.guard(');
        const fnEnd   = ir.indexOf('\n}', fnStart);
        const body    = ir.slice(fnStart, fnEnd);
        const retCount = (body.match(/\bret i32\b/g) ?? []).length;
        expect(retCount).toBeGreaterThanOrEqual(2);
    });

    it('IR: Buffer_dispose is emitted before each ret in @main.guard', () => {
        const { ir } = compileToIR('nested_fn_using_early_return.code');
        const fnStart = ir.indexOf('define private i32 @main.guard(');
        const fnEnd   = ir.indexOf('\n}', fnStart);
        const body    = ir.slice(fnStart, fnEnd);
        // Every ret should be preceded by a Buffer_dispose (inside deferred section)
        const disposePositions = [...body.matchAll(/call void @Buffer_dispose\(/g)].map(m => m.index!);
        const retPositions     = [...body.matchAll(/\bret i32\b/g)].map(m => m.index!);
        // Each ret must have at least one Buffer_dispose before it
        for (const retPos of retPositions) {
            const disposeBefore = disposePositions.some(d => d < retPos);
            expect(disposeBefore).toBe(true);
        }
    });
});

// ── 5. using + explicit defer inside nested fn (LIFO) ────────────────────────
//
// Inside `process(s)`:
//   1. `using b` registers defer b.dispose()  [first → runs last]
//   2. `defer report_done()` registered second [second → runs first, LIFO]
//
// Execution per call: report_done() fires (prints "done"), b.dispose() (silent),
// then the return value is printed.
// Expected output: done / 5 / done / 0

describe('nested fn + using + defer — LIFO order inside nested fn', () => {

    it('exit code is 0', () => {
        const { exitCode } = compileAndRun('nested_fn_using_defer.code');
        expect(exitCode).toBe(0);
    });

    it('produces 4 lines of output', () => {
        const { stdout } = compileAndRun('nested_fn_using_defer.code');
        expect(stdout.trim().split('\n')).toHaveLength(4);
    });

    it('"done" prints before 5 (defer fires during the call, before outer print)', () => {
        const { stdout } = compileAndRun('nested_fn_using_defer.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('done');
        expect(lines[1]).toBe('5');
    });

    it('"done" prints before 0 for the empty-string call', () => {
        const { stdout } = compileAndRun('nested_fn_using_defer.code');
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('done');
        expect(lines[3]).toBe('0');
    });

    it('full output is done / 5 / done / 0', () => {
        const { stdout } = compileAndRun('nested_fn_using_defer.code');
        expect(stdout).toBe('done\n5\ndone\n0\n');
    });

    it('IR: @main.process has deferred-calls section', () => {
        const { ir } = compileToIR('nested_fn_using_defer.code');
        const fnStart = ir.indexOf('define private i32 @main.process(');
        expect(fnStart).toBeGreaterThan(0);
        const deferIdx = ir.indexOf('; ── deferred calls ──', fnStart);
        expect(deferIdx).toBeGreaterThan(fnStart);
    });

    it('IR: report_done fires before Buffer_dispose (LIFO)', () => {
        const { ir } = compileToIR('nested_fn_using_defer.code');
        const fnStart     = ir.indexOf('define private i32 @main.process(');
        const fnEnd       = ir.indexOf('\n}', fnStart);
        const doneIdx     = ir.indexOf('call void @report_done()', fnStart);
        const disposeIdx  = ir.indexOf('call void @Buffer_dispose(', fnStart);
        expect(doneIdx).toBeGreaterThan(fnStart);
        expect(disposeIdx).toBeGreaterThan(fnStart);
        // LIFO: explicit defer (registered second) runs before using's dispose
        expect(doneIdx).toBeLessThan(disposeIdx);
        expect(disposeIdx).toBeLessThan(fnEnd);
    });

    it('IR: both report_done and Buffer_dispose are inside the deferred-calls section', () => {
        const { ir } = compileToIR('nested_fn_using_defer.code');
        const fnStart    = ir.indexOf('define private i32 @main.process(');
        const deferStart = ir.indexOf('; ── deferred calls ──', fnStart);
        const deferEnd   = ir.indexOf('; ──────────────────', deferStart);
        const doneIdx    = ir.indexOf('call void @report_done()', fnStart);
        const disposeIdx = ir.indexOf('call void @Buffer_dispose(', fnStart);
        expect(doneIdx).toBeGreaterThan(deferStart);
        expect(doneIdx).toBeLessThan(deferEnd);
        expect(disposeIdx).toBeGreaterThan(deferStart);
        expect(disposeIdx).toBeLessThan(deferEnd);
    });
});
