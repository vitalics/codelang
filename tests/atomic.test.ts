/**
 * Tests for stdlib/atomic.code — Atomic<T> generic atomic variables.
 *
 * Covers:
 *   - IR structure: %Atomic_* struct declarations (not opaque)
 *   - Atomic instructions: load atomic, store atomic, atomicrmw, cmpxchg
 *   - @malloc / @free declarations
 *   - Runtime: int, bool, float operations on a single thread
 *   - Runtime: cross-thread counter mutation via Async.spawn (atomic_shared)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── Shared fixture results ────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
}

let basic:  FixtureResult = { exitCode: null, lines: [] };
let shared: FixtureResult = { exitCode: null, lines: [] };

beforeAll(() => {
    const r1 = compileAndRun('atomic_basic.code');
    basic = { exitCode: r1.exitCode, lines: r1.stdout.trim().split('\n') };

    const r2 = compileAndRun('atomic_shared.code');
    shared = { exitCode: r2.exitCode, lines: r2.stdout.trim().split('\n') };
}, 120_000);

// ── IR structure — type declarations ─────────────────────────────────────────

describe('Atomic<T> — IR type declarations', () => {

    it('%Atomic_i32 is a concrete struct, not opaque', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toContain('%Atomic_i32 = type { i32 }');
    });

    it('%Atomic_bool stores as i8 (bool widened for atomic alignment)', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toContain('%Atomic_bool = type { i8 }');
    });

    it('%Atomic_f64 stores as double (CodeLang float = LLVM double)', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toContain('%Atomic_f64 = type { double }');
    });

    it('does NOT emit opaque declarations for Atomic instantiations', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).not.toMatch(/%Atomic_i32 = type opaque/);
        expect(ir).not.toMatch(/%Atomic_bool = type opaque/);
        expect(ir).not.toMatch(/%Atomic_f64 = type opaque/);
    });
});

// ── IR structure — atomic instructions ───────────────────────────────────────

describe('Atomic<T> — IR atomic instructions', () => {

    it('load emits "load atomic i32"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/load atomic i32, i32\*/);
    });

    it('store emits "store atomic i32"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/store atomic i32 /);
    });

    it('add emits "atomicrmw add i32*"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/atomicrmw add i32\*/);
    });

    it('sub emits "atomicrmw sub i32*"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/atomicrmw sub i32\*/);
    });

    it('cas emits "cmpxchg i32*"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/cmpxchg i32\*/);
    });

    it('cas result extracts success flag via extractvalue', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/extractvalue \{ i32, i1 \}/);
    });

    it('bool load emits "load atomic i8" and trunc to i1', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/load atomic i8, i8\*/);
        expect(ir).toMatch(/trunc i8 %\d+ to i1/);
    });

    it('bool store emits zext i1 to i8 then "store atomic i8"', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/zext i1 .* to i8/);
        expect(ir).toMatch(/store atomic i8 /);
    });

    it('float cas bitcasts to i64 before cmpxchg (CodeLang float = LLVM double)', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/bitcast double .* to i64/);
    });

    it('all atomic ops use seq_cst ordering', () => {
        const { ir } = compileToIR('atomic_basic.code');
        // load/store use seq_cst
        expect(ir).toMatch(/load atomic i32, i32\* .* seq_cst/);
        // atomicrmw uses seq_cst
        expect(ir).toMatch(/atomicrmw \w+ i32\* .* seq_cst/);
        // cmpxchg uses seq_cst seq_cst
        expect(ir).toMatch(/cmpxchg \w+\* .* seq_cst seq_cst/);
    });

    it('Atomic.new uses malloc + GEP + store', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/call i8\* @malloc/);
        expect(ir).toMatch(/getelementptr inbounds %Atomic_i32/);
    });

    it('free emits bitcast to i8* + call @free', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toMatch(/bitcast %Atomic_i32\* .* to i8\*/);
        expect(ir).toMatch(/call void @free\(i8\* %\d+\)/);
    });

    it('header declares @free alongside @malloc', () => {
        const { ir } = compileToIR('atomic_basic.code');
        expect(ir).toContain('declare void @free(i8*)');
    });
});

// ── Runtime — atomic_basic (single-thread) ────────────────────────────────────

describe('atomic_basic — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(basic.exitCode).toBe(0);
    });
    it('produces exactly 13 lines of output', () => {
        expect(basic.lines).toHaveLength(13);
    });
});

describe('atomic_basic — int operations', () => {
    it('initial load returns 5', () =>
        expect(basic.lines[0]).toBe('5'));

    it('store(10) then load returns 10', () =>
        expect(basic.lines[1]).toBe('10'));

    it('add(3) returns previous value 10', () =>
        expect(basic.lines[2]).toBe('10'));

    it('load after add(3) returns 13', () =>
        expect(basic.lines[3]).toBe('13'));

    it('sub(1) returns previous value 13', () =>
        expect(basic.lines[4]).toBe('13'));

    it('load after sub(1) returns 12', () =>
        expect(basic.lines[5]).toBe('12'));

    it('cas(12, 99) returns true (swap succeeded)', () =>
        expect(basic.lines[6]).toBe('true'));

    it('load after successful cas returns 99', () =>
        expect(basic.lines[7]).toBe('99'));
});

describe('atomic_basic — bool operations', () => {
    it('initial bool load returns false', () =>
        expect(basic.lines[8]).toBe('false'));

    it('bool store(true) then load returns true', () =>
        expect(basic.lines[9]).toBe('true'));
});

describe('atomic_basic — float operations', () => {
    it('initial float load returns 1.5', () =>
        expect(basic.lines[10]).toBe('1.5'));

    it('float store(2.5) then load returns 2.5', () =>
        expect(basic.lines[11]).toBe('2.5'));

    it('float cas(2.5, 0.0) returns true', () =>
        expect(basic.lines[12]).toBe('true'));
});

// ── Runtime — atomic_shared (cross-thread) ────────────────────────────────────

describe('atomic_shared — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(shared.exitCode).toBe(0);
    });
    it('produces exactly 3 lines of output', () => {
        expect(shared.lines).toHaveLength(3);
    });
});

describe('atomic_shared — cross-thread mutation', () => {
    it('counter starts at 0', () =>
        expect(shared.lines[0]).toBe('0'));

    it('counter is 1 after one spawned task increments it', () =>
        expect(shared.lines[1]).toBe('1'));

    it('counter is 5 after five sequential tasks each add 1', () =>
        expect(shared.lines[2]).toBe('5'));
});
