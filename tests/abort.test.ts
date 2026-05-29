/**
 * AbortController / AbortSignal tests.
 *
 * Covers (via abort_basic.code — 13 expected output lines):
 *   [0]  false          — fresh signal not yet aborted
 *   [1]  true           — after ctrl.abort()
 *   [2]  AbortError     — default reason
 *   [3]  user cancelled — custom reason via abortWith
 *   [4]  true           — AbortSignal.abortWith static factory → already aborted
 *   [5]  gone           — reason from static factory
 *   [6]  callback fired — onAbort fires synchronously inside abort()
 *   [7]  false          — AbortSignal.timeout(300) not yet fired
 *   [8]  true           — after Async.sleep(500) the timeout has fired
 *   [9]  TimeoutError   — reason set by the timeout factory
 *   [10] task stopped   — cooperative task cancellation (before Async.wait returns)
 *   [11] callback once  — onAbort fires exactly once (idempotent)
 *   [12] true           — signal still aborted after double abort() call
 *
 * Also verifies IR-level declarations for AbortSignal and AbortController.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Shared fixture result ─────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
    ir:       string;
}

let result: FixtureResult = { exitCode: null, lines: [], ir: '' };

beforeAll(() => {
    const r = compileAndRun('abort_basic.code');
    result = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);  // abort_basic waits up to ~500 ms; allow generous ceiling

// ── Compilation ───────────────────────────────────────────────────────────────

describe('abort_basic — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(result.exitCode).toBe(0);
    });
    it('produces exactly 13 lines of output', () => {
        expect(result.lines).toHaveLength(13);
    });
});

// ── 1. Basic abort ────────────────────────────────────────────────────────────

describe('AbortController — basic abort', () => {
    it('[0] fresh signal: aborted() returns false', () => {
        expect(result.lines[0]).toBe('false');
    });
    it('[1] after abort(): aborted() returns true', () => {
        expect(result.lines[1]).toBe('true');
    });
    it('[2] default reason is "AbortError"', () => {
        expect(result.lines[2]).toBe('AbortError');
    });
});

// ── 2. Custom reason ──────────────────────────────────────────────────────────

describe('AbortController — abortWith(reason)', () => {
    it('[3] custom reason is propagated', () => {
        expect(result.lines[3]).toBe('user cancelled');
    });
});

// ── 3. Static already-aborted factory ────────────────────────────────────────

describe('AbortSignal.abortWith() — static factory', () => {
    it('[4] factory signal is immediately aborted', () => {
        expect(result.lines[4]).toBe('true');
    });
    it('[5] factory signal carries the supplied reason', () => {
        expect(result.lines[5]).toBe('gone');
    });
});

// ── 4. onAbort callback ───────────────────────────────────────────────────────

describe('AbortSignal.onAbort() — synchronous callback', () => {
    it('[6] callback fires synchronously inside abort()', () => {
        expect(result.lines[6]).toBe('callback fired');
    });
});

// ── 5. AbortSignal.timeout() ─────────────────────────────────────────────────

describe('AbortSignal.timeout(ms) — deadline signal', () => {
    it('[7] signal not yet aborted immediately after creation', () => {
        expect(result.lines[7]).toBe('false');
    });
    it('[8] signal is aborted after Async.sleep(500) (timeout = 300 ms)', () => {
        expect(result.lines[8]).toBe('true');
    });
    it('[9] reason is "TimeoutError"', () => {
        expect(result.lines[9]).toBe('TimeoutError');
    });
});

// ── 6. Cooperative task cancellation ─────────────────────────────────────────

describe('AbortSignal — cooperative task cancellation', () => {
    it('[10] spawned task sees abort and exits before Async.wait returns', () => {
        expect(result.lines[10]).toBe('task stopped');
    });
});

// ── 7. Idempotency ────────────────────────────────────────────────────────────

describe('AbortController — idempotency (double abort)', () => {
    it('[11] onAbort callback fires exactly once', () => {
        expect(result.lines[11]).toBe('callback once');
    });
    it('[12] signal remains aborted after second abort() call', () => {
        expect(result.lines[12]).toBe('true');
    });
});

// ── IR structure ──────────────────────────────────────────────────────────────

describe('AbortSignal — IR declarations', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('abort_basic.code');
        ir = r.ir;
    }, 30_000);

    it('IR: emits %AbortSignal opaque type', () => {
        expect(ir).toMatch(/%AbortSignal = type opaque/);
    });
    it('IR: emits %AbortController opaque type', () => {
        expect(ir).toMatch(/%AbortController = type opaque/);
    });
    it('IR: declares @abort_signal_aborted', () => {
        expect(ir).toMatch(/declare i32 @abort_signal_aborted\(%AbortSignal\*\)/);
    });
    it('IR: declares @abort_signal_reason', () => {
        expect(ir).toMatch(/declare i8\* @abort_signal_reason\(%AbortSignal\*\)/);
    });
    it('IR: declares @abort_controller_new', () => {
        expect(ir).toMatch(/declare %AbortController\* @abort_controller_new\(\)/);
    });
    it('IR: declares @abort_controller_abort', () => {
        expect(ir).toMatch(/declare void @abort_controller_abort\(%AbortController\*, i8\*\)/);
    });
    it('IR: declares @abort_signal_timeout', () => {
        expect(ir).toMatch(/declare %AbortSignal\* @abort_signal_timeout\(i32\)/);
    });
    it('IR: declares @abort_signal_on_abort', () => {
        expect(ir).toMatch(/declare void @abort_signal_on_abort\(%AbortSignal\*, \{ i8\*, i8\* \}\)/);
    });
});
