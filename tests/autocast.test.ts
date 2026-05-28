/**
 * Auto-cast and SMI (Small Integer) optimisation tests
 *
 * V8-style SMI:
 *   - `const` integer literals in [-128, 127] → i8 alloca
 *   - `const` integer literals outside that range → i32 alloca
 *   - `let` integer literals → i32 alloca (promoted, safe for reassignment)
 *
 * Auto-cast (emitted at use-sites, not at declaration):
 *   - i8 variable passed to i32 param     → sext i8 … to i32
 *   - i32 variable passed to double param → sitofp i32 … to double
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── SMI — alloca type selection ───────────────────────────────────────────────

describe('SMI — alloca type selection', () => {
    it('const in [-128,127] → i8 alloca', () => {
        const { exitCode, ir } = compileToIR('smi.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/%small = alloca i8/);
    });

    it('const outside i8 range → i32 alloca', () => {
        const { exitCode, ir } = compileToIR('smi.code');
        expect(exitCode).toBe(0);
        // value 200 > 127 — must NOT use i8
        expect(ir).toMatch(/%big = alloca i32/);
        expect(ir).not.toMatch(/%big = alloca i8/);
    });

    it('let int literal → i32 alloca (always promoted)', () => {
        const { exitCode, ir } = compileToIR('smi.code');
        expect(exitCode).toBe(0);
        // value 5 fits in i8 but `let` must be promoted to i32
        expect(ir).toMatch(/%mutable_val = alloca i32/);
        expect(ir).not.toMatch(/%mutable_val = alloca i8/);
    });

    it('SMI fixture compiles and runs cleanly', () => {
        const { exitCode, stdout } = compileAndRun('smi.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('smi ok\n');
    });
});

// ── Auto-cast: sext (signed int widening) ────────────────────────────────────

describe('auto-cast — sext (i8 → i32)', () => {
    it('emits sext when SMI const is passed to an int (i32) parameter', () => {
        const { exitCode, ir } = compileToIR('auto_cast_sext.code');
        expect(exitCode).toBe(0);
        // The const x = 42 is stored as i8; calling take_int(x: int) must widen it
        expect(ir).toMatch(/sext i8 .* to i32/);
    });

    it('the widened value is passed as i32 in the call instruction', () => {
        const { exitCode, ir } = compileToIR('auto_cast_sext.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/call void @take_int\(i32 %\d+\)/);
    });

    it('auto_cast_sext compiles and runs, producing correct output', () => {
        const { exitCode, stdout } = compileAndRun('auto_cast_sext.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('took int\n');
    });
});

// ── Auto-cast: sitofp (int → double) ─────────────────────────────────────────

describe('auto-cast — sitofp (i32 → double)', () => {
    it('emits sitofp when int var is passed to a float (double) parameter', () => {
        const { exitCode, ir } = compileToIR('auto_cast_sitofp.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/sitofp i32 .* to double/);
    });

    it('the converted value is passed as double in the call instruction', () => {
        const { exitCode, ir } = compileToIR('auto_cast_sitofp.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/call void @take_float\(double %\d+\)/);
    });

    it('auto_cast_sitofp compiles and runs, producing correct output', () => {
        const { exitCode, stdout } = compileAndRun('auto_cast_sitofp.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('took float\n');
    });
});

// ── Store instructions use the correct narrowed type ─────────────────────────

describe('SMI — store / load types match alloca', () => {
    it('stores i8 literal into the i8 alloca for small const', () => {
        const { ir } = compileToIR('smi.code');
        // store i8 42, i8* %small
        expect(ir).toMatch(/store i8 42, i8\* %small/);
    });

    it('stores i32 literal into the i32 alloca for out-of-range const', () => {
        const { ir } = compileToIR('smi.code');
        expect(ir).toMatch(/store i32 200, i32\* %big/);
    });

    it('loads i8 before widening to i32 at call site', () => {
        const { ir } = compileToIR('auto_cast_sext.code');
        // load must happen before sext
        expect(ir).toMatch(/load i8, i8\* %x/);
    });
});
