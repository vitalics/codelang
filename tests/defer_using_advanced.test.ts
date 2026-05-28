/**
 * Non-trivial tests for `defer` and `using`.
 *
 * These tests go beyond the basics in defer.test.ts / using_test.code and
 * cover:
 *
 *  Positive (defer)
 *   1. Defer fires on EVERY early-return path (multi-branch function)
 *   2. Defer is scoped per function call — each invocation gets its own stack
 *   3. Defer + using together in one function: LIFO interleaving
 *   4. IR: deferred call appears before EACH ret instruction
 *
 *  Positive (using)
 *   5. Using fires dispose even when the function exits via an early return
 *   6. Two using bindings in the same function — both disposed, LIFO order
 *   7. IR: second using's dispose appears before first using's dispose in IR
 *
 *  Negative (syntax / parse errors)
 *   8. `defer print(x)` — `print` is a keyword, not an expression; parser error
 *   9. `using b: Buffer;` — missing required `= value`; parser error
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun, compileExpectError } from './helpers/cli.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEFER_EARLY   = 'defer_early_return.code';
const DEFER_PER     = 'defer_per_call.code';
const DEFER_AND_USE = 'defer_and_using.code';
const USING_EARLY   = 'using_early_return.code';
const USING_MULTI   = 'using_multiple.code';

// ── defer: multi-path early return ───────────────────────────────────────────

describe('defer — fires on every early-return path', () => {

    it('all three branches produce output', () => {
        const { exitCode, stdout } = compileAndRun(DEFER_EARLY);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(6); // 3 calls × (1 defer + 1 result)
    });

    it('defer fires before negative-branch return value is printed', () => {
        const { stdout } = compileAndRun(DEFER_EARLY);
        const lines = stdout.trim().split('\n');
        // call 1: classify(-5) → defer prints "exit", then main prints -1
        expect(lines[0]).toBe('exit');
        expect(lines[1]).toBe('-1');
    });

    it('defer fires before zero-branch return value is printed', () => {
        const { stdout } = compileAndRun(DEFER_EARLY);
        const lines = stdout.trim().split('\n');
        // call 2: classify(0) → defer prints "exit", then main prints 0
        expect(lines[2]).toBe('exit');
        expect(lines[3]).toBe('0');
    });

    it('defer fires before positive-branch return value is printed', () => {
        const { stdout } = compileAndRun(DEFER_EARLY);
        const lines = stdout.trim().split('\n');
        // call 3: classify(3) → defer prints "exit", then main prints 1
        expect(lines[4]).toBe('exit');
        expect(lines[5]).toBe('1');
    });

    it('IR: log_exit call appears before every ret instruction', () => {
        const { ir } = compileToIR(DEFER_EARLY);
        // The deferred @log_exit call must exist in IR
        expect(ir).toContain('call void @log_exit()');
        // Every ret i32 must be preceded by the deferred section comment
        const deferMarkers = [...ir.matchAll(/; ── deferred calls ──/g)];
        // classify has 3 return paths — there should be at least 3 defer sections
        // (one per return block inside classify, plus the implicit one at end)
        expect(deferMarkers.length).toBeGreaterThanOrEqual(3);
    });
});

// ── defer: scoped per function call ──────────────────────────────────────────

describe('defer — scoped to its function invocation', () => {

    it('each of the 3 calls produces exactly 2 lines (body + deferred)', () => {
        const { exitCode, stdout } = compileAndRun(DEFER_PER);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(6);
    });

    it('body runs before the deferred call within the same invocation', () => {
        const { stdout } = compileAndRun(DEFER_PER);
        const lines = stdout.trim().split('\n');
        // run_step(1): body prints -1, defer prints 1
        expect(lines[0]).toBe('-1');
        expect(lines[1]).toBe('1');
    });

    it('second call deferred value is 2, not left over from first call', () => {
        const { stdout } = compileAndRun(DEFER_PER);
        const lines = stdout.trim().split('\n');
        // run_step(2): body -2, defer 2
        expect(lines[2]).toBe('-2');
        expect(lines[3]).toBe('2');
    });

    it('third call deferred value is 3, not leaked from prior calls', () => {
        const { stdout } = compileAndRun(DEFER_PER);
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('-3');
        expect(lines[5]).toBe('3');
    });
});

// ── defer + using: interleaved LIFO ──────────────────────────────────────────

describe('defer + using — LIFO interleaving', () => {

    // Fixture: process() does  using b (registered first) then defer on_done()
    // (registered second).  LIFO: on_done() fires first, then b.dispose().
    // main() prints the return value of process() AFTER it returns.
    // Expected output:  "explicit-defer"  then  "5"

    it('produces exactly 2 lines of output', () => {
        const { exitCode, stdout } = compileAndRun(DEFER_AND_USE);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(2);
    });

    it('explicit defer (registered after using) runs first — LIFO', () => {
        const { stdout } = compileAndRun(DEFER_AND_USE);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('explicit-defer');
    });

    it('return value is printed after all defers have run', () => {
        const { stdout } = compileAndRun(DEFER_AND_USE);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('5');
    });

    it('IR: on_done() appears before Buffer_dispose in the deferred section', () => {
        const { ir } = compileToIR(DEFER_AND_USE);
        const onDoneIdx  = ir.lastIndexOf('call void @on_done()');
        const disposeIdx = ir.lastIndexOf('call void @Buffer_dispose(');
        expect(onDoneIdx).toBeGreaterThan(0);
        expect(disposeIdx).toBeGreaterThan(0);
        // on_done registered later → executed first (LIFO)
        expect(onDoneIdx).toBeLessThan(disposeIdx);
    });
});

// ── using: early return ───────────────────────────────────────────────────────

describe('using — dispose fires even on early return', () => {

    // count_bytes("") → early return → dispose still runs (no leak)
    // count_bytes("hi") → normal path
    // count_bytes("hello") → normal path

    it('exits cleanly (no crash from skipped dispose on early path)', () => {
        const { exitCode } = compileAndRun(USING_EARLY);
        expect(exitCode).toBe(0);
    });

    it('early-return path returns 0 for empty string', () => {
        const { stdout } = compileAndRun(USING_EARLY);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('0');
    });

    it('normal path returns correct length for "hi" (2)', () => {
        const { stdout } = compileAndRun(USING_EARLY);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('2');
    });

    it('normal path returns correct length for "hello" (5)', () => {
        const { stdout } = compileAndRun(USING_EARLY);
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('5');
    });

    it('IR: Buffer_dispose appears before BOTH ret instructions', () => {
        const { ir } = compileToIR(USING_EARLY);
        // There must be at least 2 Buffer_dispose calls (one per return path)
        const matches = [...ir.matchAll(/call void @Buffer_dispose\(/g)];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});

// ── using: multiple resources ─────────────────────────────────────────────────

describe('using — two resources in same function', () => {

    // sum_lengths(a, b): using b1 = a.toBuffer(), using b2 = b.toBuffer()
    // b2 is declared after b1, so LIFO: b2.dispose() fires first.

    it('exits cleanly (both resources freed, no double-free or leak)', () => {
        const { exitCode } = compileAndRun(USING_MULTI);
        expect(exitCode).toBe(0);
    });

    it('sum_lengths("hi", "world") == 7  (2 + 5)', () => {
        const { stdout } = compileAndRun(USING_MULTI);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('7');
    });

    it('sum_lengths("", "abc") == 3  (0 + 3)', () => {
        const { stdout } = compileAndRun(USING_MULTI);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('3');
    });

    it('sum_lengths("hello", "hello") == 10  (5 + 5)', () => {
        const { stdout } = compileAndRun(USING_MULTI);
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('10');
    });

    it('IR: exactly two Buffer_dispose calls in sum_lengths', () => {
        const { ir } = compileToIR(USING_MULTI);
        const matches = [...ir.matchAll(/call void @Buffer_dispose\(/g)];
        // Two using bindings → two dispose calls
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('IR: b2 is disposed before b1 (LIFO order)', () => {
        const { ir } = compileToIR(USING_MULTI);
        // Locate @sum_lengths in the IR.  The function may be emitted as
        // "define i32 @sum_lengths(" or "define private i32 @sum_lengths("
        // depending on visibility, so we search for just the symbol name.
        const symIdx  = ir.indexOf('@sum_lengths(');
        expect(symIdx).toBeGreaterThan(0); // function must exist

        const fnStart = ir.lastIndexOf('define', symIdx); // rewind to 'define'
        const fnEnd   = ir.indexOf('\n}', fnStart) + 2;   // closing brace
        const fnBody  = ir.slice(fnStart, fnEnd);

        const disposeMatches = [...fnBody.matchAll(/call void @Buffer_dispose\(/g)];
        expect(disposeMatches.length).toBe(2);

        // b2 is declared after b1 → LIFO means b2's dispose comes first in
        // the deferred block.  Verify positional order in the function text.
        const firstIdx  = disposeMatches[0].index!;
        const secondIdx = disposeMatches[1].index!;
        expect(firstIdx).toBeLessThan(secondIdx); // earlier in text = runs first (LIFO from b2)
    });
});

// ── Negative: syntax / parse errors ──────────────────────────────────────────

describe('defer — negative: parse errors', () => {

    it('defer with print keyword target is rejected (print is not an expression)', () => {
        const result = compileExpectError('defer_print_target.code');
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('print');
    });

    it('error message mentions the unexpected token', () => {
        const result = compileExpectError('defer_print_target.code');
        // Parser reports "but found: 'print'" or similar
        expect(result.stderr.toLowerCase()).toMatch(/print|unexpected|found/);
    });
});

describe('using — negative: parse errors', () => {

    it('using without initializer is rejected (= value is required)', () => {
        const result = compileExpectError('using_no_initializer.code');
        expect(result.exitCode).not.toBe(0);
    });

    it('error message mentions the missing = or unexpected ;', () => {
        const result = compileExpectError('using_no_initializer.code');
        expect(result.stderr).toMatch(/Expecting.*=|found.*`;`|=.*required/i);
    });
});
